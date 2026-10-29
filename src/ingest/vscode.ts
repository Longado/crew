// VS Code 自带聊天（Copilot Chat 等）：<User>/workspaceStorage/<哈希>/chatSessions/<会话>.jsonl
// 文件是操作日志：kind 0 初始状态，1 在路径 k 上设值，2 往路径 k 的数组追加；不认识的操作跳过。
// 工作区对应的文件夹记在同一目录的 workspace.json 里。结构照 2026-09-13 本机真实文件写成。
// 注意：VS Code 里的 Claude Code、Codex 扩展写的是 ~/.claude 和 ~/.codex，那两个读取器已经覆盖，这里不管。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Message } from '../contracts.ts';
import type { Db } from '../db.ts';
import { redact } from '../redact.ts';
import { gitRoot } from './common.ts';
import type { SyncResult } from './claude-code.ts';

type Obj = Record<string, any>;

// 重放日志时在自己新建的对象上原地改：日志本身就是一串原地修改，照做最直接，也不会影响任何外部对象
function getAt(obj: Obj, keys: (string | number)[]): any {
  return keys.reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj: Obj, keys: (string | number)[], v: unknown) {
  let o: any = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null) o[k] = typeof keys[i + 1] === 'number' ? [] : {};
    o = o[k];
  });
  if (keys.length) o[keys[keys.length - 1]] = v;
}

/** 把操作日志重放成完整的会话对象。旧版本的 .json（直接是完整对象）原样返回。 */
export function replayChatLog(text: string): Obj {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 1) {
    try {
      const d = JSON.parse(lines[0]);
      if (!(d && typeof d === 'object' && 'kind' in d && 'v' in d)) return d;
    } catch { /* 不是完整对象，按日志处理 */ }
  }
  let state: Obj = {};
  for (const line of lines) {
    let op: Obj;
    try { op = JSON.parse(line); } catch { continue; }
    if (op.kind === 0) state = structuredClone(op.v ?? {});
    else if (op.kind === 1 && Array.isArray(op.k)) setAt(state, op.k, op.v);
    else if (op.kind === 2 && Array.isArray(op.k)) {
      const items = Array.isArray(op.v) ? op.v : [op.v];
      const arr = getAt(state, op.k);
      if (Array.isArray(arr)) arr.push(...items);
      else setAt(state, op.k, [...items]);
    }
  }
  return state;
}

function responseText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map((p: Obj) => {
    if (typeof p?.content?.value === 'string') return p.content.value; // markdownContent
    if (p?.kind === 'markdownContent' && typeof p.value === 'string') return p.value; // 旧版本
    return '';
  }).filter(Boolean).join('\n').trim();
}

export function parseVscodeSession(text: string, capturedAt: string) {
  const s = replayChatLog(text);
  const sessionId = String(s.sessionId ?? '');
  const messages: Omit<Message, 'sessionId'>[] = [];
  for (const r of Array.isArray(s.requests) ? s.requests : []) {
    const ts = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : null;
    const q = typeof r.message?.text === 'string' ? r.message.text.trim() : '';
    if (q) messages.push({ id: `vs:${sessionId}:${r.requestId}:u`, seq: messages.length, role: 'user', text: redact(q), ts, capturedAt });
    const a = responseText(r.response);
    if (a) messages.push({ id: `vs:${sessionId}:${r.requestId}:a`, seq: messages.length, role: 'assistant', text: redact(a), ts, capturedAt });
  }
  const first = messages.find((m) => m.role === 'user')?.text ?? null;
  const title = typeof s.customTitle === 'string' && s.customTitle ? s.customTitle : first ? first.slice(0, 40) : null;
  return { sessionId, title, messages };
}

export function defaultVscodeRoot(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  return join(homedir(), '.config', 'Code', 'User');
}

const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

export function syncVscode(db: Db, opts: { root?: string; resolveRoot?: (dir: string) => string } = {}): SyncResult {
  const root = opts.root ?? defaultVscodeRoot();
  const resolve = opts.resolveRoot ?? gitRoot;
  const res: SyncResult = { files: 0, newMessages: 0, skippedSessions: 0, badLines: 0, skippedDirs: {}, skipped: [] };
  const capturedAt = new Date().toISOString();
  for (const ws of list(join(root, 'workspaceStorage'))) {
    const dir = join(root, 'workspaceStorage', ws);
    const chats = join(dir, 'chatSessions');
    if (!existsSync(chats)) continue;
    let folder: string | null = null;
    try {
      const uri = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8')).folder;
      if (typeof uri === 'string' && uri.startsWith('file:')) folder = fileURLToPath(uri);
    } catch { /* 多根工作区或没有记录：归不到项目 */ }
    for (const name of list(chats).filter((f) => /\.jsonl?$/.test(f))) {
      const file = join(chats, name);
      if (!statSync(file).isFile()) continue;
      const parsed = parseVscodeSession(readFileSync(file, 'utf8'), capturedAt);
      if (!parsed.sessionId || parsed.messages.length === 0) continue; // 空会话
      const known = db.getSession(`vs-${parsed.sessionId}`);
      if (known?.excluded) continue;
      const projectId = known?.projectId ?? (folder ? db.projectForDir(resolve(folder)) ?? db.projectForDir(folder) : null);
      if (projectId && db.isPaused(projectId)) continue;
      if (!projectId) {
        res.skippedSessions++;
        if (folder) res.skippedDirs[resolve(folder)] = (res.skippedDirs[resolve(folder)] ?? 0) + 1;
        continue;
      }
      res.files++;
      const id = `vs-${parsed.sessionId}`;
      db.upsertSession({ id, source: 'vscode', label: 'VS Code 聊天', projectId, cwd: folder, title: parsed.title, coverage: 'full', file });
      res.newMessages += db.insertMessages(parsed.messages.map((m) => ({ ...m, sessionId: id })));
    }
  }
  // 没打开文件夹时的聊天：归不到任何项目，只计数
  for (const name of list(join(root, 'globalStorage', 'emptyWindowChatSessions'))) {
    try {
      if (parseVscodeSession(readFileSync(join(root, 'globalStorage', 'emptyWindowChatSessions', name), 'utf8'), capturedAt).messages.length) res.skippedSessions++;
    } catch { /* 读不了的文件跳过 */ }
  }
  return res;
}
