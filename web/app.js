// Working Corpus 前端。不需要构建，直接由本地服务器提供。
// 所有来自对话记录的文字都经过 esc() 转义，对话内容不可信。
import { mountTeam } from './team.js';
import { mountTeamDock } from './team-dock.js';
import { mountWorkspace } from './workspace.js';
import { mountSecurity } from './security.js';
import { mountToday } from './today.js';
import { avatar, kindOf } from './avatar.js';
import { officeHtml, wireOffice } from './office.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS = { pending_confirm: '待确认', todo: '待开始', doing: '进行中', to_verify: '待验证', done: '已完成', blocked: '受阻', cancelled: '已取消' };
const ORDER = ['to_verify', 'blocked', 'doing', 'todo', 'pending_confirm', 'done'];
const BASIS = { user: '用户确认', text: '原文明确', ai: 'AI 自述', manual: '你改的' };
const KIND = { plan_item: '规划', plan_add: '规划新增', plan_cancel: '取消', started: '开始执行', ai_claims_done: 'AI 称完成', user_confirms_done: '你确认完成', failure: '失败', blocked: '受阻', unblocked: '解除阻塞', decision_adopt: '采用', decision_reject: '否决', out_of_scope: '范围外' };
const COLOR = { done: 'var(--done)', doing: 'var(--doing)', to_verify: 'var(--verify)', todo: 'var(--todo)', blocked: 'var(--block)' };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知');
const short = (id) => String(id).split('/').pop();
// 状态用图形表达：空心待开始、半满进行中、四分之三待验证、实心打勾完成、实心横杠受阻
const ST_SHAPE = {
  pending_confirm: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 2.1"/>',
  todo: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  doing: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.4a3.6 3.6 0 0 1 0 7.2z" fill="currentColor"/>',
  to_verify: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.4a3.6 3.6 0 1 1-3.6 3.6H8z" fill="currentColor"/>',
  done: '<circle cx="8" cy="8" r="6.4" fill="currentColor"/><path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" stroke="var(--surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  blocked: '<circle cx="8" cy="8" r="6.4" fill="currentColor"/><path d="M5.3 8h5.4" stroke="var(--surface)" stroke-width="1.7" stroke-linecap="round"/>',
  cancelled: '<circle cx="8" cy="8" r="6.4" fill="currentColor"/><path d="m6 6 4 4m0-4-4 4" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round"/>',
};
const stIcon = (s) => `<svg class="st st-${s}" viewBox="0 0 16 16" role="img" aria-label="${STATUS[s]}"><title>${STATUS[s]}</title>${ST_SHAPE[s]}</svg>`;
const chip = (s) => `<span class="chip c-${s}">${stIcon(s)}${STATUS[s]}</span>`;
const basis = (b) => `<span class="basis b-${b}">${BASIS[b]}</span>`;
const evLink = (id, text = '依据') => (id ? `<button class="ev" data-act="ev" data-ev="${esc(id)}">${text}</button>` : '');

let app = { projects: [], model: '', lastSyncAt: null, pid: null, lastPid: null, data: null };
let unmountTeam = null;
let unmountDock = null;
let unmountWorkspace = null;
let unmountSecurity = null;
let unmountToday = null;
let unmountOffice = null;
let stampTimer = 0;
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

// 线条图标，24 格画布、1.6 线宽
const IC = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  plan: '<path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/><circle cx="5" cy="6.5" r="1.1"/><circle cx="5" cy="12" r="1.1"/><circle cx="5" cy="17.5" r="1.1"/>',
  inbox: '<path d="M3.5 13h4.8l1.6 2.8h4.2l1.6-2.8h4.8"/><path d="M6.2 5h11.6l2.7 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/><path d="m7.5 9.5 2.8 2.5-2.8 2.5M12.8 15h3.8"/>',
  team: '<circle cx="9" cy="8.6" r="3.1"/><path d="M3.6 19c.6-3 2.8-4.7 5.4-4.7s4.8 1.7 5.4 4.7"/><circle cx="16.9" cy="9.6" r="2.5"/><path d="M16.2 14.5c2.3.1 3.8 1.6 4.3 4"/>',
  shield: '<path d="M12 3.3 5.3 6v5.4c0 4.2 2.8 7.4 6.7 9 3.9-1.6 6.7-4.8 6.7-9V6z"/>',
  key: '<circle cx="8" cy="15.5" r="3.8"/><path d="m10.8 12.7 8.4-8.4M16.6 6.9l2.3 2.3M14.4 9.1l1.8 1.8"/>',
  sliders: '<path d="M4 7.5h9.5M17.5 7.5H20M4 16.5h3M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  sync: '<path d="M19.5 11A7.6 7.6 0 0 0 6 7.2L4.5 9M4.5 13A7.6 7.6 0 0 0 18 16.8l1.5-1.8"/><path d="M4.5 4.5V9H9M19.5 19.5V15H15"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  chev: '<path d="m9.5 6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  quote: '<path d="M9.5 7C6.8 8 5.5 10 5.5 13v4h4.5v-4.5H7.6c0-1.9.8-3 2.4-3.6zM18 7c-2.7 1-4 3-4 6v4h4.5v-4.5h-2.4c0-1.9.8-3 2.4-3.6z"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;

async function load() {
  const version = ++loadVersion;
  unmountToday?.(); unmountToday = null;
  unmountSecurity?.(); unmountSecurity = null;
  unmountDock?.(); unmountDock = null;
  unmountOffice?.(); unmountOffice = null;
  clearInterval(stampTimer);
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
    if (STATIC) main.innerHTML = `${header('workspace')}<div class="empty">${ic('terminal')}终端需要在本机运行</div>`;
    else {
      main.innerHTML = '<div id="crew-workspace"></div>';
      unmountWorkspace = mountWorkspace($('#crew-workspace'), { projectId: app.pid, projectName: app.data.project.name, dirs: app.data.project.dirs, api, toast });
    }
  }
  else if (r.page === 'team') {
    if (STATIC) main.innerHTML = `${header('team')}<div class="empty">${ic('team')}团队需要在本机运行</div>`;
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
  else {
    main.innerHTML = renderOverview();
    const askIds = data.view.tasks.filter((t) => t.status === 'to_verify' || t.status === 'blocked').map((t) => t.id);
    unmountOffice = wireOffice(main, { pid, askIds, onTray: () => document.getElementById('asks')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) });
    if (!STATIC) watchStamp(pid, version, data.stamp);
  }
  const dock = document.getElementById('crew-team-dock');
  // 团队栏只跟着项目页走；今日、设置、新建项目页不显示
  dock.hidden = STATIC || !data || ['today', 'settings', 'new'].includes(r.page) || !app.projects.length; document.body.classList.toggle('crew-has-team-dock', !dock.hidden);
  if (!dock.hidden) unmountDock = mountTeamDock(dock, { projectId: pid, api, toast });
  drawBand();
}

// Agent 通过 MCP 自己报进度时，这里每 5 秒比一次项目的变化戳，变了才重新拉整页；页面藏起来时不查
function watchStamp(pid, version, loaded) {
  let last = loaded ?? null; // 从这页数据算出来时的戳起比，加载之后才写进来的也算变化
  stampTimer = setInterval(async () => {
    if (document.hidden || version !== loadVersion) return;
    try {
      const { stamp } = await api(`/api/projects/${pid}/stamp`);
      if (last !== null && stamp !== last) load().catch(() => {});
      last = stamp;
    } catch { clearInterval(stampTimer); }
  }, 5000);
}

// 侧栏只放全局入口和项目列表；当前项目的各页展开在它名字下面
function renderNav(r) {
  const pending = app.data?.view.pending.length ?? 0;
  const inProject = !!r.pid && !!app.data;
  const link = (href, on, icon, label, extra = '') => `<a href="${href}" class="${on ? 'on' : ''}">${ic(icon)}<span class="nv-l">${label}</span>${extra}</a>`;
  const p = esc(app.pid);
  const sub = inProject ? `<div class="sub">
      ${link(`#/p/${p}`, r.page === 'overview' || r.page === 'task', 'grid', '现场')}
      ${link(`#/p/${p}/plan`, r.page === 'plan', 'plan', '规划')}
      ${link(`#/p/${p}/inbox`, r.page === 'inbox', 'inbox', '待确认', pending ? `<span class="cnt hot">${pending}</span>` : '')}
      ${!STATIC ? `${link(`#/p/${p}/workspace`, r.page === 'workspace', 'terminal', '终端')}
      ${link(`#/p/${p}/team`, r.page === 'team', 'team', '团队')}
      ${link(`#/p/${p}/security`, r.page === 'security', 'shield', '安全')}` : ''}
    </div>` : '';
  $('#nav').innerHTML = `
    <a class="brand" href="#/"><img src="logo.svg" alt="" width="22" height="22">Crew</a>
    ${link('#/today', r.page === 'today', 'sun', '今日')}
    <div class="grp"><span>项目</span>${!STATIC ? `<a class="grp-add" href="#/new" title="打开项目" aria-label="打开项目">${ic('plus')}</a>` : ''}</div>
    ${!STATIC && app.projects.length > 6 ? '<input class="crew-project-search" type="search" aria-label="搜索项目" placeholder="搜索项目">' : ''}
    <div class="crew-project-list">${app.projects.map((x) => {
      const on = x.id === app.pid && inProject;
      return `<a href="#/p/${esc(x.id)}${STATIC ? '' : '/workspace'}" class="pj${on ? ' cur' : ''}"><span class="pj-mark">${esc([...String(x.name).replace(/^示例\s*·\s*/, '')][0] ?? '·')}</span><span class="nv-l">${esc(x.name)}</span>${x.pending ? `<span class="cnt">${x.pending}</span>` : ''}</a>${on ? sub : ''}`;
    }).join('')}</div>
    <div class="nav-end">
      ${link('#/security', r.page === 'security' && !r.pid, 'key', '凭证与安全')}
      ${link('#/settings', r.page === 'settings', 'sliders', '设置')}
      ${app.pid ? `<div class="foot" title="整理模型：${esc(app.model)}"><i></i>${app.lastSyncAt ? `${fmt(app.lastSyncAt)} 同步` : '本次打开后还没同步'}</div>` : ''}
    </div>`;
  const projectSearch = $('#nav .crew-project-search');
  if (projectSearch) projectSearch.oninput = () => {
    const query = projectSearch.value.trim().toLocaleLowerCase();
    $('#nav').querySelectorAll('.crew-project-list a.pj').forEach(link => { link.hidden = !link.textContent.toLocaleLowerCase().includes(query); });
  };
}

function header(active) {
  const { project } = app.data;
  const label = { plan: '规划', inbox: '待确认', workspace: '终端', team: '团队' }[active];
  const side = `<div class="ph-side">${app.lastSyncAt ? `<span class="ph-time">${fmt(app.lastSyncAt)}</span>` : ''}<button class="btn" data-act="sync">${ic('sync')}同步</button></div>`;
  return label
    ? `<header class="ph"><div class="ph-main"><a class="ph-up" href="#/p/${esc(app.pid)}">${esc(project.name)}</a><h1>${label}</h1></div>${side}</header>`
    : `<header class="ph"><div class="ph-main"><h1>${esc(project.name)}</h1><p class="ph-goal">${esc(project.goal || '还没写项目目标')}</p></div>${side}</header>`;
}

function banners() {
  const { view, failed, sessions, unextracted } = app.data;
  const out = [];
  if (unextracted > 0) out.push(`<div class="banner info">${unextracted} 条新消息还没整理<button class="link" data-act="sync">现在整理</button></div>`);
  if (view.coverageWarning) out.push(`<div class="banner">有来源只读到一部分，下面的结论只基于读到的内容</div>`);
  if (failed.length) out.push(`<div class="banner err">${failed.length} 批对话整理失败：${esc(failed[0].error)}<button class="link" data-act="sync">重新整理</button></div>`);
  if (!sessions.length) out.push(`<div class="banner">还没读到对话。绑定目录里用过 Claude Code 或 Codex 后点同步；网页 AI 的对话在<a href="#/settings">设置</a>里导入</div>`);
  return out.join('');
}

// 一个任务关联的对话来源，用叠在一起的小头像表示
function sourceFaces(t, sessions, size = 18) {
  const n = {};
  t.sessions.forEach((sid) => { const s = sessions.find((x) => x.id === sid); if (s) n[s.label] = (n[s.label] || 0) + 1; });
  return Object.entries(n).map(([label, count]) => avatar(kindOf(label), 'idle', { size, label: esc(`${label} · ${count} 段对话`) })).join('');
}

// ---------- 现场 ----------
function renderOverview() {
  const { view, sessions } = app.data;
  const pid = esc(app.pid);
  const plan = view.plan.versions.at(-1);
  const byStatus = (s) => view.tasks.filter((t) => t.status === s);
  const needs = [...byStatus('to_verify'), ...byStatus('blocked')];
  const active = view.tasks.filter((t) => t.status !== 'cancelled').sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const cancelled = byStatus('cancelled');
  // 已经在「等你」里的任务不再出现在下一步，同一件事只问一次
  const asked = new Set(needs.map((t) => t.id));
  const next = view.next.filter((n) => !later.has(n.key) && !asked.has(n.taskId));
  const today = new Date().toDateString();
  const doneToday = view.doneEvents.filter((d) => new Date(d.at).toDateString() === today).length;
  const pending = view.pending.length;
  const counted = ['done', 'doing', 'to_verify', 'todo', 'blocked'].filter((s) => byStatus(s).length);

  const asks = needs.map((t) => `<article class="ask">
      ${stIcon(t.status)}
      <div class="ask-b"><div class="ask-t">${esc(t.name)}</div>
        <div class="ask-d">${esc(t.status === 'blocked' ? t.blocker ?? '受阻原因原文没说' : t.basisNote)}${basis(t.basis)}${evLink(t.basisEvidenceId)}</div></div>
      <div class="ask-a">${t.status === 'to_verify' ? `<button class="btn pri" data-act="confirm-done" data-task="${esc(t.id)}">确认完成</button>` : `<button class="btn pri" data-act="unblock" data-task="${esc(t.id)}">已解决</button>`}<button class="btn ghost" data-act="cont" data-task="${esc(t.id)}">继续</button></div>
    </article>`).join('');
  const more = pending ? `<a class="ask ask-more" href="#/p/${pid}/inbox">${ic('inbox')}<div class="ask-b"><div class="ask-t">还有 ${pending} 条待确认</div><div class="ask-d">AI 建议和归属拿不准的消息</div></div>${ic('chev')}</a>` : '';

  return `${header('overview')}${banners()}
  ${officeHtml(app.data, app.pid, { asks: needs.length + pending, staticDemo: STATIC })}
  <div class="ov">
    <div class="ov-main">
      <section class="sec" id="asks">
        <h2 class="sec-h">等你<span class="n">${needs.length + pending}</span></h2>
        ${asks || more ? `<div class="asks">${asks}${more}</div>` : `<div class="calm">${avatar('codex', 'completed', { size: 34 })}<span>没有等你处理的事</span></div>`}
      </section>
      <section class="sec">
        <h2 class="sec-h">下一步<span class="n">${next.length}</span></h2>
        ${next.length ? `<ol class="nexts">${next.map((n, i) => {
          const full = [n.precondition && n.precondition !== '无' ? `前置条件：${n.precondition}` : '', `完成标准：${n.doneStandard}`, `原因：${n.reason}`].filter(Boolean).join('\n');
          return `<li class="nx"><span class="nx-no">${i + 1}</span>
            <div class="nx-b"><div class="nx-t">${esc(n.action)}</div><div class="nx-d"><span class="trunc" title="${esc(full)}">${esc(n.reason)}</span>${evLink(n.evidenceId)}</div></div>
            <div class="nx-a"><button class="btn sm" data-act="next-accept" data-task="${esc(n.taskId)}">采纳</button><button class="icon-btn" data-act="next-later" data-key="${esc(n.key)}" title="暂缓" aria-label="暂缓">${ic('clock')}</button><button class="icon-btn" data-act="next-dismiss" data-key="${esc(n.key)}" title="驳回" aria-label="驳回">${ic('x')}</button></div></li>`;
        }).join('')}</ol>` : '<p class="none">暂时没有可推荐的下一步</p>'}
      </section>
      <section class="sec">
        <h2 class="sec-h">任务<span class="n">${active.length}</span>${doneToday ? `<span class="sec-note">今天完成 ${doneToday}</span>` : ''}</h2>
        ${active.length ? `<div class="prog" role="img" aria-label="${counted.map((s) => `${STATUS[s]} ${byStatus(s).length}`).join('，')}">${counted.map((s) => `<i style="flex:${byStatus(s).length};background:${COLOR[s]}"></i>`).join('')}</div>
        <div class="legend">${counted.map((s) => `<span>${stIcon(s)}${STATUS[s]}<b>${byStatus(s).length}</b></span>`).join('')}</div>` : ''}
        <div class="tlist">${active.map((t) => `<div class="task" data-act="goto" data-href="#/p/${pid}/task/${esc(short(t.id))}">${stIcon(t.status)}<span class="nm">${esc(t.name)}</span><span class="faces">${sourceFaces(t, sessions)}</span><span class="t-a">${t.status === 'done' ? basis(t.basis) : `<button class="link" data-act="cont" data-task="${esc(t.id)}">继续</button>`}</span></div>`).join('') || '<p class="none">还没有任务。同步之后会从对话里整理出来</p>'}</div>
        ${cancelled.length ? `<details class="fold"><summary>已取消 ${cancelled.length}</summary>${cancelled.map((t) => `<div class="task" data-act="goto" data-href="#/p/${pid}/task/${esc(short(t.id))}">${stIcon(t.status)}<span class="nm muted">${esc(t.name)}</span><span class="faces"></span><span class="t-a s">${esc(t.basisNote)}</span></div>`).join('')}</details>` : ''}
      </section>
    </div>
    <aside class="ov-side">
      ${bandHtml()}
      <section class="card notes">
        <a class="note-row" href="#/p/${pid}/plan"><span>规划</span><span class="card-r">${plan ? `第 ${plan.n} 版${plan.backfilled ? ' · 后补' : ''} · ${plan.items.filter((it) => it.change !== 'cancelled').length} 项` : '还没有'}</span>${ic('chev')}</a>
        ${view.decisions.length ? `<details class="note-more"><summary><span>最近决定</span><span class="card-r">${Math.min(view.decisions.length, 5)}</span>${ic('chev')}</summary><ul class="decs">${view.decisions.slice(-5).reverse().map((d) => `<li class="${d.supersededBy ? 'old' : ''}"><span class="dk dk-${d.kind}">${d.kind === 'adopt' ? '采用' : d.kind === 'reject' ? '否决' : '取消'}</span><span class="dt" title="原因：${esc(d.reason ?? '原文未说明')}">${esc(d.text)}</span>${d.supersededBy ? evLink(d.supersededBy, '新决定') : evLink(d.evidenceId)}</li>`).join('')}</ul></details>` : ''}
        ${view.ideas.length ? `<details class="note-more"><summary><span>范围外想法</span><span class="card-r">${view.ideas.length}</span>${ic('chev')}</summary><ul class="ideas">${view.ideas.slice(-3).map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></details>` : ''}
      </section>
    </aside>
  </div>`;
}

// ---------- 对话带 ----------
const BAND_STATUS = ['done', 'to_verify', 'doing', 'todo', 'blocked', 'cancelled'];
function bandHtml() {
  const band = app.data.band ?? [];
  if (!band.length) return '';
  const linked = band.filter((b) => b.status).length;
  const shown = BAND_STATUS.filter((st) => band.some((b) => b.status === st));
  return `<section class="card band">
    <h3 class="card-h">对话<span class="card-r">${band.length} 条 · ${linked} 条成了证据</span></h3>
    <canvas id="band" aria-label="${band.length} 条消息，其中 ${linked} 条是任务证据；每格一条，颜色是它支撑的任务状态"></canvas>
    <div class="legend sm">${shown.map((st) => `<span><i style="background:var(--${st === 'to_verify' ? 'verify' : st === 'blocked' ? 'block' : st === 'cancelled' ? 'cancel' : st})"></i>${STATUS[st]}</span>`).join('')}<span><i style="background:var(--idle)"></i>未归入</span></div></section>`;
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
  const w = canvas.clientWidth;
  // 每条消息一个圆角小格，按时间从左到右、一行排满再换行；消息多到超过 120px 高时缩小格子
  const GAP = 4, MAX_H = 120;
  let size = 12, cols = 1, rows = 1;
  for (; size >= 3; size--) {
    cols = Math.max(1, Math.floor((w + GAP) / (size + GAP)));
    rows = Math.ceil(band.length / cols);
    if (rows * (size + GAP) - GAP <= MAX_H) break;
  }
  const h = rows * (size + GAP) - GAP;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const radius = Math.max(1, size / 3.5);
  const paint = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < band.length; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      const b = band[i];
      const wave = still || !b.status ? 1 : 0.7 + 0.3 * Math.sin(t / 900 - i * 0.12);
      ctx.globalAlpha = b.status ? wave : b.role === 'user' ? 1 : 0.75;
      ctx.fillStyle = b.status ? color(b.status) : css.getPropertyValue('--rule-2').trim();
      ctx.beginPath();
      ctx.roundRect(col * (size + GAP), row * (size + GAP), size, size, radius);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!still) bandFrame = requestAnimationFrame(paint);
  };
  paint(0);
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left) / (size + GAP)), row = Math.floor((e.clientY - r.top) / (size + GAP));
    const b = col < cols ? band[row * cols + col] : undefined;
    canvas.title = b ? `${fmt(b.at)} · ${b.role === 'user' ? '你' : b.role === 'assistant' ? 'AI' : '工具报错'}${b.task ? ` · ${b.task} · ${STATUS[b.status]}` : ' · 没有归入任务'}` : '';
  };
}
window.addEventListener('resize', () => drawBand());

// ---------- 任务详情 ----------
function renderTask(shortId) {
  const { view, sessions } = app.data;
  const pid = esc(app.pid);
  const t = view.tasks.find((x) => short(x.id) === shortId);
  if (!t) return `<a class="back" href="#/p/${pid}">${ic('back')}现场</a><div class="empty">这个任务不存在或已被合并</div>`;
  const others = view.tasks.filter((x) => x.id !== t.id);
  const doneCount = view.doneEvents.filter((d) => d.taskId === t.id).length;
  return `<a class="back" href="#/p/${pid}">${ic('back')}${esc(app.data.project.name)}</a>
  <header class="th">
    <div class="th-meta">${chip(t.status)}<span class="th-id">${esc(short(t.id))}</span></div>
    <h1>${esc(t.name)}</h1>
    <div class="th-a">${t.status === 'to_verify' ? `<button class="btn pri" data-act="confirm-done" data-task="${esc(t.id)}">确认完成</button><button class="btn" data-act="cont" data-task="${esc(t.id)}">继续任务</button>` : `<button class="btn pri" data-act="cont" data-task="${esc(t.id)}">继续任务</button>${t.status !== 'done' && t.status !== 'cancelled' ? `<button class="btn" data-act="confirm-done" data-task="${esc(t.id)}">确认完成</button>` : ''}`}</div>
  </header>
  <div class="td">
    <div class="td-main">
      <section class="sec">
        <h2 class="sec-h">目标</h2>
        <p class="lead">${esc(t.goal ?? t.name)}</p>
        <div class="cond"><span class="cond-k">完成条件</span>${t.doneCondition ? `<span>${esc(t.doneCondition)}</span>${t.doneConditionConfirmed ? basis('user') : ''}` : '<span class="muted">还没确认</span>'}</div>
        <div class="inline"><input type="text" id="cond" placeholder="比如：文件能打开，金额和统计页一致" value="${esc(t.doneCondition ?? '')}"><button class="btn" data-act="condition" data-task="${esc(t.id)}">设为完成条件</button></div>
      </section>
      <section class="sec">
        <h2 class="sec-h">证据<span class="n">${t.evidenceIds.length}</span></h2>
        <div class="evs">${t.evidenceIds.map((id) => { const e = app.data.evidence[id]; return e ? `<label class="evr"><input type="checkbox" class="sp" value="${esc(id)}"><span class="evk">${esc(KIND[e.kind] ?? e.kind)}</span><span class="evd">${esc(e.detail)}</span>${evLink(id)}</label>` : ''; }).join('')}</div>
        <div class="inline"><input type="text" id="sp-name" placeholder="勾选证据，拆成一个新任务"><button class="btn" data-act="split" data-task="${esc(t.id)}">拆出新任务</button></div>
      </section>
      <section class="sec">
        <h2 class="sec-h">经过<span class="sec-note">完成 ${doneCount} 次 · AI 自述不算完成</span></h2>
        <ol class="tl">${t.history.map((h) => `<li class="tl-i">${stIcon(h.to)}<div class="tl-b"><div class="tl-h">${h.from ? `<span class="tl-from">${STATUS[h.from]}</span>${ic('chev')}` : ''}<b>${STATUS[h.to]}</b><time>${fmt(h.at)}</time></div><div class="tl-d">${esc(h.note)}${basis(h.basis)}${evLink(h.evidenceId)}</div></div></li>`).join('')}</ol>
      </section>
    </div>
    <aside class="td-side">
      <section class="card"><h3 class="card-h">现在的依据</h3><p class="card-p">${esc(t.basisNote)}</p><div class="row">${basis(t.basis)}${evLink(t.basisEvidenceId)}</div>${t.blocker ? `<p class="card-p blk-why">缺：${esc(t.blocker)}</p>` : ''}</section>
      <section class="card"><h3 class="card-h">来自这些对话</h3>${t.sessions.map((sid) => { const s = sessions.find((x) => x.id === sid); return s ? `<div class="srow">${avatar(kindOf(s.label), 'idle', { size: 20 })}<span class="srow-l">${esc(s.label)}</span><span class="srow-t">${esc(s.title ?? '')}</span></div>` : ''; }).join('') || '<p class="card-p muted">无</p>'}</section>
      ${hintsHtml(app.data.hints?.[t.id])}
      <details class="card adjust"><summary>调整${ic('chev')}</summary>
        <div class="inline"><select id="st">${Object.keys(STATUS).filter((s) => s !== 'pending_confirm').map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select><button class="btn" data-act="status" data-task="${esc(t.id)}">改状态</button></div>
        <div class="inline"><input type="text" id="nm" value="${esc(t.name)}"><button class="btn" data-act="rename" data-task="${esc(t.id)}">改名</button></div>
        ${others.length ? `<div class="inline"><select id="into">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select><button class="btn" data-act="merge" data-task="${esc(t.id)}">合并进去</button></div>` : ''}
        ${app.projects.length > 1 ? `<div class="inline"><select id="mv-to">${app.projects.filter((p) => p.id !== app.pid).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="btn" data-act="move-task" data-task="${esc(t.id)}">移过去</button></div>` : ''}
        <p class="s">你的修改会保留，之后自动整理不会覆盖；有冲突时进待确认</p>
      </details>
    </aside>
  </div>`;
}

function hintsHtml(h) {
  if (!h || !(h.files.length + h.commits.length + h.links.length)) return '';
  const safe = (u) => (/^https?:\/\//.test(u) ? u : '#'); // 只放 http 和 https，挡住 javascript: 这类链接
  const group = (label, items, fmtItem) => (items.length ? `<div class="hint-g"><span class="hint-k">${label}</span>${items.slice(0, 12).map(fmtItem).join('')}${items.length > 12 ? `<span class="s">等 ${items.length} 个</span>` : ''}</div>` : '');
  return `<section class="card"><h3 class="card-h" title="从引用的消息里提取，不代表已经验证">结果线索</h3>
    ${group('文件', h.files, (f) => `<code>${esc(f)}</code>`)}
    ${group('提交', h.commits, (c) => `<code>${esc(c)}</code>`)}
    ${group('链接', h.links, (l) => `<a class="mono" href="${esc(safe(l))}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`)}</section>`;
}

// ---------- 规划 ----------
function renderPlan() {
  const { view } = app.data;
  const vs = view.plan.versions;
  const sugg = view.pending.filter((p) => p.kind === 'ai_suggestion');
  const mark = { added: '<span class="vi-m add">+</span>', cancelled: '<span class="vi-m cut">−</span>' };
  const backfill = `<section class="card form-card"><h3 class="card-h">补建当前规划</h3>
      <p class="card-p">补建的规划会标上“后补”和创建时间，不当成最初规划</p>
      <div class="checks">${view.tasks.filter((t) => t.status !== 'cancelled').map((t) => `<label class="check"><input type="checkbox" class="bf" value="${esc(t.id)}">${esc(t.name)}</label>`).join('')}</div>
      <label>另外要加的条目，一行一个<textarea id="bf-new" style="min-height:70px"></textarea></label>
      <div><button class="btn pri" data-act="backfill">补建</button></div></section>`;
  return `${header('plan')}
    ${vs.length === 0 ? `<div class="empty">${ic('plan')}读到的记录里没有明确规划${view.coverageWarning ? '<span class="s">有来源只读到一部分，前面可能有没读到的规划</span>' : ''}</div>${backfill}` : `
    <div class="versions">${vs.map((v, i) => `<section class="card ver-card${i === vs.length - 1 ? ' cur' : ''}">
      <div class="ver-h"><b>第 ${v.n} 版</b>${i === 0 && !v.backfilled ? '<span class="tag">最初</span>' : ''}${i === vs.length - 1 ? '<span class="tag on">当前</span>' : ''}${v.backfilled ? '<span class="tag">后补</span>' : ''}<time>${fmt(v.at)}</time></div>
      <ul class="ver">${v.items.map((it) => `<li class="vi ${it.change}">${mark[it.change] ?? '<span class="vi-m"></span>'}<span>${esc(it.name)}</span></li>`).join('')}</ul>
      <div class="ver-ev">${v.evidenceIds.map((id, k) => evLink(id, `依据 ${k + 1}`)).join('')}</div></section>`).join('')}</div>`}
    <section class="sec">
      <h2 class="sec-h">AI 建议<span class="n">${sugg.length}</span><span class="sec-note">你确认前不进范围</span></h2>
      ${sugg.length ? `<div class="rows">${sugg.map((s) => `<div class="rowi sg"><span class="rowi-t">${esc(s.text)}${evLink(s.evidenceId)}</span><span class="rowi-a"><button class="btn sm" data-act="sug-accept" data-task="${esc(s.taskId)}" data-ev="${esc(s.evidenceId)}">纳入</button><button class="btn ghost sm" data-act="ack" data-ev="${esc(s.evidenceId)}">忽略</button></span></div>`).join('')}</div>` : '<p class="none">没有</p>'}
    </section>`;
}

// ---------- 待确认 ----------
function renderInbox() {
  const { view, failed } = app.data;
  const opts = view.tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  const card = (kind, title, body, actions, note = '') => `<article class="card inbox-i k-${kind}${kind === 'unknown' ? '' : ' row'}"><div class="inbox-k">${title}</div><div class="inbox-t">${body}</div><div class="inline wrap">${actions}</div>${note ? `<p class="s">${note}</p>` : ''}</article>`;
  const item = (p) => {
    const text = `${esc(p.text)}${evLink(p.evidenceId)}`;
    if (p.kind === 'unknown_task') return card('unknown', '归属拿不准', text, `${opts ? `<select id="as-${esc(p.evidenceId)}">${opts}</select><button class="btn" data-act="assign" data-ev="${esc(p.evidenceId)}">归入</button>` : ''}<input type="text" id="nt-${esc(p.evidenceId)}" placeholder="或者起个新任务名"><button class="btn" data-act="new-task" data-ev="${esc(p.evidenceId)}">设为新任务</button><button class="btn ghost" data-act="ack" data-ev="${esc(p.evidenceId)}">忽略</button>`);
    if (p.kind === 'source_conflict') return card('conflict', '两段对话说法相反', text, `<button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">保留现在的状态</button>${p.suggestedStatus ? `<button class="btn pri" data-act="conflict-apply" data-task="${esc(p.taskId)}" data-status="${esc(p.suggestedStatus)}" data-ev="${esc(p.evidenceId)}">按后一段改为${STATUS[p.suggestedStatus]}</button>` : ''}`, '导入网页对话时填上大约日期，就能避免这类冲突');
    if (p.kind === 'conflict') return card('conflict', '新证据和你的修正冲突', text, `<button class="btn" data-act="ack" data-ev="${esc(p.evidenceId)}">保留我的修正</button>${p.suggestedStatus ? `<button class="btn pri" data-act="conflict-apply" data-task="${esc(p.taskId)}" data-status="${esc(p.suggestedStatus)}" data-ev="${esc(p.evidenceId)}">按新证据改为${STATUS[p.suggestedStatus]}</button>` : ''}`);
    return card('ai', 'AI 建议', text, `<button class="btn pri" data-act="sug-accept" data-task="${esc(p.taskId)}" data-ev="${esc(p.evidenceId)}">纳入</button><button class="btn ghost" data-act="ack" data-ev="${esc(p.evidenceId)}">忽略</button>`);
  };
  return `${header('inbox')}
    ${failed.length ? `<div class="banner err">${failed.length} 批对话整理失败：${esc(failed[0].error)}<button class="link" data-act="sync">重新整理</button></div>` : ''}
    ${view.pending.length ? `<div class="inbox">${view.pending.map(item).join('')}</div>` : `<div class="calm big">${avatar('codex', 'completed', { size: 44 })}<span>都处理完了</span></div>`}`;
}

// ---------- 设置 ----------
function dirRows(dirs, canBind) {
  return `<div class="rows">${dirs.map(([dir, n]) => {
    const cut = dir.replace(/\/+$/, '').lastIndexOf('/');
    const name = dir.slice(cut + 1) || dir, parent = cut > 0 ? dir.slice(0, cut) : '/';
    return `<div class="dir-row"><div class="dir-n" title="${esc(dir)}"><b>${esc(name)}</b><span>${esc(parent)}</span></div><span class="dir-c">${n} 个会话</span>${canBind ? `<button class="btn sm" data-act="bind" data-dir="${esc(dir)}">绑定</button>` : ''}</div>`;
  }).join('')}</div>`;
}

async function renderSettings() {
  const s = await api('/api/sources');
  const status = (src) => (!src.installed ? '<span class="dot d-off"></span>没装' : src.sessions ? `<span class="dot d-ok"></span>已读到` : '<span class="dot d-off"></span>还没读到');
  const projectOpts = app.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === app.pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const project = app.pid && app.data ? app.data.project : null;
  const src = (name, kind, x, scope, ver) => `<div class="src">${avatar(kind, x.sessions ? 'idle' : 'closed', { size: 26 })}<div class="src-b"><div class="src-n">${name}${ver ? `<span class="s">${esc(ver)}</span>` : ''}</div><div class="src-d" title="${scope}">${x.sessions} 个会话 · ${x.messages} 条</div></div><div class="src-st">${status(x)}</div></div>`;
  return `<header class="ph"><div class="ph-main"><h1>设置</h1><p class="ph-goal">数据都存在本机</p></div><div class="ph-side">${s.lastSyncAt ? `<span class="ph-time">${fmt(s.lastSyncAt)}</span>` : ''}<button class="btn" data-act="sync">${ic('sync')}同步</button></div></header>
  <div class="settings">
    <section class="sec">
      <h2 class="sec-h">对话来源${s.badLines ? `<span class="sec-note">${s.badLines} 行格式异常已跳过</span>` : ''}</h2>
      <div class="srcs">
        ${src('Claude Code', 'claude', s.claudeCode, '只读已绑定目录下的会话；子 agent 的会话暂不读取', s.claudeCode.version)}
        ${src('Codex', 'codex', s.codex, '只读已绑定目录下的会话；工具报错暂不读取', s.codex.version)}
        ${src('VS Code 聊天', 'web', s.vscode, 'VS Code 自带的聊天面板，按工作区文件夹归属；VS Code 里的 Claude Code、Codex 扩展算在上面两行')}
        <div class="src">${avatar('web', 'idle', { size: 26 })}<div class="src-b"><div class="src-n">网页 AI</div><div class="src-d" title="只包含你粘贴的部分；原始时间拿不到时记采集时间">${s.imports.sessions} 段 · ${s.imports.messages} 条</div></div><div class="src-st"><span class="dot d-ok"></span>手动导入</div></div>
      </div>
    </section>
    ${project && !STATIC ? `<section class="sec"><h2 class="sec-h">工作目录<span class="sec-note">${esc(project.name)}</span></h2>
      ${project.dirs.length ? `<ul class="dirs">${project.dirs.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul>` : ''}
      <div class="inline"><input id="crew-bind-dir" placeholder="/path/to/project" aria-label="本机目录（绝对路径）"><button class="btn" data-act="bind-workspace">绑定并打开终端</button></div></section>` : ''}
    ${s.skippedDirs.length ? `<section class="sec"><h2 class="sec-h">没绑定的目录<span class="n">${s.skippedDirs.length}</span>${projectOpts ? `<label class="sec-note bd-to">绑定到<select id="bd-target" aria-label="绑定到项目">${projectOpts}</select></label>` : ''}</h2>
      <p class="sec-sub">这些目录里有对话，还没归到任何项目</p>
      ${dirRows(s.skippedDirs.slice(0, 5), !!projectOpts)}${s.skippedDirs.length > 5 ? `<details class="fold"><summary>其余 ${s.skippedDirs.length - 5} 个</summary>${dirRows(s.skippedDirs.slice(5), !!projectOpts)}</details>` : ''}</section>` : ''}
    <section class="sec"><h2 class="sec-h">导入网页 AI 的对话</h2>
      <div class="grid2">
        <div class="card form-card"><h3 class="card-h">粘贴</h3>
          <div class="fields">
            <label>导入到<select id="im-p">${projectOpts}</select></label>
            <label>来源<select id="im-l"><option>Gemini 网页</option><option>ChatGPT 网页</option><option>Claude 网页</option><option>其他网页 AI</option></select></label>
          </div>
          <label>标题<input type="text" id="im-t" placeholder="比如：需求讨论"></label>
          <div class="fields">
            <label>大约发生在<input type="date" id="im-d"></label>
            <label>原页面链接<input type="text" id="im-u" placeholder="https://"></label>
          </div>
          <label>对话内容<textarea id="im-x" placeholder="用“你：”“Gemini：”这样的开头区分发言者"></textarea></label>
          <label class="check"><input type="checkbox" id="im-partial">只复制了一部分，前面还有没加载的</label>
          <div><button class="btn pri" data-act="import">导入</button></div>
        </div>
        <div class="card form-card"><h3 class="card-h">Google Takeout</h3>
          <p class="card-p" title="网页版的聊天在“我的活动 → Gemini Apps”里（格式选 JSON）；只勾“Gemini”只会导出 Workspace 侧边栏的对话；缺回复的对话会标为部分">选 Takeout 的 zip 包，网页版聊天在“我的活动 → Gemini Apps”</p>
          <label>导入到<select id="tk-p">${projectOpts}</select></label>
          <input type="file" id="tk-file" accept=".zip,.json,application/zip,application/json">
          <div><button class="btn" data-act="tk-preview">读取文件</button></div>
          <div id="tk-list"></div>
        </div>
      </div>
    </section>
    ${project ? `<section class="sec"><h2 class="sec-h">${esc(project.name)}</h2>
      <div class="card">
        <div class="ctl"><div><b>${project.paused ? '采集已暂停' : '正在采集'}</b><p class="s">暂停后不再读新对话，已有数据保留</p></div><button class="btn" data-act="pause" data-paused="${project.paused ? '1' : '0'}">${project.paused ? '恢复采集' : '暂停采集'}</button></div>
        <div class="ctl"><div><b>重新整理</b><p class="s">换了提示词或模型之后用；任务编号和你的修正保留</p></div><button class="btn" data-act="reextract">重新整理</button></div>
        <div class="ctl"><div><b>删除项目</b><p class="s">连同对话、任务和修正一起删，不能恢复；本机原始记录不受影响</p></div><button class="btn dg" data-act="delete">删除项目</button></div>
      </div>
      <h3 class="sub-h">会话<span class="n">${app.data.sessions.length}</span><span class="sec-note">归错了可以移出，移出后它得出的结论一并删掉</span></h3>
      <div class="rows">${app.data.sessions.map((x) => `<div class="rowi">${avatar(kindOf(x.label), 'idle', { size: 20 })}<span class="rowi-t">${esc(x.label)} <span class="s">${esc(x.title ?? '')}</span></span><span class="s">${x.messages} 条${x.coverage === 'partial' ? ' · 部分' : ''}</span><span class="rowi-a"><button class="btn ghost sm dg" data-act="exclude" data-sid="${esc(x.id)}">移出</button></span></div>`).join('') || '<p class="none">还没有会话</p>'}</div>
      <p class="usage" title="只记次数，不记内容">${usageLine(await api(`/api/projects/${app.pid}/usage`))}</p>
    </section>` : ''}
    <section class="sec"><h2 class="sec-h">新建项目</h2>
      <div class="card form-card">
        <div class="fields"><label>名称<input type="text" id="np-n"></label><label>一句话目标<input type="text" id="np-g"></label></div>
        <label>代码目录（绝对路径）<input type="text" id="np-d" placeholder="/path/to/project"></label>
        <div><button class="btn pri" data-act="create">建项目</button></div>
      </div>
    </section>
    <p class="fine">整理使用远程模型 ${esc(s.model)}，只发送已绑定项目的对话正文。读取时把像密钥、令牌的内容换成“[已隐藏的凭证]”，只覆盖常见格式，特别敏感的对话请自己再核对。</p>
  </div>`;
}

function usageLine(u) {
  const n = (k) => u[k] ?? 0;
  const corrections = Object.entries(u).filter(([k]) => k.startsWith('correction_')).reduce((a, [, v]) => a + v, 0);
  return `打开 ${n('open_project')} 次 · 同步 ${n('sync')} 次 · 查看续接上下文 ${n('context_view')} 次 · 复制 ${n('context_copy')} 次 · 采纳下一步 ${n('next_accept')} 次 · 人工修正 ${corrections} 次`;
}

function renderWelcome() {
  return `<div class="welcome">
    <img src="logo.svg" alt="" width="56" height="56">
    <h1>打开一个项目</h1>
    <p>在一个窗口里和 Codex、Claude Code 一起推进它</p>
    <div class="card form-card">
      <label>名称<input type="text" id="np-n" placeholder="比如：记账小程序"></label>
      <label>一句话目标<input type="text" id="np-g" placeholder="做成什么样算完成"></label>
      <label>工作目录<input type="text" id="np-d" placeholder="/path/to/project"></label>
      <button class="btn pri wide" data-act="create">打开项目</button>
    </div></div>`;
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
  drawer.innerHTML = `<div class="dr-h"><b>原文</b><button class="icon-btn" data-act="close-drawer" aria-label="关闭">${ic('x')}</button></div>
    <p class="dr-why">${esc(ev.detail)}${ev.reason ? `<span>${esc(ev.reason)}</span>` : ''}</p>
    ${msgs.map((m) => `<article class="msg msg-${m.role}">
      <div class="msg-h">${m.role === 'user' ? '<span class="me">你</span>' : avatar(kindOf(m.session?.label ?? ''), 'idle', { size: 20 })}<span>${m.role === 'user' ? '' : esc(m.session?.label)}${m.session?.title ? `「${esc(m.session.title)}」` : ''}</span><time title="${m.ts ? '原始时间' : '原始时间未知，这是采集时间'}">${m.ts ? fmt(m.ts) : `采集于 ${fmt(m.capturedAt)}`}</time></div>
      ${m.replacedBy ? '<span class="basis b-ai">后来改过，这是旧版本</span>' : ''}
      <div class="q"${m.replacedBy ? ' style="text-decoration:line-through;opacity:.7"' : ''}>${esc(m.text)}</div>
      ${m.replacedBy && latest.get(m.replacedBy) ? `<div class="s">改成了</div><div class="q">${esc(latest.get(m.replacedBy).text)}</div>` : ''}
      <div class="msg-f">${who[m.role]} · 第 ${m.seq + 1} 条${m.session?.coverage === 'partial' ? ' · 只读到一部分' : ''}
      ${m.session?.url && /^https?:\/\//.test(m.session.url) ? `<a class="link" href="${esc(m.session.url)}" target="_blank" rel="noopener noreferrer">打开原页面</a>` : ''}
      ${m.session?.source === 'import' ? `<button class="link" data-act="role" data-msg="${esc(m.id)}" data-role="${m.role === 'user' ? 'assistant' : 'user'}">发言者认错了，改成${m.role === 'user' ? 'AI' : '你'}</button>` : ''}</div>
    </article>`).join('')}`;
}

// ---------- 续接上下文 ----------
async function openContext(taskId) {
  const { text } = await api(`/api/projects/${app.pid}/context?task=${encodeURIComponent(taskId)}`);
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="card" role="dialog" aria-label="继续任务">
    <div class="dr-h"><b>继续任务</b><button class="icon-btn" data-act="close-modal" aria-label="关闭">${ic('x')}</button></div>
    <p class="s">可以删改后再复制。粘贴到 Codex 或 Claude Code 并发送，才算真正开始</p>
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
  'mcp-join'() {
    const modal = $('#modal');
    modal.hidden = false;
    modal.innerHTML = `<div class="card" role="dialog" aria-label="让 Agent 自己报到">
      <div class="dr-h"><b>让 Agent 自己报到</b><button class="icon-btn" data-act="close-modal" aria-label="关闭">${ic('x')}</button></div>
      <p class="s">接上之后，Claude Code、Codex 干活时会自己来办公室报到：开工、交活、卡住都直接出现在这里，不用等你点同步。它们说做完只算待验证，还是由你确认。</p>
      <div class="mcp-steps">
        <div><h4>Claude Code</h4><pre>claude mcp add crew --scope user -- crew mcp</pre></div>
        <div><h4>Codex（写进 ~/.codex/config.toml）</h4><pre>[mcp_servers.crew]
command = "crew"
args = ["mcp"]</pre></div>
      </div>
      <ul class="mcp-tools">
        <li><code>project_status</code> 开工前看现场</li>
        <li><code>check_in</code> 坐到桌前开始做某个任务</li>
        <li><code>hand_in</code> 交活，纸会飞进你的收件盘</li>
        <li><code>raise_hand</code> 卡住了，举手找你</li>
        <li><code>propose_task</code> 提一个新任务，等你采纳</li>
      </ul></div>`;
  },
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
      if (err.status === 428) toast('先在现场页点一次“同步”并同意发送说明');
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
    const pid = $('#bd-target').value;
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
      ${data.conversations.map((c) => `<label class="check tk-row"><input type="checkbox" class="tk" value="${esc(c.key)}"><span class="s">${esc(c.start.slice(0, 10))}</span><span class="s">${esc(c.source)}</span><span>${esc(c.title)}</span><span class="s">${c.turns} 条${c.missingResponse ? ' · 缺回复' : ''}</span></label>`).join('')}
      <div><button class="btn pri" data-act="tk-import" data-token="${esc(data.token)}" data-pid="${esc(pid)}">导入所选</button></div>` : '<div class="muted">没有找到 Gemini 对话。网页版的聊天要在 Takeout 里勾“我的活动 → Gemini Apps”；Gemini 活动记录被关掉时导出也是空的。</div>';
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
if (STATIC) document.body.insertAdjacentHTML('afterbegin', `<div class="demo-bar"><span>只读示例</span><a href="https://github.com/Longado/crew">装到本机 →</a></div>`);
// 第一次打开时只读一次新对话（不整理、不调用模型），切换页面时不重复读
const initialPage = parseHash().page;
// Live terminals must not wait behind the legacy synchronous conversation scan.
const initialRead = !STATIC && ['home', 'workspace', 'new', 'team', 'security', 'today'].includes(initialPage) ? Promise.resolve() : api('/api/read', { method: 'POST' }).catch(() => {});
initialRead.finally(() => {
  load().catch((err) => { $('#main').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
});
