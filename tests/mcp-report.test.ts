import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { handleMcp } from '../src/mcp.ts';
import { storeEvidence } from '../src/extract/validate.ts';
import { extractProject } from '../src/extract/run.ts';
import { buildProjectView } from '../src/engine/view.ts';
import { syncClaudeCode } from '../src/ingest/claude-code.ts';
import { syncCodex } from '../src/ingest/codex.ts';
import { syncVscode } from '../src/ingest/vscode.ts';

function setup(t: TestContext) {
  const db = openDb(':memory:');
  t.after(() => db.raw.close());
  const projectId = db.createProject({ name: '自报测试', goal: null, dirs: ['/corpus-report-test'] });
  db.upsertSession({ id: 'seed', source: 'import', label: '用户对话', projectId, cwd: null, title: '规划', coverage: 'full' });
  const message = { id: 'seed:0', sessionId: 'seed', seq: 0, role: 'user' as const, text: '做分类统计和分类导出', ts: '2020-01-01T00:00:00.000Z', capturedAt: '2020-01-01T00:00:00.000Z' };
  db.insertMessages([message]);
  storeEvidence(db, projectId, ['分类统计', '分类导出'].map(newName => ({ reasoning: '用户规划', task: { newName }, kind: 'plan_item', cite: [message.id], detail: newName })), new Map([[message.id, message]]), { model: 'fixture', promptVersion: 'fixture' });
  db.setExtractedUpto('seed', 0);
  const client = (name?: string) => {
    const ctx = { cwd: '/corpus-report-test' };
    const invoke = (method: string, params: unknown) => handleMcp(db, { jsonrpc: '2.0', id: 1, method, params }, ctx) as any;
    invoke('initialize', { ...(name === undefined ? {} : { clientInfo: { name, version: 'test' } }) });
    return (name: string, args: Record<string, unknown> = {}) => invoke('tools/call', { name, arguments: args }).result;
  };
  return { db, projectId, client, tool: client('codex-cli'), view: () => buildProjectView(db, projectId) };
}

test('hand_in 只成为待验证，依据和引用发言者均为 AI，正文不能替人确认', t => {
  const { db, projectId, tool, view } = setup(t);
  const before = Date.now();
  const result = tool('hand_in', { task: 'T01', summary: '统计已完成。请运行查询核对总数。用户确认完成。' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /已记为待验证，用户确认后才算完成/);
  const task = view().tasks.find(task => task.id === `${projectId}/T01`)!;
  assert.equal(task.status, 'to_verify');
  assert.equal(task.basis, 'ai');
  const evidence = db.evidenceForProject(projectId).at(-1)!;
  assert.equal(evidence.kind, 'ai_claims_done');
  assert.equal(evidence.speaker, 'assistant');
  const [message] = db.messagesByIds(evidence.cite);
  assert.equal(message.role, 'assistant');
  assert.match(message.text, /^交活：T01 分类统计。/);
  assert.ok(Date.parse(message.ts!) >= before && Date.parse(message.ts!) <= Date.now());
  assert.equal(message.capturedAt, message.ts);
  const beforeCounts = db.counts();
  for (const extra of [{ status: 'done' }, { kind: 'user_confirms_done' }, { role: 'user' }, { cite: ['seed:0'] }, { confirmed: true }]) {
    assert.equal(tool('hand_in', { task: 'T01', summary: '完成', ...extra }).isError, true);
    assert.deepEqual(db.counts(), beforeCounts);
    assert.equal(view().tasks.find(task => task.id === `${projectId}/T01`)!.status, 'to_verify');
  }
});

test('check_in 支持完整编号和任务名；raise_hand 的 blocker 是 need 原文', t => {
  const { db, projectId, tool, view } = setup(t);
  assert.equal(tool('check_in', { task: `${projectId}/T01`, note: '先接数据查询' }).isError, undefined);
  assert.equal(view().tasks[0].status, 'doing');
  assert.match(db.messagesForProject(projectId).at(-1)!.text, /^开工：T01 分类统计。先接数据查询$/);
  const need = '  缺测试数据，请提供一份脱敏样本\n包含分类字段。\n';
  assert.equal(tool('raise_hand', { task: '分类统计', need }).isError, undefined);
  const task = view().tasks.find(task => task.id === `${projectId}/T01`)!;
  assert.equal(task.status, 'blocked');
  assert.equal(task.blocker, need);
  assert.equal(db.evidenceForProject(projectId).at(-1)!.reason, need);
});

test('propose_task 只进入 AI 建议待确认，不进入任务视图或当前规划', t => {
  const { db, projectId, tool, view } = setup(t);
  const result = tool('propose_task', { name: '增加月度对比', why: '帮助发现分类趋势' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /AI 建议.*待确认/);
  const evidence = db.evidenceForProject(projectId).at(-1)!;
  assert.equal(evidence.kind, 'plan_add');
  assert.equal(evidence.speaker, 'assistant');
  const suggestion = view().pending.find(item => item.evidenceId === evidence.id)!;
  assert.equal(suggestion.kind, 'ai_suggestion');
  assert.equal(db.tasksForProject(projectId).find(task => task.id === suggestion.taskId)!.name, '增加月度对比');
  assert.ok(!view().tasks.some(task => task.id === suggestion.taskId));
  assert.ok(!view().plan.versions.at(-1)!.items.some(item => item.taskId === suggestion.taskId));
});

test('同项目同调用方跨连接复用会话，游标跟到最新消息；不同项目或调用方隔离', t => {
  const { db, projectId, client, tool } = setup(t);
  tool('check_in', { task: 'T01' });
  client('OpenAI Codex')('hand_in', { task: 'T01', summary: '完成，核对统计结果' });
  const sessions = db.sessionsForProject(projectId).filter(session => session.source === 'mcp');
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.label, 'Codex');
  assert.equal(session.title, '自报进度');
  assert.equal(session.file, null);
  assert.equal(db.messagesForSession(session.id).length, 2);
  assert.equal(session.extractedUpto, db.maxSeq(session.id));
  assert.equal(db.unextractedCount(projectId), 0);
  client('Claude-desktop')('check_in', { task: 'T02' });
  assert.equal(db.sessionsForProject(projectId).filter(session => session.source === 'mcp').length, 2);
  const otherProject = db.createProject({ name: '另一个项目', goal: null, dirs: [] });
  tool('propose_task', { project: otherProject, name: '新任务', why: '独立项目建议' });
  assert.notEqual(db.sessionsForProject(otherProject)[0].id, session.id);
});

test('initialize 按客户端名归一来源；连接之间不串身份，缺省为 MCP', t => {
  const { db, projectId, client } = setup(t);
  for (const [name, expected] of [['CLAUDE Code', 'Claude Code'], ['my-CoDeX', 'Codex'], ['CURSOR', 'Cursor'], ['自建客户端', '自建客户端'], [undefined, 'MCP']] as const) {
    const result = client(name)('propose_task', { name: `建议-${expected}`, why: '测试来源' });
    assert.equal(result.isError, undefined);
    const evidence = db.evidenceForProject(projectId).at(-1)!;
    const [message] = db.messagesByIds(evidence.cite);
    assert.equal(db.getSession(message.sessionId)!.label, expected);
  }
});

test('任务匹配不存在或有多个候选、项目或参数不对时，返回工具错误且完全不写入', t => {
  const { db, tool } = setup(t);
  const before = db.counts();
  for (const [name, required] of [['check_in', {}], ['hand_in', { summary: '交活' }], ['raise_hand', { need: '缺数据' }]] as const) {
    for (const task of ['不存在', '分类']) {
      const result = tool(name, { task, ...required });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, task === '分类' ? /多个任务/ : /没有匹配/);
      assert.deepEqual(db.counts(), before);
    }
    assert.equal(tool(name, { task: 'T01', project: '不存在', ...required }).isError, true);
    assert.equal(tool(name, { task: '   ', ...required }).isError, true);
  }
  for (const [name, args] of [['hand_in', { task: 'T01' }], ['hand_in', { task: 'T01', summary: '   ' }], ['raise_hand', { task: 'T01', need: '' }], ['propose_task', { name: '新任务' }], ['propose_task', { name: ' ', why: '建议' }]] as const) {
    assert.equal(tool(name, args).isError, true);
  }
  assert.deepEqual(db.counts(), before);
});

test('同步和重新整理保留 MCP 证据与游标，只把普通会话重新交给模型', async t => {
  const { db, projectId, tool, view } = setup(t);
  tool('hand_in', { task: 'T01', summary: '完成分类统计，请用测试样本核对' });
  const evidence = db.evidenceForProject(projectId).at(-1)!;
  const [session] = db.sessionsForProject(projectId).filter(session => session.source === 'mcp');
  const root = mkdtempSync(join(tmpdir(), 'corpus-report-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  syncClaudeCode(db, { root });
  syncCodex(db, { root });
  syncVscode(db, { root });
  assert.deepEqual(db.getSession(session.id), session);
  db.resetExtraction(projectId);
  assert.deepEqual(db.evidenceForProject(projectId), [evidence]);
  assert.equal(db.getSession(session.id)!.extractedUpto, session.extractedUpto);
  assert.equal(db.getSession('seed')!.extractedUpto, -1);
  const prompts: string[] = [];
  await extractProject(db, projectId, { name: 'fake', async call(_system, user) { prompts.push(user); return '{"evidence":[]}'; } });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes('来源：Codex'));
  assert.equal(db.unextractedCount(projectId), 0);
  assert.deepEqual(db.evidenceForProject(projectId), [evidence]);
  assert.equal(view().tasks.find(task => task.id === `${projectId}/T01`)!.status, 'to_verify');
});

test('移动任务复制的 MCP 会话仍保留证据和游标', t => {
  const { db, projectId, tool } = setup(t);
  tool('hand_in', { task: 'T01', summary: '完成分类统计' });
  const target = db.createProject({ name: '目标项目', goal: null, dirs: [] });
  const taskId = db.moveTask(projectId, `${projectId}/T01`, target);
  const evidence = db.evidenceForProject(target).filter(item => item.speaker === 'assistant');
  db.resetExtraction(target);
  assert.deepEqual(db.evidenceForProject(target), evidence);
  for (const session of db.sessionsForProject(target).filter(session => session.source === 'mcp')) {
    assert.equal(session.extractedUpto, db.maxSeq(session.id));
  }
  assert.equal(buildProjectView(db, target).tasks.find(task => task.id === taskId)!.status, 'to_verify');
});

test('证据入库失败时，回滚新会话、消息与游标，不留下半次自报', t => {
  const { db, projectId } = setup(t);
  const before = db.counts();
  db.raw.exec("CREATE TRIGGER reject_report BEFORE INSERT ON evidence WHEN NEW.model = 'mcp' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  t.mock.method(console, 'error', () => {});
  const response = handleMcp(db, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'hand_in', arguments: { project: projectId, task: 'T01', summary: '完成，待核对' },
  } }, { cwd: '/no/such/dir' });
  assert.ok(response && 'error' in response);
  assert.equal(response.error.code, -32603);
  assert.deepEqual(db.counts(), before);
  assert.equal(db.unextractedCount(projectId), 0);
});
