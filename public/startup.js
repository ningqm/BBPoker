// Runs independently of the main module: a failed dependency must not leave
// a first-time visitor staring at an unexplained connecting screen forever.
(() => {
  const status=document.getElementById('boot-status');
  if(!status)return;
  const retry=document.getElementById('boot-retry');
  if(retry){retry.href=window.location.href;retry.addEventListener('click',event=>{event.preventDefault();window.location.reload();});}
  function explain(message){if(status.isConnected)status.textContent=message;}
  const timer=setTimeout(()=>explain('加载时间较长，请检查网络后点击“重新加载”。'),15000);
  const onError=event=>{if(event.target?.id==='app-entry')explain('页面加载未完成，请点击“重新加载”再试。');};
  window.addEventListener('error',onError,true);
  const observer=new MutationObserver(()=>{if(!status.isConnected){clearTimeout(timer);observer.disconnect();window.removeEventListener('error',onError,true);}});
  observer.observe(document.getElementById('app'),{childList:true});
})();
