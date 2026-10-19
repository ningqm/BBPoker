const CACHE='bbpoker-static-v46';
const FILES=['/','/startup.js','/index.html','/style.css','/app.js','/admin-accounts.js','/admin-accounts.css','/money.js','/money.css','/table-feedback.js','/check-knock.js','/turn-recovery.js','/turn-delivery.js','/room-clock.js','/room-snapshot.js','/action-performance.js','/table-controls.js','/pre-actions.js','/stable-controls.js','/visual-viewport.js','/table-controls.css','/table-scene.js','/table-scene.css','/hand-category.js',...['chips','bet','raise','reraise','call','check','fold','allin'].map(name=>'/audio/'+name+'.wav'),'/table-fun.js','/table-mode-events.js','/table-mode-effects.js','/table-mode-effects.css','/lifecycle.js','/lobby.css','/lobby-view.js','/table-fun.css','/table-interactions.css','/avatar.js','/replay.js','/room-config.js','/records.js','/room-results.js','/room-results.css','/room-ending.js','/room-ending.css','/starting-hands.js','/hand-position.js','/hand-records.css','/hand-overview.js','/hand-overview.css','/stats.js','/player-stats.js','/versus-stats.js','/history-refresh.js','/platform.js','/client-config.js','/icon.svg','/bbpoker-mark-v2.svg','/bbpoker-mark-v3.svg','/bbpoker-favicon-v3.svg','/bbpoker-favicon-v3.ico','/bbpoker-favicon-v3-32.png','/bbpoker-touch-v3.png','/bbpoker-app-v3-192.png','/bbpoker-app-v3-512.png','/manifest.webmanifest',...Array.from({length:6},(_,i)=>`/avatars/ai-${String(i+1).padStart(2,'0')}.png`)];
// Cache only resources actually requested. Installing must not download the
// whole application, sound library and avatars alongside a new user's login.
self.addEventListener('install',event=>{event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('tongzhuo-static-')||k.startsWith('bbpoker-static-'))&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// A stalled request (including a stalled response body) must not hold the
// page indefinitely. Only this release's public cache is eligible as fallback.
async function loadStatic(request) {
  const cache=await caches.open(CACHE),cached=await cache.match(request);
  // Content-addressed assets cannot become stale within this cache.
  if(cached&&/\/(app-entry\.[a-f0-9]{16}\.js|site\.[a-f0-9]{16}\.css)$/.test(new URL(request.url).pathname))return cached;
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    controller.abort();reject(new Error('Static resource timed out'));
  },cached?4000:15000);});
  try {
    const response=await Promise.race([fetch(request,{cache:'no-store',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('Static resource unavailable');
      // fetch() alone resolves at headers, not after downloading the resource.
      const body=await response.arrayBuffer();
      const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
      return new Response(body,{status:response.status,statusText:response.statusText,headers});
    }),deadline]);
    await cache.put(request,response.clone()).catch(()=>{});
    return response;
  } catch {
    return cached||new Response('Page resource unavailable. Please reload.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  } finally {clearTimeout(timer);}
}
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||(!FILES.includes(url.pathname)&&!/^\/(app-entry\.[a-f0-9]{16}\.js|site\.[a-f0-9]{16}\.css)$/.test(url.pathname)))return;event.respondWith(loadStatic(event.request));});
