// 读取 Claude Code 会话文件：~/.claude/projects/<目录>/<会话>.jsonl
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Message } from '../contracts.ts';
import type { Db } from '../db.ts';
import { redact } from '../redact.ts';
import { gitRoot, readNewLines, peekHead, truncate, TOOL_ERROR_MAX, projectByPaths, projectWorktrees } from './common.ts';

// 这些包装块是工具自己插入的，不是用户说的话
const WRAPPER = /^<(local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-stdout|bash-stderr)\b/;

interface Parsed {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
  version: string | null;
  messages: Omit<Message, 'seq'>[];
  badLines: number;
}

type Block = { type?: string; text?: string; content?: unknown; is_error?: boolean };

function userText(content: unknown): { role: Message['role']; text: string } | null {
  if (typeof content === 'string') {
    if (WRAPPER.test(content)) return null;
    const cmd = content.match(/<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/);
    if (cmd) {
      const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
      return args ? { role: 'user', text: `${cmd[1]} ${args}` } : null; // 不带参数的命令（/model、/compact）是操作，不是内容
    }
    return content.trim() ? { role: 'user', text: content } : null;
  }
  if (!Array.isArray(content)) return null;
  const blocks = content as Block[];
  const err = blocks.find((b) => b.type === 'tool_result' && b.is_error);
  if (err) {
    const raw = typeof err.content === 'string' ? err.content : JSON.stringify(err.content ?? '');
    return { role: 'tool_error', text: truncate(raw, TOOL_ERROR_MAX) };
  }
  const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  return text && !WRAPPER.test(text) ? { role: 'user', text } : null;
}

function assistantText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = (content as Block[]).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  return text || null;
}

export function parseClaudeCodeLines(lines: string[], capturedAt: string): Parsed {
  const out: Parsed = { sessionId: null, cwd: null, title: null, version: null, messages: [], badLines: 0 };
  for (const line of lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      out.badLines++;
      continue;
    }
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') out.title = d.aiTitle;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    out.sessionId ??= d.sessionId ?? null;
    out.cwd ??= d.cwd ?? null;
    if (typeof d.version === 'string') out.version = d.version; // 取最新的一行，工具升级后会变
    if (d.isSidechain || d.isMeta || d.isCompactSummary || !d.uuid) continue;
    const content = d.message?.content;
    const picked = d.type === 'user' ? userText(content) : ((t) => (t ? { role: 'assistant' as const, text: t } : null))(assistantText(content));
    if (!picked) continue;
    out.messages.push({ id: `cc:${d.uuid}`, sessionId: d.sessionId, role: picked.role, text: redact(picked.text), ts: d.timestamp ?? null, capturedAt, parent: d.parentUuid ? `cc:${d.parentUuid}` : null });
  }
  return out;
}

export interface SyncResult {
  files: number;
  newMessages: number;
  skippedSessions: number; // 目录没绑定项目，没有读
  badLines: number;
  skippedDirs: Record<string, number>; // 没绑定的目录和会话数，给接入设置页用
  skipped: { source: string; title: string | null; cwd: string }[]; // 给了 since 时没归到项目的会话，复盘里列出来
}

/** 整份会话里出现过的工作目录和工具参数（判断归属用），以及最新的标题。 */
function scanPaths(file: string): { texts: string[]; title: string | null } {
  const texts: string[] = [];
  let title: string | null = null;
  for (const line of readNewLines(file, 0).lines) {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') title = d.aiTitle;
    if (typeof d.cwd === 'string') texts.push(d.cwd);
    if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if (b?.type === 'tool_use') texts.push(JSON.stringify(b.input ?? {}));
    }
  }
  return { texts, title };
}

export function defaultClaudeRoot() {
  return join(homedir(), '.claude', 'projects');
}

/**
 * 增量同步。只读取能归到项目的会话；子 agent 的会话在更深一层目录，这一版不读。
 * 给了 since（毫秒时间戳）时，只看这之后动过的会话文件；工作目录没绑定项目的，再按会话里进过的目录和
 * 工具参数归属（要读整份文件，所以只在给了 since 时做）。
 */
export function syncClaudeCode(db: Db, opts: { root?: string; resolveRoot?: (dir: string) => string; since?: number } = {}): SyncResult {
  const root = opts.root ?? defaultClaudeRoot();
  const resolve = opts.resolveRoot ?? gitRoot;
  const res: SyncResult = { files: 0, newMessages: 0, skippedSessions: 0, badLines: 0, skippedDirs: {}, skipped: [] };
  const capturedAt = new Date().toISOString();
  const worktrees = opts.since !== undefined ? projectWorktrees(db) : [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  } catch {
    return res; // 没装 Claude Code
  }
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsonl'))) {
      const file = join(root, dir, name);
      if (opts.since !== undefined && statSync(file).mtimeMs < opts.since) continue;
      const head = parseClaudeCodeLines(peekHead(file), capturedAt);
      if (!head.sessionId || !head.cwd) continue;
      const known = db.getSession(head.sessionId);
      if (known?.excluded) continue; // 你移出过的会话不再读
      let projectId = known?.projectId ?? db.projectForDir(resolve(head.cwd)) ?? db.projectForDir(head.cwd);
      let title = head.title;
      if (!projectId && opts.since !== undefined) {
        const scan = scanPaths(file);
        projectId = projectByPaths(db, scan.texts, head.cwd, worktrees);
        title = scan.title ?? title;
      }
      if (projectId && db.isPaused(projectId)) continue; // 暂停采集的项目不读新内容
      if (!projectId) {
        res.skippedSessions++;
        const key = resolve(head.cwd);
        res.skippedDirs[key] = (res.skippedDirs[key] ?? 0) + 1;
        if (opts.since !== undefined) res.skipped.push({ source: 'Claude Code', title, cwd: head.cwd });
        continue;
      }
      res.files++;
      db.upsertSession({ id: head.sessionId, source: 'claude_code', label: 'Claude Code', projectId, cwd: head.cwd, title: head.title, coverage: 'full', file, toolVersion: head.version });
      const session = db.getSession(head.sessionId)!;
      const { lines, next } = readNewLines(file, session.cursor);
      const parsed = parseClaudeCodeLines(lines, capturedAt);
      res.badLines += parsed.badLines;
      if (parsed.title || parsed.version) db.upsertSession({ ...session, title: parsed.title ?? session.title, toolVersion: parsed.version ?? session.toolVersion });
      let seq = db.maxSeq(head.sessionId);
      const msgs: Message[] = parsed.messages.map((m) => ({ ...m, sessionId: head.sessionId!, seq: ++seq }));
      res.newMessages += db.insertMessages(msgs);
      if (msgs.length) db.detectBranches(head.sessionId); // 改过重发的旧版本
      db.setCursor(head.sessionId, next);
    }
  }
  return res;
}
