import { randomBytes, randomUUID } from 'node:crypto';
import { createHand, applyAction, availableActions, advanceRunout, advanceTransition, rabbitRunout, evaluate, potPreview } from './poker.js';
import { commitDeck, cardProof, VERIFICATION_VERSION, hash } from './fairness.js';
import { planEntry, commitEntry, needsEntry, entryState, setEntryMode, markEntrySeat, projectEntry } from './entry-blinds.js';
import { avatarImageId } from './avatar.js';
import { calculateEquity } from './equity.js';
import { aggregateAnalytics } from './analytics.js';
import { publicPlayerStats } from './player-stats.js';
import { recordFilters, resultMatches, handBigBlind, amountInBB, holeMatches, recordTotals, recordBBTotals, opponentRecords, sessionRecord, sessionLibrary, squidSettlementMap, handMiniNet } from './records.js';
import { handContext, handContextMatches } from './hand-context.js';
import { handGameMatches } from './record-games.js';
import { directRecordLibrary } from './direct-records.js';

// At most 30 members can fund a room; keep even their summed ledger safe.
const MAX_TOTAL_BUYIN = Math.floor(Number.MAX_SAFE_INTEGER / 30);
const BUYIN_MIN_BB = 100, BUYIN_MAX_BB = 1000, BUYIN_STEP_BB = 50;
const ACTION_SECONDS = 20, TIME_BANK_SECONDS = 30;
const timeBankGrant = settings => 3 * Math.ceil((settings.durationMinutes ?? 60) / 30);
const MINI_CUTOFF = 5 * 60 * 1000;
const AUTO_DEAL_DELAY = 5000;
const REBUY_GRACE_DELAY = 5000;
const SQUID_BLOCK_GRACE = 90000, EMPTY_ROOM_TIMEOUT = 30 * 60000;
const RABBIT_START_DELAY = 1000;
// A short tail on the last action flows into the 520ms board flip; the 600ms
// reveal guard still finishes before any action or time-card command is legal.
const DEAL_PRESENTATION_DELAY = 1100, STREET_PRESENTATION_DELAY = 600;
export const transitionDelay = hand => hand.transition?.kind === 'street' ? 300
  : hand.transition?.kind === 'award' ? 650 : hand.transition?.afterRunout || hand.transition?.revealed ? 700 : 900;
export const DEFAULTS = Object.freeze({ maxPlayers: 9, smallBlind: 5, bigBlind: 10,
  minBuyIn: 1000, maxBuyIn: 10000, minBuyInBB: BUYIN_MIN_BB, maxBuyInBB: BUYIN_MAX_BB, buyInStepBB: BUYIN_STEP_BB, maxTotalBuyInBB: null,
  actionSeconds: ACTION_SECONDS, approvalRequired: false, squid: false, squidMode: 'normal', squidExtraTokens: 3, squidUnit: 20, squidUnitBB: 2,
  mushroom: false, mushroomUnit: 5, bombPot: false, bombIntervalMinutes: 10, bombAnteBB: 2,
  durationMinutes: 60, timeBankCards: 6, timeBankSeconds: TIME_BANK_SECONDS });
export const now = () => new Date().toISOString();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = x => structuredClone(x);
// Round rules are frozen at the deal, never read from mutable room settings.
// Legacy rounds have only `won`: each marked player owns exactly one fish.
function squidDetails(q) {
  const participants = q.participants ?? [], mode = q.mode === 'unlimited' ? 'unlimited' : 'normal';
  const extraTokens = mode === 'unlimited' ? q.extraTokens : 0;
  const tokenBudget = mode === 'unlimited' ? q.tokenBudget : Math.max(0, participants.length - 1);
  if (mode === 'unlimited' && (!Number.isSafeInteger(extraTokens) || extraTokens < 0 || extraTokens > 100
    || tokenBudget !== participants.length + extraTokens || !q.counts)) fail('鱿鱼轮次配置异常，请保留牌桌并联系维护者', 500);
  const counts = Object.fromEntries(participants.map(id => [id, mode === 'normal' ? Number(q.won?.includes(id)) : q.counts[id] ?? 0]));
  const tokensAwarded = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0) || !Number.isSafeInteger(tokensAwarded) || tokensAwarded > tokenBudget)
    fail('鱿鱼鱼数异常，请保留牌桌并联系维护者', 500);
  return { mode, extraTokens, tokenBudget, counts, tokensAwarded, tokensRemaining: tokenBudget - tokensAwarded };
}
const EMOTES = new Set(['nice', 'gg', 'lol', 'wow', 'thanks', 'unlucky']);
const THROW_EMOTES = new Set(['water', 'tomato', 'pat', 'cheers']);
const CHAT_LIMIT = 100, CHAT_ID_LIMIT = 2000, FAVORITE_LIMIT = 1000;
const OFFLINE_WAIT = '等待入座玩家回到牌桌';
const compareHands = (a, b) => a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;
function chatProjection(message) {
  return { id: message.id, playerId: message.playerId, name: message.name, kind: message.kind,
    ...(message.kind === 'text' ? { text: message.text } : { emote: message.emote }),
    ...(message.kind === 'throw' ? { targetId: message.targetId, targetName: message.targetName } : {}), at: message.at };
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
  // Each transfer has the same limits, including old point-based clients.
  // Old min/max settings cannot weaken the new rule or cap a winning stack.
  s.minBuyInBB = BUYIN_MIN_BB; s.maxBuyInBB = BUYIN_MAX_BB; s.buyInStepBB = BUYIN_STEP_BB;
  s.minBuyIn = BUYIN_MIN_BB * s.bigBlind; s.maxBuyIn = BUYIN_MAX_BB * s.bigBlind;
  if (s.maxTotalBuyInBB !== null) {
    integer(s.maxTotalBuyInBB, BUYIN_MIN_BB, Math.floor(MAX_TOTAL_BUYIN / s.bigBlind), '每人本场累计带入上限（BB）');
    if (s.maxTotalBuyInBB % BUYIN_STEP_BB !== 0) fail('累计带入上限需要是 50 BB 的整数倍');
  }
  if (own(input, 'squidUnitBB')) {
    integer(input.squidUnitBB, 1, Math.floor(1000000 / s.bigBlind), '鱿鱼大盲数'); s.squidUnit = input.squidUnitBB * s.bigBlind;
  } else if (!own(input, 'squidUnit') && s.bigBlind !== original.bigBlind) s.squidUnit = original.squidUnit * s.bigBlind / original.bigBlind;
  integer(s.squidUnit, 1, 1000000, '鱿鱼积分'); s.squidUnitBB = s.squidUnit / s.bigBlind;
  if (!['normal', 'unlimited'].includes(s.squidMode)) fail('鱿鱼模式需要选择普通或无限');
  integer(s.squidExtraTokens, 0, 100, '无限鱿鱼额外鱼数');
  // Hand-count schedules are deliberately not interpreted as minutes. Old
  // open tables migrate to the default 10-minute clock on their next start.
  delete s.bombEveryHands;
  integer(s.durationMinutes, 30, 720, '牌桌时长（分钟）');
  // The server owns timing. Ignore obsolete client configuration, including
  // settings copied from older tables; only the table duration determines cards.
  s.actionSeconds = ACTION_SECONDS; s.timeBankSeconds = TIME_BANK_SECONDS; s.timeBankCards = timeBankGrant(s);
  integer(s.bombIntervalMinutes, 1, 120, '炸弹池间隔（分钟）'); integer(s.bombAnteBB, 1, 1000, '炸弹池前注大盲数');
  for (const k of ['approvalRequired', 'squid', 'mushroom', 'bombPot']) if (typeof s[k] !== 'boolean') fail('玩法开关格式错误');
  if (input.mushroom === true) fail('蘑菇玩法已停用，历史牌谱和旧池退款仍保留');
  s.mushroom = false; s.approvalRequired = false;
  return s;
}

export class RoomService {
  constructor(store) { this.store = store; this.db = store.data; this.connections = new Map(); this.chatRates = new Map(); this.observationId = randomUUID(); }
  user(id) { return Object.values(this.db.users).find(u => u.id === id); }
  room(code) { if (typeof code !== 'string' || !own(this.db.rooms, code)) fail('房间不存在，请检查邀请链接', 404); return this.db.rooms[code]; }
  member(r, id) { if (typeof id !== 'string' || !own(r.members, id)) fail('请先通过邀请链接加入房间', 403); return r.members[id]; }
  host(r, id) { if (r.hostId !== id) fail('只有房主可以操作', 403); }
  idle(r) { if (r.hand?.status === 'playing') fail('请等本手结束后再操作'); }
  active(r) { if (r.status === 'closed') fail('本场已结束，牌谱仍可查看'); }
  log(r, playerId, type, amount, note) {
    const row = { id: randomUUID(), at: now(), roomCode: r.code, playerId, name: this.user(playerId)?.name ?? '朋友', type, amount, bigBlind: r.settings.bigBlind, note };
    this.db.ledger.push(row); return row;
  }
  touch(r) { r.revision += 1; r.updatedAt = now(); }
  create(user, body) {
    const active = Object.values(this.db.rooms).filter(r => r.status !== 'closed');
    if (active.some(r => r.hostId === user.id)) fail('你已有一桌正在使用，请先结束旧桌后再建房', 409);
    if (active.length >= 10) fail('当前已有 10 桌正在使用，请稍后再建房', 409);
    const access = body.access ?? 'invite';
    if (!['public', 'invite'].includes(access)) fail('房间访问方式无效');
    const settings = settingsFor(body.settings);
    let code; do { code = randomBytes(4).readUInt32BE() % 900000 + 100000; } while (this.db.rooms[code]);
    code = String(code);
    const r = { code, name: cleanName(body.name, `${user.name}必赢的局`), hostId: user.id, access, invite: randomBytes(24).toString('base64url'), status: 'waiting', settings,
      createdAt: now(), updatedAt: now(), revision: 1, rulesVersion: 5, startedAt: null, endsAt: null, nextBombAt: null, autoDealPaused: false, nextHandAt: null, autoWaitReason: null, rebuyGrace: null, members: {}, pending: [], hand: null, handNumber: 0, buttonSeat: -1, deadline: null, commandIds: {},
      mini: { squid: { active: false, round: 0, participants: [], won: [], reserves: {}, unit: settings.squidUnit, lastResult: null }, mushroom: { pool: 0, unit: settings.mushroomUnit, contributions: {}, smallBlindId: null, lastResult: null } } };
    this.db.rooms[code] = r; this.joinMember(r, user); this.syncLifecycle(r); return r;
  }
  joinMember(r, user) {
    if (!r.members[user.id]) {
      if (Object.keys(r.members).length >= 30) fail('本桌成员已达 30 人');
      r.members[user.id] = { id: user.id, seat: null, stack: 0, totalBuyIn: 0, cashedOut: 0, sittingOut: false, joinedAt: now() };
    }
    if (r.startedAt != null) this.refreshTimeBanks(r);
    return r.members[user.id];
  }
  join(user, code, invite) {
    const r = this.room(code);
    if (!r.members[user.id] && r.access !== 'public' && (typeof invite !== 'string' || hash(invite) !== hash(r.invite))) fail('邀请链接无效，请向房主索取完整链接', 403);
    if (!r.members[user.id]) { this.active(r); this.joinMember(r, user); this.touch(r); }
    if (r.status !== 'closed' && r.startedAt == null) { r.idleSince = Date.now(); r.idleEpoch = this.observationId; this.syncLifecycle(r); }
    return r;
  }
  chat(user, code, input, { ip = 'local', timestamp = Date.now() } = {}) {
    const r = this.room(code), sender = this.member(r, user.id);
    if (own(input, 'auto') || own(input, 'system')) fail('不能发送系统或自动消息');
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
    else if (input.kind === 'throw' && THROW_EMOTES.has(input.emote)) {
      if (!Number.isInteger(sender.seat)) fail('请先入座，再与朋友互动');
      if (typeof input.targetId !== 'string' || input.targetId === user.id || !own(r.members, input.targetId) || !Number.isInteger(r.members[input.targetId].seat)) fail('请选择本桌另一位已入座的朋友');
      content = { emote: input.emote, targetId: input.targetId, targetName: this.user(input.targetId)?.name ?? '朋友' };
    }
    else fail('不支持的表情或消息类型');
    // Keep player limits separate from the shared IP allowance, so friends on
    // the same Wi-Fi can chat. Transport metadata never supplies author or time.
    const limits = [[`user:${user.id}`, 20, 1000], [`ip:${ip}`, 120, 0]];
    if (input.kind === 'throw') limits.push([`throw:${user.id}`, 12, 3000]);
    const pending = [];
    for (const [rateKey, maximum, interval] of limits) {
      const times = (this.chatRates.get(rateKey) ?? []).filter(t => timestamp - t < 60000);
      if (times.length >= maximum || (times.length && timestamp - times.at(-1) < interval)) fail(input.kind === 'throw' ? '互动太频繁，请稍后再试' : '消息发送太快，请稍后再试', 429);
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
    // Financial retries must outlive the bounded general command cache. Check
    // before lifecycle, seat and limit validation: an accepted request remains
    // the same request after delivery, cancellation, leaving or closing a table.
    if (own(m.buyinReceipts ?? {}, `command:${cmd.commandId}`)
      || (m.queuedBuyins ?? []).some(request => request.commandId === cmd.commandId)) return r;
    if (r.commandIds[key]) return r;
    if (cmd.type !== 'show') this.active(r);
    switch (cmd.type) {
      case 'sit': this.sit(r, m, cmd); break;
      case 'entryBlind':
        if (m.seat === null) fail('请先入座');
        if (r.hand?.status === 'playing' && r.hand.players.some(p => p.id === m.id)) fail('本手已发牌，无需重复补盲');
        this.setBlindMode(r, m, cmd.mode); break;
      case 'buyin': this.buyin(r, m, cmd); break;
      case 'approve': this.host(r, user.id); this.approve(r, cmd.requestId); break;
      case 'reject': this.host(r, user.id); r.pending = r.pending.filter(p => p.id !== cmd.requestId); break;
      case 'stand': this.requestDeparture(r, m, 'stand', cmd); break;
      case 'sitout':
        if (m.seat === null) fail('请先入座');
        if (typeof cmd.value !== 'boolean') fail('暂离开关格式错误');
        if (cmd.value) this.requestDeparture(r, m, 'sitout', cmd);
        else { this.setBlindMode(r, m, cmd.entryMode ?? 'wait'); m.sittingOut = false; m.pendingDeparture = null; m.departureSeq = null; }
        break;
      case 'cancelDeparture': m.pendingDeparture = null; m.departureSeq = null; break;
      case 'settleSquid':
        this.idle(r);
        if (!this.canSettleSquid(r, m.id)) fail('鱿鱼需持续等待 90 秒后，由在线的本轮参与者提前结算', 409);
        this.settleSquid(r, { reason: 'partial' }); break;
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
        if (r.hand.transition || r.hand.runout?.active) fail('本轮行动已结束，请等待发牌或结算', 409);
        if (r.presentation?.handId === r.hand.id && Number.isFinite(r.presentation.actionReadyAt)
          && Date.now() < r.presentation.actionReadyAt) fail('发牌中，请稍候行动', 409);
        if (!Number.isFinite(r.deadline) || Date.now() >= r.deadline) fail('行动已超时，请等待牌桌更新', 409);
        // Limit new voluntary raise totals at the command boundary. Calls,
        // blinds and an exact remaining-stack all-in keep their real amounts;
        // historical hands and the underlying poker rules need no migration.
        if (cmd.type === 'raise' && Number.isSafeInteger(cmd.amount) && cmd.amount % r.hand.bigBlind !== 0
          && cmd.amount !== availableActions(r.hand, user.id).maxRaiseTo) fail('下注或加注总额需要是整数 BB，剩余积分全下除外');
        applyAction(r.hand, user.id, cmd.type, cmd.amount); this.afterAction(r); break;
      case 'show': this.show(r, m, cmd); break;
      case 'settings': this.host(r, user.id); this.changeSettings(r, cmd.settings); break;
      case 'close': this.host(r, user.id); this.close(r); break;
      case 'transferHost':
        this.host(r, user.id); this.idle(r); this.member(r, cmd.playerId);
        if (Object.values(this.db.rooms).some(other => other.code !== r.code && other.status !== 'closed' && other.hostId === cmd.playerId)) fail('对方已是另一张活动牌桌的房主', 409);
        r.hostId = cmd.playerId; break;
      default: fail('不支持的操作');
    }
    if (r.startedAt == null) { r.idleSince = Date.now(); r.idleEpoch = this.observationId; }
    this.syncLifecycle(r); this.reconcileAutoDeal(r);
    r.commandIds[key] = Date.now();
    const keys = Object.keys(r.commandIds); for (const old of keys.slice(0, Math.max(0, keys.length - 2000))) delete r.commandIds[old];
    this.touch(r); return r;
  }
  setBlindMode(r, m, mode) {
    if (!['wait', 'post'].includes(mode)) fail('入桌方式需要选择等大盲或补盲加入');
    setEntryMode(r, m, mode);
  }
  sit(r, m, cmd) {
    if (m.seat !== null) fail('你已经入座');
    if (Object.values(this.db.rooms).some(other => other.code !== r.code && other.status !== 'closed' && other.members[m.id]?.seat != null)) fail('你已在另一桌入座，请先离座后再加入本桌', 409);
    const seat = integer(cmd.seat, 0, r.settings.maxPlayers - 1, '座位');
    if (Object.values(r.members).some(p => p.seat === seat) || r.pending.some(p => p.seat === seat && p.playerId !== m.id)) fail('这个座位已被占用或正在申请');
    if (cmd.entryMode !== undefined && !['wait', 'post'].includes(cmd.entryMode)) fail('入桌方式需要选择等大盲或补盲加入');
    const amount = this.buyinAmount(r, cmd);
    this.requestBuyin(r, m, seat, amount);
    // Seating also funds the table. Its receipt must survive leaving and the
    // bounded command cache, just like a later top-up receipt does.
    this.recordBuyinReceipt(m, { commandId: cmd.commandId, amount, at: now() }, 'applied');
    this.setBlindMode(r, m, cmd.entryMode ?? 'wait');
  }
  pendingBuyIn(m) { return (m.queuedBuyins ?? []).reduce((sum, request) => sum + request.amount, 0); }
  recordBuyinReceipt(m, request, status) {
    // The prefix also makes accepted IDs such as "__proto__" ordinary keys.
    // Keep these compact receipts for the table's lifetime; never evict them
    // with commandIds or clear them when the delivery queue is drained.
    (m.buyinReceipts ??= {})[`command:${request.commandId}`] = {
      amount: request.amount, requestedAt: request.at, status,
      settledAt: status === 'queued' ? null : now(),
    };
  }
  buyin(r, m, cmd) {
    if (m.seat === null) fail('请先选择座位');
    if (m.pendingDeparture === 'stand') fail('已安排离座，请先取消离座再补码', 409);
    const amount = this.buyinAmount(r, cmd);
    this.validateBuyin(r, m, amount);
    r.pending = r.pending.filter(request => request.playerId !== m.id);
    if (r.hand?.status === 'playing') {
      // These are future chips, never a mid-hand change to stack, commitment,
      // betting capacity, fish reserve, buy-in accounting or winnings.
      const request = { id: randomUUID(), commandId: cmd.commandId, amount, handId: r.hand.id, at: now() };
      (m.queuedBuyins ??= []).push(request);
      this.recordBuyinReceipt(m, request, 'queued');
      return;
    }
    // A top-up is not a request to resume, cancel departure or change seats.
    m.stack += amount; m.totalBuyIn += amount;
    this.recordBuyinReceipt(m, { commandId: cmd.commandId, amount, at: now() }, 'applied');
    this.log(r, m.id, 'buyin', amount, '补充积分（不计入输赢）');
  }
  cancelQueuedBuyins(r, m, reason) {
    const amount = this.pendingBuyIn(m);
    if (!amount) return;
    for (const request of m.queuedBuyins) this.recordBuyinReceipt(m, request, 'cancelled');
    m.queuedBuyins = [];
    const row = this.log(r, m.id, 'buyinCancelled', 0, `${reason}，已取消待到账补码 ${amount / r.settings.bigBlind} BB，不计入带入或输赢`);
    row.cancelledAmount = amount;
  }
  applyQueuedBuyins(r) {
    this.idle(r);
    // Validate the whole batch before changing any member. Actual API/timer
    // transactions additionally roll back the hand and this batch on save errors.
    const plans = Object.values(r.members).filter(m => this.pendingBuyIn(m) > 0).map(m => {
      if (m.seat === null || m.pendingDeparture === 'stand') return { m, cancel: true };
      let total = m.totalBuyIn;
      for (const request of m.queuedBuyins) {
        this.validateBuyin(r, { ...m, queuedBuyins: [], totalBuyIn: total }, request.amount);
        total += request.amount;
      }
      return { m, requests: [...m.queuedBuyins] };
    });
    for (const { m, requests, cancel } of plans) {
      if (cancel) { this.cancelQueuedBuyins(r, m, '已离座'); continue; }
      m.queuedBuyins = [];
      for (const request of requests) {
        m.stack += request.amount; m.totalBuyIn += request.amount;
        this.recordBuyinReceipt(m, request, 'applied');
        Object.assign(this.log(r, m.id, 'buyin', request.amount, '本手结束，待补积分到账（不计入输赢）'), { queuedRequestId: request.id, requestedAt: request.at, afterHandId: request.handId });
      }
    }
  }
  buyinAmount(r, cmd) {
    const amount = own(cmd, 'amountBB') ? integer(cmd.amountBB, BUYIN_MIN_BB, BUYIN_MAX_BB, '单次带入大盲数') * r.settings.bigBlind : cmd.amount;
    this.validateBuyin(r, null, amount);
    return amount;
  }
  validateBuyin(r, m, amount) {
    const bb = r.settings.bigBlind;
    integer(amount, BUYIN_MIN_BB * bb, BUYIN_MAX_BB * bb, '单次带入积分');
    if (amount % (BUYIN_STEP_BB * bb) !== 0) fail('每次带入需要是 50 BB 的整数倍（100–1000 BB）');
    if (!m) return;
    const total = m.totalBuyIn + this.pendingBuyIn(m) + amount;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BUYIN) fail('本场累计带入超过安全计数范围');
    const limitBB = r.settings.maxTotalBuyInBB;
    if (limitBB != null && total > limitBB * bb) fail(`本场累计带入不能超过 ${limitBB} BB（已带入 ${m.totalBuyIn / bb} BB${this.pendingBuyIn(m) ? `，待到账 ${this.pendingBuyIn(m) / bb} BB` : ''}）`);
  }
  canRebuy(r, m) {
    if (!m || m.seat === null || m.sittingOut || m.pendingDeparture || m.stack !== 0 || this.pendingBuyIn(m) > 0) return false;
    const amount = BUYIN_MIN_BB * r.settings.bigBlind, total = m.totalBuyIn + amount;
    return Number.isSafeInteger(total) && total <= MAX_TOTAL_BUYIN
      && (r.settings.maxTotalBuyInBB == null || total <= r.settings.maxTotalBuyInBB * r.settings.bigBlind);
  }
  rebuyGraceState(r, timestamp = Date.now()) {
    const grace = r.rebuyGrace;
    if (!grace || r.status === 'closed' || r.hand?.status !== 'complete' || grace.handId !== r.hand.id) return null;
    const pendingIds = grace.eligibleIds.filter(id => this.canRebuy(r, r.members[id]));
    return { handId: grace.handId, eligibleIds: [...grace.eligibleIds], pendingIds, startsAt: grace.startsAt, endsAt: grace.endsAt,
      active: !r.autoDealPaused && timestamp >= grace.startsAt && timestamp < grace.endsAt && pendingIds.length > 0 };
  }
  rebuyGracePhase(r, timestamp) {
    const grace = this.rebuyGraceState(r, timestamp);
    return !grace ? null : timestamp < grace.startsAt ? 'watch' : timestamp < grace.endsAt ? 'grace' : 'expired';
  }
  requestBuyin(r, m, seat, amount) {
    this.validateBuyin(r, m, amount);
    const request = { id: randomUUID(), playerId: m.id, name: this.user(m.id).name, seat, amount, at: now() };
    // A fresh valid request replaces only this player's uncredited legacy
    // approval request; other players' reserved seats remain protected.
    r.pending = r.pending.filter(p => p.playerId !== m.id);
    r.pending.push(request);
    this.approve(r, request.id);
  }
  approve(r, requestId) {
    const p = r.pending.find(x => x.id === requestId); if (!p) fail('申请已处理或不存在');
    const m = this.member(r, p.playerId);
    if (m.seat !== null) this.idle(r);
    if (m.seat === null && Object.values(this.db.rooms).some(other => other.code !== r.code && other.status !== 'closed' && other.members[m.id]?.seat != null)) fail('你已在另一桌入座，请先离座后再加入本桌', 409);
    if (Object.values(r.members).some(x => x.id !== m.id && x.seat === p.seat)) fail('座位已被占用');
    this.validateBuyin(r, m, p.amount);
    if (m.seat === null) m.waitingSquidRound = r.mini.squid.active && !r.mini.squid.participants.includes(m.id) ? r.mini.squid.round : null;
    if (m.seat === null) markEntrySeat(r, m, p.seat);
    m.seat = p.seat; m.stack += p.amount; m.totalBuyIn += p.amount; m.sittingOut = false; m.pendingDeparture = null;
    r.pending = r.pending.filter(x => x.id !== requestId);
    this.log(r, m.id, 'buyin', p.amount, '带入积分（不计入输赢）');
  }
  requestDeparture(r, m, type, cmd = {}) {
    const q = r.mini.squid, participating = q.active && q.participants.includes(m.id);
    const round = participating ? q.round : 0, detail = squidDetails(q);
    const cost = participating && !detail.counts[m.id] ? detail.tokenBudget * q.unit : 0;
    if (cost > 0 && (!own(cmd, 'expectedSquidRound') || !own(cmd, 'expectedSquidCost'))) fail('离座后本轮鱿鱼预留和结算责任仍保留，请更新页面并确认后继续', 409);
    if ((own(cmd, 'expectedSquidRound') && cmd.expectedSquidRound !== round) || (own(cmd, 'expectedSquidCost') && cmd.expectedSquidCost !== cost)) fail('鱿鱼轮次或退出费用已变化，请重新确认', 409);
    if (m.seat === null) return;
    if (r.hand?.status === 'playing' && r.hand.players.some(p => p.id === m.id)) {
      m.pendingDeparture = type; m.departureSeq ??= r.departureSeq = (r.departureSeq ?? 0) + 1;
      return;
    }
    this.depart(r, m, type);
  }
  depart(r, m, type, hand = null, timestamp = Date.now()) {
    const q = r.mini.squid;
    // Leaving does not end a round or refund its reserve. The original identity
    // may return before settlement, and absent winners keep their entitlement.
    m.pendingDeparture = null; m.departureSeq = null;
    if (type === 'sitout') { m.sittingOut = true; return; }
    this.stand(r, m);
  }
  stand(r, m) {
    this.cancelQueuedBuyins(r, m, '已离座');
    r.pending = r.pending.filter(p => p.playerId !== m.id);
    if (m.seat === null) return;
    markEntrySeat(r, m, null);
    const amount = m.stack; m.cashedOut += amount; m.stack = 0; m.seat = null; m.sittingOut = false;
    this.log(r, m.id, 'cashout', amount, '离桌收回积分');
  }
  applyDepartures(r, hand, timestamp) {
    const pending = Object.values(r.members).filter(m => m.pendingDeparture).sort((a, b) => a.departureSeq - b.departureSeq);
    for (const m of pending) this.depart(r, m, m.pendingDeparture, hand, timestamp);
  }
  changeSettings(r, input) {
    this.idle(r); if (r.startedAt != null || r.handNumber > 0) fail('开局后房间配置已锁定，请结束本场后新建房间');
    const next = settingsFor(input, r.settings);
    if (r.mini.squid.active || r.mini.mushroom.pool > 0) fail('小游戏尚有进行中的轮次或积累池，请先结束整场后新建房间');
    if (r.pending.length) fail('请先处理带入申请');
    if (Object.values(r.members).some(m => m.seat !== null && m.seat >= next.maxPlayers)) fail('减少人数前，请让超出座位范围的玩家离座');
    if (next.maxTotalBuyInBB !== null && Object.values(r.members).some(m => m.totalBuyIn > next.maxTotalBuyInBB * next.bigBlind)) fail('累计带入上限不能低于本场已有带入');
    r.settings = next; r.mini.squid.unit = next.squidUnit; r.mini.mushroom.unit = next.mushroomUnit;
  }
  online(r, id) { return (this.connections.get(`${r.code}:${id}`) ?? 0) > 0; }
  // Planning never changes chips, the roster or entry debts. Only a successfully
  // constructed future hand commits admission; current-hand money stays fixed.
  squidJoinPlan(r, timestamp = Date.now(), { requireOnline = true } = {}) {
    const q = r.mini.squid, detail = squidDetails(q);
    const seated = Object.values(r.members).filter(m => m.seat !== null && !m.sittingOut && !m.pendingDeparture && m.stack > 0
      && (!requireOnline || this.online(r, m.id))).sort((a,b) => a.seat-b.seat);
    const originals = seated.filter(m => q.participants.includes(m.id));
    const pending = Object.values(r.members).filter(m => m.seat !== null && !q.participants.includes(m.id)).sort((a,b) => a.seat-b.seat);
    const base = { joinIds: [], debits: {}, tokenBudget: detail.tokenBudget, candidates: originals, entryPlan: planEntry(r, originals), waiting: {} };
    const provisional = detail.tokenBudget + 1;
    const wait = (m,status,reason,tokenBudget=provisional) => ({ status,reason,round:q.round,requiredReserve:tokenBudget*q.unit,tokenBudgetAfterJoin:tokenBudget });
    if (!q.active) return base;
    const eligible = [];
    for (const m of pending) {
      if (this.expired(r,timestamp)) base.waiting[m.id] = wait(m,'expired','牌桌已到时，本轮不再新增玩家；可等结束后开新局');
      else if (m.sittingOut || m.pendingDeparture) base.waiting[m.id] = wait(m,'sitting-out','请先回到牌桌，再从下一手加入本轮鱿鱼');
      else if (!this.online(r,m.id)) base.waiting[m.id] = wait(m,'offline','回到牌桌后，从下一手核对预留与补盲');
      else if (r.hand?.status === 'playing') base.waiting[m.id] = wait(m,'next-hand','本手结束后核对预留与补盲，满足条件的下一手以 0 鱼加入');
      else if (m.stack <= 0) base.waiting[m.id] = wait(m,'reserve','你的积分不足，请先补码，鱿鱼预留之外还需留出打牌积分');
      else eligible.push(m);
    }
    if (!eligible.length) return base;
    function combinations(items,count,start=0,prefix=[]) {
      if (!count) return [prefix];
      const result=[];
      for(let i=start;i<=items.length-count;i++)result.push(...combinations(items,count-1,i+1,[...prefix,items[i]]));
      return result;
    }
    const trial = newcomers => {
      if (q.participants.length+newcomers.length>30) return { status:'capacity',reason:'本轮参与身份已达 30 人，请等待本轮结束' };
      const tokenBudget = detail.tokenBudget+newcomers.length, target = tokenBudget*q.unit, debits = {};
      for (const id of q.participants) {
        if (detail.counts[id]) continue;
        const member=r.members[id], held=q.reserves[id];
        if (!member || !Number.isSafeInteger(held) || held<0) fail('鱿鱼预留积分异常，请保留牌桌并联系维护者',500);
        const debit=Math.max(0,target-held);
        if (member.stack<debit || originals.some(m=>m.id===id)&&member.stack<=debit) return {
          status:'reserve',reason:`${this.user(id)?.name ?? '本轮玩家'}需补足鱿鱼预留；等待其补码或本轮结束，原轮继续` };
        if (debit) debits[id]=debit;
      }
      for (const m of newcomers) {
        const state=entryState(r,m), entry=needsEntry(r,m), minimum=entry?r.settings.bigBlind+(state.mode==='post'&&state.missedSmall?r.settings.smallBlind:0):1;
        if (m.stack<target+minimum) return { status:'reserve',reason:`${this.user(m.id)?.name ?? '新玩家'}的积分不足，加入需预留 ${target} 积分并留出补盲积分` };
        debits[m.id]=target;
      }
      const candidates=[...originals,...newcomers].map(m=>({...m,stack:m.stack-(debits[m.id]??0)})).sort((a,b)=>a.seat-b.seat);
      const entryPlan=planEntry(r,candidates);
      const excluded=newcomers.find(m=>!entryPlan.players.some(p=>p.id===m.id));
      if (entryPlan.players.length<2 || excluded) {
        const waiting = entryPlan.waiting.find(p=>p.playerId===excluded?.id);
        return { status:'entry-blind',entryWaitingFor:waiting?.waitingFor ?? 'players',reason:waiting?.reason ?? '等待至少两位玩家完成补盲后加入' };
      }
      return { joinIds:newcomers.map(m=>m.id),debits,tokenBudget,candidates,entryPlan,waiting:{} };
    };
    // At most nine seats: choose the largest legal simultaneous cohort. This
    // handles two newcomers restoring a table without charging either before a
    // hand exists, and never lets one unaffordable entrant block the old roster.
    let selected=base;
    outer: for(let count=eligible.length;count>0;count--) for(const subset of combinations(eligible,count)) {
      const candidate=trial(subset);
      if(candidate.joinIds){selected=candidate;break outer;}
    }
    selected.waiting={...base.waiting};
    for(const m of eligible) {
      if(selected.joinIds.includes(m.id)) selected.waiting[m.id]=wait(m,'next-hand','已具备加入条件，从下一手加入本轮鱿鱼',selected.tokenBudget);
      else {
        const check=trial([...eligible.filter(p=>selected.joinIds.includes(p.id)),m]);
        selected.waiting[m.id]={...wait(m,check.status??'entry-blind',check.reason??'等待下一个可补盲的位置'),entryWaitingFor:check.entryWaitingFor ?? null};
      }
    }
    return selected;
  }
  waitingFor(r, m) {
    if (m.seat === null) return null;
    if (r.hand?.status === 'playing' && r.hand.players.some(p => p.id === m.id)) return null;
    if (r.mini.squid.active && !r.mini.squid.participants.includes(m.id)) return 'squid';
    return r.hand?.status === 'playing' && !r.hand.players.some(p => p.id === m.id) ? 'hand' : null;
  }
  entryFor(r, m, squidAdmission = null) {
    const info = projectEntry(r, m), state = entryState(r, m);
    const base = { ...info, required: info.pending, reason: state.played ? 'missed' : 'new',
      waitingFor: info.pending && info.mode === 'wait' ? 'bigBlind' : null, naturalBigBlind: false, nextHandEligible: false,
      estimated: r.hand?.status === 'playing' };
    if (!info.pending || m.seat === null) return base;
    if (m.pendingDeparture) return { ...base, waitingFor: 'departing' };
    if (m.sittingOut) return { ...base, waitingFor: 'sittingOut' };
    if (!this.online(r, m.id)) return { ...base, waitingFor: 'offline' };
    if (m.stack <= 0) return { ...base, waitingFor: 'funds' };
    // Current-hand entrants are already seated. Include them when projecting
    // position restrictions; filtering the old squid roster hid their wait for
    // the button and misleadingly advertised that posting would deal at once.
    const candidates = Object.values(r.members).filter(p => p.seat !== null && !p.sittingOut && !p.pendingDeparture && p.stack > 0 && this.online(r, p.id));
    let plan = planEntry(r, candidates), waiting = plan.waiting.find(p => p.playerId === m.id);
    if (r.mini.squid.active && r.hand?.status !== 'playing') {
      const admission = squidAdmission ?? this.squidJoinPlan(r), quote = admission.waiting[m.id];
      if (quote && !['next-hand', 'entry-blind'].includes(quote.status)) return { ...base, waitingFor: quote.status };
      // Between hands use the actual funded admission cohort. No hypothetical
      // newcomer may change another player's displayed natural blind position.
      plan = admission.entryPlan;
      waiting = plan.waiting.find(p => p.playerId === m.id);
      if (quote?.status === 'entry-blind') return { ...base, waitingFor: quote.entryWaitingFor ?? waiting?.waitingFor ?? 'bigBlind' };
    }
    const nextHandEligible = plan.players.some(p => p.id === m.id);
    return { ...base, waitingFor: waiting?.waitingFor ?? (nextHandEligible ? null : 'players'),
      nextHandEligible, naturalBigBlind: nextHandEligible && plan.orbit?.bigBlindSeat === m.seat };
  }
  handSquidRound(h) {
    return own(h, 'squidRound') ? h.squidRound : h.miniBefore?.squid?.active ? h.miniBefore.squid.round : null;
  }
  handSquidInfo(h) {
    const squidRound = this.handSquidRound(h);
    if (squidRound === null) return { squidRound, squidMode: null, squidTokenBudget: null, squidCounts: {}, squidAwardedId: null };
    const q = [h.miniAfter?.squid, h.miniBefore?.squid].find(q => q?.round === squidRound);
    const detail = q ? squidDetails(q) : null;
    return { squidRound, squidMode: h.squidMode ?? detail?.mode ?? 'normal', squidTokenBudget: h.squidTokenBudget ?? detail?.tokenBudget ?? null,
      squidCounts: copy(h.squidCounts ?? detail?.counts ?? {}), squidAwardedId: h.squidAwardedId ?? null };
  }
  squidStack(r, id) {
    // Chips committed in the current hand are not an inability to buy the next hand.
    return r.hand?.status === 'playing' ? r.hand.players.find(p => p.id === id)?.startingStack ?? r.members[id]?.stack : r.members[id]?.stack;
  }
  squidReady(r) {
    const q = r.mini.squid;
    return q.participants.filter(id => {
      const m = r.members[id];
      return m && m.seat !== null && !m.sittingOut && this.squidStack(r, id) > 0 && this.online(r, id);
    });
  }
  squidAbsentResult(r, timestamp = Date.now(), admission = null) {
    const q = r.mini.squid;
    if (!q.active || r.status === 'closed' || r.hand?.status === 'playing' || !q.won.length) return false;
    const join = admission ?? this.squidJoinPlan(r,timestamp);
    if (join.joinIds.length) return false;
    const ready = this.squidReady(r), unmarked = q.participants.filter(id => !q.won.includes(id));
    // Never manufacture a winner when everyone is away. A participant waiting
    // for an entry blind is still available to earn a marker in a later hand.
    return unmarked.length > 1 && ready.length > 0 && ready.every(id => q.won.includes(id));
  }
  squidBlock(r, timestamp = Date.now(), admission = null) {
    const q = r.mini.squid;
    if (!q.active || r.status === 'closed') return null;
    const ready = this.squidReady(r);
    if (r.hand?.status !== 'playing') {
      const join = admission ?? this.squidJoinPlan(r,timestamp);
      if (join.entryPlan.players.length >= 2) return null;
    }
    if (ready.length >= 2) {
      // A live hand remains playable even if the next hand would wait on entry.
      if (r.hand?.status === 'playing') return null;
      const plan = planEntry(r, ready.map(id => r.members[id]));
      if (plan.players.length >= 2) return null;
      return { ids: ready, key: 'entry-blinds', reason: '本轮玩家正在等待大盲，请一人选择补盲加入；持续 90 秒后可提前结算' };
    }
    return { ids: q.participants.filter(id => !ready.includes(id)), key: 'insufficient-opponents',
      reason: '本轮鱿鱼可参与人数不足两人，等待回桌或补码；持续 90 秒后可提前结算' };
  }
  // Retained for old callers; absent players no longer switch a round to Hold'em.
  squidFallback() { return false; }
  expired(r, timestamp = Date.now()) { return r.endsAt != null && timestamp >= r.endsAt; }
  expiryState(r, timestamp = Date.now()) {
    if (r.status === 'closed' || !this.expired(r, timestamp) || !r.mini.squid.active) return { mode: null, deadline: null };
    if (!this.squidBlock(r, timestamp)) return { mode: 'finish-squid', deadline: null };
    const since = r.squidOvertimeEpoch === this.observationId && Number.isFinite(r.squidOvertimeWaitSince) ? r.squidOvertimeWaitSince : null;
    return { mode: 'wait-squid', deadline: since == null ? null : since + SQUID_BLOCK_GRACE };
  }
  finishExpiredRoom(r, timestamp = Date.now()) {
    if (r.status === 'closed' || r.hand?.status === 'playing' || !this.expired(r, timestamp)) return false;
    this.syncLifecycle(r, timestamp);
    const expiry = this.expiryState(r, timestamp);
    if (!r.mini.squid.active || (expiry.mode === 'wait-squid' && expiry.deadline !== null && timestamp >= expiry.deadline)) { this.close(r, timestamp); return true; }
    return false;
  }
  lifecyclePlan(r, timestamp = Date.now()) {
    if (r.status === 'closed') return { room: {}, squid: {} };
    const block = this.squidBlock(r, timestamp), q = r.mini.squid;
    const blockerSince = block ? q.blockerEpoch === this.observationId && q.blockerKey === block.key && Number.isFinite(q.blockerSince) ? q.blockerSince : timestamp : null;
    const idle = r.status !== 'closed' && r.startedAt == null && !Object.keys(r.members).some(id => this.online(r, id));
    const idleSince = idle ? r.idleEpoch === this.observationId && Number.isFinite(r.idleSince) ? r.idleSince : timestamp : null;
    const room = idle ? { idleSince, idleEpoch: this.observationId } : r.idleSince != null ? { idleSince: null } : {};
    if (this.expired(r, timestamp) && r.hand?.status !== 'playing' && block && (r.squidOvertimeEpoch !== this.observationId || !Number.isFinite(r.squidOvertimeWaitSince))) {
      Object.assign(room, { squidOvertimeWaitSince: timestamp, squidOvertimeEpoch: this.observationId });
    }
    const squid = block ? { blockerSince, blockerKey: block.key, blockerEpoch: this.observationId, settleReady: timestamp - blockerSince >= SQUID_BLOCK_GRACE }
      : q.blockerSince != null || q.blockerKey != null || q.settleReady ? { blockerSince: null, blockerKey: null, settleReady: false } : {};
    const pending = this.squidAbsentResult(r, timestamp);
    let pendingAt = pending ? q.absentEpoch === this.observationId && Number.isFinite(q.absentSettlementAt) ? q.absentSettlementAt : timestamp + AUTO_DEAL_DELAY : null;
    const rebuy = this.rebuyGraceState(r, timestamp);
    // A busted original participant's wait is already anchored to this hand.
    // Reconnect/restart must not replace it with a fresh absence countdown.
    if (pending && rebuy?.pendingIds.some(id => q.participants.includes(id))) pendingAt = rebuy.endsAt;
    if (pendingAt !== (q.absentSettlementAt ?? null) || pending && q.absentEpoch !== this.observationId) {
      Object.assign(squid, { absentSettlementAt: pendingAt, absentEpoch: pending ? this.observationId : null });
    }
    if ((!block || r.hand?.status === 'playing') && r.squidOvertimeWaitSince != null) Object.assign(room, { squidOvertimeWaitSince: null, squidOvertimeEpoch: null });
    return { room, squid };
  }
  lifecycleChanged(r, plan) {
    return Object.entries(plan.room).some(([key, value]) => r[key] !== value) || Object.entries(plan.squid).some(([key, value]) => r.mini.squid[key] !== value);
  }
  syncLifecycle(r, timestamp = Date.now()) {
    const plan = this.lifecyclePlan(r, timestamp), changed = this.lifecycleChanged(r, plan);
    if (changed) { Object.assign(r, plan.room); Object.assign(r.mini.squid, plan.squid); }
    return changed;
  }
  canSettleSquid(r, userId, timestamp = Date.now()) {
    const q = r.mini.squid, block = this.squidBlock(r, timestamp);
    return Boolean(r.hand?.status !== 'playing' && block && q.participants.includes(userId) && this.online(r, userId) && q.blockerEpoch === this.observationId && q.blockerKey === block.key && Number.isFinite(q.blockerSince) && timestamp - q.blockerSince >= SQUID_BLOCK_GRACE);
  }
  bombDueAt(r, settings = r.settings) {
    if (r.status === 'closed' || !settings.bombPot || !Number.isFinite(r.startedAt)) return null;
    if (Number.isFinite(r.nextBombAt)) return r.nextBombAt;
    return r.startedAt + (settings.bombIntervalMinutes ?? DEFAULTS.bombIntervalMinutes) * 60000;
  }
  prepareStart(r, timestamp = Date.now(), { requireOnline = false } = {}) {
    let candidates = Object.values(r.members).filter(m => m.seat !== null && !m.sittingOut && m.stack > 0 && (!requireOnline || this.online(r, m.id))).sort((a, b) => a.seat - b.seat);
    const s = settingsFor({}, r.settings), squid = r.mini.squid;
    const mayStartMini = r.endsAt == null || timestamp < r.endsAt - MINI_CUTOFF;
    let squidAdmission = null;
    if (squid.active) {
      squidAdmission = this.squidJoinPlan(r,timestamp,{requireOnline});
      if (this.squidAbsentResult(r,timestamp,squidAdmission)) fail('无鱼玩家暂不可参与，等待几秒重连后结算本轮');
      candidates = squidAdmission.candidates;
    }
    if (candidates.length < 2) fail('至少需要两位已入座且有积分的朋友');
    // A due timer waits for the next eligible hand; it never interrupts play
    // or stacks missed occurrences. Entry still gets a natural blind first.
    const bombAt = this.bombDueAt(r, s);
    const bombPot = s.bombPot && mayStartMini && bombAt !== null && timestamp >= bombAt && !candidates.some(m => needsEntry(r, m));
    let entryPlan = planEntry(r, candidates, { bombPot });
    const newSquid = s.squid && !squid.active && mayStartMini && entryPlan.players.length === candidates.length;
    if (newSquid && candidates.length < 3) fail('鱿鱼玩法至少需要三人');
    const tokenBudget = s.squidMode === 'unlimited' ? candidates.length + s.squidExtraTokens : candidates.length - 1;
    const reserve = newSquid ? tokenBudget * s.squidUnit : 0;
    if (newSquid) {
      for (const m of candidates) if (m.stack <= reserve) fail(`${this.user(m.id).name} 积分不足，需先补码（鱿鱼预留 ${reserve}）`);
      entryPlan = planEntry(r, candidates.map(m => ({ ...m, stack: m.stack - reserve })), { bombPot });
      if (entryPlan.players.length !== candidates.length) fail('鱿鱼预留后积分不足以补盲，请先补码或等待大盲');
    }
    if (entryPlan.players.length < 2) fail(entryPlan.waiting[0]?.reason || '等待至少两位玩家完成入桌补盲或等大盲');
    const players = entryPlan.players.map(m => r.members[m.id]);
    return { players, s, squid, mayStartMini, newSquid, buttonSeat: entryPlan.buttonSeat, reserve, tokenBudget, ordinaryFallback: false, entryPlan, bombPot, squidAdmission };
  }
  requestStart(r, timestamp = Date.now()) {
    this.idle(r);
    if (this.finishExpiredRoom(r, timestamp)) return;
    if (r.handNumber === 0) { r.autoDealPaused = false; this.start(r, timestamp, { automatic: true }); return; }
    if (r.hand?.rabbit?.active) {
      this.completeRabbit(r, timestamp); r.nextHandAt = null;
      r.autoDealPaused = false; this.reconcileAutoDeal(r, timestamp); return;
    }
    if (Number.isFinite(r.nextHandAt) && r.nextHandAt > timestamp && !r.autoDealPaused) fail('下一手正在倒计时，请稍候', 409);
    // Old clients and pre-upgrade completed rooms resume the same server clock.
    r.autoDealPaused = false; this.reconcileAutoDeal(r, timestamp);
  }
  start(r, timestamp = Date.now(), { automatic = false } = {}) {
    this.idle(r);
    if (this.finishExpiredRoom(r, timestamp)) return;
    const { players, s, squid, mayStartMini, newSquid, buttonSeat, reserve, tokenBudget, ordinaryFallback, entryPlan, bombPot, squidAdmission } = this.prepareStart(r, timestamp, { requireOnline: automatic });
    // Construct before charging either initial or incremental reserve. A failed
    // deal leaves the pending cohort and every old participant's balance intact.
    const h = createHand({ id: randomUUID(), players: players.map(m => ({ id: m.id, name: this.user(m.id).name, seat: m.seat,
      stack: m.stack-(newSquid?reserve:squidAdmission?.debits[m.id]??0) })), buttonSeat, smallBlind: s.smallBlind, bigBlind: s.bigBlind,
      entryPosts: entryPlan.posts, bombPot, ante: bombPot ? s.bombAnteBB * s.bigBlind : 0, deferredRunout: true, deferredTransitions: true });
    h.audit = commitDeck(h);
    this.completeRabbit(r, timestamp);
    r.nextHandAt = null; r.autoWaitReason = null; r.rebuyGrace = null;
    if (newSquid) {
      squid.active = true; squid.round++; squid.participants = players.map(m => m.id); squid.won = []; squid.reserves = {}; squid.unit = s.squidUnit; squid.roundSettlementId = randomUUID(); squid.rulesVersion = 5;
      squid.mode = s.squidMode; squid.extraTokens = s.squidMode === 'unlimited' ? s.squidExtraTokens : 0;
      squid.tokenBudget = tokenBudget; squid.counts = Object.fromEntries(squid.participants.map(id => [id, 0])); squid.admissions = [];
      squid.blockerSince = null; squid.blockerKey = null; squid.settleReady = false; squid.absentSettlementAt = null; squid.absentEpoch = null;
      for (const m of players) { m.stack -= reserve; squid.reserves[m.id] = reserve; }
    } else if (squidAdmission?.joinIds.length) {
      const detail=squidDetails(squid), before=detail.tokenBudget;
      for(const [id,amount] of Object.entries(squidAdmission.debits)) {
        r.members[id].stack-=amount; squid.reserves[id]=(squid.reserves[id]??0)+amount;
      }
      squid.participants.push(...squidAdmission.joinIds);
      squid.counts={...detail.counts,...Object.fromEntries(squidAdmission.joinIds.map(id=>[id,0]))};
      squid.tokenBudget=squidAdmission.tokenBudget; squid.rulesVersion=6;
      (squid.admissions??=[]).push({handId:h.id,handNumber:r.handNumber+1,at:new Date(timestamp).toISOString(),playerIds:[...squidAdmission.joinIds],
        tokenBudgetBefore:before,tokenBudgetAfter:squid.tokenBudget,reserveIncreases:copy(squidAdmission.debits)});
      for(const id of squidAdmission.joinIds)r.members[id].waitingSquidRound=null;
      squid.absentSettlementAt=null;squid.absentEpoch=null;
    }
    r.settings = s;
    if (r.startedAt == null) { r.startedAt = timestamp; r.endsAt = timestamp + s.durationMinutes * 60000; }
    this.refreshTimeBanks(r, timestamp);
    // Commit the clock only after the hand is successfully constructed.
    r.nextBombAt = !s.bombPot ? null : bombPot ? timestamp + s.bombIntervalMinutes * 60000 : this.bombDueAt(r, s);
    h.number = ++r.handNumber; h.at = new Date(timestamp).toISOString(); h.roomCode = r.code; h.roomName = r.name; h.settings = copy(s); h.shown = {};
    h.squidRound = squid.active && !ordinaryFallback ? squid.round : null; h.settings.squid = h.squidRound !== null;
    const detail = h.settings.squid ? squidDetails(squid) : null;
    h.squidMode = detail?.mode ?? null; h.squidTokenBudget = detail?.tokenBudget ?? null; h.squidCounts = copy(detail?.counts ?? {}); h.squidAwardedId = null;
    if (detail) { h.settings.squidMode = detail.mode; h.settings.squidExtraTokens = detail.extraTokens; }
    if (h.squidRound !== null) { r.squidOvertimeWaitSince = null; r.squidOvertimeEpoch = null; }
    h.miniChanges = Object.fromEntries(players.map(m => [m.id, 0])); h.timeBankUses = [];
    h.miniBefore = copy(r.mini); r.hand = h; r.presentation = null; r.resultReadyAt = null; commitEntry(r, entryPlan, h); r.buttonSeat = buttonSeat; r.status = 'playing';
    this.afterAction(r, timestamp);
  }
  afterAction(r, timestamp = Date.now()) {
    const h = r.hand;
    if (h.transition?.revealed) {
      h.shown ??= {};
      for (const p of h.players) if (!p.folded) h.shown[p.id] = [0, 1];
    }
    this.recordEquity(h);
    const previous = r.presentation?.handId === h.id ? r.presentation : null;
    const revealDelay = !previous ? DEAL_PRESENTATION_DELAY : h.board.length > previous.boardCount ? STREET_PRESENTATION_DELAY : 0;
    const actionReadyAt = h.status === 'playing' && h.actingId ? timestamp + revealDelay : null;
    r.presentation = { handId: h.id, boardCount: h.board.length, actionReadyAt, turnStartedAt: actionReadyAt, readyPublished: revealDelay === 0 || actionReadyAt === null };
    for (const p of h.players) r.members[p.id].stack = p.stack;
    if (h.status === 'complete') {
      r.deadline = null; r.status = 'waiting'; this.finish(r, timestamp);
      if (!this.finishExpiredRoom(r, timestamp)) { r.autoDealPaused ??= false; this.syncLifecycle(r, timestamp); this.reconcileAutoDeal(r, timestamp); }
    } else if (h.transition) {
      r.deadline = null;
      if (!Number.isFinite(h.transition.nextAt)) h.transition.nextAt = timestamp + transitionDelay(h);
    } else if (h.runout?.active) {
      r.deadline = null; h.runout.nextAt = timestamp + (h.board.length === h.allInLock.board.length ? 1800 : 1500);
    } else r.deadline = actionReadyAt + ACTION_SECONDS * 1000;
    this.syncLifecycle(r, timestamp);
  }
  recordEquity(h) {
    if (!h.allInLock) return;
    // This lock contains only exposed contenders. Never pass the deck, burns or folded cards.
    h.shown ??= {};
    for (const p of h.allInLock.players) h.shown[p.id] = [0, 1];
    h.allInEquity ??= calculateEquity(h.allInLock);
    h.equityFrames ??= [];
    if (!h.equityFrames.some(frame => frame.boardCount === h.board.length)) {
      const equity = h.board.length === h.allInLock.board.length ? h.allInEquity : calculateEquity({ ...h.allInLock, board: h.board });
      const reveal = [...h.log].reverse().find(e => ['street','runoutCard','allInLock'].includes(e.type));
      h.equityFrames.push({ boardCount: h.board.length, board: [...h.board], logSeq: reveal?.seq ?? h.log.length, equity });
    }
  }
  autoBlockReason(r, timestamp = Date.now()) {
    if (r.status === 'closed' || r.hand?.status === 'playing' || r.handNumber === 0) return null;
    if (!own(r, 'autoDealPaused')) return '等待房主继续，之后会自动发牌';
    if (r.autoDealPaused) return '房主已暂停自动发牌';
    if (this.squidAbsentResult(r, timestamp)) return '等待几秒重连后，按已有鱼结算本轮';
    const block = this.squidBlock(r, timestamp);
    if (block && !this.squidFallback(r, timestamp)) return this.expired(r, timestamp) ? '牌桌已到时，等待原鱿鱼轮恢复；90 秒后仍无法继续将结算散桌' : block.reason;
    if (!Object.values(r.members).some(m => m.seat !== null && !m.sittingOut && m.stack > 0 && this.online(r, m.id))) return OFFLINE_WAIT;
    let players;
    try { ({ players } = this.prepareStart(r, timestamp, { requireOnline: true })); }
    catch (error) { if (error.status === 400) return error.message; throw error; }
    if (!players.some(m => (this.connections.get(`${r.code}:${m.id}`) ?? 0) > 0)) return OFFLINE_WAIT;
    return null;
  }
  autoPlan(r, timestamp = Date.now()) {
    // No persisted-data migration: legacy completed rooms need one host resume.
    if (!own(r, 'autoDealPaused')) return null;
    if (r.status === 'closed' || r.hand?.status === 'playing' || r.handNumber === 0) return { nextHandAt: null, autoWaitReason: null };
    const autoWaitReason = this.autoBlockReason(r, timestamp);
    const grace = this.rebuyGraceState(r, timestamp);
    if (grace && timestamp < grace.endsAt) {
      const due = timestamp < grace.startsAt || !grace.pendingIds.length ? grace.startsAt : grace.endsAt;
      const minimum = Number.isFinite(r.resultReadyAt) ? r.resultReadyAt + AUTO_DEAL_DELAY : 0;
      return { nextHandAt: autoWaitReason ? null : Math.max(due, minimum), autoWaitReason };
    }
    const due = Number.isFinite(r.nextHandAt) ? r.nextHandAt : timestamp + AUTO_DEAL_DELAY;
    const minimum = Number.isFinite(r.resultReadyAt) ? r.resultReadyAt + AUTO_DEAL_DELAY : 0;
    return { nextHandAt: autoWaitReason ? null : Math.max(due, minimum), autoWaitReason };
  }
  reconcileAutoDeal(r, timestamp = Date.now()) {
    if (this.finishExpiredRoom(r, timestamp)) return true;
    const phase = this.rebuyGracePhase(r, timestamp), phaseChanged = phase !== null && r.rebuyGrace.phase !== phase;
    if (phaseChanged) r.rebuyGrace.phase = phase;
    const plan = this.autoPlan(r, timestamp);
    const changed = plan && (r.nextHandAt !== plan.nextHandAt || r.autoWaitReason !== plan.autoWaitReason);
    if (changed) Object.assign(r, plan);
    const grace = this.rebuyGraceState(r, timestamp);
    // Buy-in/departure commands may finish the extra wait between timer ticks.
    // The original five-second result hold remains.
    if (grace && timestamp >= grace.startsAt && timestamp < grace.endsAt && !grace.pendingIds.length
      && !r.hand?.rabbit?.active && Number.isFinite(r.nextHandAt) && r.nextHandAt <= timestamp && !r.autoDealPaused) {
      this.start(r, timestamp, { automatic: true }); return true;
    }
    return Boolean(changed || phaseChanged);
  }
  connectionChanged(r, timestamp = Date.now(), { reconnected = false } = {}) {
    const grace = this.rebuyGraceState(r, timestamp);
    const reset = reconnected && !(grace && timestamp < grace.endsAt) && r.hand?.status !== 'playing' && Number.isFinite(r.nextHandAt) && r.nextHandAt <= timestamp;
    if (reset) r.nextHandAt = null;
    const lifecycle = this.syncLifecycle(r, timestamp);
    const changed = this.reconcileAutoDeal(r, timestamp) || lifecycle || reset;
    if (changed) this.touch(r);
    return changed;
  }
  timeBankFor(r, m) {
    if (m.timeBank?.version === 2) return m.timeBank;
    const granted = timeBankGrant(r.settings);
    // Preserve the exact remaining balance of an already-running legacy table.
    // Migration never refreshes spent cards or changes the current deadline.
    if (Number.isSafeInteger(m.timeBank?.remaining) && m.timeBank.remaining >= 0) {
      return { version: 2, granted, remaining: m.timeBank.remaining, legacyPreserved: true };
    }
    // An interrupted old save may contain usage but no bank. Count each hand
    // once, including an unarchived current hand, rather than grant spent cards.
    const hands = new Map(this.db.hands.filter(h => h.roomCode === r.code).map(h => [h.id, h]));
    if (r.hand) hands.set(r.hand.id, r.hand);
    const used = [...hands.values()].reduce((sum, h) => sum + (h.timeBankUses ?? []).filter(use => use.playerId === m.id).length, 0);
    return { version: 2, granted, remaining: Math.max(0, granted - used) };
  }
  refreshTimeBanks(r) {
    if (r.startedAt == null) return false;
    let changed = false;
    for (const m of Object.values(r.members)) if (m.timeBank?.version !== 2) {
      m.timeBank = this.timeBankFor(r, m); changed = true;
    }
    return changed;
  }
  useTimeBank(r, m, cmd, timestamp = Date.now()) {
    if (r.hand?.status !== 'playing' || cmd.handId !== r.hand.id || cmd.actionSeq !== r.hand.log.length) fail('行动轮次已更新，请重新操作', 409);
    if (r.hand.actingId !== m.id) fail('只有当前行动的玩家可以使用时间牌', 403);
    if (r.presentation?.handId === r.hand.id && Number.isFinite(r.presentation.actionReadyAt)
      && timestamp < r.presentation.actionReadyAt) fail('发牌中，请稍候使用时间牌', 409);
    if (!Number.isFinite(r.deadline) || timestamp >= r.deadline) fail('行动已超时，不能使用时间牌', 409);
    this.refreshTimeBanks(r, timestamp);
    if (!m.timeBank?.remaining) fail('本场时间牌已用完');
    m.timeBank.remaining--;
    const seconds = TIME_BANK_SECONDS;
    r.deadline += seconds * 1000;
    (r.hand.timeBankUses ??= []).push({ playerId: m.id, at: timestamp, actionSeq: cmd.actionSeq, seconds, remaining: m.timeBank.remaining });
  }
  needsTick(r, timestamp = Date.now()) {
    if (r.status === 'closed') return false;
    if (r.hand?.status === 'playing' && r.presentation?.handId === r.hand.id && !r.presentation.readyPublished
      && Number.isFinite(r.presentation.actionReadyAt) && timestamp >= r.presentation.actionReadyAt) return true;
    const rebuyPhase = this.rebuyGracePhase(r, timestamp);
    if (rebuyPhase !== null && r.rebuyGrace.phase !== rebuyPhase) return true;
    if (this.lifecycleChanged(r, this.lifecyclePlan(r, timestamp))) return true;
    if (r.startedAt == null && Number.isFinite(r.idleSince) && r.idleEpoch === this.observationId && timestamp - r.idleSince >= EMPTY_ROOM_TIMEOUT) return true;
    if (this.squidAbsentResult(r, timestamp) && r.mini.squid.absentEpoch === this.observationId && Number.isFinite(r.mini.squid.absentSettlementAt) && timestamp >= r.mini.squid.absentSettlementAt) return true;
    if (r.hand?.rabbit?.active && timestamp >= r.hand.rabbit.nextAt) return true;
    if (r.hand?.runout?.active && timestamp >= r.hand.runout.nextAt) return true;
    if (r.hand?.status === 'playing' && r.hand.transition && timestamp >= r.hand.transition.nextAt) return true;
    if (r.hand?.status === 'playing' && r.deadline != null && timestamp >= r.deadline) return true;
    if (this.expired(r, timestamp) && r.hand?.status !== 'playing') {
      const expiry = this.expiryState(r, timestamp);
      if (!r.mini.squid.active || (expiry.deadline !== null && timestamp >= expiry.deadline)) return true;
    }
    const plan = this.autoPlan(r, timestamp);
    if (plan && (r.nextHandAt !== plan.nextHandAt || r.autoWaitReason !== plan.autoWaitReason || (plan.nextHandAt !== null && timestamp >= plan.nextHandAt))) return true;
    return r.startedAt != null && Object.values(r.members).some(m => m.timeBank?.version !== 2);
  }
  tick(r, timestamp = Date.now()) {
    if (!this.needsTick(r, timestamp)) return false;
    const lifecycle = this.syncLifecycle(r, timestamp);
    const presentationReady = r.hand?.status === 'playing' && r.presentation?.handId === r.hand.id && !r.presentation.readyPublished
      && Number.isFinite(r.presentation.actionReadyAt) && timestamp >= r.presentation.actionReadyAt;
    if (presentationReady) r.presentation.readyPublished = true;
    if (r.startedAt == null && Number.isFinite(r.idleSince) && timestamp - r.idleSince >= EMPTY_ROOM_TIMEOUT) { this.close(r, timestamp); this.touch(r); return true; }
    if (this.squidAbsentResult(r, timestamp) && r.mini.squid.absentEpoch === this.observationId && Number.isFinite(r.mini.squid.absentSettlementAt) && timestamp >= r.mini.squid.absentSettlementAt) {
      this.settleSquid(r, { reason: 'absent', timestamp });
      this.syncLifecycle(r, timestamp); this.reconcileAutoDeal(r, timestamp); this.touch(r); return true;
    }
    if (this.finishExpiredRoom(r, timestamp)) { this.touch(r); return true; }
    const refreshed = this.refreshTimeBanks(r, timestamp);
    if (r.hand?.status === 'playing' && r.hand.transition && timestamp >= r.hand.transition.nextAt) {
      advanceTransition(r.hand); this.afterAction(r, timestamp); this.touch(r); return true;
    }
    if (r.hand?.runout?.active && timestamp >= r.hand.runout.nextAt) {
      advanceRunout(r.hand); this.afterAction(r, timestamp); this.touch(r); return true;
    }
    // Finish any delayed supplemental reveal first. Its actual publication
    // anchors a fresh result hold, so a slow tick cannot skip the result screen.
    const rabbitChanged = r.hand?.rabbit?.active && timestamp >= r.hand.rabbit.nextAt ? this.revealRabbit(r, timestamp) : false;
    if (this.timeout(r, timestamp)) return true;
    const autoChanged = this.reconcileAutoDeal(r, timestamp);
    if (r.status !== 'closed' && r.hand?.status !== 'playing' && !r.hand?.rabbit?.active && r.nextHandAt !== null && Number.isFinite(r.nextHandAt) && timestamp >= r.nextHandAt) {
      this.start(r, timestamp, { automatic: true }); this.touch(r); return true;
    }
    if (refreshed || autoChanged || lifecycle || rabbitChanged || presentationReady) this.touch(r);
    return refreshed || autoChanged || lifecycle || rabbitChanged || presentationReady;
  }
  finish(r, timestamp = Date.now()) {
    const h = r.hand; if (h.recorded) return;
    r.resultReadyAt = timestamp;
    const cashedBefore = Object.fromEntries(Object.values(r.members).map(m => [m.id, m.cashedOut]));
    const squid = r.mini.squid, mushroom = r.mini.mushroom;
    const main = h.result.mainWinnerIds;
    if (h.settings.mushroom && main.length === 1 && main[0] === mushroom.smallBlindId) {
      const id = main[0], amount = mushroom.pool; r.members[id].stack += amount; h.miniChanges[id] += amount;
      mushroom.lastResult = { handId: h.id, playerId: id, amount }; mushroom.pool = 0; mushroom.contributions = {};
    }
    const countsForSquid = squid.active && this.handSquidRound(h) === squid.round;
    if (countsForSquid) {
      const detail = squidDetails(squid), id = main.length === 1 ? main[0] : null;
      if (id && squid.participants.includes(id) && detail.tokensRemaining > 0 && (detail.mode === 'unlimited' || !detail.counts[id])) {
        detail.counts[id]++; squid.counts = detail.counts;
        if (!squid.won.includes(id)) squid.won.push(id);
        h.squidAwardedId = id;
      }
      const after = squidDetails(squid);
      h.squidMode = after.mode; h.squidTokenBudget = after.tokenBudget; h.squidCounts = copy(after.counts);
      if (squid.won.length === squid.participants.length - 1 || after.tokensRemaining === 0) {
        const unmarked = squid.participants.filter(id => !after.counts[id]);
        this.settleSquid(r, { reason: 'normal', loserId: unmarked.length === 1 ? unmarked[0] : null, hand: h, timestamp });
      }
    }
    this.applyDepartures(r, h, timestamp);
    // Mandatory showdown exposes live contenders only. Folded cards remain private.
    h.shown ??= {};
    if (h.result.showdown) for (const p of h.players) if (!p.folded) h.shown[p.id] = [0, 1];
    h.endingStacks = Object.fromEntries(h.players.map(p => [p.id, r.members[p.id].stack + r.members[p.id].cashedOut - cashedBefore[p.id]]));
    h.miniAfter = copy(r.mini); h.recorded = true;
    for (const p of h.players) {
      const net = p.stack - p.startingStack, miniNet = (h.miniChanges[p.id] ?? 0) - (h.squidSettlementChanges?.[p.id] ?? 0);
      this.log(r, p.id, 'holdem', net, `第 ${h.number} 手德州结算`);
      if (miniNet) this.log(r, p.id, 'mini', miniNet, `第 ${h.number} 手小游戏结算`);
    }
    if (rabbitRunout(h)) h.rabbit = { version: 2, originalCount: h.board.length, board: [...h.board], indices: [], active: true, nextAt: timestamp + RABBIT_START_DELAY, finishedAt: null };
    // Archive ending stacks and poker/mini profit above exclude new buy-ins.
    // Now deliver queued chips before deciding who needs a rebuy grace window.
    this.applyQueuedBuyins(r);
    // One immutable opportunity per completed hand, after mini settlements and
    // declared departures. Old zero stacks and observers were not dealt cards.
    const eligibleIds = h.players.filter(p => p.startingStack > 0 && this.canRebuy(r, r.members[p.id])).map(p => p.id);
    r.rebuyGrace = eligibleIds.length ? { handId: h.id, eligibleIds, startsAt: timestamp + AUTO_DEAL_DELAY,
      endsAt: timestamp + AUTO_DEAL_DELAY + REBUY_GRACE_DELAY, phase: 'watch' } : null;
    this.db.hands.push(copy(h));
  }
  settleSquid(r, { reason, loserId = null, hand = null, timestamp = Date.now() }) {
    const q = r.mini.squid;
    if (!q.active) return null;
    if (r.hand?.status === 'playing') fail('请等待本手结算后再结束鱿鱼轮', 409);
    if (!['normal', 'forfeit', 'partial', 'absent'].includes(reason)) fail('鱿鱼结算原因无效', 500);
    const detail = squidDetails(q), { counts, mode, tokenBudget, tokensAwarded } = detail;
    const winners = q.participants.filter(id => counts[id] > 0), losers = q.participants.filter(id => !counts[id]);
    const tokensExhausted = mode === 'unlimited' && detail.tokensRemaining === 0;
    if (reason === 'normal' && !(tokensExhausted || losers.length === 1 && loserId === losers[0])) fail('鱿鱼尚未满足结轮条件', 500);
    if (reason === 'forfeit' && (!losers.includes(loserId) || losers.length !== 1)) fail('鱿鱼结算参与者无效', 500);
    const changes = Object.fromEntries(q.participants.map(id => [id, counts[id] > 0 ? losers.length * counts[id] * q.unit : -tokensAwarded * q.unit]));
    for (const id of q.participants) if (!r.members[id] || !Number.isSafeInteger(q.reserves[id]) || q.reserves[id] + changes[id] < 0) fail('鱿鱼预留积分异常，请保留牌桌并联系维护者', 500);
    const roundSettlementId = q.roundSettlementId ?? randomUUID();
    if (this.db.ledger.some(row => row.type === 'squidSettlement' && row.roomCode === r.code && row.roundSettlementId === roundSettlementId)) fail('鱿鱼轮次已结算，请刷新牌桌', 409);
    for (const id of q.participants) {
      const m = r.members[id], amount = changes[id], returned = q.reserves[id] + amount;
      if (m.seat === null) m.cashedOut += returned; else m.stack += returned;
      const row = this.log(r, id, 'squidSettlement', amount, `第 ${q.round} 轮鱿鱼${reason === 'partial' ? '提前' : reason === 'absent' ? '缺席多人' : reason === 'forfeit' ? '主动退出' : ''}结算`);
      Object.assign(row, { at: new Date(timestamp).toISOString(), roundSettlementId, round: q.round, reason,
        squidMode: mode, squidCount: counts[id], tokenBudget, tokensAwarded, tokensExhausted,
        squidUnit: q.unit, participantIds: [...q.participants],
        handId: hand?.id ?? (r.hand?.status === 'complete' ? r.hand.id : null), rulesVersion: q.rulesVersion ?? 5 });
      if (hand) hand.miniChanges[id] = (hand.miniChanges[id] ?? 0) + amount;
    }
    if (hand) { hand.squidSettlementId = roundSettlementId; hand.squidSettlementChanges = copy(changes); }
    q.roundSettlementId = roundSettlementId;
    q.lastResult = { handId: hand?.id ?? (r.hand?.status === 'complete' ? r.hand.id : null), roundSettlementId, round: q.round, reason, loserId, loserIds: losers, amount: tokensAwarded * losers.length * q.unit, winnerIds: winners, unit: q.unit, changes,
      settledAt: new Date(timestamp).toISOString(),
      mode, counts: copy(counts), tokenBudget, tokensAwarded, tokensExhausted };
    q.active = false; q.reserves = {}; q.absentSettlementAt = null; q.absentEpoch = null; q.blockerSince = null; q.blockerKey = null; q.settleReady = false;
    return q.lastResult;
  }
  revealRabbit(r, timestamp = Date.now()) {
    const h = r.hand, rabbit = h?.rabbit;
    if (!rabbit?.active || h.status !== 'complete') return false;
    const remaining = rabbitRunout(h), offset = rabbit.board.length - rabbit.originalCount;
    if (!remaining || offset < 0 || offset >= remaining.cards.length) fail('补看进度无效', 500);
    // Reveal all still-hidden public cards together, including a persisted v1
    // partial prefix. Only rabbit changes; real board/log/payout/EV stay fixed.
    rabbit.board.push(...remaining.cards.slice(offset)); rabbit.indices.push(...remaining.indices.slice(offset));
    rabbit.active = false; rabbit.nextAt = null; rabbit.finishedAt = timestamp;
    r.resultReadyAt = timestamp;
    if (r.rebuyGrace?.handId === h.id && r.rebuyGrace.startsAt < timestamp + AUTO_DEAL_DELAY) {
      r.rebuyGrace.startsAt = timestamp + AUTO_DEAL_DELAY;
      r.rebuyGrace.endsAt = r.rebuyGrace.startsAt + REBUY_GRACE_DELAY;
      r.rebuyGrace.phase = 'watch';
    }
    const archived = this.db.hands.find(hand => hand.id === h.id);
    if (archived) archived.rabbit = copy(rabbit);
    return true;
  }
  completeRabbit(r, timestamp = Date.now()) {
    while (r.hand?.rabbit?.active) this.revealRabbit(r, timestamp);
  }
  rabbitFor(h, { summary = false } = {}) {
    const rabbit = h?.rabbit;
    if (!rabbit || (summary && rabbit.active)) return null;
    const visible = { board: [...rabbit.board], originalCount: rabbit.originalCount };
    if (summary) return visible;
    return { ...visible, active: rabbit.active, nextAt: rabbit.active ? rabbit.nextAt : null,
      finishedAt: rabbit.finishedAt ?? null, proofs: rabbit.indices.slice(0, rabbit.board.length - rabbit.originalCount).map(index => cardProof(h, index)) };
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
    for (const m of Object.values(r.members)) this.cancelQueuedBuyins(r, m, '牌桌已结束');
    this.completeRabbit(r, timestamp);
    const q = r.mini.squid, mushroom = r.mini.mushroom;
    if (q.active) this.settleSquid(r, { reason: 'partial', timestamp });
    for (const [id, amount] of Object.entries(mushroom.contributions)) {
      const m = r.members[id]; if (m.seat === null) m.cashedOut += amount; else m.stack += amount;
      this.log(r, id, 'mushroomRefund', amount, '散桌退还尚未派奖的蘑菇贡献');
    }
    mushroom.pool = 0; mushroom.contributions = {};
    for (const m of Object.values(r.members)) if (m.seat !== null) {
      this.log(r, m.id, 'cashout', m.stack, '本场结束，收回剩余积分'); m.cashedOut += m.stack; m.stack = 0; m.seat = null; m.pendingDeparture = null; m.departureSeq = null;
    }
    r.status = 'closed'; r.closedAt = new Date(timestamp).toISOString(); r.pending = []; r.deadline = null; r.nextHandAt = null; r.autoWaitReason = null; r.rebuyGrace = null;
  }
  timeout(r, timestamp = Date.now()) {
    if (r.hand?.status !== 'playing' || r.hand.runout?.active || !r.deadline || timestamp < r.deadline) return false;
    const actor = r.hand.actingId, a = availableActions(r.hand, actor);
    applyAction(r.hand, actor, a.canCheck ? 'check' : 'fold');
    r.hand.log.push({ seq: r.hand.log.length + 1, street: r.hand.street, playerId: actor, type: 'timeout', amount: 0 });
    this.afterAction(r, timestamp); this.touch(r); return true;
  }
  shownIndicesFor(h, p) {
    // A completed showdown is authoritative. Old archives must not hide a
    // called river hand merely because their optional shown marker is missing.
    if (h.status === 'complete' && h.result?.showdown === true && !p.folded) return [0, 1];
    return [...new Set(h.shown?.[p.id] ?? [])].filter(index => index === 0 || index === 1).sort();
  }
  cardsFor(h, p, viewerId) { return p.cards.map((c, i) => p.id === viewerId || this.shownIndicesFor(h, p).includes(i) ? c : null); }
  proofsFor(h, viewerId) {
    const positions = [...h.boardIndices];
    for (const p of h.players) for (let i = 0; i < p.cardIndices.length; i++) if (p.id === viewerId || this.shownIndicesFor(h, p).includes(i)) positions.push(p.cardIndices[i]);
    return [...new Set(positions)].map(i => cardProof(h, i));
  }
  handCategoryFor(h, p, viewerId) {
    // A player's private category belongs only to that player. Opponents and
    // spectators see categories only for live, fully exposed contenders.
    if (p.id !== viewerId && (p.folded || this.shownIndicesFor(h, p).length !== 2)) return null;
    let board = h.board;
    if (p.folded) {
      // Preserve the category at the fold, including after reconnect/restart.
      // Reconstruct from the persisted action street rather than subsequent
      // public cards; rabbit cards must never change the actual hand category.
      const fold = h.log.find(event => event.playerId === p.id && event.type === 'fold');
      const count = { preflop: 0, flop: 3, turn: 4, river: 5 }[fold?.street];
      if (count === undefined) return null;
      board = h.board.slice(0, count);
    }
    const cards = [...p.cards, ...board];
    if (cards.length >= 5) return evaluate(cards).name;
    const counts = Object.values(cards.reduce((all, card) => { all[card[0]] = (all[card[0]] ?? 0) + 1; return all; }, {})).sort((a, b) => b - a);
    return counts[0] === 4 ? '四条' : counts[0] === 3 ? '三条' : counts[0] === 2 && counts[1] === 2 ? '两对' : counts[0] === 2 ? '一对' : '高牌';
  }
  resultFor(h) {
    if (!h.result) return null;
    const result = { pots: copy(h.result.pots), payouts: copy(h.result.payouts), mainWinnerIds: [...h.result.mainWinnerIds], showdown: h.result.showdown, handNames: {} };
    // Normalize the legacy display label only in this viewer-safe projection;
    // the stored hand, ranking tuples and payouts must remain untouched.
    for (const [id, name] of Object.entries(h.result.handNames ?? {})) if (h.players.some(p => p.id === id && this.shownIndicesFor(h, p).length === 2)) result.handNames[id] = name === '皇家同花顺' ? '同花顺' : name;
    return result;
  }
  summary(h, userId) {
    const p = h.players.find(x => x.id === userId);
    return { id: h.id, number: h.number, at: h.at, bigBlind: handBigBlind(h), board: [...h.board], profit: p ? p.stack - p.startingStack : 0, miniProfit: h.miniChanges?.[userId] ?? 0,
      rabbit: this.rabbitFor(h, { summary: true }), ...this.handSquidInfo(h),
      winners: h.result.mainWinnerIds.map(id => ({ id, name: h.players.find(x => x.id === id)?.name ?? '朋友', amount: h.result.payouts[id] ?? 0 })) };
  }
  state(r, viewerId) {
    this.member(r, viewerId); const h = r.hand;
    const timestamp = Date.now(), bank = this.timeBankFor(r, this.member(r, viewerId));
    const currentSettings = r.status === 'closed' ? r.settings : settingsFor({}, r.settings), nextBombAt = this.bombDueAt(r, currentSettings);
    const timeBankCards = bank.remaining;
    const squidAdmission=r.mini.squid.active?this.squidJoinPlan(r,timestamp):null;
    const mini = copy(r.mini), block = this.squidBlock(r, timestamp, squidAdmission);
    Object.assign(mini.squid, squidDetails(r.mini.squid));
    const expiry = this.expiryState(r, timestamp);
    mini.squid.paused = Boolean(block?.offlineOnly); mini.squid.pauseReason = block?.offlineOnly ? block.reason : null;
    mini.squid.expiryGraceEndsAt = expiry.deadline;
    mini.squid.blockerSince = r.mini.squid.blockerEpoch === this.observationId && r.mini.squid.blockerKey === block?.key ? r.mini.squid.blockerSince : null;
    mini.squid.blockerIds = block?.ids ?? []; mini.squid.canSettle = this.canSettleSquid(r, viewerId, timestamp); mini.squid.settleAfterSeconds = SQUID_BLOCK_GRACE / 1000;
    mini.squid.absentSettlementAt = this.squidAbsentResult(r, timestamp, squidAdmission) && r.mini.squid.absentEpoch === this.observationId ? r.mini.squid.absentSettlementAt ?? null : null;
    delete mini.squid.absentEpoch;
    delete mini.squid.blockerEpoch; delete mini.squid.blockerKey; delete mini.squid.settleReady;
    const actions = h && h.status === 'playing' ? availableActions(h, viewerId) : { canAct: false, canCheck: false, canFold: false, callAmount: 0, canRaise: false, minRaiseTo: 0, maxRaiseTo: 0, canAllIn: false };
    const presentation = r.presentation?.handId === h?.id ? r.presentation : null;
    actions.turnAvailable = actions.canAct;
    actions.canAct = actions.canAct && (!Number.isFinite(presentation?.actionReadyAt) || timestamp >= presentation.actionReadyAt);
    actions.canUseTimeBank = actions.canAct && timeBankCards > 0 && Number.isFinite(r.deadline) && timestamp < r.deadline;
    actions.timeBankCards = timeBankCards; actions.timeBankSeconds = TIME_BANK_SECONDS;
    const pots = h ? potPreview(h) : null;
    const publicHand = h ? { actionReadyAt: presentation?.actionReadyAt ?? null, turnStartedAt: presentation?.turnStartedAt ?? null,
      pots: pots.pots, uncalledBets: pots.uncalledBets, id: h.id, number: h.number, status: h.status, street: h.street, board: [...h.board], buttonSeat: h.buttonSeat,
      ...this.handSquidInfo(h),
      rabbit: this.rabbitFor(h),
      transition: h.transition ? { kind: h.transition.kind, nextAt: h.transition.nextAt, revealed: Boolean(h.transition.revealed || h.transition.afterRunout) } : null,
      runout: h.runout ? { active: h.runout.active, nextAt: h.runout.active ? h.runout.nextAt : null } : null, equity: copy(h.equityFrames?.at(-1)?.equity ?? null),
      bombPot: h.bombPot ?? false, ante: h.ante ?? 0, timeBankUses: copy(h.timeBankUses ?? []), smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, actingId: h.actingId, currentBet: h.currentBet,
      pot: h.players.reduce((n, p) => n + p.contributed, 0), actionSeq: h.log.length, log: copy(h.log), result: this.resultFor(h), commitment: h.audit.root, proofs: this.proofsFor(h, viewerId) } : null;
    const acceptedCommandIds = Object.keys(r.commandIds ?? {}).filter(key => key.startsWith(`${viewerId}:`)).slice(-16).map(key => key.slice(viewerId.length + 1));
    return { code: r.code, name: r.name, access: r.access === 'public' ? 'public' : 'invite', status: r.status, hostId: r.hostId, meId: viewerId, acceptedCommandIds, invite: r.invite, settings: { ...copy(currentSettings), approvalRequired: false }, nextBombAt, bombDue: nextBombAt !== null && timestamp >= nextBombAt, revision: r.revision, serverTime: Date.now(), deadline: r.deadline, createdAt: r.createdAt, startedAt: r.startedAt ?? null, endsAt: r.endsAt ?? null,
      expiryMode: expiry.mode, autoDeal: { paused: own(r, 'autoDealPaused') ? Boolean(r.autoDealPaused) : r.handNumber > 0, nextHandAt: r.nextHandAt ?? null, waitReason: this.autoBlockReason(r, timestamp), delaySeconds: AUTO_DEAL_DELAY / 1000, rebuyGrace: this.rebuyGraceState(r, timestamp) },
      miniGamesCutoffAt: r.endsAt == null ? null : r.endsAt - MINI_CUTOFF,
      timeBankResetAt: null,
      players: Object.values(r.members).map(m => {
        const u = this.user(m.id), p = h?.players.find(x => x.id === m.id);
        return { id: m.id, name: u?.name ?? '朋友', avatar: u?.avatar ?? 0, avatarImage: avatarImageId(u?.avatarImage), seat: m.seat, stack: m.stack, totalBuyIn: m.totalBuyIn, pendingBuyIn: this.pendingBuyIn(m),
          sessionProfit: m.stack + m.cashedOut + (r.mini.squid.reserves[m.id] ?? 0) - m.totalBuyIn,
          timeBankCardsRemaining: this.timeBankFor(r, m).remaining, sittingOut: m.sittingOut, connected: (this.connections.get(`${r.code}:${m.id}`) ?? 0) > 0,
          entryBlind: this.entryFor(r, m, squidAdmission), pendingDeparture: m.pendingDeparture ?? null, waitingFor: this.waitingFor(r, m), connectionWait: m.seat !== null && !this.online(r, m.id) ? '等待回到牌桌' : null,
          squidWon: (mini.squid.counts[m.id] ?? 0) > 0, squidCount: mini.squid.counts[m.id] ?? 0, squidReserve: r.mini.squid.reserves[m.id] ?? 0,
          squidJoin: squidAdmission?.waiting[m.id] ?? null,
          squidMaxLoss: r.mini.squid.active && r.mini.squid.participants.includes(m.id) && !mini.squid.counts[m.id] ? mini.squid.tokenBudget * r.mini.squid.unit : 0,
          handCategory: p ? this.handCategoryFor(h, p, viewerId) : null,
          cards: p ? this.cardsFor(h, p, viewerId) : [], shownIndices: p ? this.shownIndicesFor(h, p) : [],
          handSeat: p?.seat ?? null, folded: p?.folded ?? false, allIn: p?.allIn ?? false, bet: h?.status === 'playing' ? p?.bet ?? 0 : 0,
          contributed: p?.contributed ?? 0, inHand: Boolean(p), lastAction: h?.log.filter(a => a.playerId === m.id && !['payout', 'street', 'refund'].includes(a.type)).at(-1)?.type ?? null };
      }),
      pending: copy(r.pending.filter(p => viewerId === r.hostId || p.playerId === viewerId)),
      hand: publicHand, actions,
      mini, recentHands: this.db.hands.filter(x => x.roomCode === r.code).slice(-20).reverse().map(x => this.summary(x, viewerId)),
      ledger: this.db.ledger.filter(x => x.roomCode === r.code).slice(-80), messages: [], chat: (r.chat ?? []).slice(-CHAT_LIMIT).map(chatProjection) };
  }
  playerStats(viewerId, roomCode, playerId, options = {}) {
    const room = this.room(roomCode); this.member(room, viewerId); this.member(room, playerId);
    return publicPlayerStats(this.db, viewerId, roomCode, this.user(playerId), options);
  }
  history(userId, roomCode, options = {}) {
    const r = this.room(roomCode); this.member(r, userId);
    if (Object.keys(options).length) return this.handLibrary(userId, { ...options, room: roomCode }, true);
    return { hands: this.db.hands.filter(h => h.roomCode === roomCode).slice().reverse().map(h => this.summary(h, userId)) };
  }
  handFor(userId, roomCode, handId) {
    const r = this.room(roomCode); this.member(r, userId);
    const h = this.db.hands.find(x => x.roomCode === roomCode && x.id === handId); if (!h) fail('牌谱不存在', 404);
    return { id: h.id, number: h.number, at: h.at, roomCode, roomName: h.roomName, settings: copy(h.settings), bigBlind: handBigBlind(h), board: [...h.board],
      ...this.handSquidInfo(h),
      rabbit: this.rabbitFor(h),
      allIn: h.allInLock ? { logSeq: h.allInLock.logSeq, playerIds: h.allInLock.players.map(p => p.id) } : null, equityFrames: copy(h.equityFrames ?? []),
      favorite: h.players.some(p => p.id === userId) && (this.user(userId)?.favoriteHands ?? []).includes(h.id),
      buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, ante: h.ante ?? 0, bombPot: h.bombPot ?? false, timeBankUses: copy(h.timeBankUses ?? []),
      players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack, endingStack: h.endingStacks[p.id], cards: this.cardsFor(h, p, userId), folded: p.folded,
        net: p.stack - p.startingStack, miniNet: h.miniChanges?.[p.id] ?? 0 })),
      log: copy(h.log), result: this.resultFor(h), mini: { before: copy(h.miniBefore), after: copy(h.miniAfter), changes: copy(h.miniChanges) },
      squidSettlementId: h.squidSettlementId ?? null, squidSettlementChanges: copy(h.squidSettlementChanges ?? {}),
      commitment: h.audit.root, proofs: this.proofsFor(h, userId), verificationVersion: VERIFICATION_VERSION };
  }
  sessions(userId, options = {}) {
    if (options.room) this.member(this.room(options.room), userId);
    return sessionLibrary(this.db, userId, options);
  }
  opponents(userId, options = {}) {
    if (options.room) this.member(this.room(options.room), userId);
    return directRecordLibrary(this.db, userId, options);
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
    if (filter.opponent === userId) fail('请选择其他玩家作为对手');
    const users = new Map(Object.values(this.db.users).map(user => [user.id, user])), opponentNames = new Map(), entries = [];
    // Scan archived hands once. Context is reconstructed at most once per
    // eligible hand and carried through totals/report/page projections.
    for (const h of this.db.hands) {
      if (h.status !== 'complete') continue;
      const p = h.players.find(p => p.id === userId);
      if (p) for (const peer of h.players) if (peer.id !== userId && !opponentNames.has(peer.id)) opponentNames.set(peer.id, users.get(peer.id)?.name ?? peer.name ?? '朋友');
      if (!((p || includeObserved && Boolean(this.db.rooms[h.roomCode]?.members[userId])) && (!room || h.roomCode === room) && (favorites !== '1' || favoriteIds.has(h.id))
        && Date.parse(h.at) >= filter.start && Date.parse(h.at) <= filter.end
        && (filter.handNumber === null || h.number === filter.handNumber)
        && resultMatches((p ? p.stack - p.startingStack : 0) + (h.miniChanges?.[userId] ?? 0), filter.result, filter.minBB, handBigBlind(h))
        && holeMatches(p?.cards, filter)
        && handGameMatches(h, filter)
        && (!filter.q || `${h.number} ${h.id} ${h.roomName}`.toLocaleLowerCase('zh-CN').includes(filter.q)))) continue;
      const context = handContext(h, userId);
      if (handContextMatches(context, userId, filter)) entries.push({ hand: h, player: p, context });
    }
    entries.sort((a, b) => compareHands(a.hand, b.hand));
    const filtered = filter.maxHands === null ? entries : entries.slice(0, filter.maxHands);
    const totals = recordTotals(filtered, e => e.player ? e.player.stack - e.player.startingStack : 0, e => e.hand.miniChanges?.[userId] ?? 0);
    totals.bb = recordBBTotals(filtered, e => ({ holdemNet: amountInBB(e.player ? e.player.stack - e.player.startingStack : 0, handBigBlind(e.hand)),
      miniNet: amountInBB(e.hand.miniChanges?.[userId] ?? 0, handBigBlind(e.hand)) }));
    const opponents = opponentRecords(filtered, userId, filter, users);
    const opponentOptions = [...opponentNames].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    const matches = filtered.filter(e => !cursor || compareHands(e.hand, cursor) > 0);
    const page = matches.slice(0, count), last = page.at(-1);
    return { hands: page.map(({ hand: h, player: p, context }) => {
      const net = p ? p.stack - p.startingStack : 0, miniNet = h.miniChanges?.[userId] ?? 0;
      return { id: h.id, roomCode: h.roomCode, roomName: h.roomName, number: h.number, at: h.at, bigBlind: handBigBlind(h), board: [...h.board], cards: p ? [...p.cards] : [null, null], participated: Boolean(p),
        position: context.position, flopPlayers: context.flopPlayers, potType: context.potType, tableSize: context.tableSize, ...this.handSquidInfo(h),
        rabbit: this.rabbitFor(h, { summary: true }),
        net, miniNet, totalNet: net + miniNet, pot: (h.result?.pots ?? []).reduce((sum, pot) => sum + pot.amount, 0), bombPot: Boolean(h.bombPot), favorite: favoriteIds.has(h.id) };
    }), totals, opponents, opponentOptions, nextCursor: matches.length > count ? Buffer.from(JSON.stringify({ at: last.hand.at, id: last.hand.id })).toString('base64url') : null };
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
    const settlements = squidSettlementMap(this.db.ledger);
    return this.db.hands.filter(h => (!roomCode || h.roomCode === roomCode) && h.players.some(p => p.id === userId) && Date.parse(h.at) >= start && Date.parse(h.at) <= end)
      .map(h => {
        const visible = this.handFor(userId, h.roomCode, h.id);
        // New squid rounds are standalone dated adjustments; do not repeat them
        // in hands whose start time can lie on a different day from settlement.
        for (const p of visible.players) p.miniNet = handMiniNet(h, p.id, settlements);
        for (const id of Object.keys(visible.mini.changes)) visible.mini.changes[id] = handMiniNet(h, id, settlements);
        return visible;
      });
  }
  exportAdjustments(userId, roomCode, from, to) {
    const { start, end } = this.exportRange(userId, roomCode, from, to);
    const seen = new Set();
    return this.db.ledger.filter(l => {
      if (l.playerId !== userId || !['mushroomRefund', 'squidSettlement'].includes(l.type) || (roomCode && l.roomCode !== roomCode) || Date.parse(l.at) < start || Date.parse(l.at) > end) return false;
      if (l.type === 'squidSettlement') { const key = `${l.roomCode}:${l.roundSettlementId}:${l.playerId}`; if (seen.has(key)) return false; seen.add(key); }
      return true;
    })
      .map(l => ({ ...copy(l), roomName: this.room(l.roomCode).name }));
  }
  stats(userId, options = {}) {
    if (options.room) this.member(this.room(options.room), userId);
    return aggregateAnalytics(this.db, userId, options);
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
  for (const a of adjustments) texts.push({ at: a.at, text: `BBPoker Adjustment [${a.id}] ${a.at}\nRoom: ${a.roomName} (${a.roomCode})\n${a.name}: ${a.note}; Mini ${a.amount >= 0 ? '+' : ''}${a.amount} points\n` });
  return texts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(x => x.text).join('\n');
}

export function exportCsv(hands, userId, adjustments = []) {
  const escape = v => typeof v === 'number' && Number.isFinite(v) ? String(v) : '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [['记录类型','手牌ID','时间','房间','手数','本人底牌','公共牌','德州盈亏','小游戏盈亏','合计','承诺根']];
  const entries = [];
  for (const h of hands) { const p = h.players.find(p => p.id === userId); entries.push(['手牌',h.id,h.at,h.roomName,h.number,p.cards.map(c => c ?? '??').join(' '),h.board.join(' '),p.net,p.miniNet,p.net+p.miniNet,h.commitment]); }
  for (const a of adjustments) entries.push([a.type === 'squidSettlement' ? '鱿鱼结算' : '退款',a.id,a.at,a.roomName,'','','',0,a.amount,a.amount,'']);
  rows.push(...entries.sort((a, b) => Date.parse(a[2]) - Date.parse(b[2])));
  return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n');
}
