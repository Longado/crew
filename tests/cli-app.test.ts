// 命令行演示：终端渲染、按当前目录找项目、后台启动和停止本地服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { loadDemo } from '../src/demo.ts';
import { buildProjectView } from '../src/engine/view.ts';
import { renderScene, renderLogo } from '../src/tui.ts';

const CREW = fileURLToPath(new URL('../bin/crew', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/corpus', import.meta.url));
const run = (args: string[], env: Record<string, string>, cwd?: string) => spawnSync(CLI, args, { env: { ...process.env, NO_COLOR: '1', ...env }, encoding: 'utf8', cwd });

test('终端渲染：没有颜色时是纯文字，状态、下一步、不要做都在', () => {
  const db = openDb(':memory:');
  const [p1] = loadDemo(db);
  const out = renderScene(db.getProject(p1)!, buildProjectView(db, p1), { color: false });
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /已完成\s+T01 记账录入/);
  assert.match(out, /下一步/);
  assert.match(out, /不要做.*云同步/s);
  assert.match(renderLogo({ color: true }), /\x1b\[38;2;/);
  assert.equal(renderLogo({ color: false }), '');
});

test('corpus show 不带参数：按当前目录找项目', () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-cli-'));
  const dir = join(home, 'proj');
  mkdirSync(dir);
  run(['project', 'add', '目录项目', '--dir', dir], { CORPUS_HOME: home });
  const r = run(['show'], { CORPUS_HOME: home }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /目录项目/);
});

test('corpus app --no-open 在后台启动服务，corpus stop 停掉', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-app-'));
  const port = String(4300 + Math.floor(Math.random() * 500));
  const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((x) => x.status);
  assert.equal(state, 200);
  assert.equal(run(['app', '--no-open', '--port', port], { CORPUS_HOME: home }).status, 0); // 已经开着就直接用
  assert.equal(run(['stop'], { CORPUS_HOME: home }).status, 0);
  await new Promise((res) => setTimeout(res, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
});


test('crew open 以真实目录复用项目，直接进入工作台，停止后台服务', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-open-'));
  const dir = join(home, 'project with spaces');
  const alias = join(home, 'project alias');
  mkdirSync(dir);
  symlinkSync(dir, alias);
  const port = String(5300 + Math.floor(Math.random() * 500));
  const env = { ...process.env, CORPUS_HOME: home };
  const open = (path: string) => spawnSync(CREW, ['open', path, '--no-open', '--port', port], { env, encoding: 'utf8' });
  try {
    const first = open(alias);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout.trim(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/#/p/p_[^/]+/workspace$`));
    const second = open(dir);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    const db = openDb(join(home, 'corpus.db'));
    try {
      const projects = db.listProjects();
      assert.equal(projects.length, 1);
      assert.equal(projects[0].name, 'project with spaces');
      assert.deepEqual(projects[0].dirs, [realpathSync(dir)]);
    } finally { db.raw.close(); }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
  } finally {
    assert.equal(run(['stop'], { CORPUS_HOME: home }).status, 0);
  }
  await new Promise((res) => setTimeout(res, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
});

test('crew open 复用历史软链接绑定', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-existing-'));
  const dir = join(home, 'project');
  const alias = join(home, 'alias');
  mkdirSync(dir);
  symlinkSync(dir, alias);
  const db = openDb(join(home, 'corpus.db'));
  const id = db.createProject({ name: 'Existing', goal: null, dirs: [alias] });
  db.raw.close();
  const port = String(5800 + Math.floor(Math.random() * 300));
  try {
    const r = run(['open', dir, '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`/#/p/${id}/workspace`));
    const check = openDb(join(home, 'corpus.db'));
    try {
      assert.equal(check.listProjects().length, 1);
      assert.ok(check.getProject(id)!.dirs.includes(realpathSync(dir)));
    } finally { check.raw.close(); }
  } finally { run(['stop'], { CORPUS_HOME: home }); }
});

test('crew open 拒绝不存在的路径和文件，不创建项目或服务', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-invalid-'));
  const file = join(home, 'file.txt');
  writeFileSync(file, 'not a directory');
  for (const path of [join(home, 'missing'), file]) {
    const r = run(['open', path, '--no-open'], { CORPUS_HOME: home });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /请指定存在的目录/);
  }
  assert.equal(existsSync(join(home, 'corpus.db')), false);
  assert.equal(existsSync(join(home, 'server.pid')), false);
});

test('crew --help 使用 Crew 名称并说明目录入口', () => {
  const r = spawnSync(CREW, ['--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Crew · 用法：crew/);
  assert.match(r.stdout, /open <目录>/);
});
