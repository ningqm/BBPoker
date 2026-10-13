import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequestGuard } from '../public/platform.js';

function harness() {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const first = source.indexOf('async function verifyHand('), end = source.indexOf('function eventText(', first);
  assert.ok(first >= 0 && end > first, 'Actual verifyHand implementation is required');
  const state = { user: { id: 'original' }, modal: null }, requests = createRequestGuard();
  const renders = [], pending = [], toasts = []; let closes = 0;
  const context = vm.createContext({ state, requests, receipts: {}, TextEncoder,
    crypto: { subtle: { digest: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
    openModal(title, body, kind) { state.modal = { title, body, kind }; renders.push(state.modal); },
    closeModal() { state.modal = null; closes++; },
    toast(message) { toasts.push(message); }, esc: String, card: value => `<card>${value}</card>`,
  });
  vm.runInContext(source.slice(first, end) + '\nglobalThis.verify = verifyHand;', context);
  return { state, requests, renders, pending, toasts, verify: context.verify, close: context.closeModal,
    get closes() { return closes; }, resolve(index) { pending[index].resolve(new Uint8Array(32).buffer); } };
}
function hand(id, card) {
  return { id, commitment: '00'.repeat(32), proofs: [{ position: 0, card, salt: 'synthetic', siblings: [] }] };
}

test('current card verification still renders successful proof details', async () => {
  const h = harness(), verification = h.verify(hand('current-hand', 'As'));
  assert.equal(h.pending.length, 1); h.resolve(0); await verification;
  assert.equal(h.state.modal.kind, 'verify'); assert.match(h.state.modal.body, /current-hand/);
  assert.match(h.state.modal.body, /<card>As<\/card>/); assert.match(h.state.modal.body, /所有可见牌与文件承诺一致/);
  assert.equal(h.closes, 0); assert.deepEqual(h.toasts, []);
});

for (const outcome of ['resolve', 'reject']) {
  test(`same-kind reopened verification ignores an older ${outcome} without closing or replacing it`, async () => {
    const h = harness(), old = h.verify(hand('old-hand', 'As'));
    h.close(); const current = h.verify(hand('new-hand', 'Kh')), currentModal = h.state.modal;
    if (outcome === 'resolve') h.resolve(0); else h.pending[0].reject(new Error('obsolete digest failure'));
    await old;
    assert.equal(h.state.modal, currentModal); assert.equal(h.closes, 1); assert.deepEqual(h.toasts, []);
    assert.equal(h.renders.length, 2, 'Stale verifier must not write private result HTML');
    h.resolve(1); await current; assert.match(h.state.modal.body, /new-hand/);
    assert.doesNotMatch(h.state.modal.body, /old-hand|<card>As<\/card>/);
  });

  test(`identity invalidation discards an old verification ${outcome} while a new account verifies`, async () => {
    const h = harness(), old = h.verify(hand('previous-private-hand', 'As'));
    h.requests.invalidate(); h.close(); h.state.user = { id: 'replacement' };
    const current = h.verify(hand('replacement-hand', 'Kh')), currentModal = h.state.modal;
    if (outcome === 'resolve') h.resolve(0); else h.pending[0].reject(new Error('previous-account failure'));
    await old;
    assert.equal(h.state.modal, currentModal); assert.equal(h.renders.length, 2);
    assert.equal(h.closes, 1); assert.deepEqual(h.toasts, []);
    h.resolve(1); await current;
    assert.match(h.state.modal.body, /replacement-hand/);
    assert.doesNotMatch(h.state.modal.body, /previous-private-hand|<card>As<\/card>/);
  });
}

test('identity invalidation alone blocks private verification results even if modal has not yet been cleared', async () => {
  const h = harness(), pending = h.verify(hand('previous-private-hand', 'As')), modal = h.state.modal;
  h.requests.invalidate(); h.state.user = { id: 'replacement' }; h.resolve(0); await pending;
  assert.equal(h.state.modal, modal); assert.equal(h.renders.length, 1);
  assert.doesNotMatch(h.state.modal.body, /previous-private-hand|<card>As<\/card>/);
  assert.deepEqual(h.toasts, []);
});

test('closing verification and opening an unrelated modal suppresses old failures', async () => {
  const h = harness(), pending = h.verify(hand('closed-hand', 'As'));
  h.close(); const other = { kind: 'hand-library', body: 'current library' }; h.state.modal = other;
  h.pending[0].reject(new Error('closed verifier failure')); await pending;
  assert.equal(h.state.modal, other); assert.equal(h.closes, 1); assert.deepEqual(h.toasts, []);
});

test('current verification failure still reports its error and closes the failed modal', async () => {
  const h = harness(), pending = h.verify(hand('current-hand', 'As'));
  h.pending[0].reject(new Error('current digest failure')); await pending;
  assert.equal(h.state.modal, null); assert.equal(h.closes, 1); assert.deepEqual(h.toasts, ['current digest failure']);
});
