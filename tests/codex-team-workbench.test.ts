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
