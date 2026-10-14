import {raiseFromSlider,sliderFromRaise} from './table-feedback.js';

// Amounts stay in integer points, regardless of the viewer's display unit.
// Ordinary bet totals use full big blinds; only an exact all-in may retain a
// fraction of a blind. Calling and the posted small blind are not changed.
export function betAmountBounds(room) {
  const a=room?.actions||{},minimum=Number(a.minRaiseTo),maximum=Number(a.maxRaiseTo);
  const configuredBlind=Number(room?.settings?.bigBlind);
  const bigBlind=Number.isSafeInteger(configuredBlind)&&configuredBlind>0?configuredBlind:1;
  if(!a.canRaise||!Number.isSafeInteger(minimum)||!Number.isSafeInteger(maximum)||minimum<0||maximum<minimum||maximum<=0)return null;
  return {minimum:Math.min(maximum,Math.max(bigBlind,Math.ceil(minimum/bigBlind)*bigBlind)),maximum,bigBlind};
}

export function normalizeBetAmount(room,amount) {
  const bounds=betAmountBounds(room);
  if(!bounds)return 0;
  const {minimum,maximum,bigBlind}=bounds,value=Number(amount);
  if(!Number.isFinite(value))return minimum;
  if(value>=maximum)return maximum;
  return Math.max(minimum,Math.min(maximum,Math.round(value/bigBlind)*bigBlind));
}

/** Preserve the nonlinear slider while snapping every ordinary selection to BB. */
export function betAmountFromSlider(room,position) {
  const bounds=betAmountBounds(room);
  if(!bounds)return 0;
  const {minimum,maximum,bigBlind}=bounds;
  return normalizeBetAmount(room,raiseFromSlider(position,minimum,maximum,bigBlind));
}

export function betSliderFromAmount(room,amount) {
  const bounds=betAmountBounds(room);
  if(!bounds)return 0;
  const {minimum,maximum,bigBlind}=bounds;
  return sliderFromRaise(normalizeBetAmount(room,amount),minimum,maximum,bigBlind);
}

export function betPresetOptions(room) {
  const a=room?.actions||{},me=room?.players?.find(p=>p.id===room.meId);
  if(!betAmountBounds(room))return [];
  const call=Number(a.callAmount)||0,total=(Number(me?.bet)||0)+call,pot=(Number(room.hand?.pot)||0)+call;
  return [['1/3池','third',1/3],['1/2池','half',.5],['2/3池','two-thirds',2/3],['满池','pot',1],['1.2倍池','over',1.2],['全下','all',null]].map(([label,id,fraction])=>{
    const amount=id==='all'?a.maxRaiseTo:normalizeBetAmount(room,total+pot*fraction);
    return {id,label,amount,available:Number.isSafeInteger(amount)&&amount>=a.minRaiseTo&&amount<=a.maxRaiseTo};
  });
}

export function betActionLabel(room,amount) {
  if(amount===room?.actions?.maxRaiseTo)return '全下至';
  return Number(room?.hand?.currentBet)>0?'加至':'下注';
}

export function revealOptions(room,player) {
  const own=player?.id===room?.meId,complete=room?.hand?.status==='complete';
  const shown=new Set(player?.shownIndices||[]);
  return (player?.cards||[]).map((value,index)=>({value,index,shown:shown.has(index),canReveal:Boolean(own&&complete&&player.inHand&&value&&!shown.has(index))}));
}

export function rebuyPrompt(room,now) {
  const grace=room?.autoDeal?.rebuyGrace;
  if(room?.status==='closed'||room?.hand?.status!=='complete'||grace?.handId!==room.hand.id||room.autoDeal.paused||!grace.pendingIds?.includes(room.meId))return null;
  const remaining=Math.max(0,Math.ceil((grace.endsAt-now)/1000));
  return {key:`${room.code}:${room.meId}:${grace.handId}`,remaining,active:now>=grace.startsAt&&remaining>0};
}
