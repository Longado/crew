import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import type { TeamSnapshot } from '../src/bridge/workbench.ts';

test('team HTTP validates project, origin and sender before dispatch; SSE restores a snapshot', async () => {
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: '桥接 HTTP 测试', goal: null, dirs: [] });
  const snapshots = new Map<string, TeamSnapshot>();
  const listeners = new Set<(value: TeamSnapshot) => void>();
  const sent: unknown[] = [];
  let closed = false;
  const snapshot = (id: string): TeamSnapshot => snapshots.get(id) ?? {
    projectId: id, status: 'idle', members: [], messages: [], updatedAt: new Date().toISOString(),
  };
  const teams = {
    snapshot,
    async start(id: string) { const s = { ...snapshot(id), status: 'running' as const }; snapshots.set(id, s); for (const fn of listeners) fn(s); return s; },
    async stop(id: string) { const s = { ...snapshot(id), status: 'stopped' as const }; snapshots.set(id, s); for (const fn of listeners) fn(s); return s; },
    async send(id: string, message: { to: 'codex' | 'claude'; text: string; requestId: string }) { sent.push({ id, ...message }); return snapshot(id); },
    subscribe(_id: string, fn: (value: TeamSnapshot) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async close() { closed = true; },
  };
  const server = serve(db, 0, teams);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { 'x-corpus': '1', 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assert.equal((await request('/api/team?projectId=missing')).status, 404);
    assert.equal((await request('/api/team/start', { projectId }, { origin: 'https://external.example' })).status, 403);
    assert.equal((await request('/api/team/start', { projectId }, { origin: 'chrome-extension://abc' })).status, 403);
    assert.equal((await request('/api/%74eam/start', { projectId }, { origin: 'chrome-extension://abc' })).status, 403);
    assert.equal((await request(`/api/%74eam?projectId=${projectId}`, undefined, { origin: 'https://external.example' })).status, 403);
    assert.equal((await request('/api/team/start', { projectId }, { 'x-corpus': '' })).status, 403);
    assert.equal((await request('/api/team/messages', { projectId, to: 'codex', text: ' ', requestId: '1' })).status, 400);
    assert.equal((await request('/api/team/messages', { projectId, from: 'claude', to: 'codex', text: 'spoof', requestId: '2' })).status, 400);
    assert.equal((await request('/api/team/messages', { projectId, to: 'unknown', text: 'hello', requestId: '3' })).status, 400);
    assert.equal(sent.length, 0);
    assert.equal((await request('/api/team/start', { projectId }, { origin: base })).status, 200);
    assert.equal((await request('/api/team/messages', { projectId, to: 'codex', text: 'hello', requestId: '4' })).status, 202);
    assert.deepEqual(sent, [{ id: projectId, to: 'codex', text: 'hello', requestId: '4' }]);
    const events = await request(`/api/team/events?projectId=${projectId}`);
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/);
    assert.match(first, /"status":"running"/);
    await request('/api/team/stop', { projectId });
    const second = new TextDecoder().decode((await reader.read()).value);
    assert.match(second, /"status":"stopped"/);
    await reader.cancel(); reader = undefined;
    assert.equal((await (await request(`/api/team?projectId=${projectId}`)).json() as TeamSnapshot).status, 'stopped');
  } finally {
    await reader?.cancel();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.raw.close();
  }
  assert.equal(closed, true);
  assert.equal(listeners.size, 0);
});
