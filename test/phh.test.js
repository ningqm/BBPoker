import test from 'node:test';
import { readyRoomAction } from './helpers/room-clock.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createHand, applyAction, availableActions } from '../src/poker.js';
import { exportPhh } from '../src/phh.js';

const canonical = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r + s));
const deck = prefix => [...prefix, ...canonical.filter(c => !prefix.includes(c))];
const act = (h, type, amount) => applyAction(h, h.actingId, type, amount);

function game(stacks = [100, 100], extra = {}) {
  return createHand({ id: 'example', buttonSeat: 0, smallBlind: 5, bigBlind: 10, deck: canonical,
    players: stacks.map((stack, seat) => ({ id: String(seat), name: `朋友${seat}`, seat, stack })), ...extra });
}

function checkDown(h) {
  while (h.status === 'playing') act(h, availableActions(h, h.actingId).canCheck ? 'check' : 'call');
  return h;
}

// Simulates the exact public handFor() contract; the exporter only sees this
// object and has no access to the source hand, deck, card indices or archive.
function filtered(h, viewerId = '0', shown = {}, miniNet = {}) {
  return { id: h.id, number: 1, at: '2026-09-29T13:45:12.345Z', roomCode: 'ABC123', roomName: '朋友局',
    buttonSeat: h.buttonSeat, smallBlindSeat: h.smallBlindSeat, bigBlindSeat: h.bigBlindSeat, ante: h.ante,
    settings: { smallBlind: h.smallBlind, bigBlind: h.bigBlind }, board: [...h.board],
    players: h.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, startingStack: p.startingStack,
      endingStack: p.stack + (miniNet[p.id] ?? 0), net: p.stack - p.startingStack, miniNet: miniNet[p.id] ?? 0,
      folded: p.folded, cards: p.cards.map((c, i) => p.id === viewerId || (h.result.showdown && !p.folded) || shown[p.id]?.includes(i) ? c : null) })),
    result: structuredClone(h.result), log: structuredClone(h.log), commitment: 'b'.repeat(64) };
}

function fixtures() {
  const hu = filtered(checkDown(game())); hu.id = 'hu';
  const foldedGame = game([100, 100, 100]); act(foldedGame, 'fold'); act(foldedGame, 'fold');
  const folded = filtered(foldedGame, '1'); folded.id = 'fold';
  const partial = filtered(foldedGame, '1', { 0: [0], 2: [1] }); partial.id = 'partial';
  const sideGame = game([200, 100, 50], { deck: deck('Ks As Qs Kh Ah Qh Jc 2c 3d 4h Tc 8s Td 9c'.split(' ')) });
  act(sideGame, 'allin'); act(sideGame, 'call'); act(sideGame, 'allin');
  const side = filtered(sideGame, '0', {}, { 0: -2, 1: 6, 2: -4 }); side.id = 'side';
  const sparseGame = game([100, 100, 100], { players: [
    { id: 'z', name: 'Z', seat: 8, stack: 100 }, { id: 'a', name: 'A', seat: 1, stack: 100 },
    { id: 'b', name: 'B', seat: 5, stack: 100 }], buttonSeat: 5 });
  act(sparseGame, 'raise', 30); act(sparseGame, 'call'); act(sparseGame, 'call');
  const sparse = filtered(checkDown(sparseGame), 'b'); sparse.id = 'sparse';
  const blindOnly = filtered(game([5, 3])); blindOnly.id = 'blind-only';
  return [hu, folded, partial, side, sparse, blindOnly];
}

async function recoveredHistory(t) {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const directory = mkdtempSync(join(tmpdir(), 'tongzhuo-phh-recovery-'));
  let app = createApp({ dataDir: directory });
  try {
    const users = [0, 1].map(i => ({ id: `recovered-${i}`, name: `恢复玩家${i}`, avatar: 0 }));
    for (const user of users) app.store.data.users[user.id] = user;
    let room = app.service.create(users[0], { name: '恢复牌局', settings: { approvalRequired: false } });
    const code = room.code;
    const command = (user, type, extra = {}) => app.service.command(user, code, {
      commandId: randomUUID(), type, handId: room.hand?.id, actionSeq: room.hand?.log.length, ...extra,
    });
    app.service.join(users[1], code, room.invite);
    command(users[0], 'sit', { seat: 0, amount: 1000 });
    command(users[1], 'sit', { seat: 5, amount: 1000 });
    for (const user of users) app.service.connections.set(`${code}:${user.id}`, 1);
    command(users[0], 'start');
    const beforeLog = structuredClone(room.hand.log);
    app.store.save();
    await app.close();
    app = createApp({ dataDir: directory });
    room = app.service.room(code);
    assert.deepEqual(room.hand.log, beforeLog);
    const checkOrCall = () => {
      if (!readyRoomAction(app.service, room, value => { clock = value; })) return;
      const actor = users.find(u => u.id === room.hand.actingId);
      command(actor, availableActions(room.hand, actor.id).canCheck ? 'check' : 'call');
    };
    for (let step = 0; room.hand.street === 'preflop'; step++) { assert.ok(step < 30, JSON.stringify({status:room.hand.status, transition:room.hand.transition,presentation:room.presentation,clock,actor:room.hand.actingId})); checkOrCall(); readyRoomAction(app.service, room, value => { clock = value; }); }
    clock = room.deadline + 1; assert.equal(app.service.timeout(room, clock), true);
    for (let step = 0; room.hand.status === 'playing'; step++) { assert.ok(step < 40, JSON.stringify({status:room.hand.status,transition:room.hand.transition,presentation:room.presentation,clock})); checkOrCall(); }
    return app.service.exports(users[0].id, code)[0];
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('real server recovery and RoomService timeout markers do not change exported poker actions', async t => {
  const hand = await recoveredHistory(t);
  assert.ok(!hand.log.some(a => a.type === 'reconnect'));
  assert.ok(hand.log.some(a => a.type === 'timeout'));
  const plain = structuredClone(hand);
  plain.log = plain.log.filter(a => !['reconnect', 'timeout'].includes(a.type));
  assert.equal(exportPhh([hand]), exportPhh([plain]));
});

test('heads-up PHH deals BB first, reverses standard blind amounts and uses raise-to totals', () => {
  const h = game(); act(h, 'raise', 30); act(h, 'call'); checkDown(h);
  const text = exportPhh([filtered(h)], [], '0');
  assert.match(text, /seats = \[2, 1\]/);
  assert.match(text, /blinds_or_straddles = \[5, 10\]/);
  assert.match(text, /"p2 cbr 30"/);
  assert.doesNotMatch(text, /cbr 25/);
  assert.match(text, /"p1 cc"/);
  assert.match(text, /_tongzhuo_viewer_id = "0"/);
});

test('hidden cards remain unknown and partial fold reveals do not become showdown actions', () => {
  const [_, folded, partial] = fixtures();
  const hidden = folded.players.find(p => p.id === '0');
  assert.deepEqual(hidden.cards, [null, null]);
  const text = exportPhh([folded, partial]);
  assert.match(text, /"d dh p3 \?\?\?\?"/);
  const halfCard = partial.players.find(p => p.id === '0').cards[0];
  assert.ok(text.includes(`"d dh p3 ${halfCard}??"`));
  assert.doesNotMatch(text, / sm /);
  assert.ok(!('deck' in folded));
  assert.throws(() => exportPhh([game()]), /过滤/);
});

test('all-in call is cc; raises and showdown precede board runout without changing side-pot accounting', () => {
  const side = fixtures()[3], text = exportPhh([side]);
  assert.match(text, /"p3 cbr 200"/);
  assert.match(text, /"p2 cc"/);
  assert.ok(text.indexOf(' sm ') < text.indexOf('d db'));
  assert.match(text, /finishing_stacks = \[100, 150, 100\]/);
  assert.match(text, /_tongzhuo_mini_net = \[6, -4, -2\]/);
  assert.match(text, /_tongzhuo_room_ending_stacks = \[106, 146, 98\]/);
  assert.doesNotMatch(text, /(?:refund|payout) /);
});

test('bulk PHH uses separate numbered TOML tables, escapes names, and keeps non-hand adjustments in comments', () => {
  const hands = fixtures(); hands[0].players[0].name = '名字"\n[9]\nvariant = "PO"\u007f';
  const adjustment = { id: 'refund', at: '2026-09-29T14:00:00Z', roomCode: 'ABC123', playerId: '0', type: 'mushroomRefund', amount: 6, note: '退款\n不产生新牌局', hiddenCards: ['secret'] };
  const text = exportPhh(hands, [adjustment]);
  assert.equal(text.match(/^\[\d+\]$/gm).length, hands.length);
  assert.ok(text.includes('\\n[9]\\n'));
  assert.ok(text.includes('\\u007f'));
  assert.match(text, /^# Tongzhuo adjustment JSON: /m);
  assert.doesNotMatch(text, /secret|hiddenCards/);
  assert.doesNotMatch(exportPhh([], [adjustment]), /^\[\d+\]$/m);
  assert.deepEqual(hands[1].players.find(p => p.id === '0').cards, [null, null]);
});

test('PHH rejects missing positions, ambiguous all-ins, duplicate visible cards and broken board history', () => {
  const original = fixtures()[3];
  for (const mutate of [
    h => { delete h.buttonSeat; },
    h => { h.smallBlindSeat = h.bigBlindSeat; },
    h => { delete h.log.find(a => a.type === 'allin').isRaise; },
    h => { h.players[0].cards[0] = h.players[1].cards[0]; },
    h => { h.log.find(a => a.type === 'street').board.pop(); },
  ]) {
    const h = structuredClone(original); mutate(h); assert.throws(() => exportPhh([h]), /PHH/);
  }
});

test('optional independent PokerKit parser replays real examples to identical hold\'em ending stacks', {
  skip: !process.env.POKERKIT_PYTHON && 'Set POKERKIT_PYTHON to an isolated Python interpreter with PokerKit installed.',
}, async t => {
  const hands = [...fixtures(), await recoveredHistory(t)];
  hands[0].players[0].name = '名字"\n[9]\nvariant = "PO"\u007f';
  const incomplete = structuredClone(hands[0]); incomplete.id = 'incomplete';
  incomplete.players[0].cards = [incomplete.players[0].cards[0], null];
  // Currency-free mini-game bookkeeping intentionally does not affect the
  // standard final stacks checked by the independent hold'em engine.
  const data = exportPhh([...hands, incomplete], [{ id: 'adjustment', amount: 3, type: 'mushroomRefund' }]);
  const script = `import sys,json,tomllib
from pokerkit import HandHistory
data=sys.stdin.read()
raw=tomllib.loads(data)
hands=list(HandHistory.loads_all(data))
assert len(hands)==8
assert all(h.variant=='NT' for h in hands)
for h in hands[:-1]:
    transitions=list(h.state_actions)
    assert [action for _,action in transitions if action is not None]==h.actions
    state=transitions[-1][0]
    assert not state.status, (h.hand,'unfinished')
    assert state.stacks==h.finishing_stacks,(h.hand,state.stacks,h.finishing_stacks)
    expected=sum(len(a.split())>1 and a.split()[1] in {'f','cc','cbr'} for a in h.actions)
    played=sum(type(op).__name__ in {'Folding','CheckingOrCalling','CompletionBettingOrRaisingTo'} for op in state.operations)
    assert played==expected,(h.hand,'parser inserted an unrecorded player action',played,expected)
assert raw['4']['_tongzhuo_mini_net']==[6,-4,-2]
assert raw['4']['_tongzhuo_room_ending_stacks']==[106,146,98]
assert '????' in raw['2']['actions'][2]
assert raw['3']['actions'][2].endswith('??')
assert any('??' in a for a in hands[-1].actions if ' sm ' in a)
print(json.dumps({'parsed':len(hands),'replayed':len(hands)-1,'mini_separate':True}))
`;
  const result = spawnSync(process.env.POKERKIT_PYTHON, ['-c', script], { input: data, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { parsed: 8, replayed: 7, mini_separate: true });
});
