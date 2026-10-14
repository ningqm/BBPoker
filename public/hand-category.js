// Presentation only: royal flush remains an ace-high straight flush in the engine.
export const HAND_CATEGORIES = Object.freeze([
  ['高牌', 'high-card'], ['一对', 'pair'], ['两对', 'two-pair'],
  ['三条', 'trips'], ['顺子', 'straight'], ['同花', 'flush'],
  ['葫芦', 'full-house'], ['四条', 'quads'], ['同花顺', 'straight-flush'],
  ['皇家同花顺', 'royal-flush'],
].map(([name, tone], index) => Object.freeze({ name, tone, strength: index + 1 })));

const categoryFor = name => HAND_CATEGORIES.find(entry => entry.name === name);
export const HAND_CATEGORY_UPGRADE_MS = 1000;

/** Only use viewer-filtered server labels. No cards are evaluated in the browser. */
export function updateHandCategoryMotion(previous, room, motions = [], { live = false, now = Date.now() } = {}) {
  if (!live || !previous?.hand?.id || previous.code !== room?.code || previous.meId !== room.meId || previous.hand.id !== room.hand?.id) return [];
  const players = room.players || [];
  const retained = motions.filter(m => m.handId === room.hand.id && now >= m.at && now - m.at < HAND_CATEGORY_UPGRADE_MS && players.some(p => p.id === m.playerId && !p.folded && p.handCategory === m.to));
  const before = previous.hand.board || [], after = room.hand.board || [];
  // Rabbit cards, duplicate deliveries, new identities and reconnect snapshots never upgrade a label.
  if (previous.hand.status !== 'playing' || after.length <= before.length || !before.every((card, i) => after[i] === card)) return retained;
  const upgrades = players.flatMap(player => {
    const old = previous.players?.find(p => p.id === player.id);
    const from = categoryFor(old?.handCategory), to = categoryFor(player.handCategory);
    if (old?.folded || player.folded || !from || !to || to.strength <= from.strength) return [];
    return [{ handId: room.hand.id, playerId: player.id, from: from.name, to: to.name, at: now }];
  });
  return [...retained.filter(m => !upgrades.some(u => u.playerId === m.playerId)), ...upgrades];
}

/** Render only a server-approved category for this viewer; never infer a hidden hand. */
export function renderHandCategory(name, { motion = null, now = Date.now() } = {}) {
  const category = categoryFor(name);
  if (!category) return '';
  const from = categoryFor(motion?.from), age = now - motion?.at;
  if (from && motion.to === name && category.strength > from.strength && age >= 0 && age < HAND_CATEGORY_UPGRADE_MS) {
    // The new label appears when the board face turns towards the player (260 ms).
    // A negative delay resumes this same upgrade after chat/clock DOM refreshes.
    return `<span class="hand-category-upgrade" style="--category-age:${Math.floor(age)}ms" aria-label="${category.name}"><span class="hand-category category-before" data-hand-category="${from.tone}" aria-hidden="true">${from.name}</span><span class="hand-category category-after" data-hand-category="${category.tone}">${category.name}</span></span>`;
  }
  return `<span class="hand-category" data-hand-category="${category.tone}" title="${category.name} · 按牌型强弱配色，同类牌还需比较点数">${category.name}</span>`;
}
