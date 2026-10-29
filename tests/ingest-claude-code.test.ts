import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync, utimesSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCodeLines, syncClaudeCode } from '../src/ingest/claude-code.ts';
import { openDb } from '../src/db.ts';

const FIXTURE = new URL('./fixtures/cc-sample.jsonl', import.meta.url);
const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

test('只保留用户和 AI 的正文，过滤命令、思考、工具调用、子 agent 和压缩摘要', () => {
  const out = parseClaudeCodeLines(lines, '2026-09-13T00:00:00Z');
  assert.equal(out.sessionId, 'sess-cc-1');
  assert.equal(out.cwd, '/code/ledger');
  assert.equal(out.title, '月度导出开发');
  assert.deepEqual(out.messages.map((m) => [m.id, m.role]), [
    ['cc:u4', 'user'],
    ['cc:u6', 'assistant'],
    ['cc:u8', 'tool_error'],
    ['cc:u11', 'user'],
    ['cc:u13', 'assistant'],
  ]);
});

test('带参数的斜杠命令保留成“/命令 参数”', () => {
  const out = parseClaudeCodeLines(lines, 'x');
  assert.equal(out.messages.find((m) => m.id === 'cc:u11')?.text, '/review 导出模块');
});

test('工具报错截短，凭证被替换', () => {
  const out = parseClaudeCodeLines(lines, 'x');
  const err = out.messages.find((m) => m.id === 'cc:u8')!;
  assert.ok(err.text.length <= 520, `长度 ${err.text.length}`);
  const user = out.messages.find((m) => m.id === 'cc:u4')!;
  assert.ok(!user.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(user.text.includes('[已隐藏的凭证]'));
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corpus-cc-'));
  const projDir = join(root, '-code-ledger');
  mkdirSync(projDir);
  const file = join(projDir, 'sess-cc-1.jsonl');
  copyFileSync(FIXTURE, file);
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: '记账小程序', goal: null, dirs: ['/code/ledger'] });
  return { root, file, db, projectId };
}

test('同步两次行数不变；追加一行多一条；只读已绑定目录的会话', () => {
  const { root, file, db, projectId } = setup();
  const r1 = syncClaudeCode(db, { root, resolveRoot: (d) => d });
  assert.equal(r1.newMessages, 5);
  const r2 = syncClaudeCode(db, { root, resolveRoot: (d) => d });
  assert.equal(r2.newMessages, 0);
  appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u99', sessionId: 'sess-cc-1', cwd: '/code/ledger', timestamp: '2026-09-10T03:00:00Z', message: { role: 'user', content: '导出能打开了，可以用。' } }) + '\n');
  const r3 = syncClaudeCode(db, { root, resolveRoot: (d) => d });
  assert.equal(r3.newMessages, 1);
  assert.equal(db.messagesForProject(projectId).length, 6);
  assert.equal(r3.skippedSessions, 0);
});

test('未绑定目录的会话不读取，只计数', () => {
  const { root, db } = setup();
  const f2 = join(root, '-code-ledger', 'sess-other.jsonl');
  writeFileSync(f2, JSON.stringify({ type: 'user', uuid: 'x1', sessionId: 'sess-other', cwd: '/elsewhere', timestamp: '2026-09-10T03:00:00Z', message: { role: 'user', content: '别的项目' } }) + '\n');
  const r = syncClaudeCode(db, { root, resolveRoot: (d) => d });
  assert.equal(r.skippedSessions, 1);
  assert.equal(db.getSession('sess-other'), null);
});

test('无法解析的行不会让整个同步失败，并报告格式异常', () => {
  const { root, file, db } = setup();
  appendFileSync(file, '{这不是 JSON\n');
  const r = syncClaudeCode(db, { root, resolveRoot: (d) => d });
  assert.equal(r.badLines, 1);
  assert.equal(r.newMessages, 5);
});

// 从上层目录开、中途才进项目的会话：按实际进过的目录和工具动过的文件归项目
function rootSession(root: string, id: string, extra: object[]) {
  const ts = '2026-10-29T03:00:00Z';
  const rows = [
    { type: 'user', uuid: `${id}-1`, sessionId: id, cwd: '/ws', timestamp: ts, message: { role: 'user', content: '看看记账导出' } },
    ...extra,
    { type: 'assistant', uuid: `${id}-9`, sessionId: id, cwd: '/ws', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '看完了' }] } },
  ];
  writeFileSync(join(root, '-code-ledger', `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('从上层目录开的会话，按进过的目录和工具里的路径归到项目', () => {
  const { root, db, projectId } = setup();
  rootSession(root, 'sess-root', [
    // 代码和正则里像路径的片段（磁盘上不存在）不算「在别处干活」
    { type: 'assistant', uuid: 'r1', sessionId: 'sess-root', cwd: '/ws', timestamp: '2026-10-29T03:00:30Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/code/ledger/src/a.ts', new_string: 'x.replace(/\\/$/g, "") // see /max /tmp-nope/zz' } }] } },
    { type: 'assistant', uuid: 'r2', sessionId: 'sess-root', cwd: '/ws', timestamp: '2026-10-29T03:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cd /code/ledger && git log -3' } }] } },
    { type: 'assistant', uuid: 'r3', sessionId: 'sess-root', cwd: '/code/ledger', timestamp: '2026-10-29T03:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/export.ts' } }] } },
  ]);
  syncClaudeCode(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('sess-root')?.projectId, projectId);
  assert.deepEqual(db.messagesForSession('sess-root', -1).map((m) => m.text), ['看看记账导出', '看完了']);
});

test('只顺手读过一次项目文件的上层会话不归项目，标题记进未归属名单', () => {
  const { root, db } = setup();
  rootSession(root, 'sess-glance', [
    { type: 'ai-title', aiTitle: '查 GitHub 仓库', sessionId: 'sess-glance' },
    { type: 'assistant', uuid: 'g2', sessionId: 'sess-glance', cwd: '/ws', timestamp: '2026-10-29T03:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/code/ledger/README.md' } }] } },
  ]);
  const r = syncClaudeCode(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('sess-glance'), null);
  assert.deepEqual(r.skipped, [{ source: 'Claude Code', title: '查 GitHub 仓库', cwd: '/ws' }]);
});

test('since 之前就没再动过的会话文件不读', () => {
  const { root, file, db } = setup();
  const old = new Date('2026-09-01T00:00:00Z');
  utimesSync(file, old, old);
  const r = syncClaudeCode(db, { root, resolveRoot: (d) => d, since: Date.parse('2026-10-29T00:00:00Z') });
  assert.equal(r.newMessages, 0);
  assert.equal(db.getSession('sess-cc-1'), null);
});

test('项目里的路径不到一半（主要在没登记的目录干活）时不归项目', () => {
  const { root, db } = setup();
  const step = (uuid: string, cwd: string) => ({ type: 'assistant', uuid, sessionId: 'sess-mixed', cwd, timestamp: '2026-10-29T03:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '…' }] } });
  const elsewhere = join(root, '-code-ledger'); // 没登记、但真实存在的目录
  rootSession(root, 'sess-mixed', [step('x1', '/code/ledger'), step('x2', '/code/ledger'), step('x3', elsewhere), step('x4', elsewhere), step('x5', elsewhere)]);
  syncClaudeCode(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('sess-mixed'), null);
});

test('在项目仓库的 git worktree 里干的活也算这个项目', () => {
  const { root, db } = setup();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-wt-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', join(base, 'wt'));
  const pid = db.createProject({ name: '仓库', goal: null, dirs: [repo] });
  const step = (uuid: string) => ({ type: 'assistant', uuid, sessionId: 'sess-wt', cwd: join(base, 'wt'), timestamp: '2026-10-29T03:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '…' }] } });
  rootSession(root, 'sess-wt', [step('w1'), step('w2'), step('w3')]);
  syncClaudeCode(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('sess-wt')?.projectId, pid);
});
