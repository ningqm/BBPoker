// Replay only a server-filtered completed hand. Never evaluate or infer cards.
const paid = new Set(['ante', 'smallBlind', 'bigBlind', 'call', 'raise', 'allin']);
const streets = new Set(['preflop', 'flop', 'turn', 'river']);
function validHand(hand) {
  if (!hand || 'deck' in hand || 'audit' in hand || !Array.isArray(hand.players) || !Array.isArray(hand.log)) throw new Error('只支持已过滤的历史牌谱');
}
function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('牌谱积分记录无效');
  return value;
}
export function replayStreets(hand) {
  validHand(hand);
  const result = [{ street: 'preflop', label: hand.bombPot ? '前注' : '开始', index: 0 }];
  const labels = { flop: '翻牌', turn: '转牌', river: '河牌' };
  for (let i = 0; i < hand.log.length; i++) {
    const event = hand.log[i];
    if (event.type === 'street' && labels[event.street] && !result.some(x => x.street === event.street)) result.push({ street: event.street, label: labels[event.street], index: i + 1 });
  }
  result.push({ street: 'complete', label: '结算', index: hand.log.length });
  return result;
}
export function replaySnapshot(hand, requestedIndex = 0, viewerId = '') {
  validHand(hand);
  const total = hand.log.length;
  const index = Math.max(0, Math.min(total, Number.isFinite(requestedIndex) ? Math.floor(requestedIndex) : 0));
  const complete = index === total;
  const players = hand.players.map(p => ({
    id: p.id, name: p.name, seat: p.seat,
    // Historical records do not timestamp voluntary reveals. Keep an opponent's
    // final public cards hidden until the result frame, even if already filtered.
    cards: [0, 1].map(i => p.id === viewerId || complete ? p.cards?.[i] ?? null : null),
    stack: amount(p.startingStack), bet: 0, contributed: 0,
    folded: false, allIn: false, payout: 0, lastAction: null,
    net: complete ? p.net : null, miniNet: complete ? p.miniNet ?? 0 : null,
    endingStack: complete ? p.endingStack : null,
  }));
  const byId = new Map(players.map(p => [p.id, p]));
  let board = [], street = 'preflop', pot = 0;
  for (const event of hand.log.slice(0, index)) {
    const p = byId.get(event.playerId);
    if (event.type === 'allInLock') {
      for (const id of hand.allIn?.playerIds ?? []) {
        const player = byId.get(id), original = hand.players.find(p => p.id === id);
        if (player && original) player.cards = [...original.cards];
      }
    } else if (event.type === 'runoutCard') {
      if (!Array.isArray(event.board)) throw new Error('跑牌记录无效');
      if (!board.length) for (const player of players) { player.bet = 0; player.lastAction = null; }
      board = [...event.board]; street = event.street;
    } else if (event.type === 'street') {
      if (!streets.has(event.street) || !Array.isArray(event.board)) throw new Error('牌谱轮次记录无效');
      street = event.street;
      board = [...event.board];
      for (const player of players) { player.bet = 0; player.lastAction = null; }
    } else if (paid.has(event.type)) {
      if (!p) throw new Error('牌谱行动玩家不存在');
      const chips = amount(event.amount);
      if (chips > p.stack) throw new Error('牌谱带入与下注不一致');
      p.stack -= chips; p.contributed += chips; pot += chips;
      if (event.type !== 'ante') p.bet += chips;
      p.lastAction = event.type; p.allIn = p.stack === 0;
    } else if (event.type === 'refund') {
      if (!p) throw new Error('牌谱退回玩家不存在');
      const chips = amount(event.amount);
      if (chips > p.contributed || chips > pot) throw new Error('牌谱退回金额不一致');
      p.stack += chips; p.contributed -= chips; p.bet = Math.max(0, p.bet - chips); pot -= chips;
      p.allIn = p.stack === 0; p.lastAction = 'refund';
    } else if (event.type === 'payout') {
      if (!p) throw new Error('牌谱获分玩家不存在');
      const chips = amount(event.amount);
      if (chips > pot) throw new Error('牌谱底池结算不一致');
      p.stack += chips; p.payout += chips; pot -= chips; p.allIn = p.stack === 0; p.lastAction = 'payout';
      for (const player of players) player.bet = 0;
    } else if (event.type === 'fold') {
      if (!p) throw new Error('牌谱弃牌玩家不存在');
      p.folded = true; p.lastAction = 'fold';
    } else if (event.type === 'check') {
      if (!p) throw new Error('牌谱过牌玩家不存在');
      p.lastAction = 'check';
    }
    // timeout/reconnect are informational; their actual action is a separate row.
  }
  const equity = (hand.equityFrames ?? []).filter(frame => frame.logSeq <= index).at(-1)?.equity ?? null;
  return { index, total, equity, street: complete ? 'complete' : street, board, pot,
    complete, lastEvent: index ? { ...hand.log[index - 1] } : null, players };
}

export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 1.5, 2, 4]);

// Playback only advances a cursor. The server-filtered hand stays in the view,
// and replaySnapshot remains the single source for cards, stacks and the pot.
export function createReplayPlayback({ total = 0, speed = 1, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  total = Number.isSafeInteger(total) && total > 0 ? total : 0;
  speed = REPLAY_SPEEDS.includes(speed) ? speed : 1;
  let index = 0, playing = false, scrubbing = false, resumeAfterScrub = false;
  let timer = null, generation = 0, disposed = false;
  const snapshot = () => ({ index, total, speed, playing, scrubbing, ended: index === total });
  const notify = () => { if (!disposed) onChange(snapshot()); };
  function cancelTimer() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    if (disposed || !playing || index >= total) return;
    const scheduledGeneration = generation;
    timer = setTimer(() => {
      // A cleared timeout can already be queued by the browser. Never allow it
      // to advance a later hand, a paused replay or a newly positioned cursor.
      if (disposed || !playing || scheduledGeneration !== generation) return;
      timer = null;
      index++;
      if (index === total) playing = false;
      notify();
      // onChange may close, pause, seek or change speed. Do not queue a second
      // timeout after any of those actions. There is no background catch-up.
      if (scheduledGeneration === generation) schedule();
    }, 1000 / speed);
  }
  function play() {
    if (disposed || !total || playing) return false;
    cancelTimer();
    scrubbing = false; resumeAfterScrub = false;
    if (index === total) index = 0;
    playing = true;
    schedule(); notify();
    return true;
  }
  function pause() {
    if (disposed) return false;
    const changed = playing || scrubbing;
    playing = false; scrubbing = false; resumeAfterScrub = false;
    cancelTimer();
    if (changed) notify();
    return changed;
  }
  function seek(requestedIndex) {
    if (disposed || !Number.isFinite(requestedIndex)) return false;
    const next = Math.max(0, Math.min(total, Math.floor(requestedIndex)));
    const changed = next !== index || playing;
    cancelTimer(); playing = false; index = next;
    if (!scrubbing) resumeAfterScrub = false;
    if (changed) notify();
    return changed;
  }
  function beginScrub() {
    if (disposed || scrubbing) return false;
    resumeAfterScrub = playing; scrubbing = true; playing = false;
    cancelTimer(); notify();
    return true;
  }
  function endScrub({ resume = true } = {}) {
    if (disposed || !scrubbing) return false;
    const shouldResume = resume && resumeAfterScrub && index < total;
    scrubbing = false; resumeAfterScrub = false;
    if (shouldResume) play(); else notify();
    return true;
  }
  function setSpeed(next) {
    if (disposed || !REPLAY_SPEEDS.includes(next) || next === speed) return false;
    speed = next; cancelTimer();
    if (playing) schedule();
    notify();
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; playing = false; scrubbing = false; resumeAfterScrub = false;
    cancelTimer();
  }
  return { snapshot, play, pause, seek, beginScrub, endScrub, setSpeed, dispose };
}
