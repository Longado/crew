import { createTeamWorkbench } from '../bridge/workbench.ts';
import type { AdapterContext, NativeAgent, NativeTask, TeamAdapter } from '../bridge/types.ts';

/** Explicit offline demo: exercises real controller/workbench actions, never a model. */
export function createDemoWorkbench() {
  let ctx: AdapterContext, agents: NativeAgent[] = [], tasks: NativeTask[] = [];
  const change = () => ctx.onNativeState?.(structuredClone(agents), structuredClone(tasks));
  const adapter: TeamAdapter = {
    async start(context) {
      ctx = context;
      agents = [
        { threadId: 'demo-leader', name: 'Codex 负责人', role: 'leader', state: 'idle', events: [], updatedAt: '' },
        { threadId: 'demo-check', parentThreadId: 'demo-leader', name: '检查成员', role: 'explorer', state: 'waiting_input', turnId: 'demo-turn', events: [{ id: 'e', text: '检查接口返回格式（演示记录）。' }], updatedAt: '' },
      ];
      tasks = [{ id: 'demo-task', title: '检查返回格式', files: [], acceptance: ['说明字段含义'], state: 'running', threadId: 'demo-check', reviews: [] }];
      change(); ctx.onMember('codex', { connection: 'ready', sessionId: 'demo-leader', authLabel: '离线演示' });
      ctx.onInput?.({ id: 'demo-input', requestId: 1, threadId: 'demo-check', turnId: 'demo-turn', state: 'pending', questions: [{ id: 'format', header: '返回格式', question: '空列表应返回什么格式？', options: [{ label: 'JSON 数组', description: '返回 []。' }, { label: '带 data 字段的对象', description: '返回 {data:[]}。' }] }] });
      ctx.onApproval?.({ id: 'demo-approval', requestId: 2, threadId: 'demo-check', turnId: 'demo-turn', method: 'item/commandExecution/requestApproval', state: 'pending', detail: '演示：运行 node --test（此处不会执行命令）。' });
      return { setup: { command: '', instructions: '' } };
    },
    async deliver(message) { ctx.onOutput(`演示已收到目标：${message.text}\n这是显示样本，不代表真实任务完成。`, `goal:${message.id}`); },
    async steer(id, text) { agents.find(a => a.threadId === id)!.events.push({ id: `note-${Date.now()}`, text: `演示补充：${text}` }); change(); },
    async approve(approval, decision) { ctx.onApprovalResolved?.(approval.requestId); const a = agents.find(a => a.threadId === approval.threadId)!; a.events.push({ id: 'approval', text: `演示审批决定：${decision}；未执行任何命令。` }); if (decision === 'cancel') a.state = 'interrupt_requested'; change(); },
    async answer(input) { ctx.onInputResolved?.(input.requestId); agents[1]!.state = 'running'; agents[1]!.events.push({ id: 'answer', text: '演示回答已收到。' }); change(); },
    async interrupt(id) { const a = agents.find(a => a.threadId === id)!; a.state = 'interrupt_requested'; change(); a.state = 'interrupted'; delete a.turnId; tasks[0]!.state = 'interrupted'; change(); },
    async close() {},
  };
  return createTeamWorkbench({ adapterFactory: () => adapter });
}
