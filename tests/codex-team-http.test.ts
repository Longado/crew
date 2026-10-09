import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import type { AdapterContext } from '../src/bridge/types.ts';
import { memoryWire } from './helpers/delegation-wire.ts';

test('HTTP native team start, SSE, member steering and interruptions remain project/run/turn bound', async t => {
  const wire = memoryWire(t), db = openDb(':memory:'), cwd = mkdtempSync(join(tmpdir(), 'crew-codex-http-')), other = mkdtempSync(join(tmpdir(), 'crew-other-'));
  const projectId = db.createProject({ name: 'Codex team', goal: null, dirs: [cwd] }), actions: any[] = [];
  let ctx: AdapterContext;
  const wb = createTeamWorkbench({ adapterFactory: () => ({ async start(c) { ctx = c; c.onMember('codex', { connection: 'ready', sessionId: 'root' }); return { setup: { command: '', instructions: '' } }; }, async deliver() {}, async steer(id, text) { actions.push(['steer', id, text]); }, async interrupt(id, turn) { actions.push(['interrupt', id, turn]); }, async close() {} }) });
  const server = serve(db, 0, wb), request = (path: string, body?: unknown, headers: Record<string, string> = {}) => wire.invoke(server, path, body, { 'x-corpus': '1', ...headers });
  try {
    const config = { projectId, mode: 'codex-team', cwd, goal: 'Inspect', access: 'read-only' };
    assert.equal((await request('/api/team/start', { ...config, cwd: other })).status, 403);
    assert.equal((await request('/api/team/start', config)).status, 200); assert.equal(wire.servers.length, 1);
    const runId = wb.snapshot(projectId).run!.id;
    ctx!.onNativeState!([{ threadId: 'child', name: 'Child', role: 'worker', state: 'running', turnId: 'turn', events: [], updatedAt: '' }], []);
    const events = await request(`/api/team/events?projectId=${projectId}`); assert.match(events.text(), /Child/);
    const input = { projectId, runId, threadId: 'child', text: 'Read only', requestId: 'm' };
    assert.equal((await request('/api/team/agent-message', input, { origin: 'https://foreign.test' })).status, 403);
    assert.equal((await request('/api/team/agent-message', { ...input, runId: 'old' })).status, 409);
    assert.equal((await request('/api/team/agent-message', { ...input, threadId: 'outside' })).status, 409);
    assert.equal((await request('/api/team/agent-message', input)).status, 202);
    assert.equal((await request('/api/team/agent-message', input)).status, 202); assert.deepEqual(actions, [['steer', 'child', 'Read only']]);
    assert.equal((await request('/api/team/agent-interrupt', { projectId, runId, threadId: 'child', turnId: 'old' })).status, 409);
    assert.equal((await request('/api/team/agent-interrupt', { projectId, runId, threadId: 'child', turnId: 'turn' })).status, 200);
    assert.deepEqual(actions.at(-1), ['interrupt', 'child', 'turn']);
    assert.equal((await request('/api/team/messages', { projectId, runId, to: 'claude', text: 'Wrong leader', requestId: 'wrong' })).status, 400);
    assert.equal((await request('/team-dock.js')).status, 200); assert.equal((await request('/team-dock.css')).status, 200);
    events.res.end();
  } finally { await wb.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.raw.close(); }
});
