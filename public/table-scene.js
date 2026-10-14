// Presentation helpers consume only the public room snapshot.
export const SEAT_LAYOUTS = {
  2:[[50,94],[50,7]],3:[[50,94],[12,27],[88,27]],4:[[50,94],[7,50],[50,7],[93,50]],
  5:[[50,94],[7,68],[28,7],[72,7],[93,68]],6:[[50,94],[7,72],[7,29],[50,7],[93,29],[93,72]],
  7:[[50,94],[8,76],[7,41],[30,7],[70,7],[93,41],[92,76]],
  8:[[50,94],[8,76],[7,50],[10,25],[50,7],[90,25],[93,50],[92,76]],
  9:[[50,94],[8,76],[7,50],[10,26],[34,7],[66,7],[90,26],[93,50],[92,76]],
};
export function seatPlacement(room,index){
 const mine=room.players.find(p=>p.id===room.meId),n=room.settings.maxPlayers;
 const relative=(index-(mine?.seat??0)+n)%n,[x,y]=(SEAT_LAYOUTS[n]||SEAT_LAYOUTS[9])[relative];
 return {relative,x,y,side:x<30?'left':x>70?'right':'center',edge:y<15?'top':y>85?'bottom':x<50?'left':'right'};
}
// Current-street chips remain beside a player's seat. Once an All-in has
// moved into the pot, retain its marker without showing that amount twice.
export function seatCommitment(room,player){
 if(room?.hand?.status!=='playing'||!player?.inHand)return null;
 const bet=Number(player.bet),paid=Number(player.contributed),amount=Number.isSafeInteger(bet)&&bet>0?bet:null;
 const contributed=Number.isSafeInteger(paid)&&paid>0?paid:amount??0;
 const allIn=Boolean(player.allIn&&!player.folded);
 return amount!==null||allIn&&contributed>0?{amount,allIn,contributed}:null;
}
export function chipPots(hand){
 if(!hand)return [];
 const pots=hand.status==='complete'?hand.result?.pots:hand.pots;
 const values=[];
 for(const p of pots||[]){if(!Number.isFinite(p.amount)||p.amount<=0)continue;const key=[...(p.eligibleIds||[])].sort().join(',');const prior=values.at(-1);if(prior&&prior._key===key)prior.amount+=p.amount;else values.push({...p,amount:p.amount,_key:key});}
 if(!values.length)return Number(hand.pot)>0?[{label:'底池',amount:hand.pot,index:0}]:[];
 return values.map((p,index)=>({...p,index,label:index===0?'主池':`边池 ${index}`}));
}
export function payoutAwards(hand){
 if(hand?.status!=='complete')return [];
 return Object.entries(hand.result?.payouts||{}).filter(([,amount])=>Number.isFinite(amount)&&amount>0).map(([playerId,amount])=>({playerId,amount}));
}
export function liveReactions(previous,room,{now=Date.now(),live=true,visible=true,reconnected=false,muted=false}={}){
 if(!live||!visible||reconnected||muted||previous?.code!==room?.code||previous?.meId!==room?.meId)return [];
 const old=new Set((previous.chat||[]).map(m=>m.id));
 return (room.chat||[]).filter(m=>!old.has(m.id)&&['text','emote'].includes(m.kind)&&Number.isFinite(Date.parse(m.at))&&now-Date.parse(m.at)>=-2000&&now-Date.parse(m.at)<8000).map(m=>({...m,until:Date.now()+8000}));
}
export function actorClock(room,now=Date.now()){
 const hand=room?.hand,deadline=typeof room?.deadline==='number'?room.deadline:Date.parse(room?.deadline);
 if(hand?.status!=='playing'||hand.transition||!hand.actingId||!Number.isFinite(deadline))return null;
 const ready=Number(hand.actionReadyAt)||0,start=Number(hand.turnStartedAt)||deadline-Number(room.settings.actionSeconds||20)*1000;
 const waiting=now<ready,remaining=Math.max(0,Math.ceil((deadline-Math.max(now,ready))/1000));
 return {playerId:hand.actingId,waiting,remaining,ratio:Math.min(1,Math.max(0,(deadline-Math.max(now,ready))/Math.max(1,deadline-start))),urgent:!waiting&&remaining<=7};
}
// The animation represents the actual payout (including side pots), once only.
// Mounts resume by age across unrelated chat renders and never replay on reconnect.
export function mountPotAwards(stage,motion,{now=Date.now(),enabled=true}={}){
 if(!stage)return;stage.querySelector('.pot-flight-layer')?.remove();
 if(!enabled||!motion||now-motion.at>=1400)return;
 const rect=stage.getBoundingClientRect(),origin=stage.querySelector('.pot-cluster')?.getBoundingClientRect();
 if(!origin)return;
 const layer=stage.ownerDocument.createElement('div');layer.className='pot-flight-layer';layer.setAttribute('aria-hidden','true');
 for(const [index,award] of motion.awards.entries()){
  const seat=[...stage.querySelectorAll('.seat[data-player-id]')].find(el=>el.dataset.playerId===award.playerId);
  if(!seat)continue;const dest=seat.getBoundingClientRect();
  const icon=stage.ownerDocument.createElement('span');icon.className='pot-flight';
  icon.style.cssText=`left:${origin.x+origin.width/2-rect.x}px;top:${origin.y+origin.height/2-rect.y}px;--award-x:${dest.x+dest.width/2-origin.x-origin.width/2}px;--award-y:${dest.y+dest.height/2-origin.y-origin.height/2}px;animation-delay:${index*70-(now-motion.at)}ms`;
  for(let i=0;i<3;i++){const chip=stage.ownerDocument.createElement('i');icon.append(chip);}layer.append(icon);
 }
 stage.append(layer);
}
// Prefer free felt space; never put chat over hole cards, action timer or board.
export function layoutTableBubbles(stage){
 if(!stage)return;const outer=stage.getBoundingClientRect(),reserved=[...stage.querySelectorAll('.seat-main,.hole-cards,.seat-label,.seat-turn,.seat-time-tools,.seat-hand-info,.bet-chip,.table-config,.pot-cluster,.board,.result-title,.result-countdown')].map(el=>el.getBoundingClientRect());
 for(const bubble of stage.querySelectorAll('.seat-reaction')){
  const seat=bubble.closest('.seat'),anchor=seat.getBoundingClientRect(),r=bubble.getBoundingClientRect(),w=r.width,h=r.height;
  const sx=anchor.x+anchor.width/2-outer.x,sy=anchor.y+anchor.height/2-outer.y,side=seat.dataset.side;
  const inward=side==='left'?sx+anchor.width/2+12:side==='right'?sx-anchor.width/2-w-12:sx-w/2;
  const candidates=[[inward,sy-h/2],[inward,sy+32],[inward,sy-h-32],[sx-w/2,sy+anchor.height/2+20],[sx-w/2,sy-anchor.height/2-h-62]];
  let best=null;
  for(let y=8;y+h<outer.height-8;y+=12)for(const x of [8,outer.width/4-w/2,outer.width/2-w/2,outer.width*3/4-w/2,outer.width-w-8])candidates.push([x,y]);
  for(const [cx,cy] of candidates){const x=Math.min(outer.width-w-2,Math.max(2,cx)),y=Math.min(outer.height-h-2,Math.max(2,cy));const box={left:x+outer.x,right:x+outer.x+w,top:y+outer.y,bottom:y+outer.y+h};const overlap=reserved.reduce((sum,o)=>sum+Math.max(0,Math.min(box.right,o.right+3)-Math.max(box.left,o.left-3))*Math.max(0,Math.min(box.bottom,o.bottom+3)-Math.max(box.top,o.top-3)),0);const score=overlap*100+Math.hypot(x+w/2-sx,y+h/2-sy);if(!best||score<best.score)best={x,y,box,score};}
  if(best){bubble.style.left=`${best.x-(anchor.x-outer.x)}px`;bubble.style.top=`${best.y-(anchor.y-outer.y)}px`;reserved.push(best.box);}
 }
}
