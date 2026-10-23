'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data = {tasks:[],jobs:[]}, filter = 'all', selected, inspectedId = null, renderedTaskId = null, lastSyncedAt = '', dockView = 'detail', dragging = false, launching = false, gesture = null, suppressClickUntil = 0;
const labels = {todo:'待办',doing:'进行中',blocked:'等待条件',done:'已完成',cancelled:'已取消',running:'执行中',starting:'正在启动',completed:'完成',waiting:'待处理',waiting_input:'待回答',waiting_approval:'待审批',idle:'准备中',failed:'失败',interrupted:'已停止',unknown:'状态未知',closed:'已关闭',interrupt_requested:'停止中'};
const runLabels = {completed:'运行结束',blocked:'需处理',recovery_required:'待核对'};
const connectionNotice = '暂时无法连接任务看板，恢复后会继续同步。', busyNotice = '已有任务运行中，请在运行记录查看进度，结束后再启动。';
const rendered = new Map();
const reconciling = new Set();
const pending = job => ['starting','running','waiting','recovery_required'].includes(job.state);
const recoveryNotice = '原运行还需要核对，请先重新核对再安排下一项。';
function html(id, value) { if (rendered.get(id) !== value) { $(id).innerHTML = value; rendered.set(id,value); } }
function isBusy() { return data.jobs.some(pending); }
function card(task) {
  const busy = isBusy();
  const status = task.eligible && task.status==='todo' ? '' : `<span class="status-badge ${esc(task.status)}">${esc(labels[task.status])}</span>`;
  const action = task.eligible ? `<button data-action="launch" aria-label="执行${esc(task.line)}" ${busy?'disabled title="当前已有任务运行中"':''}>执行…</button>` : '';
  return `<article class="card ${inspectedId===task.task_id?'selected':''}" data-id="${task.task_id}" data-draggable="${task.eligible&&!busy}" draggable="false" tabindex="0" aria-current="${inspectedId===task.task_id}" aria-label="${esc(task.line)}，${esc(labels[task.status])}，查看详情"><div class="task-main"><h3>${esc(task.line)}</h3><p class="next">${esc(task.next)}</p></div><div class="task-actions">${status}${action}</div></article>`;
}
function setDockView(view) {
  dockView = view === 'runs' ? 'runs' : 'detail';
  $('inspector').hidden = dockView !== 'detail';
  $('jobs').hidden = dockView !== 'runs';
  document.querySelectorAll('[data-dock-view]').forEach(button => {
    const active = button.dataset.dockView === dockView;
    button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active));
  });
}
function inspector(task) {
  if (!task) return '<div class="inspector-empty">没有可显示的任务。<span>调整筛选或搜索，查看任务详情。</span></div>';
  const rows = [['下一步',task.next,'detail-step'],['交付条件',task.acceptance,'detail-secondary']];
  const waiting = task.reason || task.dependency, waitingText = String(waiting ?? '').trim();
  if (!task.eligible&&!['done','cancelled','doing'].includes(task.status) && !(waitingText && waitingText===String(task.next ?? '').trim())) rows.push(['等待条件',waiting,'detail-secondary']);
  const background = String(task.title ?? '').trim();
  const context = (background && background!==String(task.line ?? '').trim() ? `<div class="detail-row"><strong>任务背景</strong><p>${esc(task.title)}</p></div>` : '') + (String(task.yesterday ?? '').trim() ? `<div class="detail-row"><strong>昨日记录</strong><p>${esc(task.yesterday)}</p></div>` : '');
  return `<div class="detail-body"><div class="detail-title"><h2>${esc(task.line)}</h2><span class="status-badge ${esc(task.status)}">${esc(labels[task.status])}</span></div>` + rows.map(([label,value,style])=>`<div class="detail-row ${style}"><strong>${label}</strong><p>${esc(value || '尚未补充')}</p></div>`).join('') + `<details class="task-context"><summary>背景与记录</summary><div class="inspector-meta"><span>任务 #${task.task_id}</span><span>原编号 ${esc(task.sources.join(' / '))}</span><span>负责人 ${esc(task.owner)}</span><span>优先级 ${esc({low:'低',medium:'普通',high:'高',urgent:'紧急'}[task.priority] || task.priority || '未设置')}</span></div>${context}<div class="detail-row"><strong>任务入口</strong><div class="entry">${esc(task.entry || '需本人确认入口')}</div></div></details></div>${task.eligible?'<div class="detail-actions"><span class="action-mode">'+(isBusy()?'当前已有任务运行中':'默认只读 · 启动前确认')+'</span><button class="primary" data-detail-launch="'+task.task_id+'" '+(isBusy()?'disabled':'')+'>执行…</button></div>':''}`;
}
function render() {
  const query = $('search').value.trim().toLowerCase();
  const number = /^#?\d+$/.test(query) ? Number(query.replace('#','')) : null;
  const queryMatches = data.tasks.filter(t => !query || (number!==null ? Number(t.task_id)===number || (t.sources||[]).some(source=>Number(source)===number) : [t.line,t.title,t.next].some(v=>String(v).toLowerCase().includes(query))));
  const tasks = queryMatches.filter(t => filter==='all'||(filter==='agent'?t.eligible:filter==='done'?['done','cancelled'].includes(t.status):!t.eligible&&!['done','cancelled','doing'].includes(t.status)));
  const ready = tasks.filter(t=>t.eligible).sort((a,b)=>Number(b.check_only)-Number(a.check_only));
  const waiting = tasks.filter(t=>!t.eligible&&!['done','cancelled','doing'].includes(t.status));
  const ended = tasks.filter(t=>['done','cancelled'].includes(t.status));
  const active = tasks.filter(t=>t.status==='doing'&&!t.eligible);
  const visible = [...active,...ready,...waiting,...ended];
  if (!visible.some(t=>t.task_id===inspectedId)) inspectedId=visible[0]?.task_id ?? null;
  $('task-panel').setAttribute('data-view',filter);
  html('active', active.map(card).join(''));
  html('ready', ready.map(card).join(''));
  html('waiting', waiting.map(card).join(''));
  html('finished', ended.map(card).join(''));
  $('active-group').hidden = !active.length;
  $('ready-group').hidden = !ready.length;
  $('waiting-group').hidden = !waiting.length;
  $('archive').hidden = !ended.length;
  if (filter==='done' || (query&&!ready.length&&!waiting.length&&!active.length&&ended.length)) $('archive').open = true;
  $('empty-list').hidden = Boolean(tasks.length);
  [['all-count',queryMatches.length],['agent-count',queryMatches.filter(t=>t.eligible).length],['human-count',queryMatches.filter(t=>!t.eligible&&!['done','cancelled','doing'].includes(t.status)).length],['ended-count',queryMatches.filter(t=>['done','cancelled'].includes(t.status)).length]].forEach(([id,count])=>$(id).textContent=count);
  const contextOpen = renderedTaskId===inspectedId && Boolean(document.querySelector('#inspector .task-context')?.open);
  html('inspector',inspector(data.tasks.find(t=>t.task_id===inspectedId)));
  const taskContext = document.querySelector('#inspector .task-context');
  if (taskContext) taskContext.open=contextOpen;
  renderedTaskId=inspectedId;
  const opened = [...document.querySelectorAll('.job details[open]')].map(e=>e.dataset.job);
  html('jobs', [...data.jobs].reverse().map(job => {
    const snap = job.snapshot || {}, leader = (snap.agents||[]).find(a=>!a.parentThreadId), native = snap.nativeTasks||[];
    const needsCheck = job.state === 'recovery_required';
    const canConfirmEnded = needsCheck && job.reconciliation_outcome === 'unresolved' && !job.can_stop;
    const live = ['starting','running','waiting'].includes(job.state) || (needsCheck && job.can_stop === true);
    const label = pending(job) && job.stop_requested ? (job.stop_confirmed ? '原运行已确认停止，等待任务状态回写。' : '停止请求已发送，等待原运行结束确认。') : job.label;
    const heading = `<div class="job-heading"><div class="job-title"><h3>${esc(job.title)}</h3><span class="status-badge ${esc(job.state)}">${esc(runLabels[job.state] || labels[job.state] || job.state)}</span></div><div class="job-meta"><time datetime="${esc(job.created_at)}">${esc(job.created_at.slice(5,10)+' '+job.created_at.slice(11,16))}</time><span>${job.access==='read-only'?'只读':'隔离修改'}</span></div></div>`;
    const summary = label?`<p class="label">${esc(label)}</p>`:'';
    const context = `${snap.agents?.length?'<div class="members">'+snap.agents.map(a=>`<div class="member"><span>${esc(a.name)}</span><span>${esc(labels[a.state]||a.state)}</span></div>`).join('')+'</div>':''}${native.length?'<div class="muted">负责人已验收 '+native.filter(t=>t.state==='accepted').length+' / '+native.length+' 项</div>':''}`;
    const error = snap.error?'<p class="error">'+esc(snap.error)+'</p>':'';
    const links = `<div class="job-links"><a href="${esc(job.crew_link)}" target="_blank" rel="noopener">Crew 工作台 ↗</a><a href="/api/receipt/${job.id}" target="_blank" rel="noopener">运行回执 ↗</a>${needsCheck?'<button data-reconcile="'+job.id+'"'+(reconciling.has(job.id)?' disabled':'')+'>重新核对</button>':''}${canConfirmEnded?'<button data-confirm-ended="'+job.id+'"'+(reconciling.has(job.id)?' disabled':'')+'>确认原运行已结束</button>':''}${live?'<button data-stop="'+job.id+'"'+(job.stop_requested?' disabled':'')+'>'+(job.stop_requested?(job.stop_confirmed?'已确认停止':'等待停止确认'):'停止运行')+'</button>':''}</div>`;
    return `<article class="job ${job.state==='blocked'?'blocked':''}">${heading}${summary}${error}${!pending(job)&&job.state!=='blocked'?`<details class="job-history" data-job="${job.id}" ${opened.includes(job.id)?'open':''}><summary>背景与回执</summary><div class="job-meta">任务 #${job.task_id}</div>${context}${leader?.output?`<div class="output">${esc(leader.output)}</div>`:''}${links}</details>`:`${context}${leader?.output?`<details data-job="${job.id}" ${opened.includes(job.id)?'open':''}><summary>查看执行结果</summary><div class="output">${esc(leader.output)}</div></details>`:''}${links}`}</article>`;
  }).join('') || '<div class="inspector-empty">还没有运行记录。<span>启动任务后，成员进度与结果会出现在这里。</span></div>');
  const busy = isBusy();
  $('dropzone').classList.toggle('busy',busy);
  $('dropzone').setAttribute('aria-disabled',String(busy));
  const current = data.jobs.find(pending);
  $('run-state').textContent = current ? (current.state==='recovery_required'?'待核对':current.state==='starting'?'启动中':current.state==='waiting'?'等待处理':'运行中') : '待命';
  $('run-state').classList.toggle('busy',busy);
  $('run-count').textContent = data.jobs.length;
  setDockView(dockView);
  $('crew-link').href = data.crew_url || '#';
}
function detail(task) {
  if (!task) return;
  inspectedId = task.task_id; setDockView('detail'); render();
}
function checkGoal() {
  return '只读核对清单.json和README.md，不执行其他项目任务。\n创建恰好两位原生成员，先crew_plan_tasks记录两项任务，spawn_agent后用返回的成员名称或真实线程ID调用crew_assign_task绑定。\n成员A仅负责清单.json：核对sources恰好覆盖1到20、无重复，18条唯一task_id，8/17和15/16合并，沿用190/215/216。\n成员B仅负责README.md：核对18行、20个来源编号、状态与JSON一致；区分昨日阶段完成与当前下一步，保留化学取消、LLM主实验暂停，拟执行不代表已派发。\n两位成员只读、引用实际文件、不得递归委派；你读取指定文件复核成员结果，随后调用crew_review_task分别接受或指出缺口。最终给出真实成员、绑定和验收结果。\n只读取上述两个文件，不读取数据库、客户材料或其他目录；不得写文件、联网或申请扩大权限。';
}
function launch(task) {
  if (!task?.eligible) { if(task)detail(task); return; }
  if (isBusy()) { if (!$('notice').textContent || [busyNotice,recoveryNotice].includes($('notice').textContent)) $('notice').textContent=data.jobs.some(j=>j.state==='recovery_required')?recoveryNotice:busyNotice; return; }
  selected = task;
  $('launch-title').textContent = task.line;
  $('launch-next').textContent = task.next;
  $('launch-acceptance').textContent = task.acceptance;
  $('launch-instructions').open = false;
  $('goal').value = task.check_only ? checkGoal() : `任务 #${task.task_id}：${task.title}\n本次目标：${task.next}\n交付条件：${task.acceptance}\n入口：${task.entry || task.cwd}\n只读模式先核对本地现状，引用实际文件，给出完成项、缺口和可执行的下一步；隔离修改模式只实现上述本地范围并完成适当检查。需要本人操作的验收保留给本人。`;
  document.querySelector('input[value="read-only"]').checked=true;
  document.querySelector('input[value="workspace-write"]').disabled=task.check_only;
  $('launch-path').textContent = '执行目录：'+task.cwd+' · 本次执行器：Codex 团队';
  $('launch-error').textContent='';
  $('start').disabled=false;
  $('launch').showModal();
}
async function post(path, payload) {
  const res = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','x-corpus':'1'},body:JSON.stringify(payload)});
  const result = await res.json(); if(!res.ok)throw new Error(result.error||'操作未完成'); return result;
}
async function refresh() {
  try {
    const res=await fetch('/api/board'); if(!res.ok)throw new Error(); data=await res.json();
    $('connection-text').textContent='本地已连接'; $('connection').classList.remove('disconnected');
    lastSyncedAt=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    $('synced').textContent='已同步 · '+lastSyncedAt;
    if ($('notice').textContent===connectionNotice || ([busyNotice,recoveryNotice].includes($('notice').textContent)&&!isBusy())) $('notice').textContent='';
    if (inspectedId===null) inspectedId=(data.tasks.find(t=>t.eligible)||data.tasks[0])?.task_id ?? null;
    if(!dragging)render();
  }
  catch { $('connection-text').textContent='连接中断'; $('connection').classList.add('disconnected'); $('synced').textContent='连接中断 · '+(lastSyncedAt?'上次同步 '+lastSyncedAt:'尚未同步'); if (['',connectionNotice,busyNotice,recoveryNotice].includes($('notice').textContent)) $('notice').textContent=connectionNotice; }
}
document.addEventListener('click',event=>{
  if (Date.now() < suppressClickUntil) return;
  const filterButton=event.target.closest('[data-filter]');
  if (filterButton) { filter=filterButton.dataset.filter; document.querySelectorAll('.tab').forEach(tab=>{const active=tab===filterButton;tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active));}); render(); return; }
  const dockButton=event.target.closest('[data-dock-view]'); if(dockButton){setDockView(dockButton.dataset.dockView);return;}
  const action=event.target.closest('[data-action]');
  if(action) { const task=data.tasks.find(t=>t.task_id===Number(action.closest('.card').dataset.id)); action.dataset.action==='launch'?launch(task):detail(task); return; }
  const cardEl=event.target.closest('.card');
  if(cardEl) { detail(data.tasks.find(t=>t.task_id===Number(cardEl.dataset.id))); return; }
  const closer=event.target.closest('[data-close]'); if(closer)$(closer.dataset.close).close();
  const taskLaunch=event.target.closest('[data-detail-launch]'); if(taskLaunch){launch(data.tasks.find(t=>t.task_id===Number(taskLaunch.dataset.detailLaunch)));}
  const check=event.target.closest('[data-reconcile]');
  const confirmEnded=event.target.closest('[data-confirm-ended]');
  if(check || confirmEnded) {
    const button=check || confirmEnded, id=check?check.dataset.reconcile:confirmEnded.dataset.confirmEnded;
    if(reconciling.has(id))return;
    if(confirmEnded) {
      const job=data.jobs.find(job=>job.id===id);
      if(job?.state!=='recovery_required' || job.reconciliation_outcome!=='unresolved' || job.can_stop)return;
      if(!confirm('确认原运行已结束？此操作将记为“用户确认结束，未经 Crew 证实”，任务转为需处理（blocked），保留成果和回执，不自动验收，也不合并隔离成果。'))return;
    }
    reconciling.add(id); button.disabled=true;
    post('/api/reconcile',{job_id:id,...(confirmEnded?{confirm_ended:true}:{})}).then(result=>{
      $('notice').textContent=result.job?.user_confirmed_ended?result.job.label:result.outcome==='live'?'原运行仍在执行，可停止原运行或再次核对。':result.outcome==='finished'?'原运行已核对结束，成果和历史已保留。':result.job?.label || '原运行仍待核对，请检查连接后重试。';
      return refresh();
    }).catch(e=>{$('notice').textContent=e.message;}).finally(()=>{reconciling.delete(id);button.disabled=false;render();});
    return;
  }
  const stop=event.target.closest('[data-stop]'); if(stop){stop.disabled=true;post('/api/stop',{job_id:stop.dataset.stop}).then(result=>{$('notice').textContent=result.stopped?'原运行已确认结束，成果和历史已保留。':'已请求停止，等待结束确认。';return refresh();}).catch(e=>{$('notice').textContent=e.message;stop.disabled=false;});}
});
document.addEventListener('keydown',event=>{
  if (!['Enter',' '].includes(event.key) || event.target.closest('button,a,input,textarea')) return;
  const cardEl=event.target.closest('.card'); if(cardEl){event.preventDefault();const taskId=Number(cardEl.dataset.id);detail(data.tasks.find(t=>t.task_id===taskId));document.querySelector(`.card[data-id="${taskId}"]`)?.focus();}
});
document.addEventListener('pointerdown', event => {
  if (event.pointerType==='touch' || event.button !== 0 || event.target.closest('button,a')) return;
  const cardEl = event.target.closest('.card[data-draggable="true"]');
  if (!cardEl) return;
  gesture = {card:cardEl, id:event.pointerId, x:event.clientX, y:event.clientY, started:false, ghost:null};
  cardEl.setPointerCapture(event.pointerId);
});
function insideDrop(x,y) { const r=$('dropzone').getBoundingClientRect(); return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; }
document.addEventListener('pointermove', event => {
  if (!gesture || gesture.id !== event.pointerId) return;
  if (!gesture.started && Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)<8) return;
  event.preventDefault();
  if (!gesture.started) {
    gesture.started=true; dragging=true; gesture.card.classList.add('dragging');
    gesture.ghost=document.createElement('div'); gesture.ghost.className='drag-ghost';
    gesture.ghost.textContent=data.tasks.find(t=>t.task_id===Number(gesture.card.dataset.id)).line;
    document.body.appendChild(gesture.ghost);
  }
  gesture.ghost.style.left=(event.clientX+14)+'px'; gesture.ghost.style.top=(event.clientY+14)+'px';
  $('dropzone').classList.toggle('over',insideDrop(event.clientX,event.clientY));
});
function finishGesture(event,cancelled=false) {
  if (!gesture || gesture.id !== event.pointerId) return;
  const current=gesture; gesture=null; dragging=false;
  current.card.classList.remove('dragging'); current.ghost?.remove(); $('dropzone').classList.remove('over');
  if (current.started) { suppressClickUntil=Date.now()+200; if(!cancelled&&insideDrop(event.clientX,event.clientY))launch(data.tasks.find(t=>t.task_id===Number(current.card.dataset.id))); }
}
document.addEventListener('pointerup',event=>finishGesture(event));
document.addEventListener('pointercancel',event=>finishGesture(event,true));
$('launch-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(launching)return; launching=true; $('start').disabled=true; $('launch-error').textContent='';
  try { await post('/api/dispatch',{task_id:selected.task_id,access:new FormData(event.target).get('access'),goal:$('goal').value}); $('launch').close();$('notice').textContent='';setDockView('runs');await refresh(); }
  catch(error){$('launch-error').textContent=error.message;}
  finally{launching=false;$('start').disabled=false;}
});
$('goal').addEventListener('invalid',()=>{ $('launch-instructions').open=true; });
document.addEventListener('dragstart',event=>{
  const cardEl=event.target.closest('.card[draggable=true]'); if(!cardEl)return;
  dragging=true;event.dataTransfer.setData('text/plain',cardEl.dataset.id);event.dataTransfer.effectAllowed='move';cardEl.classList.add('dragging');
});
document.addEventListener('dragend',()=>{dragging=false;document.querySelectorAll('.dragging').forEach(e=>e.classList.remove('dragging'));$('dropzone').classList.remove('over');});
$('dropzone').addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';$('dropzone').classList.add('over');});
$('dropzone').addEventListener('dragleave',event=>{if(!$('dropzone').contains(event.relatedTarget))$('dropzone').classList.remove('over');});
$('dropzone').addEventListener('drop',event=>{event.preventDefault();dragging=false;$('dropzone').classList.remove('over');launch(data.tasks.find(t=>t.task_id===Number(event.dataTransfer.getData('text/plain'))));});
$('search').addEventListener('input',render);
refresh();setInterval(refresh,3000);
