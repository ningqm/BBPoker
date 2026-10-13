// Amounts stay in integer points, regardless of the viewer's display unit.
export function betPresetOptions(room) {
  const a=room?.actions||{},me=room?.players?.find(p=>p.id===room.meId);
  if(!a.canRaise)return [];
  const call=Number(a.callAmount)||0,total=(Number(me?.bet)||0)+call,pot=(Number(room.hand?.pot)||0)+call;
  return [['最小','min',null],['1/3池','third',1/3],['1/2池','half',.5],['2/3池','two-thirds',2/3],['满池','pot',1],['1.2倍池','over',1.2],['全下','all',null]].map(([label,id,fraction])=>{
    const amount=id==='min'?a.minRaiseTo:id==='all'?a.maxRaiseTo:total+Math.floor(pot*fraction);
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
