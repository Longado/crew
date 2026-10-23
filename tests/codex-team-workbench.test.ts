import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import { memoryWire } from './helpers/delegation-wire.ts';
import type { AdapterContext, NativeAgent } from '../src/bridge/types.ts';

test('Codex-only mode sends one goal, shares snapshots, bounds member actions to current run and preserves old modes', async t => {
  const wire = memoryWire(t);
  let ctx: AdapterContext;
  const delivered: any[] = [], actions: any[] = [], observed: any[] = [];
  const wb = createTeamWorkbench({ adapterFactory: () => ({ async start(c) { ctx = c; c.onMember('codex', { connection: 'ready', sessionId: 'root' }); return { setup: { command: '', instructions: '' } }; }, async deliver(m) { delivered.push(m); }, async steer(id, text) { actions.push(['steer', id, text]); }, async interrupt(id, turn) { actions.push(['interrupt', id, turn]); }, async approve(a, decision) { actions.push(['approve', a.id, decision]); }, async answer(input, answers) { actions.push(['answer', input.id, answers]); }, async close() {} }) });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-codex-wb-'));
  const config = { mode: 'codex-team' as const, cwd, goal: 'Inspect two files', access: 'read-only' as const };
  wb.subscribe('p', s => observed.push(s));
  const first = await wb.start('p', config), runId = first.run!.id;
  try {
    assert.equal(first.members.length, 1); assert.equal(first.members[0]!.role, '任务负责人'); assert.equal(first.status, 'running');
    assert.equal(delivered.length, 1); await wb.start('p', config); assert.equal(delivered.length, 1);
    await assert.rejects(wb.start('other', config), /Another/);
    const member: NativeAgent = { threadId: 'child', name: 'Worker', role: 'worker', state: 'running', turnId: 'turn', events: [], updatedAt: '' };
    ctx!.onNativeState!([member], [{ id: 'a', title: 'A', files: [], acceptance: ['Inspect'], threadId: 'child', state: 'running', reviews: [] }]);
    assert.ok(observed.at(-1).agents.some((a: any) => a.threadId === 'child'));
    await assert.rejects(wb.agentMessage('p', 'old', 'child', 'hello', 'm'), /Stale/);
    await assert.rejects(wb.agentMessage('p', runId, 'foreign', 'hello', 'm'), /unknown/);
    await wb.agentMessage('p', runId, 'child', 'hello', 'm'); await wb.agentMessage('p', runId, 'child', 'hello', 'm');
    assert.deepEqual(actions, [['steer', 'child', 'hello']]);
    await assert.rejects(wb.agentMessage('p', runId, 'child', 'changed', 'm'), /reused/);
    await assert.rejects(wb.agentInterrupt('p', runId, 'child', 'old'), /Stale/);
    await wb.agentInterrupt('p', runId, 'child', 'turn'); assert.deepEqual(actions.at(-1), ['interrupt', 'child', 'turn']);
    await assert.rejects(wb.cancel('p', runId, 'a'), /native member/);
    ctx!.onInput!({ id: 'input', requestId: 55, threadId: 'child', turnId: 'turn', state: 'pending', questions: [{ id: 'q', header: 'Format', question: 'Which format?' }] });
    await wb.answer('p', runId, 'input', { q: 'JSON' }); assert.deepEqual(actions.at(-1), ['answer', 'input', { q: 'JSON' }]);
    await assert.rejects(wb.answer('p', runId, 'input', { q: 'JSON' }), /Stale/);
    ctx!.onFault!('quota unavailable'); await assert.rejects(wb.agentMessage('p', runId, 'child', 'retry', 'r'), /Inactive/);
    await wb.stop('p'); await assert.rejects(wb.agentInterrupt('p', runId, 'child', 'turn'), /Stale/);
    assert.equal(wb.snapshot('p').agents![0]!.state, 'unknown');
    assert.equal(wire.servers.length, 0);
    const ordinary = await wb.start('p'); assert.equal(ordinary.members.length, 2); assert.equal(ordinary.run, undefined); assert.equal(ordinary.agents, undefined);
  } finally { await wb.close(); }
});

test('stop rejects a stale run before closing the current adapter and repeats a matching stop safely', async () => {
  let closes = 0;
  const wb = createTeamWorkbench({ adapterFactory: () => ({
    async start(c) { c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
    async deliver() {}, async close() { closes++; },
  }) });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-bound-'));
  try {
    const running = await wb.start('p', { mode: 'codex-team', cwd, goal: 'Inspect', access: 'read-only' });
    await assert.rejects(wb.stop('p', 'stale-run'), { status: 409 });
    assert.equal(closes, 0);
    assert.equal(wb.snapshot('p').status, 'running');
    const stopped = await wb.stop('p', running.run!.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(closes, 1);
    assert.deepEqual(await wb.stop('p', running.run!.id), stopped);
    assert.equal(closes, 1);
  } finally { await wb.close(); }
});

test('an old run observed before restart cannot stop its replacement', async () => {
  const closedRuns: string[] = [];
  const wb = createTeamWorkbench({ adapterFactory: () => {
    let runId: string;
    return {
      async start(c) { runId = c.run!.id; c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
      async deliver() {}, async close() { closedRuns.push(runId); },
    };
  } });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-replaced-'));
  try {
    const config = { mode: 'codex-team' as const, cwd, goal: 'First', access: 'read-only' as const };
    const first = await wb.start('p', config), observedRunId = wb.snapshot('p').run!.id;
    await wb.stop('p', first.run!.id);
    const next = await wb.start('p', { ...config, goal: 'Next' });
    await assert.rejects(wb.stop('p', observedRunId), { status: 409 });
    assert.deepEqual(closedRuns, [first.run!.id]);
    assert.equal(wb.snapshot('p').run!.id, next.run!.id);
    assert.equal(wb.snapshot('p').status, 'running');
  } finally { await wb.close(); }
});

test('start cannot reuse a run while its adapter shutdown is pending', async () => {
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const wb = createTeamWorkbench({ adapterFactory: () => ({
    async start(c) { c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
    async deliver() {}, async close() { await closing; },
  }) });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-start-'));
  let stopping: Promise<unknown> | undefined;
  try {
    const config = { mode: 'codex-team' as const, cwd, goal: 'Inspect', access: 'read-only' as const };
    const first = await wb.start('p', config);
    stopping = wb.stop('p', first.run!.id);
    await assert.rejects(wb.start('p', config), { status: 409 });
    await assert.rejects(wb.start('p', { ...config, goal: 'Next' }), { status: 409 });
    release();
    await stopping;
    assert.equal((await wb.start('p', { ...config, goal: 'Next' })).status, 'running');
  } finally { release(); await stopping; await wb.close(); }
});

test('concurrent stops share shutdown and cannot overwrite a run started by the stopped event', async () => {
  let release!: () => void, closes = 0, adapters = 0;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const wb = createTeamWorkbench({ adapterFactory: () => {
    const index = adapters++;
    return {
      async start(c) { c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
      async deliver() {}, async close() { closes++; if (index === 0) await closing; },
    };
  } });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-concurrent-'));
  let stops: Promise<unknown>[] = [], next: ReturnType<typeof wb.start> | undefined;
  try {
    const config = { mode: 'codex-team' as const, cwd, goal: 'First', access: 'read-only' as const };
    const first = await wb.start('p', config);
    wb.subscribe('p', state => {
      if (state.status === 'stopped' && state.run!.id === first.run!.id && !next) next = wb.start('p', { ...config, goal: 'Next' });
    });
    stops = [wb.stop('p', first.run!.id), wb.stop('p', first.run!.id)];
    release();
    await Promise.all(stops);
    assert.ok(next);
    const replacement = await next;
    assert.equal(closes, 1);
    assert.notEqual(replacement.run!.id, first.run!.id);
    assert.equal(wb.snapshot('p').run!.id, replacement.run!.id);
    assert.equal(wb.snapshot('p').status, 'running');
    assert.equal(wb.snapshot('p').members[0]!.connection, 'ready');
  } finally { release(); await Promise.allSettled(stops); await wb.close(); }
});

test('stop finishes the same run when startup failure has already begun shutdown', async () => {
  let release!: () => void, closeEntered!: () => void, closes = 0, adapters = 0;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { closeEntered = resolve; });
  const wb = createTeamWorkbench({ adapterFactory: () => {
    const index = adapters++;
    return {
      async start(c) { if (index === 0) throw new Error('Startup unavailable'); c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
      async deliver() {}, async close() { closes++; if (index === 0) { closeEntered(); await closing; } },
    };
  } });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-start-fault-'));
  let starting: ReturnType<typeof wb.start> | undefined, stopping: ReturnType<typeof wb.stop> | undefined;
  try {
    const config = { mode: 'codex-team' as const, cwd, goal: 'First', access: 'read-only' as const };
    starting = wb.start('p', config);
    const firstRunId = wb.snapshot('p').run!.id;
    await entered;
    stopping = wb.stop('p', firstRunId);
    release();
    await starting;
    assert.equal((await stopping).status, 'stopped');
    assert.equal(closes, 1);
    const next = await wb.start('p', { ...config, goal: 'Next' });
    assert.equal(next.status, 'running');
    assert.notEqual(next.run!.id, firstRunId);
    assert.equal(wb.snapshot('p').members[0]!.connection, 'ready');
  } finally { release(); await Promise.allSettled([starting, stopping]); await wb.close(); }
});

test('late stop leaves a replacement created after startup error cleanup untouched', async () => {
  let release!: () => void, closeEntered!: () => void, adapters = 0;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { closeEntered = resolve; });
  const wb = createTeamWorkbench({ adapterFactory: () => {
    const index = adapters++;
    return {
      async start(c) { if (index === 0) throw new Error('Startup unavailable'); c.onMember('codex', { connection: 'ready' }); return { setup: { command: '', instructions: '' } }; },
      async deliver() {}, async close() { if (index === 0) { closeEntered(); await closing; } },
    };
  } });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-stop-start-replaced-'));
  let starting: ReturnType<typeof wb.start> | undefined, stopping: ReturnType<typeof wb.stop> | undefined, next: ReturnType<typeof wb.start> | undefined;
  try {
    const config = { mode: 'codex-team' as const, cwd, goal: 'First', access: 'read-only' as const };
    starting = wb.start('p', config);
    const firstRunId = wb.snapshot('p').run!.id;
    await entered;
    wb.subscribe('p', state => {
      if (state.status === 'error' && state.run!.id === firstRunId && !next) next = wb.start('p', { ...config, goal: 'Next' });
    });
    stopping = wb.stop('p', firstRunId);
    release();
    await Promise.all([starting, stopping]);
    assert.ok(next);
    const replacement = await next;
    assert.notEqual(replacement.run!.id, firstRunId);
    assert.equal(wb.snapshot('p').run!.id, replacement.run!.id);
    assert.equal(wb.snapshot('p').status, 'running');
    assert.equal(wb.snapshot('p').members[0]!.connection, 'ready');
  } finally { release(); await Promise.allSettled([starting, stopping]); await wb.close(); }
});
