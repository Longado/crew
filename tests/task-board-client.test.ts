import { test } from 'node:test';
import assert from 'node:assert/strict';

async function client(options: Record<string, unknown> = {}) {
  const mod = await import('../src/task-board-client.ts');
  return new mod.TaskBoardClient({ workspace: '/tmp/crew-fixture', manifest: '/tmp/crew-fixture/清单.json', ...options });
}

test('store actions pass bounded arguments and preserve cancellation sync warnings', async () => {
  const calls: string[][] = [];
  const c = await client({ runCommand: async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { stdout: JSON.stringify({ task: { task_id: 7, status: 'cancelled' }, manifest_synced: false, sync_warning: 'Read-only manifest' }), stderr: '' };
  } });
  const result = await c.cancel(7, 'blocked', '用户决定终止，保留成果');
  assert.equal(result.manifest_synced, false);
  assert.equal(result.sync_warning, 'Read-only manifest');
  assert.equal(calls[0][0], 'python3');
  assert.ok(calls[0].includes('--workspace'));
  assert.deepEqual(calls[0].slice(-8), ['--action', 'cancel', '--task', '7', '--expected-status', 'blocked', '--note', '用户决定终止，保留成果']);
});

test('list/get/status share the store adapter and reject invalid task IDs before running', async () => {
  const actions: string[] = [];
  const c = await client({ runCommand: async (_file: string, args: string[]) => {
    actions.push(args[args.indexOf('--action') + 1]);
    return { stdout: '{}', stderr: '' };
  } });
  await c.list(); await c.get(1); await c.status(1);
  assert.deepEqual(actions, ['list', 'get', 'status']);
  await assert.rejects(c.get(0), /正整数/);
  await assert.rejects(c.cancel(1, 'blocked', ' '), /终止原因/);
  assert.equal(actions.length, 3);
});

test('dispatch defaults to read-only and stop sends only the selected run ID', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const c = await client({ fetch: async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : { workspace: '/tmp/crew-fixture', manifest: '/tmp/crew-fixture/清单.json' }));
  } });
  await c.dispatch(3, '核对范围');
  assert.equal(requests[1].url, 'http://127.0.0.1:6480/api/dispatch');
  assert.equal(new Headers(requests[1].init?.headers).get('x-corpus'), '1');
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { task_id: 3, access: 'read-only', goal: '核对范围' });
  await c.dispatch(3, '修改隔离副本', true);
  assert.equal(JSON.parse(String(requests[3].init?.body)).access, 'workspace-write');
  await c.stop('exact-run');
  assert.deepEqual(JSON.parse(String(requests[5].init?.body)), { job_id: 'exact-run' });
});

test('unsafe service URLs, service mismatch and unreachable service cannot dispatch', async () => {
  for (const boardUrl of ['https://localhost:6480', 'http://example.com', 'http://user:pass@localhost:6480', 'http://localhost:6480/other']) {
    await assert.rejects(client({ boardUrl }), /本地 HTTP/);
  }
  let posts = 0;
  const c = await client({ fetch: async (_url: string, init?: RequestInit) => { if (init?.method === 'POST') posts++; return new Response(JSON.stringify({ workspace: '/other', manifest: '/other/list.json' })); } });
  await assert.rejects(c.dispatch(1, 'Read'), /工作区或清单/);
  assert.equal(posts, 0);
  const offline = await client({ fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.dispatch(1, 'Read'), /无法连接本地任务看板/);
});

test('HTTP errors and timeouts report actionable failures without retrying writes', async () => {
  const c = await client({ fetch: async () => new Response(JSON.stringify({ error: 'Crew正在执行' }), { status: 400 }) });
  await assert.rejects(c.dispatch(1, 'Read'), /Crew正在执行/);
  const timed = await client({ fetch: async () => { throw new DOMException('Timeout', 'TimeoutError'); } });
  await assert.rejects(timed.stop('run'), /超时/);
});
