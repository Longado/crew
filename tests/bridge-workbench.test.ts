import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import type { AdapterContext, MemberId, TeamMessage } from '../src/bridge/types.ts';
import { subscriptionEnv, checkCodexSubscription } from '../src/bridge/subscription.ts';
async function fixture() {
  let context!: AdapterContext; const delivered: TeamMessage[] = []; let closed = 0;
  const bench = createTeamWorkbench({ adapterFactory: () => ({ async start(ctx) { context = ctx; return { setup: { command: '/tmp/test-launcher', instructions: 'ready' } }; }, async deliver(message) { delivered.push(message); }, async close() { closed++; } }) });
  await bench.start('p1'); const streams: AbortController[] = [];
  const post = (member: MemberId, path: string, body: unknown) => fetch(context.url + path, { method: 'POST', headers: { authorization: `Bearer ${context.tokens[member]}` }, body: JSON.stringify(body) });
  async function connect(member: MemberId) { const controller = new AbortController(); streams.push(controller); const response = await fetch(context.url + '/events', { headers: { authorization: `Bearer ${context.tokens[member]}` }, signal: controller.signal }); assert.equal(response.status, 200); return controller; }
  async function ready(member: MemberId) { await connect(member); assert.equal((await post(member, '/ready', {})).status, 200); }
  return { bench, delivered, post, connect, ready, get context() { return context; }, get closed() { return closed; }, async close() { for (const controller of streams) controller.abort(); await bench.close(); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
test('authenticated identity, idempotency, conflicts and reply-to-user routing', async () => {
  const f = await fixture(); try {
    await f.ready('claude');
    assert.equal((await fetch(f.context.url + '/send', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await f.post('claude', '/send', { from: 'codex', to: 'codex', text: 'spoof', request_id: 'x' })).status, 400);
    const first = await f.bench.send('p1', { to: 'claude', text: 'Hello', requestId: 'human-1' });
    await f.bench.send('p1', { to: 'claude', text: 'Hello', requestId: 'human-1' }); assert.equal(f.bench.snapshot('p1').messages.length, 1);
    await assert.rejects(f.bench.send('p1', { to: 'claude', text: 'Different', requestId: 'human-1' }), /different content/);
    assert.equal((await f.post('codex', '/reply', { message_id: first.messages[0]!.id, text: 'wrong member' })).status, 400);
    assert.equal((await f.post('claude', '/reply', { message_id: 'missing', text: 'unknown' })).status, 400);
    assert.equal((await f.post('claude', '/reply', { message_id: first.messages[0]!.id, text: 'Hi user' })).status, 202);
    const result = f.bench.snapshot('p1'); assert.equal(result.messages[0]!.state, 'replied'); assert.equal(result.messages[1]!.to, 'user'); assert.equal(result.messages[1]!.inReplyTo, result.messages[0]!.id); assert.equal(f.delivered.length, 0);
  } finally { await f.close(); }
});
test('peer reply reaches exact Codex adapter and duplicate reply does not dispatch twice', async () => {
  const f = await fixture(); try {
    await f.ready('codex'); await f.ready('claude'); assert.equal(f.bench.snapshot('p1').status, 'running');
    const res = await f.post('codex', '/send', { to: 'claude', text: 'Question', request_id: 'peer-1' }); const body = await res.json() as { message_id: string };
    assert.equal((await f.post('claude', '/reply', { message_id: body.message_id, text: 'Answer' })).status, 202);
    assert.equal((await f.post('claude', '/reply', { message_id: body.message_id, text: 'Answer' })).status, 202);
    assert.equal((await f.post('claude', '/reply', { message_id: body.message_id, text: 'Changed' })).status, 409);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.from, 'claude'); assert.equal(f.delivered[0]!.to, 'codex');
    f.context.onOutput('Final user-visible output', 'item-1'); assert.equal(f.bench.snapshot('p1').messages.at(-1)!.to, 'user');
  } finally { await f.close(); }
});
test('transport connection requires ready; disconnect clears readiness and does not replay written messages', async () => {
  const f = await fixture(); try {
    assert.equal((await f.post('claude', '/ready', {})).status, 409);
    const controller = await f.connect('claude'); await f.bench.send('p1', { to: 'claude', text: 'Wait', requestId: 'wait-1' }); assert.equal(f.bench.snapshot('p1').messages[0]!.state, 'queued');
    await f.post('claude', '/ready', {}); assert.equal(f.bench.snapshot('p1').messages[0]!.state, 'transport_written');
    controller.abort(); await tick(); assert.equal(f.bench.snapshot('p1').members[1]!.connection, 'disconnected'); assert.equal(f.bench.snapshot('p1').messages[0]!.state, 'delivery_unknown');
    await f.ready('claude'); assert.equal(f.bench.snapshot('p1').messages[0]!.state, 'delivery_unknown');
  } finally { await f.close(); }
});
test('project isolation, immutable snapshots, stop and late callbacks', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.bench.start('p2'), /Another project/); await assert.rejects(f.bench.send('p2', { to: 'codex', text: 'wrong', requestId: 'x' }), /not active/);
    await f.bench.send('p1', { to: 'codex', text: 'pending', requestId: 'x' }); const snapshot = f.bench.snapshot('p1'); snapshot.messages.length = 0; assert.equal(f.bench.snapshot('p1').messages.length, 1);
    const old = f.context; await f.bench.stop('p1'); assert.equal(f.closed, 1); old.onMember('codex', { connection: 'ready' }); old.onOutput('late', 'late');
    assert.equal(f.bench.snapshot('p1').status, 'stopped'); assert.equal(f.bench.snapshot('p1').members[0]!.connection, 'disconnected'); assert.equal(f.bench.snapshot('p1').messages.length, 1); assert.equal(f.bench.snapshot('p1').messages[0]!.state, 'failed');
    await f.bench.start('p2'); old.onOutput('old project', 'late-2'); assert.equal(f.bench.snapshot('p2').messages.length, 0);
  } finally { await f.close(); }
});
test('subscription environment excludes API and router keys without mutating parent', () => {
  const source = { PATH: '/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', OPENAI_BASE_URL: 'third-party', CLAUDE_CODE_USE_VERTEX: '1', CUSTOM_API_KEY: 'secret' };
  assert.deepEqual(subscriptionEnv(source), { PATH: '/bin', HOME: '/home/me' }); assert.equal(source.ANTHROPIC_API_KEY, 'secret');
  assert.throws(() => checkCodexSubscription({ account: { type: 'apiKey' } }), /fallback is disabled/); assert.throws(() => checkCodexSubscription({ account: { type: 'chatgpt', planType: 'free' } }), /fallback is disabled/); assert.equal(checkCodexSubscription({ account: { type: 'chatgpt', planType: 'pro' } }), 'ChatGPT pro');
});
test('queue acknowledgement does not override a faster reply; dispatch failure stays uncertain', async () => {
  let context!: AdapterContext; let resolveDelivery!: () => void; let rejectDelivery!: (error: Error) => void;
  const bench = createTeamWorkbench({ adapterFactory: () => ({ async start(ctx) { context = ctx; return { setup: { command: '/tmp/launcher', instructions: 'ready' } }; }, deliver() { return new Promise<void>((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; }); }, async close() {} }) });
  const abort = new AbortController();
  try {
    await bench.start('p'); await fetch(context.url + '/events', { headers: { authorization: `Bearer ${context.tokens.codex}` }, signal: abort.signal });
    const post = (path: string, body: unknown) => fetch(context.url + path, { method: 'POST', headers: { authorization: `Bearer ${context.tokens.codex}` }, body: JSON.stringify(body) });
    await post('/ready', {}); await bench.send('p', { to: 'codex', text: 'One', requestId: '1' }); const first = bench.snapshot('p').messages[0]!; assert.equal(first.state, 'queued');
    await post('/reply', { message_id: first.id, text: 'Done' }); resolveDelivery(); await tick(); assert.equal(bench.snapshot('p').messages[0]!.state, 'replied');
    await bench.send('p', { to: 'codex', text: 'Two', requestId: '2' }); rejectDelivery(new Error('Queue lost')); await tick(); assert.equal(bench.snapshot('p').messages.at(-1)!.state, 'delivery_unknown');
    await bench.send('p', { to: 'codex', text: 'Three', requestId: '3' }); await bench.stop('p'); resolveDelivery(); await tick(); assert.equal(bench.snapshot('p').messages.at(-1)!.state, 'delivery_unknown');
  } finally { abort.abort(); await bench.close(); }
});
test('startup failure closes adapter and provides a retryable honest error', async () => {
  let closed = 0;
  const bench = createTeamWorkbench({ adapterFactory: () => ({ async start() { throw new Error('Subscription unavailable'); }, async deliver() {}, async close() { closed++; } }) });
  try { const failed = await bench.start('p'); assert.equal(failed.status, 'error'); assert.match(failed.error!, /Subscription/); assert.equal(closed, 1); assert.ok(failed.members.every(m => m.connection === 'disconnected')); const retried = await bench.start('p'); assert.equal(retried.status, 'error'); assert.equal(closed, 2); }
  finally { await bench.close(); }
});
test('new agent messages update only sender activity; retries and human messages do not', async () => {
  const f = await fixture(); try {
    const before = f.bench.snapshot('p1').members.map(m => m.lastActivityAt);
    await f.bench.send('p1', { to: 'claude', text: 'Hello', requestId: 'human-activity' });
    assert.deepEqual(f.bench.snapshot('p1').members.map(m => m.lastActivityAt), before);
    await f.post('codex', '/send', { to: 'claude', text: 'Question', request_id: 'activity-1' });
    const afterSend = f.bench.snapshot('p1'); const sent = afterSend.messages.at(-1)!;
    assert.equal(afterSend.members[0]!.lastActivityAt, sent.createdAt); assert.equal(afterSend.members[1]!.lastActivityAt, before[1]);
    await tick(); await f.post('codex', '/send', { to: 'claude', text: 'Question', request_id: 'activity-1' });
    assert.equal(f.bench.snapshot('p1').members[0]!.lastActivityAt, sent.createdAt);
    await f.post('claude', '/reply', { message_id: sent.id, text: 'Answer' });
    const afterReply = f.bench.snapshot('p1'); assert.equal(afterReply.members[1]!.lastActivityAt, afterReply.messages.at(-1)!.createdAt);
    await tick(); f.context.onOutput('Final answer', 'activity-output');
    const afterOutput = f.bench.snapshot('p1'); assert.equal(afterOutput.members[0]!.lastActivityAt, afterOutput.messages.at(-1)!.createdAt);
  } finally { await f.close(); }
});
