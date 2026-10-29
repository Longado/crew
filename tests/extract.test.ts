// 用假模型测整理流程：分批、重试、去重、编号映射。真模型的效果由 npm run eval 看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import type { Message } from '../src/contracts.ts';
import { extractProject, buildPrompt } from '../src/extract/run.ts';
import type { ModelCall } from '../src/extract/model.ts';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
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
