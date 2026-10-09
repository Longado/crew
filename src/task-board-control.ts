// CLI 与 MCP 共用本地 Crew Tasks 看板；工作区 tasks.db 仍是任务主库。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface BoardTask {
  task_id: number;
  sources: number[];
  line: string;
  status: string;
  next: string;
  [key: string]: unknown;
}

const cancelArgs = z.object({
  task_id: z.number().int().positive(),
  expected_status: z.enum(['todo', 'blocked', 'doing', 'done', 'cancelled']),
  reason: z.string().trim().min(1).max(2000).refine(value => !/[\r\n]/.test(value), '终止原因必须是单行'),
});

export class TaskBoardClient {
  private base: string;
  constructor(url = 'http://127.0.0.1:6480') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('board-url 必须是本地 HTTP 看板地址，如 http://127.0.0.1:6480');
    }
    this.base = parsed.origin;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-corpus': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || `Crew Tasks 返回 HTTP ${response.status}`);
    return result;
  }

  async list(): Promise<BoardTask[]> {
    const result = await this.request('/api/board') as { tasks?: BoardTask[] };
    if (!Array.isArray(result.tasks)) throw new Error('服务没有返回任务清单，请检查 board-url。');
    return result.tasks;
  }

  async get(taskId: number): Promise<BoardTask> {
    const task = (await this.list()).find(task => task.task_id === taskId);
    if (!task) throw new Error(`任务 #${taskId} 不在当前看板清单内。`);
    return task;
  }

  async cancel(args: z.infer<typeof cancelArgs>): Promise<BoardTask> {
    return await this.request('/api/tasks/cancel', cancelArgs.parse(args)) as BoardTask;
  }
}

async function runTasksMcp(client: TaskBoardClient): Promise<void> {
  const server = new McpServer({ name: 'crew-tasks', version: '0.1.0' });
  const result = async (operation: () => Promise<unknown>) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  };
  server.registerTool('crew_tasks_list', {
    description: '读取当前 Crew Tasks 看板及工作区任务库的实时状态，保留手写来源编号；不执行任务。',
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => result(() => client.list()));
  server.registerTool('crew_task_get', {
    description: '按 task_id 读取一项任务。终止前先读取并确认当前 status。',
    inputSchema: { task_id: z.number().int().positive() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ task_id }) => result(() => client.get(task_id)));
  server.registerTool('crew_task_cancel', {
    description: '用户明确要求终止时，将未执行任务设为 cancelled 并保存原因；保留文件，不能终止正在运行或已完成任务。expected_status 必须来自刚读取的任务。',
    inputSchema: cancelArgs.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => result(() => client.cancel(args)));
  await server.connect(new StdioServerTransport());
}

interface TaskOptions { url?: string; json?: boolean; reason?: string; expectedStatus?: string }
export async function runTasksCli(action: string | undefined, id: string | undefined, options: TaskOptions): Promise<void> {
  const client = new TaskBoardClient(options.url);
  if (action === 'mcp') return runTasksMcp(client);
  if (action === 'list' || !action) {
    const tasks = await client.list();
    console.log(options.json ? JSON.stringify(tasks, null, 2) : tasks.map(task => `${task.sources.join('/')}\t#${task.task_id}\t${task.line}\t${task.status}\t${task.next}`).join('\n'));
    return;
  }
  if (!['show', 'cancel'].includes(action)) throw new Error('用法：crew tasks list | show <task_id> | cancel <task_id> --expected-status <状态> --reason <原因> | mcp');
  if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('请提供任务库的正整数 task_id。');
  if (action === 'cancel' && !options.expectedStatus) throw new Error('缺少 --expected-status；请先用 tasks show 读取当前状态。');
  const task = action === 'show' ? await client.get(Number(id)) : await client.cancel(cancelArgs.parse({ task_id: Number(id), expected_status: options.expectedStatus, reason: options.reason }));
  console.log(JSON.stringify(task, null, 2));
}
