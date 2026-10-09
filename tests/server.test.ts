import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { loadDemo } from '../src/demo.ts';
import { serve } from '../src/server.ts';

const db = openDb(':memory:');
const [p1, p2] = loadDemo(db);
const server = serve(db, 0);
await new Promise((r) => server.once('listening', r));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function req(path: string, opts: { method?: string; body?: unknown; host?: string; header?: boolean } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: {
      host: opts.host ?? `127.0.0.1:${port}`, ...(opts.header === false ? {} : { 'x-corpus': '1' }), ...(data ? { 'content-type': 'application/json' } : {}),
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: res.headers['content-type']?.includes('json') ? JSON.parse(buf) : buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('首页能打开', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>Crew · 本地 Agent 工作台<\/title>/);
});

test('外部主机名访问被拒绝（防 DNS 重绑定）', async () => {
  assert.equal((await req('/api/state', { host: 'evil.example:80' })).status, 403);
});

test('写操作不带自定义请求头被拒绝（防跨站请求）', async () => {
  assert.equal((await req(`/api/projects/${p1}/corrections`, { method: 'POST', header: false, body: { type: 'ack', evidenceId: 'x' } })).status, 403);
});

test('项目视图里有任务、证据和会话', async () => {
  const r = await req(`/api/projects/${p1}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.view.tasks.length > 0);
  assert.ok(Object.keys(r.body.evidence).length > 0);
});

test('修正内容不合规被挡回；不能改别的项目的任务', async () => {
  assert.equal((await req(`/api/projects/${p1}/corrections`, { method: 'POST', body: { type: 'drop_table' } })).status, 400);
  const other = (await req(`/api/projects/${p2}`)).body.view.tasks[0].id;
  const r = await req(`/api/projects/${p1}/corrections`, { method: 'POST', body: { type: 'set_status', taskId: other, status: 'done' } });
  assert.equal(r.status, 400);
});

test('续接上下文能生成；页面确认完成后状态变为已完成，依据是你改的', async () => {
  const view = (await req(`/api/projects/${p2}`)).body.view;
  const task = view.tasks[0];
  const ctx = await req(`/api/projects/${p2}/context?task=${encodeURIComponent(task.id)}`);
  assert.match(ctx.body.text, /^# 继续：/);
  await req(`/api/projects/${p2}/corrections`, { method: 'POST', body: { type: 'set_status', taskId: task.id, status: 'done', note: '你在页面上确认完成' } });
  const after = (await req(`/api/projects/${p2}`)).body.view.tasks.find((t: any) => t.id === task.id);
  assert.equal(after.status, 'done');
  assert.equal(after.basis, 'manual');
});
