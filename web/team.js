const NAMES = { user: '你', codex: 'Codex', claude: 'Claude Code' };
const CONNECTIONS = { disconnected: '未连接', connecting: '连接中', connected: '已连接 · 待就绪', ready: '可收消息', error: '连接异常' };
const STATES = { queued: '已排队', transport_written: '已传输 · 等待回应', replied: '已回复', delivery_unknown: '投递结果待核对', failed: '发送失败' };
const STATUSES = { idle: '尚未启动', starting: '启动中', running: '团队已启动', stopped: '已停止', error: '启动或运行异常' };
const time = value => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '暂无活动';
};
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** Mount the live, project-scoped two-member team. Call cleanup on navigation. */
export function mountTeam(root, { projectId, projectName, dirs = [], api, toast = () => {} }) {
  let disposed = false, live = false, streamSeen = false, streamFailed = false, action = '', sending = false;
  let snapshot = { projectId, status: 'idle', members: [], messages: [] };
  let taskSignature = '', attentionSignature = '', setupSignature = '', pendingOperation = false;
  let selected = 'codex', filter = 'all', messageSignature = '', localError = '';
  const drafts = { codex: '', claude: '' }, attempts = new Map();
  root.innerHTML = `
    <section class="team-workbench" aria-label="团队工作台">
      <header class="team-heading">
        <div><h2>团队</h2><p class="team-project"></p></div>
        <div class="team-actions"><span class="team-status" role="status"></span><button class="btn pri team-start" type="button">启动团队</button><button class="btn team-stop" type="button">停止团队</button></div>
      </header>
      <section class="team-run-config" aria-label="运行设置">
        <div class="team-delegation-config">
          <label>本次目标 <textarea class="team-goal" rows="2" maxlength="4000" placeholder="让团队做什么？"></textarea></label>
        </div>
        <details class="team-options">
          <summary>运行设置 <span class="team-options-summary"></span></summary>
          <label>协作方式 <select class="team-mode"><option value="codex-team">Codex 团队 · 原生子 Agent</option><option value="delegation">Claude 负责 / Codex 执行</option><option value="communication">消息协作</option></select></label>
          <div class="team-execution-settings">
          <label>项目目录 <select class="team-cwd"></select></label>
          <label>执行权限 <select class="team-access"><option value="read-only">只读检查</option><option value="workspace-write">修改隔离副本</option></select></label>
          <p>修改保留在隔离目录，核对后再应用到项目。</p>
          <p class="team-run-detail" hidden></p>
          </div>
        </details>
      </section>
      <details class="team-tasks" hidden aria-label="委派任务与审批"><summary>任务与审批 <span class="team-task-summary"></span></summary><div class="team-task-list"></div><div class="team-approval-list"></div></details>
      <div class="team-notice" role="status" aria-live="polite"></div>
      <div class="team-error" role="alert" hidden></div>
      <div class="team-layout">
        <details class="team-stage" aria-label="成员与协作关系"><summary>连接详情</summary>
          <div class="team-stage-head"><span>成员与协作</span><span>2 位成员</span></div>
          <div class="team-canvas">
            <div class="team-members"></div>
            <button type="button" class="team-edge" aria-label="查看 Codex 与 Claude 双方消息" aria-pressed="false">
              <svg viewBox="0 0 80 94" aria-hidden="true"><path d="M 32 4 L 32 90 M 25 81 L 32 90 L 39 81 M 48 90 L 48 4 M 41 13 L 48 4 L 55 13" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
              <span>双向协作</span>
            </button>
          </div>
          <div class="team-stage-note">选择工牌，向该成员发送消息。选择连接，查看双方交流。</div>
          <details class="team-session-note"><summary>关于团队会话</summary><p>启动后创建本项目专用会话。Codex 使用 App Server 专用会话；这里没有接管已有终端，也不提供旧终端入口。</p><p>停止团队会断开这些专用会话；已经执行的操作不会撤回。当前记录保存在运行中的本地服务，重启服务后不会恢复。</p></details>
          <section class="team-setup" hidden aria-label="连接 Claude Code">
            <h3>在本机连接 Claude Code</h3><p class="team-setup-instructions"></p>
            <p>在本机终端执行下面的一次性命令，按提示完成工作目录信任确认。如果仍显示“待就绪”，在 Claude 会话中输入 <code>Call corpus_bridge ready now.</code>。</p>
            <pre class="team-command" tabindex="0"></pre><button class="btn team-copy" type="button">复制启动命令</button>
          </section>
        </details>
        <section class="team-conversation" aria-label="团队消息">
          <header class="team-message-head"><div><h3>对话</h3><p class="team-filter-description"></p></div><span class="team-message-count"></span></header>
          <div class="team-filters" role="group" aria-label="筛选消息">
            <button type="button" data-filter="all">全部</button><button type="button" data-filter="codex">Codex</button><button type="button" data-filter="claude">Claude</button><button type="button" data-filter="edge">双方交流</button>
          </div>
          <div class="team-message-list" role="log" aria-label="消息记录" aria-live="polite" aria-relevant="additions text"></div>
          <form class="team-composer">
            <div class="team-recipient-row"><label>发送给 <select class="team-recipient" aria-label="消息接收人"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><span class="team-recipient-status"></span></div>
            <label class="team-input-label">补充信息<textarea class="team-input" rows="2" maxlength="8192" placeholder="输入目标、补充信息或问题…"></textarea></label>
            <div class="team-send-row"><span class="team-send-hint"></span><button class="btn pri team-send" type="submit">发送消息</button></div>
            <p class="team-delivery-note">传输成功不代表模型已收到；请以实际回复判断。</p>
          </form>
        </section>
      </div>
    </section>`;
  const $ = selector => root.querySelector(selector);
  $('.team-project').textContent = projectName || projectId;
  for (const dir of dirs) { const option = node('option', '', dir); option.value = dir; $('.team-cwd').append(option); }
  const cards = new Map();
  for (const id of ['codex', 'claude']) {
    const card = node('button', `team-member team-member-${id}`);
    card.type = 'button'; card.dataset.member = id;
    card.append(node('span', 'team-avatar', id === 'codex' ? 'CX' : 'CL'));
    const body = node('span', 'team-member-body');
    for (const cls of ['name', 'role', 'connection', 'auth', 'session', 'activity', 'error']) body.append(node('span', `team-member-${cls}`));
    card.append(body); $('.team-members').append(card); cards.set(id, card);
    card.addEventListener('click', () => choose(id, true));
  }
  function choose(id, changeFilter = false) {
    drafts[selected] = $('.team-input').value;
    selected = snapshot.run ? snapshot.run.mode === 'codex-team' ? 'codex' : 'claude' : id; $('.team-recipient').value = selected; $('.team-input').value = drafts[selected];
    if (changeFilter) filter = id;
    render();
  }
  function ready() {
    return live && snapshot.status === 'running' && snapshot.members.some(m => m.id === selected && m.connection === 'ready');
  }
  function render() {
    if (disposed) return;
    const interrupted = ['starting', 'running', 'error'].includes(snapshot.status)
      && snapshot.members.some(member => member.sessionId)
      && snapshot.members.some(member => ['disconnected', 'error'].includes(member.connection));
    $('.team-status').textContent = interrupted ? '成员连接待恢复' : STATUSES[snapshot.status] || '状态未知';
    $('.team-status').dataset.status = live ? snapshot.status : 'offline';
    $('.team-notice').textContent = live
      ? snapshot.status === 'idle' ? $('.team-mode').value === 'codex-team' ? '填写目标后启动专用 Codex 团队；成员活动会显示在底部 TEAM 条。' : '尚未连接真实会话。启动团队后，按下方说明连接 Claude Code。'
        : snapshot.status === 'stopped' ? '本团队已停止。再次启动会创建新的专用会话。'
        : interrupted ? '成员连接中断，需要重新接入。团队恢复就绪前，发送已暂停。'
        : snapshot.status === 'starting' ? '正在创建专用会话，请等待连接状态更新。'
        : '界面已连接本地服务；各成员是否可收消息，请查看工牌。'
      : streamSeen || streamFailed ? '界面连接已丢失，发送已暂停。正在自动重连；工牌信息仅为最后观测。' : '正在连接本地服务，收到实时状态后才可发送消息。';
    $('.team-notice').classList.toggle('team-offline', !live);
    $('.team-error').textContent = localError || snapshot.error || '';
    $('.team-error').hidden = !$('.team-error').textContent;
    const active = ['starting', 'running'].includes(snapshot.status) || (snapshot.status === 'error' && snapshot.members.some(member => ['connecting', 'connected', 'ready'].includes(member.connection)));
    if (snapshot.status === 'error' && active && snapshot.run) $('.team-notice').textContent = '本轮已暂停派发。先核对执行目录中的产物，再停止团队并重新启动。';
    const nativeTeam = snapshot.run?.mode === 'codex-team';
    const delegationMode = $('.team-mode').value !== 'communication';
    $('.team-delegation-config').hidden = !delegationMode;
    $('.team-execution-settings').hidden = !delegationMode;
    const modeLabel = { 'codex-team': 'Codex 团队', delegation: 'Claude / Codex 委派', communication: '消息协作' }[$('.team-mode').value];
    $('.team-options-summary').textContent = delegationMode ? `${modeLabel} · ${$('.team-access').value === 'workspace-write' ? '修改隔离副本' : '只读检查'}` : modeLabel;
    for (const control of root.querySelectorAll('.team-run-config select, .team-run-config textarea')) control.disabled = active || !!action;
    $('.team-start').disabled = !!action || active || !live || (delegationMode && (!$('.team-cwd').value || !$('.team-goal').value.trim()));
    $('.team-run-detail').hidden = !snapshot.run;
    $('.team-run-detail').textContent = snapshot.run ? `目标：${snapshot.run.goal}\n项目：${snapshot.run.cwd}\n执行目录：${snapshot.run.workerCwd || '准备中'}\n基线：${snapshot.run.baselinePath || '只读任务无需副本基线'}\n权限：${snapshot.run.access === 'read-only' ? '只读检查' : '修改隔离副本'} · 修改不会自动合并` : '';
    $('.team-recipient').disabled = !!snapshot.run;
    const leader = nativeTeam ? 'codex' : 'claude';
    if (snapshot.run && selected !== leader) { selected = leader; $('.team-recipient').value = selected; $('.team-input').value = drafts[selected]; }
    $('.team-edge').hidden = nativeTeam;
    if (nativeTeam && !['all', 'codex'].includes(filter)) filter = 'codex';
    for (const button of root.querySelectorAll('[data-filter]')) button.hidden = nativeTeam && ['claude', 'edge'].includes(button.dataset.filter);
    $('.team-session-note p').textContent = nativeTeam ? '启动后创建本项目专用 Codex 负责人会话；成员由原生子 Agent 工具创建，可在底部 TEAM 条查看。这里没有接管已有终端。' : '启动后创建本项目专用会话。Codex 使用 App Server 专用会话；这里没有接管已有终端，也不提供旧终端入口。';
    $('.team-stage-head').lastElementChild.textContent = nativeTeam ? `${snapshot.agents?.length || 1} 位 Codex 成员` : '2 位成员';
    $('.team-stage-note').textContent = nativeTeam ? '负责人负责拆分与验收。底部 TEAM 条可查看每位原生成员的任务、活动和成果。' : '选择工牌，向该成员发送消息。选择连接，查看双方交流。';
    $('.team-start').textContent = action === 'start' ? '正在启动…' : snapshot.status === 'stopped' ? '重新启动' : '启动团队';
    $('.team-stop').disabled = !!action || !live || !['starting', 'running', 'error'].includes(snapshot.status);
    $('.team-stop').textContent = action === 'stop' ? '正在停止…' : '停止团队';
    for (const [id, card] of cards) {
      const member = snapshot.members.find(m => m.id === id) || { id, connection: 'disconnected' };
      card.hidden = nativeTeam && id === 'claude';
      card.setAttribute('aria-pressed', String(selected === id));
      card.dataset.connection = live ? member.connection : 'disconnected';
      const put = (cls, value) => { card.querySelector(`.team-member-${cls}`).textContent = value || ''; };
      put('name', member.name || NAMES[id]); put('role', member.role || (id === 'codex' ? '负责人' : '协作成员'));
      put('connection', live ? CONNECTIONS[member.connection] || '状态未知' : '界面离线 · 状态待更新');
      put('auth', member.authLabel); put('session', member.sessionId ? `会话 ${member.sessionId}` : '尚未绑定会话');
      put('activity', member.lastActivityAt ? `最近活动 ${time(member.lastActivityAt)}` : '暂无新活动');
      put('error', member.error);
    }
    const setupCommand = snapshot.setup?.command || '';
    if (setupCommand && setupCommand !== setupSignature) $('.team-stage').open = true;
    setupSignature = setupCommand;
    $('.team-setup').hidden = !setupCommand;
    $('.team-setup-instructions').textContent = snapshot.setup?.instructions || '';
    $('.team-command').textContent = snapshot.setup?.command || '';
    $('.team-edge').setAttribute('aria-pressed', String(filter === 'edge'));
    root.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
    $('.team-filter-description').textContent = { all: '全部成员与人类消息', codex: '与 Codex 有关的消息', claude: '与 Claude Code 有关的消息', edge: 'Codex ↔ Claude Code' }[filter];
    $('.team-recipient-status').textContent = ready() ? '可收消息' : '暂不可发送';
    $('.team-send').disabled = sending || !ready() || !$('.team-input').value.trim();
    $('.team-send').textContent = sending ? '发送中…' : '发送消息';
    const recipientReady = snapshot.members.some(member => member.id === selected && member.connection === 'ready');
    const waitingMembers = snapshot.members.filter(member => member.id !== selected && member.connection !== 'ready')
      .map(member => NAMES[member.id] || member.name).join('、');
    $('.team-send-hint').textContent = !live ? '等待界面重连'
      : !recipientReady ? `等待 ${NAMES[selected]} 就绪`
      : snapshot.status !== 'running' ? waitingMembers ? `等待 ${waitingMembers} 就绪后恢复团队发送` : '等待团队恢复就绪'
      : `仅发送给 ${NAMES[selected]}`;
    renderTasks();
    renderMessages();
  }
  async function taskOperation(kind, body) {
    if (!live || pendingOperation || !snapshot.run) return;
    pendingOperation = true; localError = ''; renderTasks(true);
    try { apply(await api(`/api/team/${kind}`, { method: 'POST', body: { projectId, runId: snapshot.run.id, ...body } })); }
    catch (error) { if (!disposed) localError = error.message || '任务操作失败'; }
    finally { pendingOperation = false; renderTasks(true); render(); }
  }
  function renderTasks(force = false) {
    const section = $('.team-tasks'); section.hidden = !snapshot.run;
    const tasks = snapshot.run?.mode === 'codex-team' ? snapshot.nativeTasks || [] : snapshot.tasks || [];
    $('.team-task-summary').textContent = `${tasks.filter(t => t.state === 'accepted').length}/${tasks.length} 已验收`;
    const attention = JSON.stringify((snapshot.approvals || []).filter(a => a.state === 'pending').map(a => a.id));
    if (attention !== attentionSignature && attention !== '[]') section.open = true;
    attentionSignature = attention;
    const signature = JSON.stringify([snapshot.run?.id, snapshot.tasks, snapshot.nativeTasks, snapshot.approvals, live, pendingOperation]);
    if (!force && signature === taskSignature) return; taskSignature = signature;
    const list = $('.team-task-list'); list.replaceChildren();
    const labels = { queued: '等待接单', running: '执行中', needs_input: '等待补充信息', submitted: '成果已提交 · 待负责人检查', accepted: '负责人已接受', failed: '执行失败', cancel_requested: '正在取消 · 等待原生结束', cancelled: '已取消', delivery_unknown: '执行结果待核对' };
    if (snapshot.run?.mode === 'codex-team') {
      if (!snapshot.nativeTasks?.length) list.append(node('p', '', '目标送给 Codex 负责人后，由负责人记录任务并创建原生成员。成员活动显示在底部 TEAM 条。'));
      for (const task of snapshot.nativeTasks || []) {
        const card = node('article', 'team-task');
        card.append(node('h4', '', task.title), node('p', 'team-task-state', `${{ planned: '待开始', running: '执行中', submitted: '成果已提交 · 待检查', accepted: '负责人已接受', failed: '执行失败', interrupted: '已中断' }[task.state]} · ${task.threadId || '等待分配成员'}`), node('p', '', `文件范围：${task.files.join('、') || '只读 / 说明'}`), node('p', '', `验收：${task.acceptance.join('；')}`));
        for (const review of task.reviews) card.append(node('p', '', `${review.decision === 'accept' ? '接受' : '返工'}：${review.reason}`));
        list.append(card);
      }
    } else if (!snapshot.tasks?.length) list.append(node('p', '', '目标将在双方就绪后送给 Claude。负责人根据工作需要决定是否委派。'));
    for (const task of snapshot.tasks || []) {
      const card = node('article', 'team-task');
      card.append(node('h4', '', task.title), node('p', 'team-task-state', `${labels[task.state] || task.state} · 第 ${task.attempt} 次执行`), node('p', '', task.goal));
      if (task.files.length) card.append(node('p', '', `文件范围：${task.files.join('、')}`));
      card.append(node('p', '', `验收：${task.acceptance.join('；')}`));
      if (task.question) card.append(node('p', '', `需要补充：${task.question}。请向 Claude 说明，由负责人补充给执行者。`));
      if (task.needsAttention) card.append(node('p', '', '已等待超过 10 分钟，可继续等待或取消。'));
      if (task.error) card.append(node('p', '', task.error));
      if (task.result) {
        card.append(node('strong', '', '执行者成果'), node('p', '', task.result.summary));
        for (const artifact of task.result.artifacts) card.append(node('p', '', `${artifact.path}：${artifact.description}`));
        for (const check of task.result.checks) card.append(node('p', '', `${{ passed: '通过', failed: '失败', not_run: '未执行' }[check.status]} · ${check.command} · ${check.detail}`));
        for (const issue of task.result.unresolved) card.append(node('p', '', `剩余问题：${issue}`));
      }
      if (task.review) card.append(node('p', '', `负责人检查：${task.review.reason}`));
      if (task.lateResults?.length) { const details = node('details'); details.append(node('summary', '', '取消或失联后收到的成果 · 未验收'), node('pre', '', JSON.stringify(task.lateResults, null, 2))); card.append(details); }
      if (task.diff) { const details = node('details'); details.append(node('summary', '', 'Codex 原生变更记录'), node('pre', '', task.diff)); card.append(details); }
      if (task.previousResults?.length) { const details = node('details'); details.append(node('summary', '', '首次成果与返工原因'), node('p', '', task.revisionReason || ''), node('pre', '', JSON.stringify(task.previousResults, null, 2))); card.append(details); }
      if (!['accepted', 'failed', 'cancelled', 'cancel_requested'].includes(task.state)) {
        const cancel = node('button', 'btn', '取消任务'); cancel.type = 'button'; cancel.disabled = !live || pendingOperation;
        cancel.addEventListener('click', () => taskOperation('cancel', { taskId: task.id })); card.append(cancel);
      }
      list.append(card);
    }
    const approvals = $('.team-approval-list'); approvals.replaceChildren();
    for (const approval of snapshot.approvals || []) {
      const card = node('article', 'team-approval');
      card.append(node('h4', '', approval.state === 'pending' ? 'Codex 等待你的审批' : '审批已处理'), node('pre', '', approval.detail));
      if (approval.state === 'pending') for (const [decision, label] of [['accept', '允许本次'], ['decline', '拒绝本次'], ['cancel', '拒绝并中断']]) {
        const button = node('button', 'btn', label); button.type = 'button'; button.disabled = !live || pendingOperation || (snapshot.run?.mode === 'codex-team' && snapshot.status !== 'running');
        button.addEventListener('click', () => taskOperation('approve', { approvalId: approval.id, decision })); card.append(button);
      }
      else card.append(node('p', '', approval.decision ? `你的决定：${{ accept: '允许', decline: '拒绝', cancel: '拒绝并中断' }[approval.decision]}` : '原生请求已结束'));
      approvals.append(card);
    }
  }
  function renderMessages() {
    const messages = snapshot.messages.filter(m => filter === 'all' || (filter === 'edge'
      ? (m.from === 'codex' && m.to === 'claude') || (m.from === 'claude' && m.to === 'codex')
      : m.from === filter || m.to === filter));
    $('.team-message-count').textContent = `${messages.length} 条`;
    const signature = JSON.stringify([filter, messages]);
    if (signature === messageSignature) return;
    const list = $('.team-message-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    const filterChanged = !messageSignature || JSON.parse(messageSignature)[0] !== filter;
    messageSignature = signature;
    const fragment = document.createDocumentFragment();
    if (!messages.length) {
      const empty = node('div', 'team-message-empty');
      empty.append(node('span', 'team-empty-symbol', '↗'), node('strong', '', '还没有消息'), node('p', '', filter === 'edge' ? '成员之间的真实提问和回复将显示在这里。' : '成员就绪后，发送第一条消息。'));
      fragment.append(empty);
    }
    for (const message of messages) {
      const item = node('article', `team-message ${message.from === 'user' ? 'team-message-human' : ''}`);
      const head = node('div', 'team-message-meta');
      head.append(node('strong', '', `${NAMES[message.from] || message.from} → ${NAMES[message.to] || message.to}`), node('time', '', time(message.createdAt)));
      item.append(head);
      if (message.inReplyTo) {
        const original = snapshot.messages.find(m => m.id === message.inReplyTo);
        item.append(node('div', 'team-reply', original ? `回复 ${NAMES[original.from] || original.from}：${original.text.slice(0, 160)}` : '回复此前消息'));
      }
      item.append(node('div', 'team-message-text', message.text));
      const stateLabel = message.to === 'user' && message.state === 'transport_written' ? '已送达页面' : STATES[message.state] || '状态待核对';
      const state = node('span', 'team-message-state', stateLabel);
      state.dataset.state = message.state; item.append(state); fragment.append(item);
    }
    list.replaceChildren(fragment);
    if (atBottom || filterChanged) list.scrollTop = list.scrollHeight;
  }
  function apply(data) {
    const next = data?.snapshot || data;
    if (disposed || next?.projectId !== projectId || !Array.isArray(next.members) || !Array.isArray(next.messages)) return false;
    snapshot = next;
    if (next.run && ['starting', 'running', 'error'].includes(next.status)) { $('.team-mode').value = next.run.mode; $('.team-cwd').value = next.run.cwd; if (!$('.team-cwd').value) { const option = node('option', '', next.run.cwd); option.value = next.run.cwd; $('.team-cwd').append(option); $('.team-cwd').value = next.run.cwd; } $('.team-goal').value = next.run.goal; $('.team-access').value = next.run.access; }
    render(); return true;
  }
  async function operate(kind) {
    if (action || !live) return;
    action = kind; localError = ''; render();
    try { apply(await api(`/api/team/${kind}`, { method: 'POST', body: { projectId, ...(kind === 'start' && $('.team-mode').value !== 'communication' ? { mode: $('.team-mode').value, cwd: $('.team-cwd').value, goal: $('.team-goal').value.trim(), access: $('.team-access').value } : {}) } })); }
    catch (error) { if (!disposed) localError = error.message || '操作失败'; }
    finally { action = ''; render(); }
  }
  $('.team-mode').addEventListener('change', render);
  $('.team-goal').addEventListener('input', render);
  $('.team-access').addEventListener('change', render);
  $('.team-cwd').addEventListener('change', render);
  $('.team-start').addEventListener('click', () => operate('start'));
  $('.team-stop').addEventListener('click', () => operate('stop'));
  $('.team-edge').addEventListener('click', () => { filter = 'edge'; render(); });
  root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
  $('.team-recipient').addEventListener('change', event => choose(event.target.value));
  $('.team-input').addEventListener('input', () => { drafts[selected] = $('.team-input').value; render(); });
  $('.team-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snapshot.setup.command); if (!disposed) toast('启动命令已复制'); }
    catch { if (!disposed) { localError = '复制失败，请选中上方命令手动复制。'; render(); } }
  });
  $('.team-composer').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('.team-input').value.trim(), recipient = selected, draft = $('.team-input').value;
    if (!text || sending || !ready()) return;
    const key = JSON.stringify([recipient, text]);
    const requestId = attempts.get(key) || crypto.randomUUID();
    attempts.set(key, requestId); sending = true; localError = ''; render();
    try {
      const result = await api('/api/team/messages', { method: 'POST', body: { projectId, to: recipient, text, requestId, ...(snapshot.run ? { runId: snapshot.run.id } : {}) } });
      if (disposed) return;
      apply(result);
      if (drafts[recipient] === draft) {
        drafts[recipient] = '';
        if (selected === recipient) $('.team-input').value = '';
      }
      attempts.delete(key);
      toast('消息已提交，请查看投递状态与回复');
    } catch (error) {
      if (!disposed) localError = `消息提交未获确认：${error.message || '请求失败'}。草稿已保留，请先核对消息记录。`;
    } finally { sending = false; render(); }
  });
  render();
  const url = `/api/team?projectId=${encodeURIComponent(projectId)}`;
  api(url).then(data => { if (!streamSeen) apply(data); }).catch(error => {
    if (!disposed && !streamSeen) { localError = error.message || '无法读取团队'; render(); }
  });
  let stream;
  try {
    stream = new EventSource(`/api/team/events?projectId=${encodeURIComponent(projectId)}`);
    stream.addEventListener('snapshot', event => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data), next = data?.snapshot || data;
        if (next?.projectId !== projectId || !Array.isArray(next.members) || !Array.isArray(next.messages)) throw new Error('无效快照');
        live = true; streamSeen = true; streamFailed = false; apply(data);
      } catch { live = false; localError = '实时状态无法读取，已暂停发送。'; render(); }
    });
    stream.onerror = () => { if (!disposed) { live = false; streamFailed = true; render(); } };
  } catch { localError = '浏览器无法建立实时连接，请重新打开团队页。'; render(); }
  const offline = () => { if (!disposed) { live = false; streamFailed = true; render(); } };
  window.addEventListener('offline', offline);
  return () => { disposed = true; live = false; stream?.close(); window.removeEventListener('offline', offline); };
}
