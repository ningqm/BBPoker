// Optional real-browser geometry regression. Run with PLAYWRIGHT_MODULE pointing
// to an installed Playwright module; it uses only in-memory local fixtures.
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import vm from 'node:vm';
import * as scene from '../public/table-scene.js';
import * as lifecycle from '../public/lifecycle.js';
import * as statsUI from '../public/stats.js';
import {createRoomClock} from '../public/room-clock.js';
import {renderHandCategory} from '../public/hand-category.js';
import {formatChips, getDisplayUnit, setDisplayUnit} from '../public/money.js';
import {revealOptions, betActionEnabled} from '../public/table-controls.js';
const playwright = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(playwright ? pathToFileURL(resolve(playwright)).href : 'playwright');
const root = fileURLToPath(new URL('../public/', import.meta.url));
const source = readFileSync(join(root, 'app.js'), 'utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)+start.length));
const c = vm.createContext({...scene,lifecycle,statsUI,renderHandCategory,formatChips,getDisplayUnit,revealOptions,betActionEnabled,Date,
 state:{clock:createRoomClock(),connected:true,connection:'已连接',animations:false,fun:false,chatUnread:0},
 avatar:()=>'<span class="avatar">🐼</span>',reactionBubble:()=>'',formatAction:a=>a.type||a,streetNames:{river:'河牌'},
 autoDealText:()=>'',actionArea:()=>'<div class="action-dock"><div class="decision"><div class="turn-row">等待行动</div><div class="raise-shortcuts"><button>1/3池</button><button>1/2池</button><button>2/3池</button><button>满池</button><button>自定义</button></div><div class="action-buttons"><button>弃牌</button><button>过牌 / 跟注</button></div></div></div>',chatPanel:()=>'',errorPage:()=>''});
vm.runInContext([section('const esc=','const fmtDate='),section('const btn=','const avatar='),section('const card=','const feedback='),section('function boardCard(','async function playerStatsModal('),section('const layouts=','function boardCard('),section('function tableCenter(','function seatActions('),section('function roomView(){','function tableInfoModal('),section('function miniPanel(','function autoDealText('),section('function roomClock(','function tick('),'globalThis.client={state,roomView};'].join('\n'),c);
const styles=['style','table-fun','table-interactions','lobby','hand-records','hand-overview','money','table-scene','table-controls'].map(x=>readFileSync(join(root,x+'.css'),'utf8')).join('\n');
function fixture(actor, count=9, name='玩家昵称123', wide=false,phase='thinking') {
 const room={code:'local-layout',name:'九人桌 · 身份与倒计时',status:'playing',hostId:'p0',meId:'p0',endsAt:Date.now()+600000,deadline:Date.now()+(phase==='extended'?155000:13000),
 settings:{maxPlayers:count,smallBlind:5,bigBlind:10,durationMinutes:60,squid:true,squidMode:'unlimited',squidUnit:20,squidUnitBB:2,squidExtraTokens:3,bombPot:true,bombAnte:30,bombAnteBB:3,bombIntervalMinutes:10,timeBankCards:6},
 players:Array.from({length:count},(_,i)=>({id:'p'+i,name:i===0?'自己':name,seat:i,stack:wide?1234500:2000,connected:true,inHand:true,allIn:false,cards:i?[null,null]:['As','Kd'],squidCount:i===actor?12:0,handCategory:i===0?'一对':null})),
 mini:{squid:{active:true,mode:'unlimited',participants:Array.from({length:count},(_,i)=>'p'+i),counts:{['p'+actor]:12},tokenBudget:20}},
 actions:{canAct:actor===0,canUseTimeBank:actor===0,timeBankCards:6},hand:{id:'h',number:2,status:'playing',street:'river',actingId:'p'+actor,buttonSeat:actor,smallBlindSeat:count===2?actor:(actor+1)%count,bigBlindSeat:count===2?(actor+1)%count:(actor+2)%count,actionReadyAt:Date.now()+(phase==='preparing'?900:-7000),turnStartedAt:Date.now()-7000,board:['Ac','Kh','2d','6s','9h'],pot:995,bombPot:false,squidRound:1}};
 c.client.state.room=room;return c.client.roomView();
}
const header='<header class="topbar table-topbar"><div class="brand"><strong>BBPoker</strong></div><button class="profile-btn">🐼</button></header>';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
const report=[];
try {
 const page=await browser.newPage();
 for(const [width,height] of [[320,568],[320,844],[360,640],[390,844],[412,915],[430,932],[768,1024],[1024,768],[1440,900],[844,390],[1024,600]]) {
  await page.setViewportSize({width,height});
  for(const count of [2,5,9]) for(let actor=1;actor<count;actor++) for(const phase of ['thinking','extended','preparing']) {
   const wide=actor===7;setDisplayUnit(wide?'points':'bb');
   await page.setContent(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><body class="at-table"><div id="app">${header}${fixture(actor,count,'玩家昵称123',wide,phase)}</div></body></html>`);
   const result=await page.evaluate(actor=>{
    const seat=document.querySelector(`[data-player-id="p${actor}"]`),main=seat.querySelector('.seat-main'),timer=seat.querySelector('.seat-turn'),name=seat.querySelector('.name'),stack=seat.querySelector('.stack-value'),fish=seat.querySelector('.squid-count');
    const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.5;
    const r=rect(timer),m=rect(main),n=rect(name),s=rect(stack),f=rect(fish),t=rect(timer.querySelector('b'));
    return {width:innerWidth,height:innerHeight,actor,stage:rect(document.querySelector('.table-stage')),main:m,timer:r,name:n,stack:s,fish:f,
     textInside:t.x>=r.x-.5&&t.right<=r.right+.5,inside:r.x>=m.x-.5&&r.right<=m.right+.5&&r.y>=m.y-.5&&r.bottom<=m.bottom+.5,nameVisible:getComputedStyle(name).visibility!=='hidden',
     overlapsName:overlap(r,n),overlapsStack:overlap(r,s),fishInside:f.x>=m.x-.5&&f.right<=m.right+.5&&f.y>=m.y-.5&&f.bottom<=m.bottom+.5,fishOverlapsTimer:overlap(f,r),fishOverlapsName:overlap(f,n),fishOverlapsStack:overlap(f,s),
     overlapsCards:[...document.querySelectorAll('.hole-cards,.board')].some(el=>overlap(r,rect(el))),
     fishOverlapsCards:[...document.querySelectorAll('.hole-cards,.board')].some(el=>overlap(f,rect(el))),
     markers:[...document.querySelectorAll('.seat-label .dealer-button,.seat-label .blind')].map(el=>({text:el.textContent,...rect(el)})),pageOverflow:document.documentElement.scrollHeight>innerHeight+1};
   },actor);
   report.push(result);const tag=`${width}×${height} ${count} players seat ${actor} ${phase}`;
   assert.ok(result.inside,tag+': timer inside identity');assert.ok(result.textInside,tag+': countdown text inside timer');assert.ok(result.nameVisible,tag+': name visible');assert.ok(result.name.width>=20,tag+': readable name area');
   assert.equal(result.overlapsName,false,tag+': clock avoids name');assert.equal(result.overlapsStack,false,tag+': clock avoids stack');assert.equal(result.overlapsCards,false,tag+': clock avoids every card');
   assert.ok(result.fishInside,tag+': fish inside reserved footer');assert.equal(result.fishOverlapsTimer||result.fishOverlapsName||result.fishOverlapsStack,false,tag+': fish avoids identity content');assert.equal(result.fishOverlapsCards,false,tag+': fish avoids every card');assert.equal(result.pageOverflow,false,tag+': table remains one screen');for(const marker of result.markers)assert.ok(marker.x>=-.5&&marker.right<=width+.5,tag+': '+marker.text+' stays inside viewport '+JSON.stringify(marker));
   if(process.env.LAYOUT_SCREENSHOTS&&actor===2&&count===9&&phase==='thinking'){mkdirSync(process.env.LAYOUT_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.LAYOUT_SCREENSHOTS,`seat-clock-${width}x${height}.png`)});}
  }
 }
 console.log(`PASS ${report.length} live CSS geometry cases: opponent timers, readable identities, fish counters and one-screen layout`);
 if(process.env.LAYOUT_REPORT)writeFileSync(process.env.LAYOUT_REPORT,JSON.stringify(report,null,2));
} finally {await browser.close();}
