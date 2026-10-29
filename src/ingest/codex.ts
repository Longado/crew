// 读取 Codex 会话文件：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Message } from '../contracts.ts';
import type { Db } from '../db.ts';
import { redact } from '../redact.ts';
import { gitRoot, readNewLines, peekHead, projectByPaths, projectWorktrees } from './common.ts';
import type { SyncResult } from './claude-code.ts';

// Codex 自动注入到用户消息里的块
const INJECTED = /^\s*(<(environment_context|in-app-browser-context|recommended_plugins|user_instructions|permissions instructions|turn_aborted)\b|# AGENTS\.md instructions)/;

function cleanUserText(text: string): string | null {
  if (INJECTED.test(text)) return null;
  if (/^\s*# Files mentioned by the user/.test(text)) {
    const req = text.split(/## My request:\s*/)[1];
    return req?.trim() || null;
  }
  return text.trim() || null;
}

interface Parsed {
  sessionId: string | null;
  cwd: string | null;
  version: string | null;
  subagent: boolean; // Codex 派出的子 agent 会话，和 Claude Code 的一样不读
  messages: Omit<Message, 'seq'>[];
  badLines: number;
}

// ponytail: Codex 的工具输出里基本没有稳定的退出码，这一版不收工具报错；以后可以从 exec 事件里取
export function parseCodexLines(lines: string[], capturedAt: string, known: { sessionId?: string | null } = {}): Parsed {
  const out: Parsed = { sessionId: known.sessionId ?? null, cwd: null, version: null, subagent: false, messages: [], badLines: 0 };
  for (const line of lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      out.badLines++;
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === 'session_meta') {
      out.sessionId = p.session_id ?? p.id ?? out.sessionId;
      out.cwd = p.cwd ?? null;
      out.version = p.cli_version ?? null;
      out.subagent = !!(p.parent_thread_id || p.source?.subagent);
      continue;
    }
    if (d.type !== 'response_item' || p.type !== 'message' || !out.sessionId) continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue;
    const parts: string[] = (p.content ?? [])
      .filter((c: any) => typeof c?.text === 'string')
      .map((c: any) => (p.role === 'user' ? cleanUserText(c.text) : c.text.trim() || null))
      .filter((t: string | null): t is string => !!t);
    if (parts.length === 0) continue;
    out.messages.push({
      id: `cx:${out.sessionId}:${d.ordinal}`,
      sessionId: out.sessionId,
      role: p.role,
      text: redact(parts.join('\n')),
      ts: d.timestamp ?? null,
      capturedAt,
    });
  }
  return out;
}

/** 整份会话里出现过的工作目录和工具参数（判断归属用）。 */
function scanPaths(file: string): string[] {
  const texts: string[] = [];
  for (const line of readNewLines(file, 0).lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === 'turn_context' && typeof p.cwd === 'string') texts.push(p.cwd);
    if (d.type === 'response_item' && ['custom_tool_call', 'function_call', 'local_shell_call'].includes(p.type)) {
      const args = p.input ?? p.arguments ?? p.action;
      texts.push(typeof args === 'string' ? args : JSON.stringify(args ?? {}));
    }
  }
  return texts;
}

export function defaultCodexRoot() {
  return join(homedir(), '.codex');
}

function walk(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.startsWith('rollout-') && name.endsWith('.jsonl') ? [p] : [];
  });
}

function titles(root: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(join(root, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) map.set(d.id, d.thread_name);
      } catch {
        // 索引里个别坏行不影响标题以外的任何东西
      }
    }
  } catch {
    // 没有索引文件：没有标题
  }
  return map;
}

/** 同 syncClaudeCode：给了 since 时只看之后动过的文件，没绑定目录的会话再按路径归属。 */
export function syncCodex(db: Db, opts: { root?: string; resolveRoot?: (dir: string) => string; since?: number } = {}): SyncResult {
  const root = opts.root ?? defaultCodexRoot();
  const resolve = opts.resolveRoot ?? gitRoot;
  const res: SyncResult = { files: 0, newMessages: 0, skippedSessions: 0, badLines: 0, skippedDirs: {}, skipped: [] };
  const capturedAt = new Date().toISOString();
  const names = titles(root);
  const worktrees = opts.since !== undefined ? projectWorktrees(db) : [];
  for (const file of walk(join(root, 'sessions'))) {
    if (opts.since !== undefined && statSync(file).mtimeMs < opts.since) continue;
    const head = parseCodexLines(peekHead(file, 64 * 1024).slice(0, 1), capturedAt);
    if (!head.sessionId || !head.cwd || head.subagent) continue;
    const known = db.getSession(head.sessionId);
    if (known?.excluded) continue; // 你移出过的会话不再读
    let projectId = known?.projectId ?? db.projectForDir(resolve(head.cwd)) ?? db.projectForDir(head.cwd);
    if (!projectId && opts.since !== undefined) projectId = projectByPaths(db, scanPaths(file), head.cwd, worktrees);
    if (projectId && db.isPaused(projectId)) continue; // 暂停采集的项目不读新内容
    if (!projectId) {
      res.skippedSessions++;
      const key = resolve(head.cwd);
      res.skippedDirs[key] = (res.skippedDirs[key] ?? 0) + 1;
      if (opts.since !== undefined) res.skipped.push({ source: 'Codex', title: names.get(head.sessionId) ?? null, cwd: head.cwd });
      continue;
    }
    res.files++;
    db.upsertSession({ id: head.sessionId, source: 'codex', label: 'Codex', projectId, cwd: head.cwd, title: names.get(head.sessionId) ?? null, coverage: 'full', file, toolVersion: head.version });
    const session = db.getSession(head.sessionId)!;
    const { lines, next } = readNewLines(file, session.cursor);
    const parsed = parseCodexLines(lines, capturedAt, { sessionId: head.sessionId });
    res.badLines += parsed.badLines;
    let seq = db.maxSeq(head.sessionId);
    res.newMessages += db.insertMessages(parsed.messages.map((m) => ({ ...m, seq: ++seq })));
    db.setCursor(head.sessionId, next);
  }
  return res;
}
