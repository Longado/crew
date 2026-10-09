// Separate workspace-task MCP endpoint. The original three project tools stay unchanged.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TaskBoardClient, TASK_STATUSES, type TaskResult } from './task-board-client.ts';

const taskArg = z.number().int().positive().describe('Workspace 任务库里的正整数 task_id，先用 list/get 核对');
const requiredText = z.string().trim().min(1).max(2800);

export function createTaskBoardMcp(client: TaskBoardClient = new TaskBoardClient()): Server {
  const tools = [
    {
      name: 'crew_tasks_list', description: '读取本批次任务，返回任务库当前状态、原始编号及执行条件。与 Crew Tasks App 共用任务源，不启动模型。',
      args: z.object({}).strict(), readOnly: true, destructive: false,
      run: () => client.list(),
    },
    {
      name: 'crew_tasks_get', description: '按 task_id 读取当前任务、执行条件和保留的历史信息。',
      args: z.object({ task: taskArg }).strict(), readOnly: true, destructive: false,
      run: (a: { task: number }) => client.get(a.task),
    },
    {
      name: 'crew_tasks_cancel', description: '仅在用户明确要求终止此任务时调用。保留历史，备份任务库并取消任务；expected_status 须来自刚读取的状态，note 记录用户决定。不会停止正在执行的运行，请先 stop。',
      args: z.object({ task: taskArg, expected_status: z.enum(TASK_STATUSES), note: requiredText.describe('明确用户终止决定及保留成果说明') }).strict(), readOnly: false, destructive: true,
      run: (a: { task: number; expected_status: string; note: string }) => client.cancel(a.task, a.expected_status, a.note),
    },
    {
      name: 'crew_tasks_status', description: '读取某任务的当前状态及本地保留的运行回执。不会连接模型或自动恢复运行。',
      args: z.object({ task: taskArg }).strict(), readOnly: true, destructive: false,
      run: (a: { task: number }) => client.status(a.task),
    },
    {
      name: 'crew_tasks_dispatch', description: '通过已有本地看板服务派发选定任务。须先核对任务、与用户确认本次具体目标；默认只读，仅用户明确授权隔离修改时 write=true。复用 Crew 执行器，不发布、不合并。',
      args: z.object({ task: taskArg, goal: requiredText.describe('本次已确认的具体目标'), write: z.boolean().default(false).describe('仅显式授权时使用隔离修改') }).strict(), readOnly: false, destructive: false,
      run: (a: { task: number; goal: string; write: boolean }) => client.dispatch(a.task, a.goal, a.write),
    },
    {
      name: 'crew_tasks_stop', description: '按明确指定的运行编号停止本地看板中的运行。只停止该运行，不终止任务；任务终止使用 cancel。',
      args: z.object({ job: z.string().trim().min(1).max(200).describe('status 回执中的运行 id') }).strict(), readOnly: false, destructive: true,
      run: (a: { job: string }) => client.stop(a.job),
    },
  ] as const;
  const server = new Server({ name: 'crew-workspace-tasks', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name, description: tool.description,
      inputSchema: z.toJSONSchema(tool.args) as Tool['inputSchema'],
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(item => item.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `未知任务工具：${request.params.name}` }] };
    const parsed = tool.args.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: `参数不对：${parsed.error.issues.map(issue => issue.path.join('.') || '参数').join('、')}` }] };
    try {
      const value = await (tool.run as (a: unknown) => Promise<TaskResult>)(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}

export async function runTaskBoardMcp(client: TaskBoardClient = new TaskBoardClient()): Promise<Server> {
  const server = createTaskBoardMcp(client);
  await server.connect(new StdioServerTransport());
  return server;
}
