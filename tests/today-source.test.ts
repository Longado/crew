import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const moduleUrl = new URL('../src/today/source.ts', import.meta.url);
async function setup(t: any) {
  assert.ok(existsSync(moduleUrl), 'read-only task search and snapshot source must exist');
  const { createTaskSource } = await import(moduleUrl.href);
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'crew-today-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'main.db'), snapshotPath = join(directory, 'private/snapshot.json');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,status TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,due_date TEXT,updated_at TEXT,created_at TEXT,notes TEXT);
    INSERT INTO projects VALUES(1,'示例项目','active'),(2,'已暂停项目','paused');
    INSERT INTO tasks VALUES
    (1,1,'准备资料','todo','high','2026-10-21','2026-10-20','2026-10-10','FAKE_PRIVATE_NOTE_NOT_TO_COPY'),
    (2,1,'等确认','blocked','medium',NULL,'2026-10-20','2026-10-10',NULL),
    (3,1,'已结束','done','low',NULL,'2026-10-20','2026-10-10',NULL),
    (4,1,'已取消','cancelled','low',NULL,'2026-10-20','2026-10-10',NULL),
    (5,2,'暂停项目里的待办','todo','high',NULL,'2026-10-20','2026-10-10',NULL);`);
  db.close();
  return { directory, path, snapshotPath, create: () => createTaskSource({ database: path, snapshotPath }) };
}

test('search uses a read-only source, saves only task metadata, and can be reopened without the source', async t => {
  const f = await setup(t);
  const digest = () => createHash('sha256').update(readFileSync(f.path)).digest('hex');
  const before = digest(), source = f.create();
  assert.equal(source.read(), undefined);
  const snapshot = source.refresh();
  assert.equal(digest(), before);
  assert.deepEqual(snapshot.tasks.map((task: any) => task.sourceId), [1, 2, 5]);
  assert.equal(statSync(f.snapshotPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'private')).mode & 0o777, 0o700);
  assert.doesNotMatch(readFileSync(f.snapshotPath, 'utf8'), /FAKE_PRIVATE_NOTE|notes|local_path/);
  assert.deepEqual(f.create().read(), snapshot);
});

test('refresh replaces the snapshot without duplicates and removes tasks closed in the source', async t => {
  const f = await setup(t), source = f.create();
  source.refresh(); source.refresh();
  assert.equal(source.read().tasks.length, 3);
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE tasks SET status='done' WHERE id=1; UPDATE tasks SET title='等待新的确认' WHERE id=2");
  db.close();
  const next = source.refresh();
  assert.deepEqual(next.tasks.map((task: any) => task.sourceId), [2, 5]);
  assert.equal(next.tasks[0].title, '等待新的确认');
});

test('an unavailable source never becomes an empty replacement for the saved snapshot', async t => {
  const f = await setup(t), source = f.create();
  source.refresh();
  const previous = readFileSync(f.snapshotPath, 'utf8');
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE tasks'); db.close();
  assert.throws(() => source.refresh(), /任务来源/);
  assert.equal(readFileSync(f.snapshotPath, 'utf8'), previous);
});
