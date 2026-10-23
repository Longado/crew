import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import type { TaskStatus } from '../src/contracts.ts';
import type { TaskSource, TaskSnapshot } from '../src/today/source.ts';
import { createTaskSource } from '../src/today/source.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, renameSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(t: any, taskSource?: TaskSource) {
  const db = openDb(':memory:');
  // Any accidental team, terminal, credential or scanner access must fail.
  const inert = new Proxy({ close: async () => {} }, {
    get(target, key) {
      if (key === 'close') return target.close;
      return () => { throw Error(`Unexpected service access: ${String(key)}`); };
    },
  });
  const server = serve(db, 0, inert as any, inert as any, inert as any, taskSource);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.raw.close();
  });
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body ? 'POST' : 'GET') =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-corpus': '1', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const today = async () => {
    const response = await req('/api/today');
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  return { db, req, today };
}

test('today starts empty with a named local source and no invented schedule', async t => {
  const { db, today } = await fixture(t);
  const before = db.counts();
  const data = await today();
  assert.equal(data.source.kind, 'local_corpus');
  assert.equal(data.source.automatic, false);
  assert.equal(data.totalTasks, 0);
  assert.deepEqual(data.suggested, []);
  assert.deepEqual(data.blocked, []);
  assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.timeZone);
  assert.deepEqual(db.counts(), before, 'reading today must not import or create data');
});

test('without an explicit source today shows only local tasks and refresh reports not configured', async t => {
  const { db, req, today } = await fixture(t);
  const projectId = db.createProject({ name: '本地示例项目', dirs: [], goal: null });
  const taskId = db.addTask({ projectId, name: '本地待办', goal: null, createdAt: new Date().toISOString() });
  db.addCorrection(projectId, { type: 'set_status', taskId, status: 'todo' });
  const before = db.counts();
  const data = await today();
  assert.equal(data.source.configured, false);
  assert.equal(data.source.label, '当前 Crew 本地任务库');
  assert.equal(data.source.importedCount, 0);
  assert.equal(data.totalTasks, 1);
  assert.equal(data.suggested[0].taskId, taskId);
  assert.equal(data.suggested[0].sourceId, undefined);
  const response = await req('/api/today/refresh', {});
  assert.equal(response.status, 409);
  assert.match((await response.json() as any).error, /尚未配置/);
  assert.deepEqual((await today()).suggested, data.suggested);
  assert.deepEqual(db.counts(), before);
});

test('refresh imports an explicit source snapshot and searches without manual entry or main-library writes', async t => {
  let saved: TaskSnapshot | undefined, reads = 0;
  const source: TaskSource = {
    read: () => saved,
    refresh: () => {
      reads++;
      saved = { version: 1, refreshedAt: new Date().toISOString(), tasks: [
        { sourceId: 17, projectId: 1, projectName: '项目 A', projectStatus: 'active', title: '准备资料', status: 'todo', priority: 'high', dueDate: null, updatedAt: new Date().toISOString() },
        { sourceId: 18, projectId: 2, projectName: '项目 B', projectStatus: 'active', title: '等确认', status: 'blocked', priority: 'medium', dueDate: null, updatedAt: new Date().toISOString() },
      ] };
      return saved;
    },
  };
  const { db, req, today } = await fixture(t, source);
  assert.equal((await today()).totalTasks, 0);
  assert.equal(reads, 0, 'reading a saved view does not query the main library');
  const response = await req('/api/today/refresh', {});
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.equal(data.source.kind, 'workspace_snapshot');
  assert.equal(data.source.importedCount, 2);
  assert.equal(data.suggested[0].sourceId, 17);
  assert.equal(data.blocked[0].sourceId, 18);
  const filtered = await (await req('/api/today?q=%2318')).json() as any;
  assert.equal(filtered.matchingTasks, 1);
  assert.equal(filtered.blocked[0].sourceId, 18);
  assert.equal(reads, 1);
  assert.equal((await req('/api/today/refresh', {})).status, 200);
  assert.equal((await today()).totalTasks, 2);
  assert.equal((await req('/api/today/tasks', { name: '手填任务' })).status, 404);
  assert.equal((await req('/api/today/refresh', { database: '/another/source' })).status, 400);
  assert.equal((await req('/api/projects/workspace:1/corrections', { type: 'set_status', taskId: 'workspace:17', status: 'done' })).status, 404);
  assert.equal(db.counts().tasks, 0, 'source tasks remain snapshots, not duplicate editable Crew records');
});

test('failed source refresh keeps the last snapshot readable', async t => {
  const snapshot: TaskSnapshot = { version: 1, refreshedAt: '2026-10-20T01:00:00Z', tasks: [] };
  const { req, today } = await fixture(t, { read: () => snapshot, refresh: () => { throw Error('unavailable'); } });
  assert.equal((await req('/api/today/refresh', {})).status, 503);
  assert.equal((await today()).source.refreshedAt, snapshot.refreshedAt);
});

test('configured synthetic SQLite supports search, exact IDs and refresh without changing the source or losing an offline snapshot', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'crew-today-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'source.db'), snapshotPath = join(directory, 'snapshot/tasks.json');
  const sourceDb = new DatabaseSync(database);
  sourceDb.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,status TEXT,local_path TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,due_date TEXT,updated_at TEXT,created_at TEXT,notes TEXT);
    CREATE TABLE session_log(summary TEXT);
    INSERT INTO projects VALUES(1,'合成项目','active','SYNTHETIC_PRIVATE_PATH'),(2,'暂停项目','paused','SYNTHETIC_PRIVATE_PATH');
    INSERT INTO session_log VALUES('SYNTHETIC_PRIVATE_SESSION');`);
  const insert = sourceDb.prepare('INSERT INTO tasks VALUES(?,?,?,\'todo\',\'medium\',NULL,?,NULL,\'SYNTHETIC_PRIVATE_NOTE\')');
  const now = new Date().toISOString();
  for (const [id, projectId, title, date] of [
    [17, 1, '准备资料', now], [170, 1, '整理材料', now], [18, 2, '暂停待办', now],
    [19, 1, '陈旧待办', '2000-01-01'], [20, 1, '普通待办', now], [21, 1, '补充待办', now],
  ] as const) insert.run(id, projectId, title, date);
  sourceDb.close();
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = digest(database);
  const { db, req, today } = await fixture(t, createTaskSource({ database, snapshotPath }));
  const localProject = db.createProject({ name: '本地项目', dirs: [], goal: null });
  const localTask = db.addTask({ projectId: localProject, name: '本地待办', goal: null, createdAt: now });
  db.addCorrection(localProject, { type: 'set_status', taskId: localTask, status: 'todo' });
  for (let i = 0; i < 2; i++) {
    assert.equal((await req('/api/today/refresh', {})).status, 200);
    assert.equal(digest(database), before);
  }
  const data = await today();
  assert.equal(data.totalTasks, 7);
  assert.equal(data.suggested.length, 3);
  assert.deepEqual(data.pending.map((item: any) => item.sourceId).sort(), [18, 19]);
  assert.equal(data.pending.every((item: any) => item.status === 'todo' && item.holdReason), true);
  assert.equal(db.counts().tasks, 1);
  const byId = await (await req('/api/today?q=%2317')).json() as any;
  assert.equal(byId.matchingTasks, 1);
  assert.equal(byId.suggested[0].sourceId, 17);
  const byWord = await (await req('/api/today?q=' + encodeURIComponent('资料'))).json() as any;
  assert.equal(byWord.matchingTasks, 1);
  const byProject = await (await req('/api/today?q=' + encodeURIComponent('合成项目'))).json() as any;
  assert.equal(byProject.matchingTasks, 5);
  assert.doesNotMatch(readFileSync(snapshotPath, 'utf8'), /SYNTHETIC_PRIVATE|notes|local_path|session/);
  assert.doesNotMatch(JSON.stringify(data), /SYNTHETIC_PRIVATE/);
  const saved = readFileSync(snapshotPath, 'utf8');
  renameSync(database, database + '.offline');
  assert.equal((await req('/api/today/refresh', {})).status, 503);
  assert.equal(readFileSync(snapshotPath, 'utf8'), saved);
  assert.equal((await today()).totalTasks, 7);
  assert.equal(digest(database + '.offline'), before);
});

test('cross-project suggestions prioritize review and active work, keep blocked and unconfirmed separate', async t => {
  const { db, today } = await fixture(t);
  const a = db.createProject({ name: '项目 A', goal: null, dirs: [] });
  const b = db.createProject({ name: '项目 B', goal: null, dirs: [] });
  const add = (pid: string, name: string, status: TaskStatus, note?: string) => {
    const id = db.addTask({ projectId: pid, name, goal: null, createdAt: '2026-10-20T01:00:00Z' });
    db.addCorrection(pid, { type: 'set_status', taskId: id, status, note });
    return id;
  };
  const todo = add(a, '规划中的任务', 'todo');
  add(a, '另一个待开始', 'todo');
  const doing = add(a, '继续处理', 'doing');
  const review = add(b, '核对已有产出', 'to_verify');
  const blocked = add(b, '等反馈', 'blocked', '等对方回复时间');
  const pending = add(b, '待确认的建议', 'pending_confirm');
  add(b, '已取消', 'cancelled');
  db.addCorrection(a, { type: 'backfill_plan', taskIds: [todo] });
  const data = await today();
  assert.deepEqual(data.suggested.map((x: any) => x.taskId), [review, doing, todo]);
  assert.equal(data.remaining.length, 1);
  assert.equal(data.blocked[0].taskId, blocked);
  assert.match(data.blocked[0].precondition, /等对方回复时间/);
  assert.equal(data.pending[0].taskId, pending);
  for (const item of [...data.suggested, ...data.blocked, ...data.pending]) {
    assert.ok(item.reason && item.action && item.precondition && item.doneStandard);
  }
  const stateBefore = db.counts();
  assert.deepEqual((await today()).suggested, data.suggested, 'same state should produce stable ordering');
  assert.deepEqual(db.counts(), stateBefore);
});

test('manual completion leaves recommendations; reopening removes it from today completed', async t => {
  const { db, req, today } = await fixture(t);
  const projectId = db.createProject({ name: '事项', goal: null, dirs: [] });
  const taskId = db.addTask({ projectId, name: '核对结果', goal: null, createdAt: new Date().toISOString() });
  const created = { projectId, taskId };
  const change = async (status: string) => {
    assert.equal((await req(`/api/projects/${created.projectId}/corrections`, { type: 'set_status', taskId: created.taskId, status })).status, 200);
  };
  await change('done');
  assert.deepEqual((await today()).suggested, []);
  assert.equal((await today()).completed.length, 1);
  await change('doing');
  assert.equal((await today()).completed.length, 0);
  assert.equal((await today()).suggested[0].status, 'doing');
});

test('today rejects foreign origins and malformed writes, serves its local module', async t => {
  const { req } = await fixture(t);
  for (const origin of ['https://example.invalid', 'chrome-extension://abc']) {
    assert.equal((await req('/api/today', undefined, { origin })).status, 403);
  }
  assert.equal((await req('/api/today/refresh', {}, { 'x-corpus': '' })).status, 403);
  assert.equal((await req('/api/today', undefined, {}, 'OPTIONS')).status, 403);
  for (const path of ['/today.js', '/today.css']) assert.equal((await req(path)).status, 200);
});
