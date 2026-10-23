// Metadata only. Secret entry and approval remain inside the native app.
const escapeSecurity = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const finalStates = new Set(['completed','cancelled','expired','failed']);
const usageResults = {approved:'已批准', denied:'已拒绝', timeout:'超时', unavailable:'无法确认'};
const usageLine = (u, e) => {
  const refused = u.denied + u.timeout + u.unavailable;
  const last = u.lastAt ? ` · 最近 ${e(new Date(u.lastAt).toLocaleString('zh-CN', {hour12:false}))} ${e(u.lastInitiator)}（${e(usageResults[u.lastResult] || u.lastResult)}）` : '';
  return `已批准 ${e(u.approved)} 次${refused ? `，未批准 ${e(refused)} 次` : ''}${last}`;
};
const inactivityLine = (credential, catalog, e) => {
  if (credential.storage !== 'macos-keychain') return '';
  const history = catalog.recentUsage;
  const id = credential.id.replace(/^local:/, '').toLowerCase();
  const times = [credential.usage?.lastAt, history?.lastDecisionAt?.[id]].filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (times.length) {
    const elapsed = Date.now() - Math.max(...times);
    const days = Math.floor(elapsed / 86400000);
    return elapsed > 30 * 86400000 ? `<p>已闲置 ${e(days)} 天</p>` : '';
  }
  const incomplete = catalog.localStore?.usage === 'unavailable' || history?.status === 'unavailable' || history?.skippedLines > 0 || history?.truncated;
  return incomplete ? '<p>暂无可确认的最近使用时间</p>' : '<p>从未使用</p>';
};
const recentUsageView = (history, e) => {
  if (!history) return '';
  return `<section aria-label="最近使用"><h2>最近使用</h2><p>最近 20 次授权决定（包括未批准的请求）</p>
    ${history.status === 'unavailable' ? '<p>使用记录暂不可读取。</p>' : ''}
    ${history.skippedLines > 0 ? `<p role="alert">部分使用记录无法读取（${e(history.skippedLines)} 行）</p>` : ''}
    ${history.truncated ? '<p>仅显示记录文件末尾 1 MiB 内的最近决定。</p>' : ''}
    <ol>${(history.decisions || []).slice(0,20).map(d=>`<li${d.result === 'approved' ? '' : ' class="usage-refused"'}>
      <p><time>${e(new Date(d.time).toLocaleString('zh-CN', {hour12:false}))}</time> · <strong>${e(d.credentialName || d.credentialId)}</strong> · 发起方：${e(d.initiator || '未记录')} · <strong>${e(usageResults[d.result] || d.result)}</strong></p>
      <p>命令：<code>${e(d.command || '未记录')}</code></p><p>目录：${e(d.cwd || '未记录')}</p></li>`).join('')}</ol>
    ${history.status !== 'unavailable' && !history.decisions?.length ? '<p>暂无可显示的使用记录</p>' : ''}</section>`;
};
export function mountSecurity(root, { projectId, projectName, api, staticDemo = false, pollMs = 1000 }) {
  let alive = true, timer, operation, catalog, project, error = '', busy = false, polls = 0, generation = 0;
  const current = token => alive && token === generation;
  const scope = projectId === undefined ? {} : {projectId};
  const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  const e = escapeSecurity;
  function scanView(op) {
    const scan = op?.result?.scan;
    if (!scan) return '<p>本次启动后尚未扫描</p>';
    const labels = {high:'优先处理',review:'需要复核',low:'低优先级'};
    return `<p>扫描时间：${e(scan.scannedAt)} · 已检查 ${e(scan.checkedFiles)} 个文件 · ${scan.complete ? '扫描完成' : '扫描范围不完整'}</p>
      <p>优先处理 ${e(scan.summary.high)} · 需要复核 ${e(scan.summary.review)} · 低优先级 ${e(scan.summary.low)}</p>
      <ul>${scan.coverageNotes.map(note=>`<li>${e(note)}</li>`).join('')}</ul>
      <ul>${scan.findings.map(f=>`<li>${e(labels[f.priority])}：${e(f.path)}${f.line == null ? '' : `:${e(f.line)}${f.column == null ? '' : ':'+e(f.column)}`} · ${e(f.rules.join('、'))}</li>`).join('')}</ul>`;
  }
  function draw() {
    if (!alive) return;
    const available = catalog?.status === 'available';
    const nativeAvailable = catalog?.nativeAvailable === true;
    const scanAvailable = catalog?.scanAvailable === true;
    const localAvailable = catalog?.localStore?.status === 'available';
    const active = operation && !finalStates.has(operation.state);
    const states = {waiting_input:'请在本地凭证管家输入',waiting_approval:'请在本地凭证管家确认',running:'正在执行',completed:'已完成',cancelled:'已取消',expired:'请求已过期',failed:'操作未完成'};
    root.innerHTML = `<section class="crew-security"><h1>凭证与安全${projectId === undefined ? '' : ' · '+e(projectName || projectId)}</h1>
      <p class="banner">${localAvailable ? '本地凭证库：由 macOS 钥匙串保存，已集中整理；授权调用尚未接入。' : '本地凭证库尚未加载。'}原生录入与检测仍为隔离测试，请仅使用假 Key。</p>
      <p>网页不接收 Key。原生 App 录入目前仅用于假 Key 测试。已保存或可取用不代表 Key 有效或服务已连接。Codex / Claude 订阅登录保持原样。</p>
      ${staticDemo ? '<p>当前是只读演示，凭证与安全功能需要本机服务。</p>' : `<p>${catalog ? (available ? '本地凭证目录可用' : '本地凭证目录当前不可用。') : '正在读取本地凭证管家状态…'}</p>
      ${catalog?.message ? `<p>${e(catalog.message)}</p>` : ''}
      <button class="btn" data-security="refresh" ${busy?'disabled':''}>刷新状态</button>
      <button class="btn" data-security="input" ${!nativeAvailable || busy || active?'disabled':''}>添加火山方舟凭证</button>
      ${catalog && !nativeAvailable ? '<p>原生录入与检测不可用；需显式配置本地 helper。</p>' : ''}
      ${catalog?.localStore?.usage === 'unavailable' ? '<p>使用记录暂不可读取。</p>' : ''}
      <ul>${(catalog?.credentials || []).map(c=>`<li><strong>${e(c.name)}</strong>${c.storage === 'macos-keychain' ? `<p>${c.runnable ? '本地钥匙串 · 逐次授权取用（每次 Touch ID 或密码）' : '本地钥匙串 · 已保存，待接入授权使用'}</p>` : ''}<p>${e(c.usageInstructions)}</p><p>${c.environmentVariables.map(e).join('、')}</p>${c.usage ? `<p>${usageLine(c.usage, e)}</p>` : ''}${inactivityLine(c,catalog,e)}${c.canProbe && c.storage !== 'macos-keychain' ? `<button class="btn" data-security="probe" data-id="${e(c.id)}" ${!nativeAvailable || busy || active?'disabled':''}>检测授权取用</button>` : ''}</li>`).join('')}</ul>
      ${recentUsageView(catalog?.recentUsage,e)}
      <p>检测授权取用仅离线检测变量是否存在，不验证 Key，也不连接服务。</p>
      ${operation ? `<div role="status">${e(states[operation.state] || '状态未知')}${operation.progress ? ` · 已检查 ${e(operation.progress.checkedFiles)} 个文件，发现 ${e(operation.progress.findings)} 处` : ''}${active ? '<button class="btn" data-security="cancel">取消操作</button>' : ''}${operation.result?.credential ? '<p>凭证已保存。</p>' : ''}${typeof operation.result?.present === 'boolean' ? `<p>${operation.result.present ? '可在本次授权中取用' : '未检测到对应变量'}</p>` : ''}${operation.error ? `<p>${e(operation.error.message)}</p>` : ''}</div>` : ''}
      ${projectId !== undefined ? `<h2>项目只读扫描</h2>${catalog && !scanAvailable ? '<p>项目扫描不可用；需显式配置本地扫描器。</p>' : ''}<p>扫描范围仅限本项目绑定目录，不修改文件。</p>${project ? (project.directories.length ? `<select aria-label="扫描目录" data-security-directory>${project.directories.map(d=>`<option value="${e(d.id)}">${e(d.label)}</option>`).join('')}</select><button class="btn" data-security="scan" ${!scanAvailable || busy || active?'disabled':''}>扫描绑定目录</button><p>绑定范围：${project.directories.map(d=>e(d.label)).join('、')}</p>` : `<p>没有可扫描的绑定目录。<a href="#/settings">绑定项目目录</a></p>`) : ''}${scanView(project?.latestScan)}` : '<p>项目扫描请从项目的“凭证与安全”入口进入。</p>'}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}`}</section>`;
  }
  async function refresh(token = generation) {
    try {
      const result = await Promise.all([api('/api/security/credentials'), projectId === undefined ? Promise.resolve(undefined) : api(`/api/security/projects/${encodeURIComponent(projectId)}`)]);
      if (!current(token)) return;
      [catalog,project] = result; error = ''; draw();
    } catch (err) { if (current(token)) { error = err.message; draw(); } }
  }
  function schedule() {
    if (!alive || !operation || finalStates.has(operation.state)) return;
    if (++polls > 600) { error = '页面已停止自动刷新；可刷新状态查看。本地操作不会因此取消。'; draw(); return; }
    const token = generation, operationId = operation.id;
    timer = setTimeout(async () => {
      if (!current(token) || operation?.id !== operationId) return;
      try {
        const next = await api(`/api/security/operations/${encodeURIComponent(operationId)}${query}`);
        if (!current(token) || operation?.id !== operationId) return;
        operation = next; draw();
        if (finalStates.has(next.state)) await refresh(token); else schedule();
      } catch (err) { if (current(token) && operation?.id === operationId) { error=err.message;draw(); } }
    }, pollMs);
  }
  root.onclick = async event => {
    const button = event.target.closest('[data-security]');
    if (!button || button.disabled || staticDemo || busy) return;
    const action = button.dataset.security;
    const token = ++generation;
    clearTimeout(timer);
    if (action === 'refresh') { await refresh(token); if (current(token) && operation && !finalStates.has(operation.state)) {clearTimeout(timer);polls=0;schedule();} return; }
    const directoryId = action === 'scan' ? root.querySelector('[data-security-directory]')?.value : undefined;
    busy = true; error = ''; draw();
    try {
      let path, body;
      if ((action === 'input' || action === 'probe') && catalog?.nativeAvailable !== true) return;
      if (action === 'scan' && catalog?.scanAvailable !== true) return;
      if (action === 'probe' && button.dataset.id?.startsWith('local:')) return;
      if (action === 'input') { path='/api/security/inputs';body={provider:'ark',...scope}; }
      if (action === 'probe') { path='/api/security/probes';body={credentialId:button.dataset.id,...scope}; }
      if (action === 'scan') { path='/api/security/scans';body={projectId,directoryId}; }
      if (action === 'cancel' && operation) { path=`/api/security/operations/${encodeURIComponent(operation.id)}/cancel`;body=scope; }
      if (!path) return;
      const next=await api(path,{method:'POST',body});
      if (!current(token)) return;
      clearTimeout(timer);operation=next;polls=0;
      if (finalStates.has(next.state)) await refresh(token); else schedule();
    } catch (err) { if(current(token)) error=err.message; }
    finally { if(current(token)) {busy=false;draw();} }
  };
  draw(); if (!staticDemo) void refresh();
  return () => { alive=false;++generation;clearTimeout(timer);root.onclick=null; };
}
