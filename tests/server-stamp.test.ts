import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { handleMcp } from '../src/mcp.ts';
import { createSecurityService } from '../src/security/adapter.ts';

async function setup(t: TestContext) {
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: 'stamp 测试', goal: null, dirs: [] });
  const server = serve(db, 0, undefined, undefined, createSecurityService({ nativeEnabled: false, localCatalogPath: false }));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.raw.close();
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path = `/api/projects/${projectId}/stamp`) => fetch(`${base}${path}`);
  const stamp = async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { stamp: string };
    assert.deepEqual(Object.keys(body), ['stamp']);
    assert.equal(typeof body.stamp, 'string');
    return body.stamp;
  };
  const report = (project = projectId) => handleMcp(db, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_task', arguments: { project, name: '新建议', why: '测试 stamp' } } }, { cwd: '/no/such/dir' }) as any;
  return { db, projectId, get, stamp, report };
}

test('stamp 在证据或修正写入后变化，空读与其他项目的写入不影响', async t => {
  const { db, projectId, get, stamp, report } = await setup(t);
  const before = await stamp();
  assert.equal(await stamp(), before);
  assert.deepEqual(db.usageSummary(projectId), {});
  assert.equal(report().result.isError, undefined);
  const afterEvidence = await stamp();
  assert.notEqual(afterEvidence, before);
  assert.equal(await stamp(), afterEvidence);
  db.addCorrection(projectId, { type: 'ack', evidenceId: db.evidenceForProject(projectId)[0].id });
  const afterCorrection = await stamp();
  assert.notEqual(afterCorrection, afterEvidence);
  const other = db.createProject({ name: '其他项目', goal: null, dirs: [] });
  assert.equal(report(other).result.isError, undefined);
  assert.equal(await stamp(), afterCorrection);
  assert.equal((await get('/api/projects/not-found/stamp')).status, 404);
  assert.equal((await get(`/api/projects/${projectId}/stamp/extra`)).status, 404);
});

test('stamp 包含最新证据时间；接口不加载任务、消息、证据列表来折叠整页', async t => {
  const { db, projectId, stamp, report } = await setup(t);
  assert.equal(report().result.isError, undefined);
  const evidence = db.evidenceForProject(projectId)[0];
  const before = await stamp();
  assert.ok(before.includes(evidence.at));
  const latest = '2099-01-01T00:00:00.000Z';
  db.raw.prepare('UPDATE evidence SET at = ? WHERE id = ?').run(latest, evidence.id);
  t.mock.method(db, 'tasksForProject', () => { throw new Error('不应加载任务'); });
  t.mock.method(db, 'messagesForProject', () => { throw new Error('不应加载消息'); });
  t.mock.method(db, 'evidenceForProject', () => { throw new Error('不应加载证据列表'); });
  t.mock.method(db, 'correctionsForProject', () => { throw new Error('不应加载修正列表'); });
  const after = await stamp();
  assert.notEqual(after, before);
  assert.ok(after.includes(latest));
});
