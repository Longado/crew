// 用假模型测整理流程：分批、重试、去重、编号映射。真模型的效果由 npm run eval 看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import type { Message } from '../src/contracts.ts';
import { extractProject, buildPrompt } from '../src/extract/run.ts';
import type { ModelCall } from '../src/extract/model.ts';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(n = 2) {
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: '记账小程序', goal: '记账', dirs: [] });
  db.upsertSession({ id: 's1', source: 'claude_code', label: 'Claude Code', projectId, cwd: null, title: '导出', coverage: 'full' });
  const msgs: Message[] = Array.from({ length: n }, (_, i) => ({
    id: `s1:${i}`, sessionId: 's1', seq: i, role: i % 2 ? 'assistant' : 'user', text: i % 2 ? '导出做完了' : '做导出', ts: `2026-09-10T10:0${i % 10}:00+08:00`, capturedAt: 'x',
  }));
  db.insertMessages(msgs);
  return { db, projectId };
}

function fake(replies: string[]): ModelCall & { calls: string[] } {
  const calls: string[] = [];
  return { name: 'fake-1', calls, async call(_s, user) { calls.push(user); return replies[Math.min(calls.length - 1, replies.length - 1)]; } };
}

function skippedSeqs(db: ReturnType<typeof openDb>, sessionId = 's1') {
  return db.raw.prepare('SELECT seq FROM messages WHERE session_id = ? AND skipped_by_since = 1 ORDER BY seq').all(sessionId).map((r) => r.seq);
}

const ok = JSON.stringify({ evidence: [
  { reasoning: '用户要求', task: { newName: '导出' }, kind: 'started', cite: ['m1'], detail: '做导出' },
  { reasoning: 'AI 说完成', task: { newName: '导出' }, kind: 'ai_claims_done', cite: ['m2'], detail: 'AI 说导出做完了' },
] });

test('整理一次：证据入库，记下模型和提示词版本；重跑不再调用模型', async () => {
  const { db, projectId } = setup();
  const m = fake([ok]);
  const r1 = await extractProject(db, projectId, m);
  assert.equal(r1.stored, 2);
  assert.equal(m.calls.length, 1);
  const e = db.evidenceForProject(projectId);
  assert.equal(e[0].model, 'fake-1');
  assert.match(e[0].promptVersion, /^evidence-v\d+/);
  const r2 = await extractProject(db, projectId, m);
  assert.equal(r2.stored, 0);
  assert.equal(m.calls.length, 1);
});

test('第一次格式不对，带着错误重试一次；成功就入库', async () => {
  const { db, projectId } = setup();
  const m = fake(['这不是 JSON', ok]);
  const r = await extractProject(db, projectId, m);
  assert.equal(m.calls.length, 2);
  assert.match(m.calls[1], /上一次的输出不符合要求/);
  assert.equal(r.stored, 2);
});

test('两次都不对：这一批记为失败，不入库，下次同步会重试', async () => {
  const { db, projectId } = setup();
  const m = fake(['{"evidence": "错"}']);
  const r = await extractProject(db, projectId, m);
  assert.equal(r.failed, 1);
  assert.equal(db.evidenceForProject(projectId).length, 0);
  assert.equal(db.getSession('s1')!.extractedUpto, -1);
  assert.equal(db.failedBatches(projectId).length, 1);
});

test('提示词里已有任务用短编号，模型用短编号回答也能对上', async () => {
  const { db, projectId } = setup();
  await extractProject(db, projectId, fake([ok]));
  db.insertMessages([{ id: 's1:9', sessionId: 's1', seq: 9, role: 'user', text: '导出能用了', ts: '2026-09-11T10:00:00+08:00', capturedAt: 'x' }]);
  const m = fake([JSON.stringify({ evidence: [{ reasoning: '用户确认', task: { id: 'T01' }, kind: 'user_confirms_done', cite: ['m1'], detail: '用户确认导出能用' }] })]);
  await extractProject(db, projectId, m);
  assert.match(m.calls[0], /T01 导出/);
  const last = db.evidenceForProject(projectId).at(-1)!;
  assert.equal(last.taskId, `${projectId}/T01`);
});

test('长对话按批次切开，按时间顺序整理', async () => {
  const { db, projectId } = setup(40);
  const m = fake([JSON.stringify({ evidence: [] })]);
  const r = await extractProject(db, projectId, m, { maxChars: 20 });
  assert.ok(r.batches > 1, `批次 ${r.batches}`);
  assert.equal(db.getSession('s1')!.extractedUpto, 39);
});

test('提示词里标出来源覆盖不完整', () => {
  const { db, projectId } = setup();
  db.raw.prepare("UPDATE sessions SET coverage = 'partial' WHERE id = 's1'").run();
  const { user } = buildPrompt(db, projectId, db.getSession('s1')!, db.messagesForSession('s1'));
  assert.match(user, /覆盖：部分/);
});

test('给了 since：之前的消息不发给模型，算已整理', async () => {
  const { db, projectId } = setup(4); // 10:00、10:01、10:02、10:03
  const m = fake([JSON.stringify({ evidence: [] })]);
  await extractProject(db, projectId, m, { since: Date.parse('2026-09-10T10:02:00+08:00') });
  assert.equal(m.calls.length, 1);
  assert.ok(!m.calls[0].includes('10:01'), '10:01 的消息不该发出去');
  assert.match(m.calls[0], /\[m1\][^\n]*10:02/);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
  const again = fake([JSON.stringify({ evidence: [] })]);
  await extractProject(db, projectId, again); // 之后不带 since 也不会回头补旧消息
  assert.equal(again.calls.length, 0);
});

test('since 只标记尚未整理的跳过消息，真正整理过的消息不补标记', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  assert.deepEqual(skippedSeqs(db), [0, 1]);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:04:00+08:00') });
  assert.deepEqual(skippedSeqs(db), [0, 1]);
});

test('since 从 10:02 前移到 10:01：只补 10:01，游标不倒退且重跑不重复', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  const m = fake(['{"evidence":[]}']);
  const opts = { since: Date.parse('2026-09-10T10:01:00+08:00') };
  await extractProject(db, projectId, m, opts);
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0], /\[m1\][^\n]*10:01/);
  assert.doesNotMatch(m.calls[0], /10:00|10:02|10:03|\[m2\]/);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
  assert.deepEqual(skippedSeqs(db), [0]);
  await extractProject(db, projectId, m, opts);
  assert.equal(m.calls.length, 1);
});

test('补整理与新消息同会话按序切批，不同会话仍按时间交错', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  db.upsertSession({ id: 's2', source: 'claude_code', label: '另一会话', projectId, cwd: null, title: null, coverage: 'full' });
  db.insertMessages([
    { id: 's1:4', sessionId: 's1', seq: 4, role: 'user', text: '同会话的新消息', ts: '2026-09-10T10:04:00+08:00', capturedAt: 'x' },
    { id: 's2:0', sessionId: 's2', seq: 0, role: 'user', text: '另一会话的新消息', ts: '2026-09-10T10:02:30+08:00', capturedAt: 'x' },
  ]);
  const m = fake(['{"evidence":[]}']);
  await extractProject(db, projectId, m, { since: Date.parse('2026-09-10T10:01:00+08:00'), maxChars: 1 });
  assert.deepEqual(m.calls.map((c) => c.match(/^\[m1\][^\n]*(10:\d{2})/m)?.[1]), ['10:01', '10:02', '10:04']);
  assert.match(m.calls[1], /来源：另一会话/);
  assert.match(m.calls[2], /同会话的新消息/);
  assert.equal(db.getSession('s1')!.extractedUpto, 4);
  assert.deepEqual(skippedSeqs(db), [0]);
});

test('补整理失败保留标记并停止后续新批次，下次带 since 能续跑', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  db.insertMessages([{ id: 's1:4', sessionId: 's1', seq: 4, role: 'user', text: '新消息', ts: '2026-09-10T10:04:00+08:00', capturedAt: 'x' }]);
  const opts = { since: Date.parse('2026-09-10T10:01:00+08:00'), maxChars: 1 };
  const failed = fake(['坏 JSON']);
  const r = await extractProject(db, projectId, failed, opts);
  assert.equal(r.failed, 1);
  assert.equal(failed.calls.length, 2);
  for (const call of failed.calls) {
    assert.match(call, /\[m1\][^\n]*10:01/);
    assert.doesNotMatch(call, /10:04/);
  }
  assert.deepEqual(skippedSeqs(db), [0, 1]);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
  const retry = fake(['{"evidence":[]}']);
  assert.equal((await extractProject(db, projectId, retry, opts)).failed, 0);
  assert.deepEqual(retry.calls.map((c) => c.match(/^\[m1\][^\n]*(10:\d{2})/m)?.[1]), ['10:01', '10:04']);
  assert.deepEqual(skippedSeqs(db), [0]);
  assert.equal(db.getSession('s1')!.extractedUpto, 4);
  assert.equal(db.failedBatches(projectId).length, 0);
});

test('补整理拆批后只清成功子批标记，失败子批下次继续', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:03:00+08:00') });
  const opts = { since: Date.parse('2026-09-10T10:01:00+08:00') };
  const m = fake(['坏 JSON', '坏 JSON', '{"evidence":[]}', '坏 JSON', '坏 JSON']);
  assert.equal((await extractProject(db, projectId, m, opts)).failed, 1);
  assert.equal(m.calls.length, 5);
  assert.deepEqual(skippedSeqs(db), [0, 2]);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
  const retry = fake(['{"evidence":[]}']);
  await extractProject(db, projectId, retry, opts);
  assert.equal(retry.calls.length, 1);
  assert.match(retry.calls[0], /\[m1\][^\n]*10:02/);
  assert.doesNotMatch(retry.calls[0], /10:01|10:03/);
  assert.deepEqual(skippedSeqs(db), [0]);
});

test('不带 since 时只整理新消息，跳过标记保持不变', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  db.insertMessages([{ id: 's1:4', sessionId: 's1', seq: 4, role: 'user', text: '新消息', ts: '2026-09-10T10:04:00+08:00', capturedAt: 'x' }]);
  const m = fake(['{"evidence":[]}']);
  await extractProject(db, projectId, m);
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0], /\[m1\][^\n]*10:04/);
  assert.doesNotMatch(m.calls[0], /10:00|10:01|10:02|10:03/);
  assert.deepEqual(skippedSeqs(db), [0, 1]);
});

test('命中 batchDone 的补整理批次也清除对应标记', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  const opts = { since: Date.parse('2026-09-10T10:01:00+08:00') };
  await extractProject(db, projectId, fake(['{"evidence":[]}']), opts);
  // 模拟已成功登记的批次留下了标记，复用真实的批次键。
  db.raw.prepare("UPDATE messages SET skipped_by_since = 1 WHERE id = 's1:1'").run();
  const m = fake(['坏 JSON']);
  const r = await extractProject(db, projectId, m, opts);
  assert.equal(r.batches, 1);
  assert.equal(r.failed, 0);
  assert.equal(m.calls.length, 0);
  assert.deepEqual(skippedSeqs(db), [0]);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
});

test('被新版本替代的消息即使有 since 标记也不补发', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  db.markReplaced(['s1:1'], 's1:3');
  const m = fake(['{"evidence":[]}']);
  await extractProject(db, projectId, m, { since: Date.parse('2026-09-10T10:00:00+08:00') });
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0], /\[m1\][^\n]*10:00/);
  assert.doesNotMatch(m.calls[0], /10:01|10:02|10:03/);
  assert.deepEqual(skippedSeqs(db), [1]);
});

test('resetExtraction 清除项目的 since 标记，从头整理', async () => {
  const { db, projectId } = setup(4);
  await extractProject(db, projectId, fake(['{"evidence":[]}']), { since: Date.parse('2026-09-10T10:02:00+08:00') });
  assert.deepEqual(skippedSeqs(db), [0, 1]);
  db.resetExtraction(projectId);
  assert.deepEqual(skippedSeqs(db), []);
  assert.equal(db.getSession('s1')!.extractedUpto, -1);
  const m = fake(['{"evidence":[]}']);
  await extractProject(db, projectId, m);
  assert.equal(m.calls.length, 1);
  for (const minute of ['10:00', '10:01', '10:02', '10:03']) assert.ok(m.calls[0].includes(minute), minute);
  assert.equal(db.getSession('s1')!.extractedUpto, 3);
});

test('openDb 给旧库补 since 标记字段，已有消息默认未标记且可重复打开', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-since-migration-'));
  const file = join(dir, 'old.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT, captured_at TEXT NOT NULL
  );
  INSERT INTO messages VALUES ('old:0', 'old', 0, 'user', '旧消息', '2026-09-10T10:00:00+08:00', 'x');`);
  legacy.close();
  let db: ReturnType<typeof openDb> | undefined;
  t.after(() => { db?.raw.close(); rmSync(dir, { recursive: true, force: true }); });
  db = openDb(file);
  const column = db.raw.prepare('PRAGMA table_info(messages)').all().find((r) => r.name === 'skipped_by_since');
  assert.ok(column);
  assert.equal(column.type, 'INTEGER');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  assert.equal(db.raw.prepare("SELECT skipped_by_since FROM messages WHERE id = 'old:0'").get()!.skipped_by_since, 0);
  db.raw.close();
  db = openDb(file);
  assert.deepEqual(skippedSeqs(db, 'old'), []);
  assert.equal(db.messagesForSession('old')[0].text, '旧消息');
});

test('Claude 订阅模型：只带白名单环境变量、关掉工具，从结果里取 JSON 并累计用量', async () => {
  const { claudeCli } = await import('../src/extract/model.ts');
  const dir = mkdtempSync(join(tmpdir(), 'corpus-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi
printf '%s\\n' "$@" > "${dir}/args"; env > "${dir}/env"; cat > "${dir}/stdin"
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"\`\`\`json\\n{\\"evidence\\":[]}\\n\`\`\`","usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":50}}'
`);
  chmodSync(bin, 0o755);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  try {
    const model = claudeCli({ model: 'claude-sonnet-5-5', bin });
    assert.equal(model.name, 'claude-sonnet-5-5');
    assert.equal(await model.call('系统说明', '消息正文'), '{"evidence":[]}');
    await model.call('系统说明', '第二批');
    assert.deepEqual(model.usage, { calls: 2, input: 240, output: 60, cacheRead: 0, cacheCreate: 100 });
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
  for (const flag of ['-p', '--safe-mode', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(args[args.indexOf('--system-prompt') + 1], '系统说明');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(readFileSync(join(dir, 'stdin'), 'utf8'), '第二批');
  assert.ok(!readFileSync(join(dir, 'env'), 'utf8').includes('ANTHROPIC_API_KEY'));
});
