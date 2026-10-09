import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import { createTeamSession } from '../src/team/session.ts';
import type { AdapterContext, NativeAgent } from '../src/bridge/types.ts';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-team-session-')), calls: any[] = [];
  let ctx: AdapterContext, block: Promise<void> | undefined;
  const workbench = createTeamWorkbench({ adapterFactory: () => ({
    async start(c) { ctx = c; c.onMember('codex', { connection: 'ready', sessionId: 'root' }); return { setup: { command: '', instructions: '' } }; },
    async deliver(m) { calls.push(['goal', m.text]); }, async steer(id, text) { calls.push(['message', id, text]); await block; },
    async approve(a, decision) { calls.push(['approve', a.id, decision]); }, async answer(q, answers) { calls.push(['answer', q.id, answers]); },
    async interrupt(id, turn) { calls.push(['interrupt', id, turn]); }, async close() { calls.push(['close']); },
  }) });
  const session = createTeamSession({ cwd, mode: 'codex-team', access: 'read-only', workbench });
  const agents: NativeAgent[] = [
    { threadId: 'root', name: 'Leader', role: 'leader', state: 'running', turnId: 'root-turn', events: [], updatedAt: '' },
    { threadId: 'worker', parentThreadId: 'root', name: 'Worker', role: 'worker', state: 'running', turnId: 'work-turn', events: [], updatedAt: '' },
  ];
  return { session, calls, agents, get ctx() { return ctx!; }, update() { ctx!.onNativeState!(agents, []); }, block(p: Promise<void>) { block = p; } };
}

test('terminal controller waits for a goal, selects real members and serializes messages', async () => {
  const f = fixture();
  try {
    assert.equal(f.session.view().snapshot.status, 'idle'); assert.equal(f.session.view().members.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(await f.session.submit('Inspect source'), true); assert.deepEqual(f.calls[0], ['goal', 'Inspect source']); f.update();
    f.session.cycle(); assert.equal(f.session.view().selected, 'worker');
    let release!: () => void; f.block(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.session.submit('Check the empty case'); assert.equal(await f.session.submit('Duplicate while busy'), false);
    release(); await pending; assert.deepEqual(f.calls.at(-1), ['message', 'worker', 'Check the empty case']);
    f.session.choose('M1'); await f.session.submit('//literal slash'); assert.deepEqual(f.calls.at(-1), ['message', 'root', '/literal slash']);
  } finally { await f.session.close(); }
});

test('terminal approvals bind to the original run and remain explicit, including after restart', async () => {
  const f = fixture();
  try {
    await f.session.submit('Inspect'); f.update();
    f.ctx.onApproval!({ id: 'old', requestId: 1, threadId: 'worker', turnId: 'work-turn', state: 'pending', method: 'approval', detail: 'Run check' });
    assert.equal(f.calls.some(c => c[0] === 'approve'), false);
    assert.equal(await f.session.submit('/approve A1'), false); assert.equal(f.calls.some(c => c[0] === 'approve'), false);
    await f.session.submit('/approve A1 n'); assert.deepEqual(f.calls.at(-1), ['approve', 'old', 'decline']);
    assert.equal(await f.session.submit('/approve A1 y'), false);
    await f.session.submit('/stop'); await f.session.submit('/start Inspect again'); f.update();
    f.ctx.onApproval!({ id: 'new', requestId: 1, threadId: 'worker', turnId: 'work-turn', state: 'pending', method: 'approval', detail: 'New check' });
    assert.equal(f.session.view().approvals[0]!.slot, 'A2');
    assert.equal(await f.session.submit('/approve A1 y'), false);
    await f.session.submit('/approve A2 y'); assert.deepEqual(f.calls.at(-1), ['approve', 'new', 'accept']);
  } finally { await f.session.close(); }
});

test('terminal question flow submits all answers to the original request, supports secret input and aborts stale forms', async () => {
  const f = fixture();
  try {
    await f.session.submit('Inspect'); f.update();
    const request = { id: 'q', requestId: 2, threadId: 'worker', turnId: 'work-turn', state: 'pending' as const, questions: [{ id: 'format', header: '格式', question: '格式？', options: [{ label: 'JSON', description: '' }] }, { id: 'note', header: '私密备注', question: '备注？', isSecret: true }, { id: 'path', header: '路径', question: '填写路径' }] };
    f.ctx.onInput!(request); await f.session.submit('/answer Q1');
    await f.session.submit('1'); assert.equal(f.session.view().prompt.secret, true);
    await f.session.submit('dummy-private-note'); await f.session.submit('//help');
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['answer', 'q', { format: 'JSON', note: 'dummy-private-note', path: '/help' }]);
    assert.equal(JSON.stringify(f.session.view()).includes('dummy-private-note'), false);
    f.ctx.onInput!({ ...request, state: 'pending', id: 'stale', requestId: 3 }); assert.equal(await f.session.submit('/answer Q2'), true);
    f.ctx.onInputResolved!(3); assert.equal(f.session.view().prompt.question, undefined);
    assert.match(f.session.view().notice, /原提问已结束/);
  } finally { await f.session.close(); }
});

test('terminal interruption binds to the observed turn, faults disable actions, and quit closes its own workbench', async () => {
  const f = fixture();
  await f.session.submit('Inspect'); f.update(); f.session.choose('M2');
  await f.session.submit('/interrupt'); assert.deepEqual(f.calls.at(-1), ['interrupt', 'worker', 'work-turn']);
  assert.match(f.session.view().notice, /等待原生执行结束确认/);
  f.agents[1]!.state = 'interrupted'; f.agents[1]!.lastTurnId = 'work-turn'; delete f.agents[1]!.turnId; f.update();
  assert.match(f.session.view().notice, /成员已中断/);
  f.ctx.onFault!('Subscription unavailable'); assert.equal(await f.session.submit('Continue'), false);
  assert.equal(await f.session.submit('/interrupt'), false);
  await f.session.submit('/quit'); assert.equal(f.session.closed, true); assert.equal(f.calls.at(-1)[0], 'close');
  assert.equal(await f.session.submit('After quit'), false);
});

test('terminal close retains a failed shutdown result for all waiters and invokes shutdown only once', async () => {
  const wb = createTeamWorkbench(); let calls = 0;
  wb.close = async () => { calls++; throw new Error('Fixture shutdown failed'); };
  const session = createTeamSession({ cwd: tmpdir(), mode: 'codex-team', access: 'read-only', workbench: wb });
  await assert.rejects(session.close(), /Fixture shutdown failed/);
  await assert.rejects(session.close(), /Fixture shutdown failed/);
  assert.equal(calls, 1);
});
