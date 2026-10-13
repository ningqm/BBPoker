/** Cash-table entry obligations are kept with the member, not with a seat or
 * connection. Planning is read-only; commit only after a hand was created. */
const MODES = new Set(['wait', 'post']);
const seated = m => Number.isSafeInteger(m?.seat) && m.seat >= 0;
const ordered = members => [...members].sort((a, b) => a.seat - b.seat);
const after = (members, seat) => members.find(m => m.seat > seat) ?? members[0];
const previous = (members, seat) => [...members].reverse().find(m => m.seat < seat) ?? members.at(-1);
const crossed = (from, to, seat) => Number.isSafeInteger(from) && from >= 0 && Number.isSafeInteger(to) && from !== to &&
  (from < to ? seat > from && seat <= to : seat > from || seat <= to);

export function entryState(r, m) {
  if (m.blindEntry) return { played: false, mode: 'wait', missedSmall: false, missedBig: false, ...m.blindEntry };
  // Existing saved rooms have no marker. Grandfather existing funded members;
  // markEntrySeat creates explicit fresh-player state for every new sit.
  return { played: Boolean(r.handNumber > 0 && (m.totalBuyIn > 0 || r.hand?.players?.some(p => p.id === m.id))),
    mode: 'wait', lastSeat: seated(m) ? m.seat : null, missedSmall: false, missedBig: false };
}
export function needsEntry(r, m) {
  const state = entryState(r, m);
  return r.handNumber > 0 && (!state.played || state.missedSmall || state.missedBig);
}
export function setEntryMode(r, m, mode) {
  if (!MODES.has(mode)) throw new Error('入桌方式需要选择等大盲或补盲加入');
  m.blindEntry = { ...entryState(r, m), mode };
}
/** Call before assigning m.seat. Standing retains the old seat to track missed
 * positions. Re-taking a different seat carries a big-blind obligation. */
export function markEntrySeat(r, m, nextSeat) {
  const state = entryState(r, m);
  if (Number.isSafeInteger(nextSeat) && nextSeat >= 0) {
    if (state.played && Number.isSafeInteger(state.lastSeat) && state.lastSeat !== nextSeat) state.missedBig = true;
    state.lastSeat = nextSeat;
  } else if (seated(m)) state.lastSeat = m.seat;
  m.blindEntry = state;
}
export function projectEntry(r, m) {
  const state = entryState(r, m), pending = needsEntry(r, m);
  const live = !state.played || state.missedBig ? r.settings.bigBlind : 0;
  const dead = state.missedSmall ? r.settings.smallBlind : 0;
  return { pending, mode: state.mode, missedSmall: Boolean(state.missedSmall), missedBig: Boolean(state.missedBig),
    live: pending ? live : 0, dead: pending ? dead : 0, amount: pending ? live + dead : 0,
    reason: pending ? state.mode === 'post' ? '等待可补盲的位置' : '等待大盲加入' : null };
}

/** eligibleMembers contains only players allowed in this hand (online, seated,
 * non-sitting-out, correct squid roster), with stack already net of any reserve.
 * Natural-BB selection includes waiting players. This is essential: filtering
 * them before rotating blinds would make waiting permanent.
 * Return members unmodified; updates/ orbit are applied by commitEntry only. */
export function planEntry(r, eligibleMembers, { bombPot = false } = {}) {
  const members = ordered(eligibleMembers.filter(m => seated(m) && m.stack > 0));
  const states = Object.fromEntries(Object.values(r.members).map(m => [m.id, entryState(r, m)]));
  const empty = { players: [], buttonSeat: null, posts: [], waiting: [], updates: states, orbit: r.blindOrbit ?? null, bombPot };
  if (members.length < 2) return { ...empty, waiting: members.map(m => ({ playerId: m.id, reason: '等待至少两位玩家' })) };
  const first = !r.handNumber;
  const oldOrbit = r.blindOrbit ?? { bigBlindSeat: r.hand?.bigBlindSeat, smallBlindSeat: r.hand?.smallBlindSeat };
  let players, bb, sb, button, waiting = [], posts = [];
  if (first || bombPot) {
    players = first ? members : members.filter(m => !needsEntry(r, m));
    if (players.length < 2) return { ...empty, waiting: members.filter(m => needsEntry(r, m)).map(m => ({ playerId: m.id, reason: '等待普通手补盲' })) };
    button = after(players, r.buttonSeat ?? -1);
    const clockwise = [...players.filter(m => m.seat > button.seat), ...players.filter(m => m.seat <= button.seat)];
    sb = players.length === 2 ? button : clockwise[0]; bb = players.length === 2 ? clockwise[0] : clockwise[1];
  } else {
    // A previous bomb hand does not change the remembered ordinary blind orbit.
    const cursor = Number.isSafeInteger(oldOrbit.bigBlindSeat) ? oldOrbit.bigBlindSeat : r.buttonSeat;
    bb = after(members, cursor ?? -1);
    const established = members.filter(m => !needsEntry(r, m));
    const posters = members.filter(m => needsEntry(r, m) && states[m.id].mode === 'post' &&
      m.stack >= r.settings.bigBlind + (states[m.id].missedSmall ? r.settings.smallBlind : 0));
    if (!established.length && !posters.length) return { ...empty,
      waiting: members.map(m => ({ playerId: m.id, reason: '所有人都在等大盲，需一人选择补盲加入' })) };
    // When a single established player remains, a waiting newcomer must get
    // the BB, never an unexpected SB. This also permits a heads-up restart.
    if (established.length === 1 && bb.id === established[0].id) bb = after(members.filter(m => m.id !== established[0].id), cursor ?? -1);
    let bootstrap = null;
    if (!established.length) {
      // At least one player explicitly agrees to post. That player can supply
      // the SB/button while a waiter enters at BB. Nobody choosing wait is
      // silently charged a small blind to unstick the table.
      bootstrap = posters.find(m => m.id !== bb.id) ?? posters[0];
      if (bootstrap.id === bb.id) bb = after(members.filter(m => m.id !== bootstrap.id), cursor ?? -1);
    }
    players = ordered(members.filter(m => !needsEntry(r, m) || m.id === bb.id || m.id === bootstrap?.id));
    sb = previous(players, bb.seat); button = players.length === 2 ? sb : previous(players, sb.seat);
    for (const m of members) {
      if (players.some(p => p.id === m.id)) continue;
      const state = states[m.id];
      if (state.mode !== 'post') continue;
      // Do not insert newcomers into the protected button-to-BB arc.
      if (m.seat === button.seat || crossed(button.seat, bb.seat, m.seat)) continue;
      const live = !state.played || state.missedBig ? r.settings.bigBlind : 0;
      const dead = state.missedSmall ? r.settings.smallBlind : 0;
      if (m.stack < live + dead || (dead && m.stack === dead)) continue;
      players.push(m);
    }
    players = ordered(players);
    // A 2 -> 3 transition can make an inserted player the new button. Keep
    // the explicitly consenting bootstrap SB, but never slide a waiter there.
    for (;;) {
      sb = previous(players, bb.seat); button = players.length === 2 ? sb : previous(players, sb.seat);
      const unsafe = players.find(m => m.id !== bb.id && m.id !== bootstrap?.id && needsEntry(r, m) &&
        (m.id === sb.id || m.id === button.id) && players.length > 2);
      if (!unsafe) break;
      players = players.filter(m => m.id !== unsafe.id);
    }
    for (const m of players) {
      const state = states[m.id];
      if (!needsEntry(r, m)) continue;
      // Only the natural BB clears a waiter's obligation. A consenting post
      // player in the bootstrap SB tops up to a total live BB, never SB+BB.
      const natural = m.id === bb.id;
      const live = natural ? 0 : !state.played || state.missedBig ? r.settings.bigBlind : 0;
      const dead = state.mode === 'post' && state.missedSmall ? r.settings.smallBlind : 0;
      if (live || dead) {
        const normal = m.id === bb.id ? r.settings.bigBlind : m.id === sb.id ? r.settings.smallBlind : 0;
        if (m.stack >= Math.max(normal, live) + dead) posts.push({ playerId: m.id, live, dead });
        else if (!natural) throw new Error('补盲积分不足，请补码或等大盲');
      }
    }
    waiting = members.filter(m => !players.some(p => p.id === m.id)).map(m => {
      const state = states[m.id], cost = (!state.played || state.missedBig ? r.settings.bigBlind : 0) + (state.missedSmall ? r.settings.smallBlind : 0);
      return { playerId: m.id, reason: state.mode === 'wait' ? '等待大盲加入' : m.stack < cost ? '补盲积分不足，请补码或等大盲' : '等待过庄后补盲加入' };
    });
  }
  const ids = new Set(players.map(m => m.id));
  if (!bombPot) {
    for (const [id, state] of Object.entries(states)) {
      if (ids.has(id)) continue;
      const m = r.members[id], seat = state.lastSeat ?? m.seat;
      if (!state.played || !Number.isSafeInteger(seat)) continue;
      if (crossed(oldOrbit.bigBlindSeat, bb.seat, seat)) state.missedBig = true;
      if (crossed(oldOrbit.smallBlindSeat, sb.seat, seat)) state.missedSmall = true;
    }
  }
  for (const m of players) {
    const state = states[m.id];
    Object.assign(state, { played: true, lastSeat: m.seat });
    if (!bombPot) Object.assign(state, { missedSmall: false, missedBig: false });
  }
  return { players, buttonSeat: button.seat, posts, waiting, updates: states, bombPot,
    orbit: bombPot ? oldOrbit : { bigBlindSeat: bb.seat, smallBlindSeat: sb.seat } };
}
export function commitEntry(r, plan, hand) {
  if (!hand?.id || r.blindOrbit?.handId === hand.id) return false;
  if (!Array.isArray(plan.players) || hand.players.map(p => p.id).sort().join('\0') !== plan.players.map(p => p.id).sort().join('\0')) throw new Error('入桌计划与实际发牌名单不一致');
  for (const [id, state] of Object.entries(plan.updates)) if (r.members[id]) r.members[id].blindEntry = { ...state };
  r.blindOrbit = { ...plan.orbit, handId: hand.id };
  return true;
}
