import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const names = ['crew_tasks_cancel', 'crew_tasks_dispatch', 'crew_tasks_get', 'crew_tasks_list', 'crew_tasks_status', 'crew_tasks_stop'];

test('SDK discovery exposes six task tools and validated calls share the same client', async () => {
  const { createTaskBoardMcp } = await import('../src/task-board-mcp.ts');
  const { TaskBoardClient } = await import('../src/task-board-client.ts');
  const actions: string[] = [];
  const api = new TaskBoardClient({ runCommand: async (_file, args) => {
    actions.push(args[args.indexOf('--action') + 1]);
    return { stdout: JSON.stringify({ task_id: 7, status: 'blocked' }), stderr: '' };
  } });
  const server = createTaskBoardMcp(api);
  const client = new Client({ name: 'test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map(t => t.name).sort(), names);
    assert.equal(listing.tools.find(t => t.name === 'crew_tasks_get')!.annotations!.readOnlyHint, true);
    assert.equal(listing.tools.find(t => t.name === 'crew_tasks_cancel')!.annotations!.readOnlyHint, false);
    assert.match(listing.tools.find(t => t.name === 'crew_tasks_cancel')!.description!, /明确.*终止/);
    const got = await client.callTool({ name: 'crew_tasks_get', arguments: { task: 7 } });
    assert.equal(got.isError, undefined); assert.equal(JSON.parse((got.content as { text: string }[])[0].text).task_id, 7);
    const invalid = await client.callTool({ name: 'crew_tasks_cancel', arguments: { task: 7, note: 'Stop' } });
    assert.equal(invalid.isError, true); assert.deepEqual(actions, ['get']);
  } finally { await client.close(); await server.close(); }
});

test('actual stdio SDK initializes, discovers tools and reads a temporary workspace task', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-task-mcp-')));
  mkdirSync(join(root, '.data')); mkdirSync(join(root, 'project'));
  const db = new DatabaseSync(join(root, '.data/tasks.db'));
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,local_path TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT); INSERT INTO projects VALUES(1,'project'); INSERT INTO tasks VALUES(7,1,'MCP 临时任务','todo','medium','');`); db.close();
  const manifest = join(root, '清单.json');
  writeFileSync(manifest, JSON.stringify({ batch: 'stdio-fixture', tasks: [{ task_id: 7, line: 'Test', sources: [3], owner: 'Codex', next: 'Read', acceptance: 'Check' }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'tasks', 'mcp', '--workspace', root, '--manifest', manifest], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => stderr += String(chunk));
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), names);
    const result = await client.callTool({ name: 'crew_tasks_get', arguments: { task: 7 } });
    assert.equal(result.isError, undefined, stderr);
    assert.equal(JSON.parse((result.content as { text: string }[])[0].text).title, 'MCP 临时任务');
    const conflict = await client.callTool({ name: 'crew_tasks_cancel', arguments: { task: 7, expected_status: 'blocked', note: '旧状态测试' } });
    assert.equal(conflict.isError, true);
    const cancelled = await client.callTool({ name: 'crew_tasks_cancel', arguments: { task: 7, expected_status: 'todo', note: '用户明确终止临时测试任务，保留成果' } });
    assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled));
    assert.equal(JSON.parse((cancelled.content as { text: string }[])[0].text).task.status, 'cancelled');
    const updated = await client.callTool({ name: 'crew_tasks_status', arguments: { task: 7 } });
    assert.equal(JSON.parse((updated.content as { text: string }[])[0].text).task.status, 'cancelled');
    const stale = await client.callTool({ name: 'crew_tasks_cancel', arguments: { task: 7, expected_status: 'todo', note: '重复旧状态' } });
    assert.equal(stale.isError, undefined);
    assert.equal(JSON.parse((stale.content as { text: string }[])[0].text).idempotent, true);
    assert.equal(stderr, '');
  } finally { await client.close(); await transport.close(); rmSync(root, { recursive: true, force: true }); }
});
