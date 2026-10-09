import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexTeamProtocol } from '../src/bridge/codex-team.ts';
import type { AdapterContext, NativeAgent, NativeTask, TeamApproval, TeamInput } from '../src/bridge/types.ts';

function fixture() {
  const sent: any[] = [], faults: string[] = [], approvals: TeamApproval[] = [], attached: string[] = [];
  let agents: NativeAgent[] = [], tasks: NativeTask[] = []; const inputs: TeamInput[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'crew-team-protocol-'));
  const ctx: AdapterContext = { url: '', tokens: { codex: '', claude: '' }, run: { id: 'run', mode: 'codex-team', cwd, goal: 'Inspect files', access: 'read-only' }, onMember() {}, onOutput() {}, onFault(m) { faults.push(m); }, onApproval(a) { approvals.push(a); }, onInput(i) { inputs.push(i); }, onNativeState(a, t) { agents = a; tasks = t; } };
  const protocol = createCodexTeamProtocol(ctx, { send(m) { sent.push(m); }, response(m) { sent.push(['response', m]); }, attach(id) { attached.push(id); } });
  protocol.leader('leader');
  const event = (method: string, params: any) => protocol.handle({ method, params });
  const turn = (threadId: string, status = 'inProgress') => event(status === 'inProgress' ? 'turn/started' : 'turn/completed', { threadId, turn: { id: `${threadId}-turn`, status } });
  const spawn = () => event('item/completed', { threadId: 'leader', turnId: 'leader-turn', item: { type: 'collabAgentToolCall', id: 'spawn', senderThreadId: 'leader', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['worker'], agentsStates: { worker: { status: 'running' } }, prompt: 'Own src/a.ts' } });
  let id = 10;
  const tool = (name: string, args: unknown, threadId = 'leader') => { const requestId = id++; protocol.handle({ id: requestId, method: 'item/tool/call', params: { threadId, turnId: `${threadId}-turn`, callId: `call-${requestId}`, tool: name, arguments: args } }); return sent.find(m => m.id === requestId); };
  const plan = () => tool('crew_plan_tasks', { tasks: [{ id: 'a', title: 'Inspect A', files: ['src/a.ts'], acceptance: ['Cite evidence'] }] });
  return { protocol, event, turn, spawn, tool, plan, sent, faults, approvals, inputs, attached, get agents() { return agents; }, get tasks() { return tasks; } };
}

test('native spawn/turn/output/diff events drive membership; completed is awaiting review', () => {
  const f = fixture(); f.turn('leader'); assert.equal(f.plan().result.success, true); f.spawn();
  assert.deepEqual(f.attached, ['worker']);
  assert.equal(f.tool('crew_assign_task', { taskId: 'a', threadId: 'worker' }).result.success, true);
  f.turn('worker');
  f.event('item/completed', { threadId: 'worker', turnId: 'worker-turn', item: { id: 'result', type: 'agentMessage', text: 'Found evidence', phase: 'final_answer' } });
  f.event('turn/diff/updated', { threadId: 'worker', turnId: 'worker-turn', diff: 'diff proof' });
  assert.equal(f.tasks[0]!.state, 'running');
  assert.equal(f.tool('crew_review_task', { taskId: 'a', decision: 'accept', reason: 'Read files' }).result.success, false);
  f.turn('worker', 'completed'); assert.equal(f.tasks[0]!.state, 'submitted');
  assert.equal(f.agents.find(a => a.threadId === 'worker')!.diff, 'diff proof');
  assert.equal(f.tool('crew_review_task', { taskId: 'a', decision: 'accept', reason: 'Read actual files' }).result.success, true);
  assert.equal(f.tasks[0]!.state, 'accepted');
  f.turn('worker'); assert.equal(f.tasks[0]!.state, 'running'); assert.equal(f.tasks[0]!.reviews.length, 1);
});

test('native questions require complete human answers on the original request and reject stale replies', () => {
  const f = fixture(); f.turn('leader'); f.spawn(); f.turn('worker');
  f.protocol.handle({ id: 70, method: 'item/tool/requestUserInput', params: { threadId: 'worker', turnId: 'worker-turn', isBlocking: true, itemId: 'question', questions: [{ id: 'format', header: '格式', question: '空列表返回什么？', options: [{ label: '数组', description: '返回 []' }] }] } });
  assert.equal(f.inputs.length, 1); assert.equal(f.agents.find(a => a.threadId === 'worker')!.state, 'waiting_input');
  assert.throws(() => f.protocol.answer(f.inputs[0]!, {}), /every/);
  f.protocol.answer(f.inputs[0]!, { format: '数组' }); assert.deepEqual(f.sent.at(-1), { id: 70, result: { answers: { format: { answers: ['数组'] } } } });
  assert.throws(() => f.protocol.answer(f.inputs[0]!, { format: '再回答' }), /Stale/);
});

test('late output from an earlier turn is retained as history and cannot pass review for a new turn', () => {
  const f = fixture(); f.turn('leader'); f.plan(); f.spawn(); f.tool('crew_assign_task', { taskId: 'a', threadId: 'worker' }); f.turn('worker'); f.turn('worker', 'completed');
  f.event('turn/started', { threadId: 'worker', turn: { id: 'new-turn', status: 'inProgress' } });
  f.event('item/completed', { threadId: 'worker', turnId: 'worker-turn', item: { id: 'late', type: 'agentMessage', text: 'old evidence' } });
  f.event('turn/completed', { threadId: 'worker', turn: { id: 'new-turn', status: 'completed' } });
  assert.equal(f.agents.find(a => a.threadId === 'worker')!.output, '');
  assert.equal(f.tool('crew_review_task', { taskId: 'a', decision: 'accept', reason: 'wrong' }).result.success, false);
});

test('leader-only task tools reject forged membership, duplicate ownership and path escape', () => {
  const f = fixture(); f.turn('leader'); f.spawn(); f.turn('worker');
  assert.equal(f.tool('crew_plan_tasks', { tasks: [] }, 'worker').result.success, false);
  assert.equal(f.tool('crew_plan_tasks', { tasks: [{ id: 'a', title: 'A', files: ['../outside'], acceptance: ['Check'] }] }).result.success, false);
  assert.equal(f.tool('crew_plan_tasks', { tasks: ['a', 'b'].map(id => ({ id, title: id, files: ['same.ts'], acceptance: ['Check'] })) }).result.success, false);
  f.plan(); assert.equal(f.tool('crew_assign_task', { taskId: 'a', threadId: 'stranger' }).result.success, false);
  f.event('thread/started', { thread: { id: 'stranger', parentThreadId: 'unrelated', name: 'stranger' } });
  assert.equal(f.agents.some(a => a.threadId === 'stranger'), false);
});

test('approval IDs do not collide with client responses; approval waits for human and rejects stale turns', () => {
  const f = fixture(); f.turn('leader'); f.spawn(); f.turn('worker');
  f.protocol.handle({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'worker', turnId: 'worker-turn', itemId: 'cmd', command: 'test' } });
  assert.equal(f.approvals.length, 1); assert.equal(f.agents.find(a => a.threadId === 'worker')!.state, 'waiting_approval');
  assert.equal(f.sent.length, 0);
  f.protocol.approve(f.approvals[0]!, 'decline'); assert.deepEqual(f.sent[0], { id: 42, result: { decision: 'decline' } });
  assert.throws(() => f.protocol.approve(f.approvals[0]!, 'accept'), /Stale/);
  f.protocol.handle({ id: 42, result: { ok: true } }); assert.equal(f.sent[1][0], 'response');
  f.protocol.handle({ id: 43, method: 'item/fileChange/requestApproval', params: { threadId: 'worker', turnId: 'old' } });
  assert.equal(f.approvals.length, 1); assert.ok(f.faults.length);
});

test('interrupt requests and stream faults retain artifacts without confirming completion', () => {
  const f = fixture(); f.turn('leader'); f.plan(); f.spawn(); f.tool('crew_assign_task', { taskId: 'a', threadId: 'worker' }); f.turn('worker');
  f.protocol.interruptRequested('worker', 'worker-turn');
  assert.equal(f.agents.find(a => a.threadId === 'worker')!.state, 'interrupt_requested');
  f.turn('worker', 'interrupted'); assert.equal(f.tasks[0]!.state, 'interrupted');
  f.protocol.fault('Disconnected');
  f.event('item/completed', { threadId: 'worker', turnId: 'worker-turn', item: { id: 'late', type: 'agentMessage', text: 'late result' } });
  assert.match(f.agents.find(a => a.threadId === 'worker')!.output!, /late result/);
  assert.notEqual(f.tasks[0]!.state, 'accepted');
  assert.equal(f.tool('crew_review_task', { taskId: 'a', decision: 'accept', reason: 'late' }).result.success, false);
});

test('thread active flags and legacy collab events update state without inventing acceptance', () => {
  const f = fixture(); f.turn('leader');
  f.event('item/completed', { threadId: 'leader', item: { id: 'legacy', type: 'collabToolCall', tool: 'spawnAgent', senderThreadId: 'leader', newThreadId: 'worker', prompt: 'Check files', agentStatus: 'running' } });
  f.event('thread/status/changed', { threadId: 'worker', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  assert.equal(f.agents.find(a => a.threadId === 'worker')!.state, 'waiting_input');
  f.event('thread/started', { thread: { id: 'worker', parentThreadId: 'leader', agentNickname: 'Ada', agentRole: 'explorer' } });
  assert.equal(f.agents.find(a => a.threadId === 'worker')!.name, 'Ada');
});
