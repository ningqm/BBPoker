// Presentation only: this module observes public room snapshots and never sends
// game commands, reads unrevealed cards, or alters a player's stored avatar.
export const THROWABLES = Object.freeze([
  { id: 'water', label: '泼水', glyph: '🪣' },
  { id: 'tomato', label: '西红柿', glyph: '🍅' },
  { id: 'pat', label: '摸摸头', glyph: '👋' },
  { id: 'cheers', label: '碰杯', glyph: '🍻' },
].map(Object.freeze));

const items = new Map(THROWABLES.map(item => [item.id, item]));
const EFFECT_MS = 2000;
const empty = () => ({ effects: [], maskIds: [] });
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 160;
const finitePercent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

// Restrict playful judgements to one unambiguous contested pot. A player can
// lose the main pot and still win a side pot, so multi-pot hands stay neutral.
function publicEquity(hand, seatedIds) {
  const equity = hand?.equity;
  if (!equity || !['exact', 'monte-carlo'].includes(equity.method) || equity.pots?.length !== 1) return null;
  const pot = equity.pots[0], players = pot?.players;
  if (!Array.isArray(players) || players.length < 2 || !Array.isArray(pot.eligibleIds) ||
      new Set(pot.eligibleIds).size !== players.length || new Set(players.map(p => p?.id)).size !== players.length ||
      players.some(p => !p || !validId(p.id) || !seatedIds.has(p.id) || !pot.eligibleIds.includes(p.id) || !finitePercent(p.equity)) ||
      Math.abs(players.reduce((sum, p) => sum + p.equity, 0) - 100) > 0.5) return null;
  const error = equity.method === 'exact' ? 0 : equity.error95Pct;
  if (!Number.isFinite(error) || error < 0 || error > 10) return null;
  const sorted = players.map(p => ({ id: p.id, equity: p.equity })).sort((a, b) => b.equity - a.equity);
  const leader = sorted[0].equity - error >= 70 && sorted[0].equity - sorted[1].equity - error * 2 >= 40 ? sorted[0].id : null;
  return { players: sorted, leader, error, eligibleKey: [...pot.eligibleIds].sort().join('\u0000') };
}

function snapshot(room) {
  if (!room || !validId(room.code)) return null;
  const seatedIds = new Set((Array.isArray(room.players) ? room.players : []).filter(p => p && p.seat != null && validId(p.id)).map(p => p.id));
  const h = room.hand;
  return {
    code: room.code, meId: room.meId, revision: room.revision, seatedIds,
    chat: (Array.isArray(room.chat) ? room.chat : []).slice(-100).filter(m => m && typeof m === 'object').map(m => ({
      id: m.id, type: m.kind === 'throw' ? m.emote : null, fromId: m.playerId, toId: m.targetId, at: Date.parse(m.at),
    })),
    hand: h && validId(h.id) ? {
      id: h.id, number: h.number, seq: h.actionSeq, status: h.status,
      // Only already-revealed board cards establish frame continuity. Rabbit
      // cards are deliberately ignored even if included elsewhere in the room.
      board: Array.isArray(h.board) ? [...h.board] : [],
      runout: h.runout?.active === true, equity: publicEquity(h, seatedIds),
    } : null,
  };
}

function stale(current, previous) {
  if (current.code !== previous?.code || current.meId !== previous?.meId) return false;
  if (Number.isFinite(current.revision) && Number.isFinite(previous.revision) && current.revision < previous.revision) return true;
  if (!previous.hand) return false;
  if (!current.hand) return true;
  return current.hand.number < previous.hand.number || (current.hand.id === previous.hand.id &&
    (current.hand.seq < previous.hand.seq || current.hand.board.length < previous.hand.board.length));
}

/** Always feed current snapshots, including while entertainment is disabled.
 * Effects are NEW events, not an active queue. Retain them in the caller for at
 * most 2 s so full-page rerenders can resume at the same animation timestamp.
 */
export function createTableFunTracker() {
  let previous = null, needsBaseline = false, strongLeader = null;
  const seenChat = new Set(), patted = new Set();
  function reset() { previous = null; needsBaseline = false; strongLeader = null; seenChat.clear(); patted.clear(); }
  return {
    reset,
    update(room, { live = true, visible = true, reconnected = false, now = Date.now() } = {}) {
      const current = snapshot(room);
      if (!current) { reset(); return empty(); }
      if (stale(current, previous)) {
        if (!visible || !live || reconnected) needsBaseline = true;
        return { effects: [], maskIds: [] };
      }
      const sameRoom = previous?.code === current.code && previous?.meId === current.meId;
      if (!sameRoom) { seenChat.clear(); patted.clear(); strongLeader = null; }
      if (previous?.hand?.id !== current.hand?.id) { patted.clear(); strongLeader = null; }
      const emit = sameRoom && live && visible && !reconnected && !needsBaseline && Number.isFinite(now);
      const effects = [];
      for (const message of current.chat) {
        if (!validId(message.id)) continue;
        const seen = seenChat.has(message.id); seenChat.add(message.id);
        const age = now - message.at;
        if (emit && !seen && items.has(message.type) && current.seatedIds.has(message.fromId) &&
            current.seatedIds.has(message.toId) && message.fromId !== message.toId && age >= -1000 && age < EFFECT_MS) {
          effects.push({ id: `throw:${message.id}`, type: message.type, fromId: message.fromId, toId: message.toId, at: Math.min(now, message.at) });
        }
      }
      // Bounded history plus freshness prevents an old truncated chat event
      // from ever replaying if it returns in a later snapshot.
      while (seenChat.size > 500) seenChat.delete(seenChat.values().next().value);
      const before = previous?.hand, after = current.hand;
      if (emit && before?.id === after?.id && before?.runout && (after.runout || after.status === 'complete') &&
          after.board.length === before.board.length + 1 && after.board.length <= 5 &&
          before.board.every((card, index) => card === after.board[index]) && after.seq > before.seq &&
          strongLeader && before.equity && after.equity?.leader && before.equity.eligibleKey === after.equity.eligibleKey &&
          strongLeader !== after.equity.leader && !patted.has(strongLeader)) {
        patted.add(strongLeader);
        effects.push({ id: `pat:${after.id}:${strongLeader}`, type: 'pat', fromId: after.equity.leader, toId: strongLeader, at: now });
      }
      if (!emit || !after?.runout || !after.equity || before?.equity?.eligibleKey !== after.equity.eligibleKey) strongLeader = after?.runout ? after.equity?.leader ?? null : null;
      else if (after.equity.leader) strongLeader = after.equity.leader;
      previous = current; needsBaseline = !visible || !live;
      // A burst is deliberately bounded: visual decoration must not cover the
      // table with a backlog after a delayed network delivery.
      return { effects: effects.slice(-4), maskIds: [] };
    },
  };
}

/** Mount only inside .table-stage. CSS lifetime + animationend removes nodes;
 * there are no per-effect timers or global references to detached DOM trees.
 * A rebuilt stage resumes using a negative animation delay rather than replay.
 */
export function mountFunEffects(stage, effects = [], { enabled = true, now = Date.now() } = {}) {
  if (!stage?.ownerDocument || !stage.querySelectorAll) return;
  let layer = stage.querySelector('.fun-layer');
  if (!enabled || stage.ownerDocument.visibilityState === 'hidden' || !Number.isFinite(now)) { layer?.remove(); return; }
  const active = effects.filter(e => validId(e.id) && items.has(e.type) && Number.isFinite(e.at) && now >= e.at && now - e.at < EFFECT_MS).slice(-4);
  if (!active.length) { layer?.remove(); return; }
  const doc = stage.ownerDocument, frame = stage.getBoundingClientRect();
  if (!frame.width || !frame.height) return;
  const seats = new Map([...stage.querySelectorAll('.seat[data-player-id]')].map(seat => [seat.dataset.playerId, seat.querySelector('.avatar')]));
  const point = id => {
    const rect = seats.get(id)?.getBoundingClientRect();
    return rect?.width && rect?.height ? { x: (rect.left + rect.width / 2 - frame.left) * stage.clientWidth / frame.width, y: (rect.top + rect.height / 2 - frame.top) * stage.clientHeight / frame.height } : null;
  };
  if (!layer) { layer = doc.createElement('div'); layer.className = 'fun-layer'; layer.setAttribute('aria-hidden', 'true'); stage.append(layer); }
  const existing = new Map([...layer.children].map(node => [node.dataset.funId, node]));
  const ids = new Set(active.map(effect => effect.id));
  for (const [id, node] of existing) if (!ids.has(id)) node.remove();
  for (const effect of active) {
    if (existing.has(effect.id)) continue;
    const from = point(effect.fromId), to = point(effect.toId);
    if (!from || !to || effect.fromId === effect.toId) continue;
    const node = doc.createElement('span'); node.className = `fun-effect fun-${effect.type}`; node.dataset.funId = effect.id;
    for (const [key, value] of Object.entries({ x: from.x, y: from.y, dx: to.x - from.x, dy: to.y - from.y, tx: to.x, ty: to.y })) node.style.setProperty(`--fun-${key}`, `${value}px`);
    node.style.setProperty('--fun-age', `${Math.max(0, now - effect.at)}ms`);
    const projectile = doc.createElement('span'); projectile.className = 'fun-projectile'; projectile.textContent = items.get(effect.type).glyph;
    const impact = doc.createElement('span'); impact.className = 'fun-impact'; impact.textContent = effect.type === 'water' ? '💦' : items.get(effect.type).glyph;
    node.append(projectile, impact); layer.append(node);
    node.addEventListener('animationend', event => { if (event.target === node) node.remove(); });
  }
  if (!layer.children.length) layer.remove();
}
