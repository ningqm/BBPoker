// Custom images are fetched with the current session and kept only in memory.
const IMAGE_ID=/^[a-f0-9]{32}$/;
const MAX_FILE_BYTES=8*1024*1024;
export const avatarIndex=user=>Number.isInteger(user?.avatar)&&user.avatar>=0&&user.avatar<12?user.avatar:0;
export const defaultAvatarSrc=user=>`/avatars/ai-${String(avatarIndex(user)%6+1).padStart(2,'0')}.png`;
export const customAvatarId=user=>IMAGE_ID.test(user?.avatarImage||'')?user.avatarImage:null;
export function avatarMarkup(user,cls='tiny'){
  const id=customAvatarId(user);
  return `<span class="avatar ${cls}" aria-hidden="true"><img src="${defaultAvatarSrc(user)}" alt="" decoding="async" ${id?`data-custom-avatar="${id}"`:''}></span>`;
}
export function cropRect(width,height,zoom=1,x,y){
  const size=Math.min(width,height)/Math.max(1,Math.min(4,Number(zoom)||1));
  return {size,x:Math.max(0,Math.min(width-size,Number.isFinite(x)?x:(width-size)/2)),y:Math.max(0,Math.min(height-size,Number.isFinite(y)?y:(height-size)/2))};
}
// Reject oversized/animated files before asking the browser to allocate decoded pixels.
// The browser decoder and the server PNG normalizer still validate the actual image.
export function inspectAvatarFile(bytes){
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const bad=()=>{throw new Error('图片文件不完整或格式不支持，请换一张图片');};
  const dimensions=[];
  const record=(width,height)=>{if(!width||!height)bad();if(width>12000||height>12000||width*height>32000000)throw new Error('图片尺寸过大，请先缩小到 3200 万像素以内');if(width<32||height<32)throw new Error('图片太小，请选择至少 32 × 32 像素的图片');dimensions.push({width,height});};
  const ascii=(start,end)=>String.fromCharCode(...data.subarray(start,end));
  if(data.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>data[i]===v)){
    let offset=8,ended=false;
    while(offset+12<=data.length){const size=view.getUint32(offset),type=ascii(offset+4,offset+8),payload=offset+8;if(size>data.length-payload-4)bad();
      if(offset===8&&(type!=='IHDR'||size!==13))bad();
      if(type==='IHDR'){if(dimensions.length||size!==13)bad();record(view.getUint32(payload),view.getUint32(payload+4));}
      if(type==='acTL')throw new Error('暂不支持动态图片，请选择一张静态图片');
      offset+=size+12;if(type==='IEND'){if(size!==0||offset!==data.length)bad();ended=true;break;}
    }
    if(!ended||!dimensions.length)bad();return dimensions[0];
  }
  if(data.length>=4&&data[0]===255&&data[1]===216){
    let offset=2;
    while(offset<data.length){if(data[offset++]!==255)bad();while(data[offset]===255)offset++;if(offset>=data.length)bad();const marker=data[offset++];
      if(marker===217||marker===218)bad();if(marker===1||(marker>=208&&marker<=215))continue;
      if(offset+2>data.length)bad();const length=view.getUint16(offset);if(length<2||length>data.length-offset)bad();
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)bad();record(view.getUint16(offset+5),view.getUint16(offset+3));return dimensions[0];}
      offset+=length;
    }
    bad();
  }
  if(data.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'){
    if(view.getUint32(4,true)+8!==data.length)bad();let offset=12,hasPixels=false;
    const le24=at=>data[at]|data[at+1]<<8|data[at+2]<<16;
    while(offset+8<=data.length){const type=ascii(offset,offset+4),size=view.getUint32(offset+4,true),payload=offset+8;if(size>data.length-payload)bad();
      if(type==='ANIM'||type==='ANMF')throw new Error('暂不支持动态图片，请选择一张静态图片');
      if(type==='VP8X'){if(size!==10)bad();if(data[payload]&2)throw new Error('暂不支持动态图片，请选择一张静态图片');record(le24(payload+4)+1,le24(payload+7)+1);}
      if(type==='VP8 '){if(size<10||data[payload+3]!==157||data[payload+4]!==1||data[payload+5]!==42)bad();record(view.getUint16(payload+6,true)&16383,view.getUint16(payload+8,true)&16383);hasPixels=true;}
      if(type==='VP8L'){if(size<5||data[payload]!==47)bad();record(1+(data[payload+1]|(data[payload+2]&63)<<8),1+((data[payload+2]>>6)|data[payload+3]<<2|(data[payload+4]&15)<<10));hasPixels=true;}
      offset+=8+size+(size%2);
    }
    if(offset!==data.length||!hasPixels)bad();return dimensions[0];
  }
  bad();
}
export function createAvatarCache({getToken,getIdentity,url,fetchImage=globalThis.fetch,createURL=blob=>URL.createObjectURL(blob),revokeURL=value=>URL.revokeObjectURL(value)}){
  const entries=new Map();let generation=0,identity='',token='';
  function clear(){generation++;for(const entry of entries.values()){entry.controller?.abort();if(entry.url)revokeURL(entry.url);}entries.clear();identity='';token='';}
  function sync(){const nextIdentity=getIdentity()||'',nextToken=getToken()||'';if(identity!==nextIdentity||token!==nextToken){clear();identity=nextIdentity;token=nextToken;}}
  async function load(id){
    sync();if(!identity||!token||!IMAGE_ID.test(id))return null;
    const old=entries.get(id);if(old?.url)return old.url;if(old?.promise)return old.promise;if(old?.retryAt>Date.now())return null;
    const version=generation,requestToken=token,requestIdentity=identity,controller=new AbortController(),entry={controller};
    const current=()=>version===generation&&requestToken===getToken()&&requestIdentity===getIdentity();
    const timer=setTimeout(()=>controller.abort(),15000);
    entries.set(id,entry);
    entry.promise=(async()=>{try{
      const response=await fetchImage(url(`/api/avatars/${id}`),{headers:{Authorization:`Bearer ${requestToken}`},cache:'no-store',signal:controller.signal});
      if(!current()||!response.ok||response.headers.get('Content-Type')?.split(';')[0]!=='image/png')return null;
      const length=Number(response.headers.get('Content-Length'));if(length>300000)return null;
      const blob=await response.blob();if(!current()||blob.size>300000||blob.size===0)return null;
      entry.url=createURL(blob);return entry.url;
    }catch{return null;}finally{
      clearTimeout(timer);delete entry.controller;delete entry.promise;entry.retryAt=Date.now()+30000;
      // A small memory-only cache is enough for several simultaneous tables.
      if(current()&&entries.size>100)for(const [key,value] of entries){if(key===id||value.promise)continue;if(value.url)revokeURL(value.url);entries.delete(key);if(entries.size<=80)break;}
    }})();
    return entry.promise;
  }
  function hydrate(root=document){
    sync();const version=generation;
    for(const image of root.querySelectorAll('img[data-custom-avatar]')){
      const id=image.dataset.customAvatar;if(!IMAGE_ID.test(id))continue;
      const ready=entries.get(id)?.url;if(ready){if(image.getAttribute('src')!==ready)image.src=ready;continue;}
      load(id).then(src=>{if(src&&version===generation&&image.isConnected&&image.dataset.customAvatar===id)image.src=src;});
    }
  }
  return {hydrate,clear,load};
}

export function avatarEditorMarkup(user){return `<section class="profile-avatar-editor" aria-label="修改头像"><div class="avatar-preview" data-avatar-preview>${avatarMarkup(user,'profile-avatar')}</div><div class="avatar-editor-actions"><button type="button" class="outline small" data-avatar-upload>上传图片</button><button type="button" class="ghost small" data-avatar-random>换一个默认头像</button><input type="file" data-avatar-file accept="image/jpeg,image/png,image/webp" aria-label="选择头像图片" hidden></div><div class="avatar-crop-controls" data-avatar-crop-controls hidden><label class="field avatar-zoom-label">缩放<input type="range" data-avatar-zoom min="1" max="4" step="0.01" value="1" aria-label="头像缩放"></label><p class="note compact-note" id="avatar-crop-hint">拖动图片调整位置，也可聚焦图片后用方向键移动。</p></div><p class="note avatar-file-hint">JPG、PNG 或 WebP，最大 8 MB</p><p class="avatar-editor-error" data-avatar-error role="alert" hidden></p></section>`;}
export function createAvatarEditor(root,{user,hydrate=()=>{}}){
  const preview=root.querySelector('[data-avatar-preview]'),fileInput=root.querySelector('[data-avatar-file]'),upload=root.querySelector('[data-avatar-upload]'),random=root.querySelector('[data-avatar-random]'),zoomInput=root.querySelector('[data-avatar-zoom]'),controls=root.querySelector('[data-avatar-crop-controls]'),error=root.querySelector('[data-avatar-error]'),submit=root.querySelector('[type=submit]'),nickname=root.querySelector('input[name=name]');
  let selectedIndex=avatarIndex(user),dirty=false,source=null,sourceURL=null,pendingSourceURL=null,pendingImage=null,canvas=null,zoom=1,x=0,y=0,loading=false,saving=false,destroyed=false,revision=0,drag=null;
  const listeners=[];
  const on=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  function setError(message=''){if(destroyed)return;error.textContent=message;error.hidden=!message;}
  function busy(){if(destroyed)return;const disabled=loading||saving;for(const node of [fileInput,upload,random,zoomInput,submit])if(node)node.disabled=disabled;if(nickname)nickname.disabled=saving;preview.setAttribute('aria-busy',String(disabled));upload.textContent=loading?'正在处理…':'上传图片';}
  function releaseSource(){if(sourceURL)URL.revokeObjectURL(sourceURL);sourceURL=null;source=null;canvas=null;drag=null;}
  function draw(){if(!canvas||!source||destroyed)return;const rect=cropRect(source.naturalWidth,source.naturalHeight,zoom,x,y);x=rect.x;y=rect.y;const ctx=canvas.getContext('2d');ctx.fillStyle='#f0f5f0';ctx.fillRect(0,0,256,256);ctx.drawImage(source,rect.x,rect.y,rect.size,rect.size,0,0,256,256);}
  function showCrop(){
    preview.replaceChildren();canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','头像裁剪预览');canvas.setAttribute('aria-describedby','avatar-crop-hint');preview.append(canvas);controls.hidden=false;zoomInput.value='1';draw();
    canvas.addEventListener('pointerdown',event=>{if(loading||saving||event.button!==0)return;event.preventDefault();const rect=cropRect(source.naturalWidth,source.naturalHeight,zoom,x,y);drag={pointer:event.pointerId,clientX:event.clientX,clientY:event.clientY,x,y,ratio:rect.size/canvas.getBoundingClientRect().width};canvas.setPointerCapture(event.pointerId);canvas.focus({preventScroll:true});});
    canvas.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.pointer||loading||saving)return;x=drag.x-(event.clientX-drag.clientX)*drag.ratio;y=drag.y-(event.clientY-drag.clientY)*drag.ratio;draw();});
    const end=()=>{drag=null;};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',end);
    canvas.addEventListener('keydown',event=>{if(loading||saving||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const step=Math.min(source.naturalWidth,source.naturalHeight)/zoom/(event.shiftKey?10:50);if(event.key==='ArrowLeft')x-=step;if(event.key==='ArrowRight')x+=step;if(event.key==='ArrowUp')y-=step;if(event.key==='ArrowDown')y+=step;draw();});
  }
  async function chooseFile(file){
    if(!file||loading||saving||destroyed)return;
    setError();if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setError('请选择 JPG、PNG 或 WebP 图片');return;}if(!file.size||file.size>MAX_FILE_BYTES){setError('图片不能超过 8 MB，请选一张小一些的图片');return;}
    loading=true;busy();const current=++revision;let tempURL=null,accepted=false;
    try{
      inspectAvatarFile(await file.arrayBuffer());if(destroyed||current!==revision)return;tempURL=URL.createObjectURL(file);
      const image=new Image();pendingSourceURL=tempURL;pendingImage=image;image.decoding='async';image.src=tempURL;await image.decode();
      if(destroyed||current!==revision)return;
      const width=image.naturalWidth,height=image.naturalHeight;
      if(width<32||height<32)throw new Error('图片太小，请选择至少 32 × 32 像素的图片');
      if(width>12000||height>12000||width*height>32000000)throw new Error('图片尺寸过大，请先缩小到 3200 万像素以内');
      releaseSource();source=image;sourceURL=tempURL;accepted=true;zoom=1;const rect=cropRect(width,height);x=rect.x;y=rect.y;dirty=true;showCrop();
    }catch(reason){if(!destroyed&&current===revision)setError(reason?.name==='EncodingError'?'这张图片无法读取，请换一张图片':reason.message||'图片处理失败，请重试');}
    finally{if(tempURL&&pendingSourceURL===tempURL){if(!accepted)URL.revokeObjectURL(tempURL);pendingSourceURL=null;pendingImage=null;}if(!destroyed&&current===revision){loading=false;busy();}}
  }
  on(upload,'click',()=>fileInput.click());
  on(fileInput,'change',()=>{const file=fileInput.files?.[0];fileInput.value='';chooseFile(file);});
  on(random,'click',()=>{if(loading||saving||destroyed)return;revision++;releaseSource();setError();const bits=new Uint32Array(1);crypto.getRandomValues(bits);selectedIndex=(selectedIndex%6+1+bits[0]%5)%6;dirty=true;controls.hidden=true;preview.innerHTML=avatarMarkup({avatar:selectedIndex},'profile-avatar');});
  on(zoomInput,'input',()=>{if(!source||loading||saving)return;const old=cropRect(source.naturalWidth,source.naturalHeight,zoom,x,y);zoom=Number(zoomInput.value);const next=cropRect(source.naturalWidth,source.naturalHeight,zoom);x=old.x+old.size/2-next.size/2;y=old.y+old.size/2-next.size/2;draw();});
  hydrate(root);
  return {
    patch(){if(loading)throw new Error('图片正在处理，请稍等');if(!dirty)return {};if(source&&canvas)return {avatarUpload:canvas.toDataURL('image/png')};return {avatar:selectedIndex};},
    setSaving(value){saving=value;busy();},setError,
    destroy(){destroyed=true;revision++;for(const remove of listeners)remove();if(pendingImage)pendingImage.src='';if(pendingSourceURL)URL.revokeObjectURL(pendingSourceURL);pendingImage=null;pendingSourceURL=null;releaseSource();fileInput.value='';}
  };
}
