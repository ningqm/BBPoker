import { handTendencies } from './analytics.js';
import { avatarImageId } from './avatar.js';
import { versusStats } from './versus-stats.js';

const rate = (count, opportunities) => ({ count, opportunities, percent: opportunities ? Math.round(count / opportunities * 1000) / 10 : null });
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

/** Room membership is authorized by RoomService before this aggregate-only projection. */
export function publicPlayerStats(db, viewerId, roomCode, player, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'scope')) fail('玩家数据筛选无效');
  const scope = options.scope ?? 'table';
  if (!['table', 'career'].includes(scope)) fail('请选择本桌数据或累计数据');
  if (!player) throw Object.assign(new Error('玩家不存在'), { status: 404 });
  const hands = db.hands.filter(hand => hand.status === 'complete'
    && hand.players.some(p => p.id === player.id && p.cards?.length === 2)
    && (scope === 'career' || hand.roomCode === roomCode));
  const counters = { vpip: 0, pfr: 0, rfi: 0, rfiOpportunity: 0, threeBet: 0, threeBetOpportunity: 0,
    fourBet: 0, fourBetOpportunity: 0, fiveBet: 0, fiveBetOpportunity: 0, flopSeen: 0 };
  let wins = 0, preflopHands = 0, showdowns = 0, wonShowdown = 0;
  for (const hand of hands) {
    const p = hand.players.find(p => p.id === player.id), tendency = handTendencies(hand, player.id);
    for (const key of Object.keys(counters)) if (tendency[key]) counters[key]++;
    if (!hand.bombPot) preflopHands++;
    if (p.stack > p.startingStack) wins++;
    if (hand.result?.showdown && !p.folded) {
      showdowns++; if ((hand.result.payouts?.[player.id] ?? 0) > 0) wonShowdown++;
    }
  }
  const metrics = { winRate: rate(wins, hands.length), vpip: rate(counters.vpip, preflopHands), pfr: rate(counters.pfr, preflopHands),
    rfi: rate(counters.rfi, counters.rfiOpportunity), threeBet: rate(counters.threeBet, counters.threeBetOpportunity),
    fourBet: rate(counters.fourBet, counters.fourBetOpportunity), fiveBet: rate(counters.fiveBet, counters.fiveBetOpportunity),
    wtsd: rate(showdowns, counters.flopSeen), wsd: rate(wonShowdown, showdowns) };
  // Never spread a profile or aggregateAnalytics response here: login fields,
  // raw hands, target-only earnings, equity and curves are outside this public contract.
  // The separate versus block exposes only the viewer's own shared-hand aggregates.
  return { player: { id: player.id, name: player.name, avatar: player.avatar ?? 0, avatarImage: avatarImageId(player.avatarImage) },
    scope, roomCode, hands: hands.length, preflopHands, metrics, versus: versusStats(hands, viewerId, player.id) };
}
