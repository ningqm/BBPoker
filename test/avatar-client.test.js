import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarMarkup,defaultAvatarSrc,customAvatarId,cropRect,createAvatarCache,inspectAvatarFile} from '../public/avatar.js';

const id='a'.repeat(32);
const png=()=>new Response(new Blob(['PNG fixture'],{type:'image/png'}),{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store'}});
function cacheFixture(fetchImage){
  const identity={user:'alice',token:'alice-token'},created=[],revoked=[];
  const cache=createAvatarCache({getToken:()=>identity.token,getIdentity:()=>identity.user,url:path=>`https://table.invalid${path}`,fetchImage,createURL:blob=>{created.push(blob);return `blob:test-${created.length}`;},revokeURL:url=>revoked.push(url)});
  return {cache,identity,created,revoked};
}

test('legacy avatar indices map to default images; untrusted image IDs cannot produce URLs or HTML',()=>{
  assert.equal(defaultAvatarSrc({avatar:11}),'/avatars/ai-06.png');
  assert.equal(defaultAvatarSrc({avatar:-1}),'/avatars/ai-01.png');
  assert.equal(defaultAvatarSrc({avatar:'2'}),'/avatars/ai-01.png');
  assert.equal(customAvatarId({avatarImage:'../../key'}),null);
  const markup=avatarMarkup({avatar:0,avatarImage:'" onerror="alert(1)'});
  assert.ok(!markup.includes('data-custom-avatar'));
  assert.ok(!markup.includes('onerror'));
  assert.ok(avatarMarkup({avatar:5,avatarImage:id}).includes(`data-custom-avatar="${id}"`));
});

test('crop stays square and entirely inside portrait, landscape and zoomed source edges',()=>{
  assert.deepEqual(cropRect(1200,800),{size:800,x:200,y:0});
  assert.deepEqual(cropRect(800,1200),{size:800,x:0,y:200});
  assert.deepEqual(cropRect(1200,800,2,-100,5000),{size:400,x:0,y:400});
  for(const [w,h] of [[32,32],[4000,3000],[64,300],[12000,32]])for(const zoom of [0,1,1.01,2,4,100])for(const n of [-99999,0,100,99999]){
    const rect=cropRect(w,h,zoom,n,n);
    assert.ok(rect.size>0&&rect.size<=Math.min(w,h));
    assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.size<=w&&rect.y+rect.size<=h);
  }
});

test('custom avatar requests use current bearer, no-store, and deduplicate concurrent fetches',async()=>{
  const calls=[];let release;
  const fixture=cacheFixture((url,options)=>{calls.push({url,options});return new Promise(resolve=>{release=resolve;});});
  const first=fixture.cache.load(id),second=fixture.cache.load(id);
  assert.equal(calls.length,1);assert.equal(calls[0].url,`https://table.invalid/api/avatars/${id}`);
  assert.equal(calls[0].options.headers.Authorization,'Bearer alice-token');assert.equal(calls[0].options.cache,'no-store');
  release(png());assert.equal(await first,'blob:test-1');assert.equal(await second,'blob:test-1');assert.equal(await fixture.cache.load(id),'blob:test-1');
  assert.equal(calls.length,1);assert.equal(fixture.created.length,1);
  fixture.cache.clear();assert.deepEqual(fixture.revoked,['blob:test-1']);
});

test('logout aborts pending loads; a late response cannot create or expose an avatar URL',async()=>{
  let release,signal;const fixture=cacheFixture((url,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});});
  const pending=fixture.cache.load(id);fixture.identity.token='';fixture.identity.user='';fixture.cache.clear();
  assert.ok(signal.aborted);release(png());assert.equal(await pending,null);assert.equal(fixture.created.length,0);
  assert.equal(await fixture.cache.load(id),null);
});

test('identity switch revokes old images and requests with the new session; late old response is dropped',async()=>{
  const pending=[];const fixture=cacheFixture((url,options)=>new Promise(resolve=>pending.push({options,resolve})));
  const first=fixture.cache.load(id);pending[0].resolve(png());assert.equal(await first,'blob:test-1');
  const oldRequest=fixture.cache.load('b'.repeat(32));fixture.identity.user='bob';fixture.identity.token='bob-token';
  const newRequest=fixture.cache.load(id);assert.deepEqual(fixture.revoked,['blob:test-1']);assert.equal(pending[2].options.headers.Authorization,'Bearer bob-token');
  pending[1].resolve(png());assert.equal(await oldRequest,null);pending[2].resolve(png());assert.equal(await newRequest,'blob:test-2');assert.equal(fixture.created.length,2);fixture.cache.clear();
});

test('unauthorized or invalid image responses keep the fallback and do not create blob URLs',async()=>{
  for(const response of [new Response('no',{status:403}),new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}}),new Response('x',{headers:{'Content-Type':'image/png','Content-Length':'400000'}})]){
    const fixture=cacheFixture(async()=>response);assert.equal(await fixture.cache.load(id),null);assert.equal(fixture.created.length,0);fixture.cache.clear();
  }
  const fixture=cacheFixture(()=>{assert.fail('invalid IDs must not be requested');});assert.equal(await fixture.cache.load('../key'),null);
});

test('an in-flight avatar cannot write to a detached or repurposed image after a view change',async()=>{
  let release;const fixture=cacheFixture(()=>new Promise(resolve=>{release=resolve;}));
  const nodes=[{dataset:{customAvatar:id},isConnected:false,src:'default.png'},{dataset:{customAvatar:id},isConnected:true,src:'default.png'}];
  fixture.cache.hydrate({querySelectorAll:()=>nodes});nodes[1].dataset.customAvatar='b'.repeat(32);
  release(png());await fixture.cache.load(id);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes[0].src,'default.png');assert.equal(nodes[1].src,'default.png');fixture.cache.clear();
});

function chunk(type,payload){const bytes=Buffer.alloc(payload.length+12);bytes.writeUInt32BE(payload.length,0);bytes.write(type,4);payload.copy(bytes,8);return bytes;}
function pngHeader(width,height,animated=false){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(animated?[chunk('acTL',Buffer.alloc(8))]:[]),chunk('IEND',Buffer.alloc(0))]);}
function webpHeader(width,height,{lossless=false,animated=false,extended=false}={}){
  const payload=Buffer.alloc(lossless?6:10);
  if(lossless){payload[0]=47;const w=width-1,h=height-1;payload[1]=w&255;payload[2]=((w>>8)&63)|((h&3)<<6);payload[3]=(h>>2)&255;payload[4]=(h>>10)&15;}
  else{payload[3]=157;payload[4]=1;payload[5]=42;payload.writeUInt16LE(width,6);payload.writeUInt16LE(height,8);}
  const chunks=[];const webpChunk=(type,p)=>{const out=Buffer.alloc(8+p.length+(p.length%2));out.write(type,0);out.writeUInt32LE(p.length,4);p.copy(out,8);return out;};
  if(extended||animated){const x=Buffer.alloc(10);x[0]=animated?2:0;x.writeUIntLE(width-1,4,3);x.writeUIntLE(height-1,7,3);chunks.push(webpChunk('VP8X',x));}
  chunks.push(webpChunk(lossless?'VP8L':'VP8 ',payload));const result=Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP','binary'),...chunks]);result.writeUInt32LE(result.length-8,4);return result;
}
test('file header checks reject oversized PNG before decoding and validate JPEG/WebP dimensions',()=>{
  assert.deepEqual(inspectAvatarFile(pngHeader(1200,800)),{width:1200,height:800});
  assert.throws(()=>inspectAvatarFile(pngHeader(100000,100000)),/尺寸过大/);
  assert.throws(()=>inspectAvatarFile(pngHeader(31,31)),/太小/);
  assert.throws(()=>inspectAvatarFile(pngHeader(800,600).subarray(0,25)),/不完整/);
  const jpeg=Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,3,32,4,176,1,1,17,0]);
  assert.deepEqual(inspectAvatarFile(jpeg),{width:1200,height:800});
  for(const options of [{},{lossless:true},{extended:true}])assert.deepEqual(inspectAvatarFile(webpHeader(1200,800,options)),{width:1200,height:800});
  assert.throws(()=>inspectAvatarFile(webpHeader(12000,12000)),/尺寸过大/);
  assert.throws(()=>inspectAvatarFile(new Uint8Array([1,2,3])),/不完整/);
});
test('APNG and animated WebP are rejected before browser image decoding',()=>{
  assert.throws(()=>inspectAvatarFile(pngHeader(800,600,true)),/动态图片/);
  assert.throws(()=>inspectAvatarFile(webpHeader(800,600,{animated:true})),/动态图片/);
});
