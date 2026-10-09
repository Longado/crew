import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-task-cli-')));
  mkdirSync(join(root, '.data')); mkdirSync(join(root, 'project'));
  const db = new DatabaseSync(join(root, '.data/tasks.db'));
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,local_path TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT); INSERT INTO projects VALUES(1,'project'); INSERT INTO tasks VALUES(7,1,'保留沉淀','blocked','medium','原有记录');`);
  db.close();
  const manifest = join(root, '清单.json');
  writeFileSync(manifest, JSON.stringify({ batch: 'fixture', tasks: [{ task_id: 7, line: 'Test', sources: [1], status: 'todo', owner: 'Codex', next: 'Read', acceptance: 'Check', dependency: 'Wait' }] }));
  const home = join(root, 'unused-corpus-home');
  const run = (args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, 'tasks', ...args, '--workspace', root, '--manifest', manifest], { env: { ...process.env, CORPUS_HOME: home }, encoding: 'utf8', timeout: 10_000 });
  return { root, home, manifest, run };
}

test('tasks list/get/status read the canonical fixture without opening the Corpus database', () => {
  const f = fixture();
  try {
    const list = f.run(['list']); assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).tasks[0].status, 'blocked');
    const get = f.run(['get', '--task', '7']); assert.equal(get.status, 0, get.stderr);
    assert.equal(JSON.parse(get.stdout).task_id, 7);
    const status = f.run(['status', '--task', '7']); assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).task.status, 'blocked');
    assert.deepEqual(JSON.parse(status.stdout).jobs, []);
    assert.equal(existsSync(f.home), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('tasks cancel needs expected status and reason, then keeps original notes and syncs manifest', () => {
  const f = fixture();
  try {
    const invalid = f.run(['cancel', '--task', '7']); assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /expected-status/);
    const result = f.run(['cancel', '--task', '7', '--expected-status', 'blocked', '--note', '用户终止，保留沉淀']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).task.status, 'cancelled');
    assert.equal(JSON.parse(result.stdout).manifest_synced, true);
    const db = new DatabaseSync(join(f.root, '.data/tasks.db'));
    const row = db.prepare('SELECT notes FROM tasks WHERE id=7').get(); db.close();
    assert.match(String(row!.notes), /原有记录/); assert.match(String(row!.notes), /用户终止，保留沉淀/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('tasks CLI rejects unknown commands and missing dispatch goal before any execution', () => {
  const f = fixture();
  try {
    assert.match(f.run(['dispatch', '--task', '7']).stderr, /goal/);
    assert.match(f.run(['unknown']).stderr, /tasks/);
    const help = spawnSync(process.execPath, ['--no-warnings', CLI, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /tasks list/); assert.match(help.stdout, /tasks mcp/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
