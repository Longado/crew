import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { createTerminalManager } from '../src/terminal/manager.ts';

test('local terminal HTTP protects cwd, origin and project, streams real PTY input and reconnects', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'crew-http-')));
  const outside = await mkdtemp(join(tmpdir(), 'crew-outside-'));
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: 'terminal HTTP', goal: null, dirs: [cwd] });
  const other = db.createProject({ name: 'other', goal: null, dirs: [cwd] });
  const terminals = createTerminalManager({ prepare: async () => ({ command: '/bin/sh', args: ['-c', 'printf "CREW_READY\\n"; while IFS= read -r line; do printf "reply:%s\\n" "$line"; done'] }) });
  const server = serve(db, 0, undefined, terminals);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-corpus': '1', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const create = { projectId, cwd, provider: 'codex', requestId: 'one', cols: 80, rows: 24 };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assert.equal((await request('/api/terminals', create, { origin: 'https://other.example' })).status, 403);
    assert.equal((await request('/api/%74erminals', create, { origin: 'chrome-extension://abc' })).status, 403);
    assert.equal((await request('/api/terminals', create, { 'x-corpus': '' })).status, 403);
    assert.equal((await request('/api/terminals', { ...create, cwd: outside })).status, 403);
    assert.equal((await request('/api/terminals', { ...create, command: '/bin/sh' })).status, 400);
    assert.equal((await request('/api/terminals', { ...create, provider: 'shell' })).status, 400);
    assert.equal((await request('/api/terminals', { ...create, projectId: 'missing' })).status, 404);
    const created = await request('/api/terminals', create, { origin: base });
    assert.equal(created.status, 201);
    const session = await created.json() as { id: string; state: string };
    assert.equal(session.state, 'running');
    const duplicate = await (await request('/api/terminals', create)).json() as { id: string };
    assert.equal(duplicate.id, session.id);
    const events = await request(`/api/terminals/${session.id}/events?projectId=${projectId}`);
    reader = events.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
    assert.equal((await request(`/api/terminals/${session.id}/input`, { projectId: other, data: 'wrong\r' })).status, 404);
    assert.equal((await request(`/api/terminals/${session.id}/input`, { projectId, data: 'hello-crew\r' })).status, 200);
    let stream = '';
    while (!stream.includes('reply:hello-crew')) {
      const result = await reader.read(); if (result.done) throw Error('stream ended early'); stream += new TextDecoder().decode(result.value);
    }
    await reader.cancel(); reader = undefined;
    assert.equal(terminals.get(projectId, session.id).state, 'running', 'browser disconnect must not kill PTY');
    const resumed = await request(`/api/terminals/${session.id}/events?projectId=${projectId}`);
    reader = resumed.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /reply:hello-crew/);
    assert.equal((await request(`/api/terminals/${session.id}/resize`, { projectId, cols: 92, rows: 37 })).status, 200);
    assert.equal(terminals.get(projectId, session.id).rows, 37);
    const list = await (await request(`/api/terminals?projectId=${projectId}`)).json() as { sessions: Record<string, unknown>[] };
    assert.equal(list.sessions.length, 1); assert.equal('output' in list.sessions[0], false);
    assert.equal((await request(`/api/terminals/${session.id}/stop`, { projectId })).status, 200);
  } finally {
    await reader?.cancel(); await terminals.close();
    await new Promise<void>(resolve => server.close(() => resolve())); db.raw.close();
  }
});
