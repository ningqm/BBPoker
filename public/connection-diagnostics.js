// Only fixed diagnostic metadata leaves the browser. Gameplay state, user IDs,
// credentials, raw exceptions and URLs are deliberately not accepted here.
export const CONNECTION_TYPES = new Set(['connect_start','stream_open','stream_snapshot','stream_first_fresh','stream_close','reconnect_scheduled','stream_stop','watchdog','probe_start','probe_result','probe_reconnect','foreground_start','foreground_result','resync_end','lifecycle']);
export const CONNECTION_REASONS = new Set(['initial','route','identity_change','network_offline','network_online','visible','hidden','pageshow','pagehide','native_resume','command_conflict','command_uncertain','watchdog_timeout','stream_eof','http_error','network_error','client_apply_error','decode_error','buffer_limit','missing_body','session_expired','retry','abort','superseded','idle','ready','deadline','presentation','timer_resume','ok','unchanged','stale_snapshot','wrong_snapshot','timeout','probe_failures','stalled_refresh_failed','foreground_timeout','foreground_failed','foreground_stale','connected']);
const ID = /^[a-f0-9-]{16,64}$/i;
const numericFields = ['attempt','durationMs','lastByteAgeMs','lastFreshAgeMs','snapshotAgeMs','revision','status','failures','delayMs','timerLagMs'];
const booleanFields = ['visible','online','connected','resync','persisted'];
function randomId() {
  try { return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), v => v.toString(16).padStart(2,'0')).join(''); }
  catch { return Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join(''); }
}
export function createConnectionDiagnostics({getIdentity,getContext=()=>({}),url=path=>path,fetcher=(...args)=>fetch(...args),clock=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout,makeId=randomId}={}) {
  let pageId=makeId(),identity=null,queue=[],sequence=0,generation=0,timer=null,pending=null,failures=0,gateStarted=null,gateRoom=null,idleSample=null;
  const safe = (fn,fallback) => { try { return fn(); } catch { return fallback; } };
  function reset() {
    generation++;clearTimer(timer);timer=null;pending?.abort();pending=null;
    queue=[];sequence=0;identity=null;failures=0;gateStarted=null;gateRoom=null;idleSample=null;pageId=safe(makeId,randomId());
  }
  function identify() {
    const current=safe(getIdentity,null);
    if(!current?.key||!current.token){if(identity)reset();return null;}
    if(identity?.key!==current.key||identity?.token!==current.token){reset();identity={key:current.key,token:current.token};}
    return identity;
  }
  function schedule(delay=10000) {
    try { if(timer!==null||pending||!queue.length||!identity)return;
    timer=setTimer(()=>{timer=null;void flush();},delay);timer?.unref?.(); } catch { timer=null; }
  }
  function record(type,detail={}) {
    return safe(()=>{
      if(!identify()||!CONNECTION_TYPES.has(type)||!CONNECTION_REASONS.has(detail.reason))return false;
      const values={...safe(getContext,{}),...detail};
      if(values.phase==='idle'){
        const key=`${values.room}:${values.streamId}`;
        if(type==='probe_start'){
          const sample=idleSample?.key!==key||clock()-idleSample.at>=30000;
          idleSample={key,at:sample?clock():idleSample.at,report:sample};if(!sample)return false;
        }
        if(type==='probe_result'&&['ok','unchanged'].includes(detail.reason)&&idleSample?.key===key&&!idleSample.report)return false;
      }
      const event={seq:++sequence,at:Math.max(0,Math.trunc(clock())),type,reason:detail.reason};
      if(/^\d{6}$/.test(values.room||''))event.room=values.room;
      if(ID.test(values.streamId||''))event.streamId=values.streamId;
      for(const key of numericFields)if(Number.isFinite(values[key])&&values[key]>=0)event[key]=Math.min(Number.MAX_SAFE_INTEGER,Math.round(values[key]));
      for(const key of booleanFields)if(typeof values[key]==='boolean')event[key]=values[key];
      if(['idle','full'].includes(values.phase))event.phase=values.phase;
      if(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,24})?$/i.test(values.version||''))event.version=values.version;
      queue.push(event);if(queue.length>120)queue.splice(0,queue.length-120);schedule();return true;
    },false);
  }
  async function flush() {
    let deadline,controller,capturedGeneration;
    try {
      if(!identify()||pending||!queue.length)return false;
      clearTimer(timer);timer=null;
      const batch=queue.slice(0,20),capturedPage=pageId,token=identity.token;capturedGeneration=generation;
      controller=new AbortController();pending=controller;
      const body=JSON.stringify({v:1,pageId:capturedPage,events:batch});
      if(body.length>16000){queue.splice(0,batch.length);pending=null;schedule();return false;}
      const timeout=new Promise((_,reject)=>{deadline=setTimer(()=>{controller.abort();reject(new Error('diagnostic timeout'));},4000);});
      // Isolated transport: no api(), no session-expiry handlers and no diagnostics
      // about diagnostics. Losing this upload cannot disable table controls.
      const response=await Promise.race([timeout,fetcher(url('/api/diagnostics/connection'),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,signal:controller.signal,cache:'no-store'})]);
      if(capturedGeneration!==generation||!identify()||capturedGeneration!==generation)return false;
      if(!response.ok)throw new Error('diagnostic upload failed');
      queue=queue.filter(event=>event.seq>batch.at(-1).seq);failures=0;return true;
    } catch { if(capturedGeneration===generation&&pending===controller)failures=Math.min(6,failures+1);return false; }
    finally { safe(()=>clearTimer(deadline));if(controller&&pending===controller){pending=null;schedule(Math.min(60000,10000*2**failures));} }
  }
  function query(streamId,separator='?') {
    return safe(()=>identify()?`${separator}pageId=${pageId}${ID.test(streamId||'')?`&streamId=${streamId}`:''}`:'','');
  }
  function gate(blocked) {
    safe(()=>{
      if(!identify())return;
      const context=safe(getContext,{});if(context.room!==gateRoom){gateRoom=context.room;gateStarted=null;}if(!context.room){gateStarted=null;return;}
      if(blocked&&gateStarted===null)gateStarted=clock();
      if(!blocked&&gateStarted!==null){record('resync_end',{reason:'connected',durationMs:Math.max(0,clock()-gateStarted)});gateStarted=null;}
    });
  }
  return {record,flush,reset:()=>safe(reset),gate,query,newStreamId:()=>safe(makeId,randomId()),
    snapshot:()=>safe(()=>({pageId,queued:queue.map(event=>({...event})),pending:Boolean(pending)}),{queued:[]})};
}
