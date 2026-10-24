import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const between = (from: string, to: string) => {
  const start = app.indexOf(from), end = app.indexOf(to);
  assert.ok(start >= 0 && end > start, `${from} ... ${to} not found in web/app.js`);
  return app.slice(start, end);
};
// parseHash + 按路由选项目的纯函数 + load() + renderNav，放进 vm 跑；其余依赖用桩。
const code = between('function parseHash()', 'function header(active)');

const projects = [{ id: 'first', name: 'First' }, { id: 'x', name: 'X' }];
function harness(hash: string, opts: { pid?: string | null; staticDemo?: boolean } = {}) {
  const requests: string[] = [];
  const els = new Map<string, any>();
  const el = (sel: string) => {
    if (sel === '#nav .crew-project-search') return null;
    if (!els.has(sel)) els.set(sel, { innerHTML: '', hidden: false, querySelectorAll: () => [] });
    return els.get(sel);
  };
  const dock = { hidden: false };
  const mounts: string[] = [];
  const location = { hash };
  const ctx: any = {
    location, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null },
    STATIC: opts.staticDemo ?? false, Promise, JSON,
    api: async (path: string) => {
      requests.push(path);
      if (path === '/api/state') return { projects, model: 'm', lastSyncAt: null };
      const id = path.replace('/api/projects/', '');
      return { project: { id, name: `Name-${id}`, dirs: [] }, view: { pending: [] }, sessions: [], failed: [] };
    },
    $: el, esc: (s: any) => String(s ?? ''), fmt: (s: any) => String(s),
    document: { getElementById: () => dock, body: { classList: { toggle() {} } } },
    mountSecurity: (_root: any, o: any) => { mounts.push(`security:${o.projectId ?? ''}:${o.projectName ?? ''}`); return () => {}; },
    mountToday: () => () => {}, mountWorkspace: () => () => {}, mountTeam: async () => () => {},
    mountTeamDock: (_root: any, o: any) => { mounts.push(`dock:${o.projectId}`); return () => {}; },
    drawBand() {}, toast() {}, renderWelcome: () => '', renderSettings: async () => '', renderOverview: () => '', renderInbox: () => '', renderPlan: () => '', renderTask: () => '',
  };
  vm.createContext(ctx);
  const api = vm.runInContext(`let app = { projects: [], model: 'm', lastSyncAt: null, pid: ${JSON.stringify(opts.pid ?? null)}, data: null };
let loadVersion = 0, unmountTeam = null, unmountDock = null, unmountWorkspace = null, unmountSecurity = null, unmountToday = null;
${code}
({ load, renderNav, parseHash, routeProject: typeof routeProject === 'function' ? routeProject : undefined, state: () => app });`, ctx);
  return { ...api, location, requests, dock, mounts, nav: () => els.get('#nav')?.innerHTML ?? '' };
}

test('route picks a project only where the route or the page calls for one', () => {
  const h = harness('#/');
  assert.equal(typeof h.routeProject, 'function');
  const pick = (hash: string, current: string | null = null) => { h.location.hash = hash; return h.routeProject(h.parseHash(), current, projects); };
  assert.equal(pick('#/security', 'x'), null);
  assert.equal(pick('#/today', 'x'), null);
  assert.equal(pick('#/p/x/security', 'first'), 'x');
  assert.equal(pick('#/p/x/workspace', 'first'), 'x');
  assert.equal(pick('#/settings', 'x'), 'x');
  assert.equal(pick('#/settings'), 'first');
  assert.equal(pick('#/new'), 'first');
});

test('global security page selects no project, asks for none, hides the team dock and the project nav', async () => {
  const h = harness('#/security', { pid: 'x' });
  await h.load();
  assert.deepEqual(h.requests, ['/api/state']);
  assert.equal(h.state().pid, null);
  assert.equal(h.dock.hidden, true);
  assert.deepEqual(h.mounts, ['security::']);
  const nav = h.nav();
  assert.doesNotMatch(nav, /终端工作台|>团队<|项目记忆|待确认|项目凭证与安全/);
  assert.doesNotMatch(nav, /class="on"[^>]*>(First|X)</);
  assert.match(nav, /class="on">凭证与安全/);
  assert.doesNotMatch(nav, /class="foot"/);
});

test('project security page still opens its project, team dock and project nav', async () => {
  const h = harness('#/p/x/security');
  await h.load();
  assert.deepEqual(h.requests, ['/api/state', '/api/projects/x']);
  assert.equal(h.state().pid, 'x');
  assert.equal(h.dock.hidden, false);
  assert.deepEqual(h.mounts, ['security:x:Name-x', 'dock:x']);
  const nav = h.nav();
  assert.match(nav, /项目凭证与安全/);
  assert.match(nav, /项目记忆/);
  assert.match(nav, /class="foot"/);
});

test('sidebar footer (model and last sync) shows only with a selected project', async () => {
  const today = harness('#/today'); await today.load();
  assert.doesNotMatch(today.nav(), /class="foot"|整理模型/);
  const project = harness('#/p/x/security'); await project.load();
  assert.match(project.nav(), /class="foot">整理模型：m<br>上次同步：本次打开后还没同步/);
});

test('leaving the global security or today page returns to the project in use, not the first one', async () => {
  for (const projectless of ['#/security', '#/today']) {
    const h = harness('#/p/x/workspace');
    await h.load();
    h.location.hash = projectless; await h.load();
    assert.equal(h.state().pid, null);
    h.location.hash = '#/settings'; await h.load();
    assert.equal(h.state().pid, 'x', `${projectless} -> #/settings`);
  }
});
