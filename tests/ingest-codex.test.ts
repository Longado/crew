import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexLines, syncCodex } from '../src/ingest/codex.ts';
import { syncClaudeCode } from '../src/ingest/claude-code.ts';
import { openDb } from '../src/db.ts';

const FIXTURE = new URL('./fixtures/codex-sample.jsonl', import.meta.url);
const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

test('只保留真实对话，过滤注入的说明、环境信息和 developer 消息', () => {
  const out = parseCodexLines(lines, 'x');
  assert.equal(out.sessionId, '019a-cx-1');
  assert.equal(out.cwd, '/code/ledger');
  assert.deepEqual(out.messages.map((m) => [m.id, m.role, m.text]), [
    ['cx:019a-cx-1:4', 'user', '导出的文件打不开，提示格式错误。'],
    ['cx:019a-cx-1:7', 'assistant', '是编码问题，已经修好了。'],
    ['cx:019a-cx-1:8', 'user', '按这个截图改一下导出按钮'],
  ]);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corpus-cx-'));
  const day = join(root, 'sessions', '2026', '09', '11');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-09-11T10-00-00-019a-cx-1.jsonl');
  copyFileSync(FIXTURE, file);
  writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: '019a-cx-1', thread_name: '修导出格式', updated_at: '2026-09-11T10:03:00Z' }) + '\n');
  const db = openDb(':memory:');
  const projectId = db.createProject({ name: '记账小程序', goal: null, dirs: ['/code/ledger'] });
  return { root, file, db, projectId };
}

test('同步两次不重复，标题取自会话索引，追加一行多一条', () => {
  const { root, file, db, projectId } = setup();
  assert.equal(syncCodex(db, { root, resolveRoot: (d) => d }).newMessages, 3);
  assert.equal(syncCodex(db, { root, resolveRoot: (d) => d }).newMessages, 0);
  assert.equal(db.getSession('019a-cx-1')?.title, '修导出格式');
  appendFileSync(file, JSON.stringify({ timestamp: '2026-09-11T11:00:00Z', ordinal: 10, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '可以了' }] } }) + '\n');
  assert.equal(syncCodex(db, { root, resolveRoot: (d) => d }).newMessages, 1);
  assert.equal(db.messagesForProject(projectId).length, 4);
});

test('同一目录下的 Claude Code 和 Codex 会话归到同一个项目', () => {
  const { root, db, projectId } = setup();
  const ccRoot = mkdtempSync(join(tmpdir(), 'corpus-cc2-'));
  mkdirSync(join(ccRoot, '-code-ledger'));
  copyFileSync(new URL('./fixtures/cc-sample.jsonl', import.meta.url), join(ccRoot, '-code-ledger', 'sess-cc-1.jsonl'));
  syncCodex(db, { root, resolveRoot: (d) => d });
  syncClaudeCode(db, { root: ccRoot, resolveRoot: (d) => d });
  assert.deepEqual(db.sessionsForProject(projectId).map((s) => s.source).sort(), ['claude_code', 'codex']);
});

function writeRollout(root: string, id: string, meta: object, rest: object[]) {
  const file = join(root, 'sessions', '2026', '09', '11', `rollout-2026-10-29T10-00-00-${id}.jsonl`);
  const rows = [{ timestamp: '2026-10-29T02:00:00Z', type: 'session_meta', payload: { id, cwd: '/ws', cli_version: '0.200.0', ...meta } }, ...rest];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('从上层目录开的 Codex 会话，按命令和工具参数里的路径归到项目', () => {
  const { root, db, projectId } = setup();
  writeRollout(root, 'cx-root', {}, [
    { timestamp: '2026-10-29T02:00:01Z', type: 'turn_context', payload: { cwd: '/ws' } },
    { timestamp: '2026-10-29T02:00:02Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修一下记账导出' }] } },
    { timestamp: '2026-10-29T02:00:03Z', ordinal: 3, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({cmd:"cat /code/ledger/src/export.ts"})' } },
    { timestamp: '2026-10-29T02:00:04Z', ordinal: 4, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status","workdir":"/code/ledger"}' } },
    { timestamp: '2026-10-29T02:00:05Z', ordinal: 5, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '改好了' }] } },
  ]);
  syncCodex(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('cx-root')?.projectId, projectId);
  assert.deepEqual(db.messagesForSession('cx-root', -1).map((m) => m.text), ['修一下记账导出', '改好了']);
});

test('Codex 子 agent 的会话不读，和 Claude Code 一样', () => {
  const { root, db } = setup();
  writeRollout(root, 'cx-sub', { cwd: '/code/ledger', parent_thread_id: 'cx-root', source: { subagent: { thread_spawn: { parent_thread_id: 'cx-root' } } } }, [
    { timestamp: '2026-10-29T02:00:02Z', ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '子任务' }] } },
  ]);
  const r = syncCodex(db, { root, resolveRoot: (d) => d, since: 0 });
  assert.equal(db.getSession('cx-sub'), null);
  assert.equal(r.skipped.length, 0);
});
