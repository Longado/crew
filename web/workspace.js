const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const providerName = provider => provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : String(provider || 'Terminal');
const ended = session => ['exited', 'stopped', 'error', 'failed'].includes(session.state || session.status);

const LAYOUTS = ['single', 'split', 'grid'];
const ids = value => Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
/** 每种布局各记一份显示的会话；旧存档只有 selected，归给它当时的布局。 */
export function restorePicks(saved) {
  const stored = saved.picks && typeof saved.picks === 'object' ? saved.picks : {};
  const picks = Object.fromEntries(LAYOUTS.map(name => [name, ids(stored[name])]));
  if (!saved.picks && LAYOUTS.includes(saved.layout)) picks[saved.layout] = ids(saved.selected);
  return picks;
}
export const withPicks = (picks, layout, selected) => ({ ...picks, [layout]: [...selected] });

/** Dispose only browser resources: PTY sessions stay alive on project navigation. */
export function mountWorkspace(root, { projectId, projectName, dirs = [], api, toast = () => {} }) {
  const preferenceKey = `crew:workspace:${projectId}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {}; } catch {}
  let disposed = false, starting = false, layout = ['single', 'split', 'grid'].includes(saved.layout) ? saved.layout : 'single';
  let picks = restorePicks(saved), selected = picks[layout], loaded = false;
  const names = new Map(Object.entries(saved.names && typeof saved.names === 'object' ? saved.names : {}).filter(([id, name]) => typeof name === 'string'));
  const capacity = () => ({ single: 1, split: 2, grid: 4 })[layout];
  function savePreferences() {
    if (!loaded) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify({ layout, picks: withPicks(picks, layout, selected), directory: directory.value, names: Object.fromEntries(names) })); }
    catch { toast('当前浏览器无法保存布局，本次仍可正常使用'); }
  }
  const sessions = new Map(), attempts = new Map();
  const base = '/api/terminals';
  const query = `projectId=${encodeURIComponent(projectId)}`;
  root.innerHTML = `
    <section class="crew-workspace" aria-label="项目终端工作台">
      <header class="crew-heading"><div><div class="crew-eyebrow">WORKSPACE</div><h1></h1></div><span class="crew-local"><i></i> 本机终端</span></header>
      <div class="crew-toolbar">
        <label class="crew-directory">工作目录<select aria-label="新会话工作目录"></select></label>
        <div class="crew-launch"><button class="btn pri" type="button" data-provider="codex">＋ 启动 Codex</button><button class="btn" type="button" data-provider="claude">＋ 启动 Claude</button></div>
      </div>
      <div class="crew-alert" role="alert" hidden></div>
      <div class="crew-session-bar"><div><span class="crew-section-label">SESSIONS</span><span class="crew-count">正在读取…</span></div><div class="crew-view" role="group" aria-label="终端布局"><button type="button" data-layout="single" aria-pressed="true">单窗</button><button type="button" data-layout="split" aria-pressed="false">双栏</button><button type="button" data-layout="grid" aria-pressed="false">四宫格</button><button type="button" class="crew-refresh" title="刷新会话列表" aria-label="刷新会话列表">↻</button></div></div>
      <label class="crew-session-search"><input type="search" aria-label="搜索会话" placeholder="搜索会话名称、Agent 或目录" maxlength="100"></label>
      <div class="crew-session-tabs" role="group" aria-label="选择会话"></div>
      <div class="crew-terminals"></div>
      <div class="crew-empty"><span class="crew-empty-mark" aria-hidden="true">›_</span><h2>你的项目，从这里继续</h2><p>选择工作目录，启动一个终端会话。<br>授权确认、输入和输出都会直接显示在这里。</p></div>
      <footer class="crew-footer"><span>会话在本地服务运行期间保留，切换项目或刷新页面不会停止进程。</span><span>原生 CLI · 原生授权</span></footer>
    </section>`;
  const $ = selector => root.querySelector(selector);
  $('h1').textContent = projectName || projectId;
  const directory = $('.crew-directory select');
  for (const value of dirs) {
    const path = typeof value === 'string' ? value : value.path;
    if (!path) continue;
    const option = node('option', '', path); option.value = path; directory.append(option);
  }
  if ([...directory.options].some(option => option.value === saved.directory)) directory.value = saved.directory;
  directory.onchange = savePreferences;
  if (!directory.options.length) {
    directory.append(node('option', '', '请先绑定项目目录'));
    directory.disabled = true;
    $('.crew-empty h2').textContent = '先为项目绑定工作目录';
    $('.crew-empty p').textContent = '在接入设置中绑定本机目录，然后回到这里启动会话。';
    const link = node('a', 'btn', '前往接入设置'); link.href = '#/settings'; $('.crew-empty').append(link);
  }
  function alert(message = '') { if (disposed) return; $('.crew-alert').textContent = message; $('.crew-alert').hidden = !message; }
  function updateLaunch() {
    root.querySelectorAll('[data-provider]').forEach(button => { button.disabled = starting || !directory.options.length || directory.disabled || !window.Terminal || !window.FitAddon; });
  }
  function statusText(record) {
    if (ended(record.meta)) return (record.meta.state || record.meta.status) === 'error' || (record.meta.state || record.meta.status) === 'failed' ? '启动 / 运行异常' : `进程已结束${record.meta.exitCode != null ? ` · ${record.meta.exitCode}` : ''}`;
    if (record.inputError) return '输入已暂停 · 请核对终端';
    if (record.card.hidden) return '后台会话 · 点击查看';
    if (!record.connected) return record.hasConnected ? '连接中断 · 输入已暂停' : '正在连接终端';
    return (record.meta.state || record.meta.status) === 'starting' ? '进程启动中' : '进程运行中';
  }
  function updateRecord(record) {
    if (ended(record.meta)) record.inputError = '';
    const title = names.get(record.meta.id) || `${providerName(record.meta.provider)} · ${String(record.meta.id).slice(0, 6)}`;
    record.rename.setAttribute('aria-label', `重命名 ${title}`);
    record.tab.title = `${providerName(record.meta.provider)} · ${record.meta.cwd || ''}`;
    record.card.setAttribute('aria-label', title);
    record.title.textContent = title;
    record.tabName.textContent = title;
    record.path.textContent = record.meta.cwd || '';
    record.path.title = record.meta.cwd || '';
    record.state.textContent = `${providerName(record.meta.provider)} · ${statusText(record)}`;
    record.tabState.textContent = statusText(record);
    record.card.dataset.state = ended(record.meta) ? 'ended' : record.connected && !record.inputError ? 'connected' : 'offline';
    record.stop.disabled = ended(record.meta) || record.stopping;
    record.resume.hidden = !record.inputError || ended(record.meta);
    record.term.options.disableStdin = !record.connected || !!record.inputError || ended(record.meta);
    record.notice.textContent = record.inputError || record.meta.error || record.replayNotice || (!record.connected && !ended(record.meta) ? '正在连接输出流；连接恢复后可继续输入。' : '');
    record.notice.hidden = !record.notice.textContent;
  }
  function fit(record) {
    if (disposed || record.card.hidden || !record.host.clientWidth || !record.host.clientHeight) return;
    try {
      record.fit.fit();
      const cols = Math.max(20, Math.min(400, record.term.cols)), rows = Math.max(5, Math.min(200, record.term.rows));
      if (record.term.cols !== cols || record.term.rows !== rows) record.term.resize(cols, rows);
      if (cols < 2 || rows < 1 || ended(record.meta) || record.stopping || record.stopRequested || !record.connected) return;
      const size = `${cols}:${rows}`;
      if (record.size === size) return;
      record.size = size;
      api(`${base}/${encodeURIComponent(record.meta.id)}/resize`, { method: 'POST', body: { projectId, cols, rows } }).catch(error => {
        record.size = '';
        if (!disposed && !ended(record.meta) && !record.stopping && !record.stopRequested) { record.inputError = `终端尺寸同步失败：${error.message}。核对输出后恢复输入。`; updateRecord(record); }
      });
    } catch (error) { if (!disposed) alert(`终端显示失败：${error.message}`); }
  }
  function renderSelection() {
    if (disposed) return;
    selected = selected.filter(id => sessions.has(id)).slice(0, capacity());
    const candidates = [...sessions.keys()].sort((a, b) => Number(ended(sessions.get(a).meta)) - Number(ended(sessions.get(b).meta)));
    for (const id of candidates) if (selected.length < capacity() && !selected.includes(id)) selected.push(id);
    $('.crew-terminals').classList.toggle('is-split', layout !== 'single' && selected.length > 1);
    $('.crew-terminals').classList.toggle('is-grid', layout === 'grid' && selected.length > 2);
    for (const [id, record] of sessions) {
      record.card.hidden = !selected.includes(id);
      record.card.style.order = String(selected.indexOf(id));
      record.tab.setAttribute('aria-pressed', String(selected.includes(id)));
      if (!record.card.hidden) {
        if (!record.stream && (!record.hasSnapshot || !ended(record.meta))) connect(record);
        requestAnimationFrame(() => fit(record));
      } else if (record.stream) {
        record.stream.close(); record.stream = null;
        record.generation = (record.generation || 0) + 1;
        if (record.pending.length || record.sending) record.inputError = '切换时有输入尚未确认，请核对终端后恢复输入；不会自动重发。';
        record.pending.length = 0; record.connected = false;
      }
      updateRecord(record);
    }
    root.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === layout)));
    $('.crew-empty').hidden = sessions.size > 0;
    $('.crew-count').textContent = loaded ? `${sessions.size} 个会话 · ${selected.length} 个显示` : '正在读取…';
    filterTabs();
    savePreferences();
  }
  function filterTabs() {
    const query = $('.crew-session-search input').value.trim().toLocaleLowerCase();
    for (const record of sessions.values()) {
      record.tab.hidden = !`${record.tabName.textContent} ${providerName(record.meta.provider)} ${record.meta.cwd}`.toLocaleLowerCase().includes(query);
    }
  }
  $('.crew-session-search input').oninput = filterTabs;
  async function sendInput(record, data) {
    if (!record.connected || record.inputError || ended(record.meta) || disposed) return;
    record.pending.push(...(data.match(/[\s\S]{1,8192}/gu) || []));
    if (record.sending) return;
    record.sending = true;
    while (record.pending.length && !disposed && !record.inputError && record.connected) {
      const chunk = record.pending.shift();
      try { await api(`${base}/${encodeURIComponent(record.meta.id)}/input`, { method: 'POST', body: { projectId, data: chunk } }); }
      catch (error) {
        record.pending.length = 0;
        record.inputError = `输入传输结果不确定：${error.message}。请先核对终端；未确认的输入不会自动重发。`;
        updateRecord(record);
      }
    }
    record.pending.length = 0;
    record.sending = false;
  }
  function createRecord(meta) {
    const card = node('section', 'crew-terminal'); card.hidden = true;
    const head = node('header', 'crew-terminal-head');
    const title = node('strong'), state = node('span', 'crew-process-state');
    const stop = node('button', 'crew-stop', '停止进程'); stop.type = 'button';
    const resume = node('button', 'crew-resume', '已核对，恢复输入'); resume.type = 'button'; resume.hidden = true;
    const rename = node('button', 'crew-rename', '命名'); rename.type = 'button';
    head.append(title, state, rename, resume, stop);
    const renameForm = node('form', 'crew-rename-form'); renameForm.hidden = true;
    const nameInput = node('input'); nameInput.type = 'text'; nameInput.maxLength = 60; nameInput.setAttribute('aria-label', '会话名称');
    const saveName = node('button', 'btn', '保存'); saveName.type = 'submit';
    const cancelName = node('button', 'btn', '取消'); cancelName.type = 'button';
    renameForm.append(nameInput, saveName, cancelName);
    const path = node('div', 'crew-terminal-path');
    const notice = node('div', 'crew-terminal-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
    const host = node('div', 'crew-terminal-host');
    card.append(head, renameForm, path, notice, host); $('.crew-terminals').append(card);
    const tab = node('button', 'crew-session-tab'); tab.type = 'button';
    const tabName = node('span'), tabState = node('small'); tab.append(tabName, tabState); $('.crew-session-tabs').append(tab);
    const term = new window.Terminal({ cols: meta.cols || 80, rows: meta.rows || 24, cursorBlink: true, convertEol: false, scrollback: 8000, fontSize: 13, fontFamily: '"SF Mono", Menlo, "PingFang SC", monospace', theme: { background: '#101217', foreground: '#dce0e9', cursor: '#b9b5ff', selectionBackground: '#55517280' }, allowProposedApi: false, disableStdin: true });
    const addon = new window.FitAddon.FitAddon(); term.loadAddon(addon); term.open(host);
    const record = { meta, card, title, rename, state, path, notice, host, stop, resume, tab, tabName, tabState, term, fit: addon, connected: false, seq: 0, pending: [], inputError: '', replayNotice: '', size: '' };
    sessions.set(meta.id, record);
    record.inputSubscription = term.onData(data => sendInput(record, data));
    record.observer = new ResizeObserver(() => { clearTimeout(record.fitTimer); record.fitTimer = setTimeout(() => fit(record), 100); }); record.observer.observe(host);
    tab.onclick = () => {
      if (layout === 'single') selected = [meta.id];
      else if (!selected.includes(meta.id)) selected = [...selected.slice(0, capacity() - 1), meta.id];
      renderSelection(); term.focus();
    };
    rename.onclick = () => { renameForm.hidden = false; nameInput.value = names.get(meta.id) || ''; nameInput.placeholder = `${providerName(meta.provider)} · ${meta.id.slice(0, 6)}`; nameInput.focus(); };
    cancelName.onclick = () => { renameForm.hidden = true; term.focus(); };
    nameInput.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); cancelName.click(); } };
    renameForm.onsubmit = event => {
      event.preventDefault();
      const value = nameInput.value.trim();
      if (value) names.set(meta.id, value); else names.delete(meta.id);
      renameForm.hidden = true; updateRecord(record); filterTabs(); savePreferences(); term.focus();
    };
    resume.onclick = () => { record.inputError = ''; record.size = ''; updateRecord(record); fit(record); if (record.connected) term.focus(); };
    stop.onclick = async () => {
      record.stopping = true; record.stopRequested = true; updateRecord(record);
      try {
        const result = await api(`${base}/${encodeURIComponent(meta.id)}/stop`, { method: 'POST', body: { projectId } });
        if (!disposed) { const next = result.session || result; if (next.id) Object.assign(record.meta, next); }
      } catch (error) { record.stopRequested = false; if (!disposed) alert(`停止失败：${error.message}`); }
      finally { record.stopping = false; if (!disposed) { updateRecord(record); renderSelection(); } }
    };
    updateRecord(record);
    return record;
  }
  function connect(record) {
    record.stream?.close();
    if (disposed) return;
    const stream = new EventSource(`${base}/${encodeURIComponent(record.meta.id)}/events?${query}`);
    record.stream = stream;
    const parse = event => { try { return JSON.parse(event.data); } catch { return null; } };
    stream.addEventListener('snapshot', event => {
      if (disposed) return;
      const snapshot = parse(event); if (!snapshot) return;
      const generation = (record.generation || 0) + 1; record.generation = generation;
      record.connected = false;
      record.pending.length = 0;
      record.hasSnapshot = true;
      const { output = [], ...metadata } = snapshot;
      Object.assign(record.meta, metadata);
      record.seq = Number(snapshot.lastSeq || output.at(-1)?.seq || 0);
      record.replayNotice = snapshot.truncated ? '较早的终端输出已超出保留范围，当前显示可恢复的部分。' : '';
      updateRecord(record);
      // Disable stdin throughout replay, including escape-sequence auto responses.
      record.term.reset();
      if (snapshot.cols > 1 && snapshot.rows > 0) record.term.resize(snapshot.cols, snapshot.rows);
      record.term.write(output.map(chunk => chunk.data).join(''), () => {
        if (disposed || generation !== record.generation) return;
        record.connected = true; record.hasConnected = true;
        updateRecord(record); renderSelection(); record.size = ''; fit(record);
        if (ended(record.meta)) { stream.close(); record.connected = false; updateRecord(record); }
      });
    });
    stream.addEventListener('output', event => {
      if (disposed) return;
      const payload = parse(event); if (!payload) return;
      const seq = Number(payload.seq);
      if (!Number.isFinite(seq) || seq <= record.seq) return;
      record.seq = seq;
      record.term.write(payload.data || '');
    });
    stream.addEventListener('state', event => {
      if (disposed) return;
      const payload = parse(event); if (!payload) return;
      Object.assign(record.meta, payload.session || payload);
      updateRecord(record); renderSelection();
      if (ended(record.meta)) { stream.close(); record.connected = false; updateRecord(record); }
    });
    stream.onerror = () => {
      if (disposed || ended(record.meta)) return;
      record.generation = (record.generation || 0) + 1;
      record.connected = false;
      if (record.pending.length || record.sending) record.inputError = '连接中断，部分输入的传输结果不确定。请核对终端后恢复输入；不会自动重发。';
      record.pending.length = 0; updateRecord(record);
    };
  }
  async function refresh() {
    try {
      const result = await api(`${base}?${query}`);
      if (disposed) return;
      const list = Array.isArray(result) ? result : result.sessions || [];
      for (const meta of list) {
        const record = sessions.get(meta.id);
        if (record) { Object.assign(record.meta, meta); updateRecord(record); }
        else createRecord(meta);
      }
      loaded = true; renderSelection();
    } catch (error) { if (!disposed) { loaded = true; renderSelection(); alert(`无法读取会话：${error.message}`); } }
  }
  for (const button of root.querySelectorAll('[data-provider]')) button.onclick = async () => {
    if (starting || !directory.value || directory.disabled) return;
    starting = true; updateLaunch(); alert();
    const provider = button.dataset.provider, cwd = directory.value, key = `${provider}:${cwd}`;
    const requestId = attempts.get(key) || crypto.randomUUID(); attempts.set(key, requestId);
    try {
      const result = await api(base, { method: 'POST', body: { projectId, provider, cwd, requestId, cols: 100, rows: 30 } });
      if (disposed) return;
      const meta = result.session || result;
      if (!meta.id) throw new Error('服务未返回会话信息');
      attempts.delete(key);
      if (!sessions.has(meta.id)) createRecord(meta);
      selected = [...selected.filter(id => id !== meta.id).slice(0, capacity() - 1), meta.id];
      $('.crew-session-search input').value = '';
      renderSelection(); sessions.get(meta.id).term.focus();
      toast(`${providerName(provider)} 会话已创建`);
    } catch (error) { if (!disposed) alert(`启动未确认：${error.message}。可刷新会话列表，或再次点击启动重试同一次请求。`); }
    finally { starting = false; if (!disposed) updateLaunch(); }
  };
  root.querySelectorAll('[data-layout]').forEach(button => { button.onclick = () => { picks = withPicks(picks, layout, selected); layout = button.dataset.layout; selected = picks[layout]; renderSelection(); }; });
  $('.crew-refresh').onclick = () => { alert(); refresh(); };
  updateLaunch();
  if (!window.Terminal || !window.FitAddon) alert('终端组件未加载，请重新加载页面。');
  else refresh();
  return () => {
    disposed = true;
    for (const record of sessions.values()) {
      record.stream?.close(); record.observer.disconnect(); clearTimeout(record.fitTimer);
      record.pending.length = 0; record.inputSubscription.dispose(); record.term.dispose();
    }
  };
}
