const LABELS = { starting: '启动中', running: '执行中', idle: '等待任务', completed: '本轮完成', waiting_approval: '等待审批', waiting_input: '等待输入', interrupt_requested: '正在中断', interrupted: '已中断', failed: '异常', closed: '已结束', unknown: '状态待核对' };
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

/** Counts accepted tasks, never elapsed time or mere native turn completion. */
export function teamProgress(snapshot, live) {
  const tasks = snapshot.run?.mode === 'codex-team' ? snapshot.nativeTasks || [] : snapshot.tasks || [];
  const accepted = tasks.filter(t => t.state === 'accepted').length;
  const label = tasks.length ? `已验收 ${accepted}/${tasks.length}` : snapshot.run ? '等待拆分任务' : '尚未启动';
  return { accepted, total: tasks.length, label: live ? label : `${label} · 最后观测`, ratio: tasks.length ? accepted / tasks.length : 0 };
}
export function dockMembers(snapshot, live) {
  if (snapshot.run?.mode === 'codex-team') return (snapshot.agents || []).map(a => ({ ...a, id: a.threadId, label: live ? LABELS[a.state] || '状态未知' : '连接中断 · 最后观测' }));
  return (snapshot.members || []).map(m => {
    const task = (snapshot.tasks || []).find(t => t.assignee === m.id && !['accepted', 'cancelled', 'failed'].includes(t.state));
    const approval = (snapshot.approvals || []).some(a => a.state === 'pending' && a.threadId === m.sessionId);
    const state = approval ? 'waiting_approval' : task?.state === 'needs_input' ? 'waiting_input' : task?.state === 'cancel_requested' ? 'interrupt_requested' : task?.state === 'running' ? 'running' : m.connection === 'ready' ? 'idle' : m.connection === 'connecting' ? 'starting' : 'unknown';
    return { id: m.id, threadId: m.sessionId, name: m.name, role: m.role, state, step: task?.title || m.error || m.authLabel, events: [], label: live ? LABELS[state] : '连接中断 · 最后观测' };
  });
}

/** Project-scoped footer survives page switches via server snapshots. */
export function mountTeamDock(root, { projectId, api, toast = () => {} }) {
  let disposed = false, live = false, seen = false, snapshot = { projectId, status: 'idle', members: [], messages: [] }, selected = '', expanded = false, busy = false, error = '';
  let inputSignature = '';
  const answers = new Map();
  const drafts = new Map(), attempts = new Map(), buttons = new Map();
  root.replaceChildren(); root.className = 'crew-team-dock'; root.setAttribute('aria-label', '团队状态与成员');
  const panel = el('section', 'crew-dock-panel'); panel.id = 'crew-team-details'; panel.hidden = true;
  const heading = el('div', 'crew-dock-heading'), title = el('h3'), close = el('button', 'btn', '收起'); close.type = 'button';
  heading.append(title, close);
  const status = el('p', 'crew-dock-detail-status'), info = el('div', 'crew-dock-info'), records = el('div', 'crew-dock-records'), approvalList = el('div', 'crew-dock-approvals');
  const inputList = el('div', 'crew-dock-inputs');
  const form = el('form', 'crew-dock-form'), label = el('label', '', '给成员补充信息'), input = el('textarea'); input.rows = 2; input.maxLength = 8192; input.setAttribute('aria-label', '给当前成员补充信息'); label.append(input);
  const controls = el('div', 'crew-dock-controls'), send = el('button', 'btn pri', '发送'), interrupt = el('button', 'btn', '中断当前执行'); send.type = 'submit'; interrupt.type = 'button'; controls.append(send, interrupt); form.append(label, controls);
  const notice = el('p', 'crew-dock-notice'); notice.setAttribute('role', 'status'); panel.append(heading, status, info, records, approvalList, inputList, form, notice);
  const bar = el('div', 'crew-dock-bar'), summary = el('div', 'crew-dock-summary'), brand = el('strong', '', 'TEAM'), count = el('span'), track = el('div', 'crew-dock-track'), fill = el('span'); track.append(fill); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', '已验收任务比例'); summary.append(brand, count, track);
  const members = el('div', 'crew-dock-members'), link = el('a', 'btn', '团队'); link.href = `#/p/${encodeURIComponent(projectId)}/team`; bar.append(summary, members, link); root.append(panel, bar);
  const remember = () => { if (selected) drafts.set(selected, input.value); };
  function choose(id) {
    remember(); expanded = selected === id ? !expanded : true; selected = id; input.value = drafts.get(id) || ''; error = ''; render();
  }
  function collapse() { remember(); expanded = false; render(); buttons.get(selected)?.focus(); }
  close.addEventListener('click', collapse);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); collapse(); }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && event.target.closest('.crew-dock-member')) {
      const list = [...members.children], i = list.indexOf(event.target.closest('.crew-dock-member'));
      list[(i + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]?.focus(); event.preventDefault();
    }
  });
  input.addEventListener('input', () => { remember(); send.disabled = busy || !live || snapshot.status !== 'running' || !input.value.trim(); });
  async function operation(kind, body) {
    if (busy || !live || !snapshot.run) return false;
    busy = true; error = ''; render();
    try { const result = await api(`/api/team/${kind}`, { method: 'POST', body: { projectId, runId: snapshot.run.id, ...body } }); apply(result); return true; }
    catch (e) { error = `操作未获确认：${e.message}。请核对成员记录后再操作。`; return false; }
    finally { busy = false; render(); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); const text = input.value.trim(), id = selected, draft = input.value;
    if (!text || send.disabled) return;
    const key = JSON.stringify([snapshot.run?.id, id, text]), requestId = attempts.get(key) || crypto.randomUUID(); attempts.set(key, requestId);
    if (await operation('agent-message', { threadId: id, text, requestId })) { attempts.delete(key); if (drafts.get(id) === draft) { drafts.set(id, ''); if (selected === id) input.value = ''; } toast('补充信息已提交'); render(); }
  });
  interrupt.addEventListener('click', () => { const a = snapshot.agents?.find(a => a.threadId === selected); if (a?.turnId) void operation('agent-interrupt', { threadId: a.threadId, turnId: a.turnId }); });
  function render() {
    if (disposed) return;
    const progress = teamProgress(snapshot, live), list = dockMembers(snapshot, live);
    count.textContent = progress.label; fill.style.width = `${progress.ratio * 100}%`; track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(progress.total || 1)); track.setAttribute('aria-valuenow', String(progress.accepted)); track.hidden = !progress.total;
    root.dataset.live = String(live); root.dataset.status = snapshot.status;
    for (const [id, button] of buttons) if (!list.some(a => a.id === id)) { button.remove(); buttons.delete(id); }
    for (const [i, a] of list.entries()) {
      let button = buttons.get(a.id);
      if (!button) { button = el('button', 'crew-dock-member'); button.type = 'button'; button.append(el('span', 'crew-dock-dot'), el('span', 'crew-dock-name'), el('span', 'crew-dock-state')); button.addEventListener('click', () => choose(a.id)); buttons.set(a.id, button); }
      if (members.children[i] !== button) members.insertBefore(button, members.children[i] || null);
      button.querySelector('.crew-dock-name').textContent = a.name; button.querySelector('.crew-dock-state').textContent = a.label;
      button.dataset.state = live ? a.state : 'unknown'; button.setAttribute('aria-expanded', String(expanded && selected === a.id)); button.setAttribute('aria-controls', panel.id);
    }
    const a = list.find(a => a.id === selected); panel.hidden = !expanded || !a;
    if (!a) return;
    title.textContent = `${a.name} · ${a.role}`; status.textContent = `${a.label}${a.step ? ` · ${a.step}` : ''}`;
    const tasks = snapshot.run?.mode === 'codex-team' ? (snapshot.nativeTasks || []).filter(t => t.threadId === a.id) : (snapshot.tasks || []).filter(t => t.assignee === a.id || t.leader === a.id);
    info.replaceChildren();
    for (const t of tasks) {
      const card = el('article', 'crew-dock-task'); card.append(el('strong', '', t.title), el('p', '', `文件：${t.files.join('、') || '说明任务'} · 验收：${t.acceptance.join('；')}`));
      for (const review of t.reviews || (t.review ? [t.review] : [])) card.append(el('p', '', `${review.decision === 'accept' ? '接受' : '返工'}：${review.reason}`));
      if (t.result) card.append(el('pre', '', JSON.stringify(t.result, null, 2))); info.append(card);
    }
    records.replaceChildren();
    const events = a.events?.length ? a.events : snapshot.messages.filter(m => m.from === a.id || m.to === a.id).slice(-30).map(m => ({ text: m.text }));
    if (!events.length) records.append(el('p', '', '暂无执行记录'));
    for (const e of events) records.append(el('pre', '', e.text));
    if (a.output) { const result = el('details'); result.open = true; result.append(el('summary', '', '最近成果'), el('pre', '', a.output)); records.append(result); }
    if (a.diff) { const diff = el('details'); diff.append(el('summary', '', '原生变更记录'), el('pre', '', a.diff)); records.append(diff); }
    approvalList.replaceChildren();
    for (const approval of snapshot.approvals || []) if (approval.state === 'pending' && approval.threadId === a.threadId) {
      const card = el('article', 'crew-dock-approval'); card.append(el('strong', '', '等待你的审批'), el('pre', '', approval.detail));
      for (const [decision, text] of [['accept', '允许本次'], ['decline', '拒绝本次'], ['cancel', '拒绝并中断']]) { const button = el('button', 'btn', text); button.type = 'button'; button.disabled = busy || !live || snapshot.status !== 'running'; button.addEventListener('click', () => operation('approve', { approvalId: approval.id, decision })); card.append(button); }
      approvalList.append(card);
    }
    const requests = (snapshot.inputs || []).filter(i => i.state === 'pending' && i.threadId === a.threadId);
    const signature = JSON.stringify([selected, requests, live, busy, snapshot.status]);
    if (signature !== inputSignature) {
      inputSignature = signature; inputList.replaceChildren();
      for (const request of requests) {
        const requestForm = el('form', 'crew-dock-task'); requestForm.append(el('strong', '', '成员需要你的回答'));
        const values = answers.get(request.id) || Object.create(null); answers.set(request.id, values);
        for (const q of request.questions) {
          const label = el('label', '', q.question), field = el('input'); field.type = q.isSecret ? 'password' : 'text'; field.maxLength = 8192; field.required = true; field.value = values[q.id] || ''; field.setAttribute('aria-label', q.question); field.disabled = busy || !live || snapshot.status !== 'running';
          field.addEventListener('input', () => { values[q.id] = field.value; });
          if (q.options?.length) { const options = el('select'); options.setAttribute('aria-label', `${q.header}选项`); options.append(el('option', '', '选择选项或填写回答')); for (const option of q.options) { const choice = el('option', '', `${option.label}：${option.description}`); choice.value = option.label; options.append(choice); } options.disabled = field.disabled; options.addEventListener('change', () => { if (options.selectedIndex) { field.value = options.value; values[q.id] = options.value; } }); label.append(options); }
          label.append(field); requestForm.append(label);
        }
        const button = el('button', 'btn pri', '提交回答'); button.type = 'submit'; button.disabled = busy || !live || snapshot.status !== 'running'; requestForm.append(button);
        requestForm.addEventListener('submit', async event => { event.preventDefault(); if (request.questions.some(q => !values[q.id]?.trim())) return; if (await operation('answer', { inputId: request.id, answers: values })) answers.delete(request.id); });
        inputList.append(requestForm);
      }
    }
    form.hidden = snapshot.run?.mode !== 'codex-team';
    input.disabled = busy || !live || snapshot.status !== 'running' || ['closed', 'unknown', 'failed', 'interrupt_requested'].includes(a.state);
    send.disabled = input.disabled || !input.value.trim(); interrupt.disabled = busy || !live || snapshot.status !== 'running' || !a.turnId || a.state === 'interrupt_requested';
    notice.textContent = error || (!live ? '连接中断，当前信息为最后观测。发送、审批与中断已暂停。' : snapshot.error || (!form.hidden ? '成员执行结束后，任务仍需负责人检查。' : '可到团队页向负责人补充信息或取消任务。'));
  }
  function apply(data) { const next = data?.snapshot || data; if (disposed || next?.projectId !== projectId || !Array.isArray(next.members) || !Array.isArray(next.messages)) return; snapshot = next; render(); }
  const url = `/api/team?projectId=${encodeURIComponent(projectId)}`;
  api(url).then(data => { if (!seen) apply(data); }).catch(e => { error = e.message; render(); });
  let stream;
  try { stream = new EventSource(`/api/team/events?projectId=${encodeURIComponent(projectId)}`); stream.addEventListener('snapshot', event => { try { const data = JSON.parse(event.data), next = data?.snapshot || data; if (next?.projectId !== projectId || !Array.isArray(next.members) || !Array.isArray(next.messages)) throw new Error('Invalid snapshot'); live = true; seen = true; apply(data); } catch { live = false; error = '实时状态无法读取'; render(); } }); stream.onerror = () => { live = false; render(); }; }
  catch { error = '无法建立实时连接'; }
  const offline = () => { live = false; render(); }; window.addEventListener('offline', offline); render();
  return () => { disposed = true; stream?.close(); window.removeEventListener('offline', offline); root.replaceChildren(); };
}
