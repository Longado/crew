import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskBoardClient as LegacyHttpTaskBoardClient } from '../src/task-board-control.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-task-control-')));
  mkdirSync(join(root, '.data')); mkdirSync(join(root, 'project'));
  const db = new DatabaseSync(join(root, '.data/tasks.db'));
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,local_path TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT);
    INSERT INTO projects VALUES(1,'project');
    INSERT INTO tasks VALUES(219,1,'图片拖动','blocked','medium','原有沉淀');
    INSERT INTO tasks VALUES(225,1,'LLM研究','blocked','medium','');`);
  db.close();
  const manifest = join(root, '清单.json');
  writeFileSync(manifest, JSON.stringify({ batch: 'control-fixture', tasks: [
    { task_id: 219, sources: [1], line: '图片拖动', status: 'blocked', owner: 'Codex', next: '等待决定', acceptance: 'Check', dependency: 'Wait' },
    { task_id: 225, sources: [8, 17], line: 'LLM研究', status: 'blocked', owner: 'Codex', next: '主实验暂缓', acceptance: 'Check', dependency: 'Wait' },
  ] }));
  const args = ['--workspace', root, '--manifest', manifest];
  const run = async (input: string[]) => {
    const child = spawn(process.execPath, ['--no-warnings', cli, 'tasks', ...input, ...args], { timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  return { root, manifest, args, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('CLI compatibility aliases read and cancel only the temporary workspace task', async () => {
  const f = fixture();
  try {
    const listed = await f.run(['list', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    const tasks = JSON.parse(listed.stdout).tasks;
    assert.deepEqual(tasks[1].sources, [8, 17]);
    assert.equal(tasks[1].task_id, 225); assert.equal(tasks[1].line, 'LLM研究');
    const shown = await f.run(['show', '219', '--json']);
    assert.equal(shown.code, 0, shown.stderr); assert.equal(JSON.parse(shown.stdout).status, 'blocked');
    const conflict = await f.run(['cancel', '219', '--expected-status', 'todo', '--reason', '旧状态']);
    assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /状态/);
    const cancelled = await f.run(['cancel', '219', '--expected-status', 'blocked', '--reason', '用户终止，资料保留']);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).task.status, 'cancelled');
    assert.equal(JSON.parse(cancelled.stdout).manifest_synced, true);
    assert.equal(JSON.parse(readFileSync(f.manifest, 'utf8')).tasks[0].status, 'cancelled');
    const repeated = await f.run(['cancel', '219', '--expected-status', 'blocked', '--reason', '停止']);
    assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).idempotent, true);
  } finally { f.close(); }
});

test('CLI rejects remote service URLs and cancellation without observed status', async () => {
  const f = fixture();
  try {
    const remote = await f.run(['list', '--board-url', 'https://example.com']);
    assert.notEqual(remote.code, 0); assert.match(remote.stderr, /本地/);
    const incomplete = await f.run(['cancel', '219', '--reason', '停止']);
    assert.notEqual(incomplete.code, 0); assert.match(incomplete.stderr, /expected-status/);
    const shown = await f.run(['get', '--task', '219']);
    assert.equal(shown.code, 0, shown.stderr); assert.equal(JSON.parse(shown.stdout).status, 'blocked');
  } finally { f.close(); }
});

test('stdio MCP exposes six current tools and cancellation stays in its configured fixture', async () => {
  const f = fixture();
  const client = new Client({ name: 'crew-tasks-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', cli, 'tasks', 'mcp', ...f.args], stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['crew_tasks_cancel', 'crew_tasks_dispatch', 'crew_tasks_get', 'crew_tasks_list', 'crew_tasks_status', 'crew_tasks_stop']);
    assert.equal(tools.find(t => t.name === 'crew_tasks_get')!.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'crew_tasks_cancel')!.annotations?.readOnlyHint, false);
    const get = await client.callTool({ name: 'crew_tasks_get', arguments: { task: 219 } });
    assert.match(JSON.stringify(get.content), /图片拖动/);
    const cancelled = await client.callTool({ name: 'crew_tasks_cancel', arguments: { task: 219, expected_status: 'blocked', note: '用户明确终止临时任务' } });
    assert.equal(cancelled.isError, undefined);
    assert.equal(JSON.parse((cancelled.content as { text: string }[])[0].text).task.status, 'cancelled');
    const unknown = await client.callTool({ name: 'crew_tasks_get', arguments: { task: 999 } });
    assert.equal(unknown.isError, true);
  } finally { await client.close(); await transport.close(); f.close(); }
});

test('legacy HTTP client retains independent list/get and cancellation request coverage', async t => {
  const tasks = [{ task_id: 219, sources: [1], line: 'HTTP fixture', status: 'blocked', next: 'Wait' }];
  const requests: { url: string; body?: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    assert.equal(new Headers(init?.headers).get('x-corpus'), '1');
    return new Response(JSON.stringify(init?.method === 'POST' ? { task: { ...tasks[0], status: 'cancelled' }, manifest_synced: true, idempotent: false } : { tasks }));
  });
  const client = new LegacyHttpTaskBoardClient('http://127.0.0.1:6480');
  assert.deepEqual(await client.list(), tasks);
  assert.equal((await client.get(219)).line, 'HTTP fixture');
  const cancelled = await client.cancel({ task_id: 219, expected_status: 'blocked', reason: '明确终止' });
  assert.equal((cancelled.task as { status: string }).status, 'cancelled');
  assert.deepEqual(requests.at(-1), { url: 'http://127.0.0.1:6480/api/tasks/cancel', body: { task_id: 219, expected_status: 'blocked', reason: '明确终止' } });
});

test('legacy HTTP client rejects invalid cancellation and forwards server errors without local writes', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(JSON.stringify({ error: '状态已改变' }), { status: 400 }); });
  const client = new LegacyHttpTaskBoardClient();
  await assert.rejects(client.cancel({ task_id: 219, expected_status: 'blocked', reason: '第一行\n第二行' }));
  assert.equal(requests, 0);
  await assert.rejects(client.cancel({ task_id: 219, expected_status: 'blocked', reason: '终止' }), /状态已改变/);
  assert.equal(requests, 1);
});
