import { readFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const compress=promisify(gzip);
export function acceptsGzip(value='') {
  const entries=String(value).toLowerCase().split(',').map(part=>{const [name,...params]=part.trim().split(';');const q=params.find(p=>p.trim().startsWith('q='));return [name,q?Number(q.trim().slice(2)):1];});
  const item=entries.find(([name])=>name==='gzip')||entries.find(([name])=>name==='*');
  return Boolean(item&&Number.isFinite(item[1])&&item[1]>0&&item[1]<=1);
}
export function createStaticAssets() {
  const cache=new Map();
  return async function sendStatic(req,res,file,mime) {
    let pending=cache.get(file);
    if(!pending){
      pending=readFile(file).then(async raw=>({raw,compressed:/^(text\/|application\/(json|manifest\+json))|^image\/svg\+xml/.test(mime)&&raw.length>=512?await compress(raw):null}));
      cache.set(file,pending);pending.catch(()=>cache.delete(file));
    }
    const asset=await pending,useGzip=asset.compressed&&acceptsGzip(req.headers['accept-encoding']),bytes=useGzip?asset.compressed:asset.raw;
    const etag='"'+createHash('sha256').update(bytes).digest('hex')+'"';
    const immutable=/(?:app-entry\.[a-f0-9]{16}\.js|site\.[a-f0-9]{16}\.css)$/.test(file);
    const headers={'Content-Type':mime,'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache','Vary':'Accept-Encoding','ETag':etag,...(useGzip?{'Content-Encoding':'gzip'}:{})};
    const matches=String(req.headers['if-none-match']||'').split(',').some(value=>value.trim().replace(/^W\//,'')===etag||value.trim()==='*');
    if(matches){res.writeHead(304,headers);return res.end();}
    res.writeHead(200,{...headers,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
  };
}
