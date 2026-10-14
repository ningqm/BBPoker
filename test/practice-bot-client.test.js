import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { PracticeBotClient } from '../scripts/practice-bot-client.mjs';
import { decideAction } from '../scripts/practice-bot-strategy.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bbpoker-bot-test-'));
  const app = createApp({ dataDir: directory, actionTickMs: 20, allowGuestSessions: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  async function api(token, path, body) {
    const response = await fetch(baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json(); assert.ok(response.ok, value.error); return value;
  }
  const bot = await api(null, '/api/session', { name: '测试陪练机器人' });
  const human = await api(null, '/api/session', { name: '测试玩家' });
  const { room } = await api(bot.token, '/api/rooms', { name: '隔离测试', access: 'invite', settings: { maxPlayers: 2 } });
  const action = (user, extra) => api(user.token, `/api/rooms/${room.code}/action`, { commandId: randomUUID(), ...extra });
  await action(bot, { type: 'sit', seat: 0, amountBB: 200, entryMode: 'post' });
  return { app, api, bot, human, room, action, baseUrl };
}

test('ordinary-client bot hosts, plays two hands, survives stream loss and closes between hands', { timeout: 45000 }, async t => {
  const f = await fixture(t), events = [];
  let client;
  client = new PracticeBotClient({ baseUrl: f.baseUrl, token: f.bot.token, roomCode: f.room.code,
    thinkMs: 15, maxRunMs: 35000, maxShutdownMs: 1500, decideAction,
    onEvent: event => { events.push(event); if (event.type === 'hand_complete' && events.filter(e => e.type === 'hand_complete').length >= 2) client.stop(); } });
  const running = client.run();
  t.after(() => client.stop());
  await f.api(f.human.token, `/api/rooms/${f.room.code}/join`, { invite: f.room.invite });
  const stream = await fetch(`${f.baseUrl}/api/events?room=${f.room.code}`, { headers: { Authorization: `Bearer ${f.human.token}` } });
  const reader = stream.body.getReader();
  const consuming = (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
  t.after(async () => { await reader.cancel(); await consuming; });
  await f.action(f.human, { type: 'sit', seat: 1, amountBB: 200, entryMode: 'post' });
  const until = Date.now() + 35000;
  let broken = false, hiddenCardsChecked = false, humanActions = 0;
  while (Date.now() < until) {
    const view = await f.api(f.human.token, `/api/rooms/${f.room.code}`);
    if (view.status === 'closed') break;
    if (view.hand?.status === 'playing') {
      const opponent = view.players.find(player => player.id === f.bot.user.id);
      const publicShowdown=view.hand.transition?.kind==='showdown'&&view.hand.transition.revealed;
      if (!view.hand.runout?.active&&!publicShowdown) { assert.ok(opponent.cards.every(card => card === null)); hiddenCardsChecked = true; }
      else if(!opponent.folded)assert.equal(opponent.cards.filter(Boolean).length,2,'A contender is visible only during public runout/showdown');
      if (!broken) {
        // Test transport recovery only, never rewrite game/deck state.
        assert.ok(client.streamController);
        client.streamController.abort();
        broken = true;
      }
      if (view.actions.canAct) {
        await f.action(f.human, { type: view.actions.canCheck ? 'check' : 'call', handId: view.hand.id, actionSeq: view.hand.actionSeq });
        humanActions++;
      }
    }
    await sleep(150);
  }
  client.stop();
  const result = await running;
  assert.equal(result.closed, true);
  const view = await f.api(f.human.token, `/api/rooms/${f.room.code}`);
  assert.equal(view.status, 'closed');
  const history = await f.api(f.human.token, `/api/rooms/${f.room.code}/history`);
  assert.ok(history.hands.length >= 2, `Only ${history.hands.length} hands completed`);
  assert.ok(humanActions > 0); assert.ok(hiddenCardsChecked);
  assert.ok(events.some(event => event.type === 'ready'));
  assert.ok(events.some(event => event.type === 'retry' && event.phase === 'connection'));
  const handIds = events.filter(event => event.type === 'hand_complete').map(event => event.handId);
  assert.equal(new Set(handIds).size, handIds.length, 'No duplicate completion events');
  assert.ok(!JSON.stringify(events).includes(f.bot.token));
  assert.equal(view.players.reduce((sum, player) => sum + player.sessionProfit, 0), 0);
});

test('unattended practice room closes after the configured wait without starting a hand', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const client = new PracticeBotClient({ baseUrl: f.baseUrl, token: f.bot.token, roomCode: f.room.code,
    thinkMs: 10, maxWaitMs: 200, maxRunMs: 5000, decideAction });
  const result = await client.run();
  assert.equal(result.closed, true);
  const view = await f.api(f.bot.token, `/api/rooms/${f.room.code}`);
  assert.equal(view.status, 'closed'); assert.equal(view.hand, null);
});

test('persistent network failure has a bounded local shutdown and never claims the room closed', { timeout: 6000 }, async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (requests++ === 0) return new Response(JSON.stringify({ code: '123456', meId: 'bot', hostId: 'bot', access: 'invite',
      settings: { maxPlayers: 2 }, players: [{ id: 'bot', seat: 0 }], status: 'waiting', revision: 1, serverTime: Date.now(), hand: null, autoDeal: { paused: false } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 503 });
  });
  const client = new PracticeBotClient({ baseUrl: 'http://127.0.0.1', token: 'synthetic-test-token', roomCode: '123456', decideAction,
    maxRunMs: 0, maxShutdownMs: 100 });
  const result = await client.run();
  assert.equal(result.reason, 'shutdown_timeout'); assert.equal(result.closed, false);
  assert.ok(requests < 10, 'Network errors must not cause a retry flood');
});

test('the bot waits for transition and authoritative reveal readiness, including when its action sequence is unchanged',()=>{
 const client=new PracticeBotClient({baseUrl:'http://127.0.0.1',token:'synthetic-test-token',roomCode:'123456',decideAction});
 const now=Date.now();
 const room={code:'123456',meId:'bot',hostId:'bot',access:'invite',settings:{maxPlayers:2},players:[{id:'bot',seat:0}],status:'playing',revision:1,serverTime:now,
  hand:{id:'h1',status:'playing',actingId:'bot',actionSeq:5,actionReadyAt:now+900},deadline:now+20900,actions:{canAct:false}};
 client.accept(room);const key=client.actionKey();assert.equal(client.canAct(key),false);
 client.accept({...room,revision:2,actions:{canAct:true}});assert.equal(client.canAct(key),false,'No action while cards are still flipping');
 const ready={...room,revision:3,serverTime:now+900,actions:{canAct:true}};client.accept(ready);assert.equal(client.canAct(key),true);
 for(const kind of ['street','showdown','award']){
  client.accept({...ready,revision:++ready.revision,hand:{...ready.hand,transition:{kind,nextAt:now+1800}}});
  assert.equal(client.canAct(key),false,'No action in '+kind+' even if an old actor survived');
 }
 client.accept({...ready,revision:++ready.revision,hand:{...ready.hand,runout:{active:true}}});assert.equal(client.canAct(key),false);
});
