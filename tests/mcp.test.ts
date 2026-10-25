import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { loadDemo } from '../src/demo.ts';
import { handleMcp } from '../src/mcp.ts';

const db = openDb(':memory:');
const [p1, p2] = loadDemo(db);
const ctx = { cwd: '/no/such/dir' };

const call = (method: string, params?: unknown) => handleMcp(db, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, ctx) as any;
const tool = (name: string, args: Record<string, string> = {}) => call('tools/call', { name, arguments: args }).result;

test('initialize 回应客户端要的协议版本，没给就用默认', () => {
  const r = call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, 'working-corpus');
  assert.equal(call('initialize', {}).result.protocolVersion, '2025-06-18');
});

test('通知不回复；未知方法返回 -32601', () => {
  assert.equal(handleMcp(db, { jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  assert.equal(call('no/such').error.code, -32601);
  assert.deepEqual(call('ping').result, {});
});

test('tools/list 有三个读工具、四个写工具，各带说明和参数结构', () => {
  const tools = call('tools/list').result.tools;
  const readers = ['continue_context', 'list_projects', 'project_status'];
  assert.deepEqual(tools.map((t: any) => t.name).sort(), ['check_in', 'continue_context', 'hand_in', 'list_projects', 'project_status', 'propose_task', 'raise_hand']);
  for (const t of tools) {
    assert.ok(t.description.length > 10);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, readers.includes(t.name));
  }
  assert.deepEqual(tools.find((t: any) => t.name === 'continue_context').inputSchema.required, ['task']);
});

test('list_projects 列出名称、编号', () => {
  const text = tool('list_projects').content[0].text;
  assert.ok(text.includes(p1) && text.includes(p2));
});

test('project_status 按名字找项目：规划、状态、不要做、提醒都在', () => {
  const name = db.getProject(p1)!.name;
  const r = tool('project_status', { project: name });
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.match(text, /当前规划：第 \d+ 版/);
  assert.match(text, /已完成 · T01 记账录入 — /);
  assert.match(text, /不要做（已取消）：\n- T04 云同步/);
  assert.match(text, /下一步：\n1\. /);
  assert.match(text, /AI 自述完成只算待验证/);
});

test('project_status 不传项目时按当前目录推断；推断不出就报错并列出项目', () => {
  const d = openDb(':memory:');
  const [a] = loadDemo(d);
  d.addProjectDir(a, '/corpus-test/app');
  const r = handleMcp(d, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_status', arguments: {} } }, { cwd: '/corpus-test/app/src' }) as any;
  assert.ok(r.result.content[0].text.includes(`（${a}）`));
  const miss = tool('project_status');
  assert.equal(miss.isError, true);
  assert.ok(miss.content[0].text.includes(p1));
});

test('continue_context 用短编号拿到续接上下文', () => {
  const r = tool('continue_context', { project: p2, task: 'T01' });
  assert.match(r.content[0].text, /^# 继续：月度导出/);
});

test('continue_context 按名字找；找不到或有歧义时报错并列出候选', () => {
  assert.match(tool('continue_context', { project: p1, task: '本地备份' }).content[0].text, /^# 继续：本地备份/);

  const missing = tool('continue_context', { project: p1, task: '不存在的任务' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /T02 分类统计/);

  const d = openDb(':memory:');
  const [a] = loadDemo(d);
  d.addCorrection(a, { type: 'rename', taskId: `${a}/T02`, name: '月度统计' });
  const r = handleMcp(d, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'continue_context', arguments: { project: a, task: '月度' } } }, ctx) as any;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /T02 月度统计/);
  assert.match(r.result.content[0].text, /T03 月度导出/);
});

test('参数缺失、未知项目返回 isError，不是协议错误', () => {
  assert.equal(tool('continue_context', { project: p1 }).isError, true);
  assert.equal(tool('project_status', { project: '没有这个项目' }).isError, true);
  assert.equal(call('tools/call', { name: 'no_such_tool', arguments: {} }).error.code, -32602);
});

test('端到端：命令行 mcp 从 stdin 读、往 stdout 只写协议消息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-mcp-'));
  try {
    const file = join(dir, 'corpus.db');
    const seeded = openDb(file);
    const [projectId] = loadDemo(seeded);
    seeded.raw.close();

    const root = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(process.execPath, ['--no-warnings', 'src/cli.ts', 'mcp'], { cwd: root, env: { ...process.env, CORPUS_DB: file } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write('{不是 JSON\n');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_in', arguments: { project: projectId, task: 'T02', note: '先接数据查询' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hand_in', arguments: { project: projectId, task: 'T02', summary: '分类统计完成，请用样本核对计数' } } })}\n`);
    child.stdin.end();
    const [code] = await once(child, 'close');

    assert.equal(code, 0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 5);
    assert.equal(lines[0].result.serverInfo.name, 'working-corpus');
    assert.deepEqual(lines[1], { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    assert.equal(lines[2].id, 2);
    assert.equal(lines[2].result.tools.length, 7);
    assert.equal(lines[3].result.isError, undefined);
    assert.match(lines[4].result.content[0].text, /已记为待验证，用户确认后才算完成/);
    const reopened = openDb(file);
    try {
      const sessions = reopened.sessionsForProject(projectId).filter(session => session.source === 'mcp');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].label, 't');
      assert.equal(sessions[0].title, '自报进度');
      assert.equal(reopened.messagesForSession(sessions[0].id).length, 2);
      assert.equal(sessions[0].extractedUpto, reopened.maxSeq(sessions[0].id));
    } finally {
      reopened.raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
