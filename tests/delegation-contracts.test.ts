import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelegation, validateTaskPath } from '../src/bridge/delegation.ts';
import type { TeamSnapshot } from '../src/bridge/types.ts';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-delegation-test-'));
  const state: TeamSnapshot = { projectId: 'p', status: 'running', members: [{ id: 'codex', name: 'Codex', provider: 'test', role: 'worker', connection: 'ready', sessionId: 'thread' }], messages: [], updatedAt: '', run: { id: 'run', mode: 'delegation', cwd, goal: 'Check files', access: 'read-only', goalMessageId: 'human-goal' } };
  const sent: { from: string; to: string; text: string; id: string }[] = [], interrupted: string[] = [];
  const controller = createDelegation(state, { changed() {}, send(from, to, text, id) { sent.push({ from, to, text, id }); return id; }, async interrupt(thread, turn) { interrupted.push(`${thread}:${turn}`); } });
  const input = (request_id: string) => ({ request_id, title: 'Check', goal: 'Inspect README', context: '', files: ['README.md'], acceptance: ['Cite evidence'] });
  const delegate = (id: string) => controller.call('claude', 'delegate_task', input(id)) as { task_id: string };
  const result = { summary: 'Checked', artifacts: [{ path: 'README.md', description: 'Evidence' }], checks: [{ command: '', status: 'not_run', detail: 'Read-only review' }], unresolved: [] };
  const start = (task_id: string, attempt: 1 | 2 = 1) => { controller.turn('thread', `turn-${attempt}`, 'inProgress'); controller.call('codex', 'accept_task', { task_id, attempt }); };
  const submit = (task_id: string, attempt: 1 | 2 = 1) => controller.call('codex', 'submit_task_result', { task_id, attempt, result });
  const review = (task_id: string, decision: string, attempt: 1 | 2 = 1) => controller.call('claude', 'review_task_result', { task_id, attempt, decision, reason: 'Read evidence' });
  return { state, controller, sent, interrupted, input, delegate, start, submit, review, result, cwd };
}

test('delegation binds authority, validates paths, deduplicates and bounds tasks', () => {
  const f = fixture(), first = f.delegate('one');
  assert.deepEqual(f.delegate('one'), first);
  assert.equal(f.state.tasks!.length, 1);
  assert.equal(f.state.tasks![0]!.goalMessageId, 'human-goal');
  assert.equal(f.state.tasks![0]!.access, 'read-only');
  assert.throws(() => f.controller.call('claude', 'accept_task', { task_id: first.task_id, attempt: 1 }), /worker/);
  assert.throws(() => f.controller.call('claude', 'submit_task_result', { task_id: first.task_id, attempt: 1, result: f.result }), /worker/);
  assert.throws(() => f.controller.call('codex', 'review_task_result', { task_id: first.task_id, attempt: 1, decision: 'accept', reason: 'spoof' }), /leader/);
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('absolute'), files: ['/etc/hosts'] }), /inside/);
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('directory'), files: ['.'] }), /files/);
  assert.throws(() => f.controller.call('codex', 'delegate_task', f.input('wrong')), /leader/);
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('one'), goal: 'Different' }), /different content/);
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('escape'), files: ['../outside'] }), /inside/);
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('spoof'), access: 'workspace-write' }));
  assert.throws(() => f.controller.call('claude', 'delegate_task', { ...f.input('empty'), acceptance: [] }));
  f.delegate('two'); f.delegate('three');
  assert.throws(() => f.delegate('four'), /three/);
  assert.equal(f.sent.length, 1); // Only one worker slot, without pretending a task is running.
  assert.equal(f.state.tasks![0]!.state, 'queued');
});

test('paths reject an existing symlink escape and a new file below that symlink', () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'crew-outside-test-'));
  writeFileSync(join(outside, 'file.txt'), 'outside');
  symlinkSync(outside, join(f.cwd, 'escape'));
  assert.throws(() => validateTaskPath(f.cwd, 'escape/file.txt'), /escapes/);
  assert.throws(() => validateTaskPath(f.cwd, 'escape/new.txt'), /escapes/);
  validateTaskPath(f.cwd, 'new/file.txt');
});

test('submission and leader acceptance do not release a still-active native turn', () => {
  const f = fixture(), a = f.delegate('a'), b = f.delegate('b');
  f.start(a.task_id); f.submit(a.task_id); f.review(a.task_id, 'accept');
  assert.equal(f.state.tasks![0]!.state, 'accepted');
  assert.equal(f.sent.filter(s => s.id.startsWith('task:')).length, 1);
  f.controller.turn('wrong-thread', 'turn-1', 'completed');
  assert.equal(f.sent.filter(s => s.id.startsWith('task:')).length, 1);
  f.controller.turn('thread', 'turn-1', 'completed');
  assert.equal(f.sent.filter(s => s.id.startsWith('task:')).length, 2);
  assert.equal(f.state.tasks![1]!.id, b.task_id);
});

test('question, supplemental input, duplicate results and stale attempts have exact states', () => {
  const f = fixture(), a = f.delegate('a'); f.start(a.task_id);
  f.controller.call('codex', 'request_task_input', { task_id: a.task_id, attempt: 1, question: 'Which route?' });
  assert.equal(f.state.tasks![0]!.state, 'needs_input');
  assert.throws(() => f.controller.input('codex', a.task_id, 1), /leader/);
  f.controller.input('claude', a.task_id, 1);
  f.submit(a.task_id); const count = f.sent.length; f.submit(a.task_id);
  assert.equal(f.sent.length, count);
  assert.throws(() => f.controller.call('codex', 'submit_task_result', { task_id: a.task_id, attempt: 1, result: { ...f.result, summary: 'Changed' } }), /different content/);
  f.review(a.task_id, 'revise');
  assert.equal(f.state.tasks![0]!.attempt, 2);
  assert.equal(f.state.tasks![0]!.previousResults.length, 1);
  assert.throws(() => f.submit(a.task_id), /stale/);
  f.controller.turn('thread', 'turn-1', 'completed');
  assert.equal(f.state.tasks![0]!.state, 'queued');
  f.start(a.task_id, 2); f.submit(a.task_id, 2);
  assert.throws(() => f.review(a.task_id, 'revise', 2), /One revision/);
  f.review(a.task_id, 'accept', 2);
  assert.equal(f.state.tasks![0]!.revisionReason, 'Read evidence');
  assert.equal(f.state.tasks![0]!.previousResults.length, 1);
});

test('cancel waits for a native receipt and retains late results without acceptance', async () => {
  const f = fixture(), a = f.delegate('a'); f.start(a.task_id);
  await f.controller.cancel(a.task_id);
  assert.equal(f.state.tasks![0]!.state, 'cancel_requested');
  assert.deepEqual(f.interrupted, ['thread:turn-1']);
  f.submit(a.task_id); assert.equal(f.state.tasks![0]!.lateResults!.length, 1);
  f.controller.turn('thread', 'turn-1', 'interrupted');
  assert.equal(f.state.tasks![0]!.state, 'cancelled');
  f.submit(a.task_id); assert.equal(f.state.tasks![0]!.state, 'cancelled');
});

test('cancel of a dispatched task waits for its future turn; pending tasks can cancel immediately', async () => {
  const f = fixture(), a = f.delegate('a'), b = f.delegate('b');
  await f.controller.cancel(a.task_id); await f.controller.cancel(b.task_id);
  assert.equal(f.state.tasks![0]!.state, 'cancel_requested');
  assert.equal(f.state.tasks![1]!.state, 'cancelled');
  f.controller.turn('thread', 'later', 'inProgress');
  assert.deepEqual(f.interrupted, ['thread:later']);
  f.controller.turn('thread', 'later', 'interrupted');
  assert.equal(f.state.tasks![0]!.state, 'cancelled');
});

test('natural turn completion without a submitted result fails honestly; no result file scope escape', () => {
  const f = fixture(), a = f.delegate('a'); f.start(a.task_id);
  assert.throws(() => f.controller.call('codex', 'submit_task_result', { task_id: a.task_id, attempt: 1, result: { ...f.result, artifacts: [{ path: 'other.ts', description: 'Wrong scope' }] } }), /assigned/);
  f.controller.turn('thread', 'turn-1', 'completed');
  assert.equal(f.state.tasks![0]!.state, 'failed');
  assert.match(f.state.tasks![0]!.error!, /without a task result/);
  f.controller.close(); assert.throws(() => f.delegate('late'), /active authorized/);
});
