import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import type { AdapterContext, TeamMessage } from '../src/bridge/types.ts';
import { memoryWire } from './helpers/delegation-wire.ts';

test('real Bridge handler binds roles and one goal, deduplicates results, and waits for native release', async t => {
  const wire = memoryWire(t), delivered: TeamMessage[] = [], snapshots: unknown[] = [];
  let ctx: AdapterContext;
  const workbench = createTeamWorkbench({ adapterFactory: () => ({ async start(c) { ctx = c; c.onMember('codex', { sessionId: 'thread' }); return { setup: { command: 'mock', instructions: 'mock' } }; }, async deliver(m) { delivered.push(m); }, async interrupt() {}, async close() {} }) });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-wire-test-'));
  workbench.subscribe('p', s => snapshots.push(s));
  await workbench.start('p', { mode: 'delegation', cwd, access: 'read-only', goal: 'Check routes' });
  const server = wire.servers[0]!, call = (member: 'claude' | 'codex', path: string, body?: unknown) => wire.invoke(server, path, body, { authorization: `Bearer ${ctx.tokens[member]}` });
  try {
    const claudeEvents = await call('claude', '/events'), codexEvents = await call('codex', '/events');
    await call('codex', '/ready', {}); assert.equal(workbench.snapshot('p').run!.goalMessageId, undefined);
    await call('claude', '/ready', {}); await call('claude', '/ready', {});
    const initial = workbench.snapshot('p'); assert.ok(initial.run!.goalMessageId); assert.equal(initial.messages.filter(m => m.from === 'user').length, 1);
    assert.match(claudeEvents.text(), /Check routes/);
    const input = { request_id: 'a', title: 'Check', goal: 'Inspect routes', context: '', files: ['routes.ts'], acceptance: ['Cite lines'] };
    assert.equal((await call('codex', '/delegate_task', input)).status, 403);
    const created = await call('claude', '/delegate_task', input), taskId = created.json().task_id;
    assert.equal(created.status, 200); assert.equal(delivered.length, 1); assert.equal(workbench.snapshot('p').tasks![0]!.state, 'queued');
    await call('claude', '/delegate_task', { ...input, request_id: 'b' }); assert.equal(delivered.length, 1);
    ctx!.onTurn!('thread', 'turn', 'inProgress');
    assert.equal((await call('codex', '/accept_task', { task_id: taskId, attempt: 1 })).status, 200);
    await call('codex', '/request_task_input', { task_id: taskId, attempt: 1, question: 'Which routes?' });
    const supplement = { to: 'codex', text: 'Check all three', request_id: 'input-a', task_id: taskId, attempt: 1 };
    assert.equal((await call('claude', '/send', supplement)).status, 202); assert.equal((await call('claude', '/send', supplement)).status, 202);
    assert.equal(delivered.length, 2); assert.equal(workbench.snapshot('p').tasks![0]!.state, 'running');
    const result = { task_id: taskId, attempt: 1, result: { summary: '核对'.repeat(2000), artifacts: [{ path: 'routes.ts', description: 'lines 1-3' }], checks: Array.from({ length: 20 }, () => ({ command: 'c'.repeat(1000), status: 'passed', detail: '证据'.repeat(500) })), unresolved: [] } };
    await call('codex', '/submit_task_result', result); await call('codex', '/submit_task_result', result);
    assert.equal(workbench.snapshot('p').messages.filter(m => m.text.includes('task_result_submitted')).length, 1);
    assert.ok(workbench.snapshot('p').messages.find(m => m.text.includes('task_result_submitted'))!.text.length > 8192);
    await call('claude', '/review_task_result', { task_id: taskId, attempt: 1, decision: 'accept', reason: 'Read evidence' });
    assert.equal(delivered.length, 2);
    ctx!.onTurn!('thread', 'turn', 'completed'); assert.equal(delivered.length, 3);
    assert.ok(snapshots.length > 10);
    await assert.rejects(workbench.send('p', { to: 'claude', text: 'old', requestId: 'old', runId: 'stale' }), /Stale/);
    await assert.rejects(workbench.send('p', { to: 'codex', text: 'bypass', requestId: 'bypass', runId: initial.run!.id }), /leader/);
    claudeEvents.res.end(); codexEvents.res.end();
  } finally { await workbench.close(); }
});
test('user approvals are run-bound and single-use; cancel is not confirmed before native receipt', async t => {
  const wire = memoryWire(t), answered: unknown[] = [], interrupted: unknown[] = [];
  let ctx: AdapterContext;
  const wb = createTeamWorkbench({ adapterFactory: () => ({ async start(c) { ctx = c; c.onMember('codex', { sessionId: 'thread' }); return { setup: { command: '', instructions: '' } }; }, async deliver() {}, async approve(a, decision) { answered.push([a.requestId, decision]); }, async interrupt(thread, turn) { interrupted.push([thread, turn]); }, async close() {} }) });
  const cwd = mkdtempSync(join(tmpdir(), 'crew-approval-wire-'));
  const initial = await wb.start('p', { mode: 'delegation', cwd, access: 'read-only', goal: 'Inspect' }), runId = initial.run!.id;
  const call = (member: 'codex' | 'claude', path: string, body?: unknown) => wire.invoke(wire.servers[0]!, path, body, { authorization: `Bearer ${ctx.tokens[member]}` });
  try {
    await call('claude', '/events'); await call('codex', '/events'); await call('claude', '/ready', {}); await call('codex', '/ready', {});
    const taskId = (await call('claude', '/delegate_task', { request_id: 'a', title: 'A', goal: 'Inspect', context: '', files: [], acceptance: ['Explain'] })).json().task_id;
    ctx!.onTurn!('thread', 'turn', 'inProgress'); await call('codex', '/accept_task', { task_id: taskId, attempt: 1 });
    ctx!.onApproval!({ id: 'approval', requestId: 9, threadId: 'thread', turnId: 'turn', method: 'item/commandExecution/requestApproval', detail: 'echo test', state: 'pending' });
    await assert.rejects(wb.approve('other', runId, 'approval', 'accept'), /Stale/);
    await assert.rejects(wb.approve('p', 'old-run', 'approval', 'accept'), /Stale/);
    await wb.approve('p', runId, 'approval', 'decline'); assert.deepEqual(answered, [[9, 'decline']]);
    await assert.rejects(wb.approve('p', runId, 'approval', 'accept'), /no longer pending/);
    await wb.cancel('p', runId, taskId); assert.equal(wb.snapshot('p').tasks![0]!.state, 'cancel_requested'); assert.deepEqual(interrupted, [['thread', 'turn']]);
    ctx!.onTurn!('thread', 'turn', 'interrupted'); assert.equal(wb.snapshot('p').tasks![0]!.state, 'cancelled');
  } finally { await wb.close(); }
});

test('communication mode retains ordinary peer messages and reply association with no task tools', async t => {
  const wire = memoryWire(t), delivered: TeamMessage[] = [];
  let ctx: AdapterContext;
  const wb = createTeamWorkbench({ adapterFactory: () => ({ async start(c) { ctx = c; return { setup: { command: '', instructions: '' } }; }, async deliver(m) { delivered.push(m); }, async close() {} }) });
  await wb.start('p');
  const call = (member: 'claude' | 'codex', path: string, body?: unknown) => wire.invoke(wire.servers[0]!, path, body, { authorization: `Bearer ${ctx.tokens[member]}` });
  try {
    await call('claude', '/events'); await call('codex', '/events'); await call('claude', '/ready', {}); await call('codex', '/ready', {});
    assert.equal(wb.snapshot('p').run, undefined);
    const first = await call('codex', '/send', { to: 'claude', text: 'Question', request_id: 'q' });
    const message_id = first.json().message_id;
    assert.equal(first.status, 202);
    assert.equal((await call('claude', '/reply', { message_id, text: 'Answer' })).status, 202);
    assert.equal((await call('claude', '/reply', { message_id, text: 'Answer' })).status, 202);
    assert.equal(delivered.length, 1); assert.equal(delivered[0]!.inReplyTo, message_id);
    assert.equal(wb.snapshot('p').messages[0]!.state, 'replied');
    assert.equal((await call('claude', '/delegate_task', {})).status, 404);
    assert.equal((await wire.invoke(wire.servers[0]!, '/send', {})).status, 401);
  } finally { await wb.close(); }
});
