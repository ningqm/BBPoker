import test from 'node:test';
import assert from 'node:assert/strict';
import { THROWABLES, createTableFunTracker, mountFunEffects } from '../public/table-fun.js';

const NOW = 1000000;
const BOARD = ['Ac', '2d', '7h', '9s', 'Jc'];
function room({ revision = 1, handId = 'h1', number = 1, board = 0, values = [80, 20],
  runout = true, status = 'playing', chat = [], method = 'exact', error95Pct = 0, code = '123456', meId = 'a' } = {}) {
  const players = values.map((equity, i) => ({ id: ['a', 'b', 'c'][i], equity }));
  return { code, meId, revision, chat, players: players.map((p, seat) => ({ id: p.id, seat })),
    hand: handId === null ? null : { id: handId, number, status, board: BOARD.slice(0, board),
      actionSeq: 10 + board, runout: { active: runout },
      equity: { method, error95Pct, players, pots: [{ amount: 100, eligibleIds: players.map(p => p.id), players }] } } };
}
function message(id, overrides = {}) { return { id, kind: 'throw', playerId: 'a', targetId: 'b', emote: 'water', at: new Date(NOW).toISOString(), ...overrides }; }
function update(tracker, snapshot, options = {}) { return tracker.update(snapshot, { now: NOW, ...options }); }
const noEffects = result => assert.deepEqual(result.effects, []);

test('only the four supported throwables are offered; configuration cannot be mutated', () => {
  assert.deepEqual(THROWABLES.map(p => p.id), ['water', 'tomato', 'pat', 'cheers']);
  assert.throws(() => { THROWABLES[0].id = 'script'; }, TypeError);
});

test('initial chat, duplicates, old messages and unrelated chat never replay', () => {
  const tracker = createTableFunTracker(), old = message('old');
  noEffects(update(tracker, room({ chat: [old] })));
  const fresh = message('fresh');
  const r = room({ revision: 2, chat: [old, fresh] });
  assert.deepEqual(update(tracker, r).effects, [{ id: 'throw:fresh', type: 'water', fromId: 'a', toId: 'b', at: NOW }]);
  noEffects(update(tracker, r));
  noEffects(update(tracker, room({ revision: 3, chat: [old, fresh, message('text', { kind: 'text', text: 'hello' }), message('emote', { kind: 'emote', emote: 'gg' }), message('expired', { at: new Date(NOW - 2000).toISOString() })] })));
});

test('throw effects validate membership, target, content and freshness without trusting chat text', () => {
  const tracker = createTableFunTracker(); update(tracker, room());
  const invalid = [message('unknown', { emote: '<script>' }), message('outside', { targetId: 'outsider' }),
    message('self', { targetId: 'a' }), message('future', { at: new Date(NOW + 60000).toISOString() }), message('bad-time', { at: 'never' })];
  noEffects(update(tracker, room({ revision: 2, chat: invalid })));
  const good = message('good', { emote: 'cheers', name: '<img onerror=alert(1)>', text: '<script>' });
  assert.deepEqual(update(tracker, room({ revision: 3, chat: [...invalid, good] })).effects.map(e => e.type), ['cheers']);
});

test('bursts are bounded and stale snapshots cannot roll back event or mask state', () => {
  const tracker = createTableFunTracker(); update(tracker, room());
  const current = room({ revision: 5, values: [95, 5], chat: Array.from({ length: 8 }, (_, i) => message(`fresh-${i}`)) });
  assert.equal(update(tracker, current).effects.length, 4);
  const stale = update(tracker, room({ revision: 2, values: [5, 95], chat: [message('not-new')] }));
  noEffects(stale); assert.deepEqual(stale.maskIds, []);
  noEffects(update(tracker, current));
});

test('reconnects, hidden updates and first foreground snapshot consume events without replay', () => {
  const tracker = createTableFunTracker(); update(tracker, room());
  noEffects(update(tracker, room({ revision: 2, board: 1, values: [5, 95], chat: [message('reconnect')] }), { reconnected: true }));
  const hidden = update(tracker, room({ revision: 3, board: 2, values: [95, 5], chat: [message('hidden')] }), { visible: false });
  noEffects(hidden); assert.deepEqual(hidden.maskIds, []);
  noEffects(update(tracker, room({ revision: 4, board: 3, values: [5, 95], chat: [message('restore')] })));
  const live = update(tracker, room({ revision: 5, board: 4, values: [95, 5], chat: [message('new-live')] }));
  assert.deepEqual(live.effects.map(e => e.type), ['water', 'pat']);
  tracker.reset(); noEffects(update(tracker, room({ revision: 5, chat: [message('new-live')] })));
});

test('nonlive snapshots and room or identity changes establish a fresh baseline', () => {
  const tracker = createTableFunTracker(); update(tracker, room());
  noEffects(update(tracker, room({ revision: 2, board: 1, values: [5, 95] }), { live: false }));
  noEffects(update(tracker, room({ revision: 3, board: 2, values: [95, 5] })));
  noEffects(update(tracker, room({ revision: 4, code: '654321', chat: [message('other-room')] })));
  noEffects(update(tracker, room({ revision: 5, code: '654321', meId: 'b', chat: [message('other-id')] })));
  noEffects(update(tracker, null));
  noEffects(update(tracker, room({ chat: [message('restart')] })));
});

test('even a stale hidden snapshot forces a fresh foreground baseline', () => {
  const tracker = createTableFunTracker(); update(tracker, room({ revision: 3 }));
  noEffects(update(tracker, room({ revision: 2 }), { visible: false }));
  noEffects(update(tracker, room({ revision: 4, board: 1, values: [5, 95], chat: [message('while-hidden')] })));
});

test('a clear all-in reversal produces one targeted pat per player per hand, including river', () => {
  const tracker = createTableFunTracker(); update(tracker, room());
  const first = update(tracker, room({ revision: 2, board: 1, values: [10, 90] }));
  assert.deepEqual(first.effects, [{ id: 'pat:h1:a', type: 'pat', fromId: 'b', toId: 'a', at: NOW }]);
  const second = update(tracker, room({ revision: 3, board: 2, values: [90, 10] }));
  assert.equal(second.effects[0].toId, 'b');
  noEffects(update(tracker, room({ revision: 4, board: 3, values: [10, 90] })));
  update(tracker, room({ revision: 5, handId: 'h2', number: 2, board: 4, values: [90, 10] }));
  const river = update(tracker, room({ revision: 6, handId: 'h2', number: 2, board: 5, values: [0, 100], runout: false, status: 'complete' }));
  assert.equal(river.effects[0].id, 'pat:h2:a'); assert.deepEqual(river.maskIds, []);
});

test('a neutral intermediate frame does not erase the observed strong lead', () => {
  const tracker = createTableFunTracker(); update(tracker, room({ values: [90, 10] }));
  noEffects(update(tracker, room({ revision: 2, board: 1, values: [55, 45] })));
  assert.equal(update(tracker, room({ revision: 3, board: 2, values: [15, 85] })).effects[0].toId, 'a');
});

test('ordinary boards, rabbit cards, skipped frames and rewritten public cards never trigger auto pats', () => {
  const tracker = createTableFunTracker(); update(tracker, room({ runout: false }));
  noEffects(update(tracker, room({ revision: 2, board: 1, values: [10, 90], runout: false })));
  tracker.reset(); update(tracker, room());
  const rabbit = room({ revision: 2, values: [10, 90] }); rabbit.hand.rabbit = { board: BOARD, active: true };
  noEffects(update(tracker, rabbit));
  noEffects(update(tracker, room({ revision: 3, board: 4, values: [90, 10] })));
  const rewritten = room({ revision: 4, board: 5, values: [10, 90] }); rewritten.hand.board[0] = 'Kh';
  noEffects(update(tracker, rewritten));
});

test('ties, uncertain samples, low edges and multiple pots stay neutral', () => {
  for (const values of [[50, 50], [60, 40], [40, 35, 25]]) {
    const tracker = createTableFunTracker(); update(tracker, room({ values }));
    noEffects(update(tracker, room({ revision: 2, board: 1, values: values.slice().reverse() })));
  }
  const mc = createTableFunTracker();
  assert.deepEqual(update(mc, room({ values: [91, 9], method: 'monte-carlo', error95Pct: 2 })).maskIds, []);
  mc.reset();
  update(mc, room({ revision: 2, values: [71, 29], method: 'monte-carlo', error95Pct: 2 }));
  noEffects(update(mc, room({ revision: 3, board: 1, values: [20, 80], method: 'monte-carlo', error95Pct: 2 })));
  const multi = createTableFunTracker(), a = room({ values: [95, 5] });
  a.hand.equity.pots.push({ amount: 20, eligibleIds: ['a'], players: [{ id: 'a', equity: 100 }] });
  assert.deepEqual(update(multi, a), { effects: [], maskIds: [] });
  const b = room({ revision: 2, board: 1, values: [5, 95] }); b.hand.equity.pots.push(a.hand.equity.pots[1]);
  assert.deepEqual(update(multi, b), { effects: [], maskIds: [] });
});

test('even extreme all-in underdogs never receive a clown mask', () => {
  const tracker = createTableFunTracker();
  for(const values of [[95,5],[99,1],[85,10,5]])assert.deepEqual(update(tracker,room({values})).maskIds,[]);
});

// A tiny DOM fixture exercises integration behaviours (not a copy of the renderer).
function domFixture() {
  const doc = { visibilityState: 'visible', createElement: () => new Element() };
  class Element {
    constructor() { this.ownerDocument = doc; this.children = []; this.dataset = {}; this.className = ''; this.events = {}; this.properties = {}; this.style = { setProperty: (k, v) => { this.properties[k] = v; } }; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(name, fn) { this.events[name] = fn; }
    querySelectorAll(selector) { const descendants = this.children.flatMap(n => [n, ...n.querySelectorAll('*')]); return selector === '*' ? descendants : descendants.filter(n => selector === '.seat[data-player-id]' ? n.className === 'seat' && n.dataset.playerId : n.className.split(' ').includes(selector.slice(1))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, width: 300, height: 200 }; }
  }
  function stage() {
    const node = new Element(); node.clientWidth = 300; node.clientHeight = 200;
    for (const [index, id] of ['a', 'b'].entries()) { const seat = new Element(), avatar = new Element(); seat.className = 'seat'; seat.dataset.playerId = id; avatar.className = 'avatar'; avatar.rect = { left: index * 200, top: 80, width: 24, height: 24 }; seat.append(avatar); node.append(seat); }
    return node;
  }
  return { doc, stage };
}
const effect = { id: 'throw:test', type: 'tomato', fromId: 'a', toId: 'b', at: NOW };

test('mount targets avatar coordinates, never duplicates, and a rebuilt stage resumes elapsed progress', () => {
  const f = domFixture(), stage = f.stage(); mountFunEffects(stage, [effect], { now: NOW });
  const layer = stage.querySelector('.fun-layer'), node = layer.children[0];
  assert.equal(layer['aria-hidden'], 'true'); assert.equal(node.properties['--fun-x'], '12px'); assert.equal(node.properties['--fun-dx'], '200px');
  assert.equal(node.children[0].textContent, '🍅');
  mountFunEffects(stage, [effect], { now: NOW + 500 }); assert.equal(layer.children.length, 1); assert.equal(layer.children[0], node);
  const rebuilt = f.stage(); mountFunEffects(rebuilt, [effect], { now: NOW + 700 });
  assert.equal(rebuilt.querySelector('.fun-layer').children[0].properties['--fun-age'], '700ms');
  node.events.animationend({ target: node.children[0] }); assert.equal(layer.children.length, 1);
  node.events.animationend({ target: node }); assert.equal(layer.children.length, 0);
});

test('disabled, hidden, expired and invalid effects cannot leave a blocking overlay or start an animation', () => {
  const f = domFixture(), stage = f.stage();
  mountFunEffects(stage, [effect], { now: NOW }); mountFunEffects(stage, [effect], { now: NOW, enabled: false }); assert.equal(stage.querySelector('.fun-layer'), null);
  mountFunEffects(stage, [effect], { now: NOW + 2000 }); assert.equal(stage.querySelector('.fun-layer'), null);
  mountFunEffects(stage, [{ ...effect, type: '<script>' }, { ...effect, toId: 'outside' }], { now: NOW }); assert.equal(stage.querySelector('.fun-layer'), null);
  f.doc.visibilityState = 'hidden'; mountFunEffects(stage, [effect], { now: NOW }); assert.equal(stage.querySelector('.fun-layer'), null);
});


test('a grouped three-card flop can reverse the lead once, but skipped turn/river snapshots do not manufacture a reversal',()=>{
  const tracker=createTableFunTracker();update(tracker,room({values:[90,10]}));
  const flop=room({revision:2,board:3,values:[10,90]});
  assert.deepEqual(update(tracker,flop).effects,[{id:'pat:h1:a',type:'pat',fromId:'b',toId:'a',at:NOW}]);
  noEffects(update(tracker,flop));
  assert.equal(update(tracker,room({revision:3,board:4,values:[90,10]})).effects[0].toId,'b');
  tracker.reset();update(tracker,room({values:[90,10]}));
  noEffects(update(tracker,room({revision:2,board:4,values:[10,90]})));
});
