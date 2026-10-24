// 命令行演示：终端渲染、按当前目录找项目、后台启动和停止本地服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});
// 收尾用：先 crew stop；没停成（机器太忙、探测超时时 pid 文件会留着）就按 pid 文件直接杀，测试不留服务
function stopBackground(home: string) {
  const file = join(home, 'server.pid');
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }) : null;
  const r = run(['stop'], { CORPUS_HOME: home });
  if (saved && existsSync(file)) {
    try { process.kill(saved.pid, 'SIGKILL'); } catch { /* 已经不在了 */ }
  }
  return r;
}

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
  const port = String(await freePort());
  try {
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((x) => x.status);
    assert.equal(state, 200);
    assert.equal(run(['app', '--no-open', '--port', port], { CORPUS_HOME: home }).status, 0); // 已经开着就直接用
  } finally {
    assert.equal(stopBackground(home).status, 0);
  }
  await wait(300);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
});

test('corpus app 起来的服务在响应头里带 x-crew-pid，等于 pid 文件里的 pid', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-app-pid-'));
  const port = String(await freePort());
  try {
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    const saved = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8'));
    assert.equal(saved.port, Number(port));
    assert.equal(res.headers.get('x-crew-pid'), String(saved.pid));
  } finally {
    assert.equal(stopBackground(home).status, 0);
  }
});

test('corpus stop：pid 文件过时（端口上没有 Crew）时不 kill 进程，只删文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-stale-'));
  const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    writeFileSync(join(home, 'server.pid'), JSON.stringify({ pid: bystander.pid, port: await freePort() }));
    const r = run(['stop'], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /后台没有在运行的本地服务/);
    assert.equal(existsSync(join(home, 'server.pid')), false);
    await wait(300); // 让子进程退出事件有机会被处理，再看它是否还活着
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('端口上已有直接 crew serve 起来的服务（没有 pid 文件）：app 认出它，stop 能停掉', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-orphan-'));
  const port = String(await freePort());
  const orphan = spawn(CREW, ['serve', '--port', port], { env: { ...process.env, NO_COLOR: '1', CORPUS_HOME: home }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${port}/api/state`).then((x) => x.ok, () => false)) break;
      await wait(200);
    }
    assert.equal(existsSync(join(home, 'server.pid')), false);
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /已经在运行/);
    const stopped = run(['stop'], { CORPUS_HOME: home });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /已停掉/);
    await wait(300);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
  } finally {
    orphan.kill('SIGKILL');
    run(['stop'], { CORPUS_HOME: home });
  }
});

test('端口被普通 TCP 监听占着：app 报错退出，不留 pid 文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-tcp-'));
  const sockets: net.Socket[] = [];
  const squatter = net.createServer((s) => { sockets.push(s); }); // 收下连接但从不回话
  await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const port = String((squatter.address() as net.AddressInfo).port);
  try {
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(home, 'server.pid')), false);
  } finally {
    for (const s of sockets) s.destroy();
    squatter.close();
    run(['stop'], { CORPUS_HOME: home });
  }
});

test('服务暂时不响应（机器忙）时 stop 不删 pid 文件、不假报没在运行，恢复后能停掉', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-busy-'));
  const port = String(await freePort());
  let pid = 0;
  try {
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    pid = JSON.parse(readFileSync(join(home, 'server.pid'), 'utf8')).pid;
    process.kill(pid, 'SIGSTOP'); // 进程还在、端口还收连接，但不回话
    const busy = run(['stop'], { CORPUS_HOME: home });
    assert.notEqual(busy.status, 0);
    assert.match(busy.stderr, /没有及时响应/);
    assert.doesNotMatch(busy.stdout, /后台没有在运行/);
    assert.equal(existsSync(join(home, 'server.pid')), true); // 记录留着，等它恢复后还能找到
    process.kill(pid, 'SIGCONT');
    const stopped = run(['stop'], { CORPUS_HOME: home });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /已停掉/);
    await wait(300);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
  } finally {
    if (pid) { try { process.kill(pid, 'SIGCONT'); } catch { /* 已经不在了 */ } }
    stopBackground(home);
  }
});

test('启动超时（子进程 10 秒内没答话）：app 报错，并把那个子进程停掉，不留成 stop 找不到的服务', async () => {
  const home = mkdtempSync(join(tmpdir(), 'corpus-slow-'));
  const port = String(await freePort());
  const childPidFile = join(home, 'child.pid');
  const preload = join(home, 'slow-start.mjs'); // 只让 serve 子进程晚 13 秒才开始监听，模拟机器很忙
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (process.argv.includes('serve')) {
  writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
  await new Promise((r) => setTimeout(r, 13000));
}
`);
  try {
    const r = run(['app', '--no-open', '--port', port], { CORPUS_HOME: home, NODE_OPTIONS: `--import ${preload}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /本地服务没有起来/);
    assert.equal(existsSync(join(home, 'server.pid')), false);
    assert.equal(existsSync(childPidFile), true, '子进程应该已经开始启动');
    await wait(500);
    assert.throws(() => process.kill(Number(readFileSync(childPidFile, 'utf8')), 0), { code: 'ESRCH' });
  } finally {
    if (existsSync(childPidFile)) { try { process.kill(Number(readFileSync(childPidFile, 'utf8')), 'SIGKILL'); } catch { /* 已经不在了 */ } }
    stopBackground(home);
  }
});

test('crew open 以真实目录复用项目，直接进入工作台，停止后台服务', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-open-'));
  const dir = join(home, 'project with spaces');
  const alias = join(home, 'project alias');
  mkdirSync(dir);
  symlinkSync(dir, alias);
  const port = String(await freePort());
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
    assert.equal(stopBackground(home).status, 0);
  }
  await new Promise((res) => setTimeout(res, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
});

test('crew open 复用历史软链接绑定', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-existing-'));
  const dir = join(home, 'project');
  const alias = join(home, 'alias');
  mkdirSync(dir);
  symlinkSync(dir, alias);
  const db = openDb(join(home, 'corpus.db'));
  const id = db.createProject({ name: 'Existing', goal: null, dirs: [alias] });
  db.raw.close();
  const port = String(await freePort());
  try {
    const r = run(['open', dir, '--no-open', '--port', port], { CORPUS_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`/#/p/${id}/workspace`));
    const check = openDb(join(home, 'corpus.db'));
    try {
      assert.equal(check.listProjects().length, 1);
      assert.ok(check.getProject(id)!.dirs.includes(realpathSync(dir)));
    } finally { check.raw.close(); }
  } finally { stopBackground(home); }
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
