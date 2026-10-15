import { SEAT_LAYOUTS, seatPlacement, seatCommitment, chipPots, payoutAwards, liveReactions, actorClock, mountPotAwards, layoutTableBubbles } from './table-scene.js';
import {THROWABLES,createTableFunTracker,mountFunEffects} from './table-fun.js';
import * as statsUI from './stats.js';
import { renderPlayerStats } from './player-stats.js';
import { renderHandCategory, updateHandCategoryMotion } from './hand-category.js';
import { createHistoryRefresh } from './history-refresh.js';
import { createTurnRecovery } from './turn-recovery.js';
import { createRoomClock, isOlderRoomSnapshot } from './room-clock.js';
import * as lifecycle from './lifecycle.js';
import { patchLobbyView } from './lobby-view.js';
import * as records from './records.js';
import { renderRoomResults } from './room-results.js';
import { renderHandOverview } from './hand-overview.js';
import { getDisplayUnit, setDisplayUnit, formatChips, chipInputValue, parseChipInput, unitLabel } from './money.js';
import { reusableRoomSettings } from './room-config.js';
import { createTableFeedback, createTableSounds, createTurnCountdown } from './table-feedback.js';
import { patchStableControls } from './stable-controls.js';
import { bindKeyboardViewport, bindTableViewport } from './visual-viewport.js';
import { betPresetOptions, betActionLabel, betTurnKey, betSubmission, normalizeBetAmount, betAmountFromSlider, betSliderFromAmount, betSelection, syncBetControls, betAmountFromKey, betActionEnabled, revealOptions, rebuyPrompt } from './table-controls.js';
import { historyBoard, replaySnapshot, replayStreets, createReplayPlayback, REPLAY_SPEEDS } from './replay.js';
import { avatarMarkup, avatarEditorMarkup, createAvatarEditor, createAvatarCache } from './avatar.js';
import { createRequestGuard, clientConfig, apiUrl, inviteUrl, parseInvite, readIdentity, writeIdentity, clearIdentity, canShare, shareInvitation, saveExport, bindNativeLifecycle } from './platform.js';
const requests=createRequestGuard();
const $=selector=>document.querySelector(selector);
const app=$('#app'),dialog=$('#dialog');
bindKeyboardViewport();
bindTableViewport();
const RECEIPT_KEY='tongzhuo.commitments.v1';
let receipts={};try{const saved=JSON.parse(localStorage.getItem(RECEIPT_KEY)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))receipts=saved;}catch{}
function rememberCommitment(hand){if(!hand?.id||!/^([a-f0-9]{64})$/.test(hand.commitment||''))return false;const previous=receipts[hand.id];if(previous)return previous!==hand.commitment;receipts[hand.id]=hand.commitment;const entries=Object.entries(receipts);if(entries.length>1000)receipts=Object.fromEntries(entries.slice(-1000));try{localStorage.setItem(RECEIPT_KEY,JSON.stringify(receipts));}catch{}return false;}
const defaults={maxPlayers:9,smallBlind:5,bigBlind:10,minBuyInBB:100,maxBuyInBB:1000,maxTotalBuyInBB:null,actionSeconds:20,squid:false,squidMode:'normal',squidExtraTokens:3,squidUnitBB:2,bombPot:false,bombIntervalMinutes:10,bombAnteBB:2,durationMinutes:60,timeBankCards:6,timeBankSeconds:30};
const state={clock:createRoomClock(),token:'',user:null,stats:null,statsView:{data:null,filters:statsUI.defaultStatsFilters(),room:'',loading:false,error:'',request:0},rooms:[],lobby:{rooms:[],filter:'all',loading:false,loaded:false,error:'',request:0,timer:null,controller:null,joining:'',limit:10},departureConfirmation:null,room:null,page:'loading',busy:false,pendingCommand:null,profileSave:null,stream:null,connected:false,connection:'连接中',raise:0,raisePreset:null,raisePanelOpen:false,raiseTurnKey:null,modal:null,activityOpen:false,commitmentMismatch:false,reconnectTimer:null,install:null,replayPlayback:null,revealed:new Set(),error:'',authMode:'login',pendingRecovery:null,chatOpen:false,chatDraft:'',chatBusy:false,chatPending:null,chatUnread:0,chatMuted:false,reactionsMuted:false,fun:true,funEffects:[],funTarget:'',throwUntil:0,boardMotion:null,handCategoryMotion:[],animations:true,sound:true,voice:true,revealMotion:null,feedbackResync:true,reactions:{},motion:null,composing:false,recordComposition:null,recordRenderDeferred:false,renderDeferred:false,sessions:{rows:[],nextCursor:null,totals:null,filters:{period:'all'},loading:false,error:'',request:0},sessionRequest:0,opponents:{data:null,opponentOptions:[],filters:{period:'all'},room:'',sort:'profit',loading:false,error:'',request:0},library:{hands:[],nextCursor:null,totals:null,opponents:null,opponentOptions:[],view:'hands',opponentSort:'hands',opponentSearch:'',viewContexts:{},opponentDrilldown:null,filters:{period:'all'},scope:'personal',favorites:false,room:'',loading:false,error:'',request:0},replaySpeed:1,replayRequest:0};
const pendingTableRequests=new Set();
const API_TIMEOUT_MS=15000;
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const num=value=>Number(value||0).toLocaleString('zh-CN');
const chips=(value,bb=state.room?.settings?.bigBlind,options={})=>formatChips(value,bb,options);
const signedChips=(value,bb=state.room?.settings?.bigBlind)=>chips(value,bb,{signed:true});
const profitClass=value=>Number(value)>0?'positive':Number(value)<0?'negative':'muted';
const fmtDate=value=>{const d=new Date(value);return Number.isNaN(+d)?'':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
const streetNames={preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',showdown:'摊牌',complete:'本手结束'};
const commandId=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('');
const btn=(label,action,cls='',attrs='')=>`<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const avatar=avatarMarkup;
const avatarCache=createAvatarCache({getToken:()=>state.token,getIdentity:()=>state.user?.id,url:apiUrl});
let profileEditor=null;
const card=(value,cls='',placeholder=false)=>{if(!value)return `<span class="card ${placeholder?'placeholder':'face-down'} ${cls}" aria-label="${placeholder?'尚未发出':'未公开的牌'}"></span>`;const rank=value.slice(0,-1).toUpperCase(),suit=value.slice(-1).toLowerCase(),symbol={s:'♠',h:'♥',d:'♦',c:'♣'}[suit]||suit;return `<span class="card ${suit==='h'||suit==='d'?'red':''} ${cls}" aria-label="${esc(symbol+(rank==='T'?'10':rank))}">${esc(rank==='T'?'10':rank)}<span>${esc(symbol)}</span></span>`;};
const cards=(values,cls='')=>(values||[]).map(v=>card(v,cls)).join('');
const feedback=createTableFeedback(),tableSounds=createTableSounds(),turnCountdown=createTurnCountdown(),funTracker=createTableFunTracker();
const historyRefresh=createHistoryRefresh({
  getContext:()=>['hand-overview','replay'].includes(state.modal?.kind)?state.replay:null,
  isVisible:()=>document.visibilityState!=='hidden',
  fetchHand:replay=>api(`/api/rooms/${encodeURIComponent(replay.hand.roomCode)}/hands/${encodeURIComponent(replay.hand.id)}`),
  apply:(replay,hand)=>{replay.hand=hand;const scroll=dialog.scrollTop;if(state.modal?.kind==='hand-overview')renderOverview();else if(state.modal?.kind==='replay')renderReplay();dialog.scrollTop=scroll;},
});
setDisplayUnit('bb');
try{const prefs=JSON.parse(localStorage.getItem('bbpoker.table.preferences')||'{}');if(prefs.displayUnit==='points')setDisplayUnit('points');state.sound=prefs.sound!==false;state.voice=prefs.voice!==false;state.animations=prefs.animations!==false;state.fun=prefs.fun!==false;}catch{}
tableSounds.setEnabled(state.sound);tableSounds.setVoiceEnabled(state.voice);document.documentElement.classList.toggle('no-motion',!state.animations);
function saveTablePreferences(){try{localStorage.setItem('bbpoker.table.preferences',JSON.stringify({sound:state.sound,voice:state.voice,animations:state.animations,fun:state.fun,displayUnit:getDisplayUnit()}));}catch{}}
function toast(text,error=false,{modal=state.modal}={}){
  const insideDialog=error&&dialog.open&&state.modal===modal;
  const host=insideDialog?dialog.querySelector('.modal-body'):$('#toasts');
  if(!host)return;
  const message=String(text),current=host.querySelector('.toast');
  if(current?.dataset.message===message&&current.classList.contains('error')===error)return;
  // One actionable notice, never a stack across the betting controls. Dialog
  // feedback must live inside the native top layer to remain visible.
  document.querySelectorAll('.toast').forEach(el=>{clearTimeout(el.noticeTimer);el.remove();});
  const el=document.createElement('div');el.className=`toast${error?' error':''}`;el.dataset.message=message;el.setAttribute('role',error?'alert':'status');
  const label=document.createElement('span');label.textContent=message;
  const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='toast-dismiss';dismiss.textContent='×';dismiss.setAttribute('aria-label','关闭提示');
  dismiss.addEventListener('click',()=>{clearTimeout(el.noticeTimer);el.remove();});
  el.append(label,dismiss);host.prepend(el);
  if(insideDialog)el.scrollIntoView?.({block:'nearest'});
  if(!insideDialog)el.noticeTimer=setTimeout(()=>el.remove(),error?6500:2800);
}
async function api(path,body,options={}){
  const guard=requests.capture(),token=options.anonymous?'':state.token;
  const {anonymous,...fetchOptions}=options;
  const controller=new AbortController(),tableCommand=body!==undefined&&/^\/api\/rooms\/[^/]+\/action$/.test(path);
  const abort=()=>controller.abort();
  if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,API_TIMEOUT_MS);
  if(tableCommand)pendingTableRequests.add(controller);
  try{
    const response=await fetch(apiUrl(path),{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),...fetchOptions,signal:controller.signal});
    guard.check();
    const data=await response.json().catch(error=>{if(controller.signal.aborted)throw error;return null;});guard.check();
    if(response.status===401&&token&&!/^\/api\/(account\/(login|register|recover|logout)$|session\/restore$)/.test(path))await expireIdentity(token);
    if(!response.ok){const e=new Error(data?.error||`请求暂时失败（${response.status}）`);e.status=response.status;throw e;}
    if(!data)throw new Error('服务器响应无法读取');return data;
  }catch(error){
    guard.check();
    if(controller.signal.aborted)throw Object.assign(new Error(tableCommand?'操作结果尚未确认，正在同步牌桌，请勿重复提交':'请求中断或超时，请稍后重试'),{resync:tableCommand});
    if(tableCommand&&!error.status)error.resync=true;
    throw error;
  }finally{
    clearTimeout(timer);pendingTableRequests.delete(controller);options.signal?.removeEventListener('abort',abort);
  }
}
function abortPendingTableRequests(){for(const controller of pendingTableRequests)controller.abort();}
function captureRoomChanges(previous,room){
  const live=state.page==='room',visible=document.visibilityState!=='hidden',resync=state.feedbackResync,clock=state.clock.now();
  const serverTime=typeof room.serverTime==='number'?room.serverTime:Date.parse(room.serverTime),freshSnapshot=!Number.isFinite(serverTime)||clock-serverTime<=5000;
  const effectsLive=live&&visible&&state.connected&&!resync&&freshSnapshot;
  const entertainment=funTracker.update(room,{live:live&&freshSnapshot&&state.connected,visible,reconnected:resync,now:clock});
  state.funEffects=effectsLive&&previous?.code===room.code?[...state.funEffects.filter(e=>clock-e.at<2000),...entertainment.effects].slice(-6):[];
  const beforeBoard=previous?.hand?.rabbit?.board||previous?.hand?.board||[],afterBoard=room.hand?.rabbit?.board||room.hand?.board||[];
  if(effectsLive&&previous?.hand?.id===room.hand?.id&&afterBoard.length>beforeBoard.length)state.boardMotion={handId:room.hand.id,from:beforeBoard.length,count:afterBoard.length,at:Date.now()};
  else if(previous?.hand?.id!==room.hand?.id||!effectsLive)state.boardMotion=null;
  state.handCategoryMotion=updateHandCategoryMotion(previous,room,state.handCategoryMotion,{live:effectsLive&&state.animations,now:Date.now()});
  const same=previous?.code===room.code;
  if(!same){state.chatDraft='';state.chatUnread=0;state.chatOpen=false;state.reactions={};state.chatBusy=false;state.chatPending=null;state.funTarget='';state.throwUntil=0;}
  const oldMessages=new Set((same?previous.chat||[]:room.chat||[]).map(m=>m.id));
  const fresh=(room.chat||[]).filter(m=>!oldMessages.has(m.id));
  if(same){for(const m of fresh)if(m.playerId!==room.meId&&!state.chatOpen&&!state.chatMuted)state.chatUnread=Math.min(99,state.chatUnread+1);}
  if(!effectsLive)state.reactions={};
  for(const message of liveReactions(previous,room,{now:clock,live:effectsLive,visible,reconnected:resync,muted:state.reactionsMuted}))state.reactions[message.playerId]=message;
  if(effectsLive&&same&&previous?.hand?.id===room.hand?.id&&previous.hand?.status!=='complete'&&room.hand?.status==='complete')state.potMotion={handId:room.hand.id,at:Date.now(),awards:payoutAwards(room.hand)};
  else if(!effectsLive||previous?.hand?.id!==room.hand?.id)state.potMotion=null;
  const changes=feedback.update(room,{live:state.page==='room',visible:document.visibilityState!=='hidden',reconnected:state.feedbackResync,connected:state.connected,now:clock});state.feedbackResync=false;
  state.pendingFeedback=changes;
  const revealKeys=effectsLive&&previous?.hand?.id===room.hand?.id?(room.players||[]).flatMap(p=>(p.shownIndices||[]).filter(i=>!previous.players?.find(old=>old.id===p.id)?.shownIndices?.includes(i)).map(i=>p.id+':'+i)):[];
  if(revealKeys.length)state.revealMotion={handId:room.hand.id,keys:revealKeys,at:Date.now()};
  else if(!effectsLive||previous?.hand?.id!==room.hand?.id)state.revealMotion=null;
  if(changes.animations.length&&state.animations){const events=changes.animations,board=events.find(e=>e.type==='board');state.motion={at:Date.now(),hand:events.some(e=>e.type==='deal'),board:board?.from??0,newBoard:Boolean(board),actor:events.find(e=>e.type==='turn')?.playerId??null,win:events.some(e=>e.type==='win'),actions:events.filter(e=>e.type==='action').map(e=>e.playerId)};}
  else if(!effectsLive||!same||!state.animations||!state.motion?.at||Date.now()-state.motion.at>900)state.motion=null;
}
function normalizeState(room){if(!room||room.meId!==state.user?.id)return;const previous=state.room;if(isOlderRoomSnapshot(previous,room))return;const pending=state.pendingCommand;if(pending?.fast&&pending.guard.valid()&&pending.code===room.code&&pending.userId===room.meId&&Array.isArray(room.acceptedCommandIds)&&room.acceptedCommandIds.includes(pending.id)){pending.acknowledged=true;state.pendingCommand=null;state.busy=false;}if(previous?.hand?.id!==room.hand?.id){if(state.modal?.kind==='show')closeModal();state.showHandId=null;state.revealed=new Set();state.raise=0;}state.clock.accept(room);captureRoomChanges(previous,room);state.room=room;const self=room.players?.find(p=>p.id===room.meId);if(self&&state.user){state.user.name=self.name??state.user.name;state.user.avatar=self.avatar??state.user.avatar;state.user.avatarImage=self.avatarImage??null;}const changed=rememberCommitment(room.hand);if(changed&&!state.commitmentMismatch)toast('发现同一手牌的发牌承诺发生变化，请停止操作并保存记录',true);state.commitmentMismatch=changed;const actions=room.actions||{};const selection=syncBetControls(room,{amount:state.raise,preset:state.raisePreset,panelOpen:state.raisePanelOpen,key:state.raiseTurnKey});state.raise=selection.amount;state.raisePreset=selection.preset;state.raisePanelOpen=selection.panelOpen;state.raiseTurnKey=selection.key;render();if(state.modal?.kind==='equity'&&previous?.hand?.actionSeq!==room.hand?.actionSeq)equityDetails();if(state.modal?.kind==='room-menu'){const old=previous?.players?.find(p=>p.id===room.meId);if(previous?.status!==room.status||previous?.hostId!==room.hostId||previous?.startedAt!==room.startedAt||previous?.hand?.status!==room.hand?.status||previous?.autoDeal?.paused!==room.autoDeal?.paused||JSON.stringify(previous?.settings)!==JSON.stringify(room.settings)||old?.pendingDeparture!==self?.pendingDeparture||old?.waitingFor!==self?.waitingFor||old?.sittingOut!==self?.sittingOut||old?.seat!==self?.seat||JSON.stringify(old?.entryBlind)!==JSON.stringify(self?.entryBlind)||JSON.stringify(old?.squidJoin)!==JSON.stringify(self?.squidJoin)||previous?.mini?.squid?.paused!==room.mini?.squid?.paused)roomMenu();}if(state.modal?.kind==='entry-blind'&&!state.busy){const old=previous?.players?.find(p=>p.id===room.meId);if(old?.seat!==self?.seat||old?.inHand!==self?.inHand||old?.sittingOut!==self?.sittingOut||JSON.stringify(old?.entryBlind)!==JSON.stringify(self?.entryBlind)){if(self?.seat==null||!lifecycle.entryBlindView(room,self))closeModal();else entryBlindModal(Boolean(state.entryBlindConfirmation?.returning));}}if(state.modal?.kind==='table-info')refreshTableInfo(previous,room);if(state.modal?.kind==='buyin')refreshBuyinStatus(room);}
// A delayed room response may update state, but only its original modal owns cleanup.
// Comparing the instance also protects a newly reopened dialog of the same kind.
async function command(type,payload={}){
  if(state.busy||!state.room)return;
  const code=state.room.code,guard=requests.capture(),modal=state.modal;
  const fast=['fold','check','call','raise','allin','timebank'].includes(type);
  const pending={id:commandId(),code,userId:state.user?.id,guard,fast,acknowledged:false,
    label:({fold:'正在弃牌…',check:'正在过牌…',call:'正在跟注…',raise:'正在下注…',allin:'正在 All-in…',timebank:'正在加时…'})[type]};
  const body={type,...payload,commandId:pending.id,...(fast?{handId:state.room.hand?.id,actionSeq:state.room.hand?.actionSeq}:{})};
  state.pendingCommand=pending;state.busy=true;
  // A press only updates the controls; do not rebuild the table or move chips
  // before the server has accepted this exact command.
  if(fast)showCommandPending(pending);else render();
  try{
    const result=await api(`/api/rooms/${encodeURIComponent(code)}/action`,body);guard.check();
    if(fast&&state.pendingCommand===pending){state.pendingCommand=null;state.busy=false;}
    const previousRoom=state.room;normalizeState(result.room||result);
    if(fast&&state.room===previousRoom&&!state.pendingCommand)render();
    if(['approve','reject','settings','transferHost'].includes(type))toast({approve:'已同意带入申请',reject:'已拒绝带入申请',settings:'房间设置已保存',transferHost:'房主已转交'}[type]);
    return true;
  }catch(error){
    // SSE can confirm a saved command before its HTTP response arrives or is
    // lost. A late transport failure must not interrupt the following turn.
    if(pending.acknowledged&&guard.valid())return true;
    if(!error.stale&&guard.valid()){
      if(['buyin','sit'].includes(type)&&(error.resync||error.status===409)&&state.modal===modal&&state.room?.code===code&&modal?.kind==='buyin')closeModal();
      if((error.resync||error.status===409)&&state.page==='room'&&state.room?.code===code&&navigator.onLine&&document.visibilityState!=='hidden')connectStream(code);
      toast(error.message,true,{modal});
    }
    return false;
  }finally{
    // An earlier HTTP request may finish after another action has begun.
    if(guard.valid()&&state.pendingCommand===pending){state.pendingCommand=null;state.busy=false;render();}
  }
}
function showCommandPending(pending){
  const dock=document.querySelector?.('.action-dock');
  if(dock){const bottom=dock.closest?.('.table-bottom');if(bottom)bottom.renderedMarkup=null;dock.setAttribute('aria-busy','true');dock.classList.add('is-submitting');const status=dock.querySelector('.dock-status-text');if(status){status.textContent=pending.label;status.setAttribute('role','status');}}
  document.querySelectorAll?.('[data-game-action], [data-topup-button]').forEach(button=>{button.disabled=true;});
  const panel=document.querySelector?.('#raise-panel'),toggle=document.querySelector?.('#raise-toggle');
  if(panel)panel.hidden=true;if(toggle)toggle.setAttribute('aria-expanded','false');
}
function stopStream(){state.turnRecovery?.reset();tableSounds.stopPlayback?.();turnCountdown.reset();state.handCategoryMotion=[];state.pendingFeedback=null;state.potMotion=null;state.feedbackResync=true;state.stream?.abort();state.stream=null;clearTimeout(state.reconnectTimer);state.reconnectTimer=null;state.connected=false;}
async function connectStream(code,attempt=0){
  stopStream();state.feedbackResync=true;
  const controller=new AbortController(),token=state.token;state.stream=controller;
  state.connection=attempt?'正在重连':'正在同步牌桌';updateConnection();
  let watchdog,lastMessage=Date.now();
  try{
    watchdog=setInterval(()=>{if(state.stream===controller&&Date.now()-lastMessage>45000)connectStream(code,attempt+1);},5000);
    const response=await fetch(apiUrl(`/api/events?room=${encodeURIComponent(code)}`),{headers:{Authorization:`Bearer ${token}`},signal:controller.signal,cache:'no-store'});
    if(controller.signal.aborted||state.stream!==controller)return;
    if(response.status===401){await expireIdentity(token);return;}
    if(!response.ok||!response.body)throw new Error('无法连接牌桌');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){
      const {done,value}=await reader.read();
      if(controller.signal.aborted||state.stream!==controller)return;
      if(done)throw new Error('连接已中断');
      lastMessage=Date.now();buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
      if(buffer.length>2*1024*1024)throw new Error('牌桌更新过大，请重新连接');
      let end;
      while((end=buffer.indexOf('\n\n'))!==-1){
        const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(data){
          const incoming=JSON.parse(data);
          if(event.split('\n').some(line=>/^event:\s*session-expired$/.test(line))){await expireIdentity(token);return;}
          if(incoming.code===code&&state.page==='room'){
            state.connected=true;state.connection='实时连接';normalizeState(incoming);updateConnection();
          }
        }
      }
    }
  }catch(error){
    if(controller.signal.aborted||state.stream!==controller)return;
    controller.abort();tableSounds.stopPlayback?.();state.handCategoryMotion=[];state.connected=false;state.connection=navigator.onLine?'连接中断 · 正在重连':'网络已断开';updateConnection();
    if(state.page==='room'&&state.room?.code===code)state.reconnectTimer=setTimeout(()=>connectStream(code,attempt+1),Math.min(12000,1200*2**Math.min(attempt,4)));
  }finally{clearInterval(watchdog);}
}
function updateConnection(){document.querySelectorAll('[data-connection]').forEach(el=>el.innerHTML=`<i class="dot ${state.connected?'':'off'}"></i>${esc(state.connection)}`);document.querySelectorAll('[data-game-action]').forEach(el=>el.disabled=el.dataset.action==='timebank'?!seatTimeBankEnabled(state.room):!state.connected||state.busy||!betActionEnabled(state.room,el.dataset.action));if(!state.connected)setRaisePanel(false);document.querySelectorAll('[data-topup-button]').forEach(el=>el.disabled=!state.connected||state.feedbackResync||state.busy||el.dataset.blocked==='true');syncInteractionPanel();}
async function loadMe(){const guard=requests.capture(),data=await api('/api/me');guard.check();state.user=data.user;state.stats=data.stats;state.rooms=data.rooms||[];}
function stopLobbyPolling(){const list=state.lobby;if(!list)return;clearTimeout(list.timer);list.timer=null;list.controller?.abort();list.controller=null;list.request++;list.loading=false;}
async function loadLobby({silent=false,refreshHistory=false}={}){
  if(state.page!=='lobby'||!state.user||document.visibilityState==='hidden')return;
  const list=state.lobby,guard=requests.capture();clearTimeout(list.timer);list.controller?.abort();
  const id=++list.request,controller=new AbortController();list.controller=controller;list.loading=true;list.error='';
  if(!silent)render();
  try{
    const [directory,history]=await Promise.allSettled([api('/api/lobby',undefined,{signal:controller.signal}),...(refreshHistory?[api('/api/me',undefined,{signal:controller.signal})]:[])]);
    guard.check();if(state.lobby!==list||list.request!==id||state.page!=='lobby'||controller.signal.aborted)return;
    if(directory.status==='fulfilled'){const data=directory.value;list.rooms=Array.isArray(data.rooms)?data.rooms:[];list.limit=Number(data.limit)||10;list.loaded=true;}
    else list.error=directory.reason?.message||'牌桌列表刷新失败';
    if(history?.status==='fulfilled'&&Array.isArray(history.value.rooms))state.rooms=history.value.rooms;
    else if(history?.status==='rejected')list.error=[list.error,'历史牌桌刷新失败，已保留之前记录'].filter(Boolean).join('；');
  }
  catch(error){if(!error.stale&&!controller.signal.aborted&&guard.valid()&&state.lobby===list&&list.request===id)list.error=error.message;}
  finally{if(guard.valid()&&state.lobby===list&&list.request===id){list.loading=false;list.controller=null;if(state.page==='lobby'){render();if(document.visibilityState!=='hidden')list.timer=setTimeout(()=>loadLobby({silent:true}),15000);}}}
}
async function joinPublicRoom(code){
  const room=state.lobby.rooms.find(r=>r.code===code);if(!room||room.joined)return room?.joined?navigate(`/room/${encodeURIComponent(code)}`):undefined;
  if(room.access!=='public'||!room.canJoin||state.lobby.joining)return;
  const guard=requests.capture(),list=state.lobby;list.joining=code;render();
  try{await api(`/api/rooms/${encodeURIComponent(code)}/join`,{});guard.check();if(state.page==='lobby'&&state.lobby===list)navigate(`/room/${encodeURIComponent(code)}`);}
  catch(error){if(!error.stale&&guard.valid()){toast(error.message,true);await loadLobby({silent:true});}}
  finally{if(state.lobby===list){list.joining='';if(state.page==='lobby')render();}}
}
function joinInviteModal(code=''){
  const room=state.lobby.rooms.find(r=>r.code===code);
  openModal('用邀请加入',`<form id="join-form">${room?`<p class="note">「${esc(room.name)}」仅限邀请。请向房主索取完整链接。</p>`:'<p class="note">粘贴朋友发来的完整邀请链接。</p>'}<label class="field">邀请链接<input name="invite" aria-label="邀请链接" placeholder="https://…/#/room/…" required autocomplete="off"></label><div class="modal-footer">${btn('取消','close-modal','ghost')}<button class="primary" type="submit">加入牌桌</button></div></form>`,'join-invite');
}
async function route(){stopLobbyPolling();requests.invalidate();const guard=requests.capture();stopStream();state.busy=false;state.pendingCommand=null;closeModal();if(state.pendingRecovery){state.page='recovery';render();return;}const parts=location.hash.replace(/^#\/?/,'').split('/').map(p=>{try{return decodeURIComponent(p);}catch{return p;}});if(!state.user){state.page='welcome';render();return;}if(parts[0]==='room'&&parts[1]){state.page='loading';render();try{let room;if(parts[2]){const result=await api(`/api/rooms/${encodeURIComponent(parts[1])}/join`,{invite:parts[2]});room=result.room||result;}else room=await api(`/api/rooms/${encodeURIComponent(parts[1])}`);guard.check();state.page='room';normalizeState(room);connectStream(room.code);return;}catch(error){if(error.stale||!guard.valid())return;toast(error.message,true);state.page='lobby';state.room=null;render();await loadLobby();return;}}state.room=null;state.page=parts[0]==='career'?'career':parts[0]==='hands'?'hands':parts[0]==='sessions'?'sessions':parts[0]==='opponents'?'opponents':'lobby';try{await loadMe();if(state.page==='lobby')await loadLobby({silent:true});if(state.page==='career')await loadStats();if(state.page==='hands'){state.library.scope='personal';await loadLibrary(true);}if(state.page==='sessions')await loadSessions(true);if(state.page==='opponents')await loadOpponents();guard.check();}catch(error){if(error.stale||!guard.valid())return;toast(error.message,true);}if(guard.valid())render();}
function navigate(hash=''){if(location.hash===`#${hash}`||(!hash&&!location.hash))route();else location.hash=hash;}
function moneyUnitToggle(){return `<div class="money-unit-toggle" role="group" aria-label="筹码显示单位">${[['bb','BB'],['points','积分']].map(([value,label])=>btn(label,'display-unit',getDisplayUnit()===value?'selected':'',`data-unit="${value}" aria-pressed="${getDisplayUnit()===value}" aria-label="按${label}显示"`)).join('')}</div>`;}
function changeMoneyUnit(unit){
  if(!['bb','points'].includes(unit)||unit===getDisplayUnit())return;
  const kind=state.modal?.kind,scroll=dialog.scrollTop,form=dialog.querySelector('#buyin-form');
  if(form&&!form.querySelector('#buyin-amount').disabled&&!form.reportValidity())return;
  const buyin=form?{seat:form.dataset.seat,bb:Number(form.elements.namedItem('amountBB').value),entry:form.querySelector('[name="entryMode"]:checked')?.value}:null;
  setDisplayUnit(unit);saveTablePreferences();document.activeElement?.blur();render();
  if(kind==='room-menu')roomMenu();
  else if(kind==='table-info')tableInfoModal();
  else if(kind==='equity')equityDetails();
  else if(kind==='career')paintStats();
  else if(kind==='hand-library')renderHandLibrary();
  else if(kind==='session-list')renderSessions();
  else if(kind==='session-detail'&&state.sessionDetailData)openModal(esc(state.sessionDetailData.name),records.sessionDetail(state.sessionDetailData,state.user.id),'session-detail');
  else if(kind==='hand-overview')renderOverview();
  else if(kind==='replay'){renderReplay();dialog.querySelectorAll('.replay-log button').forEach((button,i)=>button.textContent=`${i+1}. ${eventText(state.replay.hand.log[i],state.replay.hand.players,state.replay.hand.settings?.bigBlind??state.replay.hand.bigBlind??null)}`);dialog.querySelector('.modal-unit-tools')?.replaceChildren();const tools=dialog.querySelector('.modal-unit-tools');if(tools)tools.innerHTML=moneyUnitToggle();}
  else if(kind==='buyin'&&buyin){buyinModal(buyin.seat===''?undefined:Number(buyin.seat));const fresh=dialog.querySelector('#buyin-form');fresh.querySelector('#buyin-amount').value=chipInputValue(buyin.bb*Number(fresh.dataset.bigBlind),Number(fresh.dataset.bigBlind));updateBuyinSummary(fresh);const radio=[...fresh.querySelectorAll('[name="entryMode"]')].find(el=>el.value===buyin.entry);if(radio)radio.checked=true;}
  dialog.scrollTop=scroll;
}
function header(){const inRoom=state.page==='room';return `<header class="topbar ${inRoom?'table-topbar':''}"><button class="brand" data-action="lobby" aria-label="回到 BBPoker 大厅"><img src="/bbpoker-mark-v3.svg" alt=""><strong>BB<span>Poker</span></strong></button>${state.user&&state.page!=='recovery'?`<nav class="topnav" aria-label="主导航">${inRoom?'':`${btn('牌桌','lobby',state.page==='lobby'?'active':'')}${btn('战绩','career',['career','sessions','hands','opponents'].includes(state.page)?'active':'')}`}${inRoom&&state.room?.status==='closed'?'':moneyUnitToggle()}<button class="profile-btn" data-action="profile" aria-label="账号：${esc(state.user.name)}">${avatar(state.user)}<span class="profile-name">${esc(state.user.name)}</span></button></nav>`:btn('规则与隐私','fairness','ghost small')}</header>`;}
function patchRoomToolbar(current,fresh){
  const toolbar=current.querySelector('.table-toolbar'),next=fresh.querySelector('.table-toolbar');if(!toolbar||!next)return false;
  // Keep pointer targets attached between press and click, even when SSE changes unread counts.
  for(const incoming of next.children){
    const button=[...toolbar.children].find(el=>el.dataset.action===incoming.dataset.action);
    if(!button)return false;
    button.className=incoming.className;button.disabled=incoming.disabled;
    for(const key of ['aria-expanded','aria-controls']){const value=incoming.getAttribute(key);if(value==null)button.removeAttribute(key);else button.setAttribute(key,value);}
    if(button.innerHTML!==incoming.innerHTML)button.innerHTML=incoming.innerHTML;
  }
  return true;
}
function patchTableRegion(current,fresh){if(!patchStableControls(current,fresh))current?.replaceWith(fresh);}
function patchTableColumn(current,fresh){
  const column=current.querySelector('.table-column'),incoming=fresh.querySelector('.table-column');
  const dock=column?.querySelector('.table-bottom'),nextDock=incoming?.querySelector('.table-bottom');
  if(!column||!incoming)return;
  // Chat, connection and other players' updates must not detach a button
  // between pointerdown and click when its turn and quoted amount are unchanged.
  patchTableRegion(column.querySelector('.table-stage'),incoming.querySelector('.table-stage'));
  column.style.cssText=incoming.style.cssText;
  if(!(dock&&nextDock&&dock.dataset.turn===nextDock.dataset.turn&&dock.renderedMarkup===nextDock.innerHTML)){
    if(dock&&nextDock)dock.replaceWith(nextDock);else column.replaceWith(incoming);
  }
}
function patchRoomView(html){
  const next=document.createElement('div');next.innerHTML=html;
  const current=app.querySelector('.room-shell'),fresh=next.querySelector('.room-shell');
  if(!current||!fresh||current.dataset.room!==fresh.dataset.room||current.dataset.roomView!==fresh.dataset.roomView)return false;
  if(fresh.dataset.roomView==='results'){
    const scroll=current.querySelector('.results-scroll'),top=scroll?.scrollTop||0;
    patchTableRegion(app.querySelector('.topbar'),next.querySelector('.topbar'));
    patchTableRegion(current,fresh);
    const updated=app.querySelector('.results-scroll');if(updated)updated.scrollTop=top;
    return true;
  }
  if(!patchRoomToolbar(current,fresh))return false;
  patchTableRegion(app.querySelector('.topbar'),next.querySelector('.topbar'));
  patchTableRegion(current.querySelector('.room-head'),fresh.querySelector('.room-head'));
  patchTableColumn(current,fresh);
  current.querySelectorAll(':scope > .room-notice').forEach(el=>el.remove());
  const grid=current.querySelector('.game-grid');for(const note of fresh.querySelectorAll(':scope > .room-notice'))current.insertBefore(note,grid);
  const chat=current.querySelector('.chat-card'),incoming=fresh.querySelector('.chat-card');if(chat)chat.remove();if(incoming)current.append(incoming);
  return true;
}
function patchFocusedChat(html){
  // Keep the actual input node attached during SSE updates, including Chinese IME.
  const next=document.createElement('div');next.innerHTML=html;
  const currentMain=app.querySelector('.room-shell'),nextMain=next.querySelector('.room-shell');
  const oldChat=app.querySelector('.chat-card'),newChat=next.querySelector('.chat-card');
  if(!currentMain||!nextMain||!oldChat||!newChat||currentMain.dataset.room!==nextMain.dataset.room)return false;
  patchTableRegion(app.querySelector('.topbar'),next.querySelector('.topbar'));
  patchTableRegion(currentMain.querySelector('.room-head'),nextMain.querySelector('.room-head'));
  currentMain.querySelectorAll(':scope > .room-notice').forEach(el=>el.remove());
  const grid=currentMain.querySelector('.game-grid');for(const note of nextMain.querySelectorAll(':scope > .room-notice'))currentMain.insertBefore(note,grid);
  patchTableColumn(currentMain,nextMain);
  for(const selector of ['.chat-heading','.chat-options','.emote-row','.chat-hint']){const old=oldChat.querySelector(selector),fresh=newChat.querySelector(selector);if(old&&fresh&&old.innerHTML!==fresh.innerHTML)old.innerHTML=fresh.innerHTML;}
  const oldMessages=oldChat.querySelector('.chat-messages'),newMessages=newChat.querySelector('.chat-messages');
  if(oldMessages&&newMessages){const ids=new Set([...newMessages.children].map(el=>el.dataset.message));for(const item of [...oldMessages.children])if(!ids.has(item.dataset.message)||!item.dataset.message)item.remove();const currentIds=new Set([...oldMessages.children].map(el=>el.dataset.message));for(const item of [...newMessages.children])if(!item.dataset.message||!currentIds.has(item.dataset.message))oldMessages.append(item);}
  const input=oldChat.querySelector('#chat-input'),freshInput=newChat.querySelector('#chat-input');
  if(input&&freshInput){input.disabled=freshInput.disabled;if(!state.composing&&input.value!==state.chatDraft)input.value=state.chatDraft;}
  const submit=oldChat.querySelector('[type=submit]'),freshSubmit=newChat.querySelector('[type=submit]');if(submit&&freshSubmit)submit.disabled=freshSubmit.disabled;
  patchRoomToolbar(currentMain,nextMain);
  const oldTurn=oldChat.querySelector('.drawer-turn'),newTurn=newChat.querySelector('.drawer-turn');
  if(oldTurn&&newTurn)patchStableControls(oldTurn,newTurn);
  return true;
}
function patchFocusedRaise(html){
  // Keep the live slider node attached while a chat update arrives.
  const next=document.createElement('div');next.innerHTML=html;
  const current=app.querySelector('.room-shell'),fresh=next.querySelector('.room-shell');
  const dock=current?.querySelector('.table-bottom'),incoming=fresh?.querySelector('.table-bottom');
  if(!current||!fresh||dock?.renderedMarkup===null||current.dataset.room!==fresh.dataset.room||dock?.querySelector('#raise-range')?.dataset.unit!==incoming?.querySelector('#raise-range')?.dataset.unit||!dock?.querySelector('#raise-range')||!incoming?.querySelector('#raise-range')||dock.dataset.turn!==incoming.dataset.turn)return false;
  patchTableRegion(app.querySelector('.topbar'),next.querySelector('.topbar'));
  patchTableRegion(current.querySelector('.room-head'),fresh.querySelector('.room-head'));
  patchTableRegion(current.querySelector('.table-stage'),fresh.querySelector('.table-stage'));
  current.querySelector('.table-column').style.cssText=fresh.querySelector('.table-column').style.cssText;
  patchRoomToolbar(current,fresh);
  current.querySelectorAll(':scope > .room-notice').forEach(el=>el.remove());
  const grid=current.querySelector('.game-grid');for(const notice of fresh.querySelectorAll(':scope > .room-notice'))current.insertBefore(notice,grid);
  const oldChat=current.querySelector('.chat-card'),newChat=fresh.querySelector('.chat-card');if(oldChat)oldChat.remove();if(newChat)current.append(newChat);
  dock.querySelector('.turn-row').replaceWith(incoming.querySelector('.turn-row'));
  // Keep unchanged buttons attached too: a chat frame must not swallow a
  // press while the slider has focus. A genuinely changed quote is replaced.
  for(const selector of ['.raise-shortcuts','#raise-button','#raise-amount']){
    const old=dock.querySelector(selector),fresh=incoming.querySelector(selector);if(old&&fresh&&old.outerHTML!==fresh.outerHTML)old.replaceWith(fresh);
  }
  const range=dock.querySelector('#raise-range'),nextRange=incoming.querySelector('#raise-range');
  dock.renderedMarkup=incoming.innerHTML;
  range.disabled=nextRange.disabled;
  if(range.value!==nextRange.value)range.value=nextRange.value;
  range.setAttribute('aria-valuetext',nextRange.getAttribute('aria-valuetext'));
  const panel=dock.querySelector('#raise-panel'),nextPanel=incoming.querySelector('#raise-panel');if(panel&&nextPanel)panel.hidden=nextPanel.hidden;
  const endpoint=dock.querySelector('.raise-vertical-track .raise-endpoint:last-child'),nextEndpoint=incoming.querySelector('.raise-vertical-track .raise-endpoint:last-child');if(endpoint&&nextEndpoint)endpoint.textContent=nextEndpoint.textContent;
  for(const button of dock.querySelectorAll('.action-buttons [data-game-action]')){const other=incoming.querySelector(`[data-action="${button.dataset.action}"]`);if(other)button.disabled=other.disabled;}
  return true;
}
function patchLobby(html){
  const next=document.createElement('div');next.innerHTML=html;return patchLobbyView(app,next);
}
function finishComposition(target=state.compositionTarget,{renderPending=true}={}){
  const record=state.recordComposition;
  if(target&&target!==state.compositionTarget)return;
  if(target?.id==='chat-input')state.chatDraft=target.value;
  const deferred=state.recordRenderDeferred||state.renderDeferred;
  state.compositionTarget=null;state.composing=false;state.recordComposition=null;
  state.recordRenderDeferred=false;state.renderDeferred=false;
  if(!renderPending||!deferred)return;
  if(record?.form?.isConnected)(record.kind==='hands'?renderHandLibrary:record.kind==='opponents'?renderOpponents:renderSessions)();
  else render();
}
function flushTableFeedback(){if(state.pendingFeedback){const pending=state.pendingFeedback;state.pendingFeedback=null;if(state.sound&&state.page==='room'&&state.connected&&!state.feedbackResync&&document.visibilityState!=='hidden')tableSounds.playFeedback(pending);}}
function render(){
  document.body.classList.toggle('at-table',state.page==='room');
  flushTableFeedback();
  // IME can lose compositionend when the keyboard is dismissed, its input is
  // removed, or the page backgrounds. Only a still-focused input may defer DOM.
  if(state.compositionTarget&&(state.compositionTarget.isConnected===false||document.activeElement!==state.compositionTarget))finishComposition(undefined,{renderPending:false});
  if(state.composing&&document.activeElement?.id!=='chat-input'){state.renderDeferred=true;return;}
  const statsDraft=statsUI.captureStatsDraft(app.querySelector('#stats-filter-form'),state.statsView,document.activeElement);
  const recordDrafts=[['hands',state.library],['sessions',state.sessions],['opponents',state.opponents]].map(([kind,list])=>({kind,list,draft:records.captureRecordDraft(app.querySelector(recordFormSelector(kind)),list,document.activeElement)}));
  const focused=document.activeElement,focusId=app.contains(focused)?focused.id:null;
  const selection=focusId&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
  const scroll=$('#chat-messages'),scrollTop=scroll?.scrollTop||0,atBottom=!scroll||scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<45;
  const html=header()+({welcome:welcome,recovery:recoveryPage,loading:()=>'<div class="boot"><span class="spinner"></span><span>正在连接 BBPoker…</span></div>',error:errorPage,lobby:lobby,room:roomView,career:career,hands:handLibrary,sessions:sessionLibrary,opponents:opponentLibrary}[state.page]||lobby)();
  const patched=state.page==='lobby'?patchLobby(html):state.page==='room'&&((focusId==='chat-input'&&patchFocusedChat(html))||(focusId==='raise-range'&&patchFocusedRaise(html))||patchRoomView(html));
  if(!patched)app.innerHTML=html;
  statsUI.restoreStatsDraft(app.querySelector('#stats-filter-form'),state.statsView,statsDraft);
  for(const {kind,list,draft} of recordDrafts)records.restoreRecordDraft(app.querySelector(recordFormSelector(kind)),list,draft);
  const current=$('#chat-messages');if(current)current.scrollTop=atBottom?current.scrollHeight:scrollTop;
  if(focusId){const next=document.getElementById(focusId);if(next&&next!==focused){next.focus({preventScroll:true});if(selection&&typeof next.setSelectionRange==='function'&&!['number','range'].includes(next.type))next.setSelectionRange(...selection);}}
  const renderedDock=app.querySelector('.table-bottom');if(renderedDock&&renderedDock.renderedMarkup===undefined)renderedDock.renderedMarkup=renderedDock.innerHTML;
  state.renderDeferred=false;avatarCache.hydrate(app);layoutTableBubbles(app.querySelector('.table-stage'));mountPotAwards(app.querySelector('.table-stage'),state.potMotion,{enabled:state.animations});mountFunEffects(app.querySelector('.table-stage'),state.funEffects,{enabled:state.fun&&state.animations,now:state.clock.now()});document.body.classList.toggle('at-table',state.page==='room');tick();
}
function usernameField(value='',readonly=false){return `<label class="field">账号<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" value="${esc(value)}" placeholder="3–24 位字母、数字或下划线" ${readonly?'readonly':''} required></label>`;}
function passwordField(name='password',label='密码',fresh=false){return `<label class="field">${label}<input name="${name}" type="password" autocomplete="${fresh?'new-password':'current-password'}" ${fresh?'minlength="10"':''} maxlength="128" placeholder="${fresh?'至少 10 位，可用密码管理器生成':'输入密码'}" required></label>`;}
function welcome(){const register=state.authMode==='register';return `<main class="welcome"><form id="${register?'register':'login'}-form" class="panel stack"><h1>${register?'注册账号':'登录'}</h1>${usernameField()}${passwordField('password','密码',register)}${register?'<label class="field">昵称（选填）<input name="name" autocomplete="nickname" maxlength="18" placeholder="不填则使用账号名"></label>':''}<button class="primary wide" type="submit">${register?'注册':'登录'}</button><div class="row between">${btn(register?'已有账号？登录':'没有账号？注册',register?'auth-login':'auth-register','ghost small')}${!register?btn('忘记密码','recover','ghost small'):''}</div><div class="note">朋友积分局 · 不涉及现金</div></form><div class="welcome-footer">${btn('找回以前的昵称身份','restore','ghost small')}</div></main>`;}
function recoveryPage(){const recovery=state.pendingRecovery;if(!recovery)return welcome();return `<main class="welcome"><section class="panel stack"><h1>保存找回码</h1><div class="note">账号：${esc(recovery.username)}<br>忘记密码时，用它设置新密码。仅显示这一次，请私下保存，不要发给别人。旧找回码已失效。</div><div class="recovery" id="account-recovery-code">${esc(recovery.code)}</div><div class="row wrap">${btn('复制找回码','copy-recovery','outline')}${btn('下载保存','save-recovery','outline')}</div>${btn('已保存，继续','recovery-done','primary wide')}</section></main>`;}
function errorPage(){return `<main class="shell"><div class="panel empty"><span class="empty-symbol">↻</span><h2>暂时没连上 BBPoker</h2><p>${esc(state.error||'请检查网络，稍后再试。')}</p>${btn('重新连接','retry','primary', 'style="margin-top:20px"')}</div></main>`;}
function lobby(){
  const list=state.lobby,rooms=lifecycle.filterLobbyRooms(list.rooms,list.filter),past=state.rooms.filter(r=>r.status==='closed');
  const empty=list.loading&&!list.loaded?'<div class="directory-empty"><span class="spinner"></span><p>正在查找牌桌…</p></div>':`<div class="directory-empty"><h2>${list.filter==='mine'?'还没有加入牌桌':list.filter==='joinable'?'暂时没有可直接加入的牌桌':'现在没有进行中的牌桌'}</h2><p>${list.filter==='mine'?'选择公开牌桌，或使用朋友的邀请链接。':list.filter==='joinable'?'试试全部牌桌，或请朋友发送邀请。':'创建一桌，叫朋友来玩。'}</p></div>`;
  return `<main class="shell lobby-shell" data-user="${esc(state.user.id)}"><div class="lobby-heading" data-lobby-region="heading"><div><h1 class="page-title">牌桌大厅</h1><p class="subheading">找朋友的局，随时回来继续。</p></div><div class="lobby-actions">${btn('用邀请加入','join-invite','outline')}${btn('创建牌桌','create','primary',list.loaded&&list.rooms.length>=list.limit?'disabled title="当前进行中的牌桌已达上限"':'')}</div></div><div class="lobby-filters" data-lobby-region="filters"><div class="segmented" aria-label="筛选牌桌">${[['all','全部'],['joinable','可加入'],['mine','我的']].map(([value,label])=>btn(label,'lobby-filter',list.filter===value?'active':'',`data-filter="${value}" aria-pressed="${list.filter===value}"`)).join('')}</div>${btn(list.loading?'刷新中…':'刷新','lobby-refresh','lobby-refresh',list.loading?'disabled':'')}</div><div data-lobby-region="directory">${list.error?`<div class="directory-error" role="status"><span>${esc(list.error)}${list.loaded?'，已保留可用的牌桌信息。':''}</span>${btn('重试','lobby-refresh','ghost small')}</div>`:''}${rooms.length?`<div class="directory-grid">${rooms.map(lobbyRoomCard).join('')}</div>`:empty}</div><p class="lobby-footnote" data-lobby-region="note">公开牌桌可直接加入；仅限邀请的牌桌需要邀请链接。大厅不显示牌局内容。</p>${past.length?`<details class="panel past-rooms" data-lobby-region="past"><summary>我参加过的已结束牌桌 · ${past.length}</summary><div class="room-list">${past.slice().reverse().map(r=>`<button class="room-item" data-lobby-code="${esc(r.code)}" data-action="open-room" data-code="${esc(r.code)}"><span><strong>${esc(r.name)}</strong><small>${esc(r.code)} · 已结束</small></span><span class="muted">查看记录 ↗</span></button>`).join('')}</div></details>`:''}<footer class="footer" data-lobby-region="footer"><span>朋友积分局</span><div class="row">${btn('玩法规则','rules')}${btn('公平与隐私','fairness')}</div></footer></main>`;
}
function lobbyRoomCard(room){
  const cta=lifecycle.lobbyRoomAction(room),joining=state.lobby.joining===room.code,started=room.status==='playing';
  const end=typeof room.endsAt==='number'?room.endsAt:Date.parse(room.endsAt),expired=Number.isFinite(end)&&end<=state.clock.now();
  const status=started?'进行中':expired?'等待收尾':Number(room.handNumber)>0||room.endsAt?'等待下一手':'等待开局';
  return `<article data-lobby-code="${esc(room.code)}" class="directory-card ${room.joined?'joined':''}"><div class="directory-heading"><h2>${esc(room.name)}</h2><span class="directory-status ${started?'playing':''}">${status}</span></div><p class="directory-host">${esc(room.hostName||'朋友')}的牌桌 · ${esc(room.code)}${room.joined?' · 已加入':''}</p><div class="directory-meta"><span><b>${num(room.seatedCount)}</b> / ${num(room.maxPlayers)} 人</span><span>盲注 <b>${chips(room.smallBlind,room.bigBlind,{unitLabel:false})} / ${chips(room.bigBlind,room.bigBlind)}</b></span><span>德州${room.squid?' · 🐙 '+lifecycle.squidName(room.squidMode):''}${room.bombPot?' · 💣 炸弹':''}</span></div><div class="directory-bottom"><small>${room.access==='public'?'公开加入':'仅限邀请'}${room.bombPot?` · 炸弹每 ${num(room.bombIntervalMinutes||10)} 分钟`:''}<br>${esc(lifecycle.lobbyTime(room.endsAt,state.clock.now()))}${started&&room.handNumber?` · 第 ${num(room.handNumber)} 手`:''}</small>${btn(joining?'正在加入…':cta.label,cta.action,room.joined||room.canJoin?'primary':'outline',`data-code="${esc(room.code)}" ${cta.disabled||joining?'disabled':''}`)}</div></article>`;
}
const emotes={nice:{symbol:'👏',label:'好牌'},gg:{symbol:'🤝',label:'好局'},lol:{symbol:'😄',label:'哈哈'},wow:{symbol:'😮',label:'哇'},thanks:{symbol:'🙏',label:'谢谢'},unlucky:{symbol:'😅',label:'差一点'}};
function chatContent(m){if(m.kind==='throw'){const e=THROWABLES.find(x=>x.id===m.emote);return e?`${e.glyph} 对 ${esc(m.targetName||'牌友')} ${esc(e.label)}`:'牌桌互动';}return m.kind==='emote'&&emotes[m.emote]?`<span class="chat-emote" role="img" aria-label="${esc(emotes[m.emote].label)}">${emotes[m.emote].symbol}</span>`:esc(m.text);}
function reactionBubble(id){const r=state.reactions[id];if(!r||r.until<Date.now()||state.reactionsMuted)return '';const e=emotes[r.emote];return `<div class="seat-reaction ${r.kind==='emote'?'is-emote':''}" data-reaction-until="${r.until}" role="status"><small>${esc(r.name||state.room?.players.find(p=>p.id===id)?.name||'牌友')}</small>${r.kind==='emote'&&e?`<span class="chat-emote" role="img" aria-label="${esc(e.label)}">${e.symbol}</span>`:`<span>${esc(r.text)}</span>`}</div>`;}
function chatPanel(room){if(!state.chatOpen)return '';const messages=state.chatMuted?[]:(room.chat||[]).slice(-100);return `<section class="panel chat-card table-drawer is-open" id="chat-drawer" role="dialog" aria-modal="false" aria-labelledby="chat-title"><header class="chat-heading"><h2 id="chat-title">牌桌聊天</h2>${btn('×','toggle-chat','icon-btn ghost','aria-label="关闭聊天"')}</header><div class="drawer-turn">${room.actions?.canAct?btn('轮到你 · 返回牌桌 <b class="clock" data-turn-clock></b>','toggle-chat','chat-return-turn'):'聊天不会暂停牌局'}</div>${state.chatOpen?`<div id="chat-content"><div class="chat-options">${btn(state.chatMuted?'显示聊天':'隐藏聊天','mute-chat','ghost small',`aria-pressed="${state.chatMuted}"`)}${btn(state.reactionsMuted?'显示气泡':'隐藏气泡','mute-reactions','ghost small',`aria-pressed="${state.reactionsMuted}"`)}</div><div id="chat-messages" class="chat-messages" role="log" aria-label="本桌聊天">${messages.length?messages.map(m=>`<div class="chat-message ${m.playerId===room.meId?'self':''}" data-message="${esc(m.id)}"><div class="chat-byline"><b>${esc(m.name)}</b><time>${esc(new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</time></div><p>${chatContent(m)}</p></div>`).join(''):`<p class="chat-empty">${state.chatMuted?'已隐藏聊天内容':'和这桌朋友聊两句'}</p>`}</div><div class="emote-row" aria-label="快捷表情">${Object.entries(emotes).map(([id,e])=>btn(e.symbol,'send-emote','emote-btn',`data-emote="${id}" title="${e.label}" aria-label="发送表情：${e.label}" ${state.chatBusy||room.status==='closed'?'disabled':''}`)).join('')}</div><form id="chat-form" class="chat-compose"><input id="chat-input" name="text" maxlength="160" autocomplete="off" placeholder="聊两句…" aria-label="聊天消息，最多160字" value="${esc(state.chatDraft)}" ${room.status==='closed'?'disabled':''}><button class="primary" type="submit" ${state.chatBusy||room.status==='closed'?'disabled':''}>发送</button></form><small class="chat-hint">${room.status==='closed'?'本桌已结束':'仅本桌成员可见 · 最近 100 条'}</small></div>`:''}</section>`;}
async function sendChat(kind,textOrEmote,targetId=''){
  const room=state.room;if(!room||state.chatBusy)return;
  const text=String(textOrEmote||'').trim();if(kind==='text'&&!text)return;
  const guard=requests.capture(),code=room.code,draft=state.chatDraft;const previous=state.chatPending;const pending=previous?.code===code&&previous.kind===kind&&previous.content===text&&(previous.targetId||'')===targetId?previous:{code,kind,content:text,targetId,messageId:commandId()};state.chatPending=pending;state.chatBusy=true;render();
  try{await api(`/api/rooms/${encodeURIComponent(code)}/chat`,{kind,...(kind==='text'?{text}:{emote:text}),...(kind==='throw'?{targetId}:{}),messageId:pending.messageId});guard.check();if(state.room?.code!==code)return;state.chatPending=null;if(kind==='throw')state.throwUntil=Date.now()+3000;if(kind==='text'&&state.chatDraft===draft)state.chatDraft='';}
  catch(error){if(!error.stale&&guard.valid())toast(error.message,true);}
  finally{if(guard.valid()&&state.room?.code===code){state.chatBusy=false;render();}}
}
function renderHandLibrary(){if(state.recordComposition?.kind==='hands'&&state.recordComposition.form.isConnected){state.recordRenderDeferred=true;return;}const documentRef=globalThis.document,draft=records.captureRecordDraft(documentRef?.querySelector('#hand-records-filter-form'),state.library,documentRef?.activeElement);if(state.modal?.kind==='hand-library')openModal(state.library.scope==='table'?'本桌牌谱':'我的牌谱',`<div class="records-overlay">${handLibraryContent()}</div>`,'hand-library');else if(state.page==='hands')render();records.restoreRecordDraft(documentRef?.querySelector('#hand-records-filter-form'),state.library,draft);const modal=documentRef?.querySelector('#dialog');if(modal?.open)avatarCache.hydrate(modal);}
async function loadLibrary(reset=false){
  const library=state.library;if(library.loading&&!reset)return;
  const id=++library.request,guard=requests.capture();library.loading=true;library.error='';
  if(reset){library.hands=[];library.nextCursor=null;library.totals=null;library.opponents=null;}renderHandLibrary();
  try{const query=records.recordQuery('hands',library,reset);const path=library.scope==='table'?`/api/rooms/${encodeURIComponent(library.room)}/history`:'/api/hands';if(library.scope==='table')query.delete('room');const data=await api(`${path}?${query}`);guard.check();if(id!==state.library.request)return;const seen=new Set(library.hands.map(h=>h.id));for(const hand of data.hands){if(!seen.has(hand.id)){seen.add(hand.id);library.hands.push(hand);}}library.nextCursor=data.nextCursor||null;library.totals=data.totals||null;library.opponents=library.scope==='table'?null:data.opponents||null;library.opponentOptions=library.scope==='table'?[]:data.opponentOptions||[];}
  catch(error){if(!error.stale&&guard.valid()&&id===state.library.request)library.error=error.message;}
  finally{if(guard.valid()&&id===state.library.request){library.loading=false;renderHandLibrary();}}
}
function returnToHandLibrary(){openModal(state.library.scope==='table'?'本桌牌谱':'我的牌谱',`<div class="records-overlay">${handLibraryContent()}</div>`,'hand-library');const saved=state.libraryReturn;if(saved){records.restoreRecordDraft(document.querySelector('#hand-records-filter-form'),state.library,saved.draft);dialog.scrollTop=saved.scroll;}tick();}
function historyTurnNotice(){return state.page==='room'?`<div class="history-turn-notice" data-history-turn hidden><strong>轮到你了 <span data-turn-clock></span></strong>${btn('返回牌桌','close-modal','primary small')}</div>`:'';}
function opponentViewOptions(){return {mode:state.library.filters.potType==='headsUp'?'headsUp':'all',search:state.library.opponentSearch||'',avatar};}
function handLibraryContent(){
  const l=state.library,table=l.scope==='table';
  const handList=l.hands.length?`<div class="hand-library">${l.hands.map(handSummary).join('')}</div>`:!l.loading?`<div class="panel empty"><span class="empty-symbol">♧</span><h3>没有符合条件的牌谱</h3><p>调整筛选，或完成一手后再来看。</p>${btn('清除筛选','record-reset','outline small','data-kind="hands"')}</div>`:'';
  const status=l.error?`<div class="panel empty"><p>${esc(l.error)}</p>${btn('重试','library-retry','outline small')}</div>`:handList;
  const paging=`<div class="load-more">${l.loading?'<span class="spinner"></span><span>正在读取记录…</span>':!l.error&&l.nextCursor?btn('加载更多','library-more','outline'):!l.error&&l.hands.length?'<span>已显示全部记录</span>':''}</div>`;
  const selectedName=l.opponentOptions.find(p=>p.id===l.filters.opponent)?.name||(l.opponentDrilldown&&l.filters.opponent===l.opponentDrilldown.id?l.opponentDrilldown.name:'已选择的对手');
  const drilldown=!table&&l.opponentDrilldown?`<div class="opponent-drilldown">${btn('← 返回对手','opponents','ghost small')}<strong>${l.filters.opponent?`与 ${esc(selectedName)} 的共同牌谱`:'当前条件的牌谱'}</strong><span>这里显示整手盈亏；两人直接输赢请看对手页。</span></div>`:'';
  return `${historyTurnNotice()}<div class="section-head"><div><h1 class="page-title">${table?'本桌牌谱':'我的牌谱'}</h1><p class="subheading">${table?'只看这一桌，最新完成的手牌排在前面。':'找到想复盘的一手，查看每个人的行动。'}</p></div><div class="row wrap">${table?btn('刷新','library-retry','ghost small'):''}${btn('导出','export','outline small')}</div></div>${drilldown}<div class="library-favorites segmented">${btn('全部','library-all',!l.favorites?'active':'')}${btn('★ 收藏','library-favorites',l.favorites?'active':'')}</div>${records.recordFilters('hands',l,state.rooms)}${records.recordTotals(l.totals,'hands')}${status}${paging}<p class="privacy-footnote">盈亏包含德州及本手小游戏结算；BB 按各手的大盲换算。汇总覆盖筛选后的全部记录${!table?'，如选最近手数则只统计该范围':''}。起手牌只筛选自己的底牌，其他人的未公开底牌始终隐藏。${table?'未参与发牌时，仍会显示与你有关的鱿鱼结算。':''}</p>`;
}
// Each view keeps its own applied filters and unsubmitted form edits. Hand-only
// fields must never silently narrow the opponent overview.
function libraryViewSnapshot(){
  const l=state.library,d=globalThis.document;
  return {filters:{...l.filters},room:l.room,favorites:l.favorites,draft:records.captureRecordDraft(d?.querySelector('#hand-records-filter-form'),l,d?.activeElement),scroll:d?.querySelector('#dialog')?.open?d.querySelector('#dialog').scrollTop:d?.documentElement?.scrollTop||0};
}
function opponentOverviewFilters(filters={}){
  const result=records.defaultRecordFilters();
  for(const key of ['period','from','to','position','type','tableSize'])if(filters[key]!==undefined)result[key]=filters[key];
  result.potType=filters.potType==='headsUp'?'headsUp':'all';return result;
}
async function restoreLibraryView(view,saved){
  const l=state.library;l.view=view;l.opponentDrilldown=null;l.filters=view==='opponents'?opponentOverviewFilters(saved.filters):{...saved.filters};l.room=saved.room||'';l.favorites=view==='hands'&&Boolean(saved.favorites);
  const pending=loadLibrary(true),request=l.request,guard=requests.capture();await pending;
  if(!guard.valid()||state.library!==l||l.request!==request||l.view!==view)return;
  const d=globalThis.document;records.restoreRecordDraft(d?.querySelector('#hand-records-filter-form'),l,saved.draft);
  const scroll=d?.querySelector('#dialog');if(scroll?.open)scroll.scrollTop=saved.scroll||0;else if(d?.documentElement)d.documentElement.scrollTop=saved.scroll||0;
}
async function setLibraryView(view){
  const l=state.library;if(l.scope==='table'||!['hands','opponents'].includes(view)||l.view===view&&!l.opponentDrilldown)return;
  if(!l.opponentDrilldown)l.viewContexts[l.view]=libraryViewSnapshot();
  let saved=l.viewContexts[view];
  if(!saved){const f=l.filters;saved={filters:view==='opponents'?opponentOverviewFilters({period:f.period,from:f.from,to:f.to}):records.defaultRecordFilters(),room:l.room,favorites:false};}
  await restoreLibraryView(view,saved);
}
async function setOpponentMode(mode){
  const l=state.library;if(l.scope==='table'||l.view!=='opponents'||!['all','headsUp'].includes(mode))return;
  l.filters={...opponentOverviewFilters(l.filters),potType:mode};await loadLibrary(true);
}
function refreshOpponentResults(){
  const l=state.library;if(l.scope==='table'||l.view!=='opponents')return;
  const root=globalThis.document?.querySelector('[data-opponent-results]');
  if(root){root.innerHTML=records.opponentResultList(l.opponents,l.opponentSort,opponentViewOptions());avatarCache.hydrate(root);}
}
function sortLibraryOpponents(sort){if(state.library.scope==='table'||state.library.view!=='opponents'||!['hands','profit','loss','recent'].includes(sort))return;state.library.opponentSort=sort;refreshOpponentResults();}
function searchLibraryOpponents(value){if(state.library.scope==='table'||state.library.view!=='opponents')return;state.library.opponentSearch=String(value||'').slice(0,80);refreshOpponentResults();}
function clearOpponentSearch(){state.library.opponentSearch='';const input=globalThis.document?.querySelector('[data-opponent-search]');if(input){input.value='';input.focus();}refreshOpponentResults();}
async function selectLibraryOpponent(id){
  const l=state.library,row=(l.opponents?.rows||[]).find(row=>row.id===id);if(l.scope==='table'||l.view!=='opponents'||!row)return;
  l.viewContexts.opponents=libraryViewSnapshot();l.opponentDrilldown={id:row.id,name:row.name};
  l.filters={...opponentOverviewFilters(l.filters),opponent:id};l.favorites=false;l.view='hands';await loadLibrary(true);
}
function handLibrary(){return `<main class="shell library-shell records-shell">${records.recordNavigation('hands')}${handLibraryContent()}</main>`;}
async function openHandLibrary(code='',scope='personal'){
  state.library.room=code;state.library.scope=scope;state.library.filters=records.defaultRecordFilters();state.library.favorites=false;state.library.view='hands';state.library.opponentSort='hands';state.library.opponentSearch='';state.library.viewContexts={};state.library.opponentDrilldown=null;state.library.opponents=null;state.library.opponentOptions=[];state.library.hands=[];state.library.totals=null;state.library.nextCursor=null;
  openModal(scope==='table'?'本桌牌谱':'我的牌谱',`<div class="records-overlay">${handLibraryContent()}</div>`,'hand-library');await loadLibrary(true);
}
function handSummary(h){const visible=historyBoard(h,{summary:true});const net=h.totalNet??Number(h.net||0)+Number(h.miniNet||0),observed=h.participated===false,settlement=observed&&Number(h.miniNet||0)!==0,bb=h.bigBlind,profit=observed&&!settlement?'观战':formatChips(net,bb,{signed:true});return `<article class="hand-record"><button class="hand-open" data-action="hand-overview" data-hand="${esc(h.id)}" data-room="${esc(h.roomCode)}"><div class="hand-record-title"><strong>第 ${num(h.number)} 手${h.bombPot?' · 炸弹池':''}${h.squidRound?` · ${lifecycle.squidName(h.squidMode)}`:''}${observed?settlement?' · 鱿鱼结算':' · 观战':''}</strong><small>${esc(h.roomName)} · ${esc(fmtDate(h.at))}</small>${records.handContextChips(h)}</div><div class="hand-record-cards"><div class="record-hole">${cards(h.cards||[null,null],'small-card')}</div><span class="card-separator"></span><div class="record-board" aria-label="公共牌，金色虚线为结算后补看">${Array.from({length:5},(_,i)=>card(visible.board[i],`mini ${i>=visible.actualCount&&visible.board[i]?'rabbit-card':''}`,!visible.board[i])).join('')}</div></div><div class="hand-record-result"><b class="${profitClass(net)}">${esc(profit)}</b>${observed&&!settlement?'':`<small>德州 ${esc(formatChips(h.net||0,bb,{signed:true}))}${Number(h.miniNet||0)!==0?` · 小游戏 ${esc(formatChips(h.miniNet,bb,{signed:true}))}`:''}</small>`}${visible.rabbitCount?'<small class="record-rabbit-note">虚线牌为补看 · 不计输赢</small>':''}<small>底池 ${esc(formatChips(h.pot,bb))} · 查看行动 →</small></div></button>${observed?'':btn(h.favorite?'★':'☆','favorite',`favorite-btn ${h.favorite?'is-favorite':''}`,`data-hand="${esc(h.id)}" data-favorite="${!h.favorite}" aria-label="${h.favorite?'取消收藏':'收藏这手牌'}" aria-pressed="${Boolean(h.favorite)}"`)}</article>`;}
async function favoriteHand(id,favorite,button){const guard=requests.capture();button.disabled=true;try{const result=await api(`/api/hands/${encodeURIComponent(id)}/favorite`,{favorite});guard.check();const item=state.library.hands.find(h=>h.id===id);if(item)item.favorite=result.favorite;if(state.replay?.hand.id===id)state.replay.favorite=result.favorite;if(state.library.favorites)await loadLibrary(true);else renderHandLibrary();if(state.modal?.kind==='replay')renderReplay();else if(state.modal?.kind==='hand-overview')renderOverview();}catch(error){if(!error.stale)toast(error.message,true);}finally{if(button.isConnected)button.disabled=false;}}
function sessionLibraryContent(){const list=state.sessions;return `<div class="section-head"><div><h1 class="page-title">我的对局</h1><p class="subheading">一张牌桌算一场，查看每位朋友的整场输赢。</p></div></div>${records.recordFilters('sessions',list)}${records.recordTotals(list.totals,'sessions')}${list.error?`<div class="panel empty"><p>${esc(list.error)}</p>${btn('重试','sessions-retry','outline small')}</div>`:list.rows.length?`<div class="session-list">${list.rows.map(records.sessionRow).join('')}</div>`:!list.loading?`<div class="panel empty"><span class="empty-symbol">♧</span><h3>没有符合条件的对局</h3><p>调整筛选，或入座参与一场后再来看。</p>${btn('清除筛选','record-reset','outline small','data-kind="sessions"')}</div>`:''}<div class="load-more">${list.loading?'<span class="spinner"></span><span>正在读取对局…</span>':list.nextCursor?btn('加载更多','sessions-more','outline'):list.rows.length?'<span>已显示全部记录</span>':''}</div><p class="privacy-footnote">日期按牌桌开始时间筛选；汇总覆盖全部符合条件的对局。只计算已结算的盈亏，带入和补码不算输赢。</p>`;}
function sessionLibrary(){return `<main class="shell records-shell">${records.recordNavigation('sessions')}${sessionLibraryContent()}</main>`;}
function renderSessions(){if(state.recordComposition?.kind==='sessions'&&state.recordComposition.form.isConnected){state.recordRenderDeferred=true;return;}const documentRef=globalThis.document,draft=records.captureRecordDraft(documentRef?.querySelector('#session-records-filter-form'),state.sessions,documentRef?.activeElement);if(state.modal?.kind==='session-list')openModal('我的对局',`<div class="records-overlay">${sessionLibraryContent()}</div>`,'session-list');else if(state.page==='sessions')render();records.restoreRecordDraft(documentRef?.querySelector('#session-records-filter-form'),state.sessions,draft);}
async function loadSessions(reset=false){
  const list=state.sessions;if(list.loading&&!reset)return;const id=++list.request,guard=requests.capture();list.loading=true;list.error='';
  if(reset){list.rows=[];list.nextCursor=null;list.totals=null;}renderSessions();
  try{const data=await api(`/api/sessions?${records.recordQuery('sessions',list,reset)}`);guard.check();if(id!==state.sessions.request)return;const seen=new Set(list.rows.map(r=>r.code));list.rows.push(...data.sessions.filter(r=>!seen.has(r.code)));list.nextCursor=data.nextCursor||null;list.totals=data.totals||null;}
  catch(error){if(!error.stale&&guard.valid()&&id===state.sessions.request)list.error=error.message;}
  finally{if(guard.valid()&&id===state.sessions.request){list.loading=false;renderSessions();}}
}
async function openSessions(){if(state.page==='room'){openModal('我的对局',`<div class="records-overlay">${sessionLibraryContent()}</div>`,'session-list');await loadSessions(true);}else if(state.page==='sessions'){closeModal();await loadSessions(true);}else navigate('/sessions');}
async function sessionDetailModal(code){
  const guard=requests.capture(),request=++state.sessionRequest;openModal('本场结果','<div class="empty"><span class="spinner"></span></div>','session-loading');
  try{const data=await api(`/api/sessions/${encodeURIComponent(code)}`);guard.check();if(request!==state.sessionRequest||state.modal?.kind!=='session-loading')return;state.sessionDetailData=data.session;openModal(esc(data.session.name),records.sessionDetail(data.session,state.user.id),'session-detail');}
  catch(error){if(!error.stale&&guard.valid()&&request===state.sessionRequest&&state.modal?.kind==='session-loading')openModal('本场结果',`<div class="empty"><p>${esc(error.message)}</p>${btn('重试','session-detail','outline',`data-code="${esc(code)}"`)}</div>`,'session-error');}
}
function recordFormSelector(kind){return kind==='hands'?'#hand-records-filter-form':kind==='opponents'?'#opponent-records-filter-form':'#session-records-filter-form';}
function recordState(kind){return kind==='hands'?state.library:kind==='opponents'?state.opponents:state.sessions;}
function reloadRecords(kind){return kind==='hands'?loadLibrary(true):kind==='opponents'?loadOpponents():loadSessions(true);}
function recordRequest(kind,list){return kind==='opponents'?records.opponentQuery(list):records.recordQuery(kind,list,true);}
function renderOpponents(){
  if(state.page!=='opponents')return;
  if(state.recordComposition?.kind==='opponents'&&state.recordComposition.form.isConnected){state.recordRenderDeferred=true;return;}
  render();
}
async function loadOpponents(){
  const list=state.opponents,id=++list.request,guard=requests.capture();list.loading=true;list.error='';list.data=null;renderOpponents();
  try{const data=await api(`/api/opponents?${records.opponentQuery(list)}`);guard.check();if(state.opponents!==list||id!==list.request)return;list.data=data.opponents?{...data.opponents,excludedMiniEvents:data.excludedMiniEvents||0,excludedMiniTypes:data.excludedMiniTypes||[]}:null;list.opponentOptions=data.opponentOptions||[];}
  catch(error){if(!error.stale&&guard.valid()&&state.opponents===list&&id===list.request)list.error=error.message;}
  finally{if(guard.valid()&&state.opponents===list&&id===list.request){list.loading=false;renderOpponents();}}
}
function opponentLibrary(){const list=state.opponents;return `<main class="shell records-shell opponent-shell">${records.recordNavigation('opponents')}<div class="section-head"><div><h1 class="page-title">我的对手</h1><p class="subheading">和每位朋友之间，实际净赢或净输了多少。</p></div></div>${records.opponentFilters(list,state.rooms)}${list.error?`<div class="panel empty" role="alert"><p>${esc(list.error)}</p>${btn('重试','opponents-retry','outline small')}</div>`:list.loading?'<div class="panel empty" role="status"><span class="spinner"></span><p>正在读取对手战绩…</p></div>':records.directOpponentRecords(list.data,list.sort,{avatar})}</main>`;}
function sortDirectOpponents(sort){if(!['profit','loss','hands','recent'].includes(sort))return;state.opponents.sort=sort;renderOpponents();}
function openOpponentHands(id){
  const list=state.opponents,row=(list.data?.rows||[]).find(row=>row.id===id);if(!row)return;
  state.library.filters={...records.defaultRecordFilters(),period:list.filters.period||'all',from:list.filters.from||'',to:list.filters.to||'',opponent:id};
  state.library.room=list.room;state.library.scope='personal';state.library.favorites=false;state.library.view='hands';state.library.opponentDrilldown={id,name:row.name};state.library.opponentOptions=list.opponentOptions;state.library.hands=[];navigate('/hands');
}
async function applyRecordFilters(form){
  const kind=form.dataset.recordKind,list=recordState(kind);
  try{
    const fd=new FormData(form),filters=kind==='opponents'?records.opponentFilterValues(fd,list.filters):records.filterValues(fd,list.filters),room=kind==='opponents'||kind==='hands'&&list.scope!=='table'?String(fd.get('room')||''):list.room;
    recordRequest(kind,{...list,filters,room});
    list.filters=filters;if(kind==='hands'||kind==='opponents')list.room=room;await reloadRecords(kind);
  }catch(error){if(!error.stale)toast(error.message,true);}
}
async function setRecordPeriod(button){
  const kind=button.dataset.kind,list=recordState(kind),form=button.closest('form');
  try{
    const fd=new FormData(form),filters=kind==='opponents'?records.opponentFilterValues(fd,list.filters):records.filterValues(fd,list.filters);filters.period=button.dataset.period;
    if(filters.period==='custom'&&!filters.from&&!filters.to){const now=new Date(),today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');filters.from=today;filters.to=today;}
    const room=kind==='opponents'||kind==='hands'&&list.scope!=='table'?String(fd.get('room')||''):list.room;
    recordRequest(kind,{...list,filters,room});
    list.filters=filters;if(kind==='hands'||kind==='opponents')list.room=room;await reloadRecords(kind);
  }catch(error){if(!error.stale)toast(error.message,true);}
}
async function resetRecordFilters(kind){const list=recordState(kind);list.filters=kind==='opponents'?records.defaultOpponentFilters():records.defaultRecordFilters();if(kind==='opponents')list.room='';if(kind==='hands'){list.favorites=false;if(list.scope!=='table')list.room='';list.opponentDrilldown=null;}await reloadRecords(kind);}
const layouts=SEAT_LAYOUTS;
function seatTimeBankEnabled(room){
 const hand=room?.hand,me=room?.players?.find(p=>p.id===room.meId),now=state.clock.now(),clock=actorClock(room,now);
 return Boolean(state.connected&&!state.busy&&!state.feedbackResync&&me?.seat!=null&&me.inHand&&!me.folded&&!me.allIn&&hand?.actingId===me.id&&!hand?.runout?.active&&clock&&!clock.waiting&&clock.remaining>0&&betActionEnabled(room,'timebank'));
}
function seatHoleCards(player,room){
  if(!player.inHand||!player.cards?.length)return '';
  const own=player.id===room.meId,options=revealOptions(room,player),ready=options.some(c=>c.canReveal),complete=room.hand?.status==='complete';
  return `<div class="hole-cards ${own?'own-cards':''} ${own&&complete?'hand-finished':''}">${options.map(c=>{
    const motion=state.animations&&state.revealMotion?.handId===room.hand.id&&state.revealMotion.keys.includes(player.id+':'+c.index)&&Date.now()-state.revealMotion.at<700;
    const face=card(c.value,`mini ${state.motion?.hand?'card-enter':''}`),label=c.value?c.value.slice(0,-1).toUpperCase()+({s:'黑桃',h:'红桃',d:'方块',c:'梅花'}[c.value.slice(-1).toLowerCase()]||''):'';
    return own&&complete?btn(face,'show-card',`hole-card-button ${c.shown?'is-public':''} ${motion?'card-reveal-pop':''}`,`data-index="${c.index}" data-hand="${esc(room.hand.id)}" aria-label="${esc(c.shown?'已亮出 '+label:'向所有人亮出 '+label)}" ${!c.canReveal||state.busy||!state.connected?'disabled':''}`):`<span class="hole-card-wrap ${motion?'card-reveal-pop':''}">${face}</span>`;
  }).join('')}${own&&complete&&ready?'<small class="show-card-hint">点击单张亮牌</small>':''}</div>`;
}
function seatView(index,room){
 const player=room.players.find(p=>p.seat===index),mine=room.players.find(p=>p.id===room.meId),{relative,x,y,side,edge}=seatPlacement(room,index),hand=room.hand,isMe=player?.id===room.meId;
 const style=`left:var(--seat-x,${x}%);top:var(--seat-y,${y}%);--deal-delay:${relative*28}ms`;
 if(!player)return `<div class="seat" data-side="${side}" data-edge="${edge}" data-relative-seat="${relative}" style="${style}">${btn(`<span>＋</span>${room.status==='closed'?'已结束':mine?.seat!=null?'空座':`${index+1} 号座`}`,'sit','empty-seat',`data-seat="${index}" ${room.status==='closed'||mine?.seat!=null?'disabled':''}`)}</div>`;
 const award=payoutAwards(hand).find(a=>a.playerId===player.id),isWinner=Boolean(award),isNextActor=hand?.status==='playing'&&!hand.transition&&!hand.runout?.active&&hand.actingId===player.id,entry=lifecycle.entryBlindView(room,player),pending=room.pending?.some(p=>p.playerId===player.id);
 let label='',statusTone='neutral';
 if(pending){label='等待入座';statusTone='waiting';}
 else if(isWinner){label='收池 '+chips(award.amount,room.settings.bigBlind);statusTone='win';}
 else if(player.pendingDeparture){label=player.pendingDeparture==='stand'?'本手后离座':'本手后暂离';statusTone='waiting';}
 else if(player.waitingFor&&!(hand?.status==='playing'&&player.inHand)){label=lifecycle.squidJoinView(room,player)?.seatLabel||entry?.seatLabel||lifecycle.participation(room,player).label;statusTone='waiting';}
 else if(player.sittingOut){label='暂离';statusTone='waiting';}
 else if(!player.connected){label='离线';statusTone='waiting';}
 else if(entry){label=entry.seatLabel;statusTone='waiting';}
 // Top seats deal cards downward, so every status belongs above the identity
 // panel even when an uncontested winner has no public hand category.
 const inlineStatus=Boolean(label&&(edge==='top'||player.handCategory&&['left','right','bottom'].includes(edge)));
 const statusMarkup=`<div class="seat-status ${isWinner?'winner':''} ${inlineStatus?'seat-status-inline':''}" title="${esc(label)}" data-tone="${statusTone}">${esc(inlineStatus&&isWinner?'＋'+chips(award.amount,room.settings.bigBlind):label)}</div>`;
 const clock=isNextActor?actorClock(room,state.clock.now()):null,isActor=Boolean(clock&&!clock.waiting);
 const timer=isNextActor?`<div class="seat-turn ${isMe?'seat-turn-own':''} ${clock?.waiting?'is-preparing':''} ${clock?.urgent?'urgent':''}" data-seat-turn style="--turn-progress:${clock?.ratio??1}" aria-label="${esc(player.name)} ${clock?.waiting?'等待发牌完成':'正在思考'}"><span class="turn-dot"></span><b data-seat-clock>${clock?.waiting?'发牌中':`${clock?.remaining??20}s`}</b></div>`:'';
 const timeBank=isMe&&hand?.status==='playing'&&player.inHand&&!player.folded&&!player.allIn&&Number(room.settings.timeBankCards)>0?btn(`+30秒 · ${num(room.actions?.timeBankCards??player.timeBankCardsRemaining)}张`,'timebank','timebank-button seat-timebank-button',`aria-label="使用一张时间牌延长 30 秒，剩余 ${num(room.actions?.timeBankCards??player.timeBankCardsRemaining)} 张" title="轮到你时可使用一张时间牌延长 30 秒" data-game-action ${seatTimeBankEnabled(room)?'':'disabled'}`):'';
 const timeTools=isMe&&(timer||timeBank)?`<div class="seat-time-tools" aria-label="我的思考时间与时间牌">${timer}${timeBank}</div>`:'';
 const commitment=seatCommitment(room,player),commitmentLabel=commitment?`${player.name} ${commitment.amount!==null?`本轮已投入 ${chips(commitment.amount,room.settings.bigBlind)}${commitment.allIn?'，All-in':''}`:`All-in，本手累计投入 ${chips(commitment.contributed,room.settings.bigBlind)}，已计入底池`}`:'';
 const committedChips=commitment?`<span class="bet-chip ${commitment.allIn?'is-allin':''} ${state.motion?.actions?.includes(player.id)?'chip-enter':''}" data-unit="${getDisplayUnit()}" aria-label="${esc(commitmentLabel)}" title="${esc(commitmentLabel)}"><i class="poker-chip" aria-hidden="true"></i>${commitment.amount!==null?`<span class="bet-value">${esc(chips(commitment.amount,room.settings.bigBlind,{unitLabel:false}))}<span class="bet-unit"> ${getDisplayUnit()==='bb'?'BB':'积分'}</span></span>`:''}</span>`:'';

 const isAllIn=Boolean(hand?.status==='playing'&&player.inHand&&!player.folded&&player.allIn&&Number(player.stack)===0);
 return `<div class="seat ${isMe?'mine':''} ${player.folded?'folded':''} ${isActor?'acting':''} ${isWinner?'collecting':''} ${isAllIn?'is-allin':''}" data-player-id="${esc(player.id)}" data-side="${side}" data-edge="${edge}" data-relative-seat="${relative}" style="${style}"><div class="seat-main" data-action="player-stats" data-player="${esc(player.id)}">${seatHoleCards(player,room)}<div class="name" title="${esc(player.name)}${player.id===room.hostId?' · 房主':''}">${esc(player.name)}</div><div class="stack-value${!isAllIn&&chips(player.stack,room.settings.bigBlind,{unitLabel:false}).length>(getDisplayUnit()==='bb'?3:5)?' stack-wide':''}">${isAllIn?'<span class="seat-allin-label">All-in</span>':`${esc(chips(player.stack,room.settings.bigBlind,{unitLabel:false}))}${getDisplayUnit()==='bb'?' <small class="stack-unit">BB</small>':''}`}</div><div class="seat-identity">${btn(avatar(player,''),'player-stats','seat-avatar-button',`data-player="${esc(player.id)}" aria-label="查看 ${esc(player.name)} 的数据" aria-haspopup="dialog"`)}${isMe?'':timer}</div>${inlineStatus?'':statusMarkup}<div class="seat-label">${hand&&hand.buttonSeat===index?'<b class="dealer-button" title="庄家" aria-label="庄家">D</b>':''}${hand&&!hand.bombPot&&hand.smallBlindSeat===index?'<b class="blind" title="小盲">SB</b>':''}${hand&&!hand.bombPot&&hand.bigBlindSeat===index?'<b class="blind" title="大盲">BB</b>':''}${lifecycle.playerSquidCount(room,player)>0?`<b class="squid-mark squid-count" title="本轮已获 ${lifecycle.playerSquidCount(room,player)} 条鱼">鱼×${lifecycle.playerSquidCount(room,player)}</b>`:''}</div></div>${timeTools}<div class="seat-hand-info">${statsUI.renderEquityBadge(inlineStatus||hand?.status!=='playing'?undefined:hand?.equity?.players.find(p=>p.id===player.id),{approximate:hand?.equity?.method==='monte-carlo'})}${renderHandCategory(player.handCategory,{motion:state.animations?state.handCategoryMotion?.find(m=>m.handId===hand?.id&&m.playerId===player.id):null})}${inlineStatus?statusMarkup:''}</div>${reactionBubble(player.id)}${committedChips}</div>`;
}
function boardCard(value,{flipping=false,delay=0,age=0,rabbit=false}={}){
  const face=value?card(value,'board-face'):'';
  return `<span class="board-slot ${value?'is-revealed':''} ${value&&flipping&&age<650?'is-flipping':''} ${rabbit?'is-rabbit':''}" style="--flip-delay:${Math.max(0,delay)}ms;--motion-age:${Math.max(0,age)}ms"><span class="card face-down board-back" ${value?'aria-hidden="true"':'aria-label="公共牌尚未翻开"'}></span>${face}</span>`;
}
async function playerStatsModal(playerId,scope='table'){
  const room=state.room,player=room?.players.find(p=>p.id===playerId);
  if(!player||!['table','career'].includes(scope))return;
  const guard=requests.capture(),view={roomCode:room.code,playerId,player,scope,data:null,error:'',loading:true};
  state.playerStats=view;openModal('选手数据',`${historyTurnNotice()}${renderPlayerStats(view)}`,'player-stats');
  try{
    const data=await api(`/api/rooms/${encodeURIComponent(room.code)}/players/${encodeURIComponent(playerId)}/stats?scope=${scope}`);
    guard.check();if(state.playerStats!==view||state.modal?.kind!=='player-stats'||state.room?.code!==view.roomCode)return;
    view.data=data;
  }catch(error){if(error.stale||state.playerStats!==view||state.modal?.kind!=='player-stats')return;view.error=error.message;}
  finally{if(guard.valid()&&state.playerStats===view&&state.modal?.kind==='player-stats'&&state.room?.code===view.roomCode){view.loading=false;openModal('选手数据',`${historyTurnNotice()}${renderPlayerStats(view)}`,'player-stats');avatarCache.hydrate(dialog);tick();}}
}
function interactionModal(playerId){
  const room=state.room;if(!room)return;
  const me=room.players.find(p=>p.id===room.meId),targets=room.players.filter(p=>p.seat!=null&&p.id!==room.meId);
  const direct=Boolean(playerId),target=direct?targets.find(p=>p.id===playerId):targets.find(p=>p.id===state.funTarget)||targets[0];
  if(direct&&!target){toast('这位朋友已离座，请重新选择');return;}
  state.funTarget=target?.id||'';
  const canSend=me?.seat!=null&&room.status!=='closed'&&state.connected&&!state.feedbackResync&&Boolean(target)&&!state.chatBusy;
  openModal('牌桌互动',`${direct?'':`<div class="interaction-targets" aria-label="选择互动对象">${targets.map(p=>btn(esc(p.name),'interact-target',p.id===state.funTarget?'selected':'',`data-player="${esc(p.id)}" aria-pressed="${p.id===state.funTarget}"`)).join('')}</div>`}${target?`<div class="interaction-recipient">${avatar(target)}<p class="interaction-caption">送给 <strong>${esc(target.name)}</strong></p>${direct&&targets.length>1?btn('换个人','interact','ghost small'):''}</div>`:'<p class="note">朋友入座后就可以互动。</p>'}<div class="throwable-grid">${THROWABLES.map(e=>btn(`<span aria-hidden="true">${e.glyph}</span><b>${esc(e.label)}</b>`,'throw','throwable-option',`data-emote="${e.id}" data-target="${esc(target?.id||'')}" data-room="${esc(room.code)}" aria-label="${esc(e.label)}${target?'给 '+esc(target.name):''}" ${canSend?'':'disabled'}`)).join('')}</div><p class="note" data-interaction-hint>${me?.seat==null?'入座后可以发送互动。':room.status==='closed'?'本桌已结束。':!state.connected||state.feedbackResync?'正在同步牌桌，恢复连接后再互动。':'选择上方玩家，再点想发送的互动 · 每 3 秒一次'}</p><div class="interaction-footer">${btn(state.fun?'娱乐特效：开':'娱乐特效：关','toggle-fun','outline small',`aria-pressed="${state.fun}"`)}<small>仅影响你看到的特效</small></div>`,'interactions');
  avatarCache.hydrate(dialog);
}
async function sendThrow(emote,targetId,roomCode){
  const room=state.room;if(!room||state.chatBusy||!THROWABLES.some(e=>e.id===emote))return;
  if(room.code!==roomCode)return;
  if(!state.connected||state.feedbackResync){toast('正在同步牌桌，请稍后再互动');return;}
  if(room.status==='closed'){closeModal();toast('本桌已结束');return;}
  if(Date.now()<state.throwUntil){toast('等一下，互动每 3 秒可发送一次');return;}
  if(targetId===room.meId||!room.players.some(p=>p.id===targetId&&p.seat!=null)||room.players.find(p=>p.id===room.meId)?.seat==null){closeModal();toast('你或对方已离座，请重新选择');return;}
  closeModal();await sendChat('throw',emote,targetId);
}
function syncInteractionPanel(){
  if(state.modal?.kind!=='interactions')return;
  const room=state.room,buttons=dialog.querySelectorAll('[data-action="throw"]'),me=room?.players.find(p=>p.id===room.meId);
  let validTarget=false;
  for(const button of buttons){const valid=room?.code===button.dataset.room&&button.dataset.target!==room?.meId&&room?.players.some(p=>p.id===button.dataset.target&&p.seat!=null);validTarget ||= Boolean(valid);button.disabled=!valid||me?.seat==null||room?.status==='closed'||!state.connected||state.feedbackResync||state.chatBusy;}
  const hint=dialog.querySelector('[data-interaction-hint]');
  if(hint)hint.textContent=me?.seat==null?'入座后可以发送互动。':room?.status==='closed'?'本桌已结束。':!validTarget?'这位朋友已离座，请重新选择。':!state.connected||state.feedbackResync?'正在同步牌桌，恢复连接后再互动。':'选择上方玩家，再点想发送的互动 · 每 3 秒一次';
}
function formatAction(action){if(typeof action==='object')return eventText(action);return ({fold:'弃牌',check:'过牌',call:'跟注',raise:'加注',allin:'ALL IN',sitout:'暂离',smallBlind:'小盲',bigBlind:'大盲',small_blind:'小盲',big_blind:'大盲',ante:'前注',entryBlind:'入桌大盲',deadBlind:'补小盲（不抵跟注）'})[action]||String(action||'');}
function tableCenter(room){
  const hand=room.hand,bb=room.settings.bigBlind,ready=room.players.filter(p=>p.seat!=null&&!p.sittingOut&&p.stack>0).length>=2;

  if(!hand)return `<div class="table-center is-idle"><div class="table-idle"><strong>${room.status==='closed'?'牌桌已结束':ready?'朋友已就位':'等待入座'}</strong><p>${room.status==='closed'?'可查看历史牌局。':ready?'房主开始后发牌。':room.players.some(p=>p.id===room.meId&&p.seat!=null)?'等待朋友入座。':'点击空座入座。'}</p>${room.status==='closed'?btn('回顾牌局','history','outline'):!ready?btn('邀请朋友','invite','outline'):''}</div></div>`;
  const pots=chipPots(hand),showPotTiers=hand.status==='complete'||room.players.some(p=>p.inHand&&p.allIn&&!p.folded),total=hand.pot??pots.reduce((sum,p)=>sum+p.amount,0),uncalled=(hand.uncalledBets||[]).reduce((sum,p)=>sum+p.amount,0);
  const awards=payoutAwards(hand),winners=awards.map(a=>room.players.find(p=>p.id===a.playerId)?.name||'牌友');
  // A street is one reveal: flop cards share both start time and flip phase.
  // Chat/profile renders retain that age instead of replaying an open card.
  const boardMotion=state.animations&&state.boardMotion?.handId===hand.id?state.boardMotion:null,boardMotionAge=Date.now()-(boardMotion?.at||0);
  const potView=`<div class="pot-cluster" aria-label="底池和边池"><${hand.equity?'button type="button" data-action="equity-details" aria-label="查看主池及各边池胜率" aria-haspopup="dialog"':'div'} class="pot-total${hand.equity?' has-details':''}"><i class="poker-chip" aria-hidden="true"></i><span>${hand.status==='complete'?'本手总池':'总底池'}</span><strong>${esc(chips(total,bb))}</strong></${hand.equity?'button':'div'}>${showPotTiers&&(pots.length>1||uncalled>0)?`<div class="pot-breakdown" tabindex="0" aria-label="各底池金额，可左右滑动查看">${pots.map(p=>`<span class="pot-token ${p.index?'side-pot':''}"><i class="poker-chip" aria-hidden="true"></i>${p.label}<b>${esc(chips(p.amount,bb))}</b></span>`).join('')}${uncalled>0?`<span class="uncalled-pot">待跟注 ${esc(chips(uncalled,bb))}</span>`:''}</div>`:''}</div>`;
  return `<div class="table-center has-hand ${hand.equity?'has-equity':''} ${hand.status==='complete'?'is-complete':''}"><div class="table-hand-center">${potView}<div class="board">${Array.from({length:5},(_,i)=>boardCard((hand.rabbit?.board||hand.board)?.[i],{flipping:boardMotion&&i>=boardMotion.from&&i<boardMotion.count,age:boardMotionAge,rabbit:Boolean(hand.rabbit&&i>=hand.rabbit.originalCount)})).join('')}</div>${hand.rabbit?'<div class="rabbit-note">🐇 补看余牌 · 不计输赢</div>':''}${hand.status==='complete'?`<div class="hand-result"><p class="result-title">${winners.length?`${esc(winners.join('、'))} 收池`:'本手已结束'}</p><span class="result-countdown" data-auto-deal>${esc(autoDealText(room))}</span></div>`:`<div class="street-label">第 ${num(hand.number)} 手 · ${esc(streetNames[hand.street]||hand.street)}</div>`}</div></div>`;
}
function seatActions(room,me){
  const closed=room.status==='closed',playing=room.hand?.status==='playing',seated=me?.seat!=null&&!closed;
  if(!seated)return '';
  const status=lifecycle.participation(room,me),queued=lifecycle.departurePlan(room,me,'stand').queued;
  return `${seated&&(me.pendingDeparture||me.waitingFor||me.sittingOut||me.entryBlind?.required)?`<div class="lifecycle-state"><strong>${esc(status.label)}</strong><small>${esc(status.note)}</small>${lifecycle.entryBlindView(room,me)?.canChoose?btn('参与方式','entry-blind','outline small'):''}${status.canCancel?btn('取消安排','cancel-departure','outline small'):''}</div>`:''}<div class="seat-actions">${seated?`${btn('补码','buyin','ghost',me.pendingDeparture==='stand'?'disabled title="请先取消离座安排"':'')}${me.pendingDeparture?'':`${btn(me.sittingOut?'继续参与':queued?'本手后暂离':'暂离','sitout','ghost')}${btn(queued?'本手后离座':'离开座位','stand','ghost')}`}`:''}</div>`;
}
function roomView(){
  const room=state.room;if(!room)return errorPage();const me=room.players.find(p=>p.id===room.meId),host=room.hostId===room.meId,closed=room.status==='closed';
  if(closed)return renderRoomResults(room,{unitToggle:moneyUnitToggle()});
  const topup=me?.seat!=null&&!closed?`<div class="table-topup ${Number(me.pendingBuyIn)>0?'is-pending':''}">${btn('<span aria-hidden="true">＋</span> 补码','buyin','table-topup-button',`data-topup-button data-blocked="${me.pendingDeparture==='stand'}" ${state.busy||!state.connected||state.feedbackResync||me.pendingDeparture==='stand'?'disabled':''}`)}<span class="table-topup-status" data-topup-status>${Number(me.pendingBuyIn)>0?`待加 ${esc(chips(me.pendingBuyIn,room.settings.bigBlind))} · 下一手`:`筹码 ${esc(chips(me.stack,room.settings.bigBlind))}`}</span></div>`:'';
  return `<main class="room-shell" data-room="${esc(room.code)}"><div class="room-head"><div class="room-heading"><h2>${esc(room.name)}</h2><div class="room-meta"><span>${room.players.filter(p=>p.seat!=null).length}/${room.settings.maxPlayers} 人</span><span>·</span><span data-connection><i class="dot ${state.connected?'':'off'}"></i>${esc(state.connection)}</span></div></div><div class="room-head-tools">${lifecycle.entryBlindView(room,me)?.canChoose?btn(lifecycle.entryBlindView(room,me).modeLabel+' ▾','entry-blind','table-entry-button outline small'):''}${topup}${btn('邀请','invite','outline small',closed?'disabled':'')}</div>${roomStatusBar(room)}</div>${state.commitmentMismatch?'<div class="room-notice negative" role="alert">发牌承诺与此前不同，请暂停参与并保存记录。</div>':''}${closed?'<div class="room-notice">牌桌已结束，积分和牌谱已保存。</div>':''}<div class="game-grid"><section class="table-column" style="--motion-age:${Math.max(0,Date.now()-(state.motion?.at||Date.now()))}ms"><div class="table-stage" data-seat-count="${room.settings.maxPlayers}" aria-label="德州牌桌"><div class="felt"></div>${tableCenter(room)}${Array.from({length:room.settings.maxPlayers},(_,i)=>seatView(i,room)).join('')}</div><div class="table-bottom" data-turn="${esc(room.hand?.id)}:${esc(room.hand?.actionSeq)}">${actionArea(room,me,host)}</div></section></div><nav class="table-toolbar" aria-label="牌桌工具">${btn(`聊天${state.chatUnread?` <b class="unread">${state.chatUnread}</b>`:''}`,'toggle-chat',state.chatOpen?'active':'',`id="chat-toggle" aria-expanded="${state.chatOpen}" aria-controls="chat-drawer"`)}${btn('互动','interact')}${btn('牌谱','history')}${btn('本场','table-info')}${btn('菜单','room-menu')}</nav>${chatPanel(room)}</main>`;
}
function roomStatusBar(room){
  const bb=room.settings.bigBlind;
  return `<div class="room-status-bar" aria-label="本桌摘要"><button type="button" class="room-status-main" data-action="table-info" title="1 BB = ${esc(chips(bb,bb,{unit:'points'}))}" aria-label="查看盲注、时间和玩法详情"><span class="table-blinds">盲注 <b>${esc(chips(room.settings.smallBlind,bb,{unitLabel:false}))} / ${esc(chips(bb,bb))}</b></span><span class="room-countdown" data-room-clock="compact" aria-label="${esc(roomClock(room))}">${esc(roomClock(room,undefined,true))}</span></button>${gameModeMarkers(room)}</div>`;
}
function gameModeMarkers(room){
  if(room.status==='closed')return '';
  const squid=room.mini?.squid,bb=room.settings.bigBlind,progress=lifecycle.squidProgress(room);
  const unit=squid?.active?squid.unit??room.settings.squidUnit??Number(room.settings.squidUnitBB||0)*bb:room.settings.squidUnit??Number(room.settings.squidUnitBB||0)*bb;
  const fishState=squid?.active?progress.mode==='unlimited'?`余 ${progress.remaining??'—'}/${progress.budget??'—'} · ${progress.missing}人无鱼`:`${progress.holders}/${progress.participants} 有鱼`:squid?.lastResult?`第 ${num(squid.lastResult.round)} 轮已结算`:`${progress.name}已开启`,fishTitle=`${progress.name}${squid?.active?` · 第 ${num(squid.round)} 轮`:''} · 每条 ${chips(unit,bb)}${lifecycle.squidMode(room)?.label?' · '+lifecycle.squidMode(room).label:''}`;
  const fishShort=squid?.active?progress.mode==='unlimited'?`无限鱼 余${progress.remaining??'—'}/${progress.budget??'—'}`:`鱿鱼 ${progress.holders}/${progress.participants}`:progress.mode==='unlimited'?'无限鱼':'鱿鱼';
  const fish=squid?.active||room.settings.squid?btn(`<span aria-hidden="true">🐙</span><span class="mode-state">${esc(fishShort)}</span>`,'table-info',`game-mode squid ${progress.mode==='unlimited'?'unlimited':''} ${squid?.active?'active':''}`,`title="${esc(fishTitle+'，'+fishState)}" aria-label="${esc(fishTitle+'，'+fishState+'，查看详情')}"`):'';
  const bomb=bombStatus(room),ante=room.settings.bombAnte??Number(room.settings.bombAnteBB||0)*bb,pot=bomb?btn(`<span aria-hidden="true">💣</span><span class="mode-state" data-bomb-status="compact">${esc(bomb.shortLabel)}</span>`,'table-info',`game-mode bomb ${bomb.active?'active':''}`,`aria-label="${esc(bomb.label)}，每人前注 ${esc(chips(ante,bb))}，查看详情" title="每 ${num(room.settings.bombIntervalMinutes||10)} 分钟 · 每人前注 ${esc(chips(ante,bb))}" data-bomb-marker`):'';
  return fish||pot?`<div class="room-status-modes game-mode-markers" aria-label="本桌玩法">${fish}${pot}</div>`:'';
}
function tableInfoModal(){openModal('本场详情',tableInfoBody(state.room),'table-info');}
function tableInfoBody(r){const me=r.players.find(p=>p.id===r.meId);return `<div class="table-info-section" data-table-info="settings"><h3>牌桌设置</h3><div class="data-row"><span>盲注</span><strong>${chips(r.settings.smallBlind,r.settings.bigBlind,{unitLabel:false})} / ${chips(r.settings.bigBlind,r.settings.bigBlind)}</strong></div><p class="note">1 BB = ${num(r.settings.bigBlind)} 积分</p><div class="data-row"><span>牌桌时间</span><strong data-room-clock>${esc(roomClock(r))}</strong></div><div class="data-row"><span>思考时间</span><strong>${num(r.settings.actionSeconds)} 秒</strong></div></div><div class="table-info-section" data-table-info="chips"><h3>我的筹码</h3><div class="data-row"><span>累计带入</span><strong>${chips(me?.totalBuyIn||0)}</strong></div><div class="data-row"><span>本场盈亏</span><strong class="${profitClass(me?.sessionProfit)}">${signedChips(me?.sessionProfit||0)}</strong></div>${me?.squidReserve?`<div class="data-row"><span>鱿鱼预留</span><strong>${chips(me.squidReserve)}</strong></div>`:''}</div>${r.settings.squid||r.settings.bombPot?`<div class="table-info-section" data-table-info="mini"><h3>小游戏</h3>${miniPanel(r)}<p class="note" data-mini-cutoff ${!miniCutoff(r)?'hidden':''}>最后 5 分钟不再开启新鱿鱼轮或炸弹池。</p></div>`:''}${r.hand?.log?.length?`<div class="table-info-section" data-table-info="activity"><h3>本手动态</h3><div class="activity-list">${r.hand.log.slice(-20).reverse().map(e=>`<div>${esc(eventText(e,r.players))}</div>`).join('')}</div></div>`:''}${(r.messages||[]).length?`<div class="table-info-section" data-table-info="notices">${r.messages.map(m=>`<p class="note">${esc(m)}</p>`).join('')}</div>`:''}<div class="modal-footer" data-table-info="footer">${btn('整场输赢','session-detail','outline',`data-code="${esc(r.code)}"`)}${btn('我的数据','career','outline')}${btn('上一手回放','last-hand','primary',!r.hand?'disabled':'')}</div>`;}
function tableInfoSnapshot(room){
  if(!room)return '';
  return JSON.stringify([room.code,room.status,room.settings,room.endsAt,room.expiryMode,room.miniGamesCutoffAt,room.nextBombAt,room.mini,
    (room.players||[]).map(p=>[p.id,p.name,p.seat,p.stack,p.totalBuyIn,p.sessionProfit,p.squidReserve,p.sittingOut,p.waitingFor,p.connected,p.pendingDeparture,p.entryBlind,p.squidJoin]),
    room.hand&&[room.hand.id,room.hand.status,room.hand.actionSeq,room.hand.bombPot,room.hand.squidRound,room.hand.log?.slice(-20)],room.messages]);
}
function refreshTableInfo(previous,room){
  if(state.modal?.kind!=='table-info'||tableInfoSnapshot(previous)===tableInfoSnapshot(room))return;
  const body=dialog.querySelector('.modal-body');if(!body)return;
  const next=document.createElement('div');next.innerHTML=tableInfoBody(room);
  const scroll=dialog.scrollTop,bodyScroll=body.scrollTop,existing=new Map([...body.children].map(el=>[el.dataset.tableInfo,el]));
  let anchor=body.firstElementChild;
  for(const fresh of [...next.children]){
    let current=existing.get(fresh.dataset.tableInfo);existing.delete(fresh.dataset.tableInfo);
    if(!current)current=fresh;
    else if(current.innerHTML!==fresh.innerHTML){
      const expanded=[...current.querySelectorAll('details')].map((el,index)=>({key:el.id||el.querySelector('summary')?.textContent||String(index),open:el.open})),sectionScroll=current.scrollTop;
      current.innerHTML=fresh.innerHTML;
      [...current.querySelectorAll('details')].forEach((el,index)=>{const old=expanded.find(item=>item.key===(el.id||el.querySelector('summary')?.textContent||String(index)));if(old)el.open=old.open;});
      current.scrollTop=sectionScroll;
    }
    if(current!==anchor)body.insertBefore(current,anchor);anchor=current.nextElementSibling;
  }
  for(const old of existing.values())old.remove();
  body.scrollTop=bodyScroll;dialog.scrollTop=scroll;
}

function paintStats(){
  if(state.modal?.kind==='career'){
    const draft=statsUI.captureStatsDraft(dialog.querySelector('#stats-filter-form'),state.statsView,document.activeElement),scroll=dialog.scrollTop;
    openModal('我的数据',statsUI.renderStatsPage(state.statsView.data,state.statsView,{rooms:state.rooms,currentRoom:state.room?.code,compact:true}),'career');
    statsUI.restoreStatsDraft(dialog.querySelector('#stats-filter-form'),state.statsView,draft);dialog.scrollTop=scroll;
  }else if(state.page==='career')render();
}
async function loadStats(){
  const guard=requests.capture(),view=state.statsView,request=++view.request;
  let query;try{query=statsUI.statsQuery(view);}catch(error){view.error=error.message;view.loading=false;paintStats();return;}
  view.loading=true;view.error='';paintStats();
  try{const data=await api(`/api/stats?${query}`);guard.check();if(request!==view.request||view!==state.statsView)return;view.data=data;}
  catch(error){if(error.stale||!guard.valid()||request!==view.request)return;view.error=error.message;}
  finally{if(guard.valid()&&request===view.request&&view===state.statsView){view.loading=false;paintStats();}}
}
async function careerModal(){openModal('我的数据',statsUI.renderStatsPage(state.statsView.data,state.statsView,{rooms:state.rooms,currentRoom:state.room?.code,compact:true}),'career');await loadStats();}
async function applyStatsFilters(form){if(!form)return;const fd=new FormData(form);state.statsView.filters=statsUI.statsFilterValues(fd,state.statsView.filters);state.statsView.room=String(fd.get('room')||'');await loadStats();}
async function setStatsPeriod(period){const form=document.querySelector('#stats-filter-form');if(form){const fd=new FormData(form);state.statsView.filters=statsUI.statsFilterValues(fd,state.statsView.filters);state.statsView.room=String(fd.get('room')||'');}state.statsView.filters.period=period;if(period==='custom'){state.statsView.error='';paintStats();}else await loadStats();}
function equityDetails(){const h=state.room?.hand,e=h?.equity;if(!e)return;const scroll=dialog.scrollTop,expanded=Boolean(dialog.querySelector('.help-details[open]'));const pct=v=>`${Number(v).toFixed(1)}%`,name=id=>esc(state.room.players.find(p=>p.id===id)?.name||'牌友');openModal('全下胜率',`<div class="board">${Array.from({length:5},(_,i)=>card(h.board[i],'mini',!h.board[i])).join('')}</div><p class="note">按当前已公开底牌与公共牌计算。座位上的百分比为主池权益，平局按分得的份额计入；按翻牌三张、转牌一张、河牌一张更新。</p>${e.pots.map((pot,i)=>`<section class="table-info-section"><h3>${i===0?'主池':`边池 ${i}`} · ${chips(pot.amount)}</h3>${pot.players.filter(p=>pot.eligibleIds.includes(p.id)).map(p=>`<div class="data-row"><span>${name(p.id)}</span><strong>${e.method==='monte-carlo'?'≈':''}${pct(p.equity)}</strong></div>`).join('')}</section>`).join('')}<details class="help-details"><summary>独赢、平局与估算精度</summary>${e.players.map(p=>`<p class="note">${name(p.id)}：独赢主池 ${pct(p.winPct)} · 平局 ${pct(p.tiePct)}</p>`).join('')}<p class="note">${e.method==='exact'?`已穷举 ${num(e.samples)} 种剩余公共牌组合。`:`抽样 ${num(e.samples)} 次，95% 误差范围最多约 ±${Number(e.error95Pct).toFixed(1)} 个百分点。`}计算不会使用未发出的牌、烧牌或他人弃牌。</p></details>`,'equity');if(expanded)dialog.querySelector('.help-details').open=true;dialog.scrollTop=scroll;}

function miniPanel(room){
  let html='';const squid=room.mini?.squid,mode=lifecycle.squidMode(room),join=lifecycle.squidJoinView(room,room.players.find(p=>p.id===room.meId));
  if(room.settings.squid){const progress=lifecycle.squidProgress(room),unit=squid?.active?squid.unit??room.settings.squidUnit??Number(room.settings.squidUnitBB||0)*room.settings.bigBlind:room.settings.squidUnit??Number(room.settings.squidUnitBB||0)*room.settings.bigBlind,extra=squid?.active?squid.extraTokens??room.settings.squidExtraTokens??3:room.settings.squidExtraTokens??3;html+=`<div class="mini-status"><strong>${progress.name} <span class="gold">${squid?.active?`第 ${squid.round} 轮${mode?.paused?' · 等待玩家':''}`:room.status==='closed'?'已结束':miniCutoff(room)?'不再开启新一轮':'等待新一轮'}</span></strong><p>每条 ${esc(chips(unit,room.settings.bigBlind))}。${squid?.active?progress.mode==='unlimited'?`本轮 ${progress.budget??'—'} 条鱼，剩余 ${progress.remaining??'—'} 条；${progress.missing} 人还没鱼。`:`${progress.holders} / ${progress.participants} 人有鱼${progress.budget===null?'':`，本轮共 ${progress.budget} 条，剩余 ${progress.remaining} 条`}。`:''}${progress.mode==='unlimited'?`开轮鱼数 = 实际参与人数 + ${num(extra)}，每成功加入一位新人再加 1 条；独赢主池可重复拿鱼。只剩 1 人没鱼或鱼发完即结轮，先达到哪个按哪个。无鱼者向有鱼者按已拿鱼数支付，未发出的鱼不计费。`:'每人最多 1 条鱼；新人以 0 鱼入轮，总鱼数加 1。无鱼者按每位有鱼者的实际鱼数支付。'}</p>${squid?.active?`<p class="note">${esc(mode?.note||'符合条件的新人可从下一手加入本轮；离开可在菜单安排。')}</p>${join?`<p class="lifecycle-note"><strong>${esc(join.label)}</strong>：${esc(join.note)}${join.requiredReserve!==null?`<br>预计本人${join.minimum?'至少':''}预留 ${chips(join.requiredReserve,room.settings.bigBlind)}${join.budget===null?'':`，加入后${join.minimum?'至少':'共'} ${num(join.budget)} 条鱼`}；以实际发牌时为准。`: ''}</p>`:''}<div class="squid-player-counts" aria-label="本轮各玩家鱼数">${(squid.participants||[]).map(id=>{const p=room.players.find(p=>p.id===id);return `<span class="${progress.counts[id]>0?'has-fish':'no-fish'}"><b>${esc(p?.name||'已离座玩家')}</b><strong>${progress.counts[id]>0?`鱼×${progress.counts[id]}`:'无鱼'}</strong></span>`;}).join('')}</div>`:''}</div>`;}
  if(room.settings.bombPot)html+=`<div class="mini-status"><strong>炸弹池 <span class="gold">每 ${num(room.settings.bombIntervalMinutes||10)} 分钟</span></strong><p>${esc(bombStatus(room)?.label||'本场不再触发新炸弹池')}。每人 ${chips(room.settings.bombAnteBB*room.settings.bigBlind,room.settings.bigBlind)} 前注，直接发翻牌，无翻前下注。计时到点后在下一手符合条件时触发，不中断当前手。</p></div>`;
  const result=squid?.lastResult;if(result){const change=result.changes?.[room.meId];html+=`<p class="squid-result-note"><strong>${lifecycle.squidName(result.mode)} · 第 ${num(result.round)} 轮已结算</strong><br>${result.tokensExhausted?'本轮鱼已发完。':result.reason==='absent'?'无鱼玩家暂不可参与，按现有鱼数结算。':result.reason==='partial'?'按现有鱼数提前结算。':'本轮已完成。'}${Number.isSafeInteger(change)?` 我的鱿鱼盈亏 <b class="${profitClass(change)}">${esc(chips(change,room.settings.bigBlind,{signed:true}))}</b>。`:''}已计入本场小游戏盈亏。</p>`;}
  const settlement=lifecycle.squidSettlement(room);if(settlement?.blocked&&room.expiryMode!=='wait-squid')html+=`<p class="squid-settle-note">${settlement.canSettle?'原轮可参与人数持续不足，可在两手之间按现有标记结算。':`原轮不足两人可参与，等待返回、补码或补盲；满 ${num(settlement.waitSeconds)} 秒后，本轮在线玩家可在两手之间结算。`}</p>${settlement.canSettle?btn('结算本轮鱿鱼','settle-squid','outline small'):''}`;
  return html;
}
function bombStatus(room,now=state.clock.now()){
  if(room.status==='closed')return null;
  if(room.hand?.bombPot&&room.hand.status==='playing')return {active:true,label:'本手炸弹池',shortLabel:'炸弹本手'};
  if(!room.settings.bombPot||room.miniGamesCutoffAt&&now>=Number(room.miniGamesCutoffAt))return null;
  const next=Number(room.nextBombAt);
  if(!next)return {active:false,label:'炸弹池已开启',shortLabel:'炸弹'};
  const seconds=Math.max(0,Math.ceil((next-now)/1000));
  const clock=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  return {active:false,label:seconds?`下次炸弹 ${clock}`:'炸弹待触发 · 等合适的下一手',shortLabel:seconds?`炸弹 ${clock}`:'炸弹待开'};
}
function autoDealText(room,now=state.clock.now()){
  if(room.status==='closed')return '牌桌已结束';
  if(!room.hand)return '由房主开始第一手';
  if(room.hand.status!=='playing'&&room.mini?.squid?.absentSettlementAt){const seconds=Math.max(0,Math.ceil((Number(room.mini.squid.absentSettlementAt)-now)/1000));return seconds?`${seconds} 秒后按现有标记结轮`:'正在结算本轮鱿鱼…';}
  if(room.hand.status==='playing')return room.expiryMode==='wait-squid'?'已到时，本手后等待鱿鱼恢复':room.autoDeal?.paused?'本手结束后暂停自动发牌':lifecycle.squidMode(room)?.paused?'本手结束后等待原轮玩家':'每手结束后自动继续';
  const auto=room.autoDeal||{};
  if(room.expiryMode==='wait-squid')return '已到时，等待原轮鱿鱼恢复';
  if(room.hand.rabbit?.active)return auto.paused?'补看余牌中 · 自动发牌已暂停':'补看余牌中 · 稍后自动继续';
  if(auto.paused)return '自动发牌已暂停';
  const grace=auto.rebuyGrace;if(grace?.pendingIds?.length&&now>=grace.startsAt&&now<grace.endsAt)return `补码等待 · 还剩 ${Math.ceil((grace.endsAt-now)/1000)} 秒`;
  if(auto.nextHandAt){const seconds=Math.max(0,Math.ceil((Number(auto.nextHandAt)-now)/1000));return seconds?`${seconds} 秒后自动发下一手`:'正在准备下一手…';}
  return ({insufficient_players:'等待至少 2 位可参与的玩家',waiting_players:'等待朋友入座或补码',squid_reserve:'鱿鱼预留积分不足，请补码',expired:'本场时间已到',closed:'牌桌已结束'})[auto.waitReason]||auto.waitReason||'等待可参与的玩家，满足条件后自动继续';
}
function actionArea(room,me,host){
  const hand=room.hand,a=room.actions||{},playing=hand?.status==='playing',closed=room.status==='closed',active=Boolean(a.canAct&&playing&&!hand.transition&&!hand.runout?.active),eligible=room.players.filter(p=>p.seat!=null&&!p.sittingOut&&p.stack>0).length;
  const blocked=state.busy||!state.connected||state.feedbackResync,canRaise=active&&a.canRaise,amount=normalizeBetAmount(room,state.raise),turnKey=betTurnKey(room);
  const shortAllIn=active&&!canRaise&&a.canAllIn&&Number(a.maxRaiseTo)>Number(hand.currentBet);
  const disabled=action=>blocked||!betActionEnabled(room,action)?'disabled':'';
  const submitting=state.pendingCommand?.fast&&state.pendingCommand.code===room.code&&state.pendingCommand.userId===room.meId?state.pendingCommand:null;
  const text=submitting?submitting.label:closed?'本场已结算':active?(me?.pendingDeparture?(me.pendingDeparture==='stand'?'本手后离座 · ':'本手后暂离 · '):'')+(a.callAmount?`跟注 ${chips(a.callAmount)}`:'可过牌'):me?.seat!=null&&(me?.waitingFor||me?.entryBlind?.required)&&!(playing&&me.inHand)?lifecycle.participation(room,me).label:me?.sittingOut?'你已暂离':me?.seat==null?'观战中 · 点击空座入座':playing?(hand.transition?({street:'准备翻牌…',showdown:hand.transition.revealed?'正在比牌…':'准备摊牌…',award:'准备收池…'}[hand.transition.kind]||'稍候…'):hand.runout?.active?'All-in 跑牌中':me?.folded?'已弃牌':me?.allIn?'All-in':a.turnAvailable?(hand.board?.length?'正在翻牌…':'正在发牌…'):'等待行动'):hand?'本手结束':'朋友就位后开始';
  const departed=hand?.status==='complete'?room.players.filter(p=>p.id!==room.meId&&p.inHand&&p.seat==null&&!p.folded&&p.cards?.some(Boolean)):[];
  const showdown=departed.length?`<div class="detached-showdown" aria-label="离座玩家摊牌">${departed.map(p=>`<div class="detached-showdown-player"><b>${esc(p.name)}<small>本手已离座 · 摊牌</small></b>${seatHoleCards(p,room)}</div>`).join('')}</div>`:'';
  const entry=lifecycle.entryBlindView(room,me),participation=lifecycle.participation(room,me);
  const notices=me?.pendingDeparture&&participation.canCancel?btn(me.pendingDeparture==='stand'?'取消离座':'取消暂离','cancel-departure','dock-context-action'):'';
  const contextActions=`${!hand&&!closed&&host?btn('开始第一手','start','primary dock-context-action',eligible<2||blocked?'disabled':''):''}${hand&&!playing&&!closed&&host&&room.autoDeal?.paused?btn('继续发牌','resume-deal','primary dock-context-action',blocked?'disabled':''):''}${!closed&&me?.sittingOut?btn('继续参与','sitout','dock-context-action'):''}${!closed&&lifecycle.squidSettlement(room)?.canSettle?btn('结算本轮','settle-squid','dock-context-action'):''}${closed?btn('查看牌谱','history','dock-context-action'):''}${notices}`;
  const rows=canRaise?betPresetOptions(room):[],placeholderPresets=[['third','1/3池'],['half','1/2池'],['two-thirds','2/3池'],['pot','满池']].map(([id,label])=>({id,label,available:false}));
  const open=Boolean(state.raisePanelOpen&&canRaise&&!blocked),raiseLabel=`${betActionLabel(room,amount)} ${chips(amount)}`;
  const shortcuts=(rows.length?rows:placeholderPresets).map(p=>{
    const label=p.available?`${p.label}，${betActionLabel(room,p.amount)} ${chips(p.amount)}，点击直接下注`:`${p.label}，当前不可下注`;
    return btn(`<span class="bet-preset-label">${p.label}${p.available?' · '+betActionLabel(room,p.amount):''}</span><strong class="bet-preset-amount">${p.available?esc(chips(p.amount)):'—'}</strong>`,'raise-preset','bet-preset',`data-preset="${p.id}" data-bet-turn="${esc(turnKey||'')}" data-amount="${p.available?p.amount:''}" data-game-action aria-label="${esc(label)}" ${!p.available?'disabled':disabled('raise-preset')}`);
  }).join('');
  const amountControl=shortAllIn?btn(`<span class="bet-preset-label">All-in</span><strong class="bet-preset-amount">${esc(chips(a.maxRaiseTo))}</strong>`,'allin','bet-preset short-allin',`data-game-action data-bet-turn="${esc(turnKey||'')}" data-amount="${a.maxRaiseTo}" aria-label="All-in ${esc(chips(a.maxRaiseTo))}，点击直接下注" ${disabled('allin')}`):`<button type="button" class="raise-toggle" id="raise-toggle" data-action="toggle-raise-panel" data-game-action aria-expanded="${open}" aria-controls="raise-panel" aria-label="自定义下注金额，向上拖到顶为 All-in" ${disabled('toggle-raise-panel')}><span>自定义</span><span aria-hidden="true">↕</span></button>`;
  return `<div class="action-area action-dock ${submitting?'is-submitting':''} ${active?'is-my-turn':'is-waiting'}" data-control-state="${active?'active':'waiting'}" aria-busy="${Boolean(submitting)}">${showdown}${me?.seat==null&&hand?.status==='complete'&&me?.inHand?`<div class="detached-final-cards">${seatHoleCards(me,room)}</div>`:''}<div class="decision"><div class="turn-row dock-status"><span class="dock-status-text">${!playing&&!closed&&hand&&me?.seat!=null&&!me?.sittingOut?`<strong class="auto-deal-status" data-auto-deal>${esc(autoDealText(room))}</strong>`:esc(text)}</span><div class="turn-tools">${contextActions}</div></div><div class="raise-shortcuts" aria-label="常用下注尺度，点金额直接下注">${shortcuts}${amountControl}</div><div class="action-buttons" aria-label="牌局操作">${btn('弃牌','fold','fold-button',`data-game-action ${active&&!a.canCheck?'data-timeout-action':''} ${disabled('fold')}`)}${a.canCheck?btn('过牌','check','outline',`data-game-action ${active?'data-timeout-action':''} ${disabled('check')}`):btn(active?`${a.callAmount>=me?.stack?'All-in 跟注':'跟注'} ${chips(a.callAmount)}`:'过牌 / 跟注','call','outline',`data-game-action data-allin="${Boolean(active&&a.callAmount>=me?.stack)}" ${disabled('call')}`)}</div></div>${canRaise?`<section class="raise-popover" id="raise-panel" role="group" aria-label="调整下注金额" ${open?'':'hidden'}><header><output id="raise-amount" for="raise-range">${betActionLabel(room,amount)} <b>${chips(amount)}</b></output>${btn('×','close-raise-panel','raise-close','aria-label="收起下注滑条"')}</header><div class="raise-vertical-track"><span class="raise-endpoint">All-in</span><label class="sr-only" for="raise-range">下注总额，向上拖动增加；方向键微调，Home 最小，End All-in</label><span class="raise-range-rail"><input type="range" id="raise-range" min="0" max="1000" step="1" aria-orientation="vertical" data-unit="${getDisplayUnit()}" value="${betSliderFromAmount(room,amount)}" aria-valuetext="${betActionLabel(room,amount)} ${chips(amount)}" ${blocked?'disabled':''}></span><span class="raise-endpoint">${chips(normalizeBetAmount(room,a.minRaiseTo))}</span></div>${btn(raiseLabel,'raise','raise-submit',`id="raise-button" data-game-action data-bet-turn="${esc(turnKey||'')}" data-amount="${amount}" data-allin="${amount===a.maxRaiseTo}" ${disabled('raise')}`)}<p>拖动选金额 · 点上方按钮直接下注</p></section>`:''}</div>`;
}
function career(){return statsUI.renderStatsPage(state.statsView.data,state.statsView,{rooms:state.rooms,navigation:records.recordNavigation('career'),title:'战绩概览'});}

function roomClock(room,now=state.clock.now(),compact=false){
  if(room.status==='closed')return '已结束';
  if(!room.endsAt)return compact?'未开始':`${room.settings.durationMinutes||60} 分钟 · 首手开始计时`;
  const left=Math.max(0,Math.ceil((Number(room.endsAt)-now)/1000));
  if(left)return `${compact?'':'剩余 '}${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`;
  if(compact)return room.expiryMode==='wait-squid'?'等待鱿鱼':room.expiryMode==='finish-squid'?'鱿鱼加时':'已到时';
  if(room.expiryMode==='wait-squid'){const end=Number(room.mini?.squid?.expiryGraceEndsAt);if(end>0)return `已到时 · 等待恢复 ${Math.max(0,Math.ceil((end-now)/1000))}秒`;return room.hand?.status==='playing'?'已到时 · 本手后等待恢复':'已到时 · 等待鱿鱼恢复';}
  if(room.expiryMode==='finish-squid')return '已到时 · 打完本轮鱿鱼';
  return '时间到 · 本手结束后散桌';
}
function miniCutoff(room,now=state.clock.now()){return Boolean(room.miniGamesCutoffAt&&now>=Number(room.miniGamesCutoffAt));}
function syncRebuyPrompt(room,now){
  const prompt=rebuyPrompt(room,now),me=room.players?.find(p=>p.id===room.meId);
  document.querySelectorAll('[data-rebuy-countdown]').forEach(el=>{el.textContent=prompt?.remaining?`补码等待还剩 ${prompt.remaining} 秒 · 超时先旁观下一手`:'补码等待已结束，下一手开始前仍可补码';});
  const needsChips=me?.seat!=null&&room.status!=='closed'&&Number(me.stack)===0&&!Number(me.pendingBuyIn)&&me.pendingDeparture!=='stand';
  document.querySelectorAll('.table-topup').forEach(el=>el.classList.toggle('needs-chips',needsChips));
  document.querySelectorAll('[data-topup-status]').forEach(el=>{el.textContent=Number(me?.pendingBuyIn)>0?`待加 ${chips(me.pendingBuyIn,room.settings.bigBlind)} · 下一手`:needsChips?(prompt?.active?`补码等待 ${prompt.remaining} 秒`:'筹码不足 · 点击补码'):`筹码 ${chips(me?.stack||0,room.settings.bigBlind)}`;});
}
function tick(){
  state.turnRecovery?.check();
  document.querySelectorAll('[data-reaction-until]').forEach(el=>{if(Number(el.dataset.reactionUntil)<=Date.now())el.remove();});
  const room=state.room;if(!room)return;
  const now=state.clock.now();
  document.querySelectorAll('[data-room-clock]').forEach(el=>{el.textContent=roomClock(room,now,el.dataset.roomClock==='compact');el.setAttribute('aria-label',roomClock(room,now));el.dataset.squidExpiry=String(Boolean(room.expiryMode));el.classList.toggle('ending',room.status!=='closed'&&miniCutoff(room,now));});
  document.querySelectorAll('[data-bomb-marker]').forEach(el=>{const status=bombStatus(room,now);el.hidden=!status;el.classList.toggle('active',Boolean(status?.active));const label=el.querySelector('[data-bomb-status]');if(label&&status){label.textContent=label.dataset.bombStatus==='compact'?status.shortLabel:status.label;el.setAttribute('aria-label',status.label+'，查看炸弹池详情');}});
  document.querySelectorAll('[data-mini-cutoff]').forEach(el=>{el.hidden=room.status==='closed'||(!room.settings.squid&&!room.settings.bombPot)||!miniCutoff(room,now);});
  if(room.endsAt&&now>=Number(room.endsAt)&&room.expiryMode!=='finish-squid')document.querySelectorAll('[data-action="start"]').forEach(el=>el.disabled=true);
  document.querySelectorAll('[data-auto-deal]').forEach(el=>el.textContent=autoDealText(room,now));
  document.querySelectorAll('[data-history-turn]').forEach(el=>{el.hidden=!(room.hand?.status==='playing'&&room.hand.actingId===room.meId&&room.actions?.canAct&&state.connected&&!state.feedbackResync);});
  syncRebuyPrompt(room,now);
  const actor=actorClock(room,now);document.querySelectorAll('[data-seat-turn]').forEach(el=>{const seat=el.closest('.seat');el.hidden=!actor||seat?.dataset.playerId!==actor.playerId;seat?.classList.toggle('acting',!el.hidden&&!actor?.waiting);if(el.hidden)return;el.classList.toggle('is-preparing',actor.waiting);el.classList.toggle('urgent',actor.urgent);el.style.setProperty('--turn-progress',actor.ratio);const text=el.querySelector('[data-seat-clock]');if(text)text.textContent=actor.waiting?'发牌中':`${actor.remaining}s`;el.setAttribute('aria-label',actor.waiting?'等待发牌完成，随后开始思考计时':`正在思考，剩余 ${actor.remaining} 秒`);});
  document.querySelectorAll('.seat-timebank-button').forEach(button=>button.disabled=!seatTimeBankEnabled(room));
  const warning=turnCountdown.update(room,{now,live:state.page==='room',visible:document.visibilityState!=='hidden',connected:state.connected,reconnected:state.feedbackResync});
  if(warning.sound&&state.sound)tableSounds.play(warning.sound);
  document.querySelectorAll('[data-timeout-action]').forEach(el=>{el.classList.toggle('timeout-warning',warning.urgent&&!state.busy);el.removeAttribute('title');el.setAttribute('aria-description',warning.urgent?(room.actions?.canCheck?'超时将自动过牌':'超时将自动弃牌'):'');});
  const clocks=document.querySelectorAll('[data-turn-clock]');if(!clocks.length||!room.deadline)return;
  const deadline=typeof room.deadline==='number'?room.deadline:Date.parse(room.deadline),remaining=Math.max(0,Math.ceil((deadline-now)/1000));
  clocks.forEach(el=>{el.textContent=`${remaining}s${remaining===0?' · 同步中':''}`;el.classList.toggle('urgent',remaining>0&&remaining<=7);});
}
setInterval(tick,400);
state.turnRecovery=createTurnRecovery({
  getContext:()=>({room:state.room,page:state.page,identity:state.token,visible:document.visibilityState!=='hidden',online:navigator.onLine,connected:state.connected,resync:state.feedbackResync,busy:state.busy,now:state.clock.now()}),
  fetchRoom:(code,signal)=>api(`/api/rooms/${encodeURIComponent(code)}`,undefined,{signal}),
  apply:room=>normalizeState(room),reconnect:code=>connectStream(code),
});
function openModal(title,body,kind='custom'){finishComposition(undefined,{renderPending:false});if(state.page==='room'&&['career','session-list','session-detail','stats-metric','equity','table-info','fairness','verify'].includes(kind)&&!body.includes('data-history-turn'))body=historyTurnNotice()+body;if(state.chatOpen){state.chatOpen=false;render();}profileEditor?.destroy();profileEditor=null;if(kind!=='replay'){state.replayPlayback?.dispose();state.replayPlayback=null;}state.modal={kind,title};dialog.dataset.kind=kind;dialog.innerHTML=`<header class="modal-head"><h2>${title}</h2>${['room-menu','table-info','equity','career','hand-library','session-list','session-detail','hand-overview','replay','buyin'].includes(kind)?`<span class="modal-unit-tools">${moneyUnitToggle()}</span>`:''}${btn('×','close-modal','icon-btn ghost','aria-label="关闭窗口"')}</header><div class="modal-body">${body}</div>`;if(!dialog.open)dialog.showModal();}
function closeModal(){finishComposition(undefined,{renderPending:false});historyRefresh.stop();profileEditor?.destroy();profileEditor=null;state.replayRequest++;state.replayPlayback?.dispose();state.replayPlayback=null;state.modal=null;if(dialog.open)dialog.close();dialog.innerHTML='';}
dialog.addEventListener('cancel',event=>{event.preventDefault();closeModal();});
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();}});
function settingFields(settings,{roomName,advancedOpen=false}={}){
  const s={...defaults,...settings};
  s.minBuyInBB=100;s.maxBuyInBB=1000;s.actionSeconds=20;s.timeBankSeconds=30;s.timeBankCards=3*Math.ceil(s.durationMinutes/30);
  if(settings.squidUnitBB==null&&settings.squidUnit)s.squidUnitBB=Math.max(1,Math.round(settings.squidUnit/s.bigBlind));
  const numberField=(label,name,min,max,disabled=false,step=1)=>`<label class="field">${label}<input name="${name}" type="number" value="${s[name]??defaults[name]??1000}" min="${min}" max="${max}" step="${step}" ${disabled?'disabled':''} required></label>`;
  const blindPreset=[[1,2],[2,5],[5,10],[10,20]].find(([small,big])=>s.smallBlind===small&&s.bigBlind===big)?.join('/')||'custom';
  const durationPreset=[30,60,90,120].includes(s.durationMinutes)?String(s.durationMinutes):'custom';
  const bombPreset=[5,10,15,30].includes(s.bombIntervalMinutes)?String(s.bombIntervalMinutes):'custom';
  return `${roomName!==undefined?`<label class="field">牌桌名称<input name="name" maxlength="24" value="${esc(roomName)}" required></label>`:''}
  <section class="form-section"><div class="setting-heading"><strong>盲注</strong><span data-blind-value>1 BB = ${num(s.bigBlind)} 积分</span></div><div class="preset-row" role="group" aria-label="常用盲注">${[[1,2],[2,5],[5,10],[10,20]].map(([a,b])=>btn(`${a} / ${b}`,'blind-preset',blindPreset===`${a}/${b}`?'selected':'',`data-value="${a}/${b}" aria-pressed="${blindPreset===`${a}/${b}`}"`)).join('')}${btn('自定义','blind-preset',blindPreset==='custom'?'selected':'','data-value="custom" aria-pressed="'+(blindPreset==='custom')+'"')}</div><div class="field-grid custom-settings" data-blind-custom ${blindPreset==='custom'?'':'hidden'}>${numberField('小盲（积分）','smallBlind',1,1000)}${numberField('大盲（积分）','bigBlind',s.smallBlind*2,2000)}</div></section>
  <section class="form-section"><div class="setting-heading"><strong>牌桌时长</strong><span>首手开始计时</span></div><div class="preset-row" role="group" aria-label="牌桌时长">${[[30,'半小时'],[60,'1 小时'],[90,'1.5 小时'],[120,'2 小时']].map(([v,label])=>btn(label,'duration-preset',durationPreset===String(v)?'selected':'',`data-value="${v}" aria-pressed="${durationPreset===String(v)}"`)).join('')}${btn('自定义','duration-preset',durationPreset==='custom'?'selected':'','data-value="custom" aria-pressed="'+(durationPreset==='custom')+'"')}</div><div class="custom-settings" data-duration-custom ${durationPreset==='custom'?'':'hidden'}>${numberField('时长（分钟）','durationMinutes',30,720)}</div></section>
  <details class="form-section more-settings" data-advanced-settings ${advancedOpen?'open':''}><summary>高级设置 <small>玩法 · 带入 · 人数</small></summary><div class="mini-options"><label class="toggle"><span>鱿鱼<small>至少 3 人，没鱼者向有鱼者支付积分</small></span><input name="squid" type="checkbox" data-mini-toggle="squid-options" ${s.squid?'checked':''}></label><div id="squid-options" class="mini-config" ${s.squid?'':'hidden'}><label class="field">鱿鱼玩法<select name="squidMode" ${s.squid?'':'disabled'}><option value="normal" ${s.squidMode!=='unlimited'?'selected':''}>普通鱿鱼 · 每人最多 1 条</option><option value="unlimited" ${s.squidMode==='unlimited'?'selected':''}>无限鱿鱼 · 可以重复拿鱼</option></select></label><div data-squid-extra ${s.squidMode==='unlimited'?'':'hidden'}>${numberField('每轮额外加几条鱼','squidExtraTokens',0,100,!s.squid||s.squidMode!=='unlimited')}<p class="note compact-note">总鱼数 = 本轮实际人数 + 额外条数。例如 9 人加 3 条，共 12 条鱼。</p></div>${numberField('每条鱼支付（BB）','squidUnitBB',1,Math.floor(1000000/s.bigBlind),!s.squid)}<p class="note compact-note" data-squid-rule>${s.squidMode==='unlimited'?'独赢主池可重复拿鱼；只剩 1 人没鱼，或鱼发完，立即结轮。无鱼者按已发鱼数支付，剩余鱼不计费。':'独赢主池拿 1 条鱼，已有鱼不再增加；最后只剩 1 人没鱼时结轮。'}</p></div><label class="toggle"><span>炸弹池<small>所有人下前注，直接从翻牌开始</small></span><input name="bombPot" type="checkbox" data-mini-toggle="bomb-options" ${s.bombPot?'checked':''}></label><div id="bomb-options" class="mini-config" ${s.bombPot?'':'hidden'}><div class="setting-heading"><strong>炸弹池间隔</strong><span>到时后，下一手符合条件时触发</span></div><div class="preset-row" role="group" aria-label="炸弹池间隔">${[5,10,15,30].map(v=>btn(`${v} 分钟`,'bomb-preset',bombPreset===String(v)?'selected':'',`data-value="${v}" aria-pressed="${bombPreset===String(v)}"`)).join('')}${btn('自定义','bomb-preset',bombPreset==='custom'?'selected':'','data-value="custom" aria-pressed="'+(bombPreset==='custom')+'"')}</div><div class="custom-settings" data-bomb-custom ${bombPreset==='custom'?'':'hidden'}>${numberField('间隔（分钟）','bombIntervalMinutes',1,120,!s.bombPot)}</div>${numberField('每人前注（BB）','bombAnteBB',1,1000,!s.bombPot)}</div></div>
  <section class="buyin-policy"><div class="setting-heading"><strong>带入积分</strong><span>每次 100–1000 BB · 50 BB 一档</span></div><label class="toggle compact"><span>本场累计带入不限<small>每位玩家离座再入，也计入同一场累计</small></span><input name="unlimitedTotalBuyIn" type="checkbox" ${s.maxTotalBuyInBB===null?'checked':''}></label><div data-total-buyin-limit ${s.maxTotalBuyInBB===null?'hidden':''}>${numberField('本场每人累计上限（BB）','maxTotalBuyInBB',100,Math.floor(1000000000/s.bigBlind/50)*50,s.maxTotalBuyInBB===null,50)}</div></section><div class="field-grid"><label class="field">座位人数<select name="maxPlayers">${Array.from({length:8},(_,i)=>i+2).map(n=>`<option ${n===s.maxPlayers?'selected':''} value="${n}">${n} 人桌</option>`).join('')}</select></label></div><p class="note compact-note">时间牌每 30 分钟配 3 张，不足 30 分钟按一份计；开局一次发放，整场不补发，每张延长 30 秒。到期打完当前手；最后 5 分钟不再开启新鱿鱼轮或炸弹池。</p></details><p class="settings-overview note" data-settings-overview>${settingsOverview(s)}</p>`;
}
function settingsOverview(s){return `${s.maxPlayers} 人桌 · 每次带入 100–1000 BB${s.maxTotalBuyInBB===null?' · 累计不限':' · 累计上限 '+num(s.maxTotalBuyInBB)+' BB'} · 思考 20 秒 · 开局 ${3*Math.ceil(s.durationMinutes/30)} 张时间牌（每张 30 秒）${s.squid?' · '+lifecycle.squidName(s.squidMode)+' '+s.squidUnitBB+' BB/鱼'+(s.squidMode==='unlimited'?' · 实际人数＋'+s.squidExtraTokens+' 条':''):''}${s.bombPot?' · 炸弹池每 '+s.bombIntervalMinutes+' 分钟 / '+s.bombAnteBB+' BB':''}`;}
function updateSettingConstraints(form){
  if(!form?.matches('#create-form,#settings-form'))return;
  const field=name=>form.elements.namedItem(name),big=Number(field('bigBlind').value);
  field('bigBlind').min=String(Math.max(2,Number(field('smallBlind').value)*2));
  field('maxTotalBuyInBB').max=String(Math.floor(1000000000/Math.max(1,big)/50)*50);
  field('maxTotalBuyInBB').disabled=field('unlimitedTotalBuyIn').checked;
  const cap=form.querySelector('[data-total-buyin-limit]');if(cap)cap.hidden=field('unlimitedTotalBuyIn').checked;
  field('squidUnitBB').max=String(Math.floor(1000000/Math.max(1,big)));
  field('squidUnitBB').defaultValue=String(Math.min(Number(field('squidUnitBB').defaultValue)||defaults.squidUnitBB,Number(field('squidUnitBB').max)));
  const mode=field('squidMode'),extra=field('squidExtraTokens'),enabled=field('squid').checked;
  if(mode)mode.disabled=!enabled;if(extra)extra.disabled=!enabled||mode?.value!=='unlimited';
  const extraSection=form.querySelector('[data-squid-extra]');if(extraSection)extraSection.hidden=mode?.value!=='unlimited';
  const squidRule=form.querySelector('[data-squid-rule]');if(squidRule)squidRule.textContent=mode?.value==='unlimited'?'独赢主池可重复拿鱼；只剩 1 人没鱼，或鱼发完，立即结轮。无鱼者按已发鱼数支付，剩余鱼不计费。':'独赢主池拿 1 条鱼，已有鱼不再增加；最后只剩 1 人没鱼时结轮。';
  const summary=form.querySelector('[data-settings-overview]');if(summary)summary.textContent=settingsOverview(readSettings(form));
  const blind=form.querySelector('[data-blind-value]');if(blind)blind.textContent=`1 BB = ${num(big)} 积分`;
}
function inactiveSettingValue(input,fallback){const n=Number(input.value);return input.value!==''&&Number.isSafeInteger(n)&&n>=Number(input.min)&&n<=Number(input.max)?n:Number(input.defaultValue||fallback);}
function readSettings(form){const fd=new FormData(form),s={};for(const key of Object.keys(defaults)){const input=form.elements.namedItem(key);if(['minBuyInBB','maxBuyInBB','actionSeconds','timeBankCards','timeBankSeconds'].includes(key)){s[key]=defaults[key];continue;}if(key==='squidMode'){s[key]=input?.value==='unlimited'?'unlimited':'normal';continue;}s[key]=typeof defaults[key]==='boolean'?fd.get(key)==='on':input?.disabled?inactiveSettingValue(input,defaults[key]):Number(fd.get(key));}if(form.elements.namedItem('unlimitedTotalBuyIn')?.checked)s.maxTotalBuyInBB=null;s.timeBankCards=3*Math.ceil(s.durationMinutes/30);return s;}
function applySettingPreset(button,kind){
  const form=button.closest('form'),value=button.dataset.value;if(!form)return;
  const group=button.parentElement;for(const item of group.querySelectorAll('button')){const selected=item===button;item.classList.toggle('selected',selected);item.setAttribute('aria-pressed',String(selected));}
  const custom=form.querySelector(kind==='blind'?'[data-blind-custom]':kind==='bomb'?'[data-bomb-custom]':'[data-duration-custom]');custom.hidden=value!=='custom';
  if(value!=='custom'){if(kind==='blind'){const [small,big]=value.split('/');form.elements.namedItem('smallBlind').value=small;form.elements.namedItem('bigBlind').value=big;}else form.elements.namedItem(kind==='bomb'?'bombIntervalMinutes':'durationMinutes').value=value;}
  else custom.querySelector('input')?.focus();
  updateSettingConstraints(form);
}
function createModal(){
  const rooms=[...(state.rooms||[])].reverse();
  const reuse=rooms.length?`<div class="settings-reuse"><label for="reuse-room-settings">沿用之前的牌桌配置</label><div class="settings-reuse-row"><select id="reuse-room-settings"><option value="">选择你参加过的牌桌</option>${rooms.map(r=>`<option value="${esc(r.code)}">${esc(r.name)} · ${esc(r.code)}${r.status==='closed'?' · 已结束':''}</option>`).join('')}</select>${btn('沿用','load-room-settings','outline small')}</div><p class="note compact-note" data-settings-reuse-status role="status">读取后可以继续调整，不影响原牌桌。</p></div>`:'';
  openModal('创建牌桌',`<form id="create-form"><section class="room-access"><strong>谁可以加入</strong><div class="room-access-options"><label class="room-access-option"><input type="radio" name="access" value="invite" checked><span>仅限邀请</span><small>在大厅可见，持有邀请链接才能进入。</small></label><label class="room-access-option"><input type="radio" name="access" value="public"><span>公开加入</span><small>登录后的朋友可从大厅直接进入。</small></label></div></section>${reuse}<fieldset class="settings-fields">${settingFields(defaults,{roomName:state.user.name+'必赢的局'})}</fieldset><div class="modal-footer">${btn('取消','close-modal','ghost')}<button class="primary" type="submit">创建牌桌</button></div></form>`,'create');
}
async function loadPreviousRoomSettings(button){
  const form=button.closest('#create-form'),selector=form?.querySelector('#reuse-room-settings'),code=selector?.value;
  if(!form||form.dataset.settingsLoading==='true')return;
  const previous=(state.rooms||[]).find(r=>r.code===code);
  if(!previous){toast('先选择要沿用配置的牌桌');selector?.focus();return;}
  const guard=requests.capture(),fields=form.querySelector('.settings-fields'),submit=form.querySelector('[type="submit"]'),status=form.querySelector('[data-settings-reuse-status]');
  const name=form.elements.namedItem('name').value,advancedOpen=Boolean(form.querySelector('[data-advanced-settings]')?.open);
  const current=()=>guard.valid()&&form.isConnected&&state.modal?.kind==='create'&&selector.value===code;
  form.dataset.settingsLoading='true';fields.disabled=true;submit.disabled=true;button.disabled=true;selector.disabled=true;status.textContent='正在读取配置…';
  try{
    const response=await api(`/api/rooms/${encodeURIComponent(code)}`);guard.check();if(!current())return;
    const settings=reusableRoomSettings((response.room||response).settings,defaults);
    fields.innerHTML=settingFields(settings,{roomName:name,advancedOpen});fields.disabled=false;updateSettingConstraints(form);
    status.textContent=`已沿用「${previous.name}」的配置，可以继续调整。`;
  }catch(error){if(current()&&!error.stale){status.textContent='未能读取，当前设置保持不变。';toast(error.message,true);}}
  finally{form.dataset.settingsLoading='false';fields.disabled=false;submit.disabled=false;button.disabled=false;selector.disabled=false;}
}
function joinInvite(value){navigate(parseInvite(value));}
function buyinTimingSummary(room,isSit,me){
  if(!isSit)return lifecycle.buyinTiming(room,false,me,state.clock.now());
  if(!room.startedAt&&!room.hand)return '确认后立即入座，无需房主审核。';
  return '确认后立即入座；从符合条件的下一手拿牌。'+(room.mini?.squid?.active?room.mini.squid.participants?.includes(me?.id)?'重返本轮，保留原有鱼数，不重复增加鱼数。':'以 0 鱼加入，总鱼数加 1；发牌时收预留。':'等待期间不扣盲。');
}
function buyinModal(seat){
  const r=state.room,isSit=seat!==undefined,me=r.players.find(p=>p.id===r.meId),bb=r.settings.bigBlind;
  if(isSit&&lifecycle.squidAdmissionClosed(r,me,state.clock.now())){toast(lifecycle.buyinTiming(r,true,me,state.clock.now()));return;}
  if(!isSit&&me?.seat==null){toast('先选择一个空座位');return;}
  if(!isSit&&r.status==='closed'){toast('牌桌已结束，不能再补码');return;}
  if(!isSit&&me.pendingDeparture==='stand'){toast('已安排离座，请先取消离座再补码');return;}
  const cap=r.settings.maxTotalBuyInBB??null,pending=Number(me?.pendingBuyIn||0)/bb,used=(Number(me?.totalBuyIn||0)+Number(me?.pendingBuyIn||0))/bb,remaining=cap===null?null:Math.max(0,cap-used);
  const min=100,max=Math.min(1000,remaining===null?1000:Math.floor(remaining/50)*50),blocked=max<min,initial=blocked?0:Math.min(200,max),unit=getDisplayUnit();
  const value=n=>chipInputValue(n*bb,bb,unit),amount=n=>chips(n*bb,bb);
  const rebuy=rebuyPrompt(r,state.clock.now());
  const budget=cap===null?'本场累计带入不限':`本场已占额度 ${amount(used)} / 上限 ${amount(cap)}，剩余 ${amount(remaining)}${pending?'（包含待到账补码）':''}`;
  openModal(isSit?`入座 · ${Number(seat)+1} 号座`:'补充筹码',`${rebuy?.remaining?`<p class="rebuy-notice" role="status" data-rebuy-countdown>补码等待还剩 ${rebuy.remaining} 秒 · 超时先旁观下一手</p>`:''}<form id="buyin-form" data-room="${esc(r.code)}" data-seat="${isSit?seat:''}" data-big-blind="${bb}" data-unit="${unit}"><div class="buyin-fields"><input type="hidden" name="amountBB" value="${initial}"><p class="topup-timing" data-buyin-timing role="status">${esc(buyinTimingSummary(r,isSit,me))}</p><p class="topup-pending" data-buyin-pending ${pending?'':'hidden'}>${pending?`已排队 +${amount(pending)} · 下一手生效`:""}</p><div class="buyin-amount-row"><label class="field" for="buyin-amount">本次${isSit?'带入':'补充'}</label><div class="buyin-number"><input id="buyin-amount" name="amountDisplay" type="number" min="${value(min)}" max="${value(Math.max(min,max))}" step="${value(50)}" value="${value(initial)}" ${blocked?'disabled':''} required><span>${unitLabel()}</span></div></div><input id="buyin-range" type="range" aria-label="拖动设置带入数量" aria-valuetext="${amount(initial)}" min="${min}" max="${Math.max(min,max)}" step="50" value="${blocked?min:initial}" ${blocked?'disabled':''}><div class="buyin-range-labels"><span>${amount(min)}</span><span>${amount(Math.max(min,max))}</span></div><div class="preset-row buyin-presets">${[100,200,500,1000].filter(n=>n<=max).map(n=>btn(amount(n),'buyin-preset',n===initial?'selected':'',`data-value="${n}" aria-pressed="${n===initial}"`)).join('')}</div><p class="buyin-points" data-buyin-points aria-live="polite" ${blocked?'':'hidden'}>${blocked?'无法继续带入':`带入 ${amount(initial)}`}</p><details class="buyin-details"><summary>带入额度与规则</summary><p class="note buyin-budget" data-buyin-budget>${esc(budget)}${blocked?`<br><strong>剩余额度不足单次最低 ${amount(min)}，无法再带入。</strong>`:''}</p><p class="note" data-buyin-rules>每次 ${value(min)}–${amount(1000)}，${amount(50)} 一档 · 1 BB = ${num(bb)} 积分${!isSit?'<br>本手已开始则排队；未到账前离座或关桌会取消，不计入已带入。':''}</p></details>${!blocked&&isSit&&(r.startedAt||r.hand||me?.entryBlind?.required)?entryModeFields(r,me):''}</div><div class="modal-footer buyin-footer">${btn('取消','close-modal','ghost')}<button class="primary" type="submit" ${blocked?'disabled':''}>${isSit?'确认入座':r.hand?.status==='playing'?'确认补码 · 下一手可用':'确认补码'}</button></div></form>`,'buyin');
}
function refreshBuyinStatus(room){
  const form=dialog.querySelector('#buyin-form');if(!form||form.dataset.room!==room.code)return;
  const me=room.players.find(p=>p.id===room.meId),isSit=form.dataset.seat!=='';
  if(room.status==='closed'||!isSit&&(me?.seat==null||me.pendingDeparture==='stand')||isSit&&(me?.seat!=null||room.players.some(p=>p.seat===Number(form.dataset.seat))||lifecycle.squidAdmissionClosed(room,me,state.clock.now()))){closeModal();return;}
  const previousBB=Number(form.dataset.bigBlind),bb=room.settings.bigBlind,pending=Number(me?.pendingBuyIn||0),used=Number(me?.totalBuyIn||0)+pending,cap=room.settings.maxTotalBuyInBB??null,remaining=cap===null?null:Math.max(0,cap-used/bb),max=Math.min(1000,remaining===null?1000:Math.floor(remaining/50)*50),blocked=max<100;
  const input=form.querySelector('#buyin-amount'),range=form.querySelector('#buyin-range'),timing=form.querySelector('[data-buyin-timing]'),queued=form.querySelector('[data-buyin-pending]'),budget=form.querySelector('[data-buyin-budget]'),submit=form.querySelector('[type=submit]');
  if(timing)timing.textContent=buyinTimingSummary(room,isSit,me);
  if(queued){queued.hidden=pending<=0;queued.textContent=pending>0?`已排队 +${chips(pending,bb)} · 下一手生效`:'';}
  if(budget)budget.textContent=(cap===null?'本场累计带入不限':`本场已占额度 ${chips(used,bb)} / 上限 ${chips(cap*bb,bb)}，剩余 ${chips(remaining*bb,bb)}${pending?'（包含待到账补码）':''}`)+(blocked?'；剩余额度不足单次最低 100 BB，无法再带入。':'');
  if(!input||!range||!submit)return;
  if(previousBB!==bb){const entry=form.querySelector('.entry-mode-options');if(entry){const selected=entry.querySelector('[name="entryMode"]:checked')?.value;entry.outerHTML=entryModeFields(room,me);const radio=form.querySelector(`[name="entryMode"][value="${selected==="post"?"post":"wait"}"]`);if(radio)radio.checked=true;}}
  form.dataset.bigBlind=String(bb);
  input.min=chipInputValue(100*bb,bb,form.dataset.unit);input.step=chipInputValue(50*bb,bb,form.dataset.unit);
  input.max=chipInputValue(Math.max(100,max)*bb,bb,form.dataset.unit);range.max=String(Math.max(100,max));input.disabled=blocked;range.disabled=blocked;
  const rangeEnd=form.querySelector('.buyin-range-labels span:last-child');if(rangeEnd)rangeEnd.textContent=chips(Math.max(100,max)*bb,bb);
  form.querySelectorAll('[data-action="buyin-preset"]').forEach(button=>{button.disabled=blocked||Number(button.dataset.value)>max;button.textContent=formatChips(Number(button.dataset.value)*bb,bb,{unit:form.dataset.unit});});
  const rangeStart=form.querySelector('.buyin-range-labels span:first-child');if(rangeStart)rangeStart.textContent=chips(100*bb,bb);
  const rules=form.querySelector('[data-buyin-rules]');if(rules)rules.textContent=`每次 ${formatChips(100*bb,bb,{unit:form.dataset.unit})}–${formatChips(1000*bb,bb,{unit:form.dataset.unit})}，${formatChips(50*bb,bb,{unit:form.dataset.unit})} 一档 · 1 BB = ${num(bb)} 积分${!isSit?'；本手已开始则排队，未到账前离座或关桌会取消。':''}`;
  submit.textContent=isSit?'确认入座':room.hand?.status==='playing'?'确认补码 · 下一手可用':'确认补码';
  updateBuyinSummary(form);submit.disabled=blocked||state.busy||!state.connected||state.feedbackResync||!form.elements.namedItem('amountBB').value;
}
function entryModeFields(room,player){
  const entry=lifecycle.entryBlindView(room,player),live=entry?.live??Number(room.settings.bigBlind),dead=entry?.dead??0,mode=entry?.mode||'wait';
  return `<fieldset class="entry-mode-options"><legend>参与方式</legend><label class="entry-mode-option"><input type="radio" name="entryMode" value="wait" ${mode==='wait'?'checked':''}><span>等大盲加入<small>等待期间不发牌、不扣盲</small></span></label><label class="entry-mode-option"><input type="radio" name="entryMode" value="post" ${mode==='post'?'checked':''}><span>补盲加入 · ${chips(live+dead,room.settings.bigBlind)}<small>${dead?`${live?`大盲 ${chips(live,room.settings.bigBlind)} 抵跟注；`:''}补小盲 ${chips(dead,room.settings.bigBlind)} 不抵跟注`:'抵本手跟注'}，发牌时才扣</small></span></label><small class="entry-mode-hint">先入座，发牌时扣盲。庄位、小盲附近需先等过庄；入座后可切换。</small></fieldset>`;
}
function updateBuyinSummary(form,source){
  if(form?.id!=='buyin-form')return;
  const input=form.querySelector('#buyin-amount'),stored=form.elements.namedItem('amountBB'),range=form.querySelector('#buyin-range'),summary=form.querySelector('[data-buyin-points]'),bb=Number(form.dataset.bigBlind),unit=form.dataset.unit;
  if(input.disabled){const submit=form.querySelector('[type=submit]');if(submit)submit.disabled=true;return;}
  if(source?.id==='buyin-range')input.value=chipInputValue(Number(source.value)*bb,bb,unit);
  const points=parseChipInput(input.value,bb,unit),amount=points===null?null:points/bb,valid=amount!==null&&Number.isSafeInteger(amount)&&amount>=Number(range.min)&&amount<=Number(range.max)&&amount%50===0;
  stored.value=valid?String(amount):'';
  const submit=form.querySelector('[type=submit]');if(submit)submit.disabled=!valid||state.busy||!state.connected||state.feedbackResync;
  input.setCustomValidity(valid?'':`请填写范围内 ${formatChips(50*bb,bb,{unit})} 的整数倍`);
  if(valid){range.value=String(amount);range.setAttribute('aria-valuetext',formatChips(points,bb,{unit}));}
  if(summary){summary.textContent=valid?`带入 ${formatChips(points,bb,{unit})}`:input.validationMessage;summary.hidden=valid;}
  for(const button of form.querySelectorAll('[data-action="buyin-preset"]')){const selected=valid&&Number(button.dataset.value)===amount;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
}

function inviteModal(){const url=inviteUrl(state.room);openModal('邀请朋友',`<p class="note">持有链接的人可加入，请只发给本局朋友。</p><label class="field">邀请链接<textarea id="invite-link" readonly>${esc(url)}</textarea></label><div class="modal-footer">${canShare()?btn('分享','share-invite','outline'):''}${btn('复制链接','copy-invite','primary')}</div>`,'invite');}
async function copy(text,success='已复制'){try{await navigator.clipboard.writeText(text);toast(success);}catch{const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';(dialog.open?dialog:document.body).append(input);input.select();try{if(!document.execCommand('copy'))throw Error();toast(success);}catch{toast('请长按链接或恢复码手动复制');}input.remove();}}
function profileModal(){
  const account=state.user.username;
  openModal('我的账号',`<form id="profile-form" class="stack">${avatarEditorMarkup(state.user)}<label class="field">昵称<input name="name" autocomplete="nickname" value="${esc(state.user.name)}" required></label><button type="submit" class="primary">保存资料</button></form><div class="divider"></div>${account?`<p class="note">账号：${esc(account)}<br>用账号和密码可在其他设备登录，牌谱和积分记录会保留。忘记密码时使用注册时保存的找回码。</p>${btn('修改密码','change-password','outline')}`:`<p class="note">设置账号和密码后，继续保留现在的牌谱、积分和牌桌。</p>${btn('设置账号密码','bind-account','primary')}<details class="help-details"><summary>保存旧身份恢复码</summary><p class="note">仅用于尚未设置账号的旧身份。设置账号后此码失效。不要发给别人。</p><div class="recovery">${esc(state.token)}</div>${btn('复制旧恢复码','copy-token','outline small')}</details>`}<div class="divider"></div><div class="row wrap">${state.install?btn('添加到主屏幕','install','outline small'):''}${btn('退出当前设备','logout-confirm','danger small')}</div>`,'profile');
  profileEditor=createAvatarEditor($('#profile-form'),{user:state.user,hydrate:root=>avatarCache.hydrate(root)});profileEditor.setSaving(Boolean(state.profileSave));
}
async function saveProfile(fd){
  const guard=requests.capture(),editor=profileEditor,name=String(fd.get('name')||'').trim();
  if(state.profileSave)throw new Error('资料正在保存，请稍等');
  if(!name||[...name].length>18)throw new Error('昵称请填写 1–18 个字');
  const patch=editor?.patch()||{},job={};state.profileSave=job;editor?.setError();editor?.setSaving(true);
  try{
    const data=await api('/api/profile',{name,...patch});guard.check();state.user=data.user;
    const me=state.room?.players.find(p=>p.id===data.user.id);if(me){me.name=data.user.name;me.avatar=data.user.avatar;me.avatarImage=data.user.avatarImage??null;}
    if(profileEditor===editor)closeModal();else if(state.modal?.kind==='profile')profileModal();render();toast('头像和昵称已保存');
  }catch(error){if(!error.stale&&state.profileSave===job)profileEditor?.setError(error.message);throw error;}
  finally{if(state.profileSave===job){state.profileSave=null;profileEditor?.setSaving(false);}}
}
function bindAccountModal(){openModal('设置账号密码',`<form id="bind-account-form" class="stack"><p class="note">保留当前身份的全部牌谱和积分。设置后用账号密码登录。</p>${usernameField()}${passwordField('password','密码',true)}<button type="submit" class="primary">保存账号</button></form>`,'bind-account');}
function changePasswordModal(){openModal('修改密码',`<form id="password-form" class="stack">${usernameField(state.user.username,true)}${passwordField('currentPassword','当前密码')}${passwordField('newPassword','新密码',true)}<p class="note">修改后其他设备会退出登录，并生成新的找回码。</p><button type="submit" class="primary">修改密码</button></form>`,'password');}
function recoverModal(){openModal('找回密码',`<form id="recover-form" class="stack"><p class="note">输入注册时保存的找回码。此版本不使用手机短信或邮箱找回。</p>${usernameField()}<label class="field">找回码<input name="recoveryCode" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>${passwordField('newPassword','新密码',true)}<button type="submit" class="primary">设置新密码</button></form>`,'recover');}
function restoreModal(){openModal('找回旧昵称身份',`<form id="restore-form"><p class="note">只适用于以前没有设置账号的昵称身份。已设置账号请用账号密码登录。</p><label class="field">旧身份恢复码<textarea name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴以前保存的完整恢复码" required></textarea></label><div class="modal-footer">${btn('取消','close-modal','ghost')}<button type="submit" class="primary">恢复旧身份</button></div></form>`,'restore');}
async function acceptAccount(data){await adoptIdentity(data);if(data.recoveryCode)state.pendingRecovery={code:data.recoveryCode,username:data.user.username};await route();}
async function submitAccount(kind,fd){const changing=kind==='bind'||kind==='password';if(changing){requests.invalidate();abortPendingTableRequests();stopStream();state.busy=false;state.pendingCommand=null;}const guard=requests.capture();const body={username:String(fd.get('username')||'').trim()};if(kind==='password'){delete body.username;body.currentPassword=String(fd.get('currentPassword')||'');body.newPassword=String(fd.get('newPassword')||'');}else if(kind==='recover'){body.recoveryCode=String(fd.get('recoveryCode')||'').trim();body.newPassword=String(fd.get('newPassword')||'');}else{body.password=String(fd.get('password')||'');if(kind==='register')body.name=String(fd.get('name')||'').trim()||body.username.slice(0,18);}try{const data=await api(`/api/account/${kind}`,body,{anonymous:!changing});guard.check();await acceptAccount(data);}catch(error){if(changing&&guard.valid())resumeTable();throw error;}}
async function logout(){const token=state.token,user=state.user,account=user?.username;stopStream();try{if(account)await api('/api/account/logout',{});}catch(error){if(error.status!==401){resumeTable();throw error;}}if(state.token!==token)return;resetPrivateView();const guard=requests.capture();state.token='';state.user=null;state.authMode='login';state.page='loading';render();try{await clearIdentity(token);}catch{if(!guard.valid())return;if(!account){state.token=token;state.user=user;state.page='lobby';render();throw new Error('本设备暂时无法清除旧身份，请重试退出');}toast('本设备未能清除缓存，请关闭页面；此登录已退出',true);}if(guard.valid()){state.page='welcome';render();}}
function roomMenu(){
  const r=state.room,me=r.players.find(p=>p.id===r.meId),host=r.hostId===r.meId,playing=r.hand?.status==='playing';
  openModal('牌桌菜单',`<div class="table-settings"><div class="data-row"><span>盲注</span><strong>${chips(r.settings.smallBlind,r.settings.bigBlind,{unitLabel:false})} / ${chips(r.settings.bigBlind,r.settings.bigBlind)}</strong></div><div class="data-row"><span>单次带入</span><strong>${chips(100*r.settings.bigBlind,r.settings.bigBlind,{unitLabel:false})}–${chips(1000*r.settings.bigBlind,r.settings.bigBlind)} · ${chips(50*r.settings.bigBlind,r.settings.bigBlind)} 一档</strong></div><div class="data-row"><span>本场每人累计上限</span><strong>${r.settings.maxTotalBuyInBB==null?'不限':chips(r.settings.maxTotalBuyInBB*r.settings.bigBlind,r.settings.bigBlind)}</strong></div><div class="data-row"><span>思考时间</span><strong>${r.settings.actionSeconds} 秒</strong></div><div class="data-row"><span>牌桌时长</span><strong>${r.settings.durationMinutes||60} 分钟</strong></div><div class="data-row"><span>时间牌 · 开局发放，不补发</span><strong>${r.settings.timeBankCards??3*Math.ceil(r.settings.durationMinutes/30)} 张 × 30 秒</strong></div></div><div class="menu-seat-group">${seatActions(r,me)}</div><div class="stack menu-options">${host&&r.hand&&r.status!=='closed'?btn(r.autoDeal?.paused?'继续自动发牌':'暂停自动发牌','toggle-autodeal','outline'):''}${btn(state.sound?'声音：开':'声音：关','toggle-sound','outline')}${btn(state.voice?'动作语音：开':'动作语音：关','toggle-voice','outline',state.sound?'':'disabled')}${btn(state.animations?'动效：开':'动效：关','toggle-animations','outline')}${btn(state.fun?'娱乐特效：开':'娱乐特效：关','toggle-fun','outline')}${btn('我的数据','career','outline')}${btn('账号与头像','profile','outline')}${btn('玩法规则','rules','outline')}${r.hand?btn('核验当前牌局','verify','outline'):''}${host&&r.status!=='closed'?`${!r.startedAt?btn('调整房间设置','settings','outline',playing?'disabled':''):''}${btn('转交房主','transfer-host','outline',playing?'disabled':'')}${btn('结束本场牌桌','close-room-confirm','danger',playing?'disabled':'')}`:''}</div><div class="room-menu-navigation">${btn('返回大厅','lobby','ghost')}<p class="lifecycle-note">返回大厅不等于离座，座位和积分仍保留。要休息或离开，请使用上方的暂离或离座；本手仍照常计时。</p></div>${r.startedAt?'<p class="note" style="margin-top:15px">开局后设置已锁定。到期打完当前手；有未完鱿鱼轮时先收尾原轮。</p>':''}`,'room-menu');
}
function departureModal(type){
  const room=state.room,me=room?.players.find(p=>p.id===room.meId);if(!me||me.seat==null||room.status==='closed')return;
  const plan=lifecycle.departurePlan(room,me,type);state.departureConfirmation={...plan,code:room.code};
  const responsibility=plan.participant?`<div class="lifecycle-caution">${plan.won?`你已获得本轮 ${plan.fishCount} 条鱼，离开后仍保留结算权益。`:`你仍在本轮名单中；离开不会免除鱿鱼结算责任。现有预留最多覆盖 <strong>${chips(plan.cost)}</strong>，最终按结轮时的标记情况计算。`}<br>本轮预留不会随离座取走，剩余部分在结轮后退回。${plan.canEarnMark?'<br>本手仍可正常获得标记。':''}<br>回来时恢复原轮身份，不重新收鱿鱼预留。</div>`:'';
  openModal(plan.title,`<p class="note">${esc(plan.description)}</p>${plan.queued?'<p class="lifecycle-note">本手结束后执行，这手仍需照常行动；已投入积分不退回，全下照常跑牌。执行前可取消安排。</p>':''}${responsibility}<div class="modal-footer">${btn('留在座位','close-modal','ghost')}${btn(plan.label,'departure-confirm','primary')}</div>`,'departure');
}
async function confirmDeparture(){
  const quote=state.departureConfirmation,room=state.room,modal=state.modal,me=room?.players.find(p=>p.id===room.meId);
  if(state.modal?.kind!=='departure'||!quote||quote.code!==room?.code||!me||me.seat==null)return;
  const plan=lifecycle.departurePlan(room,me,quote.type);
  if(plan.cost!==quote.cost||plan.round!==quote.round||plan.queued!==quote.queued||plan.canEarnMark!==quote.canEarnMark||plan.won!==quote.won||plan.fishCount!==quote.fishCount){departureModal(quote.type);toast('牌桌状态已变化，请确认更新后的说明');return;}
  if(await command(quote.type,{...(quote.type==='sitout'?{value:true}:{}),expectedSquidRound:plan.round,expectedSquidCost:plan.cost})){
    if(state.modal===modal&&state.room?.code===quote.code)closeModal();if(state.departureConfirmation===quote)state.departureConfirmation=null;
    const updated=state.room?.players.find(p=>p.id===state.room.meId);toast(updated?.pendingDeparture?(updated.pendingDeparture==='stand'?'已安排本手后离座':'已安排本手后暂离'):quote.type==='stand'?'已离座，积分记录保留':'已暂离，座位和积分保留');
  }
}
function settleSquidModal(){
  const settlement=lifecycle.squidSettlement(state.room);if(!settlement?.canSettle)return;
  openModal('结算本轮鱿鱼',`<p class="note">原轮鱿鱼可参与人数不足，已等待至少 ${num(settlement.waitSeconds)} 秒。${state.room.expiryMode?'牌桌已到时，仅等待原轮恢复或结算。':'原轮名单与预留仍保留。'}</p><div class="lifecycle-caution">${settlement.winnerCount?`每位未获标记者支付 ${chips(settlement.loserCost)}；${settlement.mode==='unlimited'?'有鱼者每条鱼获得':'每位已获标记者获得'} ${chips(settlement.winnerGain)}。${settlement.mode==='unlimited'?'按已拿鱼数结算，剩余未发出的鱼不计费。':''}`:'本轮还无人获得标记，所有预留积分退回。'}<br>其余未用预留退回，本轮结束。</div><p class="lifecycle-note">只结算当前鱿鱼轮，已结束手牌的结果不变。</p><div class="modal-footer">${btn('保留原轮','close-modal','ghost')}${btn('按现有标记结算','settle-squid-confirm','primary')}</div>`,'settle-squid');
}
function entryBlindModal(returning=false){
  const room=state.room,me=room?.players.find(p=>p.id===room.meId),entry=lifecycle.entryBlindView(room,me);
  if(!entry||me?.seat==null||room.status==='closed')return;
  state.entryBlindConfirmation={code:room.code,playerId:me.id,returning,live:entry.live,dead:entry.dead,reason:me.entryBlind.reason};
  const join=lifecycle.squidJoinView(room,me);
  openModal(returning?'返回牌桌':'参与方式',`<p class="note">${esc(entry.note)}</p><div class="entry-blind-actions">${btn(`${entry.mode==='wait'?'✓ 已选 · ':''}等大盲加入`,'entry-blind-confirm',entry.mode==='wait'?'outline selected':'outline',`data-mode="wait" aria-pressed="${entry.mode==='wait'}" ${entry.mode==='wait'&&!returning?'disabled':''}`)}${btn(`${entry.mode==='post'?'✓ 已选 · ':''}补盲加入 · ${chips(entry.total)}`,'entry-blind-confirm',entry.mode==='post'?'outline selected':'primary',`data-mode="post" aria-pressed="${entry.mode==='post'}" ${entry.mode==='post'&&!returning?'disabled':''}`)}</div><details class="entry-choice-details"><summary>查看补盲与鱿鱼规则</summary><p class="lifecycle-note">${entry.live?`大盲 ${chips(entry.live)} 抵本手跟注。`:''}${entry.dead?`另补小盲 ${chips(entry.dead)}进底池、不抵跟注。`:''}实际拿牌时才扣，同手重连不会重复收盲。若全员等盲无法开牌，至少一人改选补盲。</p>${join?`<p class="lifecycle-note">${esc(join.note)}${join.requiredReserve!==null?`<br>预计本人入轮${join.minimum?'至少':''}预留 ${chips(join.requiredReserve)}，以实际发牌时为准。`:''}</p>`:''}</details>`,'entry-blind');
}
async function confirmEntryBlind(mode){
  if(!['wait','post'].includes(mode))return;
  const quote=state.entryBlindConfirmation,room=state.room,modal=state.modal,me=room?.players.find(p=>p.id===room.meId),entry=lifecycle.entryBlindView(room,me);
  if(state.modal?.kind!=='entry-blind'||!quote||quote.code!==room?.code||quote.playerId!==me?.id||me?.seat==null)return;
  if(!entry){closeModal();toast('参与状态已更新，请查看牌桌');return;}
  if(entry.live!==quote.live||entry.dead!==quote.dead||me.entryBlind.reason!==quote.reason){entryBlindModal(quote.returning);toast('补盲状态已变化，请确认更新后的金额');return;}
  const ok=quote.returning?await command('sitout',{value:false,entryMode:mode}):await command('entryBlind',{mode});
  if(ok){if(state.modal===modal&&state.room?.code===quote.code)closeModal();if(state.entryBlindConfirmation===quote)state.entryBlindConfirmation=null;toast(lifecycle.entryChoiceFeedback(state.room,state.room.players.find(p=>p.id===state.room.meId)));}else if(state.modal===modal&&state.room?.code===quote.code){const current=state.room.players.find(p=>p.id===state.room.meId);if(current?.seat==null||!lifecycle.entryBlindView(state.room,current))closeModal();else entryBlindModal(quote.returning);toast('请求未确认，正在同步牌桌；请查看连接恢复后的已选状态',true);}
}
function participationNotice(room,me){
  if(me?.seat==null||me.sittingOut&&!me.pendingDeparture)return '';
  if(!me?.pendingDeparture&&((!me?.waitingFor&&!me?.entryBlind?.required)||room.hand?.status==='playing'&&me.inHand))return '';
  const view=lifecycle.participation(room,me),entry=lifecycle.entryBlindView(room,me);
  const note=lifecycle.squidJoinView(room,me)?view.note:entry?.canChoose?entry.mode==='wait'?'等待期间不发牌、不扣盲':entry.waitingFor==='button'?'等待过庄，实际发牌时才补盲':'实际发牌时才补盲':view.label;
  return `<div class="lifecycle-queue"><span>${esc(note)}</span>${view.canCancel?btn('取消','cancel-departure','ghost small'):entry?.canChoose?btn('参与方式','entry-blind','outline small'):''}</div>`;
}
function rulesModal(){openModal('玩法规则',`<p class="note">所有数字均为游戏积分。BB 指一份大盲，例如盲注 5 / 10 时，100 BB = 1,000 积分。单次入座或补码为 100–1000 BB，按 50 BB 一档；无需审核。本场累计带入默认不限，房主可设上限，离座再入也累计。</p>
<h3 class="rule-title">入桌、等盲与返桌</h3><ol class="rule-list"><li>首手的玩家正常出大小盲。中途加入默认等自然大盲，也可以选择补 1 BB 参与；在不适合入局的位置，系统自动等过庄。等待期间不发牌、不扣盲；不会把选择等大盲的人改放小盲。若全员等盲无法开牌，至少一人改选补盲。</li><li>补盲在实际发牌时才扣，切换选择不扣积分；自然轮到大盲不会重复收取。补的大盲抵本手跟注，例如已补 10、需跟到 30 时，只再投入 20。</li><li>离线、暂离或离座后返桌，仍使用原身份。没漏盲无需补盲；漏盲可等自然大盲，或按提示补盲。补小盲直接进底池、不抵跟注。最多一次大盲加一次小盲，不按缺席手数累计；同手重连不重新收盲。</li></ol>
<h3 class="rule-title">德州扑克</h3><ol class="rule-list"><li>每人两张底牌，依次发出翻牌、转牌、河牌；用底牌与公共牌组成最强五张牌。</li><li>庄位顺时针轮转。两人局由庄家下小盲，翻牌前先行动、翻牌后后行动。</li><li>加注金额表示本轮累计下注总额。未达到完整加注的短码全下不会自动重新开放已行动玩家的加注权。</li><li>超时自动过牌；需要跟注时自动弃牌。断线后本手继续计时；后续手牌跳过缺席玩家，返回后同步牌桌。当前手的投入不退回，全下照常跑牌。</li><li>首手由房主开始，之后结算停留约 5 秒自动继续；补看余牌时会等展示完成。房主可暂停自动发牌；可在手牌进行中安排本手后暂离或离座，随时可补码，当前手进行中则结束后到账、下一手可用；两手间可主动亮牌。</li><li>多人全下按实际投入分主池和边池；未被跟注的部分退回。平分零头从庄家左侧按座次分配。</li></ol>
<h3 class="rule-title">牌桌互动与补看</h3><p class="note">点击头像查看选手核心数据；底部“互动”入口可泼水、丢番茄、摸头或碰杯。全下单池中，领先方被大幅反超时会收到自动摸头。可在菜单关闭娱乐特效。这些只影响显示，不改变牌序、胜率或结算。弃牌结束后自动补看原牌堆的剩余公共牌，不公开弃牌，不计入输赢。</p>
<h3 class="rule-title">普通鱿鱼与无限鱿鱼</h3><ol class="rule-list"><li>至少 3 人开轮。新人满足入桌与预留条件后，可从下一手加入当前轮；以 0 鱼加入，总鱼数加 1。累计责任名单可超过 9 人，同时发牌仍不超过座位数。只有独自赢得主池才拿鱼；平分主池和仅赢边池均不计，炸弹池独赢主池也计入。</li><li>普通鱿鱼：每人最多 1 条，已有鱼再次独赢不再增加。开轮鱼数为实际人数 − 1，每人按总鱼数 × 每条积分预留，最后只剩 1 人没鱼时结轮。</li><li>无限鱿鱼：开轮鱼数 = 实际人数 + 额外条数，中途每成功加入一位新人再加 1 条。额外默认 3 条，可设置 0–100 条；例如 9 人加 3 条，共 12 条鱼。每次独赢主池都拿 1 条，可以重复拿鱼。只剩 1 人没鱼，或本轮鱼发完，先达到哪个就结轮。每人预留本轮总鱼数 × 每条积分；预留不能用于下注。</li><li>结轮时，每位无鱼者向每位有鱼者支付“该玩家鱼数 × 每条积分”。只按实际已拿的鱼计算，未发出的鱼不计费，剩余预留退回。例：两位玩家分别有 3 条、1 条，另两人无鱼，每条 2 BB；两位无鱼者各付 8 BB，两位有鱼者分别获 12 BB、4 BB。无鱼者不互相收款。</li><li>新人实际拿牌时才加入并收预留；本人或原有无鱼玩家预留不足时先等待，原轮照常继续。原轮玩家掉线、暂离或离座后，从下一手起不再发牌、不持续扣盲；其余可参与的原轮玩家达到两人即可继续。已有鱼数、预留与结算责任保留；结轮前回来恢复原身份，不重复增加鱼数或收一份入轮预留。</li><li>如果可继续打的原轮玩家都已有鱼，剩余无鱼者均缺席或不能参与，打完当前手等待 5 秒后按现有鱼数结轮，允许多人同时无鱼。缓冲期间及时回来并满足参与条件可继续。</li><li>原轮不足两人可参与时，等待返回、补码或补盲；持续 90 秒后，本轮在线参与者可在两手之间提前结算。无人拿鱼则全部预留退回；已结轮不能撤销。</li></ol>
<h3 class="rule-title">炸弹池 · 单公共牌</h3><ol class="rule-list"><li>从首手开始按约定分钟计时，到点后在下一手符合条件时触发；不打断当前手，也不补发多次。每人支付相同 BB 前注，无小盲、大盲及翻前下注，直接发出三张翻牌。</li><li>之后按普通德州行动、比牌和分池，翻后由庄家左侧首个可行动者开始。</li><li>积分不足前注时全下，仍按实际投入分池。有玩家等盲入桌时，先用有大小盲的常规发牌处理入桌；已有鱿鱼轮仍计鱼。</li></ol>
<h3 class="rule-title">牌桌计时与时间牌</h3><ol class="rule-list"><li>首手开始计时；最后 5 分钟不再开启新鱿鱼轮或炸弹池，但到时前仍可加入已有轮。到时不再增加本轮参与者，通常打完当前手散桌；若有鱿鱼原轮且能够继续，则继续打完原轮。原轮不足两人时，当前手后等待最多 90 秒恢复，仍不能继续则按现有标记结算散桌。</li><li>每次行动固定思考 20 秒。时间牌每张固定延长 30 秒，按整场时长一次发放：半小时 3 张、一小时 6 张、两小时 12 张；不足半小时的部分按半小时计算。整场不重置，离座或重连不补发。</li></ol><p class="note">仅供朋友积分局，不提供充值、提现或现金下注。</p>`,'rules');}
function fairnessSourceLinks(sourceUrls) {
  const entries=Array.isArray(sourceUrls)?sourceUrls:sourceUrls&&typeof sourceUrls==='object'?Object.values(sourceUrls):[sourceUrls];
  const labels={'/api/source/poker.js':'查看洗牌、比牌与分池代码','/api/source/fairness.js':'查看发牌指纹校验代码'};
  return entries.map(entry=>{
    const value=typeof entry==='string'?{url:entry}:entry;
    if(!value||typeof value.url!=='string')return '';
    const href=value.url.trim(),relative=href.startsWith('/api/');
    if(/[\u0000-\u0020\\]/.test(href)||(!relative&&!/^https?:\/\//i.test(href)))return '';
    let url;try{url=new URL(href,'https://bbpoker.invalid');}catch{return '';}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(relative&&!url.pathname.startsWith('/api/')))return '';
    const label=typeof value.label==='string'&&value.label.trim()?value.label.trim():labels[url.pathname]||'查看源码（'+(url.pathname.split('/').filter(Boolean).at(-1)||url.hostname)+'）';
    return '<a class="note" href="'+esc(relative?apiUrl(href):href)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>';
  }).join('');
}
async function fairnessModal(){const guard=requests.capture();openModal('发牌与隐私',`<p class="note">正在读取公开说明…</p>`,'fairness');const modal=state.modal;try{const f=await api('/api/fairness');guard.check();if(state.modal!==modal)return;const paragraphs=value=>(Array.isArray(value)?value:[value]).filter(Boolean).map(t=>`<p class="note">${esc(t)}</p>`).join('');openModal('发牌与隐私',`<p class="note brand-fairness-note">BBPoker 使用公开的随机洗牌实现与牌局承诺校验。它们不能代替独立审计；当前仍需信任服务器运行者。</p><h3 style="margin:16px 0 10px">密码学随机洗牌</h3>${paragraphs(f.summary)}<h3 class="rule-title">牌局承诺可以核验什么</h3><p class="note">每手开始锁定整副牌的承诺值。你可以核对当前已知牌与这一承诺是否一致；只有公共牌、你自己的底牌及主动公开的底牌会获得核验证明。</p><h3 class="rule-title">核验的边界</h3>${paragraphs(f.limits)||'<p class="note">承诺校验不能单独证明服务器最初没有挑选牌序，也不能防止玩家在平台外串通。源码与测试用于进一步审阅。</p>'}<div class="verification">版本：${esc(f.version||'公开版本')}<br>未公开底牌不会发送给其他玩家；牌谱和导出也保留相同隐私限制。</div>${f.sourceUrls?`<div class="stack" style="margin-top:16px">${fairnessSourceLinks(f.sourceUrls)}</div>`:''}${state.room?.hand?`<div class="modal-footer">${btn('核验当前牌局','verify','primary')}</div>`:''}`,'fairness');}catch(error){if(error.stale||!guard.valid()||state.modal!==modal)return;closeModal();toast(error.message,true);}}
async function verifyHand(hand=state.room?.hand){if(!hand)return toast('开始第一手后即可核验');const guard=requests.capture();const proofs=[...(hand.proofs||[]),...(hand.rabbit?.proofs||[])],root=hand.commitment,receipt=receipts[hand.id],receiptMatches=receipt===root;openModal('核验已知牌',`<p class="note">正在本设备计算承诺证明…</p>`,'verify');const verificationModal=state.modal;const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');try{if(!crypto.subtle)throw new Error('本地校验需要 HTTPS 或 localhost 的安全连接');const rows=await Promise.all(proofs.map(async proof=>{let value=await hash(`${hand.id}:${proof.position}:${proof.card}:${proof.salt}`);for(const sibling of proof.siblings||[])value=await hash(sibling.side==='left'?sibling.hash+value:value+sibling.hash);return {card:proof.card,valid:value===root};}));guard.check();if(state.modal!==verificationModal)return;openModal('核验已知牌',`<p class="note">在你的设备上重新计算每张可见牌的 SHA-256 证明，并与本手发牌承诺对比。</p><div class="verification">${receipt?`<strong class="${receiptMatches?'positive':'negative'}">${receiptMatches?'✓ 与本机此前保存的承诺一致':'⚠ 与本机此前保存的承诺不一致'}</strong><br>`:'<span class="gold">本机没有这手的承诺回执，仅检查文件内部一致性。</span><br>'}${rows.length?`<strong>${rows.every(r=>r.valid)?'✓ 所有可见牌与文件承诺一致':'发现不一致，请保存牌局记录'}</strong><br>${rows.length} 张牌已检查`:'本手尚无可核验的可见牌'}<br><br>牌局 ID<br><span class="mono">${esc(hand.id)}</span><br><br>发牌承诺<br><span class="mono">${esc(root||'暂无')}</span></div><div class="row wrap" style="margin:17px 0">${rows.map(r=>`<div style="text-align:center">${card(r.card,'small-card')}<small class="${r.valid?'positive':'negative'}">${r.valid?'✓':'×'}</small></div>`).join('')}</div><p class="note">本机仅保存首次收到的承诺，不保存底牌或盐值；首次看到的时间可能晚于开局。校验不能独立证明服务器初始没有挑选牌序，也不能验证尚未公开的牌。</p>`,'verify');}catch(error){if(error.stale||!guard.valid()||state.modal!==verificationModal)return;closeModal();toast(error.message,true);}}
function eventText(event,players=state.room?.players||[],bb=state.room?.settings?.bigBlind){if(typeof event==='string')return event;const name=players.find(p=>p.id===event.playerId)?.name||'',amount=event.type==='raise'?(event.to??event.amount):(event.amount??event.to);const labels={allInLock:'下注结束，公开全下底牌',runoutCard:({flop:event.board?.length===3?'发出翻牌（三张）':'发出翻牌',turn:'发出转牌',river:'发出河牌'}[event.street]||'发出公共牌'),timebank:'使用时间牌',bombPot:'炸弹池',mushroom:'旧蘑菇池结算',mushroomRefund:'旧蘑菇池退回',fold:'弃牌',check:'过牌',call:'跟注',raise:'加注至',allin:'全下',smallBlind:'小盲',bigBlind:'大盲',small_blind:'小盲',big_blind:'大盲',ante:'前注',entryBlind:'入桌大盲',deadBlind:'补小盲（不抵跟注）',refund:'退回未跟注积分',uncalled:'退回未跟注积分',win:'赢得',payout:'获得',deal:'发牌',flop:'发出翻牌',turn:'发出转牌',river:'发出河牌',showdown:'摊牌',street:'进入下一轮',start:'开始本手',complete:'本手结束',show:'主动亮牌'};return `${name?name+' · ':''}${labels[event.type]||event.type||'牌局更新'}${event.type==='timebank'&&event.seconds?' +'+num(event.seconds)+'秒':amount!==undefined?' '+chips(amount,bb):''}${event.board?.length?' · '+event.board.join(' '):''}`;}
async function historyModal(){if(state.room)await openHandLibrary(state.room.code,'table');}
async function replayModal(id,code=state.room?.code,mode='replay'){
  const guard=requests.capture(),request=++state.replayRequest;if(!code)return;
  if(state.modal?.kind==='hand-library')state.libraryReturn={draft:records.captureRecordDraft(document.querySelector('#hand-records-filter-form'),state.library,document.activeElement),scroll:dialog.scrollTop};
  const origin=state.modal?.kind==='career'?'stats-modal':state.page==='career'?'stats':state.modal?.kind==='hand-library'?'library-modal':state.page==='hands'?'library':'room';
  openModal(mode==='overview'?'手牌概览':'牌局回放','<div class="empty"><span class="spinner"></span></div>','replay-loading');
  try{
    const response=await api(`/api/rooms/${encodeURIComponent(code)}/hands/${encodeURIComponent(id)}`),hand=response.hand||response;
    guard.check();if(state.modal?.kind!=='replay-loading'||request!==state.replayRequest)return;
    const replay={hand,index:0,origin,favorite:hand.favorite??state.library.hands.find(h=>h.id===id)?.favorite??false};
    state.replay=replay;
    if(mode==='overview')renderOverview();else startOverviewReplay();
    if(hand.rabbit?.active)historyRefresh.watch();
  }catch(error){if(error.stale||request!==state.replayRequest||state.modal?.kind!=='replay-loading')return;closeModal();toast(error.message,true);}
}
function overviewBackButton(){const origin=state.replay.origin;return ['stats','stats-modal'].includes(origin)?btn('返回我的数据',origin==='stats-modal'?'career':'close-modal','ghost small'):btn(origin==='library'||origin==='library-modal'?'返回牌谱':'本桌牌谱',origin==='library-modal'?'library-return':origin==='library'?'close-modal':'history','ghost small');}
function renderOverview(){
  if(!state.replay||!state.user)return;
  const {hand}=state.replay;
  const body=`${historyTurnNotice()}<div class="hand-overview-head"><p class="note">${esc(hand.roomName)} · ${esc(fmtDate(hand.at))}</p><div class="row wrap">${hand.players.some(p=>p.id===state.user.id)?btn(state.replay.favorite?'★ 已收藏':'☆ 收藏','favorite','ghost small',`data-hand="${esc(hand.id)}" data-favorite="${!state.replay.favorite}"`):''}${btn('▶ 播放回放','overview-play','primary small')}</div></div>${renderHandOverview(hand,state.user.id)}<div class="modal-footer overview-footer">${overviewBackButton()}${btn('核验这手牌','verify-history','outline small')}</div>`;
  openModal(`第 ${num(hand.number)} 手牌 · 行动概览`,body,'hand-overview');tick();
}
function startOverviewReplay(){
  if(!state.replay||!state.user)return;
  const replay=state.replay,request=state.replayRequest,guard=requests.capture();
  state.replayPlayback?.dispose();replay.index=0;
  state.replayPlayback=createReplayPlayback({total:replay.hand.log?.length||0,speed:state.replaySpeed,onChange:frame=>{
    if(!guard.valid()||request!==state.replayRequest||state.replay!==replay)return;
    replay.index=frame.index;state.replaySpeed=frame.speed;if(state.modal?.kind==='replay')renderReplay();
  }});
  renderReplay();if(document.visibilityState!=='hidden')playReplay();tick();
}
function renderReplay(){
  if(!state.replay||!state.user)return;
  const {hand,index}=state.replay,view=replaySnapshot(hand,index,state.user.id),stages=replayStreets(hand),log=hand.log||[];
  const visible=historyBoard({...hand,board:view.board,rabbit:view.rabbit});
  const playing=Boolean(state.replayPlayback?.snapshot().playing),playLabel=playing?'暂停':index>=log.length?'重播':'播放';
  // replaySnapshot validates each payout against the available pot. At the
  // final frame, show that distributed amount, not the now-empty remainder.
  const paidPot=view.players.reduce((sum,p)=>sum+p.payout,0),hasPaidPot=view.complete&&log.some(e=>e.type==='payout')&&Number.isSafeInteger(paidPot)&&paidPot>=0;
  const displayedPot=view.complete?(hasPaidPot?paidPot:null):view.pot;
  const frame=`<div class="replay-table"><div class="pot-label">${view.complete?(hasPaidPot?'已分配底池':'已完成结算'):'底池'}</div>${displayedPot===null?'':`<strong class="pot-amount">${chips(displayedPot,hand.settings?.bigBlind??hand.bigBlind??null)}</strong>`}<div class="board">${Array.from({length:5},(_,i)=>card(visible.board[i],i>=visible.actualCount&&visible.board[i]?'rabbit-card':'',!visible.board[i])).join('')}</div><div class="replay-caption">${view.lastEvent?esc(eventText(view.lastEvent,hand.players,hand.settings?.bigBlind??hand.bigBlind??null)):'开始 · 逐步查看这手牌'}</div></div>`;
  const players=`<div class="replay-players">${view.players.map(p=>`<div class="replay-player ${p.folded?'folded':''} ${!view.complete&&p.allIn&&!p.folded?'is-allin':''}"><div class="row"><b>${esc(p.name)} ${p.id===state.user.id?'<span class="you-tag">我</span>':''}</b><strong>${chips(p.stack,hand.settings?.bigBlind??hand.bigBlind??null)}</strong></div><div class="row replay-player-detail"><div class="row gap6">${cards(p.cards||[null,null],'mini')}</div><small>${view.complete?`德州 <span class="${profitClass(p.net)}">${signedChips(p.net,hand.settings?.bigBlind??hand.bigBlind??null)}</span><br>小游戏 ${signedChips(p.miniNet,hand.settings?.bigBlind??hand.bigBlind??null)}`:p.folded?'<span class="replay-state state-fold">已弃牌</span>':p.allIn?'<span class="replay-state state-allin">全下</span>':`本轮已下 ${chips(p.bet,hand.settings?.bigBlind??hand.bigBlind??null)}`}</small></div>${statsUI.renderEquityBadge(view.equity?.players.find(q=>q.id===p.id),{approximate:view.equity?.method==='monte-carlo'})}${view.complete&&hand.squidRound&&Number.isSafeInteger(hand.squidCounts?.[p.id])?`<small class="replay-fish-count">本手结束时 · 鱼×${num(hand.squidCounts[p.id])}${hand.squidAwardedId===p.id?' · 本手＋1':''}</small>`:''}${view.complete&&p.endingStack!=null?`<small class="ending-stack">结算后筹码 ${chips(p.endingStack,hand.settings?.bigBlind??hand.bigBlind??null)}</small>`:''}</div>`).join('')}</div>`;
  const notes=`${visible.rabbitCount?'<p class="replay-rabbit note">金色虚线牌为结算后补看，不参与输赢或胜率统计。</p>':visible.pending?'<p class="replay-rabbit note" role="status">正在补看余牌…</p>':''}${view.complete&&hand.timeBankUses?.length?`<p class="privacy-footnote">本手使用时间牌 ${hand.timeBankUses.length} 张，累计延长 ${num(hand.timeBankUses.reduce((n,x)=>n+Number(x.seconds||0),0))} 秒。</p>`:''}${view.complete&&hand.settings?.mushroom?'<p class="privacy-footnote">本手保留旧版蘑菇池记录，相关积分计入小游戏结算。</p>':''}`;
  const existing=dialog.querySelector('.replay-view');
  if(state.modal?.kind==='replay'&&existing?.dataset.hand===String(hand.id)){
    // Keep the same range, speed selector and buttons attached during playback.
    // Replacing them on each input interrupts pointer capture and mobile drags.
    const scroll=dialog.scrollTop;
    dialog.querySelector('[data-replay-frame]').innerHTML=frame;
    dialog.querySelector('[data-replay-players]').innerHTML=players;
    dialog.querySelector('[data-replay-notes]').innerHTML=notes;
    const play=dialog.querySelector('[data-action="replay-play"]');play.textContent=playLabel;play.setAttribute('aria-pressed',String(playing));play.setAttribute('aria-label',playing?'暂停回放':index>=log.length?'重新播放':'播放回放');
    dialog.querySelector('[data-action="replay-prev"]').disabled=index===0;
    dialog.querySelector('[data-action="replay-next"]').disabled=index>=log.length;
    const progress=dialog.querySelector('#replay-progress');progress.value=String(index);progress.setAttribute('aria-valuetext',`第 ${index} 步，共 ${log.length} 步`);
    dialog.querySelector('#replay-position').textContent=`${index} / ${log.length} 步`;
    dialog.querySelector('#replay-speed').value=String(state.replaySpeed);
    dialog.querySelectorAll('.replay-streets button').forEach((button,i)=>{const active=index>=stages[i].index&&(i===stages.length-1||index<stages[i+1].index);button.classList.toggle('active',active);button.setAttribute('aria-current',String(active));});
    dialog.querySelectorAll('.replay-log button').forEach((button,i)=>{button.classList.toggle('current',i===index-1);button.classList.toggle('future',i>=index);});
    const favorite=dialog.querySelector('[data-replay-favorite]');if(favorite){favorite.textContent=state.replay.favorite?'★ 已收藏':'☆ 收藏';favorite.dataset.favorite=String(!state.replay.favorite);}
    dialog.scrollTop=scroll;return;
  }
  const body=`${historyTurnNotice()}<div class="overview-switch">${btn('← 行动概览','overview-return','outline small')}</div><section class="replay-view" data-hand="${esc(hand.id)}"><div class="row between"><span class="note" style="margin:0">${esc(hand.roomName)}${hand.bombPot?' · 炸弹池':''}${hand.squidRound?` · ${lifecycle.squidName(hand.squidMode)} 第${num(hand.squidRound)}轮`:''} · ${esc(fmtDate(hand.at))}</span>${hand.players.some(p=>p.id===state.user.id)?btn(state.replay.favorite?'★ 已收藏':'☆ 收藏','favorite','ghost small',`data-replay-favorite data-hand="${esc(hand.id)}" data-favorite="${!state.replay.favorite}"`):''}</div><nav class="replay-streets" aria-label="跳转至回合">${stages.map((step,i)=>{const active=index>=step.index&&(i===stages.length-1||index<stages[i+1].index);return btn(esc(step.label),'replay-street',active?'active':'',`data-index="${step.index}" aria-current="${active}"`);}).join('')}</nav><div class="replay-frame" data-replay-frame>${frame}</div><div class="replay-transport" role="group" aria-label="回放控制"><div class="replay-controls">${btn('‹','replay-prev','outline',`aria-label="上一步" ${index===0?'disabled':''}`)}${btn(playLabel,'replay-play','primary',`aria-label="${playing?'暂停回放':'播放回放'}" aria-pressed="${playing}" ${!log.length?'disabled':''}`)}${btn('›','replay-next','outline',`aria-label="下一步" ${index>=log.length?'disabled':''}`)}<label class="replay-speed-label" for="replay-speed">速度</label><select id="replay-speed" aria-label="回放速度">${REPLAY_SPEEDS.map(speed=>`<option value="${speed}" ${state.replaySpeed===speed?'selected':''}>${speed}×</option>`).join('')}</select></div><div class="replay-timeline"><input type="range" aria-label="回放进度" aria-valuetext="第 ${index} 步，共 ${log.length} 步" id="replay-progress" min="0" max="${log.length}" step="1" value="${index}" class="replay-progress" ${!log.length?'disabled':''}><output id="replay-position" for="replay-progress">${index} / ${log.length} 步</output></div></div><div data-replay-players>${players}</div><div data-replay-notes>${notes}</div><details class="replay-log-details"><summary>逐步记录</summary><div class="replay-log">${log.map((e,i)=>`<button type="button" data-action="replay-street" data-index="${i+1}" class="${i===index-1?'current':''} ${i>=index?'future':''}">${i+1}. ${esc(eventText(e,hand.players,hand.settings?.bigBlind??hand.bigBlind??null))}</button>`).join('')}</div></details><p class="privacy-footnote">全下底牌从下注结束时展示，其他已公开底牌在结算步展示；未公开底牌始终隐藏。过程中筹码只计德州，小游戏结算单列。</p><div class="row between">${['stats','stats-modal'].includes(state.replay.origin)?btn('返回我的数据',state.replay.origin==='stats-modal'?'career':'close-modal','ghost small'):btn(state.replay.origin==='library'||state.replay.origin==='library-modal'?'返回牌谱':'本桌牌谱',state.replay.origin==='library-modal'?'library-return':state.replay.origin==='library'?'close-modal':'history','ghost small')}${btn('核验这手牌','verify-history','outline small')}</div></section>`;
  openModal(`第 ${num(hand.number)} 手牌回放`,body,'replay');
}
function stopReplay(){state.replayPlayback?.pause();}
function playReplay(){if(state.modal?.kind==='replay'&&document.visibilityState!=='hidden')state.replayPlayback?.play();}
async function replayLastHand(){if(!state.room)return;const guard=requests.capture(),code=state.room.code,previousModal=state.modal,request=state.replayRequest;try{const data=await api(`/api/rooms/${encodeURIComponent(code)}/history`);guard.check();if(state.modal!==previousModal||state.replayRequest!==request||state.room?.code!==code)return;const latest=[...(data.hands||[])].sort((a,b)=>Number(b.number)-Number(a.number))[0];if(latest)await replayModal(latest.id,code,'overview');else toast('完成第一手后即可查看牌谱');}catch(error){if(!error.stale&&guard.valid()&&state.modal===previousModal&&state.replayRequest===request)toast(error.message,true);}}

function exportModal(){const tableScope=state.page==='room'&&state.library.scope==='table';state.exportRoom=state.modal?.kind==='career'||state.page==='career'?state.statsView.room:state.room?.code||state.library.room||'';openModal('导出牌谱',`<form id="export-form"><p class="note">导出本人参加过的手牌，只包含自己的底牌和已公开牌。${tableScope?'':'可另选日期；'}记录页的输赢、对手、位置、翻后人数、起手牌、玩法、收藏及手数等筛选不用于导出。<br>范围：${state.exportRoom?esc(state.rooms.find(r=>r.code===state.exportRoom)?.name||'房间 '+state.exportRoom+' 的对局'):'全部对局'}</p><label class="field">导出格式<select name="format"><option value="json">JSON · 完整结构，便于备份与核验</option><option value="txt">TXT · 易读逐手牌谱</option><option value="csv">CSV · 用表格分析</option><option value="phh">PHH · 通用牌谱，便于其他工具读取</option></select></label>${tableScope?'':`<details class="help-details"><summary>筛选日期</summary><div class="record-date-fields"><label class="field">开始日期<input name="from" type="date"></label><label class="field">结束日期<input name="to" type="date"></label></div></details>`}<div class="modal-footer">${btn('取消','close-modal','ghost')}<button type="submit" class="primary">下载记录</button></div></form>`,'export');}
async function handleAction(button){const action=button.dataset.action;if(button.disabled)return;const modal=state.modal,roomCode=state.room?.code,ownsModal=()=>state.modal===modal&&state.room?.code===roomCode;switch(action){case'display-unit':changeMoneyUnit(button.dataset.unit);break;case'lobby-refresh':await loadLobby({refreshHistory:true});break;case'lobby-filter':if(['all','joinable','mine'].includes(button.dataset.filter)){state.lobby.filter=button.dataset.filter;render();}break;case'join-public':await joinPublicRoom(button.dataset.code);break;case'join-invite':joinInviteModal(button.dataset.code);break;case'cancel-departure':if(await command('cancelDeparture')){toast('已取消安排');if(ownsModal()&&state.modal?.kind==='room-menu')roomMenu();}break;case'departure-confirm':await confirmDeparture();break;case'entry-blind':entryBlindModal();break;case'entry-blind-confirm':await confirmEntryBlind(button.dataset.mode);break;case'settle-squid':settleSquidModal();break;case'settle-squid-confirm':if(await command('settleSquid')){if(ownsModal())closeModal();toast('本轮鱿鱼已结算');}break;case'player-stats':await playerStatsModal(button.dataset.player);break;case'player-stats-scope':await playerStatsModal(state.playerStats?.playerId,button.dataset.scope);break;case'player-stats-retry':await playerStatsModal(state.playerStats?.playerId,state.playerStats?.scope);break;case'interact':interactionModal(button.dataset.player);break;case'interact-target':interactionModal(button.dataset.player);break;case'throw':await sendThrow(button.dataset.emote,button.dataset.target,button.dataset.room);break;case'toggle-fun':state.fun=!state.fun;state.funEffects=[];saveTablePreferences();render();if(state.modal?.kind==='interactions')interactionModal(state.funTarget);else roomMenu();break;case'stats-period':await setStatsPeriod(button.dataset.period);break;case'stats-reset':state.statsView.filters=statsUI.defaultStatsFilters();state.statsView.room='';await loadStats();break;case'stats-retry':await loadStats();break;case'stats-metric':openModal('指标说明',statsUI.renderStatsMetricDetails(button.dataset.metric)+btn('返回我的数据','stats-return','outline'),'stats-metric');break;case'stats-return':if(state.page==='room')await careerModal();else closeModal();break;case'equity-details':equityDetails();break;case'lobby':navigate('');break;case'career':if(state.page==='room')await careerModal();else navigate('/career');break;case'opponents':navigate('/opponents');break;case'opponents-retry':await loadOpponents();break;case'opponent-hands':openOpponentHands(button.dataset.opponent);break;case'sessions':await openSessions();break;case'sessions-retry':await loadSessions(true);break;case'sessions-more':await loadSessions();break;case'session-detail':await sessionDetailModal(button.dataset.code);break;case'session-hands':await openHandLibrary(button.dataset.code);break;case'library-return':returnToHandLibrary();break;case'record-hole-preset':{const form=button.closest('form');if(records.applyHolePreset(form,button.dataset))await applyRecordFilters(form);break;}case'record-period':await setRecordPeriod(button);break;case'record-reset':await resetRecordFilters(button.dataset.kind);break;case'hands':if(state.page==='room')await historyModal();else navigate('/hands');break;case'library-view':await setLibraryView(button.dataset.view);break;case'library-opponent-back':await setLibraryView('opponents');break;case'library-opponent-mode':await setOpponentMode(button.dataset.mode);break;case'library-opponent-clear-search':clearOpponentSearch();break;case'library-opponent-sort':sortLibraryOpponents(button.dataset.sort);break;case'library-opponent':await selectLibraryOpponent(button.dataset.opponent);break;case'library-all':state.library.favorites=false;await loadLibrary(true);break;case'library-favorites':state.library.favorites=true;await loadLibrary(true);break;case'library-retry':await loadLibrary(true);break;case'library-more':await loadLibrary();break;case'favorite':await favoriteHand(button.dataset.hand,button.dataset.favorite==='true',button);break;case'toggle-chat':state.chatOpen=!state.chatOpen;if(state.chatOpen)state.chatUnread=0;render();if(state.chatOpen)document.querySelector('#chat-drawer [data-action="toggle-chat"]')?.focus({preventScroll:true});else $('#chat-toggle')?.focus({preventScroll:true});break;case'table-info':tableInfoModal();break;case'resume-deal':await command('autoDeal',{paused:false});break;case'toggle-autodeal':if(await command('autoDeal',{paused:!state.room.autoDeal?.paused})&&ownsModal())roomMenu();break;case'toggle-sound':state.sound=!state.sound;tableSounds.setEnabled(state.sound);if(state.sound)tableSounds.unlock();saveTablePreferences();roomMenu();break;case'toggle-voice':state.voice=!state.voice;tableSounds.setVoiceEnabled(state.voice);if(state.voice)tableSounds.unlock();saveTablePreferences();roomMenu();break;case'mute-chat':state.chatMuted=!state.chatMuted;state.chatUnread=0;render();break;case'mute-reactions':state.reactionsMuted=!state.reactionsMuted;state.reactions={};render();break;case'toggle-animations':state.animations=!state.animations;state.motion=null;state.handCategoryMotion=[];document.documentElement.classList.toggle('no-motion',!state.animations);saveTablePreferences();roomMenu();break;case'send-emote':await sendChat('emote',button.dataset.emote);break;case'hand-overview':await replayModal(button.dataset.hand,button.dataset.room,'overview');break;case'overview-play':startOverviewReplay();break;case'overview-return':renderOverview();break;case'last-hand':await replayLastHand();break;case'retry':boot();break;case'close-modal':closeModal();break;case'create':createModal();break;case'load-room-settings':await loadPreviousRoomSettings(button);break;case'blind-preset':applySettingPreset(button,'blind');break;case'duration-preset':applySettingPreset(button,'duration');break;case'bomb-preset':applySettingPreset(button,'bomb');break;case'buyin-preset':{const form=button.closest('form');form.querySelector('#buyin-amount').value=chipInputValue(Number(button.dataset.value)*Number(form.dataset.bigBlind),Number(form.dataset.bigBlind),form.dataset.unit);updateBuyinSummary(form);break;}case'open-room':navigate(`/room/${encodeURIComponent(button.dataset.code)}`);break;case'profile':profileModal();break;case'restore':restoreModal();break;case'auth-login':case'auth-register':requests.invalidate();state.authMode=action==='auth-register'?'register':'login';render();break;case'recover':recoverModal();break;case'bind-account':bindAccountModal();break;case'change-password':changePasswordModal();break;case'copy-token':if(!state.user?.username)await copy(state.token,'旧恢复码已复制，请私下保存');break;case'copy-recovery':if(state.pendingRecovery)await copy(state.pendingRecovery.code,'找回码已复制，请私下保存');break;case'save-recovery':if(state.pendingRecovery){const r=state.pendingRecovery,result=await saveExport({name:'BBPoker-账号找回码.txt',content:`网站：https://bbpoker.fun
账号：${r.username}
找回码：${r.code}
请私下保存。用于忘记密码时设置新密码；修改密码后旧码失效。
`,mime:'text/plain;charset=utf-8'});if(!result.canceled)toast('找回资料已交给系统保存');}break;case'recovery-done':state.pendingRecovery=null;await route();break;case'logout-confirm':if(state.user?.username){openModal('退出登录',`<p class="note">牌谱和积分记录仍会保留，下次用账号密码登录。</p><div class="modal-footer">${btn('取消','close-modal','ghost')}${btn('退出当前设备','logout','danger')}</div>`);}else openModal('退出前，留好旧恢复码',`<p class="note">你尚未设置账号。请保存旧恢复码，下次用它找回当前昵称和记录。</p><div class="recovery">${esc(state.token)}</div><div class="modal-footer">${btn('复制旧恢复码','copy-token','outline')}${btn('已保存，退出','logout','danger')}</div>`);break;case'logout':await logout();break;case'choose-seat':toast('点击牌桌周围带 ＋ 的空座位');document.querySelector('.table-stage')?.scrollIntoView({behavior:'smooth',block:'center'});break;case'sit':buyinModal(Number(button.dataset.seat));break;case'buyin':buyinModal();break;case'invite':inviteModal();break;case'copy-invite':await copy($('#invite-link').value,'邀请已复制，发给你的朋友吧');break;case'share-invite':await shareInvitation({title:`BBPoker · ${state.room.name}`,text:'BBPoker给你留了个位置，来和朋友打一场积分局。',url:$('#invite-link').value});break;case'room-menu':roomMenu();break;case'rules':rulesModal();break;case'fairness':fairnessModal();break;case'verify':verifyHand();break;case'verify-history':verifyHand(state.replay.hand);break;case'settings':openModal('调整牌桌设置',`<form id="settings-form"><p class="note">开始第一手后将锁定本桌设置。</p>${settingFields(state.room.settings)}<div class="modal-footer">${btn('取消','close-modal','ghost')}<button class="primary" type="submit">保存设置</button></div></form>`,'settings');break;case'approve':case'reject':await command(action,{requestId:button.dataset.request});break;case'timebank':if(seatTimeBankEnabled(state.room))await command(action);break;case'fold':case'check':case'call':await command(action);break;case'raise':case'raise-preset':case'allin':await submitBetButton(button);break;case'toggle-raise-panel':setRaisePanel(!state.raisePanelOpen,{focus:true});break;case'close-raise-panel':setRaisePanel(false,{focus:true});break;case'start':await command('start');break;case'stand':departureModal('stand');break;case'stand-confirm':await confirmDeparture();break;case'sitout':{const me=state.room.players.find(p=>p.id===state.room.meId);if(me?.sittingOut){if(lifecycle.entryBlindView(state.room,me)){entryBlindModal(true);break;}if(await command('sitout',{value:false})){toast('已恢复参与');if(ownsModal()&&state.modal?.kind==='room-menu')roomMenu();}}else departureModal('sitout');break;}case'show-card':{const room=state.room,me=room?.players.find(p=>p.id===room.meId),index=Number(button.dataset.index);if(room?.hand?.id!==button.dataset.hand||!revealOptions(room,me).some(c=>c.index===index&&c.canReveal))break;await command('show',{indices:[index],handId:button.dataset.hand});break;}case'transfer-host':openModal('转交房主',`<p class="note">接任的朋友将获得开局及结束房间权限。</p><div class="stack">${state.room.players.filter(p=>p.id!==state.room.meId).map(p=>btn(`${esc(p.name)} ↗`,'transfer-confirm','outline',`data-player="${esc(p.id)}"`)).join('')||'<p class="note">还没有可以接任的朋友。</p>'}</div>`);break;case'transfer-confirm':if(await command('transferHost',{playerId:button.dataset.player})&&ownsModal())closeModal();break;case'close-room-confirm':openModal('结束牌桌',`<p class="note">结束后不能再继续发牌。未结束的鱿鱼轮按现有标记结算：未获标记者向每位已获标记者支付约定积分，其余预留退回。历史与积分记录保留。</p><div class="modal-footer">${btn('继续同桌','close-modal','ghost')}${btn('结算并结束','close-room','danger')}</div>`);break;case'close-room':if(await command('close')){if(ownsModal())closeModal();toast('牌桌已结束，记录已经保留');}break;case'history':historyModal();break;case'replay':replayModal(button.dataset.hand,button.dataset.room||state.room?.code);break;case'replay-prev':state.replayPlayback?.seek(state.replay.index-1);break;case'replay-next':state.replayPlayback?.seek(state.replay.index+1);break;case'replay-end':case'replay-street':state.replayPlayback?.seek(action==='replay-end'?state.replay.hand.log.length:Number(button.dataset.index));break;case'replay-play':if(state.replayPlayback?.snapshot().playing)stopReplay();else playReplay();break;case'export':exportModal();break;case'install':if(state.install){await state.install.prompt();await state.install.userChoice;state.install=null;render();}break;}}
async function submitBetButton(button){
  if(state.busy||!state.connected||state.feedbackResync)return;
  const action=button.dataset.action;
  if(action==='raise'&&(!state.raisePanelOpen||Number(button.dataset.amount)!==state.raise))return;
  const submission=betSubmission(state.room,{turnKey:button.dataset.betTurn,amount:button.dataset.amount,preset:action==='raise-preset'?button.dataset.preset:null});
  if(!submission){toast('下注范围已更新，请重新选择',true);return;}
  const {type,...payload}=submission;
  state.raisePanelOpen=false;
  await command(type,payload);
}
function setRaise(value,preset=null){
  const a=state.room?.actions;if(!a?.canRaise||state.busy||!state.connected||state.feedbackResync)return;
  const selected=betSelection(state.room,value,preset);state.raise=selected.amount;state.raisePreset=selected.preset;
  const label=betActionLabel(state.room,state.raise),range=$('#raise-range');
  if(range){range.value=betSliderFromAmount(state.room,state.raise);range.setAttribute('aria-valuetext',`${label} ${chips(state.raise)}`);}
  const output=$('#raise-amount');if(output)output.innerHTML=`${label} <b>${esc(chips(state.raise))}</b>`;
  if($('#raise-button')){$('#raise-button').textContent=`${label} ${chips(state.raise)}`;$('#raise-button').dataset.allin=String(state.raise===a.maxRaiseTo);$('#raise-button').dataset.amount=String(state.raise);$('#raise-button').dataset.betTurn=betTurnKey(state.room)||'';}
}
function setRaisePanel(open,{focus=false}={}){
  state.raisePanelOpen=Boolean(open&&!state.busy&&state.connected&&!state.feedbackResync&&betActionEnabled(state.room,'raise'));
  const panel=$('#raise-panel'),toggle=$('#raise-toggle');
  if(panel)panel.hidden=!state.raisePanelOpen;if(toggle)toggle.setAttribute('aria-expanded',String(state.raisePanelOpen));
  if(focus)(state.raisePanelOpen?$('#raise-range'):toggle)?.focus({preventScroll:true});
}
document.addEventListener('pointerdown',()=>tableSounds.unlock(),{passive:true});
document.addEventListener('keydown',event=>{tableSounds.unlock();if(event.key==='Escape'&&state.chatOpen&&!dialog.open){state.chatOpen=false;render();$('#chat-toggle')?.focus({preventScroll:true});}});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');
  // Cards extend outside the identity panel. Only their own reveal control
  // handles a card tap; passive cards must not open the player's data.
  if(button?.classList.contains('seat-main')&&event.target.closest('.hole-cards'))return;
  if(button){const modal=state.modal;handleAction(button).catch(error=>toast(error.message,true,{modal}));}
});
document.addEventListener('compositionstart',event=>{state.compositionTarget=event.target;state.composing=app.contains(event.target);const form=event.target.form,kind=form?.dataset.recordKind;if(['hands','sessions','opponents'].includes(kind))state.recordComposition={kind,form};});
document.addEventListener('compositionend',event=>finishComposition(event.target));
document.addEventListener('focusout',event=>{const target=event.target;if(target!==state.compositionTarget)return;queueMicrotask(()=>{if(state.compositionTarget===target&&document.activeElement!==target)finishComposition(target);});});
document.addEventListener('input',event=>{if('opponentSearch' in (event.target.dataset||{}))searchLibraryOpponents(event.target.value);if(event.target.id==='chat-input')state.chatDraft=event.target.value;updateSettingConstraints(event.target.form);updateBuyinSummary(event.target.form,event.target);if(event.target.id==='raise-range'&&betActionEnabled(state.room,'raise')){setRaise(betAmountFromSlider(state.room,Number(event.target.value)));}if(event.target.id==='replay-progress')state.replayPlayback?.seek(Number(event.target.value));});
document.addEventListener('change',event=>{const input=event.target;if('opponentSort' in input.dataset)sortLibraryOpponents(input.value);if('directOpponentSort' in input.dataset)sortDirectOpponents(input.value);if(input.form?.dataset.recordKind)records.updateRecordFields(input.form,input);if(input.form?.dataset.recordKind==='hands')records.updateHoleDraft(input.form,input);if(input.dataset.statsAuto){if(input.name==='maxHands'&&input.value==='custom'){const field=input.form.querySelector('.stats-custom-hands');field.hidden=false;field.querySelector('input').required=true;field.querySelector('input').focus();}else applyStatsFilters(input.form);}if(input.dataset.recordAuto)applyRecordFilters(input.form);if(input.id==='replay-speed')state.replayPlayback?.setSpeed(Number(input.value));if(input.id==='replay-progress')state.replayPlayback?.endScrub();if(input.dataset.miniToggle){const config=document.getElementById(input.dataset.miniToggle);if(config){config.hidden=!input.checked;for(const field of config.querySelectorAll('input,select'))field.disabled=!input.checked;}}updateSettingConstraints(input.form);});
document.addEventListener('pointerdown',event=>{if(state.raisePanelOpen&&!event.target.closest('#raise-panel, #raise-toggle'))setRaisePanel(false);if(event.target.id==='replay-progress')state.replayPlayback?.beginScrub();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.raisePanelOpen){event.preventDefault();setRaisePanel(false,{focus:true});return;}if(event.target.id==='raise-range'&&betActionEnabled(state.room,'raise')){const amount=betAmountFromKey(state.room,event.key,state.raise);if(amount!==null){event.preventDefault();setRaise(amount);}}});
document.addEventListener('pointerup',()=>state.replayPlayback?.endScrub());
document.addEventListener('pointercancel',()=>state.replayPlayback?.endScrub({resume:false}));
document.addEventListener('invalid',event=>{const details=event.target.closest('details');if(details)details.open=true;},true);
document.addEventListener('toggle',event=>{if(event.target.id==='table-activity'&&event.target.isConnected)state.activityOpen=event.target.open;},true);
document.addEventListener('submit',async event=>{const form=event.target;if(!form.id)return;event.preventDefault();if(form.id==='chat-form'&&state.composing||state.recordComposition?.form===form)return;const submit=form.querySelector('[type=submit]');if(submit?.disabled)return;if(submit)submit.disabled=true;const fd=new FormData(form),guard=requests.capture(),modal=state.modal,roomCode=state.room?.code,ownsModal=()=>guard.valid()&&state.modal===modal&&state.room?.code===roomCode;try{switch(form.id){case'stats-filter-form':await applyStatsFilters(form);break;case'opponent-records-filter-form':case'hand-records-filter-form':case'session-records-filter-form':await applyRecordFilters(form);break;case'profile-form':await saveProfile(fd);break;case'chat-form':await sendChat('text',String(fd.get('text')||''));break;case'login-form':await submitAccount('login',fd);break;case'register-form':await submitAccount('register',fd);break;case'bind-account-form':await submitAccount('bind',fd);break;case'password-form':await submitAccount('password',fd);break;case'recover-form':await submitAccount('recover',fd);break;case'restore-form':{const data=await api('/api/session/restore',{token:String(fd.get('token')).trim()},{anonymous:true});await adoptIdentity(data);closeModal();await route();toast('身份已恢复');break;}case'join-form':{const target=parseInvite(String(fd.get('invite')));closeModal();navigate(target);break;}case'create-form':{if(form.dataset.settingsLoading==='true')break;const result=await api('/api/rooms',{name:String(fd.get('name')).trim(),access:fd.get('access')==='public'?'public':'invite',settings:readSettings(form)});if(!ownsModal())return;closeModal();const room=result.room||result;navigate(`/room/${encodeURIComponent(room.code)}/${encodeURIComponent(room.invite)}`);break;}case'buyin-form':{if(!state.connected||state.feedbackResync)throw new Error('正在同步牌桌，请连接恢复后再确认带入');const amountBB=Number(fd.get('amountBB')),isSit=form.dataset.seat!=='';if(!Number.isSafeInteger(amountBB)||amountBB<100||amountBB>1000||amountBB%50!==0)throw new Error('每次带入 100–1000 BB，需为 50 BB 的整数倍');if(await command(isSit?'sit':'buyin',{amountBB,...(isSit?{seat:Number(form.dataset.seat),entryMode:fd.get('entryMode')==='post'?'post':'wait'}:{})})){if(ownsModal())closeModal();if(isSit&&guard.valid()&&state.room?.code===roomCode){const seated=state.room.players.find(p=>p.id===state.room.meId);if(seated?.seat!=null)toast(`已入座 · ${lifecycle.participation(state.room,seated).label}`);}}break;}case'settings-form':if(await command('settings',{settings:readSettings(form)})&&ownsModal())closeModal();break;case'export-form':{const format=String(fd.get('format')),exportRoom=state.exportRoom,query=new URLSearchParams({format});if(exportRoom)query.set('room',exportRoom);if(fd.get('from'))query.set('from',new Date(String(fd.get('from'))+'T00:00:00').toISOString());if(fd.get('to'))query.set('to',new Date(String(fd.get('to'))+'T23:59:59.999').toISOString());const exportToken=state.token,response=await fetch(apiUrl(`/api/export?${query}`),{headers:{Authorization:`Bearer ${exportToken}`},cache:'no-store'});guard.check();if(response.status===401){await expireIdentity(exportToken);guard.check();}if(!response.ok){const e=await response.json().catch(()=>({}));throw new Error(e.error||'导出暂时失败');}let content=await response.text();guard.check();if(format==='csv'&&!content.startsWith('\uFEFF'))content='\uFEFF'+content;const result=await saveExport({name:`BBPoker-${exportRoom||'我的生涯'}-${new Date().toISOString().slice(0,10)}.${format==='phh'?'phhs':format}`,content,mime:response.headers.get('Content-Type')||'text/plain'});if(!result.canceled&&guard.valid()){toast('记录已交给系统保存');if(ownsModal())closeModal();}break;}}}catch(error){if(!error.stale)toast(error.message,true,{modal});}finally{if(submit?.isConnected)submit.disabled=false;}});
function resetPrivateView(){state.pendingCommand=null;state.pendingFeedback=null;state.potMotion=null;state.raise=0;state.raisePreset=null;state.raisePanelOpen=false;state.raiseTurnKey=null;state.lobby?.controller?.abort();clearTimeout(state.lobby?.timer);state.lobby={rooms:[],filter:'all',loading:false,loaded:false,error:'',request:0,timer:null,controller:null,joining:'',limit:10};state.departureConfirmation=null;state.entryBlindConfirmation=null;feedback.reset();turnCountdown.reset();state.revealMotion=null;funTracker.reset();state.funEffects=[];state.funTarget='';state.throwUntil=0;state.boardMotion=null;state.feedbackResync=true;state.profileSave=null;avatarCache.clear();requests.invalidate();stopStream();closeModal();state.room=null;state.stats=null;state.statsView={data:null,filters:statsUI.defaultStatsFilters(),room:'',loading:false,error:'',request:state.statsView.request+1};state.rooms=[];state.replay=null;state.playerStats=null;state.libraryReturn=null;state.showHandId=null;state.revealed=new Set();state.busy=false;state.activityOpen=false;state.pendingRecovery=null;state.chatDraft='';state.chatBusy=false;state.chatPending=null;state.chatOpen=false;state.chatUnread=0;state.reactions={};state.motion=null;state.composing=false;state.recordComposition=null;state.recordRenderDeferred=false;state.sessions={rows:[],nextCursor:null,totals:null,filters:{period:'all'},loading:false,error:'',request:state.sessions.request+1};state.sessionRequest++;state.sessionDetailData=null;state.opponents={data:null,opponentOptions:[],filters:records.defaultOpponentFilters(),room:'',sort:'profit',loading:false,error:'',request:state.opponents.request+1};state.library={hands:[],nextCursor:null,totals:null,opponents:null,opponentOptions:[],view:'hands',opponentSort:'hands',opponentSearch:'',viewContexts:{},opponentDrilldown:null,filters:{period:'all'},scope:'personal',favorites:false,room:'',loading:false,error:'',request:state.library.request+1};}
async function expireIdentity(token){
  if(!token||state.token!==token)return;
  resetPrivateView();const guard=requests.capture();state.token='';state.user=null;state.authMode='login';state.page='loading';render();
  await clearIdentity(token).catch(()=>{});if(!guard.valid())return;
  state.page='welcome';render();toast('登录已失效，请重新登录；牌谱和积分记录仍会保留',true);
}
async function adoptIdentity(data){
  resetPrivateView();
  state.token=data.token;state.user=data.user;state.identityEphemeral=false;state.page='loading';render();const guard=requests.capture();
  try{await writeIdentity(data.token);}catch{guard.check();state.identityEphemeral=true;toast(data.user.username?'本设备未能记住登录，下次请用账号密码登录':'本设备暂时无法保存身份，请保存旧恢复码',true);}
  guard.check();
}
function resumeTable(){
  if(state.compositionTarget&&(state.compositionTarget.isConnected===false||document.activeElement!==state.compositionTarget))finishComposition(undefined,{renderPending:false});
  if(state.page==='lobby'&&navigator.onLine&&document.visibilityState!=='hidden'){loadLobby({silent:true});return;}
  if(state.page==='room'&&state.room&&navigator.onLine&&document.visibilityState!=='hidden'){abortPendingTableRequests();connectStream(state.room.code);}
}
window.addEventListener('hashchange',route);
window.addEventListener('online',resumeTable);
window.addEventListener('offline',()=>{stopStream();state.connection='网络已断开';updateConnection();});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.install=event;if(state.page==='lobby')render();});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'){finishComposition(undefined,{renderPending:false});stopReplay();stopLobbyPolling();}
  if(document.visibilityState==='visible')resumeTable();
  else if(state.page==='room'){state.pendingFeedback=null;state.potMotion=null;state.funEffects=[];state.boardMotion=null;state.handCategoryMotion=[];funTracker.reset();document.querySelector('.fun-layer')?.remove();state.feedbackResync=true;feedback.reset();tableSounds.suspend();stopStream();state.connection='返回后同步牌桌';updateConnection();}
});
window.addEventListener('pageshow',event=>{if(event.persisted)resumeTable();});
window.addEventListener('pagehide',stopReplay);
window.addEventListener('blur',()=>state.replayPlayback?.endScrub({resume:false}));
bindNativeLifecycle({resume:resumeTable,back:()=>{if(dialog.open)closeModal();else if(state.chatOpen){state.chatOpen=false;render();}else if(state.page!=='lobby'&&state.page!=='welcome')navigate('');}});
async function boot(){
  requests.invalidate();const guard=requests.capture();state.page='loading';state.error='';render();
  try{
    const config=clientConfig();
    if(!config.native&&'serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
    const savedToken=state.token||await readIdentity();guard.check();state.token=savedToken;
    if(!state.token){state.page='welcome';render();return;}
    await loadMe();guard.check();await route();
  }catch(error){
    if(error.stale||!guard.valid())return;
    if(error.status===401){await clearIdentity(state.token).catch(()=>{});if(!guard.valid())return;state.token='';state.user=null;state.page='welcome';toast('登录已失效，请重新登录',true);}
    else{state.error=error.message;state.page='error';}
    render();
  }
}
boot();
