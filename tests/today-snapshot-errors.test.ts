import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createTaskSource } from '../src/today/source.ts';
import { openDb } from '../src/db.ts';
import { serve } from '../src/server.ts';
import { memoryWire } from './helpers/delegation-wire.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'crew-size-errors-'));
  const database = join(root, 'synthetic.db'), snapshotPath = join(root, 'snapshot.json');
  const sourceDb = new DatabaseSync(database), db = openDb(':memory:');
  sourceDb.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,status TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,due_date TEXT,updated_at TEXT,created_at TEXT);
    INSERT INTO projects VALUES(1,'Synthetic','active');
    INSERT INTO tasks VALUES(1,1,'Synthetic saved task','todo','medium',NULL,'','');`);
  const source = createTaskSource({ database, snapshotPath });
  source.refresh();
  const saved = readFileSync(snapshotPath);
  const wire = memoryWire(t), inert = { close: async () => {} } as any;
  const server = serve(db, 0, inert, inert, inert, source);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.raw.close(); sourceDb.close(); rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, body?: unknown) => wire.invoke(server, path, body, { 'x-corpus': '1' });
  return { source, snapshotPath, saved, request,
    overflowSource() {
      sourceDb.exec('DELETE FROM tasks; BEGIN');
      const insert = sourceDb.prepare("INSERT INTO tasks VALUES(?,1,?,'todo','medium',NULL,'','')");
      for (let id = 1; id <= 1400; id++) insert.run(id, '合'.repeat(2000));
      sourceDb.exec('COMMIT');
    },
    async api(path: string, options?: any) {
      const response = await request(path, options?.body), body = response.json();
      if (response.status >= 400) throw Object.assign(Error(body.error), { status: response.status });
      return body;
    } };
}
const sizeMessage = /快照.*超.*约 8 MB.*缩小来源范围/;

test('size overflow has a distinct error type and HTTP reason while preserving the old snapshot', async t => {
  const f = fixture(t); f.overflowSource();
  assert.throws(() => f.source.refresh(), error => {
    assert.equal((error as Error).name, 'TaskSnapshotSizeError');
    assert.match((error as Error).message, sizeMessage);
    return true;
  });
  const response = await f.request('/api/today/refresh', {});
  assert.equal(response.status, 413);
  assert.match(response.json().error, sizeMessage);
  assert.match(response.json().error, /保留.*快照/);
  assert.deepEqual(readFileSync(f.snapshotPath), f.saved);
  assert.equal((await f.request('/api/today')).json().totalTasks, 1);
});

test('reading an oversized snapshot reports size, while unsafe file permissions still report permissions', async t => {
  const f = fixture(t);
  writeFileSync(f.snapshotPath, ' '.repeat(8_000_001));
  assert.throws(() => f.source.read(), error => {
    assert.equal((error as Error).name, 'TaskSnapshotSizeError');
    assert.match((error as Error).message, sizeMessage);
    assert.doesNotMatch((error as Error).message, /权限/);
    return true;
  });
  const response = await f.request('/api/today');
  assert.equal(response.status, 413);
  assert.match(response.json().error, sizeMessage);
  writeFileSync(f.snapshotPath, f.saved); chmodSync(f.snapshotPath, 0o644);
  assert.throws(() => f.source.read(), /权限/);
  assert.doesNotMatch((await f.request('/api/today')).json().error, /8 MB/);
});

async function page(api: any) {
  let html = '';
  const feedback = { textContent: '' };
  const root: any = { set innerHTML(value: string) { html = value; },
    querySelector: () => feedback, querySelectorAll: () => [] };
  const context: any = {};
  vm.runInNewContext(readFileSync(new URL('../web/today.js', import.meta.url), 'utf8')
    .replace('export function mountToday', 'function mountToday') + ';this.mount = mountToday;', context);
  const unmount = context.mount(root, { api });
  // Wait for both real HTTP handlers used by refresh and saved-snapshot fallback.
  for (let i = 0; i < 20 && !feedback.textContent; i++) await new Promise(resolve => setImmediate(resolve));
  return { feedback, html: () => html, unmount };
}

test('page displays the HTTP size reason alongside usable saved tasks', async t => {
  const f = fixture(t); f.overflowSource();
  const ui = await page(f.api); t.after(ui.unmount);
  assert.match(ui.feedback.textContent, sizeMessage);
  assert.match(ui.feedback.textContent, /已保存的内容/);
  assert.match(ui.html(), /Synthetic saved task/);
  assert.doesNotMatch(ui.feedback.textContent, /稍后重新搜索/);
});

test('page keeps the refresh size reason if the saved snapshot also cannot be read', async t => {
  const f = fixture(t); f.overflowSource();
  writeFileSync(f.snapshotPath, ' '.repeat(8_000_001));
  const ui = await page(f.api); t.after(ui.unmount);
  assert.match(ui.feedback.textContent, sizeMessage);
  assert.match(ui.feedback.textContent, /保留.*快照/);
  assert.match(ui.feedback.textContent, /已保存.*快照.*无法读取|已保存.*快照.*超/);
  assert.doesNotMatch(ui.feedback.textContent, /权限|当前显示已保存的内容/);
});
