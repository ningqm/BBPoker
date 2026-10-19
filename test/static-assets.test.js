import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createStaticAssets, acceptsGzip } from '../src/static-assets.js';
test('gzip negotiation respects explicit rejection and wildcard',()=>{
 for(const value of ['gzip','br, gzip;q=0.5','*'])assert.equal(acceptsGzip(value),true);
 for(const value of ['', 'br', 'gzip;q=0, *;q=1','gzip;q=garbage','gzip;q=2'])assert.equal(acceptsGzip(value),false);
});
test('static compression preserves bytes, supports conditional GET and concurrent downloads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bbpoker-static-'));
 try{
  const file=join(dir,'app-entry.0123456789abcdef.js'),text='console.log("hello");'.repeat(1000);await writeFile(file,text);
  const send=createStaticAssets();
  async function request(headers={},method='GET'){const result={};await send({headers,method},{writeHead:(status,h)=>Object.assign(result,{status,headers:h}),end:body=>result.body=body},file,'text/javascript');return result;}
  const rows=await Promise.all(Array.from({length:12},()=>request({'accept-encoding':'gzip'})));
  for(const r of rows){assert.equal(gunzipSync(r.body).toString(),text);assert.equal(r.headers['Content-Length'],r.body.length);assert.match(r.headers['Cache-Control'],/immutable/);}
  const plain=await request({'accept-encoding':'gzip;q=0'});assert.equal(plain.body.toString(),text);assert.equal(plain.headers['Content-Encoding'],undefined);
  const unchanged=await request({'accept-encoding':'gzip','if-none-match':rows[0].headers.ETag});assert.equal(unchanged.status,304);assert.equal(unchanged.body,undefined);
  assert.equal((await request({'if-none-match':rows[0].headers.ETag})).status,200);
  assert.equal((await request({'accept-encoding':'gzip'},'HEAD')).body,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
