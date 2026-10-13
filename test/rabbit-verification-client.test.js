import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { commitDeck, cardProof } from '../src/fairness.js';

test('visible rabbit cards participate in browser commitment verification, including tamper detection', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('async function verifyHand('), source.indexOf('function eventText('));
  const original = { id:'rabbit-browser-proof', deck:Array.from({length:52}, (_,i)=>String(i)) };
  original.audit = commitDeck(original);
  let html = '';
  const state = {}, context = vm.createContext({ state, receipts:{}, crypto:webcrypto, TextEncoder,
    esc:String, card:()=>'', toast(message){ throw new Error(message); }, closeModal(){},
    openModal(title, body, kind){ state.modal={kind}; html=body; },
  });
  vm.runInContext(functionSource, context);
  const visible = { id:original.id, commitment:original.audit.root, proofs:[cardProof(original,0)], rabbit:{proofs:[cardProof(original,5)]} };
  await context.verifyHand(visible);
  assert.match(html,/2 张牌已检查/); assert.match(html,/所有可见牌与文件承诺一致/);
  visible.rabbit.proofs[0].card='tampered';
  await context.verifyHand(visible);
  assert.match(html,/发现不一致/);
});
