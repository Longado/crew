import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { createTerminalManager } from '../src/terminal/manager.ts';
import { terminalEnv } from '../src/terminal/provider.ts';

async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Terminal test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
test('real PTY carries input, resize, replay, reconnect and isolated stop without model calls', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'crew-pty-test-'));
  const manager = createTerminalManager({ prepare: async () => ({ command: '/bin/sh', args: ['-i'] }), stopGraceMs: 100 });
  try {
    const a = await manager.create('p', { provider: 'codex', cwd, requestId: 'a' });
    const b = await manager.create('other', { provider: 'claude', cwd, requestId: 'b' });
    assert.equal(a.state, 'running'); assert.equal(manager.list('p').length, 1);
    assert.throws(() => manager.get('other', a.id), /not found/);
    let received = '';
    const detach = manager.subscribe('p', a.id, event => { if (event.type === 'output') received += event.data; });
    manager.resize('p', a.id, 92, 37);
    manager.input('p', a.id, "printf 'CREW_%s\\n' LIVE; stty size\n");
    await until(() => received.includes('CREW_LIVE') && received.includes('37 92'));
    detach(); manager.input('p', a.id, "printf 'STILL_%s\\n' HERE\n");
    await until(() => manager.get('p', a.id).output.some(chunk => chunk.data.includes('STILL_HERE')));
    assert.equal((await manager.create('p', { provider: 'codex', cwd, requestId: 'a' })).id, a.id);
    await assert.rejects(manager.create('p', { provider: 'claude', cwd, requestId: 'a' }), /different content/);
    assert.throws(() => manager.input('p', a.id, 'x'.repeat(65537)), /limit/);
    assert.throws(() => manager.resize('p', a.id, 0, 10), /dimensions/);
    manager.stop('p', a.id);
    await until(() => manager.get('p', a.id).state === 'exited');
    assert.equal(manager.get('other', b.id).state, 'running');
    manager.input('other', b.id, "printf 'OTHER_%s\\n' LIVE\n");
    await until(() => manager.get('other', b.id).output.some(chunk => chunk.data.includes('OTHER_LIVE')));
    assert.throws(() => manager.input('p', a.id, 'hi'), /not running/);
  } finally { await manager.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('pending starts count toward capacity; concurrent request IDs share one PTY; bounded replay is immutable', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let onData!: (data: string) => void, onExit!: (event: { exitCode: number }) => void, spawns = 0;
  const manager = createTerminalManager({ maxSessions: 1, replayBytes: 8,
    prepare: async () => { await ready; return { command: 'test', args: [] }; },
    spawn: () => { spawns++; return { pid: 0, onData(callback: typeof onData) { onData = callback; }, onExit(callback: typeof onExit) { onExit = callback; }, kill() { onExit({ exitCode: 0 }); }, write() {}, resize() {} } as unknown as IPty; },
  });
  try {
    const input = { provider: 'codex' as const, cwd: tmpdir(), requestId: 'one' };
    const first = manager.create('p', input), duplicate = manager.create('p', input);
    await assert.rejects(manager.create('p', { ...input, requestId: 'two' }), /limit/);
    release(); const a = await first; assert.equal((await duplicate).id, a.id); assert.equal(spawns, 1);
    onData('12345'); onData('67890');
    const view = manager.get('p', a.id);
    assert.equal(view.truncated, true); assert.deepEqual(view.output, [{ seq: 2, data: '67890' }]);
    view.output[0]!.data = 'modified'; assert.equal(manager.get('p', a.id).output[0]!.data, '67890');
  } finally { release(); await manager.close(); }
});

test('bad cwd and spawn failure are actionable, and closed managers cannot start children', async () => {
  const manager = createTerminalManager({ prepare: async () => ({ command: 'missing', args: [] }), spawn: () => { throw new Error('ENOENT'); } });
  await assert.rejects(manager.create('p', { provider: 'codex', cwd: '/does-not-exist-crew-test', requestId: 'missing' }));
  const failed = await manager.create('p', { provider: 'claude', cwd: tmpdir(), requestId: 'failed' });
  assert.equal(failed.state, 'error'); assert.match(failed.error!, /could not start/);
  await manager.close(); await assert.rejects(manager.create('p', { provider: 'codex', cwd: tmpdir(), requestId: 'closed' }), /closed/);
});

test('terminal environment removes API credentials and inherited agent controls', () => {
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_SANDBOX', 'CORPUS_BRIDGE_TOKEN'];
  const previous = keys.map(key => process.env[key]);
  try { for (const key of keys) process.env[key] = 'fixture-only'; const env = terminalEnv(); for (const key of keys) assert.equal(env[key], undefined); assert.equal(env.TERM, 'xterm-256color'); }
  finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test('HTTP callers receive precise validation, not-found and conflict statuses', async () => {
  const manager = createTerminalManager({ maxSessions: 1, prepare: async () => ({ command: 'fixture', args: [] }), spawn: () => { throw new Error('fixture failed'); } });
  const request = { provider: 'codex' as const, cwd: tmpdir(), requestId: 'status' };
  const status = (expected: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === expected;
  try {
    assert.throws(() => manager.get('wrong', 'missing'), status(404));
    await assert.rejects(manager.create('p', { ...request, cols: -1 }), status(400));
    await assert.rejects(manager.create('p', { ...request, cwd: '/does-not-exist-crew-test' }), status(400));
    const result = await manager.create('p', request);
    await assert.rejects(manager.create('p', { ...request, provider: 'claude' }), status(409));
    assert.throws(() => manager.input('p', result.id, 'hello'), status(409));
    assert.throws(() => manager.input('p', result.id, 'x'.repeat(65537)), status(400));
    assert.throws(() => manager.resize('p', result.id, 10, 0), status(400));
    assert.throws(() => manager.resize('p', result.id, 10, 10), status(409));
  } finally { await manager.close(); }
  await assert.rejects(manager.create('p', request), status(409));
  const capped = createTerminalManager({ maxSessions: 0 });
  try { await assert.rejects(capped.create('p', request), status(409)); } finally { await capped.close(); }
});
