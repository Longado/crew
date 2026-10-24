// 本地网页服务。只监听 127.0.0.1。
import http from 'node:http';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Db } from './db.ts';
import type { StoredEvidence } from './contracts.ts';
import { buildProjectView } from './engine/view.ts';
import { buildContext } from './engine/context.ts';
import { corpusBand } from './engine/band.ts';
import { resultHints } from './engine/hints.ts';
import { syncClaudeCode, type SyncResult } from './ingest/claude-code.ts';
import { syncCodex } from './ingest/codex.ts';
import { syncVscode, defaultVscodeRoot } from './ingest/vscode.ts';
import { importText } from './ingest/paste.ts';
import { parseTakeout, readTakeoutPath, importConversations, type TakeoutConversation } from './ingest/takeout.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { extractProject } from './extract/run.ts';
import { deepseek } from './extract/model.ts';
import { createTeamWorkbench } from './bridge/workbench.ts';
import { createTerminalManager } from './terminal/manager.ts';
import { createSecurityService } from './security/adapter.ts';
import type { SecurityService } from './security/types.ts';
import { buildToday } from './engine/today.ts';
import { TaskSnapshotSizeError, type TaskSource } from './today/source.ts';

const WEB = new URL('../web/', import.meta.url);
const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/team.js': 'team.js', '/team.css': 'team.css', '/team-dock.js': 'team-dock.js', '/team-dock.css': 'team-dock.css', '/workspace.js': 'workspace.js', '/workspace.css': 'workspace.css', '/security.js': 'security.js', '/security.css': 'security.css', '/today.js': 'today.js', '/today.css': 'today.css' };
const TERMINAL_ASSETS: Record<string, string> = {
  '/vendor/xterm.js': '../node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '../node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': '../node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };

const Status = z.enum(['pending_confirm', 'todo', 'doing', 'to_verify', 'done', 'blocked', 'cancelled']);
const Name = z.string().trim().min(1).max(60);
const CorrectionBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename'), taskId: z.string(), name: Name }),
  z.object({ type: z.literal('merge'), from: z.string(), into: z.string() }),
  z.object({ type: z.literal('set_status'), taskId: z.string(), status: Status, note: z.string().max(200).optional() }),
  z.object({ type: z.literal('assign'), evidenceId: z.string(), taskId: z.string() }),
  z.object({ type: z.literal('confirm_condition'), taskId: z.string(), condition: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('dismiss_next'), key: z.string() }),
  z.object({ type: z.literal('ack'), evidenceId: z.string() }),
  z.object({ type: z.literal('set_role'), messageId: z.string(), role: z.enum(['user', 'assistant']) }),
  z.object({ type: z.literal('backfill_plan'), taskIds: z.array(z.string()).default([]), names: z.array(Name).max(30).default([]) }),
  z.object({ type: z.literal('new_task'), name: Name, evidenceId: z.string().optional() }),
  z.object({ type: z.literal('split'), name: Name, evidenceIds: z.array(z.string()).min(1).max(50) }),
]);
const ImportBody = z.object({ text: z.string().min(1).max(2_000_000), label: Name, title: Name, partial: z.boolean().default(false), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), url: z.string().max(2000).regex(/^https?:\/\/\S+$/, '只接受 http 或 https 链接').optional().or(z.literal('')) });
const ProjectBody = z.object({ name: Name, goal: z.string().trim().max(300).optional(), dirs: z.array(z.string().trim().min(1)).max(20).default([]) });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, '内容太大');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage, limit = 5_000_000): Promise<unknown> {
  const text = (await readBody(req, limit)).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, '请求内容不是合法的 JSON'); }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, `请求内容不对：${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  return r.data;
}

/** 左侧项目列表。 */
export function statePayload(db: Db, modelName: string, lastSyncAt: string | null) {
  const projects = db.listProjects().map((p) => {
    const v = buildProjectView(db, p.id);
    return { ...p, counts: v.counts, pending: v.pending.length };
  });
  return { projects, model: modelName, lastSyncAt };
}

/** 接入设置页：各来源读到多少。是否安装、上次同步这些本机状态由调用方给。 */
export function sourcesPayload(db: Db, local: { installed: { claudeCode: boolean; codex: boolean; vscode: boolean }; lastSyncAt: string | null; badLines: number; skippedDirs: [string, number][]; model: string }) {
  const count = (sql: string, ...a: string[]) => Number((db.raw.prepare(sql).get(...a) as { c: number }).c);
  const src = (s: string) => ({
    sessions: count('SELECT COUNT(*) AS c FROM sessions WHERE source = ? AND project_id IS NOT NULL', s),
    messages: count('SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source = ?', s),
  });
  const { installed, ...rest } = local;
  return {
    claudeCode: { installed: installed.claudeCode, version: db.latestToolVersion('claude_code'), ...src('claude_code') },
    codex: { installed: installed.codex, version: db.latestToolVersion('codex'), ...src('codex') },
    vscode: { installed: installed.vscode, version: null, ...src('vscode') },
    imports: src('import'),
    ...rest,
  };
}

/** 页面要的项目数据。本地服务和在线演示（scripts/build-site.ts）共用，演示看到的就是真实运行的样子。 */
export function projectPayload(db: Db, id: string) {
  const view = buildProjectView(db, id);
  const evidence: Record<string, Pick<StoredEvidence, 'cite' | 'kind' | 'detail' | 'speaker' | 'reason' | 'at'>> = {};
  for (const e of db.evidenceForProject(id)) evidence[e.id] = { cite: e.cite, kind: e.kind, detail: e.detail, speaker: e.speaker, reason: e.reason, at: e.at };
  const sessions = db.sessionsForProject(id).map((s) => ({ id: s.id, label: s.label, title: s.title, coverage: s.coverage, source: s.source, messages: db.messagesForSession(s.id).length }));
  const textOf = new Map(db.messagesForProject(id).map((m) => [m.id, m.text]));
  const hints = Object.fromEntries(view.tasks.map((t) => [t.id, resultHints(t.evidenceIds.flatMap((e) => evidence[e]?.cite ?? []).map((m) => textOf.get(m) ?? ''))]));
  return { project: db.getProject(id), view, evidence, hints, sessions, unextracted: db.unextractedCount(id), band: corpusBand(db, id, view), failed: db.failedBatches(id), allTasks: db.tasksForProject(id).map((t) => ({ id: t.id, name: t.name })) };
}

/** 页面要的消息：带上会话信息。 */
export function messagesPayload(db: Db, projectId: string, ids: string[]) {
  return db.messagesByIds(ids, projectId).map((m) => {
    const s = db.getSession(m.sessionId);
    return { ...m, session: s && { label: s.label, title: s.title, coverage: s.coverage, source: s.source, url: s.url } };
  });
}

type OptionalTeamControls = 'approve' | 'cancel' | 'agentMessage' | 'agentInterrupt' | 'answer';
type TeamService = Omit<ReturnType<typeof createTeamWorkbench>, OptionalTeamControls> & Partial<Pick<ReturnType<typeof createTeamWorkbench>, OptionalTeamControls>>;
export function serve(db: Db, port: number, teams: TeamService = createTeamWorkbench(), terminals = createTerminalManager(), security: SecurityService = createSecurityService(), taskSource?: TaskSource) {
  const teamStreams = new Set<http.ServerResponse>();
  let lastSync: { at: string; cc: SyncResult; cx: SyncResult; vs?: SyncResult } | null = null;
  // Takeout 预览后暂存解析前的原文，导入时不用再传一遍；只留最近一份
  let takeout: { token: string; projectId: string; conversations: TakeoutConversation[] } | null = null;
  let syncing = false;
  const model = deepseek();

  const ownTask = (projectId: string, taskId: string) => {
    if (!taskId.startsWith(`${projectId}/`)) throw new HttpError(400, '任务不属于这个项目');
    return taskId;
  };
  const ownEvidence = (projectId: string, evidenceId: string) => {
    if (!db.evidenceForProject(projectId).some((e) => e.id === evidenceId)) throw new HttpError(400, '证据不属于这个项目');
    return evidenceId;
  };
  const project = (id: string) => {
    const p = db.getProject(id);
    if (!p) throw new HttpError(404, '项目不存在，可能已被删除');
    return p;
  };

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('x-crew-pid', String(process.pid)); // crew app / stop 靠它确认端口上是 Crew 服务
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    let parts: string[];
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, '地址编码无效'); }
    const method = req.method ?? 'GET';
    // 防 DNS 重绑定：只接受本机地址访问
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) throw new HttpError(403, '只允许本机访问');
    // 浏览器扩展（chrome-extension://）是唯一允许跨域的来源；网站来源一律不放行
    const origin = req.headers.origin;
    if (parts[0] === 'api' && ['team', 'terminals', 'security', 'today'].includes(parts[1]) && origin && origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, '工作台操作只允许当前本机页面访问');
    }
    const fromExtension = typeof origin === 'string' && /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin);
    if (parts[0] === 'api' && parts[1] === 'security' && method === 'OPTIONS') throw new HttpError(403, '凭证操作不接受跨域预检');
    if (parts[0] === 'api' && parts[1] === 'today' && method === 'OPTIONS') throw new HttpError(403, '今日安排不接受跨域预检');
    if (method === 'OPTIONS') {
      if (!fromExtension) throw new HttpError(403, '只允许本机页面和浏览器扩展访问');
      res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-corpus', 'access-control-max-age': '600', vary: 'origin' });
      res.end();
      return;
    }
    if (fromExtension) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); }
    // 防跨站请求：写操作必须带自定义请求头（网站跨站发不出这个头）
    if (method !== 'GET' && req.headers['x-corpus'] !== '1') throw new HttpError(403, '缺少请求头');

    if (method === 'GET' && STATIC[url.pathname]) {
      const file = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': TYPES[file.split('.').pop()!], 'cache-control': 'no-store' });
      res.end(readFileSync(new URL(file, WEB)));
      return;
    }
    if (method === 'GET' && TERMINAL_ASSETS[url.pathname]) {
      res.writeHead(200, { 'content-type': TYPES[url.pathname.split('.').pop()!], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(readFileSync(new URL(TERMINAL_ASSETS[url.pathname], import.meta.url)));
      return;
    }

    if (parts[0] !== 'api') throw new HttpError(404, '找不到这个地址');

    if (parts[1] === 'today') {
      const query = parse(z.string().max(100), url.searchParams.get('q') ?? '');
      if (method === 'GET' && parts.length === 2) {
        try { return send(res, 200, buildToday(db, { query, snapshot: taskSource?.read(), sourceConfigured: !!taskSource })); }
        catch (error) {
          if (error instanceof TaskSnapshotSizeError) throw new HttpError(413, error.message);
          throw error;
        }
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'refresh') {
        parse(z.object({}).strict(), await readJson(req, 1000));
        if (!taskSource) throw new HttpError(409, '尚未配置可搜索的任务来源');
        let result: ReturnType<typeof buildToday>;
        try { result = buildToday(db, { query, snapshot: taskSource.refresh(), sourceConfigured: true }); }
        catch (error) {
          if (error instanceof TaskSnapshotSizeError) throw new HttpError(413, error.message);
          throw new HttpError(503, '任务来源暂时无法读取，已保留上次快照；请稍后重新搜索');
        }
        if (!query) {
          try { taskSource.recordView?.(result.date, result.suggested.map(item => item.sourceId ?? item.taskId)); }
          catch (error) { console.error('今日页打开记录没有写入：', error); } // 记录失败不影响看页面
        }
        return send(res, 200, result);
      }
      throw new HttpError(404, '找不到这个今日安排操作');
    }

    if (parts[1] === 'security') {
      const Id = z.string().min(1).max(100);
      const scopeFields = { projectId: Id.optional() };
      const validateScope = (projectId?: string) => { if (projectId !== undefined) project(projectId); };
      const directories = (projectId: string) => project(projectId).dirs.flatMap((dir, index) => {
        try { return [{ id: `directory-${index}`, label: dir, canonical: realpathSync(dir) }]; } catch { return []; }
      });
      try {
        if (method === 'GET' && parts.length === 3 && parts[2] === 'credentials') return send(res, 200, await security.listCredentials());
        if (method === 'GET' && parts.length === 4 && parts[2] === 'projects') {
          const dirs = directories(parts[3]);
          return send(res, 200, { directories: dirs.map(({id,label}) => ({id,label})), latestScan: security.latestScan(parts[3]) });
        }
        if (method === 'POST' && parts.length === 3) {
          const raw = await readJson(req, 10000);
          if (parts[2] === 'inputs') {
            const body = parse(z.object({ provider:z.literal('ark'), ...scopeFields }).strict(), raw);
            validateScope(body.projectId); return send(res, 202, await security.requestInput(body));
          }
          if (parts[2] === 'probes') {
            const body = parse(z.object({ credentialId:Id, ...scopeFields }).strict(), raw);
            validateScope(body.projectId); return send(res, 202, await security.probe(body));
          }
          if (parts[2] === 'scans') {
            const body = parse(z.object({ projectId:Id, directoryId:Id }).strict(), raw);
            const dir = directories(body.projectId).find(d => d.id === body.directoryId);
            if (!dir) throw new HttpError(404, '绑定目录不存在');
            return send(res, 202, await security.startScan({ projectId:body.projectId, directory:dir.canonical }));
          }
        }
        if (parts[2] === 'operations' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'cancel' && method === 'POST'))) {
          let projectId: string | undefined;
          if (method === 'GET' && parts.length === 4) {
            const query = Object.fromEntries(url.searchParams);
            projectId = parse(z.object(scopeFields).strict(), query).projectId;
          } else if (method === 'POST' && parts[4] === 'cancel') {
            projectId = parse(z.object(scopeFields).strict(), await readJson(req, 10000)).projectId;
          } else throw new HttpError(404, '找不到这个凭证操作');
          validateScope(projectId);
          const existing = await security.getOperation(parts[3], projectId);
          if (!existing || existing.projectId !== projectId) throw new HttpError(404, '操作不存在');
          const op = method === 'POST' ? await security.cancelOperation(parts[3], projectId) : existing;
          if (!op || op.projectId !== projectId) throw new HttpError(404, '操作不存在');
          return send(res, 200, op);
        }
        throw new HttpError(404, '找不到这个凭证操作');
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const status = (error as {status?:number}).status;
        throw new HttpError(status && status >= 400 && status < 600 ? status : 503, '本地凭证管家暂不可用，请手动打开本地原生 App 后重试');
      }
    }

    if (parts[1] === 'terminals') {
      if (parts.length > 4) throw new HttpError(404, '找不到这个终端操作');
      const id = parts[2], action = parts[3];
      try {
        if (method === 'GET') {
          const projectId = url.searchParams.get('projectId') ?? '';
          project(projectId);
          if (!id) return send(res, 200, { sessions: terminals.list(projectId).map(({ output: _, ...metadata }) => metadata) });
          const snapshot = terminals.get(projectId, id);
          if (!action) return send(res, 200, snapshot);
          if (action !== 'events') throw new HttpError(404, '找不到这个终端操作');
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
          const write = (event: string, value: unknown) => {
            if (!res.destroyed && !res.writableEnded) {
              // A slow client must reconnect and replay instead of buffering without limit.
              if (res.writableLength > 2_000_000) { res.destroy(); return; }
              res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
            }
          };
          const unsubscribe = terminals.subscribe(projectId, id, event => write(event.type, event));
          teamStreams.add(res);
          write('snapshot', snapshot);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
          heartbeat.unref();
          res.on('close', () => { unsubscribe(); clearInterval(heartbeat); teamStreams.delete(res); });
          return;
        }
        if (method === 'POST' && !id) {
          const body = parse(z.object({ projectId: z.string().min(1).max(100), provider: z.enum(['codex', 'claude']), cwd: z.string().min(1).max(4096), requestId: z.string().min(1).max(100), cols: z.number().int().min(20).max(400).optional(), rows: z.number().int().min(5).max(200).optional() }).strict(), await readJson(req, 10000));
          const p = project(body.projectId);
          let cwd: string;
          try { cwd = realpathSync(body.cwd); } catch { throw new HttpError(400, '工作目录不存在'); }
          const allowed = p.dirs.some(dir => { try { return realpathSync(dir) === cwd; } catch { return false; } });
          if (!allowed) throw new HttpError(403, '请先把工作目录绑定到当前项目');
          return send(res, 201, await terminals.create(body.projectId, { ...body, cwd }));
        }
        if (method === 'POST' && id && ['input', 'resize', 'stop'].includes(action)) {
          const base = { projectId: z.string().min(1).max(100) };
          const raw = await readJson(req, 400000);
          if (action === 'input') {
            const body = parse(z.object({ ...base, data: z.string().min(1).max(65536) }).strict(), raw);
            project(body.projectId); terminals.input(body.projectId, id, body.data);
          } else if (action === 'resize') {
            const body = parse(z.object({ ...base, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(), raw);
            project(body.projectId); terminals.resize(body.projectId, id, body.cols, body.rows);
          } else {
            const body = parse(z.object(base).strict(), raw);
            project(body.projectId); terminals.stop(body.projectId, id);
          }
          return send(res, 200, { ok: true });
        }
        throw new HttpError(404, '找不到这个终端操作');
      } catch (error) {
        const e = error as Error & { status?: number };
        throw new HttpError(e.status && e.status >= 400 && e.status < 600 ? e.status : 503, e.message);
      }
    }

    if (parts[1] === 'team') {
      const action = parts[2];
      if (parts.length > 3) throw new HttpError(404, '找不到这个地址');
      if (method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? '';
        project(projectId);
        if (!action) return send(res, 200, teams.snapshot(projectId));
        if (action === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          const write = (snapshot: ReturnType<typeof teams.snapshot>) => {
            if (!res.destroyed && !res.writableEnded) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          };
          teamStreams.add(res);
          const unsubscribe = teams.subscribe(projectId, write);
          write(teams.snapshot(projectId));
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
          heartbeat.unref();
          res.on('close', () => { clearInterval(heartbeat); unsubscribe(); teamStreams.delete(res); });
          return;
        }
      } else if (method === 'POST' && ['start', 'stop', 'messages', 'approve', 'cancel', 'agent-message', 'agent-interrupt', 'answer'].includes(action ?? '')) {
        const body = parse(z.object({ projectId: z.string().min(1).max(100), to: z.enum(['codex', 'claude']).optional(), text: z.string().trim().min(1).max(8192).optional(), requestId: z.string().min(1).max(100).optional(), clientRequestId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(), mode: z.enum(['communication', 'delegation', 'codex-team']).optional(), cwd: z.string().min(1).max(4096).optional(), goal: z.string().trim().min(1).max(4000).optional(), access: z.enum(['read-only', 'workspace-write']).optional(), runId: z.string().min(1).max(100).optional(), taskId: z.string().min(1).max(100).optional(), inputId: z.string().min(1).max(100).optional(), answers: z.record(z.string().min(1).max(100), z.string().trim().min(1).max(8192)).optional(), threadId: z.string().min(1).max(100).optional(), turnId: z.string().min(1).max(100).optional(), approvalId: z.string().min(1).max(100).optional(), decision: z.enum(['accept', 'decline', 'cancel']).optional() }).strict(), await readJson(req, 40000));
        project(body.projectId);
        try {
          if (action === 'start') {
            if (body.mode === 'delegation' || body.mode === 'codex-team') {
              if (!body.cwd || !body.goal || !body.access) throw new HttpError(400, '需要项目目录、目标和权限');
              let cwd: string; try { cwd = realpathSync(body.cwd); } catch { throw new HttpError(400, '工作目录不存在'); }
              const p = project(body.projectId);
              if (!p.dirs.some(dir => { try { return realpathSync(dir) === cwd; } catch { return false; } })) throw new HttpError(403, '只能使用本项目绑定的工作目录');
              return send(res, 200, await teams.start(body.projectId, { mode: body.mode, cwd, goal: body.goal, access: body.access, ...(body.clientRequestId !== undefined ? { clientRequestId: body.clientRequestId } : {}) }));
            }
            if (body.cwd || body.goal || body.access || body.clientRequestId !== undefined) throw new HttpError(400, '委派配置需要明确选择委派模式');
            return send(res, 200, await teams.start(body.projectId));
          }
          if (action === 'answer') { if (!body.runId || !body.inputId || !body.answers || !teams.answer) throw new HttpError(400, '需要当前运行、提问编号和回答'); return send(res, 200, await teams.answer(body.projectId, body.runId, body.inputId, body.answers)); }
          if (action === 'agent-message') { if (!body.runId || !body.threadId || !body.text || !body.requestId || !teams.agentMessage) throw new HttpError(400, '需要当前运行、成员、消息和请求编号'); return send(res, 202, await teams.agentMessage(body.projectId, body.runId, body.threadId, body.text, body.requestId)); }
          if (action === 'agent-interrupt') { if (!body.runId || !body.threadId || !body.turnId || !teams.agentInterrupt) throw new HttpError(400, '需要当前运行、成员和执行编号'); return send(res, 200, await teams.agentInterrupt(body.projectId, body.runId, body.threadId, body.turnId)); }
          if (action === 'cancel') { if (!body.runId || !body.taskId || !teams.cancel) throw new HttpError(400, '需要当前运行与任务编号'); return send(res, 200, await teams.cancel(body.projectId, body.runId, body.taskId)); }
          if (action === 'approve') { if (!body.runId || !body.approvalId || !body.decision || !teams.approve) throw new HttpError(400, '需要当前运行、审批编号和决定'); return send(res, 200, await teams.approve(body.projectId, body.runId, body.approvalId, body.decision)); }
          if (action === 'stop') return send(res, 200, await teams.stop(body.projectId, body.runId));
          if (!body.to || !body.text || !body.requestId) throw new HttpError(400, '需要收件人、消息正文和请求编号');
          return send(res, 202, await teams.send(body.projectId, { to: body.to, text: body.text, requestId: body.requestId, ...(body.runId ? { runId: body.runId } : {}) }));
        } catch (error) {
          const e = error as Error & { status?: number };
          throw new HttpError(e.status && e.status >= 400 && e.status < 600 ? e.status : 503, e.message);
        }
      }
      throw new HttpError(404, '找不到这个团队操作');
    }

    if (method === 'GET' && parts[1] === 'state') {
      return send(res, 200, statePayload(db, model.name, lastSync?.at ?? null));
    }

    if (method === 'GET' && parts[1] === 'sources') {
      const skipped: Record<string, number> = {};
      for (const r of [lastSync?.cc, lastSync?.cx, lastSync?.vs]) for (const [k, n] of Object.entries(r?.skippedDirs ?? {})) skipped[k] = (skipped[k] ?? 0) + n;
      return send(res, 200, sourcesPayload(db, {
        installed: { claudeCode: existsSync(join(homedir(), '.claude', 'projects')), codex: existsSync(join(homedir(), '.codex', 'sessions')), vscode: existsSync(defaultVscodeRoot()) },
        lastSyncAt: lastSync?.at ?? null,
        badLines: (lastSync?.cc.badLines ?? 0) + (lastSync?.cx.badLines ?? 0),
        skippedDirs: Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 12),
        model: model.name,
      }));
    }

    if (method === 'POST' && parts[1] === 'read') {
      // 打开页面时调用：只读新对话，不整理，不调用模型
      const cc = syncClaudeCode(db);
      const cx = syncCodex(db);
      const vs = syncVscode(db);
      lastSync = { at: new Date().toISOString(), cc, cx, vs };
      return send(res, 200, { newMessages: cc.newMessages + cx.newMessages + vs.newMessages });
    }

    if (parts[1] !== 'projects') throw new HttpError(404, '找不到这个地址');

    if (method === 'POST' && parts.length === 2) {
      const b = parse(ProjectBody, await readJson(req));
      const id = db.createProject({ name: b.name, goal: b.goal || null, dirs: b.dirs });
      return send(res, 201, { id });
    }

    const id = parts[2];
    const p = project(id);

    if (method === 'DELETE' && parts.length === 3) {
      db.deleteProject(id);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && parts.length === 3) {
      db.logUsage(id, 'open_project');
      return send(res, 200, projectPayload(db, id));
    }

    if (method === 'GET' && parts[3] === 'messages') {
      // 只返回当前项目的消息（安全评审：之前是全局接口，知道编号就能跨项目读原文）
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 50);
      return send(res, 200, messagesPayload(db, id, ids));
    }

    if (method === 'GET' && parts[3] === 'context') {
      const taskId = ownTask(id, url.searchParams.get('task') ?? '');
      db.logUsage(id, 'context_view');
      return send(res, 200, { text: buildContext(db, id, taskId) });
    }

    if (method === 'POST' && parts[3] === 'usage') {
      const b = parse(z.object({ kind: z.enum(['context_copy', 'next_accept', 'next_later']) }), await readJson(req));
      db.logUsage(id, b.kind);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[3] === 'dirs') {
      const b = parse(z.object({ dir: z.string().trim().min(1) }), await readJson(req));
      db.addProjectDir(id, b.dir);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[3] === 'takeout' && parts[4] === 'preview') {
      // 可以直接传 Takeout 的 zip 包，也可以传 MyActivity.json
      let conversations: TakeoutConversation[];
      try {
        if (/zip|octet-stream/.test(req.headers['content-type'] ?? '')) {
          const buf = await readBody(req, 50_000_000);
          const dir = mkdtempSync(join(tmpdir(), 'corpus-upload-'));
          try {
            writeFileSync(join(dir, 'takeout.zip'), buf);
            conversations = readTakeoutPath(join(dir, 'takeout.zip'));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        } else {
          conversations = parseTakeout(await readJson(req, 50_000_000));
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
      takeout = { token: randomUUID(), projectId: id, conversations };
      return send(res, 200, { token: takeout.token, conversations: conversations.map((c) => ({ key: c.key, source: c.source, title: c.title, start: c.start, turns: c.turns.length, missingResponse: c.missingResponse, url: c.url })) });
    }

    if (method === 'POST' && parts[3] === 'takeout' && parts[4] === 'import') {
      const b = parse(z.object({ token: z.string(), keys: z.array(z.string()).min(1).max(500) }), await readJson(req));
      if (!takeout || takeout.token !== b.token || takeout.projectId !== id) throw new HttpError(409, '预览已过期，请重新选择文件');
      const r = importConversations(db, id, takeout.conversations, b.keys);
      db.logUsage(id, 'takeout_import');
      return send(res, 200, r);
    }

    if (method === 'POST' && parts[3] === 'import') {
      const b = parse(ImportBody, await readJson(req));
      const r = importText(db, { projectId: id, text: b.text, label: b.label, title: b.title, coverage: b.partial ? 'partial' : 'full', date: b.date || undefined, url: b.url || undefined });
      return send(res, 200, r);
    }

    if (method === 'POST' && parts[3] === 'consent') {
      db.setRemoteOk(id, true);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[3] === 'pause') {
      const b = parse(z.object({ paused: z.boolean() }), await readJson(req));
      db.setPaused(id, b.paused);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && parts[3] === 'usage') {
      return send(res, 200, db.usageSummary(id));
    }

    if (method === 'POST' && parts[3] === 'reextract') {
      // 换了提示词或模型后从头整理：证据清掉重来，任务编号和你的修正保留
      if (!p.remoteOk) throw new HttpError(428, `整理会把这个项目的对话正文发送到远程模型 ${model.name}。请先确认。`);
      if (syncing) throw new HttpError(409, '正在同步，请稍等');
      syncing = true;
      try {
        db.resetExtraction(id);
        db.logUsage(id, 'reextract');
        const r = await extractProject(db, id, model);
        return send(res, 200, { newMessages: 0, badLines: 0, ...r });
      } finally {
        syncing = false;
      }
    }

    if (method === 'POST' && parts[3] === 'tasks' && parts[5] === 'move') {
      const taskId = ownTask(id, parts[4]);
      const b = parse(z.object({ to: z.string() }), await readJson(req));
      project(b.to); // 目标项目不存在就 404
      if (b.to === id) throw new HttpError(400, '已经在这个项目里了');
      if (!db.tasksForProject(id).some((t) => t.id === taskId)) throw new HttpError(400, '任务不属于这个项目');
      const moved = db.moveTask(id, taskId, b.to);
      db.logUsage(id, 'move_task');
      return send(res, 200, { taskId: moved });
    }

    if (method === 'POST' && parts[3] === 'sessions' && parts[5] === 'exclude') {
      const sid = parts[4];
      if (!db.sessionsForProject(id).some((s) => s.id === sid)) throw new HttpError(400, '会话不属于这个项目');
      db.excludeSession(id, sid);
      db.logUsage(id, 'exclude_session');
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && parts[3] === 'sync') {
      // 需求：启用远程整理前说明会发送什么，得到同意再发
      if (!p.remoteOk) throw new HttpError(428, `整理会把这个项目的对话正文发送到远程模型 ${model.name}。请先确认。`);
      if (syncing) throw new HttpError(409, '正在同步，请稍等');
      syncing = true;
      try {
        const cc = syncClaudeCode(db);
        const cx = syncCodex(db);
        const vs = syncVscode(db);
        lastSync = { at: new Date().toISOString(), cc, cx, vs };
        db.logUsage(id, 'sync');
        const r = await extractProject(db, id, model);
        return send(res, 200, { newMessages: cc.newMessages + cx.newMessages + vs.newMessages, badLines: cc.badLines + cx.badLines, ...r });
      } finally {
        syncing = false;
      }
    }

    if (method === 'POST' && parts[3] === 'corrections') {
      const c = parse(CorrectionBody, await readJson(req));
      db.logUsage(id, `correction_${c.type}`);
      switch (c.type) {
        case 'new_task': {
          if (c.evidenceId) ownEvidence(id, c.evidenceId);
          const taskId = db.addTask({ projectId: id, name: c.name, goal: null, createdAt: new Date().toISOString() });
          if (c.evidenceId) db.addCorrection(id, { type: 'assign', evidenceId: c.evidenceId, taskId });
          db.addCorrection(id, { type: 'set_status', taskId, status: 'todo', note: '你手动建的任务' });
          return send(res, 200, { taskId });
        }
        case 'split': {
          // 把选中的证据拆成一个新任务；新任务的状态由这些证据自己算出来
          c.evidenceIds.forEach((e) => ownEvidence(id, e));
          const taskId = db.addTask({ projectId: id, name: c.name, goal: null, createdAt: new Date().toISOString() });
          c.evidenceIds.forEach((e) => db.addCorrection(id, { type: 'assign', evidenceId: e, taskId }));
          return send(res, 200, { taskId });
        }
        case 'set_role': {
          if (!db.messagesForProject(id).some((m) => m.id === c.messageId)) throw new HttpError(400, '消息不属于这个项目');
          db.setMessageRole(id, c.messageId, c.role);
          return send(res, 200, { ok: true });
        }
        case 'backfill_plan': {
          const ids = [...c.taskIds.map((t) => ownTask(id, t)), ...c.names.map((name) => db.addTask({ projectId: id, name, goal: null, createdAt: new Date().toISOString() }))];
          if (ids.length === 0) throw new HttpError(400, '后补规划至少要有一项');
          db.addCorrection(id, { type: 'backfill_plan', taskIds: ids });
          return send(res, 200, { ok: true });
        }
        case 'rename': case 'set_status': case 'confirm_condition':
          ownTask(id, c.taskId);
          break;
        case 'merge':
          ownTask(id, c.from); ownTask(id, c.into);
          if (c.from === c.into) throw new HttpError(400, '不能合并到自己');
          break;
        case 'assign':
          ownTask(id, c.taskId);
          ownEvidence(id, c.evidenceId);
          break;
        case 'ack':
          ownEvidence(id, c.evidenceId);
          break;
      }
      db.addCorrection(id, c as never);
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, '找不到这个地址');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: `服务出错：${(e as Error).message}` });
    });
  });
  const closeServer = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    for (const stream of teamStreams) stream.end();
    void security.close().catch(() => {});
    void teams.close().catch((error: unknown) => console.error('关闭团队连接失败', error));
    void terminals.close().catch((error: unknown) => console.error('关闭终端失败', error));
    return closeServer(callback);
  };
  server.requestTimeout = 15 * 60_000; // 整理一次可能要几分钟
  server.listen(port, '127.0.0.1', () => console.log(`Crew 已打开：http://127.0.0.1:${port}`));
  return server;
}
