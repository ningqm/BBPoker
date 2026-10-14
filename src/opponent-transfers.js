// Attribution of settled public money movements. Never inspect cards/decks.
// A multi-winner pot has no recorded physical chip provenance. We distribute
// each net loser's loss among the pot's net winners in proportion to their gain.
// Exact fractions preserve conservation; numeric presentation happens last.
import { avatarImageId } from './avatar.js';
const METHOD = 'net-pot-proportional-v1';
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const natural = n => Number.isSafeInteger(n) && n >= 0;
const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
const sameIds = (a,b) => validIds(a) && validIds(b) && a.length === b.length && a.every(id => b.includes(id));
const gcd = (a,b) => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a; };
function rational(n, d = 1n) {
  if (d <= 0n) throw new Error('invalid fraction');
  const g = gcd(n,d); return { n:n/g, d:d/g };
}
const plus = (a,b) => rational(a.n*b.d+b.n*a.d,a.d*b.d);
const minus = (a,b) => rational(a.n*b.d-b.n*a.d,a.d*b.d);
// Denominators can grow beyond Number's range after many unlike allocations.
// Convert only the integer part and a bounded 15-decimal remainder, never n/d
// through separate floating-point conversions. Internal accounting stays exact.
function numeric(a) {
  const scale=1000000000000000n;
  return Number(a.n/a.d)+Number((a.n%a.d)*scale/a.d)/Number(scale);
}
const exact = a => ({ numerator:a.n.toString(), denominator:a.d.toString() });
const zero = () => rational(0n);
function addTransfer(map, fromId, toId, amount) {
  if (amount.n <= 0n || fromId === toId) return;
  const key = JSON.stringify([fromId,toId]), entry = map.get(key) ?? { fromId,toId,value:zero() };
  entry.value = plus(entry.value,amount); map.set(key,entry);
}
function transfersView(map) {
  return [...map.values()].sort((a,b) => a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId))
    .map(({fromId,toId,value}) => ({ fromId,toId,amount:numeric(value),exact:exact(value) }));
}
const unavailable = reason => ({ covered:false, method:METHOD, reason, allocated:false, transfers:[] });

/** Reconstruct contribution tiers from the final, refund-normalized archive.
 * Cross-check every pot, each player's total payout and their poker stack net.
 * A missing or inconsistent archive is wholly uncovered, never a guessed zero.
 */
export function directHandTransfers(hand) {
  if (!hand || hand.status !== 'complete' || !Array.isArray(hand.players) || hand.players.length < 2 || hand.players.length > 9
    || !validIds(hand.players.map(p => p?.id))) return unavailable('invalid_players');
  const players = hand.players, ids = players.map(p => p.id), result = hand.result;
  if (!result || !Array.isArray(result.pots) || !result.pots.length || !result.payouts
    || !sameIds(Object.keys(result.payouts),ids)) return unavailable('missing_pots');
  const deadById = new Map();
  for (const p of players) {
    if (!natural(p.contributed) || !natural(p.startingStack) || !p.startingStack || p.contributed>p.startingStack || !natural(p.stack) || typeof p.folded !== 'boolean'
      || !natural(result.payouts[p.id])) return unavailable('missing_balances');
    let dead = p.deadContribution;
    if (!own(p,'deadContribution')) {
      if (!Array.isArray(hand.log) || !hand.log.length || hand.log.some((e,i) => !e || typeof e.type !== 'string'
        || e.seq !== undefined && e.seq !== i+1)) return unavailable('missing_dead_contribution');
      const posts = hand.log.filter(e => e.type === 'deadBlind' && e.playerId === p.id);
      if (posts.some(e => !natural(e.amount))) return unavailable('invalid_dead_contribution');
      dead = posts.reduce((sum,e) => sum+e.amount,0);
    }
    if (!natural(dead) || dead > p.contributed) return unavailable('invalid_dead_contribution');
    deadById.set(p.id,dead);
  }
  const live = players.filter(p => !p.folded), matched = p => p.contributed-deadById.get(p.id);
  if (!live.length) return unavailable('no_eligible_player');
  const levels = [...new Set(players.map(matched).filter(n => n > 0))].sort((a,b) => a-b), tiers = [];
  let previous = 0;
  for (const level of levels) {
    const contributing = players.filter(p => matched(p) >= level), amount = level-previous; previous=level;
    // The actual engine refunds a lone unmatched contributor before archiving.
    if (contributing.length < 2) return unavailable('unrefunded_excess');
    let eligibleIds = contributing.filter(p => !p.folded).map(p => p.id);
    if (!eligibleIds.length && live.length === 1) eligibleIds = [live[0].id];
    if (!eligibleIds.length) return unavailable('invalid_eligibility');
    tiers.push({ contribution:new Map(contributing.map(p => [p.id,BigInt(amount)])), eligibleIds });
  }
  if ([...deadById.values()].some(n => n > 0)) {
    if (!tiers.length) tiers.push({ contribution:new Map(),eligibleIds:live.map(p => p.id) });
    for (const [id,n] of deadById) tiers[0].contribution.set(id,(tiers[0].contribution.get(id) ?? 0n)+BigInt(n));
  }
  if (tiers.length !== result.pots.length) return unavailable('pot_tiers_mismatch');
  const paid = new Map(ids.map(id => [id,0n])), transfers = new Map(); let allocated = false;
  for (let i=0;i<tiers.length;i++) {
    const tier = tiers[i], pot = result.pots[i];
    if (!pot || !natural(pot.amount) || !pot.amount || !sameIds(pot.eligibleIds,tier.eligibleIds)
      || !validIds(pot.winnerIds) || !pot.winnerIds.length || pot.winnerIds.some(id => !tier.eligibleIds.includes(id))) return unavailable('invalid_pot');
    const total = [...tier.contribution.values()].reduce((a,b) => a+b,0n);
    if (total !== BigInt(pot.amount)) return unavailable('pot_amount_mismatch');
    const shares = new Map(ids.map(id => [id,0n]));
    const share = total/BigInt(pot.winnerIds.length), odd = Number(total%BigInt(pot.winnerIds.length));
    for (const [index,id] of pot.winnerIds.entries()) { const n = share+BigInt(index<odd); shares.set(id,n); paid.set(id,paid.get(id)+n); }
    const winners = [], losers = [];
    for (const id of ids) {
      const net = shares.get(id)-(tier.contribution.get(id) ?? 0n);
      if (net>0n) winners.push({id,amount:net}); else if (net<0n) losers.push({id,amount:-net});
    }
    const gains = winners.reduce((sum,p) => sum+p.amount,0n), losses = losers.reduce((sum,p) => sum+p.amount,0n);
    if (gains !== losses) return unavailable('pot_not_conserved');
    allocated ||= winners.length>1 && losers.length>1;
    for (const loser of losers) for (const winner of winners) addTransfer(transfers,loser.id,winner.id,rational(loser.amount*winner.amount,gains));
  }
  for (const p of players) if (paid.get(p.id) !== BigInt(result.payouts[p.id])
    || paid.get(p.id)-BigInt(p.contributed) !== BigInt(p.stack)-BigInt(p.startingStack)) return unavailable('payout_or_stack_mismatch');
  return { covered:true,method:METHOD,reason:null,allocated,potCount:tiers.length,participantIds:ids,transfers:transfersView(transfers) };
}

/** Squid is an explicit transfer, not a poker-pot allocation. Evidence must
 * identify the complete frozen round and its final counts. Ledger rows remain
 * authoritative and every expected player's amount must agree with the rules.
 */
export function directSquidTransfers(rows, evidence) {
  if (!Array.isArray(rows) || !rows.length || !rows[0] || typeof rows[0]!=='object' || !evidence) return unavailable('missing_squid_evidence');
  const first = rows[0], q = typeof first.roundSettlementId==='string' && first.roundSettlementId
    && evidence.lastResult && typeof evidence.lastResult==='object'
    && evidence.lastResult.roundSettlementId===first.roundSettlementId ? evidence.lastResult : evidence;
  const ids = evidence.participants ?? q.participants ?? (Array.isArray(q.winnerIds) && Array.isArray(q.loserIds) ? [...q.winnerIds,...q.loserIds] : null);
  if (!validIds(ids) || ids.length<3 || ids.length>9 || !natural(q.unit) || !q.unit
    || !['normal','unlimited'].includes(q.mode ?? 'normal')) return unavailable('invalid_squid_evidence');
  if (typeof first.roomCode !== 'string' || typeof first.roundSettlementId !== 'string' || !first.roundSettlementId
    || q.roundSettlementId !== first.roundSettlementId) return unavailable('invalid_squid_identity');
  const settledAt=first.at===undefined?null:typeof first.at==='string'?Date.parse(first.at):NaN;
  if (settledAt!==null&&!Number.isFinite(settledAt) || own(q,'settledAt') && (typeof q.settledAt!=='string'||Date.parse(q.settledAt)!==settledAt)
    || own(q,'round') && q.round!==first.round || own(q,'reason') && q.reason!==first.reason) return unavailable('conflicting_squid_metadata');
  const mode = q.mode ?? 'normal', counts = new Map();
  for (const id of ids) {
    const count = q.counts && own(q.counts,id) ? q.counts[id] : mode === 'normal' && Array.isArray(q.won) ? Number(q.won.includes(id)) : null;
    if (!natural(count) || mode === 'normal' && count>1) return unavailable('missing_squid_counts');
    counts.set(id,count);
  }
  const total = [...counts.values()].reduce((a,b) => a+b,0), winners = ids.filter(id => counts.get(id)>0), losers = ids.filter(id => !counts.get(id));
  const budget = mode === 'normal' ? ids.length-1 : q.tokenBudget;
  if (!natural(budget) || budget<(mode==='normal'?ids.length-1:ids.length) || budget>ids.length+100 || total>budget
    || own(q,'tokenBudget') && q.tokenBudget!==budget || total>0 && !losers.length || own(q,'tokensAwarded') && q.tokensAwarded!==total) return unavailable('invalid_squid_budget');
  const unique = new Map();
  for (const row of rows) {
    if (!row || row.type!=='squidSettlement' || row.roomCode!==first.roomCode || row.roundSettlementId!==first.roundSettlementId
      || !ids.includes(row.playerId) || !Number.isSafeInteger(row.amount)) return unavailable('invalid_squid_row');
    if ((settledAt===null?row.at!==undefined:typeof row.at!=='string'||Date.parse(row.at)!==settledAt)
      || row.round!==first.round||row.reason!==first.reason) return unavailable('conflicting_squid_metadata');
    const expected = counts.get(row.playerId)>0 ? losers.length*counts.get(row.playerId)*q.unit : -total*q.unit;
    if (!Number.isSafeInteger(expected) || row.amount!==expected || own(row,'squidMode') && row.squidMode!==mode
      || own(row,'squidCount') && row.squidCount!==counts.get(row.playerId)
      || own(row,'tokenBudget') && row.tokenBudget!==budget || own(row,'tokensAwarded') && row.tokensAwarded!==total
      || own(row,'squidUnit') && row.squidUnit!==q.unit
      || own(row,'participantIds') && !sameIds(row.participantIds,ids)) return unavailable('squid_amount_mismatch');
    unique.set(row.playerId,row);
  }
  if (unique.size!==ids.length) return unavailable('incomplete_squid_rows');
  const transfers = new Map();
  for (const loser of losers) for (const winner of winners) addTransfer(transfers,loser,winner,rational(BigInt(counts.get(winner))*BigInt(q.unit)));
  return { covered:true,method:'squid-rule-v1',reason:null,allocated:false,participantIds:ids,transfers:transfersView(transfers) };
}

const blindOf = hand => { const bb=hand.settings?.bigBlind ?? hand.bigBlind; return Number.isSafeInteger(bb)&&bb>0 ? bb : null; };
const internalAmount = transfer => rational(BigInt(transfer.exact.numerator),BigInt(transfer.exact.denominator));
const blankBucket = () => ({ events:0,coveredEvents:0,unknownEvents:0,bbEvents:0,won:zero(),lost:zero(),wonBB:zero(),lostBB:zero() });
function addEvent(bucket, result, mine, peerIds, bb) {
  bucket.events++;
  if (!result.covered) { bucket.unknownEvents++; return; }
  bucket.coveredEvents++;
  let won=zero(),lost=zero();
  for (const transfer of result.transfers) {
    if (transfer.toId===mine && peerIds.includes(transfer.fromId)) won=plus(won,internalAmount(transfer));
    if (transfer.fromId===mine && peerIds.includes(transfer.toId)) lost=plus(lost,internalAmount(transfer));
  }
  bucket.won=plus(bucket.won,won); bucket.lost=plus(bucket.lost,lost);
  if (Number.isSafeInteger(bb)&&bb>0) {
    bucket.bbEvents++;
    bucket.wonBB=plus(bucket.wonBB,rational(won.n,won.d*BigInt(bb)));
    bucket.lostBB=plus(bucket.lostBB,rational(lost.n,lost.d*BigInt(bb)));
  } else if (!won.n && !lost.n) bucket.bbEvents++; // A known zero stays zero at any blind level.
  return { won,lost,net:minus(won,lost) };
}
function mergeBuckets(a,b) {
  return { events:a.events+b.events,coveredEvents:a.coveredEvents+b.coveredEvents,unknownEvents:a.unknownEvents+b.unknownEvents,bbEvents:a.bbEvents+b.bbEvents,
    won:plus(a.won,b.won),lost:plus(a.lost,b.lost),wonBB:plus(a.wonBB,b.wonBB),lostBB:plus(a.lostBB,b.lostBB) };
}
function bucketView(bucket) {
  const complete=bucket.unknownEvents===0, bbComplete=complete&&bucket.bbEvents===bucket.events;
  const knownBB=bucket.bbEvents===bucket.coveredEvents;
  const known={ won:numeric(bucket.won),lost:numeric(bucket.lost),net:numeric(minus(bucket.won,bucket.lost)),
    wonBB:knownBB?numeric(bucket.wonBB):null,lostBB:knownBB?numeric(bucket.lostBB):null,netBB:knownBB?numeric(minus(bucket.wonBB,bucket.lostBB)):null };
  return { events:bucket.events,coveredEvents:bucket.coveredEvents,unknownEvents:bucket.unknownEvents,bbEvents:bucket.bbEvents,complete,bbComplete,
    won:complete?known.won:null,lost:complete?known.lost:null,net:complete?known.net:null,
    wonBB:bbComplete?known.wonBB:null,lostBB:bbComplete?known.lostBB:null,netBB:bbComplete?known.netBB:null,covered:known };
}
function appearance(id, users, name='朋友') {
  const peer=users.get(id);
  return { id,name:peer?.name ?? name,avatar:Number.isInteger(peer?.avatar)&&peer.avatar>=0&&peer.avatar<12?peer.avatar:0,avatarImage:avatarImageId(peer?.avatarImage) };
}
function groupParticipants(group) {
  const q=group.evidence?.lastResult ?? group.evidence;
  const ids=group.participants ?? group.evidence?.participants ?? q?.participants ?? (Array.isArray(q?.winnerIds)&&Array.isArray(q?.loserIds)?[...q.winnerIds,...q.loserIds]:null);
  // A duplicated idempotent ledger row must not make an uncovered round vanish.
  const rowIds=[...new Set(group.rows?.map(r=>r?.playerId) ?? [])];
  return validIds(ids)?ids:validIds(rowIds)?rowIds:[];
}
const allBuckets = object => ({ ...object,holdem:bucketView(object.holdem),squid:bucketView(object.squid),total:bucketView(mergeBuckets(object.holdem,object.squid)) });

/** Caller selects dates/rooms/game modes. This pure report applies only the
 * opponent selector; squidGroups are complete rounds, never filtered rows.
 * Main amounts become null if any corresponding historical event is unknown.
 * `covered` amounts are an explicitly partial subset, not an inferred total.
 */
export function directOpponentRecords(entries, userId, filter={}, users=new Map(), { squidGroups=[] }={}) {
  const rows=new Map(), candidates=new Map(), handEvents=new Map(), squidEvents=new Map();
  const summary={ hands:0,coveredHands:0,unknownHands:0,allocatedHands:0,opponents:0,holdem:blankBucket(),squid:blankBucket() };
  function rowFor(id,at,name) {
    if (!rows.has(id)) rows.set(id,{ ...appearance(id,users,name),lastAt:at ?? null,hands:0,transferHands:0,wins:0,losses:0,even:0,allocatedHands:0,holdem:blankBucket(),squid:blankBucket() });
    const row=rows.get(id); if (typeof at==='string' && (!row.lastAt || at>row.lastAt)) row.lastAt=at;
    return row;
  }
  function peers(ids,names) {
    for (const id of ids.filter(id=>id!==userId)) if (!candidates.has(id)) candidates.set(id,{id,name:appearance(id,users,names?.get(id)).name});
    return ids.filter(id=>id!==userId&&(!filter.opponent||filter.opponent===id));
  }
  for (const entry of entries ?? []) {
    const hand=entry?.hand;
    if (!hand || hand.status!=='complete' || !Array.isArray(hand.players) || !hand.players.some(p=>p?.id===userId)) continue;
    const ids=hand.players.map(p=>p?.id); if (!validIds(ids)) continue;
    const names=new Map(hand.players.map(p=>[p.id,p.name])), opponents=peers(ids,names);
    if (!opponents.length) continue;
    const key=JSON.stringify([hand.roomCode,hand.id]), result=directHandTransfers(hand), bb=blindOf(hand);
    const event={ids:opponents,names,result,bb,at:hand.at};
    const prior=handEvents.get(key);
    if (prior) {
      if (JSON.stringify(prior.result)!==JSON.stringify(result)||prior.bb!==bb||prior.at!==hand.at||!sameIds(prior.ids,opponents)) prior.result=unavailable('conflicting_duplicate_hand');
    } else handEvents.set(key,event);
  }
  for (const event of handEvents.values()) {
    const {ids,names,result,bb,at}=event;
    summary.hands++; summary[result.covered?'coveredHands':'unknownHands']++;
    if (result.covered&&result.allocated) summary.allocatedHands++;
    addEvent(summary.holdem,result,userId,ids,bb);
    for (const id of ids) {
      const row=rowFor(id,at,names.get(id)); row.hands++;
      if (result.covered&&result.allocated) row.allocatedHands++;
      const amounts=addEvent(row.holdem,result,userId,[id],bb);
      if (amounts) { if (amounts.won.n||amounts.lost.n) row.transferHands++; row[amounts.net.n>0n?'wins':amounts.net.n<0n?'losses':'even']++; }
    }
  }
  for (const [index,group] of (squidGroups ?? []).entries()) {
    if (!group || !Array.isArray(group.rows)) continue;
    const all=groupParticipants(group); if (!all.includes(userId)) continue;
    const opponents=peers(all); if (!opponents.length) continue;
    const first=group.rows[0], roomCode=group.roomCode ?? first?.roomCode, settlementId=group.roundSettlementId ?? first?.roundSettlementId;
    const key=roomCode&&settlementId?JSON.stringify([roomCode,settlementId]):`unidentified-${index}`;
    const result=directSquidTransfers(group.rows,group.evidence), bb=Number.isSafeInteger(group.bigBlind)&&group.bigBlind>0?group.bigBlind:null,at=group.at ?? first?.at;
    const prior=squidEvents.get(key);
    if (prior) {
      if (JSON.stringify(prior.result)!==JSON.stringify(result)||prior.bb!==bb||prior.at!==at||!sameIds(prior.ids,opponents)) prior.result=unavailable('conflicting_duplicate_squid');
    } else squidEvents.set(key,{ids:opponents,result,bb,at});
  }
  for (const {ids,result,bb,at} of squidEvents.values()) {
    addEvent(summary.squid,result,userId,ids,bb);
    for (const id of ids) addEvent(rowFor(id,at).squid,result,userId,[id],bb);
  }
  summary.opponents=rows.size;
  const projected=[...rows.values()].map(allBuckets).sort((a,b)=>{
    const x=a.total.net,y=b.total.net;
    if (x===null||y===null) { if (x!==y) return x===null?1:-1; }
    return (y??0)-(x??0)||b.hands-a.hands||a.id.localeCompare(b.id);
  });
  return { method:METHOD,rows:projected,summary:allBuckets(summary),opponentOptions:[...candidates.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id)) };
}
