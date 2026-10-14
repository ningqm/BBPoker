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
  return [['1/3池','third',1/3],['1/2池','half',.5],['2/3池','two-thirds',2/3],['满池','pot',1]].map(([label,id,fraction])=>{
    const amount=normalizeBetAmount(room,total+pot*fraction);
    return {id,label,amount,available:Number.isSafeInteger(amount)&&amount>=a.minRaiseTo&&amount<=a.maxRaiseTo};
  });
}

export function betActionLabel(room,amount) {
  if(amount===room?.actions?.maxRaiseTo)return 'All-in';
  return Number(room?.hand?.currentBet)>0?'加至':'下注';
}

// Presets are selections, not amounts: rounding or a short stack may give two
// presets the same amount without making both of them the chosen control.
export function betSelection(room,amount,preset=null) {
  const value=normalizeBetAmount(room,amount),option=betPresetOptions(room).find(p=>p.id===preset);
  return {amount:value,preset:option?.available&&option.amount===value?option.id:null};
}

export function betTurnKey(room) {
  if(!room?.actions?.canAct||room.hand?.status!=='playing'||room.hand?.transition||room.hand?.runout?.active)return null;
  return [room.code,room.hand.id,room.hand.actionSeq,room.hand.actingId].join(':');
}

export function syncBetControls(room,current={}) {
  const key=betTurnKey(room),same=Boolean(key&&key===current.key);
  const selected=betSelection(room,same?current.amount:room?.actions?.minRaiseTo,same?current.preset:null);
  return {...selected,key,panelOpen:Boolean(same&&room.actions.canRaise&&current.panelOpen)};
}

export function betSliderKeyPosition(key,position) {
  const current=Math.max(0,Math.min(1000,Number(position)||0));
  const next={ArrowUp:current+10,ArrowRight:current+10,ArrowDown:current-10,ArrowLeft:current-10,PageUp:current+100,PageDown:current-100,Home:0,End:1000}[key];
  return next===undefined?null:Math.max(0,Math.min(1000,next));
}

export function betActionEnabled(room,action) {
  const a=room?.actions||{};
  if(room?.status==='closed'||room?.hand?.status!=='playing'||room?.hand?.transition||!a.canAct)return false;
  return Boolean(({fold:a.canFold,check:a.canCheck,call:!a.canCheck&&Number(a.callAmount)>0,raise:a.canRaise,allin:a.canAllIn,timebank:a.canUseTimeBank,'raise-preset':a.canRaise,'toggle-raise-panel':a.canRaise})[action]);
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
