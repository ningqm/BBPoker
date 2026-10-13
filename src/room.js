import { randomBytes, randomUUID } from 'node:crypto';
import { createHand, applyAction, availableActions } from './poker.js';
import { commitDeck, cardProof, VERIFICATION_VERSION, hash } from './fairness.js';
import { avatarImageId } from './avatar.js';
import { recordFilters, resultMatches, recordTotals, sessionRecord, sessionLibrary } from './records.js';

const MAX_BUYIN = 1000000000;
const TIME_BANK_WINDOW = 30 * 60 * 1000;
const MINI_CUTOFF = 5 * 60 * 1000;
const AUTO_DEAL_DELAY = 5000;
export const DEFAULTS = Object.freeze({ maxPlayers: 9, smallBlind: 5, bigBlind: 10,
  minBuyIn: 200, maxBuyIn: 2000, minBuyInBB: 20, maxBuyInBB: 200,
  actionSeconds: 15, approvalRequired: false, squid: false, squidUnit: 20, squidUnitBB: 2,
  mushroom: false, mushroomUnit: 5, bombPot: false, bombEveryHands: 10, bombAnteBB: 2,
  durationMinutes: 60, timeBankCards: 3, timeBankSeconds: 30 });
export const now = () => new Date().toISOString();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = x => structuredClone(x);
const EMOTES = new Set(['nice', 'gg', 'lol', 'wow', 'thanks', 'unlucky']);
const CHAT_LIMIT = 100, CHAT_ID_LIMIT = 2000, FAVORITE_LIMIT = 1000;
const OFFLINE_WAIT = '等待入座玩家回到牌桌';
const compareHands = (a, b) => a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;
function chatProjection(message) {
  return { id: message.id, playerId: message.playerId, name: message.name, kind: message.kind,
    ...(message.kind === 'text' ? { text: message.text } : { emote: message.emote }), at: message.at };
}
function handCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const cursor = JSON.parse(bytes.toString('utf8'));
    if (!cursor || typeof cursor.at !== 'string' || typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(cursor.id) || new Date(cursor.at).toISOString() !== cursor.at) throw new Error();
    return { at: cursor.at, id: cursor.id };
  } catch { fail('牌谱分页位置无效，请重新打开牌谱'); }
}
export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function integer(v, min, max, label) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${label}需要是 ${min}–${max} 的整数`); return v; }
export function cleanName(value, fallback = '朋友的牌桌') { return String(value ?? fallback).replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 24) || fallback; }
export function settingsFor(input = {}, original = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('房间配置格式错误');
  const s = { ...DEFAULTS, ...original };
  for (const k of Object.keys(DEFAULTS)) if (own(input, k)) s[k] = input[k];
  integer(s.maxPlayers, 2, 9, '人数'); integer(s.smallBlind, 1, 1000, '小盲'); integer(s.bigBlind, s.smallBlind * 2, 2000, '大盲');
  // New clients configure BB units. Old saved rooms and clients can still send
  // integer point amounts, but never use Infinity as the no-limit sentinel.
  for (const [points, bb, minimum, maximum] of [['minBuyIn', 'minBuyInBB', 10, MAX_BUYIN], ['maxBuyIn', 'maxBuyInBB', 10, MAX_BUYIN], ['squidUnit', 'squidUnitBB', 1, 1000000]]) {
    if (own(input, bb)) {
      const value = input[bb];
      if (points === 'maxBuyIn' && value === null) s[points] = null;
      else { integer(value, minimum, Math.floor(maximum / s.bigBlind), bb === 'squidUnitBB' ? '鱿鱼大盲数' : '带入大盲数'); s[points] = value * s.bigBlind; }
    } else if (!own(input, points) && s.bigBlind !== original.bigBlind) {
      // Adjust untouched values with a newly chosen blind, while keeping old
      // non-BB-multiple saved amounts exactly unchanged during ordinary play.
      s[points] = original[points] === null ? null : original[points] * s.bigBlind / original.bigBlind;
    }
    if (!(points === 'maxBuyIn' && s[points] === null)) integer(s[points], points === 'squidUnit' ? 1 : minimum * s.bigBlind, maximum, points === 'squidUnit' ? '鱿鱼积分' : '带入积分');
    s[bb] = s[points] === null ? null : s[points] / s.bigBlind;
  }
  if (s.maxBuyIn !== null && s.maxBuyIn < s.minBuyIn) fail('最高带入不能低于最低带入');
  integer(s.actionSeconds, 15, 90, '思考时间'); integer(s.durationMinutes, 30, 720, '牌桌时长（分钟）');
  integer(s.timeBankCards, 0, 20, '时间牌数量'); integer(s.timeBankSeconds, 5, 120, '每张时间牌秒数');
  integer(s.bombEveryHands, 1, 100, '炸弹池间隔手数'); integer(s.bombAnteBB, 1, 1000, '炸弹池前注大盲数');
  for (const k of ['approvalRequired', 'squid', 'mushroom', 'bombPot']) if (typeof s[k] !== 'boolean') fail('玩法开关格式错误');
  if (input.mushroom === true) fail('蘑菇玩法已停用，历史牌谱和旧池退款仍保留');
  s.mushroom = false; s.approvalRequired = false;
  return s;
}

export class RoomService {
  constructor(store) { this.store = store; this.db = store.data; this.connections = new Map(); this.chatRates = new Map(); }
  user(id) { return Object.values(this.db.users).find(u => u.id === id); }
  room(code) { if (typeof code !== 'string' || !own(this.db.rooms, code)) fail('房间不存在，请检查邀请链接', 404); return this.db.rooms[code]; }
  member(r, id) { if (typeof id !== 'string' || !own(r.members, id)) fail('请先通过邀请链接加入房间', 403); return r.members[id]; }
  host(r, id) { if (r.hostId !== id) fail('只有房主可以操作', 403); }
  idle(r) { if (r.hand?.status === 'playing') fail('请等本手结束后再操作'); }
  active(r) { if (r.status === 'closed') fail('本场已结束，牌谱仍可查看'); }
  log(r, playerId, type, amount, note) {
    const row = { id: randomUUID(), at: now(), roomCode: r.code, playerId, name: this.user(playerId)?.name ?? '朋友', type, amount, note };
    this.db.ledger.push(row); return row;
  }
  touch(r) { r.revision += 1; r.updatedAt = now(); }
  create(user, body) {
    if (Object.values(this.db.rooms).some(r => r.status !== 'closed')) fail('当前已有一桌正在使用。请通过邀请加入，或结束旧桌后再建房。', 409);
    const settings = settingsFor(body.settings);
    let code; do { code = randomBytes(4).readUInt32BE() % 900000 + 100000; } while (this.db.rooms[code]);
    code = String(code);
    const r = { code, name: cleanName(body.name, `${user.name}必赢的局`), hostId: user.id, invite: randomBytes(24).toString('base64url'), status: 'waiting', settings,
      createdAt: now(), updatedAt: now(), revision: 1, rulesVersion: 2, startedAt: null, endsAt: null, autoDealPaused: false, nextHandAt: null, autoWaitReason: null, members: {}, pending: [], hand: null, handNumber: 0, buttonSeat: -1, deadline: null, commandIds: {},
      mini: { squid: { active: false, round: 0, participants: [], won: [], reserves: {}, unit: settings.squidUnit, lastResult: null }, mushroom: { pool: 0, unit: settings.mushroomUnit, contributions: {}, smallBlindId: null, lastResult: null } } };
    this.db.rooms[code] = r; this.joinMember(r, user); return r;
  }
  joinMember(r, user) {
    if (!r.members[user.id]) {
      if (Object.keys(r.members).length >= 30) fail('本桌成员已达 30 人');
      r.members[user.id] = { id: user.id, seat: null, stack: 0, totalBuyIn: 0, cashedOut: 0, sittingOut: false, joinedAt: now() };
    }
    return r.members[user.id];
  }
  join(user, code, invite) {
    const r = this.room(code);
    if (!r.members[user.id] && (typeof invite !== 'string' || hash(invite) !== hash(r.invite))) fail('邀请链接无效，请向房主索取完整链接', 403);
    if (!r.members[user.id]) { this.active(r); this.joinMember(r, user); this.touch(r); }
    return r;
  }
  chat(user, code, input, { ip = 'local', timestamp = Date.now() } = {}) {
    const r = this.room(code); this.member(r, user.id);
    if (typeof input.messageId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.messageId)) fail('缺少消息编号，请重试');
    const key = `${user.id}:${input.messageId}`;
    if (own(r.chatIds ?? {}, key)) {
      const previous = (r.chat ?? []).find(message => message.id === r.chatIds[key]);
      if (previous) return chatProjection(previous);
      fail('这条消息已经发送，已超出最近消息范围', 409);
    }
    this.active(r);
    let content;
    if (input.kind === 'text') {
      if (typeof input.text !== 'string') fail('请输入聊天内容');
      const text = input.text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
      if (!text || [...text].length > 160) fail('聊天内容需要是 1–160 个字');
      content = { text };
    } else if (input.kind === 'emote' && EMOTES.has(input.emote)) content = { emote: input.emote };
    else fail('不支持的表情或消息类型');
    // Keep player limits separate from the shared IP allowance, so friends on
    // the same Wi-Fi can chat. Transport metadata never supplies author or time.
    const limits = [[`user:${user.id}`, 20], [`ip:${ip}`, 120]];
    const pending = [];
    for (const [rateKey, maximum] of limits) {
      const times = (this.chatRates.get(rateKey) ?? []).filter(t => timestamp - t < 60000);
      if (times.length >= maximum || (rateKey.startsWith('user:') && times.length && timestamp - times.at(-1) < 1000)) fail('消息发送太快，请稍后再试', 429);
      pending.push([rateKey, [...times, timestamp]]);
    }
    if (this.chatRates.size >= 6000) {
      for (const [rateKey, times] of this.chatRates) if (timestamp - times.at(-1) >= 60000) this.chatRates.delete(rateKey);
      if (this.chatRates.size >= 6000 && pending.some(([key]) => !this.chatRates.has(key))) fail('消息发送太快，请稍后再试', 429);
    }
    const message = { id: randomUUID(), playerId: user.id, name: this.user(user.id)?.name ?? '朋友', kind: input.kind, ...content, at: new Date(timestamp).toISOString() };
    r.chat = [...(r.chat ?? []), message].slice(-CHAT_LIMIT);
    r.chatIds ??= {}; r.chatIds[key] = message.id;
    const keys = Object.keys(r.chatIds); for (const old of keys.slice(0, Math.max(0, keys.length - CHAT_ID_LIMIT))) delete r.chatIds[old];
    for (const [rateKey, times] of pending) this.chatRates.set(rateKey, times);
    this.touch(r); return chatProjection(message);
  }
  command(user, code, cmd) {
    const r = this.room(code), m = this.member(r, user.id);
    if (typeof cmd.commandId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(cmd.commandId)) fail('缺少操作编号，请刷新页面重试');
    const key = `${user.id}:${cmd.commandId}`;
    if (r.commandIds[key]) return r;
    if (cmd.type !== 'show') this.active(r);
    switch (cmd.type) {
      case 'sit': this.sit(r, m, cmd); break;
      case 'buyin': this.buyin(r, m, cmd); break;
      case 'approve': this.host(r, user.id); this.approve(r, cmd.requestId); break;
      case 'reject': this.host(r, user.id); r.pending = r.pending.filter(p => p.id !== cmd.requestId); break;
      case 'stand': this.stand(r, m); break;
      case 'sitout':
        this.idle(r); if (m.seat === null) fail('请先入座');
        if (r.mini.squid.active && r.mini.squid.participants.includes(m.id)) fail('本轮鱿鱼结束后才能暂离');
        m.sittingOut = Boolean(cmd.value); break;
      case 'start': this.host(r, user.id); this.requestStart(r); break;
      case 'autoDeal':
        this.host(r, user.id);
        if (typeof cmd.paused !== 'boolean') fail('自动发牌开关格式错误');
        r.autoDealPaused = cmd.paused; break;
      case 'timebank': this.useTimeBank(r, m, cmd); break;
      case 'fold': case 'check': case 'call': case 'raise': case 'allin':
        if (!r.hand || r.hand.status !== 'playing') fail('当前没有进行中的手牌');
        if (cmd.handId !== r.hand.id) fail('牌局已更新，请重新操作', 409);
        if (cmd.actionSeq !== r.hand.log.length) fail('行动轮次已更新，请重新操作', 409);
        if (!Number.isFinite(r.deadline) || Date.now() >= r.deadline) fail('行动已超时，请等待牌桌更新', 409);
        applyAction(r.hand, user.id, cmd.type, cmd.amount); this.afterAction(r); break;
      case 'show': this.show(r, m, cmd); break;
      case 'settings': this.host(r, user.id); this.changeSettings(r, cmd.settings); break;
      case 'close': this.host(r, user.id); this.close(r); break;
      case 'transferHost':
        this.host(r, user.id); this.idle(r); this.member(r, cmd.playerId); r.hostId = cmd.playerId; break;
      default: fail('不支持的操作');
    }
    this.reconcileAutoDeal(r);
    r.commandIds[key] = Date.now();
    const keys = Object.keys(r.commandIds); for (const old of keys.slice(0, Math.max(0, keys.length - 2000))) delete r.commandIds[old];
    this.touch(r); return r;
  }
  sit(r, m, cmd) {
    this.idle(r);
    if (m.seat !== null) fail('你已经入座');
    if (r.mini.squid.active) fail('请等本轮鱿鱼结束后入座');
    const seat = integer(cmd.seat, 0, r.settings.maxPlayers - 1, '座位');
    if (Object.values(r.members).some(p => p.seat === seat) || r.pending.some(p => p.seat === seat && p.playerId !== m.id)) fail('这个座位已被占用或正在申请');
    this.requestBuyin(r, m, seat, this.buyinAmount(r, cmd));
  }
  buyin(r, m, cmd) { this.idle(r); if (m.seat === null) fail('请先选择座位'); this.requestBuyin(r, m, m.seat, this.buyinAmount(r, cmd)); }
  buyinAmount(r, cmd) {
    const amount = own(cmd, 'amountBB') ? integer(cmd.amountBB, 1, Math.floor(MAX_BUYIN / r.settings.bigBlind), '带入大盲数') * r.settings.bigBlind : cmd.amount;
    if (r.rulesVersion >= 2 && (!Number.isSafeInteger(amount) || amount % r.settings.bigBlind !== 0)) fail('带入需要是完整的大盲数量');
    return amount;
  }
  requestBuyin(r, m, seat, amount) {
    integer(amount, m.seat === null ? r.settings.minBuyIn : 1, r.settings.maxBuyIn ?? MAX_BUYIN, '带入积分');
    if (r.settings.maxBuyIn !== null && m.stack + amount > r.settings.maxBuyIn) fail(`补码后桌上积分不能超过 ${r.settings.maxBuyIn}`);
    if (m.totalBuyIn + amount > MAX_BUYIN) fail('本场累计带入达到上限');
    const request = { id: randomUUID(), playerId: m.id, name: this.user(m.id).name, seat, amount, at: now() };
    // A fresh valid request replaces only this player's uncredited legacy
    // approval request; other players' reserved seats remain protected.
    r.pending = r.pending.filter(p => p.playerId !== m.id);
    r.pending.push(request);
    this.approve(r, request.id);
  }
  approve(r, requestId) {
    this.idle(r);
    const p = r.pending.find(x => x.id === requestId); if (!p) fail('申请已处理或不存在');
    const m = this.member(r, p.playerId);
    if (Object.values(r.members).some(x => x.id !== m.id && x.seat === p.seat)) fail('座位已被占用');
    if (m.seat === null && r.mini.squid.active) fail('请等本轮鱿鱼结束后批准新入座');
    if (r.settings.maxBuyIn !== null && m.stack + p.amount > r.settings.maxBuyIn) fail('申请后筹码已变化，请重新申请带入');
    m.seat = p.seat; m.stack += p.amount; m.totalBuyIn += p.amount; m.sittingOut = false;
    r.pending = r.pending.filter(x => x.id !== requestId);
    this.log(r, m.id, 'buyin', p.amount, '带入积分（不计入输赢）');
  }
  stand(r, m) {
    this.idle(r);
    if (r.mini.squid.active && r.mini.squid.participants.includes(m.id)) fail('本轮鱿鱼结束后才能离座，或请房主结束整场并退还预留积分');
    r.pending = r.pending.filter(p => p.playerId !== m.id);
    if (m.seat === null) return;
    const amount = m.stack; m.cashedOut += amount; m.stack = 0; m.seat = null; m.sittingOut = false;
    this.log(r, m.id, 'cashout', amount, '离桌收回积分');
  }
  changeSettings(r, input) {
    this.idle(r); if (r.startedAt != null || r.handNumber > 0) fail('开局后房间配置已锁定，请结束本场后新建房间');
    const next = settingsFor(input, r.settings);
    if (r.mini.squid.active || r.mini.mushroom.pool > 0) fail('小游戏尚有进行中的轮次或积累池，请先结束整场后新建房间');
    if (r.pending.length) fail('请先处理带入申请');
    if (Object.values(r.members).some(m => m.seat !== null && m.seat >= next.maxPlayers)) fail('减少人数前，请让超出座位范围的玩家离座');
    r.settings = next; r.mini.squid.unit = next.squidUnit; r.mini.mushroom.unit = next.mushroomUnit;
  }
  prepareStart(r, timestamp = Date.now()) {
    let players = Object.values(r.members).filter(m => m.seat !== null && !m.sittingOut && m.stack > 0).sort((a, b) => a.seat - b.seat);
    const s = settingsFor({}, r.settings), squid = r.mini.squid;
    const mayStartMini = r.endsAt == null || timestamp < r.endsAt - MINI_CUTOFF;
    const newSquid = s.squid && !squid.active && mayStartMini;
    if (squid.active) {
      players = squid.participants.map(id => r.members[id]);
      if (players.some(m => !m || m.seat === null || m.sittingOut || m.stack <= 0)) fail('鱿鱼轮中有玩家积分不足，请补码后继续，或结束本场退还预留积分');
      players.sort((a, b) => a.seat - b.seat);
    }
    if (players.length < 2) fail('至少需要两位已入座且有积分的朋友');
    if (newSquid && players.length < 3) fail('鱿鱼玩法至少需要三人');
    const buttonSeat = players.find(m => m.seat > r.buttonSeat)?.seat ?? players[0].seat;
    const reserve = newSquid ? (players.length - 1) * s.squidUnit : 0;
    for (const m of players) if (m.stack <= reserve) fail(`${this.user(m.id).name} 积分不足，需先补码（鱿鱼预留 ${reserve}）`);
    return { players, s, squid, mayStartMini, newSquid, buttonSeat, reserve };
  }
  requestStart(r, timestamp = Date.now()) {
    this.idle(r);
    if (r.endsAt != null && timestamp >= r.endsAt) { this.close(r, timestamp); return; }
    if (r.handNumber === 0) { r.autoDealPaused = false; this.start(r, timestamp); return; }
    if (Number.isFinite(r.nextHandAt) && r.nextHandAt > timestamp && !r.autoDealPaused) fail('下一手正在倒计时，请稍候', 409);
    // Old clients and pre-upgrade completed rooms resume the same server clock.
    r.autoDealPaused = false; this.reconcileAutoDeal(r, timestamp);
  }
  start(r, timestamp = Date.now()) {
    this.idle(r);
    if (r.endsAt != null && timestamp >= r.endsAt) { this.close(r, timestamp); return; }
    const { players, s, squid, mayStartMini, newSquid, buttonSeat, reserve } = this.prepareStart(r, timestamp);
    r.nextHandAt = null; r.autoWaitReason = null;
    if (newSquid) {
      squid.active = true; squid.round++; squid.participants = players.map(m => m.id); squid.won = []; squid.reserves = {}; squid.unit = s.squidUnit;
      for (const m of players) { m.stack -= reserve; squid.reserves[m.id] = reserve; }
    }
    r.settings = s;
    if (r.startedAt == null) { r.startedAt = timestamp; r.endsAt = timestamp + s.durationMinutes * 60000; }
    this.refreshTimeBanks(r, timestamp);
    const bombPot = s.bombPot && mayStartMini && (r.handNumber + 1) % s.bombEveryHands === 0;
    const h = createHand({ id: randomUUID(), players: players.map(m => ({ id: m.id, name: this.user(m.id).name, seat: m.seat, stack: m.stack })), buttonSeat, smallBlind: s.smallBlind, bigBlind: s.bigBlind,
      bombPot, ante: bombPot ? s.bombAnteBB * s.bigBlind : 0 });
    h.number = ++r.handNumber; h.at = new Date(timestamp).toISOString(); h.roomCode = r.code; h.roomName = r.name; h.settings = copy(s); h.shown = {};
    h.miniChanges = Object.fromEntries(players.map(m => [m.id, 0])); h.timeBankUses = []; h.audit = commitDeck(h);
    h.miniBefore = copy(r.mini); r.hand = h; r.buttonSeat = buttonSeat; r.status = 'playing';
    this.afterAction(r, timestamp);
  }
  afterAction(r, timestamp = Date.now()) {
    const h = r.hand;
    for (const p of h.players) r.members[p.id].stack = p.stack;
    if (h.status === 'complete') {
      r.deadline = null; r.status = 'waiting'; this.finish(r);
      if (r.endsAt != null && timestamp >= r.endsAt) this.close(r, timestamp);
      else { r.autoDealPaused ??= false; this.reconcileAutoDeal(r, timestamp); }
    } else r.deadline = timestamp + r.settings.actionSeconds * 1000;
  }
  autoBlockReason(r, timestamp = Date.now()) {
    if (r.status === 'closed' || r.hand?.status === 'playing' || r.handNumber === 0) return null;
    if (!own(r, 'autoDealPaused')) return '等待房主继续，之后会自动发牌';
    if (r.autoDealPaused) return '房主已暂停自动发牌';
    let players;
    try { ({ players } = this.prepareStart(r, timestamp)); }
    catch (error) { if (error.status === 400) return error.message; throw error; }
    if (!players.some(m => (this.connections.get(`${r.code}:${m.id}`) ?? 0) > 0)) return OFFLINE_WAIT;
    return null;
  }
  autoPlan(r, timestamp = Date.now()) {
    // No persisted-data migration: legacy completed rooms need one host resume.
    if (!own(r, 'autoDealPaused')) return null;
    if (r.status === 'closed' || r.hand?.status === 'playing' || r.handNumber === 0) return { nextHandAt: null, autoWaitReason: null };
    const autoWaitReason = this.autoBlockReason(r, timestamp);
    return { nextHandAt: autoWaitReason ? null : (Number.isFinite(r.nextHandAt) ? r.nextHandAt : timestamp + AUTO_DEAL_DELAY), autoWaitReason };
  }
  reconcileAutoDeal(r, timestamp = Date.now()) {
    if (r.status !== 'closed' && r.hand?.status !== 'playing' && r.endsAt != null && timestamp >= r.endsAt) { this.close(r, timestamp); return true; }
    const plan = this.autoPlan(r, timestamp);
    if (!plan || (r.nextHandAt === plan.nextHandAt && r.autoWaitReason === plan.autoWaitReason)) return false;
    Object.assign(r, plan); return true;
  }
  connectionChanged(r, timestamp = Date.now(), { reconnected = false } = {}) {
    const reset = reconnected && r.hand?.status !== 'playing' && Number.isFinite(r.nextHandAt) && r.nextHandAt <= timestamp;
    if (reset) r.nextHandAt = null;
    const changed = this.reconcileAutoDeal(r, timestamp) || reset;
    if (changed) this.touch(r);
    return changed;
  }
  timeBankWindow(r, timestamp) { return r.startedAt == null ? null : Math.max(0, Math.floor((timestamp - r.startedAt) / TIME_BANK_WINDOW)); }
  refreshTimeBanks(r, timestamp) {
    const window = this.timeBankWindow(r, timestamp);
    if (window === null || (r.endsAt != null && timestamp >= r.endsAt)) return false;
    let changed = false;
    for (const m of Object.values(r.members)) if (m.timeBank?.window !== window) {
      m.timeBank = { window, remaining: r.settings.timeBankCards ?? DEFAULTS.timeBankCards }; changed = true;
    }
    return changed;
  }
  useTimeBank(r, m, cmd, timestamp = Date.now()) {
    if (r.hand?.status !== 'playing' || cmd.handId !== r.hand.id || cmd.actionSeq !== r.hand.log.length) fail('行动轮次已更新，请重新操作', 409);
    if (r.hand.actingId !== m.id) fail('只有当前行动的玩家可以使用时间牌', 403);
    if (!Number.isFinite(r.deadline) || timestamp >= r.deadline) fail('行动已超时，不能使用时间牌', 409);
    this.refreshTimeBanks(r, timestamp);
    if (!m.timeBank?.remaining) fail('本轮时间牌已用完');
    m.timeBank.remaining--;
    const seconds = r.settings.timeBankSeconds ?? DEFAULTS.timeBankSeconds;
    r.deadline += seconds * 1000;
    (r.hand.timeBankUses ??= []).push({ playerId: m.id, at: timestamp, actionSeq: cmd.actionSeq, seconds, remaining: m.timeBank.remaining });
  }
  needsTick(r, timestamp = Date.now()) {
    if (r.status === 'closed') return false;
    if (r.hand?.status === 'playing' && r.deadline != null && timestamp >= r.deadline) return true;
    if (r.endsAt != null && timestamp >= r.endsAt) return r.hand?.status !== 'playing';
    const plan = this.autoPlan(r, timestamp);
    if (plan && (r.nextHandAt !== plan.nextHandAt || r.autoWaitReason !== plan.autoWaitReason || (plan.nextHandAt !== null && timestamp >= plan.nextHandAt))) return true;
    const window = this.timeBankWindow(r, timestamp);
    return window !== null && Object.values(r.members).some(m => m.timeBank?.window !== window);
  }
  tick(r, timestamp = Date.now()) {
    if (!this.needsTick(r, timestamp)) return false;
    if (r.endsAt != null && timestamp >= r.endsAt && r.hand?.status !== 'playing') { this.close(r, timestamp); this.touch(r); return true; }
    const refreshed = this.refreshTimeBanks(r, timestamp);
    if (this.timeout(r, timestamp)) return true;
    const autoChanged = this.reconcileAutoDeal(r, timestamp);
    if (r.status !== 'closed' && r.hand?.status !== 'playing' && r.nextHandAt !== null && Number.isFinite(r.nextHandAt) && timestamp >= r.nextHandAt) {
      this.start(r, timestamp); this.touch(r); return true;
    }
    if (refreshed || autoChanged) this.touch(r);
    return refreshed || autoChanged;
  }
  finish(r) {
    const h = r.hand; if (h.recorded) return;
    const squid = r.mini.squid, mushroom = r.mini.mushroom;
    const main = h.result.mainWinnerIds;
    if (h.settings.mushroom && main.length === 1 && main[0] === mushroom.smallBlindId) {
      const id = main[0], amount = mushroom.pool; r.members[id].stack += amount; h.miniChanges[id] += amount;
      mushroom.lastResult = { handId: h.id, playerId: id, amount }; mushroom.pool = 0; mushroom.contributions = {};
    }
    if (squid.active && main.length === 1 && squid.participants.includes(main[0]) && !squid.won.includes(main[0])) squid.won.push(main[0]);
    if (squid.active && squid.won.length === squid.participants.length - 1) {
      const loser = squid.participants.find(id => !squid.won.includes(id)), cost = squid.unit * (squid.participants.length - 1);
      for (const id of squid.participants) {
        const net = id === loser ? -cost : squid.unit;
        r.members[id].stack += squid.reserves[id] + net; h.miniChanges[id] = (h.miniChanges[id] ?? 0) + net;
      }
      squid.lastResult = { handId: h.id, loserId: loser, amount: cost, winnerIds: [...squid.won], unit: squid.unit };
      squid.active = false; squid.reserves = {};
    }
    // Mandatory showdown exposes live contenders only. Folded cards remain private.
    if (h.result.showdown) for (const p of h.players) if (!p.folded) h.shown[p.id] = [0, 1];
    h.endingStacks = Object.fromEntries(h.players.map(p => [p.id, r.members[p.id].stack]));
    h.miniAfter = copy(r.mini); h.recorded = true;
    for (const p of h.players) {
      const net = p.stack - p.startingStack, miniNet = h.miniChanges[p.id] ?? 0;
      this.log(r, p.id, 'holdem', net, `第 ${h.number} 手德州结算`);
      if (miniNet) this.log(r, p.id, 'mini', miniNet, `第 ${h.number} 手小游戏结算`);
    }
    this.db.hands.push(copy(h));
  }
  show(r, m, cmd) {
    this.idle(r); const h = r.hand;
    if (!h || h.status !== 'complete' || !h.players.some(p => p.id === m.id)) fail('只能在本手结束后亮出自己的牌');
    if (cmd.handId !== h.id) fail('手牌已更新，请重新选择要亮出的牌', 409);
    const indices = cmd.indices; if (!Array.isArray(indices) || !indices.length || indices.some(i => i !== 0 && i !== 1)) fail('请选择要亮出的牌');
    h.shown[m.id] = [...new Set([...(h.shown[m.id] ?? []), ...indices])];
    const archived = this.db.hands.find(x => x.id === h.id); if (archived) archived.shown = copy(h.shown);
  }
  close(r, timestamp = Date.now()) {
    this.idle(r);
    const q = r.mini.squid, mushroom = r.mini.mushroom;
    for (const [id, reserve] of Object.entries(q.reserves)) r.members[id].stack += reserve;
    q.active = false; q.reserves = {};
    for (const [id, amount] of Object.entries(mushroom.contributions)) {
      const m = r.members[id]; if (m.seat === null) m.cashedOut += amount; else m.stack += amount;
      this.log(r, id, 'mushroomRefund', amount, '散桌退还尚未派奖的蘑菇贡献');
    }
    mushroom.pool = 0; mushroom.contributions = {};
    for (const m of Object.values(r.members)) if (m.seat !== null) {
      this.log(r, m.id, 'cashout', m.stack, '本场结束，收回剩余积分'); m.cashedOut += m.stack; m.stack = 0; m.seat = null;
    }
    r.status = 'closed'; r.closedAt = new Date(timestamp).toISOString(); r.pending = []; r.deadline = null; r.nextHandAt = null; r.autoWaitReason = null;
  }
  timeout(r, timestamp = Date.now()) {
    if (r.hand?.status !== 'playing' || !r.deadline || timestamp < r.deadline) return false;
    const actor = r.hand.actingId, a = availableActions(r.hand, actor);
    applyAction(r.hand, actor, a.canCheck ? 'check' : 'fold');
    r.hand.log.push({ seq: r.hand.log.length + 1, street: r.hand.street, playerId: actor, type: 'timeout', amount: 0 });
    this.afterAction(r, timestamp); this.touch(r); return true;
  }
  cardsFor(h, p, viewerId) { return p.cards.map((c, i) => p.id === viewerId || (h.shown?.[p.id] ?? []).includes(i) ? c : null); }
  proofsFor(h, viewerId) {
    const positions = [...h.boardIndices];
    for (const p of h.players) for (let i = 0; i < p.cardIndices.length; i++) if (p.id === viewerId || (h.shown?.[p.id] ?? []).includes(i)) positions.push(p.cardIndices[i]);
    return [...new Set(positions)].map(i => cardProof(h, i));
  }
  resultFor(h) {
    if (!h.result) return null;
    const result = { pots: copy(h.result.pots), payouts: copy(h.result.payouts), mainWinnerIds: [...h.result.mainWinnerIds], showdown: h.result.showdown, handNames: {} };
    for (const [id, name] of Object.entries(h.result.handNames ?? {})) if ((h.shown?.[id] ?? []).length === 2) result.handNames[id] = name;
    return result;
  }
  summary(h, userId) {
    const p = h.players.find(x => x.id === userId);
    return { id: h.id, number: h.number, at: h.at, board: [...h.board], profit: p ? p.stack - p.startingStack : 0, miniProfit: h.miniChanges?.[userId] ?? 0,
      winners: h.result.mainWinnerIds.map(id => ({ id, name: h.players.find(x => x.id === id)?.name ?? '朋友', amount: h.result.payouts[id] ?? 0 })) };
  }
  state(r, viewerId) {
    this.member(r, viewerId); const h = r.hand;
    const timestamp = Date.now(), bank = this.member(r, viewerId).timeBank;
    const timeBankCards = bank?.remaining ?? (r.settings.timeBankCards ?? DEFAULTS.timeBankCards);
    const actions = h && h.status === 'playing' ? availableActions(h, viewerId) : { canAct: false, canCheck: false, canFold: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false };
    actions.canUseTimeBank = actions.canAct && timeBankCards > 0 && Number.isFinite(r.deadline) && timestamp < r.deadline;
    actions.timeBankCards = timeBankCards; actions.timeBankSeconds = r.settings.timeBankSeconds ?? DEFAULTS.timeBankSeconds;
    const publicHand = h ? { id: h.id, number: h.number, status: h.status, street: h.street, board: [...h.board], buttonSeat: h.buttonSeat,
      bombPot: h.bombPot ?? false, ante: h.ante ?? 0, timeBankUses: copy(h.timeBankUses ?? []), smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, actingId: h.actingId, currentBet: h.currentBet,
      pot: h.players.reduce((n, p) => n + p.contributed, 0), actionSeq: h.log.length, log: copy(h.log), result: this.resultFor(h), commitment: h.audit.root, proofs: this.proofsFor(h, viewerId) } : null;
    return { code: r.code, name: r.name, status: r.status, hostId: r.hostId, meId: viewerId, invite: r.invite, settings: { ...copy(r.settings), approvalRequired: false }, revision: r.revision, serverTime: Date.now(), deadline: r.deadline, createdAt: r.createdAt, startedAt: r.startedAt ?? null, endsAt: r.endsAt ?? null,
      autoDeal: { paused: own(r, 'autoDealPaused') ? Boolean(r.autoDealPaused) : r.handNumber > 0, nextHandAt: r.nextHandAt ?? null, waitReason: this.autoBlockReason(r, timestamp), delaySeconds: AUTO_DEAL_DELAY / 1000 },
      miniGamesCutoffAt: r.endsAt == null ? null : r.endsAt - MINI_CUTOFF,
      timeBankResetAt: r.startedAt == null ? null : (r.startedAt + (this.timeBankWindow(r, timestamp) + 1) * TIME_BANK_WINDOW < r.endsAt ? r.startedAt + (this.timeBankWindow(r, timestamp) + 1) * TIME_BANK_WINDOW : null),
      players: Object.values(r.members).map(m => {
        const u = this.user(m.id), p = h?.players.find(x => x.id === m.id);
        return { id: m.id, name: u?.name ?? '朋友', avatar: u?.avatar ?? 0, avatarImage: avatarImageId(u?.avatarImage), seat: m.seat, stack: m.stack, totalBuyIn: m.totalBuyIn,
          sessionProfit: m.stack + m.cashedOut + (r.mini.squid.reserves[m.id] ?? 0) - m.totalBuyIn,
          timeBankCardsRemaining: m.timeBank?.remaining ?? (r.settings.timeBankCards ?? DEFAULTS.timeBankCards), sittingOut: m.sittingOut, connected: (this.connections.get(`${r.code}:${m.id}`) ?? 0) > 0,
          squidWon: r.mini.squid.won.includes(m.id), squidReserve: r.mini.squid.reserves[m.id] ?? 0,
          cards: p ? this.cardsFor(h, p, viewerId) : [], folded: p?.folded ?? false, allIn: p?.allIn ?? false, bet: h?.status === 'playing' ? p?.bet ?? 0 : 0,
          contributed: p?.contributed ?? 0, inHand: Boolean(p), lastAction: h?.log.filter(a => a.playerId === m.id && !['payout', 'street', 'refund'].includes(a.type)).at(-1)?.type ?? null };
      }),
      pending: copy(r.pending.filter(p => viewerId === r.hostId || p.playerId === viewerId)),
      hand: publicHand, actions,
      mini: copy(r.mini), recentHands: this.db.hands.filter(x => x.roomCode === r.code).slice(-20).reverse().map(x => this.summary(x, viewerId)),
      ledger: this.db.ledger.filter(x => x.roomCode === r.code).slice(-80), messages: [], chat: (r.chat ?? []).slice(-CHAT_LIMIT).map(chatProjection) };
  }
  history(userId, roomCode, options = {}) {
    const r = this.room(roomCode); this.member(r, userId);
    if (Object.keys(options).length) return this.handLibrary(userId, { ...options, room: roomCode }, true);
    return { hands: this.db.hands.filter(h => h.roomCode === roomCode).slice().reverse().map(h => this.summary(h, userId)) };
  }
  handFor(userId, roomCode, handId) {
    const r = this.room(roomCode); this.member(r, userId);
    const h = this.db.hands.find(x => x.roomCode === roomCode && x.id === handId); if (!h) fail('牌谱不存在', 404);
    return { id: h.id, number: h.number, at: h.at, roomCode, roomName: h.roomName, settings: copy(h.settings), board: [...h.board],
      favorite: h.players.some(p => p.id === userId) && (this.user(userId)?.favoriteHands ?? []).includes(h.id),
      buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, ante: h.ante ?? 0, bombPot: h.bombPot ?? false, timeBankUses: copy(h.timeBankUses ?? []),
      players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack, endingStack: h.endingStacks[p.id], cards: this.cardsFor(h, p, userId), folded: p.folded,
        net: p.stack - p.startingStack, miniNet: h.miniChanges?.[p.id] ?? 0 })),
      log: copy(h.log), result: this.resultFor(h), mini: { before: copy(h.miniBefore), after: copy(h.miniAfter), changes: copy(h.miniChanges) },
      commitment: h.audit.root, proofs: this.proofsFor(h, userId), verificationVersion: VERIFICATION_VERSION };
  }
  sessions(userId, options = {}) {
    if (options.room) this.member(this.room(options.room), userId);
    return sessionLibrary(this.db, userId, options);
  }
  sessionFor(userId, roomCode) {
    const room = this.room(roomCode); this.member(room, userId);
    return { session: sessionRecord(this.db, room, userId) };
  }
  handLibrary(userId, { before, limit = '20', favorites, room, ...options } = {}, includeObserved = false) {
    if (typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) fail('每页牌谱数量需要是 1–50');
    if (favorites !== undefined && favorites !== null && !['0', '1'].includes(favorites)) fail('收藏筛选格式错误');
    if (room) this.member(this.room(room), userId);
    const cursor = handCursor(before), favoriteIds = new Set(this.user(userId)?.favoriteHands ?? []), count = Number(limit), filter = recordFilters(options);
    const filtered = this.db.hands.filter(h => {
      const p = h.players.find(p => p.id === userId);
      return h.status === 'complete' && (p || includeObserved) && (!room || h.roomCode === room) && (favorites !== '1' || favoriteIds.has(h.id))
        && Date.parse(h.at) >= filter.start && Date.parse(h.at) <= filter.end
        && resultMatches((p ? p.stack - p.startingStack : 0) + (h.miniChanges?.[userId] ?? 0), filter.result)
        && (filter.type === 'all' || Boolean(h.bombPot) === (filter.type === 'bomb'))
        && (!filter.q || `${h.number} ${h.id} ${h.roomName}`.toLocaleLowerCase('zh-CN').includes(filter.q));
    });
    const totals = recordTotals(filtered, h => { const p = h.players.find(p => p.id === userId); return p ? p.stack - p.startingStack : 0; }, h => h.miniChanges?.[userId] ?? 0);
    const matches = filtered.filter(h => !cursor || compareHands(h, cursor) > 0).sort(compareHands);
    const page = matches.slice(0, count), last = page.at(-1);
    return { hands: page.map(h => {
      const p = h.players.find(p => p.id === userId), net = p ? p.stack - p.startingStack : 0, miniNet = h.miniChanges?.[userId] ?? 0;
      return { id: h.id, roomCode: h.roomCode, roomName: h.roomName, number: h.number, at: h.at, board: [...h.board], cards: p ? [...p.cards] : [null, null], participated: Boolean(p),
        net, miniNet, totalNet: net + miniNet, pot: (h.result?.pots ?? []).reduce((sum, pot) => sum + pot.amount, 0), bombPot: Boolean(h.bombPot), favorite: favoriteIds.has(h.id) };
    }), totals, nextCursor: matches.length > count ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString('base64url') : null };
  }
  favoriteHand(userId, handId, favorite) {
    if (typeof favorite !== 'boolean') fail('收藏状态格式错误');
    const h = this.db.hands.find(h => h.id === handId && h.status === 'complete' && h.players.some(p => p.id === userId));
    if (!h) fail('牌谱不存在', 404);
    const user = this.user(userId); if (!user) fail('请先登录账号', 401);
    const favorites = new Set(user.favoriteHands ?? []);
    if (favorite && !favorites.has(handId) && favorites.size >= FAVORITE_LIMIT) fail(`最多收藏 ${FAVORITE_LIMIT} 手牌谱，请先取消部分收藏`);
    if (favorite) favorites.add(handId); else favorites.delete(handId);
    user.favoriteHands = [...favorites]; return { favorite };
  }
  exportRange(userId, roomCode, from, to) {
    if (roomCode) this.member(this.room(roomCode), userId);
    const start = from ? Date.parse(from) : -Infinity, end = to ? Date.parse(to) + (/^\d{4}-\d{2}-\d{2}$/.test(to) ? 86400000 - 1 : 0) : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) fail('日期范围无效');
    return { start, end };
  }
  exports(userId, roomCode, from, to) {
    const { start, end } = this.exportRange(userId, roomCode, from, to);
    return this.db.hands.filter(h => (!roomCode || h.roomCode === roomCode) && h.players.some(p => p.id === userId) && Date.parse(h.at) >= start && Date.parse(h.at) <= end)
      .map(h => this.handFor(userId, h.roomCode, h.id));
  }
  exportAdjustments(userId, roomCode, from, to) {
    const { start, end } = this.exportRange(userId, roomCode, from, to);
    return this.db.ledger.filter(l => l.playerId === userId && l.type === 'mushroomRefund' && (!roomCode || l.roomCode === roomCode) && Date.parse(l.at) >= start && Date.parse(l.at) <= end)
      .map(l => ({ ...copy(l), roomName: this.room(l.roomCode).name }));
  }
  stats(userId) {
    const hands = this.db.hands.filter(h => h.players.some(p => p.id === userId));
    let holdemNet = 0, miniNet = 0, vpip = 0, pfr = 0, wins = 0, showdowns = 0, preflopHands = 0; const curve = [], events = [];
    for (const h of hands) {
      const p = h.players.find(p => p.id === userId), actions = h.log.filter(a => a.playerId === userId && a.street === 'preflop');
      events.push({ at: h.at, handId: h.id, holdemDelta: p.stack - p.startingStack, miniDelta: h.miniChanges?.[userId] ?? 0,
        order: this.db.ledger.findIndex(l => l.playerId === userId && l.roomCode === h.roomCode && l.type === 'holdem' && l.note === `第 ${h.number} 手德州结算`) });
      if ((h.result.payouts[userId] ?? 0) > 0) wins++;
      if (h.result.showdown && !p.folded) showdowns++;
      if (!h.bombPot) {
        preflopHands++;
        if (actions.some(a => ['call','raise','allin'].includes(a.type) && a.amount > 0)) vpip++;
        if (actions.some(a => a.type === 'raise' || (a.type === 'allin' && a.isRaise))) pfr++;
      }
    }
    const refunds = this.db.ledger.filter(l => l.playerId === userId && l.type === 'mushroomRefund');
    for (const refund of refunds) events.push({ at: refund.at, handId: null, holdemDelta: 0, miniDelta: refund.amount, order: this.db.ledger.indexOf(refund), adjustment: '蘑菇池退款' });
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
    for (const e of events) {
      holdemNet += e.holdemDelta; miniNet += e.miniDelta;
      curve.push({ at: e.at, handId: e.handId, net: holdemNet + miniNet, holdemNet, miniNet, ...(e.adjustment ? { adjustment: e.adjustment } : {}) });
    }
    return { hands: hands.length, wins, net: holdemNet + miniNet, holdemNet, miniNet, totalBuyIn: this.db.ledger.filter(l => l.playerId === userId && l.type === 'buyin').reduce((s, l) => s + l.amount, 0),
      vpip: preflopHands ? Math.round(vpip / preflopHands * 1000) / 10 : 0, pfr: preflopHands ? Math.round(pfr / preflopHands * 1000) / 10 : 0, preflopHands, showdowns, curve,
      sessions: Object.values(this.db.rooms).filter(r => r.members[userId]?.totalBuyIn > 0).length };
  }
}

export function exportText(hands, adjustments = []) {
  const texts = hands.map(h => ({ at: h.at, text: [
    `BBPoker Hand #${h.number} [${h.id}] ${h.at}`, `Room: ${h.roomName} (${h.roomCode}) | Hold'em No Limit | ${h.settings.smallBlind}/${h.settings.bigBlind} points`,
    ...h.players.map(p => `Seat ${p.seat + 1}: ${p.name} (${p.startingStack} points) [${p.cards.map(c => c ?? '??').join(' ')}]`),
    ...h.log.map(a => `${a.street}: ${h.players.find(p => p.id === a.playerId)?.name ?? '桌面'} ${a.type}${a.amount !== undefined ? ' ' + a.amount : ''}${a.to !== undefined ? ' to ' + a.to : ''}${a.board ? ' [' + a.board.join(' ') + ']' : ''}`),
    `Board: [${h.board.join(' ')}]`, ...h.players.map(p => `${p.name}: Holdem ${p.net >= 0 ? '+' : ''}${p.net}; Mini ${p.miniNet >= 0 ? '+' : ''}${p.miniNet}`),
    `Commitment: ${h.commitment}`, 'Privacy: hidden/folded cards remain private. JSON includes proofs for visible cards.', ''
  ].join('\n') }));
  for (const a of adjustments) texts.push({ at: a.at, text: `BBPoker Adjustment [${a.id}] ${a.at}\nRoom: ${a.roomName} (${a.roomCode})\n${a.name}: ${a.note}; Mini +${a.amount} points\n` });
  return texts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(x => x.text).join('\n');
}

export function exportCsv(hands, userId, adjustments = []) {
  const escape = v => typeof v === 'number' && Number.isFinite(v) ? String(v) : '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [['记录类型','手牌ID','时间','房间','手数','本人底牌','公共牌','德州盈亏','小游戏盈亏','合计','承诺根']];
  const entries = [];
  for (const h of hands) { const p = h.players.find(p => p.id === userId); entries.push(['手牌',h.id,h.at,h.roomName,h.number,p.cards.map(c => c ?? '??').join(' '),h.board.join(' '),p.net,p.miniNet,p.net+p.miniNet,h.commitment]); }
  for (const a of adjustments) entries.push(['退款',a.id,a.at,a.roomName,'','','',0,a.amount,a.amount,'']);
  rows.push(...entries.sort((a, b) => Date.parse(a[2]) - Date.parse(b[2])));
  return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n');
}
