// Working Corpus 前端。不需要构建，直接由本地服务器提供。
// 所有来自对话记录的文字都经过 esc() 转义，对话内容不可信。
import { mountTeam } from './team.js';
import { mountTeamDock } from './team-dock.js';
import { mountWorkspace } from './workspace.js';
import { mountSecurity } from './security.js';
import { mountToday } from './today.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS = { pending_confirm: '待确认', todo: '待开始', doing: '进行中', to_verify: '待验证', done: '已完成', blocked: '受阻', cancelled: '已取消' };
const ORDER = ['to_verify', 'blocked', 'doing', 'todo', 'pending_confirm', 'done'];
const BASIS = { user: '用户确认', text: '原文明确', ai: 'AI 自述', manual: '你改的' };
const KIND = { plan_item: '规划', plan_add: '规划新增', plan_cancel: '取消', started: '开始执行', ai_claims_done: 'AI 称完成', user_confirms_done: '你确认完成', failure: '失败', blocked: '受阻', unblocked: '解除阻塞', decision_adopt: '采用', decision_reject: '否决', out_of_scope: '范围外' };
const COLOR = { done: 'var(--done)', doing: 'var(--doing)', to_verify: 'var(--verify)', todo: 'var(--todo)', blocked: 'var(--block)' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知');
const short = (id) => String(id).split('/').pop();
const chip = (s) => `<span class="chip c-${s}">${STATUS[s]}</span>`;
const basis = (b) => `<span class="basis b-${b}">${BASIS[b]}</span>`;
const evLink = (id, text = '依据') => (id ? `<button class="link" data-act="ev" data-ev="${esc(id)}">${text}</button>` : '');

let app = { projects: [], model: '', lastSyncAt: null, pid: null, lastPid: null, data: null };
let unmountTeam = null;
let unmountDock = null;
let unmountWorkspace = null;
let unmountSecurity = null;
let unmountToday = null;
let loadVersion = 0;
const later = new Set(JSON.parse(sessionStorage.getItem('later') || '[]'));

// 在线演示（GitHub Pages）没有本地服务：构建时把接口结果导成 JSON，这里按路径读；改动一律拒绝
const STATIC = document.querySelector('meta[name="corpus-static"]') !== null;
const READ_ONLY = '这是只读演示。装到本机后可以修改、同步和导入。';

async function staticApi(path, method) {
  const u = new URL(path, location.origin);
  const p = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', 'projects', id, ...]
  if (method !== 'GET') {
    if (p[1] === 'read' || p[3] === 'usage') return {}; // 打开页面时的读取和使用记录，演示里静默跳过
    throw new Error(READ_ONLY);
  }
  const get = async (file) => {
    const res = await fetch(`data/${file}`);
    if (!res.ok) throw new Error('演示数据缺失');
    return res.json();
  };
  if (p[1] === 'state' || p[1] === 'sources') return get(`${p[1]}.json`);
  const base = `p/${p[2]}`;
  if (p.length === 3) return get(`${base}.json`);
  if (p[3] === 'messages') {
    const ids = new Set((u.searchParams.get('ids') ?? '').split(','));
    return (await get(`${base}.messages.json`)).filter((m) => ids.has(m.id));
  }
  if (p[3] === 'context') return { text: (await get(`${base}.context.json`))[u.searchParams.get('task')] ?? '' };
  if (p[3] === 'usage') return {};
  throw new Error(READ_ONLY);
}

async function api(path, opts = {}) {
  if (STATIC) return staticApi(path, opts.method ?? 'GET');
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'x-corpus': '1', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: '返回内容无法解析' }));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  return data;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

const correct = async (body, msg) => {
  await api(`/api/projects/${app.pid}/corrections`, { method: 'POST', body });
  toast(msg);
  await load();
};

// ---------- 路由 ----------
function parseHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'p' && p[1]) return { page: p[2] || 'overview', pid: p[1], arg: p[3] };
  return { page: p[0] || 'home' };
}

// 今日页和全局安全页（路由里没带项目）不选项目；其余页面没带项目时回退到当前项目或第一个。
function routeProject(r, current, projects) {
  if (r.page === 'today' || (r.page === 'security' && !r.pid)) return null;
  return r.pid ?? current ?? projects[0]?.id ?? null;
}

async function load() {
  const version = ++loadVersion;
  unmountToday?.(); unmountToday = null;
  unmountSecurity?.(); unmountSecurity = null;
  unmountDock?.(); unmountDock = null;
  unmountTeam?.();
  unmountTeam = null;
  unmountWorkspace?.();
  unmountWorkspace = null;
  const s = await api('/api/state');
  if (version !== loadVersion) return;
  Object.assign(app, s);
  const r = parseHash();
  if (r.page === 'home' && app.projects.length) {
    let lastProject;
    try { if (!STATIC) lastProject = localStorage.getItem('crew:last-project'); } catch {}
    const target = app.projects.find(project => project.id === lastProject) || app.projects[0];
    location.hash = `#/p/${target.id}${STATIC ? '' : '/workspace'}`; return;
  }
  const pid = routeProject(r, app.lastPid ?? app.pid, app.projects); // 今日页、全局安全页不选项目，但记住刚才用的那个
  const data = pid && app.projects.some((p) => p.id === pid) ? await api(`/api/projects/${pid}`) : null;
  if (version !== loadVersion) return;
  app.pid = pid;
  if (pid) app.lastPid = pid;
  app.data = data;
  if (!STATIC && r.page === 'workspace' && data) { try { localStorage.setItem('crew:last-project', pid); } catch {} }
  renderNav(r);
  const main = $('#main');
  if (r.page === 'today') {
    main.innerHTML = '<div id="crew-today"></div>';
    unmountToday = mountToday($('#crew-today'), { api, staticDemo: STATIC });
  }
  else if (r.page === 'security') {
    main.innerHTML = '<div id="crew-security"></div>';
    unmountSecurity = mountSecurity($('#crew-security'), {projectId:r.pid, projectName:r.pid ? data?.project.name : undefined, api, staticDemo:STATIC});
  }
  else if (!app.projects.length || r.page === 'new') main.innerHTML = renderWelcome();
  else if (r.page === 'settings') {
    const html = await renderSettings();
    if (version !== loadVersion) return;
    main.innerHTML = html;
  }
  else if (!app.data) main.innerHTML = `<div class="empty">项目不存在，可能已被删除。<a href="#/">回到首页</a></div>`;
  else if (r.page === 'workspace') {
    if (STATIC) main.innerHTML = `${header('workspace')}<div class="empty">Crew 终端工作台需要本地运行。当前是只读演示。</div>`;
    else {
      main.innerHTML = '<div id="crew-workspace"></div>';
      unmountWorkspace = mountWorkspace($('#crew-workspace'), { projectId: app.pid, projectName: app.data.project.name, dirs: app.data.project.dirs, api, toast });
    }
  }
  else if (r.page === 'team') {
    if (STATIC) main.innerHTML = `${header('team')}<div class="empty">团队工作台需要本机 Bridge。当前为只读演示，不能启动 Agent。</div>`;
    else {
      main.innerHTML = '<div id="team-workbench"></div>';
      const cleanup = await mountTeam($('#team-workbench'), { projectId: app.pid, projectName: app.data.project.name, dirs: app.data.project.dirs, api, toast });
      if (version !== loadVersion) cleanup?.();
      else unmountTeam = cleanup;
    }
  }
  else if (r.page === 'task') main.innerHTML = renderTask(r.arg);
  else if (r.page === 'plan') main.innerHTML = renderPlan();
  else if (r.page === 'inbox') main.innerHTML = renderInbox();
  else main.innerHTML = renderOverview();
  const dock = document.getElementById('crew-team-dock');
  dock.hidden = STATIC || !data || r.page === 'today'; document.body.classList.toggle('crew-has-team-dock', !dock.hidden);
  if (!dock.hidden) unmountDock = mountTeamDock(dock, { projectId: pid, api, toast });
  drawBand();
}

function renderNav(r) {
  const pending = app.data?.view.pending.length ?? 0;
  $('#nav').innerHTML = `
    <div class="brand"><img src="logo.svg" alt="" width="22" height="22" style="image-rendering:pixelated">Crew</div>
    <a href="#/today" class="${r.page === 'today' ? 'on' : ''}">今日安排</a>
    <div class="grp">项目</div>
    ${!STATIC ? '<input class="crew-project-search" type="search" aria-label="搜索项目" placeholder="搜索项目…">' : ''}
    <div class="crew-project-list">${app.projects.map((p) => `<a href="#/p/${esc(p.id)}${STATIC ? '' : '/workspace'}" class="${p.id === app.pid && !['settings','new'].includes(r.page) ? 'on' : ''}">${esc(p.name)}${p.pending ? `<span class="cnt">${p.pending}</span>` : ''}</a>`).join('')}</div>
    ${!STATIC ? '<a href="#/new">＋ 打开项目</a>' : ''}
    <div class="grp">工作区</div>
    ${app.pid && !STATIC ? `<a href="#/p/${esc(app.pid)}/workspace" class="${r.page === 'workspace' ? 'on' : ''}">终端工作台<span class="cnt">LOCAL</span></a>
    <a href="#/p/${esc(app.pid)}/team" class="${r.page === 'team' ? 'on' : ''}">团队</a>` : ''}
    ${app.pid ? `<a href="#/p/${esc(app.pid)}" class="${r.page === 'overview' ? 'on' : ''}">项目记忆</a>` : ''}
    ${app.pid ? `<a href="#/p/${esc(app.pid)}/inbox" class="${r.page === 'inbox' ? 'on' : ''}">待确认 ${pending ? `<span class="cnt hot">${pending}</span>` : '<span class="cnt">0</span>'}</a>` : ''}
    <a href="#/security" class="${r.page === 'security' && !r.pid ? 'on' : ''}">凭证与安全</a>
    ${app.pid ? `<a href="#/p/${esc(app.pid)}/security" class="${r.page === 'security' && r.pid ? 'on' : ''}">项目凭证与安全</a>` : ''}
    <a href="#/settings" class="${r.page === 'settings' ? 'on' : ''}">接入设置</a>
    ${app.pid ? `<div class="foot">整理模型：${esc(app.model)}<br>上次同步：${app.lastSyncAt ? fmt(app.lastSyncAt) : '本次打开后还没同步'}</div>` : ''}`;
  const projectSearch = $('#nav .crew-project-search');
  if (projectSearch) projectSearch.oninput = () => {
    const query = projectSearch.value.trim().toLocaleLowerCase();
    $('#nav').querySelectorAll('.crew-project-list a').forEach(link => { link.hidden = !link.textContent.toLocaleLowerCase().includes(query); });
  };
}

function header(active) {
  const { project } = app.data;
  const pending = app.data.view.pending.length;
  return `
    <div class="head">
      <div><h1>${esc(project.name)}</h1><div class="sub">${esc(project.dirs.join('，') || '没有绑定目录')}</div></div>
      <div class="row"><span class="s">${app.lastSyncAt ? `上次同步 ${fmt(app.lastSyncAt)}` : ''}</span><button class="btn pri" data-act="sync">同步</button></div>
    </div>
    <nav class="tabs">
      ${!STATIC ? `<a href="#/p/${esc(app.pid)}/workspace" class="${active === 'workspace' ? 'on' : ''}">终端</a>` : ''}
      <a href="#/p/${esc(app.pid)}" class="${active === 'overview' ? 'on' : ''}">概览</a>
      <a href="#/p/${esc(app.pid)}/plan" class="${active === 'plan' ? 'on' : ''}">规划${app.data.view.plan.noPlan ? '' : ` 第 ${app.data.view.plan.versions.length} 版`}</a>
      <a href="#/p/${esc(app.pid)}/inbox" class="${active === 'inbox' ? 'on' : ''}">待确认 ${pending}</a>
      ${!STATIC ? `<a href="#/p/${esc(app.pid)}/team" class="${active === 'team' ? 'on' : ''}">团队</a>` : ''}
    </nav>`;
}

function banners() {
  const { view, failed, sessions, unextracted } = app.data;
  const out = [];
  if (unextracted > 0) out.push(`<div class="banner" style="border-color:var(--accent);color:var(--accent);background:var(--accent-soft)">有 ${unextracted} 条新消息还没整理。<button class="link" data-act="sync">现在整理</button></div>`);
  if (view.coverageWarning) out.push(`<div class="banner">有来源只读到一部分对话，下面的结论只基于已读到的内容。</div>`);
  if (failed.length) out.push(`<div class="banner err">有 ${failed.length} 批对话整理失败：${esc(failed[0].error)}。<button class="link" data-act="sync">重新整理</button></div>`);
  if (!sessions.length) out.push(`<div class="banner">这个项目还没有读到任何对话。确认绑定的目录里用过 Claude Code 或 Codex，然后点“同步”；网页 AI 的对话可以在<a href="#/settings">接入设置</a>里粘贴导入。</div>`);
  return out.join('');
}

// ---------- 概览 ----------
function renderOverview() {
  const { project, view, sessions } = app.data;
  const plan = view.plan.versions.at(-1);
  const last = view.lastPosition;
  const byStatus = (s) => view.tasks.filter((t) => t.status === s);
  const needs = [...byStatus('to_verify'), ...byStatus('blocked')];
  const active = view.tasks.filter((t) => t.status !== 'cancelled').sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const cancelled = byStatus('cancelled');
  const total = active.length || 1;
  const sessionLabels = (t) => {
    const n = {};
    t.sessions.forEach((sid) => { const s = sessions.find((x) => x.id === sid); if (s) n[s.label] = (n[s.label] || 0) + 1; });
    return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(' · ');
  };
  const next = view.next.filter((n) => !later.has(n.key));
  const today = new Date().toDateString();
  const doneToday = view.doneEvents.filter((d) => new Date(d.at).toDateString() === today).length;

  return `${header('overview')}${bandHtml()}<div class="stack">${banners()}
    <div class="grid2">
      <div class="blk"><div class="blk-t">当前目标</div>
        <div class="big">${esc(project.goal || '还没填写项目目标')}</div>
        <div class="row" style="margin-top:8px">${plan ? `<span class="s">当前规划 第 ${plan.n} 版${plan.backfilled ? '（后补）' : ''} · ${fmt(plan.at)}</span><a class="link" href="#/p/${esc(app.pid)}/plan">${view.plan.versions.length > 1 ? '对比第 1 版' : '查看规划'}</a>` : `<span class="s">已读取的记录里没有明确规划</span><a class="link" href="#/p/${esc(app.pid)}/plan">补建当前规划</a>`}</div>
      </div>
      <div class="blk"><div class="blk-t">上次停在</div>
        ${last ? `<div class="s">${fmt(last.at)} · ${esc(last.label)}${last.title ? `「${esc(last.title)}」` : ''}${last.taskId ? ` · ${esc(view.tasks.find((t) => t.id === last.taskId)?.name ?? '')}` : ''}</div><div class="q" style="margin-top:6px">${esc(last.text)}</div>` : '<div class="muted">还没有读到对话</div>'}
      </div>
    </div>
    <div class="blk"><div class="blk-t">需要你处理</div>
      ${needs.length ? needs.map((t) => `<div class="line">${chip(t.status)}<div><b>${esc(t.name)}</b> · ${esc(t.status === 'blocked' ? `缺：${t.blocker ?? '原因未说明'}` : t.basisNote)} ${basis(t.basis)} ${evLink(t.basisEvidenceId)}</div>
        <div class="row">${t.status === 'to_verify' ? `<button class="btn" data-act="confirm-done" data-task="${esc(t.id)}">确认完成</button>` : `<button class="btn" data-act="unblock" data-task="${esc(t.id)}">已解决</button>`}<button class="btn" data-act="cont" data-task="${esc(t.id)}">继续</button></div></div>`).join('') : '<div class="muted">没有待验证或受阻的任务</div>'}
    </div>
    <div class="blk"><div class="blk-t">下一步 <span class="r s">最多 3 条</span></div>
      ${next.length ? next.map((n, i) => `<div class="next"><span class="no">${i + 1}</span><div><b>${esc(n.action)}</b><div class="s">${n.precondition && n.precondition !== '无' ? `前置条件：${esc(n.precondition)} · ` : ''}完成标准：${esc(n.doneStandard)} · 原因：${esc(n.reason)} ${evLink(n.evidenceId)}</div></div>
        <div class="row"><button class="btn" data-act="next-accept" data-task="${esc(n.taskId)}">采纳</button><button class="btn" data-act="next-later" data-key="${esc(n.key)}">暂缓</button><button class="btn" data-act="next-dismiss" data-key="${esc(n.key)}">驳回</button></div></div>`).join('') : '<div class="muted">暂时没有可推荐的下一步</div>'}
      ${view.ideas.length ? `<div class="s" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule)">范围外想法 ${view.ideas.length} 条，不会自动变成待办：${view.ideas.slice(-3).map((x) => esc(x.text)).join('；')}</div>` : ''}
    </div>
    <div class="blk"><div class="blk-t">任务 · 当前 ${active.length} 项 <span class="r s">今日完成 ${doneToday} · 已取消 ${cancelled.length} 项单列</span></div>
      <div class="bar" aria-hidden="true">${['done', 'doing', 'to_verify', 'todo', 'blocked'].filter((s) => byStatus(s).length).map((s) => `<i style="flex:${byStatus(s).length};background:${COLOR[s]}"></i>`).join('')}</div>
      <div class="s">${['done', 'doing', 'to_verify', 'todo', 'blocked'].map((s) => `${STATUS[s]} ${byStatus(s).length}`).join(' · ')}。不显示项目百分比。</div>
      ${active.map((t) => `<div class="task" data-act="goto" data-href="#/p/${esc(app.pid)}/task/${esc(short(t.id))}">${chip(t.status)}<span class="nm">${esc(t.name)}</span><span class="s src">${esc(sessionLabels(t) || '')}</span><span>${t.status === 'done' || t.status === 'cancelled' ? basis(t.basis) : `<button class="link" data-act="cont" data-task="${esc(t.id)}">继续</button>`}</span></div>`).join('') || '<div class="muted" style="padding-top:8px">还没有任务。同步之后，任务会从对话里整理出来。</div>'}
      ${cancelled.length ? `<div class="sep">已取消</div>${cancelled.map((t) => `<div class="task" data-act="goto" data-href="#/p/${esc(app.pid)}/task/${esc(short(t.id))}">${chip(t.status)}<span class="muted">${esc(t.name)}</span><span class="s src">${esc(t.basisNote)}</span><span></span></div>`).join('')}` : ''}
    </div>
    ${view.decisions.length ? `<div class="blk"><div class="blk-t">最近决定</div>${view.decisions.slice(-6).reverse().map((d) => `<div class="row" style="padding:3px 0${d.supersededBy ? ';color:var(--ink-3)' : ''}"><span style="${d.supersededBy ? 'text-decoration:line-through' : ''}">${fmt(d.at)} ${d.kind === 'adopt' ? '采用' : d.kind === 'reject' ? '否决' : '取消'}：${esc(d.text)}。原因：${esc(d.reason ?? '原文未说明')}</span>${d.supersededBy ? `<span class="basis b-ai">已被替代</span>${evLink(d.supersededBy, '新决定')}` : ''}${evLink(d.evidenceId)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- 语料带 ----------
const BAND_STATUS = ['done', 'to_verify', 'doing', 'todo', 'blocked', 'cancelled'];
function bandHtml() {
  const band = app.data.band ?? [];
  if (!band.length) return '';
  const linked = band.filter((b) => b.status).length;
  return `<div class="band"><div class="blk-t">语料带 · ${band.length} 条消息，${linked} 条已经变成任务证据<span class="r s">每个方块是一条消息，颜色是它支撑的任务的状态</span></div>
    <canvas id="band" aria-label="语料带：${band.length} 条消息，其中 ${linked} 条是任务证据"></canvas>
    <div class="band-legend">${BAND_STATUS.map((st) => `<span><i style="background:var(--${st === 'to_verify' ? 'verify' : st === 'blocked' ? 'block' : st === 'cancelled' ? 'cancel' : st})"></i>${STATUS[st]}</span>`).join('')}<span><i style="background:var(--rule-2)"></i>没有归入任务</span></div></div>`;
}

let bandFrame = 0;
function drawBand() {
  cancelAnimationFrame(bandFrame);
  const canvas = document.getElementById('band');
  const band = app.data?.band ?? [];
  if (!canvas || !band.length) return;
  const css = getComputedStyle(document.documentElement);
  const color = (st) => css.getPropertyValue(`--${{ to_verify: 'verify', blocked: 'block', cancelled: 'cancel' }[st] ?? st ?? 'idle'}`).trim();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // 一整片像素格铺满宽度：消息从左往右按列填，没填到的格子是很淡的底色；放不下时缩小格子
  const GAP = 2;
  let size = 8, rows = 0, cols = 0;
  for (; size >= 3; size--) {
    rows = Math.max(1, Math.floor((h + GAP) / (size + GAP)));
    cols = Math.max(1, Math.floor((w + GAP) / (size + GAP)));
    if (rows * cols >= band.length) break;
  }
  const total = rows * cols;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const idle = color(null);
  const paint = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < total; i++) {
      const col = Math.floor(i / rows), row = i % rows;
      const b = band[i];
      if (!b) { ctx.globalAlpha = 0.45; ctx.fillStyle = idle; }
      else {
        const wave = still || !b.status ? 1 : 0.72 + 0.28 * Math.sin(t / 900 - col * 0.18);
        ctx.globalAlpha = b.status ? wave : b.role === 'user' ? 1 : 0.8;
        ctx.fillStyle = b.status ? color(b.status) : css.getPropertyValue('--rule-2').trim();
      }
      ctx.fillRect(col * (size + GAP), row * (size + GAP), size, size);
    }
    ctx.globalAlpha = 1;
    if (!still) bandFrame = requestAnimationFrame(paint);
  };
  paint(0);
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left) / (size + GAP)), row = Math.floor((e.clientY - r.top) / (size + GAP));
    const b = row < rows ? band[col * rows + row] : undefined;
    canvas.title = b ? `${fmt(b.at)} · ${b.role === 'user' ? '你' : b.role === 'assistant' ? 'AI' : '工具报错'}${b.task ? ` · ${b.task} · ${STATUS[b.status]}` : ' · 没有归入任务'}` : '';
  };
}
window.addEventListener('resize', () => drawBand());

// ---------- 任务详情 ----------
function renderTask(shortId) {
  const { view, sessions, allTasks } = app.data;
  const t = view.tasks.find((x) => short(x.id) === shortId);
  if (!t) return `${header('')}<div class="empty">这个任务不存在或已被合并。<a href="#/p/${esc(app.pid)}">回到概览</a></div>`;
  const others = view.tasks.filter((x) => x.id !== t.id);
  return `${header('')}<div class="stack">
    <div class="row">${chip(t.status)}<h2 style="margin:0;font-size:20px">${esc(t.name)}</h2><span class="s">任务 ${esc(short(t.id))}</span></div>
    <div class="row"><button class="btn pri" data-act="cont" data-task="${esc(t.id)}">继续任务</button>${t.status !== 'done' && t.status !== 'cancelled' ? `<button class="btn" data-act="confirm-done" data-task="${esc(t.id)}">确认完成</button>` : ''}</div>
    <div class="grid2">
      <div class="stack">
        <div class="blk"><div class="blk-t">目标与完成条件</div>
          <div>目标：${esc(t.goal ?? t.name)}</div>
          <div style="margin-top:6px">完成条件：${t.doneCondition ? `${esc(t.doneCondition)} ${t.doneConditionConfirmed ? basis('user') : ''}` : '<span class="muted">还没确认</span>'}</div>
          <div class="row" style="margin-top:8px"><input type="text" id="cond" placeholder="比如：文件能打开，金额和统计页一致" value="${esc(t.doneCondition ?? '')}" style="flex:1;min-width:200px"><button class="btn" data-act="condition" data-task="${esc(t.id)}">确认为完成条件</button></div>
        </div>
        <div class="blk"><div class="blk-t">证据 · ${t.evidenceIds.length} 条<span class="r s">勾选后可以拆成新任务</span></div>
          ${t.evidenceIds.map((id) => { const e = app.data.evidence[id]; return e ? `<label class="check" style="padding:5px 0;border-top:1px solid var(--rule)"><input type="checkbox" class="sp" value="${esc(id)}"><span class="s" style="min-width:74px">${esc(KIND[e.kind] ?? e.kind)}</span><span>${esc(e.detail)}</span>${evLink(id)}</label>` : ''; }).join('')}
          <div class="row" style="margin-top:10px"><input type="text" id="sp-name" placeholder="新任务名称"><button class="btn" data-act="split" data-task="${esc(t.id)}">拆成新任务</button></div>
        </div>
        <div class="blk"><div class="blk-t">状态变化</div>
          ${t.history.map((h) => `<div class="hist"><span class="s">${fmt(h.at)}</span><span class="row">${h.from ? chip(h.from) : ''}${chip(h.to)}</span><span>${esc(h.note)} ${basis(h.basis)} ${evLink(h.evidenceId)}</span></div>`).join('')}
          <div class="s" style="margin-top:8px">完成事件 ${view.doneEvents.filter((d) => d.taskId === t.id).length} 次。AI 自述不计为完成，重开不新增任务。</div>
        </div>
      </div>
      <div class="stack" style="align-content:start">
        <div class="blk"><div class="blk-t">现在的依据</div><div>${esc(t.basisNote)} ${basis(t.basis)} ${evLink(t.basisEvidenceId)}</div>${t.blocker ? `<div style="margin-top:6px">阻塞：${esc(t.blocker)}</div>` : ''}</div>
        <div class="blk"><div class="blk-t">跨会话进展</div>${t.sessions.map((sid) => { const s = sessions.find((x) => x.id === sid); return s ? `<div><span class="s">${esc(s.label)}</span> ${esc(s.title ?? '')}</div>` : ''; }).join('') || '<span class="muted">无</span>'}</div>
        ${hintsHtml(app.data.hints?.[t.id])}
        <div class="blk"><div class="blk-t">修改</div>
          <div class="row"><select id="st">${Object.keys(STATUS).filter((s) => s !== 'pending_confirm').map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select><button class="btn" data-act="status" data-task="${esc(t.id)}">改状态</button></div>
          <div class="row" style="margin-top:8px"><input type="text" id="nm" value="${esc(t.name)}"><button class="btn" data-act="rename" data-task="${esc(t.id)}">改名</button></div>
          ${others.length ? `<div class="row" style="margin-top:8px"><select id="into">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select><button class="btn" data-act="merge" data-task="${esc(t.id)}">合并到这个任务</button></div>` : ''}
          ${app.projects.length > 1 ? `<div class="row" style="margin-top:8px"><select id="mv-to">${app.projects.filter((p) => p.id !== app.pid).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="btn" data-act="move-task" data-task="${esc(t.id)}">移到这个项目</button></div>` : ''}
          <div class="s" style="margin-top:8px">你的修改会被保存，之后的自动整理不会悄悄覆盖；有冲突时会进待确认。</div>
        </div>
      </div>
    </div></div>`;
}

function hintsHtml(h) {
  if (!h || !(h.files.length + h.commits.length + h.links.length)) return '<div class="blk"><div class="blk-t">结果线索</div><span class="muted">引用的消息里没有提到文件、提交或链接</span></div>';
  const safe = (u) => (/^https?:\/\//.test(u) ? u : '#'); // 只放 http 和 https，挡住 javascript: 这类链接
  const group = (label, items, fmtItem) => (items.length ? `<div style="margin-top:6px"><span class="s">${label}</span><div class="stack" style="gap:2px;margin-top:2px">${items.slice(0, 12).map(fmtItem).join('')}${items.length > 12 ? `<span class="s">等 ${items.length} 个</span>` : ''}</div></div>` : '');
  return `<div class="blk"><div class="blk-t">结果线索 · 从引用的消息里提取，不代表已经验证</div>
    ${group('文件', h.files, (f) => `<span class="mono">${esc(f)}</span>`)}
    ${group('提交', h.commits, (c) => `<span class="mono">${esc(c)}</span>`)}
    ${group('链接', h.links, (l) => `<a class="mono" href="${esc(safe(l))}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`)}</div>`;
}

// ---------- 规划 ----------
function renderPlan() {
  const { view } = app.data;
  const vs = view.plan.versions;
  const sugg = view.pending.filter((p) => p.kind === 'ai_suggestion');
  const backfill = `<div class="blk"><div class="blk-t">补建当前规划</div>
      <div class="s">补建的规划会标注“后补”和创建时间，不会被当成最初规划。</div>
      <div class="stack" style="margin-top:8px">${view.tasks.filter((t) => t.status !== 'cancelled').map((t) => `<label class="check"><input type="checkbox" class="bf" value="${esc(t.id)}"> ${esc(t.name)}</label>`).join('')}
      <label>另外要加的条目，一行一个<textarea id="bf-new" style="min-height:70px"></textarea></label>
      <div><button class="btn pri" data-act="backfill">补建</button></div></div></div>`;
  return `${header('plan')}<div class="stack">
    ${vs.length === 0 ? `<div class="blk"><b>已读取的记录里没有明确规划。</b>${view.coverageWarning ? '<div class="s">有来源只读到一部分，前面可能有没读到的规划。</div>' : ''}</div>${backfill}` : `
    <div class="versions">${vs.map((v, i) => `<div class="blk"><div class="blk-t">第 ${v.n} 版${i === 0 && !v.backfilled ? ' · 最初规划' : ''}${i === vs.length - 1 ? ' · 当前有效' : ''}${v.backfilled ? ' · 后补' : ''}<span class="r">${fmt(v.at)}</span></div>
      <div class="ver">${v.items.map((it) => `<div class="vi ${it.change}">${esc(it.name)}<span class="s">${it.change === 'added' ? '后续新增' : it.change === 'cancelled' ? '已取消' : ''}</span></div>`).join('')}</div>
      <div style="margin-top:8px">${v.evidenceIds.map((id, k) => evLink(id, `依据 ${k + 1}`)).join(' ')}</div></div>`).join('')}</div>`}
    <div class="blk" style="border-style:dashed"><div class="blk-t">AI 建议，未经你确认 · 不进入范围</div>
      ${sugg.length ? sugg.map((s) => `<div class="line"><span class="basis b-ai">AI 建议</span><div>${esc(s.text)} ${evLink(s.evidenceId)}</div><div class="row"><button class="btn" data-act="sug-accept" data-task="${esc(s.taskId)}" data-ev="${esc(s.evidenceId)}">纳入</button><button class="btn" data-act="ack" data-ev="${esc(s.evidenceId)}">忽略</button></div></div>`).join('') : '<div class="muted">没有</div>'}
    </div></div>`;
}

// ---------- 待确认 ----------
function renderInbox() {
  const { view, failed, allTasks } = app.data;
  const opts = view.tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  const item = (p) => {
    if (p.kind === 'unknown_task') return `<div class="blk"><div class="blk-t">归属拿不准</div><div>${esc(p.text)} ${evLink(p.evidenceId)}</div>
      <div class="row" style="margin-top:8px">${opts ? `<select id="as-${esc(p.evidenceId)}">${opts}</select><button class="btn" data-act="assign" data-ev="${esc(p.evidenceId)}">归入</button>` : ''}<input type="text" id="nt-${esc(p.evidenceId)}" placeholder="新任务名称"><button class="btn" data-act="new-task" data-ev="${esc(p.evidenceId)}">设为新任务</button><button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">忽略</button></div></div>`;
    if (p.kind === 'source_conflict') return `<div class="blk"><div class="blk-t">两段对话说法相反，分不出先后</div><div>${esc(p.text)} ${evLink(p.evidenceId)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">保留现在的状态</button>${p.suggestedStatus ? `<button class="btn" data-act="conflict-apply" data-task="${esc(p.taskId)}" data-status="${esc(p.suggestedStatus)}" data-ev="${esc(p.evidenceId)}">按后面这段改为${STATUS[p.suggestedStatus]}</button>` : ''}</div>
      <div class="s" style="margin-top:6px">导入网页对话时填上“大约发生在”的日期，就能避免这类冲突。</div></div>`;
    if (p.kind === 'conflict') return `<div class="blk"><div class="blk-t">新证据和你的修正冲突</div><div>${esc(p.text)} ${evLink(p.evidenceId)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">保留我的修正</button>${p.suggestedStatus ? `<button class="btn" data-act="conflict-apply" data-task="${esc(p.taskId)}" data-status="${esc(p.suggestedStatus)}" data-ev="${esc(p.evidenceId)}">按新证据改为${STATUS[p.suggestedStatus]}</button>` : ''}</div></div>`;
    return `<div class="blk"><div class="blk-t">AI 建议，未经你确认</div><div>${esc(p.text)} ${evLink(p.evidenceId)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="sug-accept" data-task="${esc(p.taskId)}" data-ev="${esc(p.evidenceId)}">纳入</button><button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">忽略</button></div></div>`;
  };
  void allTasks;
  return `${header('inbox')}<div class="stack">
    ${failed.length ? `<div class="banner err">${failed.length} 批对话整理失败：${esc(failed[0].error)} <button class="link" data-act="sync">重新整理</button></div>` : ''}
    ${view.pending.length ? view.pending.map(item).join('') : '<div class="empty">没有待确认的事项</div>'}
  </div>`;
}

// ---------- 接入设置 ----------
async function renderSettings() {
  const s = await api('/api/sources');
  const status = (src) => (!src.installed ? '<span class="dot d-off"></span>没有检测到安装' : src.sessions ? `<span class="dot d-ok"></span>已读到对话` : '<span class="dot d-off"></span>已安装，还没读到对话');
  const projectOpts = app.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === app.pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<div class="head"><div><h1>接入设置</h1><div class="sub">数据都存在本机</div></div><button class="btn pri" data-act="sync">同步</button></div>
  <div class="stack">
    ${app.pid && !STATIC ? `<div class="blk"><div class="blk-t">绑定工作目录 · ${esc(app.projects.find(p => p.id === app.pid)?.name ?? '')}</div><div class="stack"><label>本机目录（绝对路径）<input id="crew-bind-dir" placeholder="/path/to/project"></label><div><button class="btn" data-act="bind-workspace">绑定并进入工作台</button></div></div></div>` : ''}
    <div class="tbl"><table><thead><tr><th>来源</th><th>状态</th><th>已读到</th><th>读取范围</th></tr></thead><tbody>
      <tr><td>Claude Code${s.claudeCode.version ? ` <span class="s">${esc(s.claudeCode.version)}</span>` : ''}</td><td>${status(s.claudeCode)}</td><td>${s.claudeCode.sessions} 个会话 · ${s.claudeCode.messages} 条</td><td>只读已绑定目录下的会话；子 agent 的会话暂不读取</td></tr>
      <tr><td>Codex${s.codex.version ? ` <span class="s">${esc(s.codex.version)}</span>` : ''}</td><td>${status(s.codex)}</td><td>${s.codex.sessions} 个会话 · ${s.codex.messages} 条</td><td>只读已绑定目录下的会话；工具报错暂不读取</td></tr>
      <tr><td>VS Code 聊天</td><td>${status(s.vscode)}</td><td>${s.vscode.sessions} 个会话 · ${s.vscode.messages} 条</td><td>VS Code 自带的聊天面板（Copilot Chat 等），按工作区文件夹归属；VS Code 里的 Claude Code、Codex 扩展算在上面两行</td></tr>
      <tr><td>网页 AI · 手动导入</td><td><span class="dot d-ok"></span>手动</td><td>${s.imports.sessions} 段 · ${s.imports.messages} 条</td><td>只包含你粘贴的部分；原始时间拿不到时记采集时间</td></tr>
    </tbody></table></div>
    <div class="s">上次同步：${s.lastSyncAt ? fmt(s.lastSyncAt) : '本次打开后还没同步'}${s.badLines ? ` · ${s.badLines} 行格式异常已跳过，已有数据不受影响` : ''}</div>
    ${s.skippedDirs.length ? `<div class="blk"><div class="blk-t">这些目录里有对话，但没有绑定项目，所以没有读取</div>
      ${s.skippedDirs.map(([dir, n], i) => `<div class="line" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="mono">${esc(dir)}</span><span class="s">${n} 个会话</span><span class="row">${projectOpts ? `<select id="bd-${i}">${projectOpts}</select><button class="btn" data-act="bind" data-dir="${esc(dir)}" data-i="${i}">绑定</button>` : ''}</span></div>`).join('')}</div>` : ''}
    <div class="grid2">
      <div class="blk"><div class="blk-t">粘贴导入网页 AI 的对话</div><div class="stack">
        <label>导入到<select id="im-p">${projectOpts}</select></label>
        <label>来源<select id="im-l"><option>Gemini 网页</option><option>ChatGPT 网页</option><option>Claude 网页</option><option>其他网页 AI</option></select></label>
        <label>标题<input type="text" id="im-t" placeholder="比如：需求讨论"></label>
        <label>这段对话大约发生在（可不填）<input type="date" id="im-d"></label>
        <label>原页面链接（可不填，原文侧栏可以跳回去）<input type="text" id="im-u" placeholder="https://gemini.google.com/app/..."></label>
        <label class="check"><input type="checkbox" id="im-partial"> 只复制了一部分，前面还有没加载的内容</label>
        <label>对话内容。用“你：”“Gemini：”这样的开头区分发言者<textarea id="im-x"></textarea></label>
        <div><button class="btn pri" data-act="import">导入</button></div></div></div>
      <div class="blk"><div class="blk-t">从 Google Takeout 导入 Gemini 历史</div><div class="stack">
        <div class="s">直接选 Takeout 的 zip 包就行。网页版 gemini.google.com 的聊天在“我的活动 → Gemini Apps”里（格式选 JSON）；勾“Gemini”只会导出 Workspace 侧边栏的对话。缺回复的对话会标为“部分”。</div>
        <label>导入到<select id="tk-p">${projectOpts}</select></label>
        <input type="file" id="tk-file" accept=".zip,.json,application/zip,application/json">
        <div><button class="btn" data-act="tk-preview">读取文件</button></div>
        <div id="tk-list"></div></div></div>
      <div class="stack" style="align-content:start">
        <div class="blk"><div class="blk-t">新建项目</div><div class="stack">
          <label>名称<input type="text" id="np-n"></label><label>一句话目标<input type="text" id="np-g"></label>
          <label>代码目录（绝对路径）<input type="text" id="np-d" placeholder="/path/to/project"></label>
          <div><button class="btn pri" data-act="create">建项目</button></div></div></div>
        <div class="blk"><div class="blk-t">整理方式</div><div>整理使用远程模型 ${esc(s.model)}，只发送已绑定项目的对话正文。读取时已把像密钥、令牌的内容换成“[已隐藏的凭证]”，但只覆盖常见格式；特别敏感的对话请自己再核对一遍。</div></div>
        ${app.pid && app.data ? `<div class="blk"><div class="blk-t">数据控制 · ${esc(app.data.project.name)}</div>
          <div class="s">暂停采集：不再读取新对话，已有数据保留。删除项目：同时删除它的对话、任务、证据和修正记录，不能恢复；本机的 Claude Code 和 Codex 原始记录不受影响。</div>
          <div class="row" style="margin-top:8px"><button class="btn" data-act="pause" data-paused="${app.data.project.paused ? '1' : '0'}">${app.data.project.paused ? '恢复采集' : '暂停采集'}</button><button class="btn" data-act="reextract">重新整理</button><button class="btn dg" data-act="delete">删除项目</button></div>
          <div class="s" style="margin-top:6px">重新整理：换了提示词或模型之后用。旧证据清掉重来，任务编号和你的修正保留。</div></div>
        <div class="blk"><div class="blk-t">本项目的会话 · 归错了可以移出</div>
          ${app.data.sessions.length ? app.data.sessions.map((x) => `<div class="line" style="grid-template-columns:minmax(0,1fr) auto auto"><span>${esc(x.label)} <span class="s">${esc(x.title ?? '')}</span></span><span class="s">${x.messages} 条${x.coverage === 'partial' ? ' · 部分' : ''}</span><button class="btn dg" data-act="exclude" data-sid="${esc(x.id)}">移出</button></div>`).join('') : '<div class="muted">还没有会话</div>'}
          <div class="s" style="margin-top:6px">移出后，这段会话的消息和由它得出的结论会删掉，之后同步也不会再读它。</div></div>
        <div class="blk"><div class="blk-t">使用记录 · ${esc(app.data.project.name)}</div><div>${usageLine(await api(`/api/projects/${app.pid}/usage`))}</div><div class="s">只记次数，不记内容，用来判断这个工具是否真的在帮忙。</div></div>` : ''}
      </div>
    </div>
  </div>`;
}

function usageLine(u) {
  const n = (k) => u[k] ?? 0;
  const corrections = Object.entries(u).filter(([k]) => k.startsWith('correction_')).reduce((a, [, v]) => a + v, 0);
  return `打开 ${n('open_project')} 次 · 同步 ${n('sync')} 次 · 查看续接上下文 ${n('context_view')} 次 · 复制 ${n('context_copy')} 次 · 采纳下一步 ${n('next_accept')} 次 · 人工修正 ${corrections} 次`;
}

function renderWelcome() {
  return `<div class="stack" style="max-width:560px">
    <div class="row"><img src="logo.svg" alt="" width="40" height="40" style="image-rendering:pixelated"><h1 style="margin:0">Crew</h1></div>
    <p>你的本地 Agent 工作台。打开项目，在同一个窗口与 Codex、Claude Code 工作，直接处理原生权限提示。</p>
    <div class="blk"><div class="blk-t">打开项目</div><div class="stack">
      <label>名称<input type="text" id="np-n"></label><label>一句话目标<input type="text" id="np-g"></label>
      <label>工作目录（绝对路径），新终端从这里启动<input type="text" id="np-d" placeholder="/path/to/project"></label>
      <div><button class="btn pri" data-act="create">打开项目</button></div></div></div></div>`;
}

// ---------- 原文侧栏 ----------
async function openEvidence(evId) {
  const ev = app.data.evidence[evId];
  if (!ev) return;
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.innerHTML = '<div class="muted">加载原文…</div>';
  const msgs = await api(`/api/projects/${app.pid}/messages?ids=${encodeURIComponent(ev.cite.join(','))}`);
  // 改过的消息：把新版本也取回来，放在旧版本下面
  const newer = [...new Set(msgs.map((m) => m.replacedBy).filter(Boolean))];
  const latest = newer.length ? new Map((await api(`/api/projects/${app.pid}/messages?ids=${encodeURIComponent(newer.join(','))}`)).map((m) => [m.id, m])) : new Map();
  const who = { user: '你', assistant: 'AI', tool_error: '工具报错' };
  drawer.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><b>原文</b><button class="link" data-act="close-drawer">关闭</button></div>
    <div class="s" style="margin-bottom:10px">${esc(ev.detail)}${ev.reason ? ` · 原因：${esc(ev.reason)}` : ''}</div>
    ${msgs.map((m) => `<div class="msg">
      <div class="s">${esc(m.session?.label)}${m.session?.title ? `「${esc(m.session.title)}」` : ''} · 第 ${m.seq + 1} 条</div>
      <div class="s">${m.ts ? `原始时间 ${fmt(m.ts)}` : `原始时间未知 · 采集于 ${fmt(m.capturedAt)}`}</div>
      <div><b>${who[m.role]}：</b>${m.replacedBy ? ' <span class="basis b-ai">后来改过，这是旧版本</span>' : ''}</div><div class="q"${m.replacedBy ? ' style="text-decoration:line-through;opacity:.7"' : ''}>${esc(m.text)}</div>
      ${m.replacedBy && latest.get(m.replacedBy) ? `<div class="s">改成了：</div><div class="q">${esc(latest.get(m.replacedBy).text)}</div>` : ''}
      ${m.session?.coverage === 'partial' ? '<div class="s">覆盖：只读到一部分，前文没加载</div>' : ''}
      ${m.session?.url && /^https?:\/\//.test(m.session.url) ? `<a class="link" href="${esc(m.session.url)}" target="_blank" rel="noopener noreferrer">打开原页面</a>` : ''}
      ${m.session?.source === 'import' ? `<div class="row"><span class="s">发言者认错了？</span><button class="link" data-act="role" data-msg="${esc(m.id)}" data-role="${m.role === 'user' ? 'assistant' : 'user'}">改成${m.role === 'user' ? 'AI' : '你'}</button></div>` : ''}
    </div>`).join('')}`;
}

// ---------- 续接上下文 ----------
async function openContext(taskId) {
  const { text } = await api(`/api/projects/${app.pid}/context?task=${encodeURIComponent(taskId)}`);
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="card" role="dialog" aria-label="继续任务">
    <div class="row" style="justify-content:space-between"><b>继续任务</b><button class="link" data-act="close-modal">关闭</button></div>
    <div class="s">可以删改后再复制。复制之后记为“已复制”，粘贴到目标工具并发送，才算真正开始。</div>
    <textarea id="ctx">${esc(text)}</textarea>
    <div class="row"><button class="btn pri" data-act="copy">复制</button><button class="btn" data-act="export-md" data-name="${esc(text.split('\n')[0].replace(/^# 继续：/, ''))}">导出 Markdown</button><span class="s" id="ctx-state">已生成</span></div></div>`;
}

// ---------- 事件 ----------
const on = {
  async ev(el) { await openEvidence(el.dataset.ev); },
  'close-drawer'() { $('#drawer').hidden = true; },
  'close-modal'() { $('#modal').hidden = true; },
  goto(el, e) { if (!e.target.closest('button')) location.hash = el.dataset.href; },
  async cont(el) { await openContext(el.dataset.task); },
  async copy() {
    await navigator.clipboard.writeText($('#ctx').value);
    $('#ctx-state').textContent = '已复制';
    await api(`/api/projects/${app.pid}/usage`, { method: 'POST', body: { kind: 'context_copy' } });
    toast('已复制到剪贴板');
  },
  'export-md'(el) {
    const blob = new Blob([$('#ctx').value], { type: 'text/markdown;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `继续-${el.dataset.name || '任务'}.md` });
    a.click();
    URL.revokeObjectURL(a.href);
    $('#ctx-state').textContent = '已导出';
  },
  async 'move-task'(el) {
    const to = $('#mv-to').value;
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = '确认移动'; return; }
    const { taskId } = await api(`/api/projects/${app.pid}/tasks/${encodeURIComponent(el.dataset.task)}/move`, { method: 'POST', body: { to } });
    toast('已移动，任务的证据和原话一起带过去了');
    location.hash = `#/p/${to}/task/${short(taskId)}`;
  },
  async split(el) {
    const evidenceIds = [...document.querySelectorAll('.sp:checked')].map((x) => x.value);
    const name = $('#sp-name').value.trim();
    if (!evidenceIds.length) return toast('先勾选要拆出去的证据');
    if (!name) return toast('给新任务起个名字');
    const { taskId } = await api(`/api/projects/${app.pid}/corrections`, { method: 'POST', body: { type: 'split', name, evidenceIds } });
    toast('已拆出新任务，两边的状态都按证据重算了');
    location.hash = `#/p/${app.pid}/task/${short(taskId)}`;
  },
  async sync(el) {
    const pid = app.pid ?? app.projects[0]?.id;
    if (!pid) return toast('先建一个项目');
    el.disabled = true;
    el.textContent = '同步中，整理可能要几分钟…';
    try {
      const r = await api(`/api/projects/${pid}/sync`, { method: 'POST' });
      toast(`读到新消息 ${r.newMessages} 条，新证据 ${r.stored} 条${r.failed ? `，${r.failed} 批整理失败` : ''}`);
    } catch (err) {
      if (err.status !== 428) throw err;
      // 第一次整理：先说明会发送什么，同意后再发
      const modal = $('#modal');
      modal.hidden = false;
      modal.innerHTML = `<div class="card" role="dialog" aria-label="发送说明"><b>整理前请确认</b>
        <div>${esc(err.message)}</div>
        <div class="s">只发送这个项目已读到的对话正文。读取时已把像密钥、令牌的内容换成“[已隐藏的凭证]”。不同意也可以继续使用：看原文、手动建任务、手动改状态。</div>
        <div class="row"><button class="btn pri" data-act="consent" data-pid="${esc(pid)}">同意并整理</button><button class="btn" data-act="close-modal">先不整理</button></div></div>`;
    } finally {
      await load().catch(() => {});
    }
  },
  async consent(el) {
    await api(`/api/projects/${el.dataset.pid}/consent`, { method: 'POST' });
    $('#modal').hidden = true;
    toast('已同意，开始整理');
    const btn = document.querySelector('[data-act="sync"]');
    if (btn) await on.sync(btn);
  },
  async reextract(el) {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = '再点一次，开始重新整理'; return; }
    el.disabled = true;
    el.textContent = '重新整理中…';
    try {
      const r = await api(`/api/projects/${app.pid}/reextract`, { method: 'POST' });
      toast(`重新整理完成：新证据 ${r.stored} 条${r.failed ? `，${r.failed} 批失败` : ''}`);
    } catch (err) {
      if (err.status === 428) toast('先在概览页点一次“同步”并同意发送说明');
      else throw err;
    } finally {
      await load().catch(() => {});
    }
  },
  async exclude(el) {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = '确认移出'; return; }
    await api(`/api/projects/${app.pid}/sessions/${encodeURIComponent(el.dataset.sid)}/exclude`, { method: 'POST' });
    toast('已移出，结论已重新计算');
    await load();
  },
  async pause(el) {
    const paused = el.dataset.paused !== '1';
    await api(`/api/projects/${app.pid}/pause`, { method: 'POST', body: { paused } });
    toast(paused ? '已暂停采集，已有数据保留' : '已恢复采集');
    await load();
  },
  'confirm-done'(el) { return correct({ type: 'set_status', taskId: el.dataset.task, status: 'done', note: '你在页面上确认完成' }, '已确认完成'); },
  unblock(el) { return correct({ type: 'set_status', taskId: el.dataset.task, status: 'doing', note: '你标记阻塞已解决' }, '已标记为进行中'); },
  async 'next-accept'(el) { await api(`/api/projects/${app.pid}/usage`, { method: 'POST', body: { kind: 'next_accept' } }); await openContext(el.dataset.task); },
  async 'next-later'(el) {
    later.add(el.dataset.key);
    sessionStorage.setItem('later', JSON.stringify([...later]));
    await api(`/api/projects/${app.pid}/usage`, { method: 'POST', body: { kind: 'next_later' } });
    toast('这次先不看它');
    await load();
  },
  'next-dismiss'(el) { return correct({ type: 'dismiss_next', key: el.dataset.key }, '已驳回，没有新进展前不再推荐'); },
  status(el) { return correct({ type: 'set_status', taskId: el.dataset.task, status: $('#st').value }, '状态已修改'); },
  rename(el) { return correct({ type: 'rename', taskId: el.dataset.task, name: $('#nm').value }, '已改名'); },
  async merge(el) {
    const into = $('#into').value;
    await correct({ type: 'merge', from: el.dataset.task, into }, '已合并');
    location.hash = `#/p/${app.pid}/task/${short(into)}`;
  },
  condition(el) { return correct({ type: 'confirm_condition', taskId: el.dataset.task, condition: $('#cond').value }, '完成条件已确认'); },
  ack(el) { return correct({ type: 'ack', evidenceId: el.dataset.ev }, '已处理'); },
  async 'conflict-apply'(el) {
    await api(`/api/projects/${app.pid}/corrections`, { method: 'POST', body: { type: 'set_status', taskId: el.dataset.task, status: el.dataset.status, note: '你按新证据修改' } });
    await correct({ type: 'ack', evidenceId: el.dataset.ev }, '已按新证据修改');
  },
  async 'sug-accept'(el) {
    await api(`/api/projects/${app.pid}/corrections`, { method: 'POST', body: { type: 'set_status', taskId: el.dataset.task, status: 'todo', note: '你把 AI 的建议纳入了' } });
    await correct({ type: 'ack', evidenceId: el.dataset.ev }, '已纳入，成为待开始的任务');
  },
  assign(el) { return correct({ type: 'assign', evidenceId: el.dataset.ev, taskId: $(`#as-${CSS.escape(el.dataset.ev)}`).value }, '已归入'); },
  'new-task'(el) {
    const name = $(`#nt-${CSS.escape(el.dataset.ev)}`).value.trim();
    if (!name) return toast('先填新任务名称');
    return correct({ type: 'new_task', name, evidenceId: el.dataset.ev }, '已建新任务');
  },
  backfill() {
    const taskIds = [...document.querySelectorAll('.bf:checked')].map((x) => x.value);
    const names = $('#bf-new').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!taskIds.length && !names.length) return toast('至少选一项');
    return correct({ type: 'backfill_plan', taskIds, names }, '已补建规划，标注为后补');
  },
  role(el) { $('#drawer').hidden = true; return correct({ type: 'set_role', messageId: el.dataset.msg, role: el.dataset.role }, '发言者已改正，结论已重新计算'); },
  async bind(el) {
    const pid = $(`#bd-${el.dataset.i}`).value;
    await api(`/api/projects/${pid}/dirs`, { method: 'POST', body: { dir: el.dataset.dir } });
    toast('已绑定，点“同步”读取这个目录的对话');
    await load();
  },
  async 'bind-workspace'() {
    const dir = $('#crew-bind-dir').value.trim();
    if (!dir) return toast('先填工作目录');
    await api(`/api/projects/${app.pid}/dirs`, { method: 'POST', body: { dir } });
    location.hash = `#/p/${app.pid}/workspace`;
  },
  async create() {
    const name = $('#np-n').value.trim();
    if (!name) return toast('先填项目名称');
    const dir = $('#np-d').value.trim();
    const { id } = await api('/api/projects', { method: 'POST', body: { name, goal: $('#np-g').value.trim(), dirs: dir ? [dir] : [] } });
    toast('项目已建好');
    location.hash = `#/p/${id}/workspace`;
  },
  async import() {
    const pid = $('#im-p').value;
    const text = $('#im-x').value;
    const title = $('#im-t').value.trim();
    if (!text.trim() || !title) return toast('请填写标题和对话内容');
    const r = await api(`/api/projects/${pid}/import`, { method: 'POST', body: { text, title, label: $('#im-l').value, partial: $('#im-partial').checked, date: $('#im-d').value, url: $('#im-u').value.trim() } });
    toast(`导入 ${r.newMessages} 条新消息${r.unsure ? '，有一段认不出发言者，请在原文里核对' : ''}。点“同步”整理`);
    $('#im-x').value = '';
    await load();
  },
  async 'tk-preview'() {
    const file = $('#tk-file').files?.[0];
    if (STATIC) return toast(READ_ONLY);
    if (!file) return toast('先选 MyActivity.json');
    const pid = $('#tk-p').value;
    const zip = /\.zip$/i.test(file.name);
    const res = await fetch(`/api/projects/${pid}/takeout/preview`, { method: 'POST', headers: { 'x-corpus': '1', 'content-type': zip ? 'application/zip' : 'application/json' }, body: zip ? file : await file.text() });
    const data = await res.json();
    if (!res.ok) return toast(data.error || '读取失败');
    $('#tk-list').innerHTML = data.conversations.length ? `<div class="s">${data.conversations.length} 段对话，勾选和这个项目有关的：</div>
      ${data.conversations.map((c) => `<label class="check" style="padding:4px 0;border-top:1px solid var(--rule)"><input type="checkbox" class="tk" value="${esc(c.key)}"><span class="s" style="min-width:86px">${esc(c.start.slice(0, 10))}</span><span class="s">${esc(c.source)}</span><span>${esc(c.title)}</span><span class="s">${c.turns} 条${c.missingResponse ? ' · 缺回复' : ''}</span></label>`).join('')}
      <div style="margin-top:8px"><button class="btn pri" data-act="tk-import" data-token="${esc(data.token)}" data-pid="${esc(pid)}">导入所选</button></div>` : '<div class="muted">没有找到 Gemini 对话。网页版的聊天要在 Takeout 里勾“我的活动 → Gemini Apps”；Gemini 活动记录被关掉时导出也是空的。</div>';
  },
  async 'tk-import'(el) {
    const keys = [...document.querySelectorAll('.tk:checked')].map((x) => x.value);
    if (!keys.length) return toast('至少勾选一段对话');
    const r = await api(`/api/projects/${el.dataset.pid}/takeout/import`, { method: 'POST', body: { token: el.dataset.token, keys } });
    toast(`导入 ${r.sessions} 段对话，新消息 ${r.newMessages} 条。点“同步”整理`);
    $('#tk-list').innerHTML = '';
    await load();
  },
  async delete(el) {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = '再点一次，确认删除'; return; }
    await api(`/api/projects/${app.pid}`, { method: 'DELETE' });
    app.pid = null;
    app.lastPid = null;
    toast('项目已删除');
    location.hash = '#/';
    await load();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  try { await on[el.dataset.act]?.(el, e); } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#modal').hidden = true; $('#drawer').hidden = true; } });
window.addEventListener('hashchange', () => load().catch((err) => toast(err.message)));
if (STATIC) document.body.insertAdjacentHTML('afterbegin', `<div class="demo-bar">项目现场只读示例；任务编排和材料流程请装到本机运行<a href="https://github.com/Longado/crew">装到本机 →</a></div>`);
// 第一次打开时只读一次新对话（不整理、不调用模型），切换页面时不重复读
const initialPage = parseHash().page;
// Live terminals must not wait behind the legacy synchronous conversation scan.
const initialRead = !STATIC && ['home', 'workspace', 'new', 'team', 'security', 'today'].includes(initialPage) ? Promise.resolve() : api('/api/read', { method: 'POST' }).catch(() => {});
initialRead.finally(() => {
  load().catch((err) => { $('#main').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
});
