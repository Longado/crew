import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import type { TeamSnapshot, TeamRunOptions } from '../src/bridge/types.ts';
import { memoryWire } from './helpers/delegation-wire.ts';

test('HTTP handlers validate bound directory, human origin, run controls, and restore SSE snapshots without sockets', async t => {
  const wire = memoryWire(t), db = openDb(':memory:'), cwd = mkdtempSync(join(tmpdir(), 'crew-http-test-')), outside = mkdtempSync(join(tmpdir(), 'crew-http-outside-'));
  const projectId = db.createProject({ name: 'Delegation', goal: null, dirs: [cwd] });
  const calls: any[] = [], listeners = new Set<(s: TeamSnapshot) => void>();
  let state: TeamSnapshot = { projectId, status: 'idle', members: [], messages: [], updatedAt: '' };
  const teams = { snapshot() { return state; }, async start(id: string, config?: TeamRunOptions) { calls.push(['start', id, config]); state = { ...state, status: 'running', run: config ? { ...config, id: 'run' } : undefined }; for (const fn of listeners) fn(state); return state; }, async stop() { return state; }, async send(_id: string, input: unknown) { calls.push(['send', input]); return state; }, async cancel(id: string, run: string, task: string) { calls.push(['cancel', id, run, task]); return state; }, async approve(id: string, run: string, approval: string, decision: string) { calls.push(['approve', id, run, approval, decision]); return state; }, subscribe(_id: string, fn: (s: TeamSnapshot) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, async close() {} };
  const server = serve(db, 0, teams);
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => wire.invoke(server, path, body, { 'x-corpus': '1', ...headers });
  const config = { projectId, mode: 'delegation', cwd, goal: 'Check documentation', access: 'read-only' };
  try {
    assert.equal((await request('/api/team/start', config, { origin: 'https://external.test' })).status, 403);
    assert.equal((await request('/api/team/start', config, { origin: 'chrome-extension://external' })).status, 403);
    assert.equal((await request('/api/team/start', config, { 'x-corpus': '' })).status, 403);
    assert.equal((await request('/api/team/start', { ...config, projectId: 'unknown' })).status, 404);
    assert.equal((await request('/api/team/start', { ...config, cwd: outside })).status, 403);
    assert.equal((await request('/api/team/start', { ...config, access: 'full-access' })).status, 400);
    assert.equal((await request('/api/team/start', { ...config, from: 'claude' })).status, 400);
    assert.equal((await request('/api/team/start', { projectId, goal: 'implicit goal' })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await request('/api/team/start', config, { origin: 'http://127.0.0.1:19091' })).status, 200);
    assert.deepEqual(calls[0], ['start', projectId, { mode: 'delegation', cwd: realpathSync(cwd), goal: 'Check documentation', access: 'read-only' }]);
    const events = await request(`/api/team/events?projectId=${projectId}`); assert.match(events.text(), /event: snapshot/); assert.match(events.text(), /Check documentation/);
    assert.equal((await request('/api/team/approve', { projectId, approvalId: 'a', decision: 'accept' })).status, 400);
    assert.equal((await request('/api/team/approve', { projectId, runId: 'run', approvalId: 'a', decision: 'acceptForSession' })).status, 400);
    assert.equal((await request('/api/team/approve', { projectId, runId: 'run', approvalId: 'a', decision: 'decline' })).status, 200);
    assert.equal((await request('/api/team/cancel', { projectId, runId: 'run', taskId: 'task' })).status, 200);
    assert.equal((await request('/api/team/messages', { projectId, runId: 'run', to: 'claude', text: 'Supplement', requestId: 'input' })).status, 202);
    assert.deepEqual(calls.slice(1), [['approve', projectId, 'run', 'a', 'decline'], ['cancel', projectId, 'run', 'task'], ['send', { to: 'claude', text: 'Supplement', requestId: 'input', runId: 'run' }]]);
    events.res.end();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.raw.close(); }
});
