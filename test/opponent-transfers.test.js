import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, applyAction, advanceRunout, availableActions } from '../src/poker.js';
import { directHandTransfers, directSquidTransfers, directOpponentRecords } from '../src/opponent-transfers.js';

// Decks drive the actual poker engine. Every financial expectation is separately
// hand-calculated below, not derived from an evaluator or the subject module.
const PACK = [...'cdhs'].flatMap(s => [...'23456789TJQKA'].map(r => r+s));
const AT = '2026-10-14T08:00:00.000Z';
function fixture({ids=['A','B'],stacks=ids.map(()=>100),holes,board,bb=10,room='100001',id='hand',entryPosts=[],bombPot=false,ante=0}) {
  const assigned=new Map(),order=[...ids.slice(1),ids[0]];
  for (let i=0;i<2;i++) order.forEach((p,j)=>assigned.set(i*ids.length+j,holes[p][i]));
  [2*ids.length+1,2*ids.length+2,2*ids.length+3,2*ids.length+5,2*ids.length+7].forEach((p,i)=>assigned.set(p,board[i]));
  assert.equal(new Set(assigned.values()).size,assigned.size);
  const unused=PACK.filter(c=>![...assigned.values()].includes(c));
  const deck=PACK.map((_,i)=>assigned.get(i)??unused.shift());
  const h=createHand({id,players:ids.map((p,seat)=>({id:p,name:p,seat,stack:stacks[seat]})),buttonSeat:0,smallBlind:bb/2,bigBlind:bb,
    deck,deferredRunout:true,entryPosts,bombPot,ante});
  return Object.assign(h,{roomCode:room,at:AT,settings:{smallBlind:bb/2,bigBlind:bb},miniChanges:{}});
}
function through(h,street) {
  for (let n=0;h.status==='playing'&&h.street!==street;n++) {
    assert.ok(n<100); applyAction(h,h.actingId,availableActions(h,h.actingId).canCheck?'check':'call');
  }
  assert.equal(h.street,street);
}
function complete(h) {
  for (let n=0;h.status==='playing';n++) {
    assert.ok(n<100);
    if(h.runout?.active) advanceRunout(h); else applyAction(h,h.actingId,availableActions(h,h.actingId).canCheck?'check':'call');
  }
  return h;
}
function headsUp({id='heads-up',bb=10,room='100001',stacks=[100,100],reverse=false}={}) {
  const h=fixture({id,bb,room,stacks,holes:{A:reverse?['Ks','Kh']:['As','Ah'],B:reverse?['As','Ah']:['Ks','Kh']},board:['2c','7d','8h','9s','3d']});
  through(h,'turn'); applyAction(h,'B','check'); applyAction(h,'A','allin'); applyAction(h,'B','call'); return complete(h);
}
function sidePots({bombPot=false,entryPosts=[]}={}) {
  const h=fixture({id:'side-pots',ids:['A','B','C'],stacks:[100,200,200],holes:{A:['As','Ah'],B:['Ks','Kh'],C:['Qs','Qh']},
    board:['Ac','Kd','Qc','2s','3d'],bombPot,ante:bombPot?20:0,entryPosts});
  through(h,'turn'); applyAction(h,'B','allin'); applyAction(h,'C','call'); applyAction(h,'A','call'); return complete(h);
}
const simple = result => result.transfers.map(({fromId,toId,amount})=>[fromId,toId,amount]);
const entries = hands => hands.map(hand=>({hand}));
const byId = (report,id) => report.rows.find(r=>r.id===id);
function assertReconciles(h,result) {
  assert.equal(result.covered,true,result.reason);
  for(const p of h.players) {
    const net=result.transfers.reduce((n,t)=>n+(t.toId===p.id?t.amount:0)-(t.fromId===p.id?t.amount:0),0);
    assert.ok(Math.abs(net-(p.stack-p.startingStack))<1e-9,`${p.id} attributed ${net}`);
  }
}

test('head-to-head all-in attributes only matched loss, excluding a 900-point uncalled refund',()=>{
  const h=headsUp({stacks:[1000,100],reverse:true});
  assert.equal(h.players[0].stack,900);
  const result=directHandTransfers(h);
  assert.deepEqual(simple(result),[['A','B',100]]);
  assert.equal(result.allocated,false); assertReconciles(h,result);
});

test('three-way main and side winners keep pairwise transfers even when a winner has zero whole-hand net',()=>{
  for(const bombPot of [false,true]) {
    const h=sidePots({bombPot}), result=directHandTransfers(h);
    // 300 main: A takes B100+C100; 200 side: B takes C100.
    assert.deepEqual(simple(result),[['B','A',100],['C','A',100],['C','B',100]]);
    assert.deepEqual(h.players.map(p=>p.stack-p.startingStack),[200,0,-200]);
    assertReconciles(h,result);
    const report=directOpponentRecords(entries([h]),'B');
    assert.equal(byId(report,'A').total.net,-100); assert.equal(byId(report,'C').total.net,100);
    assert.equal(report.summary.total.net,0); assert.equal(report.summary.total.won,100); assert.equal(report.summary.total.lost,100);
    assert.equal(report.summary.hands,1); assert.equal(report.summary.holdem.events,1);
    assert.equal(report.rows.reduce((n,r)=>n+r.hands,0),2);
  }
});

test('tied winners never pay one another: odd-chip folded blind goes 2 to A and 3 to B',()=>{
  const h=fixture({ids:['A','C','B'],holes:{A:['2d','3d'],B:['4h','5h'],C:['6d','7d']},board:['Ac','Kc','Qc','Jc','Tc']});
  applyAction(h,'A','raise',20); applyAction(h,'C','fold'); applyAction(h,'B','call'); complete(h);
  assert.deepEqual(h.result.payouts,{A:22,C:0,B:23});
  const result=directHandTransfers(h);
  assert.deepEqual(simple(result),[['C','A',2],['C','B',3]]); assertReconciles(h,result);
  const report=directOpponentRecords(entries([h]),'A');
  assert.equal(byId(report,'B').total.net,0); assert.equal(byId(report,'B').even,1);
  assert.equal(byId(report,'B').transferHands,0); assert.equal(byId(report,'C').total.net,2);
});

test('five-way folded dead blind and split pot use exact rational allocations per actual pot',()=>{
  const h=fixture({ids:['A','C','D','E','B'],holes:{A:['2d','3d'],B:['4h','5h'],C:['6d','7d'],D:['8d','9d'],E:['Th','Jh']},
    board:['Ac','Kc','Qc','Jc','Tc'],entryPosts:[{playerId:'C',live:10,dead:5}]});
  applyAction(h,'E','call'); applyAction(h,'B','raise',20); applyAction(h,'A','call');
  for(const id of ['C','D','E']) applyAction(h,id,'fold'); complete(h);
  // 55 main: A27 B28, with A/B live10, C live10+dead5, D/E10.
  // Thus net winners A17/B18; losers C15/D10/E10. The 20 side is a wash.
  const result=directHandTransfers(h); assert.equal(result.allocated,true); assertReconciles(h,result);
  assert.deepEqual(result.transfers.map(t=>[t.fromId,t.toId,t.exact]),[
    ['C','A',{numerator:'51',denominator:'7'}],['C','B',{numerator:'54',denominator:'7'}],
    ['D','A',{numerator:'34',denominator:'7'}],['D','B',{numerator:'36',denominator:'7'}],
    ['E','A',{numerator:'34',denominator:'7'}],['E','B',{numerator:'36',denominator:'7'}],
  ]);
  assert.equal(result.transfers.some(t=>t.fromId==='A'||t.fromId==='B'),false);
  const report=directOpponentRecords(entries([h]),'A');
  assert.equal(report.summary.total.net,17); assert.equal(report.summary.allocatedHands,1);
});

test('dead entry SB belongs to main pot and is never refunded or turned into a phantom side pot',()=>{
  const h=fixture({ids:['A','B','C'],stacks:[100,50,100],holes:{A:['As','Ah'],B:['Ks','Kh'],C:['Qs','Qh']},
    board:['Ac','Kd','Qc','2s','3d'],entryPosts:[{playerId:'A',live:10,dead:5}]});
  applyAction(h,'A','allin'); applyAction(h,'B','call'); applyAction(h,'C','call'); complete(h);
  // A's 5 dead leaves live95. Main155 costs A55/B50/C50; A wins all.
  // Side90 costs A45/C45. A takes B50 and C95, not C100.
  assert.deepEqual(h.result.pots.map(p=>p.amount),[155,90]);
  const result=directHandTransfers(h); assert.deepEqual(simple(result),[['B','A',50],['C','A',95]]); assertReconciles(h,result);
  const old=structuredClone(h); for(const p of old.players) delete p.deadContribution;
  assert.deepEqual(directHandTransfers(old),result); // Valid legacy log supplies the dead blind.
});

test('all-fold finish includes only the paid blinds, not the winning raise that was returned',()=>{
  const h=fixture({ids:['A','B','C'],holes:{A:['As','Ah'],B:['Ks','Kh'],C:['Qs','Qh']},board:['Ac','Kd','Qc','2s','3d']});
  applyAction(h,'A','raise',40); applyAction(h,'B','fold'); applyAction(h,'C','fold');
  const result=directHandTransfers(h); assert.deepEqual(simple(result),[['B','A',5],['C','A',10]]); assertReconciles(h,result);
});

test('forced short all-in plus side pot excludes the unmatched tail and keeps each tier attribution',()=>{
  const h=fixture({ids:['A','B','C'],stacks:[100,5,15],holes:{A:['Qs','Qh'],B:['As','Ah'],C:['Ks','Kh']},board:['Ac','Kd','Qc','2s','3d']});
  applyAction(h,'A','allin');applyAction(h,'C','call');complete(h);
  // B's AA takes the 15 main. C's KK takes the 20 side. A gets 85 back.
  assert.deepEqual(h.result.payouts,{A:0,B:15,C:20});
  const result=directHandTransfers(h);
  assert.deepEqual(simple(result),[['A','B',5],['A','C',10],['C','B',5]]);assertReconciles(h,result);
});

test('strong balance/eligibility/payout checks make corrupt or insufficient old archives uncovered',()=>{
  const base=sidePots();
  const mutations=[
    h=>delete h.result.pots,
    h=>h.result.pots[0].amount++,
    h=>h.result.pots[0].eligibleIds.pop(),
    h=>h.result.pots[1].winnerIds=['A'],
    h=>h.result.payouts.A++,
    h=>h.players[0].stack++,
    h=>h.players[0].contributed++,
    h=>h.players[0].deadContribution=-1,
    h=>{delete h.players[0].deadContribution;delete h.log;},
    h=>{delete h.players[0].deadContribution;h.log[0].seq=2;},
    h=>h.players[0].startingStack=NaN,
  ];
  for(const mutate of mutations) {
    const h=structuredClone(base); mutate(h); const result=directHandTransfers(h);
    assert.equal(result.covered,false,mutate.toString()); assert.deepEqual(result.transfers,[]);
  }
});

function squid({mode='normal',counts={A:1,B:1,C:0},unit=20,budget=2,room='100001',round='round-1',bb=10}={}) {
  const ids=Object.keys(counts),issued=Object.values(counts).reduce((a,b)=>a+b,0),missing=ids.filter(id=>!counts[id]).length;
  const rows=ids.map(playerId=>({type:'squidSettlement',roomCode:room,roundSettlementId:round,playerId,
    amount:counts[playerId]?counts[playerId]*missing*unit:-issued*unit,at:AT,
    squidMode:mode,squidCount:counts[playerId],tokenBudget:budget,tokensAwarded:issued}));
  return {rows,bigBlind:bb,at:AT,evidence:{participants:ids,roundSettlementId:round,mode,counts,unit,tokenBudget:budget,tokensAwarded:issued}};
}

test('ordinary squid uses authoritative actual unit and never creates transfers between fish holders',()=>{
  const g=squid({unit:37}), result=directSquidTransfers(g.rows,g.evidence);
  assert.equal(result.covered,true); assert.deepEqual(simple(result),[['C','A',37],['C','B',37]]);
  const report=directOpponentRecords([],'A',{},new Map(),{squidGroups:[g]});
  assert.equal(report.summary.squid.net,37); assert.equal(report.summary.total.netBB,3.7);
  assert.equal(byId(report,'B').squid.net,0); assert.equal(byId(report,'C').squid.net,37);
  assert.equal(report.summary.hands,0); assert.equal(report.summary.squid.events,1);
});

test('unlimited squid repeats tokens and pays each holder from every no-fish player, including absentees',()=>{
  const g=squid({mode:'unlimited',counts:{A:4,B:2,C:0,D:0},unit:13,budget:7});
  // Six awarded, early absence settlement leaves the seventh unawarded.
  // C/D each pay78; A gets104, B52. No ghost token or A/B transfer.
  const result=directSquidTransfers(g.rows,g.evidence);
  assert.equal(result.covered,true); assert.deepEqual(simple(result),[['C','A',52],['C','B',26],['D','A',52],['D','B',26]]);
  const report=directOpponentRecords([],'A',{},new Map(),{squidGroups:[g]});
  assert.equal(report.summary.total.net,104); assert.equal(byId(report,'C').total.net,52); assert.equal(byId(report,'B').total.net,0);
  const last={participants:g.evidence.participants,lastResult:{...g.evidence}};
  assert.deepEqual(directSquidTransfers(g.rows,last),result);
});

test('squid cannot infer unit, missing rows, corrupted count, mode or duplicated conflict as zero',()=>{
  const base=squid();
  for(const mutate of [
    g=>g.rows.pop(),g=>g.rows[0].amount++,g=>g.evidence.unit++,g=>g.evidence.counts.A=2,
    g=>g.evidence.tokenBudget=4,g=>g.evidence.roundSettlementId='other',g=>delete g.evidence.counts,
    g=>g.rows.push({...g.rows[0],amount:999}),g=>g.rows[0].squidMode='unlimited',g=>g.evidence.tokensAwarded++,
    g=>g.rows[0].squidUnit=123,g=>g.rows[0].participantIds=['A','B','X'],
  ]) {
    const g=structuredClone(base);mutate(g); const result=directSquidTransfers(g.rows,g.evidence);
    assert.equal(result.covered,false,mutate.toString());assert.deepEqual(result.transfers,[]);
  }
  const old=structuredClone(base); old.evidence.won=['A','B']; delete old.evidence.counts; delete old.evidence.mode;
  assert.equal(directSquidTransfers(old.rows,old.evidence).covered,true);
  for(const rows of [null,[],[null],[undefined],['invalid'],[123]]) assert.equal(directSquidTransfers(rows,{}).covered,false);
  for(const lastResult of [undefined,null,{}, {roundSettlementId:null}]) {
    const legacy=structuredClone(base);
    for(const row of legacy.rows)delete row.roundSettlementId;
    delete legacy.evidence.roundSettlementId;legacy.evidence.lastResult=lastResult;
    assert.equal(directSquidTransfers(legacy.rows,legacy.evidence).covered,false);
  }
});

test('hand/round repeated input is idempotent; conflicting duplicate is unknown instead of first-row-wins',()=>{
  const h=headsUp(),g=squid();
  g.rows.push({...g.rows[0]});
  const report=directOpponentRecords(entries([h,structuredClone(h)]),'A',{},new Map(),{squidGroups:[g,structuredClone(g)]});
  assert.equal(report.summary.hands,1);assert.equal(report.summary.squid.events,1);
  assert.equal(report.summary.total.net,120);assert.equal(byId(report,'B').total.net,100);
  const conflicting=structuredClone(h);conflicting.result.payouts.A++;
  const broken=directOpponentRecords(entries([h,conflicting]),'A');
  assert.equal(broken.summary.hands,1);assert.equal(broken.summary.unknownHands,1);assert.equal(broken.summary.total.net,null);
  const conflict=structuredClone(g);conflict.rows[0].amount++;
  const fish=directOpponentRecords([],'A',{},new Map(),{squidGroups:[g,conflict]});
  assert.equal(fish.summary.squid.events,1);assert.equal(fish.summary.total.net,null);
});

test('same-round conflicting timestamps, reasons, round numbers and settled snapshots are uncovered',()=>{
  const original=squid();
  for(const row of original.rows)Object.assign(row,{round:3,reason:'last-unmarked'});
  Object.assign(original.evidence,{round:3,reason:'last-unmarked',settledAt:AT});
  assert.equal(directSquidTransfers(original.rows,original.evidence).covered,true);
  for(const alter of [
    g=>g.rows[1].at='2026-10-15T08:00:00.000Z',g=>delete g.rows[1].at,g=>g.rows[1].round=4,
    g=>g.rows[1].reason='closed',g=>g.rows.push({...g.rows[0],at:'2026-10-15T08:00:00.000Z'}),
    g=>g.rows.push({...g.rows[0],round:4}),g=>g.rows.push({...g.rows[0],reason:'closed'}),
    g=>g.evidence.settledAt='2026-10-15T08:00:00.000Z',g=>g.evidence.round=4,g=>g.evidence.reason='closed',
  ]) {
    const group=structuredClone(original);alter(group);
    assert.equal(directSquidTransfers(group.rows,group.evidence).covered,false,alter.toString());
    const report=directOpponentRecords([],'A',{},new Map(),{squidGroups:[group]});
    assert.equal(report.summary.squid.unknownEvents,1);assert.equal(report.summary.total.net,null);
  }
});

test('unknown legacy fish remains an unknown event even without ledger evidence or with repeated player rows',()=>{
  const g=squid();g.rows.push({...g.rows[0]});g.evidence=null;
  const report=directOpponentRecords([],'A',{},new Map(),{squidGroups:[g]});
  assert.equal(report.summary.squid.events,1);assert.equal(report.summary.squid.unknownEvents,1);
  assert.equal(report.summary.total.net,null);assert.equal(report.rows.length,2);
  const placeholder={rows:[],participants:['A','B','C'],roomCode:'100001',roundSettlementId:'legacy-hand1',at:AT,evidence:null};
  const omitted=directOpponentRecords([],'A',{},new Map(),{squidGroups:[placeholder]});
  assert.equal(omitted.summary.squid.events,1);assert.equal(byId(omitted,'B').squid.net,null);
});

test('mixed stakes normalize each event independently, and missing BB never fabricates a full BB result',()=>{
  const one=headsUp({id:'one'}),two=headsUp({id:'two',bb:20,stacks:[200,200],reverse:true});
  const report=directOpponentRecords(entries([one,two]),'A');
  assert.equal(report.summary.total.net,-100);assert.equal(report.summary.total.netBB,0);
  assert.equal(report.summary.total.wonBB,10);assert.equal(report.summary.total.lostBB,10);
  delete two.settings;delete two.bigBlind;
  const missing=directOpponentRecords(entries([one,two]),'A');
  assert.equal(missing.summary.total.net,-100);assert.equal(missing.summary.total.netBB,null);
  assert.equal(missing.summary.total.complete,true);assert.equal(missing.summary.total.bbComplete,false);
  assert.equal(missing.summary.total.covered.netBB,null);
});

test('uncovered mixed history is explicitly partial; opponent selector retains options and additive summary',()=>{
  const good=sidePots(),bad=headsUp({id:'bad'});delete bad.result.pots;
  const report=directOpponentRecords(entries([good,bad]),'A');
  assert.equal(report.summary.hands,2);assert.equal(report.summary.coveredHands,1);assert.equal(report.summary.unknownHands,1);
  assert.equal(report.summary.total.net,null);assert.equal(report.summary.total.covered.net,200);
  assert.equal(byId(report,'B').total.net,null);assert.equal(byId(report,'B').total.covered.net,100);
  assert.equal(byId(report,'C').total.net,100);
  const selected=directOpponentRecords(entries([good,bad]),'A',{opponent:'C'});
  assert.equal(selected.summary.total.net,100);assert.equal(selected.summary.hands,1);
  assert.deepEqual(selected.opponentOptions.map(p=>p.id),['B','C']);assert.equal(selected.rows.length,1);
  const unseen=directOpponentRecords(entries([good]),'outsider');assert.deepEqual(unseen.rows,[]);assert.equal(unseen.summary.total.net,0);
});

test('report never reads hidden cards, deck, seeds or account secrets and serializes only public aggregation',()=>{
  const h=sidePots(), users=new Map([['B',{id:'B',name:'Bob',avatar:3,avatarImage:'f'.repeat(32)}]]);
  const secret=(object,key)=>Object.defineProperty(object,key,{get(){throw new Error(`private ${key} read`);},enumerable:true});
  for(const key of ['deck','seed','commitment','log'])secret(h,key);
  for(const p of h.players)for(const key of ['cards','cardSalts'])secret(p,key);
  for(const key of ['passwordHash','recoveryCode','sessions'])secret(users.get('B'),key);
  const report=directOpponentRecords(entries([h]),'A',{},users);
  assert.equal(report.summary.total.net,200);assert.equal(byId(report,'B').name,'Bob');
  const serialized=JSON.stringify(report);
  for(const key of ['deck','seed','passwordHash','cards','cardSalts','payouts','contributed','log','recoveryCode','sessions'])assert.equal(serialized.includes(`"${key}"`),false,key);
});

test('over 100 unlike split-pot denominators stay finite after exact aggregate denominator exceeds Number range',()=>{
  const primes=[];let product=1n;
  for(let p=11;product.toString().length<=330;p+=2) {
    let prime=true;for(let d=3;d*d<=p;d+=2)if(p%d===0){prime=false;break;}
    if(prime){primes.push(p);product*=BigInt(p);}
  }
  assert.ok(product>10n**330n);
  const hands=primes.map(p=>{
    const live=(p-1)/2;
    const h=fixture({id:`prime-${p}`,ids:['A','B','C','D'],stacks:[live,live,live+1,live],bb:2,
      holes:{A:['As','Kd'],B:['Ah','Kc'],C:['Qs','Qh'],D:['Js','Jh']},board:['Ad','7c','8d','9s','2h'],
      entryPosts:[{playerId:'C',live:2,dead:1}]});
    applyAction(h,'D','allin');complete(h);
    // Two identical winning A/K hands split 4*live+1. B takes the odd point:
    // B's gain=live+1, C's loss=live+1, total net loss=2*live+1=p.
    assert.equal(h.result.payouts.B,p);assert.equal(h.result.payouts.A,p-1);
    return h;
  });
  // Each summand ((p+1)/2)^2 / p has reduced denominator p; distinct primes
  // cannot cancel in their sum, so the exact aggregate denominator >10^330.
  // Compute this bounded floating oracle before aggregation, avoiding the same
  // huge-rational projection that this regression is intended to exercise.
  const expected=primes.reduce((sum,p)=>sum+p/4+0.5+1/(4*p),0);
  const gain=directOpponentRecords(entries(hands),'B',{opponent:'C'});
  const loss=directOpponentRecords(entries(hands),'C',{opponent:'B'});
  assert.equal(gain.summary.coveredHands,primes.length);
  assert.ok(Math.abs(gain.summary.total.net-expected)<1e-8);
  assert.ok(Math.abs(gain.summary.total.netBB-expected/2)<1e-8);
  assert.ok(Math.abs(loss.summary.total.net+expected)<1e-8);
  function finiteNumbers(value) {
    if(typeof value==='number')assert.equal(Number.isFinite(value),true);
    else if(value&&typeof value==='object')for(const next of Object.values(value))finiteNumbers(next);
  }
  for(const report of [gain,loss]) {
    finiteNumbers(report);
    const parsed=JSON.parse(JSON.stringify(report));
    assert.equal(typeof parsed.summary.total.net,'number');
    assert.equal(typeof parsed.rows[0].total.wonBB,'number');
  }
});
