// MCP 连接器：读取项目现场、续接上下文，也让 Agent 自报进度。
// 手写 JSON-RPC 2.0，走 stdio：一行一条消息。不调用大模型，自报走现有证据规则。
// stdout 只能写协议消息，其他输出一律走 stderr。
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { STATUS_LABEL, type Message, type TaskRef, type TaskView } from './contracts.ts';
import type { Db } from './db.ts';
import { buildProjectView } from './engine/view.ts';
import { buildContext, planLine } from './engine/context.ts';
import { gitRoot } from './ingest/common.ts';
import { storeEvidence } from './extract/validate.ts';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const DEFAULT_PROTOCOL = '2025-06-18';

type Id = string | number | null;
export type McpResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };
interface ToolResult { content: { type: 'text'; text: string }[]; isError?: true }
interface McpContext { cwd: string; clientName?: string }

const ok = (id: Id, result: unknown): McpResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): McpResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const problem = (t: string): ToolResult => ({ ...text(t), isError: true });

const shortId = (id: string) => id.split('/').at(-1)!;

/** 先按编号或全名精确找，找不到再按名字包含找。返回全部命中，由调用方判断 0 个、1 个还是多个。 */
function pick<T extends { name: string }>(items: T[], query: string, ids: (t: T) => string[]): T[] {
  const q = query.trim();
  const exact = items.filter((t) => t.name === q || ids(t).some((i) => i.toLowerCase() === q.toLowerCase()));
  return exact.length ? exact : items.filter((t) => t.name.includes(q));
}

function projectListing(db: Db): string {
  const projects = db.listProjects();
  if (!projects.length) return '还没有项目。先在终端运行 npm run corpus -- project add "项目名" --dir <代码目录> 建一个。';
  return projects.map((p) => `- ${p.name}（${p.id}）${p.dirs.length ? `：${p.dirs.join('，')}` : '：没有绑定目录'}`).join('\n');
}

/** 找项目：传了就按编号或名字找；没传就看当前目录绑定到哪个项目。 */
function findProject(db: Db, query: string | undefined, cwd: string): { id: string } | { error: ToolResult } {
  if (!query) {
    const id = db.projectForDir(gitRoot(cwd)) ?? db.projectForDir(cwd);
    return id ? { id } : { error: problem(`当前目录（${cwd}）没有绑定到任何项目。请用 project 参数指定项目名或编号。已有项目：\n${projectListing(db)}`) };
  }
  const hits = pick(db.listProjects(), query, (p) => [p.id]);
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length === 0) return { error: problem(`没有找到项目「${query}」。已有项目：\n${projectListing(db)}`) };
  return { error: problem(`「${query}」匹配到多个项目，请写全名或编号：\n${hits.map((p) => `- ${p.name}（${p.id}）`).join('\n')}`) };
}

const taskLine = (t: TaskView) => `${STATUS_LABEL[t.status]} · ${shortId(t.id)} ${t.name} — ${t.basisNote}`;

function projectStatus(db: Db, projectId: string): string {
  const project = db.getProject(projectId)!;
  const view = buildProjectView(db, projectId);
  const active = view.tasks.filter((t) => t.status !== 'cancelled');
  const cancelled = view.tasks.filter((t) => t.status === 'cancelled');
  return [
    `# ${project.name}（${project.id}）`,
    `目标：${project.goal ?? '未填写'}`,
    `当前规划：${planLine(view)}`,
    ...(view.coverageWarning ? ['注意：有来源只读到一部分，下面的结论可能不全'] : []),
    '任务：',
    ...(active.length ? active.map((t) => `- ${taskLine(t)}`) : ['- 还没有任务']),
    ...(cancelled.length ? ['不要做（已取消）：', ...cancelled.map((t) => `- ${shortId(t.id)} ${t.name} — ${t.basisNote}`)] : []),
    '下一步：',
    ...(view.next.length ? view.next.map((n, i) => `${i + 1}. ${n.action}（${n.reason}）${n.precondition !== '无' ? ` 前置条件：${n.precondition}` : ''}`) : ['- 暂无建议']),
    `待确认：${view.pending.length} 条${view.pending.length ? '，请到 Working Corpus 页面上处理' : ''}`,
    '提醒：AI 自述完成只算待验证，用户确认了才算完成。要接着做某个任务，调用 continue_context 并传任务编号。',
  ].join('\n');
}

function findTask(db: Db, projectId: string, query: string): { task: TaskView } | { error: ToolResult } {
  const tasks = buildProjectView(db, projectId).tasks;
  const listing = (ts: TaskView[]) => ts.map((t) => `- ${shortId(t.id)} ${t.name}（${STATUS_LABEL[t.status]}）`).join('\n');
  const hits = pick(tasks, query, (t) => [t.id, shortId(t.id)]);
  if (hits.length === 1) return { task: hits[0] };
  if (hits.length === 0) {
    const name = db.getProject(projectId)!.name;
    return { error: problem(`项目「${name}」里没有匹配「${query}」的任务。${tasks.length ? `已有任务：\n${listing(tasks)}` : '这个项目还没有任务。'}`) };
  }
  return { error: problem(`「${query}」匹配到多个任务，请用编号指定：\n${listing(hits)}`) };
}

function continueContext(db: Db, projectId: string, query: string): ToolResult {
  const found = findTask(db, projectId, query);
  return 'error' in found ? found.error : text(buildContext(db, projectId, found.task.id));
}

function clientLabel(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) return 'MCP';
  if (/claude/i.test(name)) return 'Claude Code';
  if (/codex/i.test(name)) return 'Codex';
  if (/cursor/i.test(name)) return 'Cursor';
  return name;
}

type ReportKind = 'started' | 'ai_claims_done' | 'blocked' | 'plan_add';

/** 消息、证据和整理游标一起提交；引用固定为 assistant，沿用折叠规则。 */
function writeReport(db: Db, projectId: string, label: string, report: {
  kind: ReportKind; task: TaskRef; message: string; detail: string; reason?: string;
}): ToolResult {
  const sessionId = `mcp-${createHash('sha256').update(JSON.stringify([projectId, label])).digest('hex')}`;
  return db.tx(() => {
    if (db.getSession(sessionId)?.excluded) return problem('这个自报会话已被移出项目，请先由用户处理。');
    db.upsertSession({ id: sessionId, source: 'mcp', label, projectId, cwd: null, title: '自报进度', coverage: 'full' });
    const now = new Date().toISOString();
    const message: Message = {
      id: `mcp:${randomUUID()}`, sessionId, seq: db.maxSeq(sessionId) + 1,
      role: 'assistant', text: report.message, ts: now, capturedAt: now,
    };
    db.insertMessages([message]);
    const result = storeEvidence(db, projectId, [{
      reasoning: 'MCP 调用方主动自报，引用 AI 消息，不代表用户确认',
      task: report.task, kind: report.kind, cite: [message.id], detail: report.detail, reason: report.reason,
    }], new Map([[message.id, message]]), { model: 'mcp', promptVersion: 'mcp-report-v1' });
    if (result.stored.length !== 1) throw new Error(`自报未入库：${result.dropped.map(item => item.why).join('；')}`);
    // 通用提取会 trim 原因；主动求助的 need 要完整保留，和 blocker 原文一致。
    if (report.kind === 'blocked' && report.reason !== undefined && report.reason !== result.stored[0].reason) {
      db.setEvidenceReason(projectId, result.stored[0].id, report.reason);
    }
    db.setExtractedUpto(sessionId, message.seq);
    const receipt: Record<ReportKind, string> = {
      started: '已记录开工，状态按现有证据规则折叠为进行中。',
      ai_claims_done: '已记为待验证，用户确认后才算完成。',
      blocked: '已记录受阻及所需输入，请用户处理。',
      plan_add: '已记为 AI 建议，进入待确认；用户采纳前不进入当前规划。',
    };
    return text(`${receipt[report.kind]}\n${report.message}`);
  });
}

function reportTask(db: Db, a: { task: string; project?: string; note?: string; summary?: string; need?: string }, cwd: string, label: string, kind: Exclude<ReportKind, 'plan_add'>): ToolResult {
  const p = findProject(db, a.project, cwd);
  if ('error' in p) return p.error;
  const found = findTask(db, p.id, a.task);
  if ('error' in found) return found.error;
  const task = found.task;
  const verb = { started: '开工', ai_claims_done: '交活', blocked: '受阻' }[kind];
  const detail = kind === 'blocked' ? a.need! : kind === 'ai_claims_done' ? a.summary! : a.note;
  const message = `${verb}：${shortId(task.id)} ${task.name}。${detail ?? ''}`;
  return writeReport(db, p.id, label, { kind, task: { id: task.id }, message, detail: detail ?? message, ...(kind === 'blocked' ? { reason: a.need } : {}) });
}

const projectArg = z.string().min(1).optional().describe('项目名或编号。不传就按当前工作目录推断');
const taskArg = z.string().trim().min(1).describe('任务编号（如 T03）、完整编号或任务名');
const nonblank = () => z.string().min(1).refine(value => value.trim().length > 0, '不能为空白');
const TOOLS = [
  {
    name: 'list_projects',
    readOnly: true,
    description: '列出 Working Corpus 里的全部项目：名称、编号、绑定的代码目录。不确定当前项目叫什么时先调这个。',
    args: z.object({}),
    run: (db: Db) => text(projectListing(db)),
  },
  {
    name: 'project_status',
    readOnly: true,
    description: '读取一个项目的现场：目标、当前规划、每个任务的状态和依据、已取消不要做的事、下一步建议、待确认条数。开工前先看一眼，避免重做已完成或已取消的事。AI 自述完成只算待验证。',
    args: z.object({ project: projectArg }),
    run: (db: Db, a: { project?: string }, cwd: string) => {
      const p = findProject(db, a.project, cwd);
      return 'error' in p ? p.error : text(projectStatus(db, p.id));
    },
  },
  {
    name: 'continue_context',
    readOnly: true,
    description: '生成某个任务的续接上下文：项目目标、当前规划、完成标准、进展、相关决定、阻塞、不要做的事、本轮该做什么。接着做某个任务之前调用，按里面写的范围和完成标准干活。',
    args: z.object({ task: z.string().min(1).describe('任务编号（如 T03）、完整编号或任务名'), project: projectArg }),
    run: (db: Db, a: { task: string; project?: string }, cwd: string) => {
      const p = findProject(db, a.project, cwd);
      return 'error' in p ? p.error : continueContext(db, p.id, a.task);
    },
  },
  {
    name: 'check_in',
    readOnly: false,
    description: '开工前读过 project_status 后调用，报告开始执行已有任务，可说明先做什么。只记 AI 自报，按现有规则折叠为进行中；不替用户确认完成或采纳规划。',
    args: z.object({ task: taskArg, note: z.string().optional().describe('本轮先做什么'), project: projectArg }).strict(),
    run: (db: Db, a: { task: string; note?: string; project?: string }, cwd: string, label: string) => reportTask(db, a, cwd, label, 'started'),
  },
  {
    name: 'hand_in',
    readOnly: false,
    description: '完成本轮工作后调用，summary 写做了什么以及用户如何验收。只记 AI 自述完成，进入待验证；用户确认后才算完成，不能通过参数替人确认。',
    args: z.object({ task: taskArg, summary: nonblank().describe('做了什么、用户怎么验收，必填'), project: projectArg }).strict(),
    run: (db: Db, a: { task: string; summary: string; project?: string }, cwd: string, label: string) => reportTask(db, a, cwd, label, 'ai_claims_done'),
  },
  {
    name: 'raise_hand',
    readOnly: false,
    description: '缺输入、依赖或需要用户操作而无法继续时调用。need 写缺什么、要用户做什么，记录为受阻，在网页「等你」中显示；只记 AI 自报。',
    args: z.object({ task: taskArg, need: nonblank().describe('缺什么、需要用户做什么，必填'), project: projectArg }).strict(),
    run: (db: Db, a: { task: string; need: string; project?: string }, cwd: string, label: string) => reportTask(db, a, cwd, label, 'blocked'),
  },
  {
    name: 'propose_task',
    readOnly: false,
    description: '发现值得新增的工作时调用，name 写任务名，why 写原因。只记 AI 建议，进入待确认，用户采纳之前不加入当前规划。',
    args: z.object({ name: z.string().trim().min(1).describe('建议的新任务名'), why: nonblank().describe('为什么建议做这件事'), project: projectArg }).strict(),
    run: (db: Db, a: { name: string; why: string; project?: string }, cwd: string, label: string) => {
      const p = findProject(db, a.project, cwd);
      if ('error' in p) return p.error;
      const message = `建议新增：${a.name}。${a.why}`;
      return writeReport(db, p.id, label, { kind: 'plan_add', task: { newName: a.name }, message, detail: a.why, reason: a.why });
    },
  },
] as const;

function callTool(db: Db, params: Record<string, unknown>, ctx: McpContext, id: Id): McpResponse {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return fail(id, -32602, `未知工具：${String(params.name)}。可用：${TOOLS.map((t) => t.name).join('、')}`);
  const parsed = tool.args.safeParse(params.arguments ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '参数').join('、');
    return ok(id, problem(`参数不对：${fields}。请按 ${tool.name} 的参数说明重试`));
  }
  return ok(id, (tool.run as (db: Db, a: unknown, cwd: string, label: string) => ToolResult)(db, parsed.data, ctx.cwd, ctx.clientName ?? 'MCP'));
}

/** 处理一条已解析的消息。请求返回响应，通知和客户端发来的响应返回 null。 */
export function handleMcp(db: Db, msg: unknown, ctx: McpContext): McpResponse | null {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return fail(null, -32600, 'Invalid Request');
  const m = msg as { id?: Id; method?: unknown; params?: Record<string, unknown> };
  if (typeof m.method !== 'string') return 'result' in m || 'error' in m ? null : fail(m.id ?? null, -32600, 'Invalid Request');
  if (!('id' in m)) return null; // 通知不回复，包括 notifications/initialized
  const id = m.id ?? null;
  const params = m.params ?? {};
  try {
    switch (m.method) {
      case 'initialize':
        ctx.clientName = clientLabel((params.clientInfo as { name?: unknown } | undefined)?.name);
        return ok(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'working-corpus', version: VERSION },
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.args), annotations: { readOnlyHint: t.readOnly } })),
        });
      case 'tools/call':
        return callTool(db, params, ctx, id);
      default:
        return fail(id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    console.error(e);
    return fail(id, -32603, e instanceof Error ? e.message : String(e));
  }
}

/** 接上 stdin/stdout。stdin 关闭后进程自然退出。 */
export function runMcp(db: Db): void {
  const send = (r: McpResponse) => process.stdout.write(`${JSON.stringify(r)}\n`);
  const ctx = { cwd: process.cwd() };
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, -32700, 'Parse error'));
      return;
    }
    const r = handleMcp(db, msg, ctx);
    if (r) send(r);
  });
}
