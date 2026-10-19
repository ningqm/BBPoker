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
// Keep the current street's amounts while players can still respond. Once
// betting locks for a runout/showdown, the central pots carry those chips;
// All-in remains on the player's zero-stack row instead of another wager.
export function seatCommitment(room,player){
 const hand=room?.hand;
 if(hand?.status!=='playing'||!player?.inHand||hand.runout?.active||hand.transition?.kind==='showdown')return null;
 const bet=Number(player.bet),paid=Number(player.contributed);
 if(!Number.isSafeInteger(bet)||bet<=0)return null;
 const contributed=Number.isSafeInteger(paid)&&paid>0?paid:bet;
 return {amount:bet,allIn:Boolean(player.allIn&&!player.folded),contributed};
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
 if(hand?.status!=='playing'||hand.transition||hand.runout?.active||!hand.actingId||!Number.isFinite(deadline))return null;
 const ready=Number(hand.actionReadyAt)||0,start=Number(hand.turnStartedAt)||deadline-Number(room.settings.actionSeconds||20)*1000;
 // The first actor is named before the deal/reveal finishes. A local clock
 // reaching readyAt is not permission to act: keep their cue in preparation
 // until the authoritative ready snapshot enables the same turn's controls.
 const awaitingReady=hand.actingId===room.meId&&room.actions?.turnAvailable===true&&room.actions.canAct===false;
 const waiting=now<ready||awaitingReady,remaining=Math.max(0,Math.ceil((deadline-Math.max(now,ready))/1000));
 return {playerId:hand.actingId,waiting,remaining,ratio:Math.min(1,Math.max(0,(deadline-Math.max(now,ready))/Math.max(1,deadline-start))),urgent:!waiting&&remaining<=7};
}
// One route per paid player includes all of their main/side-pot awards. Refunds
// are not awards. Rebuilds resume by age, so chat and countdown renders cannot
// replay a collection. Seat styling remains after the short motion finishes.
export const POT_AWARD_DURATION=3300;
export function mountPotAwards(stage,motion,{now=Date.now(),enabled=true}={}){
 if(!stage)return;stage.querySelector('.pot-flight-layer')?.remove();
 const age=now-Number(motion?.at);
 if(!enabled||!motion||!Number.isFinite(age)||age<0||age>=POT_AWARD_DURATION)return;
 const rect=stage.getBoundingClientRect(),origin=(stage.querySelector('.pot-total')||stage.querySelector('.pot-cluster'))?.getBoundingClientRect();
 if(!origin)return;
 const layer=stage.ownerDocument.createElement('div');layer.className='pot-flight-layer';layer.setAttribute('aria-hidden','true');
 const seats=[...stage.querySelectorAll('.seat[data-player-id]')];
 for(const [index,award] of (motion.awards||[]).entries()){
  if(!Number.isFinite(award.amount)||award.amount<=0)continue;
  const seat=seats.find(el=>el.dataset.playerId===award.playerId);if(!seat)continue;
  const dest=(seat.querySelector('.seat-main')||seat).getBoundingClientRect();
  const group=stage.ownerDocument.createElement('div');group.className='pot-award';group.dataset.playerId=award.playerId;
  // Three compact stacks make the transfer readable without a banner covering
  // cards or a second amount competing with the player's existing receipt.
  for(let packet=0;packet<3;packet++){
   const icon=stage.ownerDocument.createElement('span');icon.className='pot-flight';
   const ox=origin.x+origin.width/2+(packet-1)*8,oy=origin.y+origin.height/2-packet*3;
   icon.style.cssText=`left:${ox-rect.x}px;top:${oy-rect.y}px;--award-x:${dest.x+dest.width/2-ox}px;--award-y:${dest.y+dest.height/2-oy}px;animation-delay:${index*60+packet*130-age}ms`;
   for(let i=0;i<3;i++){const chip=stage.ownerDocument.createElement('i');icon.append(chip);}group.append(icon);
  }
  // The pulse is only an outline. It never scales/repositions the player's
  // cards, name, stack or controls, even on a nine-seat narrow-screen table.
  const ring=stage.ownerDocument.createElement('span');ring.className='pot-arrival-ring';
  ring.style.cssText=`left:${dest.x-rect.x-3}px;top:${dest.y-rect.y-3}px;width:${dest.width+6}px;height:${dest.height+6}px;animation-delay:${index*60+800-age}ms`;
  group.append(ring);layer.append(group);
 }
 if(layer.children.length)stage.append(layer);
}
// Place each wager in nearby open felt. Identity panels, cards, clocks, pot and
// settings are obstacles: a bet must not cover information from another player.
// The pure rectangle planner is shared by rendering and geometry regression tests.
export function planWagerPositions({width,height,wagers,reserved=[],gap=4}){
 const placed=[],obstacles=reserved.filter(r=>r.width>0&&r.height>0).map(r=>({...r}));
 const overlap=(a,b)=>a.x<b.x+b.width+gap&&a.x+a.width>b.x-gap&&a.y<b.y+b.height+gap&&a.y+a.height>b.y-gap;
 for(const wager of wagers){
  const w=wager.width,h=wager.height,anchor=wager.anchor,preferred=wager.preferred;
  const minX=2,maxX=Math.max(2,width-w-2),minY=2,maxY=Math.max(2,height-h-2);
  const side=wager.side,edge=wager.edge,sideLimit=Math.max(65,height*.1),columnLimit=Math.max(68,width*.2);
  const validX=x=>side==='left'?x+w/2>=anchor.x&&x+w<=width/2-gap/2:side==='right'?x+w/2<=anchor.x&&x>=width/2+gap/2:side!=='center'||Math.abs(x+w/2-anchor.x)<=columnLimit;
  const validY=y=>(!['left','right'].includes(side)||Math.abs(y+h/2-anchor.y)<=sideLimit)&&(edge!=='top'||y+h/2>=anchor.y&&y+h/2<=height*.45)&&(edge!=='bottom'||y+h/2<=anchor.y&&y+h/2>=height*.62);
  let best=null;
  const consider=(x,y)=>{
   const distance=Math.hypot(x-preferred.x,y-preferred.y);
   if(best&&distance>=best.score)return;
   const score=distance+Math.hypot(x+w/2-anchor.x,y+h/2-anchor.y)*.3;
   if(best&&score>=best.score)return;
   const box={x,y,width:w,height:h};
   if(obstacles.some(r=>overlap(box,r)))return;
   best={...box,score};
  };
  const px=Math.max(minX,Math.min(maxX,preferred.x)),py=Math.max(minY,Math.min(maxY,preferred.y));
  if(validX(px)&&validY(py))consider(px,py);
  // A free preferred slot is already optimal: moving by d costs d while the
  // anchor-distance term can improve by at most 0.3d. Do not allocate/search
  // thousands of grid candidates for every normal blind or action update.
  if(!best||px!==preferred.x||py!==preferred.y){
   const xs=new Set([minX,maxX,preferred.x]),ys=new Set([minY,maxY,preferred.y]);
   for(const r of obstacles){xs.add(r.x-w-gap);xs.add(r.x+r.width+gap);ys.add(r.y-h-gap);ys.add(r.y+r.height+gap);}
   for(let y=minY;y<=maxY;y+=8)ys.add(y);for(let x=minX;x<=maxX;x+=8)xs.add(x);
   // Restrict each axis before combining it. Nearest candidates establish a
   // good bound early; farther candidates cannot beat it, even before overlap
   // tests. The complete former grid is still available in genuinely crowded
   // layouts, with identical seat-half and anchor-distance ownership rules.
   const axis=(values,min,max,valid,origin)=>[...new Set([...values].map(v=>Math.max(min,Math.min(max,v))))].filter(valid).sort((a,b)=>Math.abs(a-origin)-Math.abs(b-origin)||a-b);
   const xValues=axis(xs,minX,maxX,validX,preferred.x),yValues=axis(ys,minY,maxY,validY,preferred.y);
   for(const y of yValues){
    const dy=Math.abs(y-preferred.y);if(best&&dy>=best.score)break;
    for(const x of xValues){if(best&&Math.hypot(x-preferred.x,dy)>=best.score)break;consider(x,y);}
   }
  }
  // Do not hide a wager if a third-party zoom or unusually long value leaves
  // no free rectangle. Keep its original position; all normal widths are tested.
  const box=best||{...preferred,width:w,height:h};
  placed.push({id:wager.id,...box,clear:Boolean(best)});obstacles.push(box);
 }
 return placed;
}
let lastWagerPlan=null;
export function layoutTableWagers(stage){
 if(!stage)return;
 const nodes=[...stage.querySelectorAll('.bet-chip')].filter(node=>node.closest('.seat'));
 // Nothing to position between streets or during a locked runout. Avoid
 // forcing layout of every seat/card merely to produce an empty plan.
 if(!nodes.length)return;
 const outer=stage.getBoundingClientRect();if(!outer.width||!outer.height)return;
 const rect=el=>{const r=el.getBoundingClientRect();return{x:r.left-outer.left,y:r.top-outer.top,width:r.width,height:r.height};};
 const selectors='.seat-main,.hole-cards,.seat-label,.seat-turn,.seat-time-tools,.seat-hand-info,.table-config-primary,.table-config .game-mode,.table-config .squid-mode-note,.pot-total,.pot-breakdown,.board,.table-idle,.result-title,.result-countdown,.equity-runout,.rabbit-note,.street-label';
 const reserved=[...stage.querySelectorAll(selectors)].map(rect);
 // Read original CSS anchors on every render/resize, never the previous correction.
 const animations=nodes.map(node=>node.style.animation);
 for(const node of nodes){node.style.animation='none';node.style.removeProperty('left');node.style.removeProperty('right');node.style.removeProperty('top');node.style.removeProperty('bottom');node.style.removeProperty('transform');}
 const seatRects=nodes.map(node=>rect(node.closest('.seat')));
 const wagers=nodes.map((node,id)=>{const seat=node.closest('.seat'),a=seatRects[id],r=rect(node);return{id,width:r.width,height:r.height,preferred:{x:r.x,y:r.y},anchor:{x:a.x+a.width/2,y:a.y+a.height/2},side:seat.dataset.side,edge:seat.dataset.edge};});
 // Hero and the two top seats have the narrowest inward lanes.
 wagers.sort((a,b)=>(a.edge==='bottom'?0:a.edge==='top'?1:2)-(b.edge==='bottom'?0:b.edge==='top'?1:2)||a.anchor.y-b.anchor.y);
 const geometry={width:outer.width,height:outer.height,wagers,reserved},key=JSON.stringify(geometry);
 // A bounded, geometry-only cache also survives table DOM replacement. It
 // contains no room/player data; changed chips, cards, timers or viewport
 // produce a new key immediately.
 if(lastWagerPlan?.key!==key)lastWagerPlan={key,positions:planWagerPositions(geometry)};
 for(const p of lastWagerPlan.positions){
  const node=nodes[p.id],seat=seatRects[p.id];
  Object.assign(node.style,{left:`${p.x-seat.x}px`,right:'auto',top:`${p.y-seat.y}px`,bottom:'auto',transform:'none',animation:animations[p.id]});node.dataset.wagerLayout=p.clear?'clear':'crowded';
 }
}
let observedTable=null,tableResizeObserver=null;
// Prefer free felt space; never put chat over hole cards, action timer or board.
export function layoutTableBubbles(stage){
 if(!stage)return;
 const nodes=[...stage.querySelectorAll('.seat-reaction')];
 const hasWagers=[...stage.querySelectorAll('.bet-chip')].some(node=>node.closest('.seat'));
 if(!nodes.length&&!hasWagers){tableResizeObserver?.disconnect();observedTable=null;tableResizeObserver=null;return;}
 if(typeof ResizeObserver==='function'&&observedTable!==stage){
  tableResizeObserver?.disconnect();observedTable=stage;let size=stage.getBoundingClientRect();
  const observer=new ResizeObserver(()=>{
   if(!stage.isConnected){observer.disconnect();return;}
   const next=stage.getBoundingClientRect();
   // observe() immediately reports the dimensions we have already laid out.
   // Avoid planning and DOM writes twice when an actor/SSE render mounts a table.
   if(next.width===size.width&&next.height===size.height)return;
   size=next;layoutTableBubbles(stage);
  });tableResizeObserver=observer;observer.observe(stage);
 }
 layoutTableWagers(stage);
 // The usual action update has no chat bubble. Wagers have already been
 // placed, so do not measure the complete table for an empty bubble list.
 if(!nodes.length)return;
 const outer=stage.getBoundingClientRect(),reserved=[...stage.querySelectorAll('.seat-main,.hole-cards,.seat-label,.seat-turn,.seat-time-tools,.seat-hand-info,.bet-chip,.table-config-primary,.table-config .game-mode,.table-config .squid-mode-note,.pot-total,.pot-breakdown,.board,.result-title,.result-countdown,.equity-runout,.rabbit-note,.street-label,.table-idle')].map(el=>el.getBoundingClientRect());
 // Measure each new/full-size bubble first. A prior crowded frame may have
 // compacted or hidden it, but a later roomy frame should restore normal chat.
 for(const bubble of nodes){bubble.dataset.bubbleLayout='normal';bubble.style.visibility='hidden';}
 const bubbles=nodes.map(bubble=>({bubble,anchor:bubble.closest('.seat').getBoundingClientRect(),r:bubble.getBoundingClientRect(),side:bubble.closest('.seat').dataset.side}));
 for(const {bubble,anchor,r,side} of bubbles){
  let best=findBubbleSpace(outer,anchor,r,side,reserved);
  if(!best){
   // Keep the sender and a short one-line message if that fits. Read the actual
   // compact CSS dimensions; do not assume a font/zoom-dependent box will fit.
   bubble.dataset.bubbleLayout='compact';
   best=findBubbleSpace(outer,anchor,bubble.getBoundingClientRect(),side,reserved);
  }
  if(best){
   bubble.style.left=`${best.x-(anchor.x-outer.x)}px`;bubble.style.top=`${best.y-(anchor.y-outer.y)}px`;
   bubble.style.visibility='';bubble.setAttribute('aria-hidden','false');reserved.push(best.box);
  }else{
   // All-in/side-pot layouts can exhaust the felt. Never cover a wager, card,
   // clock or another message just to show the decorative table copy. The full
   // message remains available in the chat drawer and is not removed or changed.
   bubble.dataset.bubbleLayout='hidden';bubble.setAttribute('aria-hidden','true');
  }
 }
}
function findBubbleSpace(outer,anchor,size,side,reserved){
 const w=size.width,h=size.height;
 if(w<=0||h<=0||w>outer.width-4||h>outer.height-4)return null;
 const sx=anchor.x+anchor.width/2-outer.x,sy=anchor.y+anchor.height/2-outer.y;
 const inward=side==='left'?sx+anchor.width/2+12:side==='right'?sx-anchor.width/2-w-12:sx-w/2;
 const candidates=[[inward,sy-h/2],[inward,sy+32],[inward,sy-h-32],[sx-w/2,sy+anchor.height/2+20],[sx-w/2,sy-anchor.height/2-h-62]];
 for(let y=8;y+h<outer.height-8;y+=12)for(const x of [8,outer.width/4-w/2,outer.width/2-w/2,outer.width*3/4-w/2,outer.width-w-8])candidates.push([x,y]);
 let best=null;
 for(const [cx,cy] of candidates){
  const x=Math.min(outer.width-w-2,Math.max(2,cx)),y=Math.min(outer.height-h-2,Math.max(2,cy));
  const score=Math.hypot(x+w/2-sx,y+h/2-sy);if(best&&score>=best.score)continue;
  const box={left:x+outer.x,right:x+outer.x+w,top:y+outer.y,bottom:y+outer.y+h};
  if(reserved.some(o=>o.width!==0&&o.height!==0&&box.left<o.right+3&&box.right>o.left-3&&box.top<o.bottom+3&&box.bottom>o.top-3))continue;
  best={x,y,box,score};
 }
 return best;
}
