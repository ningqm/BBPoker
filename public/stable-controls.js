// Only used for the small table header / seat regions. Keep a pressed control
// and its ancestor chain attached while a chat or clock snapshot is rendered.
// Different players, seats and revealed hands are different controls.
const identityAttributes=['id','data-action','data-player-id','data-player','data-seat','data-hand','data-index','data-room','data-unit','data-custom-avatar'];

function sameIdentity(current,fresh) {
  if(current.nodeType!==fresh.nodeType)return false;
  if(current.nodeType!==1)return true;
  if(current.tagName!==fresh.tagName)return false;
  if(identityAttributes.some(name=>current.getAttribute(name)!==fresh.getAttribute(name)))return false;
  // Structural classes identify anonymous wrappers; later classes are live
  // states such as acting, folded, collecting, selected or disabled.
  return (current.getAttribute('class')||'').trim().split(/\s+/)[0]===(fresh.getAttribute('class')||'').trim().split(/\s+/)[0];
}

function preserveAvatarSources(current,fresh) {
  const sources=new Map([...current.querySelectorAll('img[data-custom-avatar]')]
    .map(image=>[image.getAttribute('data-custom-avatar'),image.getAttribute('src')]));
  for(const image of fresh.querySelectorAll('img[data-custom-avatar]')) {
    const id=image.getAttribute('data-custom-avatar'),src=sources.get(id);
    if(/^[a-f0-9]{32}$/.test(id||'')&&typeof src==='string'&&src.startsWith('blob:'))image.setAttribute('src',src);
  }
}

function hasControl(node) {
  return node.nodeType===1&&(node.hasAttribute('data-action')||Boolean(node.querySelector('[data-action]')));
}

function syncAttributes(current,fresh) {
  for(const attribute of [...current.attributes])if(!fresh.hasAttribute(attribute.name))current.removeAttribute(attribute.name);
  for(const attribute of fresh.attributes)if(current.getAttribute(attribute.name)!==attribute.value)current.setAttribute(attribute.name,attribute.value);
}

function patchBranch(current,fresh,forceRoot=false,insideControl=false) {
  if(!sameIdentity(current,fresh)){current.replaceWith(fresh);return;}
  if(current.nodeType!==1){if(current.nodeValue!==fresh.nodeValue)current.nodeValue=fresh.nodeValue;return;}
  if(current.outerHTML===fresh.outerHTML)return;
  const preserveDescendants=insideControl||current.hasAttribute('data-action')||fresh.hasAttribute('data-action');
  if(!forceRoot&&!preserveDescendants&&!hasControl(current)&&!hasControl(fresh)){current.replaceWith(fresh);return;}
  syncAttributes(current,fresh);
  const oldChildren=[...current.childNodes],newChildren=[...fresh.childNodes];
  for(let i=0;i<Math.max(oldChildren.length,newChildren.length);i++) {
    if(!newChildren[i])oldChildren[i].remove();
    else if(!oldChildren[i])current.append(newChildren[i]);
    else patchBranch(oldChildren[i],newChildren[i],false,preserveDescendants);
  }
}

export function patchStableControls(current,fresh) {
  if(current?.nodeType!==1||fresh?.nodeType!==1||!sameIdentity(current,fresh))return false;
  preserveAvatarSources(current,fresh);
  patchBranch(current,fresh,true);
  return true;
}
