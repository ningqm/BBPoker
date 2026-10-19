const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const button = (label, action, cls = 'outline', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const accountLabel = account => account.username || account.name || '旧昵称身份';

export function renderAccountRows(accounts, meId, query = '') {
  const needle = query.trim().toLocaleLowerCase();
  const rows = accounts.filter(account => `${account.username || ''} ${account.name || ''}`.toLocaleLowerCase().includes(needle));
  return rows.map(account => {
    const own = account.id === meId, id = escape(account.id);
    return `<article class="managed-account"><div class="managed-account-heading"><div class="managed-account-name"><strong>${escape(account.name || account.username)}</strong><span>${account.username ? `账号 ${escape(account.username)}` : '旧昵称身份'}${own ? ' · 你' : ''}</span></div><span class="managed-account-status ${account.disabled ? 'is-disabled' : ''}">${account.disabled ? '已停用' : account.isAdmin ? '管理员' : '可登录'}</span></div>${!own ? `<div class="managed-account-actions">${button(account.username ? '重置密码' : '分配登录账号','admin-account-reset','outline small',`data-account="${id}"`)}${button(account.disabled ? '启用账号' : '停用账号','admin-account-status',account.disabled ? 'outline small' : 'ghost small',`data-account="${id}"`)}</div>` : '<small class="managed-account-own">修改自己的密码请在「我的账号」中操作</small>'}</article>`;
  }).join('') || '<p class="note account-empty">没有匹配的账号</p>';
}

// Only keep generated credentials in this controller while its result dialog is
// visible. API authorization is still mandatory; this is presentation gating.
export function createAccountManager({api, getUser, getModal, openModal, copy, notice = () => {}, updateMutation = () => {}, makeRequestId = () => crypto.randomUUID(), now = () => Date.now()}) {
  let accounts = [], credentials = null, revision = 0, pending = false, query = '';
  // Retry metadata contains no password and is never persisted to browser storage.
  // Keep it across dialog changes so a lost response can be recovered safely.
  let operationOwner = null;const operations = new Map();
  const authorized = () => getUser()?.isAdmin === true;
  const requireAdmin = () => {if (!authorized()) throw new Error('只有管理员可以管理账号');};
  const changed = kind => {revision++; credentials = null; pending = false; if (!String(kind || '').startsWith('admin-account')) {accounts = []; query = '';}};
  const reset = () => {changed();};
  const show = (title, body, kind = 'admin-accounts') => openModal(title, body, kind);
  const capture = () => ({revision, userId: getUser()?.id, modal: getModal()});
  const current = token => revision === token.revision && getUser()?.id === token.userId && authorized() && getModal() === token.modal;
  const byId = id => accounts.find(account => account.id === id);
  const listBody = () => `<div class="account-manager-head"><p class="note">账号由管理员分配。停用会退出登录，牌谱和积分记录保留。</p>${button('分配新账号','admin-account-create','primary')}</div><label class="field account-search">查找账号<input type="search" data-admin-account-search placeholder="账号或昵称" value="${escape(query)}" autocomplete="off"></label><div class="managed-accounts" data-managed-accounts>${renderAccountRows(accounts,getUser().id,query)}</div>`;
  async function open() {
    requireAdmin();query = '';
    show('账号管理','<p class="note" role="status">正在读取账号…</p>');
    const token = capture();
    try {const result = await api('/api/admin/accounts');if (!current(token)) return;accounts = result.accounts || [];show('账号管理',listBody());}
    catch (error) {if (!current(token) || error.stale) return;show('账号管理',`<p class="note" role="alert">${escape(error.message)}</p>${button('重新读取','admin-accounts','primary')}`);}
  }
  function create() {
    requireAdmin();
    // Reopening this form is an explicit new attempt; username uniqueness still protects existing accounts.
    for (const [key,value] of operations) if (JSON.parse(key)[0] === '/api/admin/accounts' && (value.terminal || now() - value.createdAt >= 15 * 60 * 1000)) operations.delete(key);
    show('分配新账号',`<form id="admin-account-create-form" class="admin-account-panel"><div class="admin-account-fields"><label class="field">账号<input name="username" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" placeholder="3–24 位字母、数字或下划线" required></label><label class="field">昵称（选填）<input name="name" autocomplete="off" maxlength="18" placeholder="朋友怎么称呼"></label><p class="note">初始密码自动生成，创建后请保存并私下交给朋友。</p></div><div class="admin-account-footer">${button('返回','admin-accounts','ghost')}<button type="submit" class="primary">创建账号</button></div></form>`,'admin-account-create');
  }
  function confirm(id, mode) {
    requireAdmin();const account = byId(id);if (!account || account.id === getUser().id) return;
    // A fresh confirmation is an explicit new reset after an expired/changed receipt.
    if (mode === 'reset') for (const [key,value] of operations) {
      if (JSON.parse(key)[0] === `/api/admin/accounts/${encodeURIComponent(id)}/reset-password` && (value.terminal || now() - value.createdAt >= 15 * 60 * 1000)) operations.delete(key);
    }
    const resetPassword = mode === 'reset', label = resetPassword ? '重置密码' : account.disabled ? '启用账号' : '停用账号';
    if (resetPassword && !account.username) {
      show('分配登录账号',`<form id="admin-account-legacy-form" class="admin-account-panel"><div class="admin-account-fields"><input type="hidden" name="accountId" value="${escape(id)}"><p>原昵称：<strong>${escape(account.name)}</strong></p><p class="note">为这个已有身份设置登录账号，原有牌谱和积分继续保留。旧身份恢复码将失效。</p><label class="field">登录账号<input name="username" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required></label></div><div class="admin-account-footer">${button('返回','admin-accounts','ghost')}<button type="submit" class="primary">生成账号密码</button></div></form>`,'admin-account-legacy');return;
    }
    show(label,`<div class="admin-account-panel"><div class="admin-account-fields"><p>账号：<strong>${escape(accountLabel(account))}</strong></p><p class="note">${resetPassword ? '旧密码和旧找回码将失效，已登录设备会退出。生成的新密码仅显示一次。' : account.disabled ? '恢复此账号登录，原有牌谱和积分记录保持不变。' : '此账号将退出登录，无法继续进入牌桌。牌谱和积分记录保留。'}</p></div><div class="admin-account-footer">${button('返回','admin-accounts','ghost')}${button(label,resetPassword ? 'admin-account-reset-confirm' : 'admin-account-status-confirm',resetPassword || account.disabled ? 'primary' : 'danger',`data-account="${escape(id)}" data-disabled="${!account.disabled}"`)}</div></div>`,'admin-account-confirm');
  }
  function presentCredentials(result) {
    const value = result.credentials;
    if (!value?.username || !value.password) throw new Error('未取得账号密码');
    show('账号密码已生成',`<div class="admin-account-panel"><div class="admin-account-fields">${result.account?.disabled ? '<p class="note">此账号仍处于停用状态，需在账号列表启用后才能登录。</p>' : ''}<p class="note">请保存后私下交给这位朋友，关闭后不能再查看密码。</p><dl class="assigned-credentials"><dt>账号</dt><dd>${escape(value.username)}</dd><dt>初始密码</dt><dd>${escape(value.password)}</dd></dl><div class="credential-copy-actions">${button('复制账号','admin-account-copy-username','outline')}${button('复制密码','admin-account-copy-password','primary')}</div><p class="note">朋友登录后可在「我的账号」中修改密码。管理员不能查看修改后的密码。</p></div><div class="admin-account-footer">${button('已保存，返回账号列表','admin-accounts','outline wide')}</div></div>`,'admin-account-credentials');
    credentials = {username:value.username,password:value.password};
  }
  async function mutate(path, body, receiveCredentials = false) {
    requireAdmin();if (pending) return;
    const userId = getUser().id;
    if (operationOwner !== userId) {operations.clear();operationOwner = userId;}
    const signature = JSON.stringify([path,body]);
    if (receiveCredentials && !operations.has(signature)) {
      if (operations.size >= 100) throw new Error('未确认的操作过多，请先确认已有账号的创建结果');
      operations.set(signature,{requestId:makeRequestId(),createdAt:now()});
    }
    const operation = receiveCredentials ? operations.get(signature) : null;
    if (operation && (operation.terminal || now() - operation.createdAt >= 15 * 60 * 1000)) {
      operation.terminal ||= '密码取回时间已过，请返回账号列表核对，再明确选择重置密码';
      updateMutation({pending:false,retry:false});throw new Error(operation.terminal);
    }
    pending = true;const token = capture();
    updateMutation({pending:true,retry:false});
    try {
      const result = await api(path,operation ? {...body,requestId:operation.requestId} : body);
      if (receiveCredentials && (!result.credentials?.username || !result.credentials?.password)) throw new Error('未取得账号密码');
      if (!current(token)) return;
      if (receiveCredentials) {operations.delete(signature);presentCredentials(result);}
      else {notice(result.account?.disabled ? '账号已停用，记录保留' : '账号已启用');await open();}
    } catch(error) {
      if (!current(token) || error.stale) return;
      if (operation && /^ACCOUNT_OPERATION_(EXPIRED|CHANGED|UNAVAILABLE|MISMATCH)$/.test(error.code || '')) operation.terminal = error.message;
      const uncertain = receiveCredentials && (!error.status || error.status >= 500);
      updateMutation({pending:false,retry:uncertain});
      if (uncertain) throw Object.assign(new Error('结果尚未确认，请保持填写内容不变，再点“重试并取回密码”。同一次操作不会重复创建账号或更换密码。'),{uncertain:true});
      // A rejected retry (including rate limiting) cannot disprove an earlier commit.
      // Keep its ID until success or a deliberately reopened terminal operation.
      throw error;
    } finally {if (current(token)) pending = false;}
  }
  return {
    open, create, changed, reset,
    filter(value, host) {if (!authorized() || getModal()?.kind !== 'admin-accounts') return;query = String(value || '');if (host) host.innerHTML = renderAccountRows(accounts,getUser().id,query);},
    submit(formData) {if (getModal()?.kind !== 'admin-account-create') return;const name=String(formData.get('name') || '').trim();return mutate('/api/admin/accounts',{username:String(formData.get('username') || '').trim(),...(name?{name}:{})},true);},
    submitLegacy(formData) {requireAdmin();if(getModal()?.kind !== 'admin-account-legacy')return;const account=byId(String(formData.get('accountId') || ''));if(!account||account.username||account.id===getUser().id)return;return mutate(`/api/admin/accounts/${encodeURIComponent(account.id)}/reset-password`,{username:String(formData.get('username') || '').trim()},true);},
    async handle(action, dataset = {}) {
      requireAdmin();
      if (action === 'admin-accounts') return open();
      if (action === 'admin-account-create') return create();
      if (action === 'admin-account-reset') return confirm(dataset.account,'reset');
      if (action === 'admin-account-status') return confirm(dataset.account,'status');
      if (action === 'admin-account-copy-username' || action === 'admin-account-copy-password') {if (credentials && getModal()?.kind === 'admin-account-credentials') {const token=capture(),value=credentials;await copy(action==='admin-account-copy-username'?value.username:value.password,action==='admin-account-copy-username'?'账号已复制':'密码已复制，请私下交给本人',{isCurrent:()=>current(token)&&credentials===value&&getModal()?.kind==='admin-account-credentials'});}return;}
      if (getModal()?.kind !== 'admin-account-confirm') return;
      const account = byId(dataset.account);if (!account || account.id === getUser().id) return;
      const base = `/api/admin/accounts/${encodeURIComponent(account.id)}`;
      if (action === 'admin-account-reset-confirm') return mutate(`${base}/reset-password`,{},true);
      if (action === 'admin-account-status-confirm') return mutate(`${base}/status`,{disabled:dataset.disabled === 'true'});
    },
  };
}
