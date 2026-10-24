import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (file: string, name: string) => {
  const context: any = { setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(context);
  const source = readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8').replace(`export function ${name}`, `function ${name}`);
  vm.runInContext(`${source};this.mount=${name};`, context);
  return context.mount;
};
const flush = () => new Promise(resolve => setImmediate(resolve));

async function today(data: any) {
  let html = '';
  const root: any = { set innerHTML(value: string) { html = value; }, querySelector: () => null, querySelectorAll: () => [] };
  const unmount = load('today.js', 'mountToday')(root, { api: async () => data });
  await flush(); unmount();
  return html;
}
const task = (n: number, extra: any = {}) => ({
  taskId: `workspace:${n}`, projectId: 'workspace:1', projectName: `Project ${n}`, name: `Task ${n}`, status: 'todo',
  sourceId: n, sourceKind: 'workspace', sourceUpdatedAt: '2026-10-20', priority: 'medium', dueDate: null,
  action: `推进：Task ${n}`, reason: `reason ${n}`, precondition: 'same wait', doneStandard: 'same done', updatedAt: '2026-10-20', ...extra,
});
const todayData = (groups: any) => ({
  date: '2026-10-23', timeZone: 'Asia/Taipei', generatedAt: '2026-10-23T00:00:00Z',
  source: { kind: 'workspace_snapshot', label: 'snapshot', configured: true, refreshedAt: '2026-10-23T00:00:00Z' },
  projects: [], totalTasks: 9, matchingTasks: 9, suggested: [], remaining: [], blocked: [], pending: [], completed: [], ...groups,
});

test('today keeps full cards only for suggestions; other groups are one expandable row per task', async () => {
  const html = await today(todayData({
    suggested: [task(1), task(2)],
    remaining: [task(3, { dueDate: '2026-11-01' }), task(4)],
    blocked: [task(5, { status: 'blocked' })],
    pending: [task(6, { status: 'todo', holdReason: 'old' })],
  }));
  assert.equal((html.match(/class="today-card"/g) || []).length, 2);
  assert.equal((html.match(/<details class="today-row"/g) || []).length, 4);
  const row = html.match(/<details class="today-row">(?:(?!<\/details>)[\s\S])*?Task 3[\s\S]*?<\/details>/)?.[0] ?? '';
  const summary = row.match(/<summary>[\s\S]*?<\/summary>/)?.[0] ?? '';
  for (const part of [/Task 3/, /Project 3/, /#3/, /待开始/, /截止 2026-11-01/]) assert.match(summary, part);
  assert.match(row.slice(summary.length), /reason 3/, 'details open on click');
});

test('today drops a next step that only repeats the title and states identical conditions once per group', async () => {
  const html = await today(todayData({
    suggested: [task(1), task(2, { action: '先联系对方确认时间' })],
    remaining: [task(3), task(4), task(5)],
  }));
  assert.doesNotMatch(html, /推进：Task/);
  assert.match(html, /先联系对方确认时间/);
  assert.equal((html.match(/same wait/g) || []).length, 2, 'once for suggestions, once for the remaining group');
  assert.equal((html.match(/same done/g) || []).length, 2);
});

test('today shows a single card condition on the card itself and hides an empty wait condition', async () => {
  const html = await today(todayData({ suggested: [task(1, { precondition: '无' })], remaining: [task(2, { precondition: '等审批' })] }));
  assert.doesNotMatch(html, /等待条件<\/dt><dd>无|无已知等待条件/);
  assert.match(html, /<dt>完成条件<\/dt><dd>same done/);
  assert.match(html, /<dt>等待条件<\/dt><dd>等审批/);
});

async function security(catalog: any, projectId?: string, project?: any) {
  let html = '';
  const root: any = { set innerHTML(value: string) { html = value; }, onclick: null, querySelector: () => null };
  const unmount = load('security.js', 'mountSecurity')(root, { projectId, api: async (path: string) => path.endsWith('/credentials') ? catalog : project });
  await flush(); unmount();
  return html;
}
const runUsage = 'run with approval <cmd>';
const key = (n: number) => ({ id: `local:${n}`, name: `Key ${n}`, storage: 'macos-keychain', usageInstructions: runUsage,
  environmentVariables: [`KEY_${n}`], canProbe: false, runnable: true, usage: { approved: n, denied: 0, timeout: 0, unavailable: 0 } });
const keychain = { status: 'available', nativeAvailable: false, scanAvailable: true, localStore: { status: 'available', count: 3 }, credentials: [key(1), key(2), key(3)] };

test('security banner describes approved use, not the fake-key experiment, when native input is not configured', async () => {
  const html = await security(keychain);
  assert.match(html, /本地凭证库：由 macOS 钥匙串保存/);
  assert.match(html, /最近使用/);
  assert.doesNotMatch(html, /尚未接入|假 Key|隔离测试/);
  assert.doesNotMatch(html, /data-security="(input|probe)"/);
  assert.doesNotMatch(html, /原生录入与检测不可用/);
});

test('security lists one line per key and the shared usage instruction once', async () => {
  const html = await security(keychain);
  assert.equal((html.match(/run with approval &lt;cmd&gt;/g) || []).length, 1);
  assert.equal((html.match(/逐次授权取用（每次 Touch ID 或密码）/g) || []).length, 1);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`<li><strong>Key ${n}</strong>[^\\n]*KEY_${n}[^\\n]*已批准 ${n} 次[^\\n]*</li>`));
});

test('native fake-key input stays available and labelled when a helper is configured', async () => {
  const html = await security({ ...keychain, nativeAvailable: true, credentials: [{ id: 'fake', name: 'Fake', usageInstructions: 'offline', environmentVariables: ['ARK_API_KEY'], canProbe: true }] });
  assert.match(html, /data-security="input"/);
  assert.match(html, /data-security="probe"/);
  assert.match(html, /仅使用假 Key/);
});

test('scan time is shown in local time, not the raw UTC string', async () => {
  const scannedAt = '2026-10-23T07:35:54.981Z';
  const scan = { scannedAt, checkedFiles: 20, complete: true, summary: { high: 0, review: 0, low: 0 }, coverageNotes: [], findings: [] };
  const html = await security(keychain, 'p', { directories: [{ id: 'd', label: 'dir' }], latestScan: { result: { scan } } });
  assert.doesNotMatch(html, /07:35:54\.981Z/);
  assert.ok(html.includes(`扫描时间：${new Date(scannedAt).toLocaleString('zh-CN', { hour12: false })}`));
});
