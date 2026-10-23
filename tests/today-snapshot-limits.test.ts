import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTaskSource } from '../src/today/source.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'crew-snapshot-limits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, 'synthetic.db'), snapshotPath = join(root, 'shared/private/snapshot.json');
  const db = new DatabaseSync(database);
  t.after(() => db.close());
  db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,status TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,due_date TEXT,updated_at TEXT,created_at TEXT);
    INSERT INTO projects VALUES(1,'Synthetic','active');
    INSERT INTO tasks VALUES(1,1,'Synthetic task','todo','medium',NULL,'','');`);
  return { root, db, snapshotPath, source: createTaskSource({ database, snapshotPath }) };
}

test('refresh preserves existing parent permissions and keeps the snapshot private', t => {
  const f = fixture(t), parent = dirname(f.snapshotPath);
  mkdirSync(parent, { recursive: true });
  chmodSync(dirname(parent), 0o755); chmodSync(parent, 0o750);
  f.source.refresh(); f.source.refresh();
  assert.equal(statSync(parent).mode & 0o777, 0o750);
  assert.equal(statSync(dirname(parent)).mode & 0o777, 0o755);
  assert.equal(statSync(f.snapshotPath).mode & 0o777, 0o600);
  assert.equal(f.source.read()!.tasks.length, 1);
});

test('refresh creates only missing directories with private permissions', t => {
  const f = fixture(t), parent = dirname(f.snapshotPath);
  f.source.refresh();
  assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(parent)).mode & 0o777, 0o700);
  assert.equal(statSync(f.snapshotPath).mode & 0o777, 0o600);
});

function fill(db: DatabaseSync, title: string, count: number) {
  db.exec('DELETE FROM tasks; BEGIN');
  const insert = db.prepare("INSERT INTO tasks VALUES(?,1,?,'todo','medium',NULL,'','')");
  for (let id = 1; id <= count; id++) insert.run(id, title);
  db.exec('COMMIT');
}

test('UTF-8 size overflow refuses replacement and preserves the readable old snapshot', t => {
  const f = fixture(t), previous = f.source.refresh(), before = readFileSync(f.snapshotPath);
  fill(f.db, '合'.repeat(2000), 1400);
  // Each field and row count is valid; UTF-8 bytes exceed the limit, characters do not.
  assert.throws(() => f.source.refresh(), /快照.*大小.*超.*8[,_]?000[,_]?000/);
  assert.deepEqual(readFileSync(f.snapshotPath), before);
  assert.deepEqual(f.source.read(), previous);
  assert.deepEqual(readdirSync(dirname(f.snapshotPath)), ['snapshot.json']);
});

test('oversized first refresh creates no snapshot directory', t => {
  const f = fixture(t);
  fill(f.db, '合'.repeat(2000), 1400);
  assert.throws(() => f.source.refresh(), /大小.*超/);
  assert.equal(existsSync(dirname(f.snapshotPath)), false);
});

test('snapshot exactly at the read limit is writable and one extra UTF-8 byte is refused', t => {
  const f = fixture(t);
  fill(f.db, 'a'.repeat(2000), 3500);
  const sample = f.source.refresh();
  const size = Buffer.byteLength(JSON.stringify(sample, null, 2) + '\n');
  // Pad projectName across all rows, then one title, without exceeding field limits.
  const gap = 8_000_000 - size;
  const perRow = Math.floor(gap / 3500), rest = gap % 3500;
  assert.ok(perRow >= 0 && perRow + 'Synthetic'.length <= 500);
  f.db.prepare('UPDATE projects SET name=?').run('Synthetic' + 'a'.repeat(perRow));
  // Replacing ASCII with a two-byte character adds exactly one byte per character.
  for (let id = 1, remaining = rest; remaining > 0; id++) {
    const extra = Math.min(remaining, 2000);
    f.db.prepare('UPDATE tasks SET title=? WHERE id=?').run('é'.repeat(extra) + 'a'.repeat(2000 - extra), id);
    remaining -= extra;
  }
  const exact = f.source.refresh();
  assert.equal(statSync(f.snapshotPath).size, 8_000_000);
  assert.deepEqual(f.source.read(), exact);
  const before = readFileSync(f.snapshotPath);
  f.db.prepare('UPDATE tasks SET title=? WHERE id=3500').run('é' + 'a'.repeat(1999));
  assert.throws(() => f.source.refresh(), /大小.*超/);
  assert.deepEqual(readFileSync(f.snapshotPath), before);
});
