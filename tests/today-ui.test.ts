import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const modulePath = new URL('../web/today.js', import.meta.url);
const source = () => existsSync(modulePath) ? readFileSync(modulePath, 'utf8').replace('export function mountToday', 'function mountToday') : '';
const empty = () => ({
  date: '2026-10-20', timeZone: 'Asia/Taipei', generatedAt: '2026-10-20T03:00:00Z',
  source: { kind: 'workspace_snapshot', label: '外部任务库 · 只读快照', automatic: false, configured: true, refreshedAt: '2026-10-20T03:00:00Z' },
  projects: [], totalTasks: 0, matchingTasks: 0, suggested: [], remaining: [], blocked: [], pending: [], completed: [],
});
function harness(api?: any, staticDemo = false) {
  let html = '', writes = 0;
  const feedback = { textContent: '' };
  const root: any = {
    set innerHTML(value: string) { html = value; writes++; },
    querySelector: (selector: string) => selector === '[data-today-feedback]' ? feedback : null,
    querySelectorAll: () => [],
  };
  const requests: any[] = [];
  const context: any = {};
  vm.createContext(context);
  vm.runInContext(source() + ';this.mount = typeof mountToday === "function" ? mountToday : null;', context);
  assert.equal(typeof context.mount, 'function', 'today page should be available');
  const unmount = context.mount(root, { staticDemo, api: async (path: string, options: any) => {
    requests.push({ path, ...options });
    return api ? api(path, options) : empty();
  } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const submit = async (kind: string, values: Record<string, string>, extra = {}) => {
    const form = { dataset: { todayForm: kind, ...extra }, elements: { namedItem: (key: string) => ({ value: values[key] ?? '' }) } };
    await root.onsubmit({ target: form, preventDefault() {} });
  };
  return { root, requests, flush, submit, unmount, html: () => html, writes: () => writes, feedback };
}

test('today automatically refreshes the configured snapshot; the user can filter by task keyword without filling tasks', async () => {
  const f = harness(); await f.flush();
  assert.match(f.html(), /还没有可用任务快照/);
  assert.match(f.html(), /外部任务库/);
  assert.match(f.html(), /data-today-form="search"/);
  assert.doesNotMatch(f.html(), /name="projectName"|data-today-form="add"/);
  assert.deepEqual(f.requests.map(r => r.path), ['/api/today/refresh']);
  assert.equal(f.requests[0].method, 'POST');
  await f.submit('search', { query: '项目 A' });
  assert.equal(f.requests[1].path, '/api/today?q=' + encodeURIComponent('项目 A'));
  f.unmount();
});

test('source failure shows the cached snapshot date and offers no status writeback', async () => {
  const f = harness(async (path: string) => {
    if (path.includes('/refresh')) throw Error('来源暂时无法读取');
    return empty();
  }); await f.flush();
  assert.deepEqual(f.requests.map(r => r.path), ['/api/today/refresh', '/api/today']);
  assert.match(f.feedback.textContent, /已保存的内容/);
  assert.match(f.html(), /快照更新/);
  assert.doesNotMatch(f.html(), /data-today-form="status"/);
  f.unmount();
});

test('unconfigured source keeps local tasks visible and does not suggest an unavailable entrypoint', async () => {
  const data: any = empty();
  data.source = { kind: 'local_corpus', label: '当前 Crew 本地任务库', configured: false, refreshedAt: null };
  data.totalTasks = data.matchingTasks = 1;
  data.suggested = [{ taskId: 'p/T01', projectId: 'p', projectName: '本地示例', name: '本地待办', status: 'todo' }];
  const f = harness(async (path: string) => {
    if (path.includes('/refresh')) throw Object.assign(Error('尚未配置可搜索的任务来源'), { status: 409 });
    return data;
  });
  await f.flush();
  assert.match(f.html(), /本地待办/);
  assert.match(f.html(), /尚未配置外部任务来源，仅展示 Crew 本地任务/);
  assert.match(f.feedback.textContent, /尚未配置/);
  assert.doesNotMatch(f.html(), /请使用本地管家入口|打开此页时自动搜索并保存快照/);
  f.unmount();
});

test('task text is escaped, reasons and conditions are visible, and late results cannot redraw after leaving', async () => {
  const data: any = empty();
  data.totalTasks = 1;
  data.suggested = [{
    taskId: 'p/T01', projectId: 'p', projectName: '<project>', name: '<script>bad</script>', status: 'to_verify',
    reason: '先核对已有产出', action: '核对内容', precondition: '<wait>', doneStandard: '满足三项条件',
  }];
  const f = harness(async () => data); await f.flush();
  assert.match(f.html(), /&lt;script&gt;/);
  assert.doesNotMatch(f.html(), /<script>/);
  assert.match(f.html(), /先核对已有产出/);
  assert.match(f.html(), /&lt;wait&gt;/);
  assert.match(f.html(), /满足三项条件/);
  f.unmount();
  let resolve!: (data: any) => void;
  const late = harness(() => new Promise(r => { resolve = r; }));
  late.unmount(); const writes = late.writes();
  resolve(data); await late.flush();
  assert.equal(late.writes(), writes);
});

test('failed search keeps the input form and shows an error; static demo makes no requests', async () => {
  const f = harness(async (path: string) => {
    if (path.includes('?q=')) throw Error('搜索失败，请重试');
    return empty();
  });
  await f.flush();
  const writes = f.writes();
  await f.submit('search', { query: '查找' });
  assert.equal(f.writes(), writes, 'do not replace the form and lose entered text');
  assert.match(f.feedback.textContent, /搜索失败/);
  f.unmount();
  const demo = harness(undefined, true); await demo.flush();
  assert.equal(demo.requests.length, 0); assert.match(demo.html(), /本机/); demo.unmount();
});

test('today has a global empty-state route and manual entry, without conversation ingestion or team dock', async () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /['"]#\/today['"]/);
  assert.ok(app.indexOf("if (r.page === 'today')") < app.indexOf("else if (!app.projects.length"));
  assert.match(app, /unmountToday\?\.\(\)/);
  assert.match(app, /dock.hidden = .*r.page === 'today'/);
  const startup = app.slice(app.indexOf('const initialPage = parseHash().page;'));
  const parser = app.slice(app.indexOf('function parseHash()'), app.indexOf('async function load()'));
  let reads = 0, loads = 0;
  vm.runInNewContext(parser + startup, { location: { hash: '#/today' }, STATIC: false, Promise,
    api: () => { reads++; return new Promise(() => {}); }, load: async () => { loads++; }, $: () => ({}), esc: String });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.equal(loads, 1);
});
