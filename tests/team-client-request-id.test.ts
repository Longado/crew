import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import type { AdapterContext } from '../src/bridge/types.ts';
import { memoryWire } from './helpers/delegation-wire.ts';

function fixture(t: any, slow = false) {
  const wire = memoryWire(t), db = openDb(':memory:');
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'crew-claim-'));
  const projectId = db.createProject({ name: 'Synthetic project', goal: null, dirs: [cwd] });
  let context: AdapterContext, release = () => {}, starts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wb = createTeamWorkbench({ adapterFactory: () => ({
    async start(c) {
      starts++; context = c;
      if (slow) await gate;
      c.onWorkspace!(join(cwd, 'isolated'), join(cwd, 'baseline.json'));
      c.onMember('codex', { connection: 'ready' });
      return { setup: { command: '', instructions: '' } };
    }, async deliver() {}, async close() {},
  }) });
  const inert = { close: async () => {} } as any;
  const server = serve(db, 0, wb, inert, inert);
  t.after(async () => {
    release(); await wb.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.raw.close(); rmSync(cwd, { recursive: true, force: true });
  });
  const config = { projectId, mode: 'codex-team', cwd, goal: 'Inspect synthetic files', access: 'workspace-write' };
  return { wb, projectId, config, release, context: () => context, starts: () => starts,
    request: (path: string, body?: unknown) => wire.invoke(server, path, body, { 'x-corpus': '1' }) };
}

test('client request ID is visible while startup is pending, in HTTP snapshots and after stop', async t => {
  const f = fixture(t, true), clientRequestId = 'synthetic-job_12';
  const pending = f.request('/api/team/start', { ...f.config, clientRequestId });
  // Also release on the old route's immediate validation failure, avoiding a hung test.
  await new Promise(resolve => setImmediate(resolve));
  const starting = (await f.request('/api/team?projectId=' + f.projectId)).json();
  assert.equal(starting.run?.clientRequestId, clientRequestId);
  assert.equal(starting.status, 'starting');
  assert.equal((f.context().run as any).clientRequestId, clientRequestId);
  f.release();
  const started = await pending;
  assert.equal(started.status, 200);
  assert.equal(started.json().run.id, starting.run.id);
  assert.equal(started.json().run.clientRequestId, clientRequestId);
  assert.ok(started.json().run.workerCwd && started.json().run.baselinePath);
  const stopped = await f.request('/api/team/stop', { projectId: f.projectId, runId: starting.run.id });
  assert.equal(stopped.json().run.clientRequestId, clientRequestId);
});

test('same claim reuses its active run, a different claim cannot borrow an identical active configuration', async t => {
  const f = fixture(t);
  const first = await f.request('/api/team/start', { ...f.config, clientRequestId: 'claim-one' });
  assert.equal(first.status, 200);
  const repeat = await f.request('/api/team/start', { ...f.config, clientRequestId: 'claim-one' });
  assert.equal(repeat.json().run.id, first.json().run.id);
  const other = await f.request('/api/team/start', { ...f.config, clientRequestId: 'claim-two' });
  assert.equal(other.status, 409);
  assert.equal(f.starts(), 1);
  assert.equal((f.wb.snapshot(f.projectId).run as any).clientRequestId, 'claim-one');
});

test('claim validation rejects invalid lengths, types and characters at HTTP and workbench boundaries', async t => {
  const f = fixture(t);
  for (const clientRequestId of ['', 'a'.repeat(101), 'has space', '../path', 'line\n', '非ASCII', null, 12]) {
    const response = await f.request('/api/team/start', { ...f.config, clientRequestId });
    assert.equal(response.status, 400, JSON.stringify(clientRequestId));
    await assert.rejects(f.wb.start(f.projectId, { ...f.config, clientRequestId } as any), /client request ID/i);
  }
  assert.equal(f.starts(), 0);
  const valid = await f.request('/api/team/start', { ...f.config, clientRequestId: 'A'.repeat(100) });
  assert.equal(valid.status, 200);
});

test('callers omitting a claim keep the existing start and active-run behavior', async t => {
  const f = fixture(t);
  const first = await f.request('/api/team/start', f.config);
  assert.equal(first.status, 200);
  assert.equal(first.json().run.clientRequestId, undefined);
  const repeat = await f.request('/api/team/start', f.config);
  assert.equal(repeat.json().run.id, first.json().run.id);
  assert.equal(f.starts(), 1);
});
