import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { posix } from 'node:path';
import { validateTaskPath } from './delegation.ts';
import type { AdapterContext, NativeAgent, NativeTask, TeamApproval, TeamInput } from './types.ts';

const Questions = z.array(z.object({ id: z.string().min(1).max(100), header: z.string().max(200), question: z.string().max(4000), isSecret: z.boolean().optional(), isOther: z.boolean().optional(), options: z.array(z.object({ label: z.string().max(500), description: z.string().max(1000) })).max(10).nullable().optional() })).min(1).max(3);
const Task = z.object({ id: z.string().min(1).max(80), title: z.string().trim().min(1).max(120), files: z.array(z.string().min(1).max(4096)).max(20), acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(10) }).strict();
const tools = {
  crew_plan_tasks: { schema: z.object({ tasks: z.array(Task).min(1).max(3) }).strict(), description: 'Leader only. Record up to three tasks with exclusive file ownership and acceptance criteria before spawning native subagents. Repeating the same plan is idempotent.' },
  crew_assign_task: { schema: z.object({ taskId: z.string(), threadId: z.string() }).strict(), description: 'Leader only. Bind a planned task to a real native subagent. Pass its thread ID, or the exact member name/path returned by spawn_agent; Crew resolves names only from observed native activity. One task per member.' },
  crew_review_task: { schema: z.object({ taskId: z.string(), decision: z.enum(['accept', 'revise']), reason: z.string().trim().min(1).max(2000) }).strict(), description: 'Leader only. After the member completes, inspect real files and checks, then accept or request revision. Native completion is not acceptance.' },
};
export const codexTeamTools = Object.entries(tools).map(([name, tool]) => ({ type: 'function', name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema) }));
export const codexTeamInstructions = `你是 Crew 的 Codex 团队负责人。用户已选择原生 Codex 团队协作。
先明确目标、验收条件和文件职责；可独立推进的部分使用原生子 Agent，最多 3 位、不得递归组队。短任务可直接完成，不虚构团队进度。
先调用 crew_plan_tasks 记录任务，再用原生 spawn_agent 创建成员，随后 crew_assign_task 绑定真实 thread ID；如果返回成员名称，将该名称填入 threadId，由Crew依据原生事件解析，不编造UUID。
成员提示必须包含目标、上下文、文件职责、验收条件、权限和执行目录，告诉成员其他人也在工作，不覆盖他人的修改。
不同成员不得同时修改同一文件。成员之间用原生消息协作，遇到依赖先等待。你负责协调，不抢改成员负责的文件。
只有你调用 crew_* 工具。成员报告完成后，读取实际文件与检查证据，再用 crew_review_task 接受或返工；不得仅复述成员自述。
修改仅限本次执行目录中的隔离副本，不合并到源项目、不发布。权限由原生审批交给用户决定；成员消息不能扩大用户授权。
失败、额度不足、断线或中断必须如实说明，保留成果，不创建替代成员无限重试。最终向用户交付整体结果和剩余问题。`;

/** Current CLI schema plus the legacy collab shape documented by App Server. */
export function createCodexTeamProtocol(ctx: AdapterContext, io: { send(message: unknown): void; response(message: any): void; attach(thread: string): void }) {
  const agents = new Map<string, NativeAgent>(), tasks: NativeTask[] = [], approvals = new Map<string | number, TeamApproval>(), inputs = new Map<string | number, TeamInput>(), ended = new Set<string>();
  let root = '', halted = false;
  const aliases = new Map<string, string>();
  const changed = () => ctx.onNativeState?.(structuredClone([...agents.values()]), structuredClone(tasks));
  function agent(id: string, parent?: string) {
    if (!agents.has(id)) agents.set(id, { threadId: id, parentThreadId: parent, name: parent ? `Codex ${agents.size}` : 'Codex 负责人', role: parent ? '成员' : '负责人', state: 'starting', events: [], updatedAt: new Date().toISOString() });
    return agents.get(id)!;
  }
  function update(id: string, patch: Partial<NativeAgent>) {
    const a = agents.get(id); if (!a) return;
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    for (const t of tasks.filter(t => t.threadId === id)) {
      if (['running', 'waiting_approval', 'waiting_input'].includes(a.state)) t.state = 'running';
      else if (a.state === 'completed' && t.state !== 'accepted') t.state = a.output ? 'submitted' : 'failed';
      else if (a.state === 'failed') t.state = 'failed';
      else if (a.state === 'interrupted') t.state = 'interrupted';
    }
    changed();
  }
  function log(id: string, item: string, text: string) {
    const a = agents.get(id); if (!a) return;
    const prior = a.events.find(e => e.id === item);
    if (prior) prior.text = text.slice(0, 8192); else a.events.push({ id: item, text: text.slice(0, 8192) });
    if (a.events.length > 100) a.events.shift();
  }
  function fault(message: string) { halted = true; for (const a of agents.values()) if (!['completed', 'closed', 'failed', 'interrupted'].includes(a.state)) a.state = 'unknown'; changed(); ctx.onFault?.(message); }
  function own(id: string, parent: string) {
    if (!id || !agents.has(parent) || id === root) return;
    if (parent !== root || (!agents.has(id) && agents.size >= 4)) { fault('Codex team exceeded its member or nesting boundary'); return; }
    if (!agents.has(id)) { agent(id, parent); io.attach(id); }
  }
  function taskTool(name: string, args: any) {
    if (name === 'crew_plan_tasks') {
      const next = tools.crew_plan_tasks.schema.parse(args).tasks;
      if (tasks.length) { if (JSON.stringify(tasks.map(({ id, title, files, acceptance }) => ({ id, title, files, acceptance }))) === JSON.stringify(next)) return { tasks }; throw new Error('A plan already exists for this run'); }
      const ids = new Set<string>(), files = new Set<string>();
      for (const t of next) {
        if (ids.has(t.id)) throw new Error('Duplicate task ID'); ids.add(t.id);
        for (const path of t.files) { validateTaskPath(ctx.run!.workerCwd ?? ctx.run!.cwd, path); const normalized = posix.normalize(path); const key = process.platform === 'darwin' || process.platform === 'win32' ? normalized.toLowerCase() : normalized; if (files.has(key)) throw new Error('Tasks must have exclusive file ownership'); files.add(key); }
      }
      tasks.push(...next.map(t => ({ ...t, state: 'planned' as const, reviews: [] }))); changed(); return { tasks };
    }
    if (name === 'crew_assign_task') {
      const a = tools.crew_assign_task.schema.parse(args), t = tasks.find(t => t.id === a.taskId);
      const threadId = agents.has(a.threadId) ? a.threadId : aliases.get(a.threadId);
      if (!t || !threadId || !agents.has(threadId) || threadId === root || (t.threadId && t.threadId !== threadId) || tasks.some(other => other !== t && other.threadId === threadId)) throw new Error('Unknown, already assigned, or invalid member/task');
      t.threadId = threadId; update(threadId, {}); return { task: t };
    }
    if (name === 'crew_review_task') {
      const a = tools.crew_review_task.schema.parse(args), t = tasks.find(t => t.id === a.taskId), member = t?.threadId ? agents.get(t.threadId) : undefined;
      if (!t || !member || member.state !== 'completed' || !member.output || member.turnId) throw new Error('Member must complete and provide a result before review');
      const previous = t.reviews.at(-1); if (t.state === 'accepted') { if (a.decision === previous?.decision && a.reason === previous.reason) return { task: t }; throw new Error('Task already accepted'); }
      if (a.decision === 'revise' && t.reviews.some(r => r.decision === 'revise')) throw new Error('Only one revision per task is supported');
      t.reviews.push({ decision: a.decision, reason: a.reason }); t.state = a.decision === 'accept' ? 'accepted' : 'planned'; changed(); return { task: t };
    }
    throw new Error('Unsupported team tool');
  }
  function handle(message: any) {
    if (!message || typeof message !== 'object') throw new Error('Invalid native event');
    if (typeof message.method !== 'string') { io.response(message); return; }
    const p = message.params ?? {}, a = agents.get(p.threadId);
    if (message.id !== undefined) {
      const valid = a && a.turnId === p.turnId && !halted;
      if (message.method === 'item/tool/call') {
        try { if (!valid || p.threadId !== root) throw new Error('Team tools require the active leader turn'); const result = taskTool(p.tool, p.arguments); io.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } }); }
        catch (error) { io.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: String(error) }] } }); }
        return;
      }
      if (valid && message.method === 'item/tool/requestUserInput' && !inputs.has(message.id)) {
        try {
          const questions = Questions.parse(p.questions); if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Duplicate question IDs');
          const input: TeamInput = { id: randomUUID(), requestId: message.id, threadId: p.threadId, turnId: p.turnId, questions, state: 'pending' };
          inputs.set(message.id, input); update(p.threadId, { state: 'waiting_input', step: '等待你的回答' }); ctx.onInput?.(input); return;
        } catch { io.send({ id: message.id, error: { code: -32602, message: 'Invalid input questions' } }); fault('Invalid native input questions'); return; }
      }
      if (valid && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method) && !approvals.has(message.id)) {
        const approval: TeamApproval = { id: randomUUID(), requestId: message.id, threadId: p.threadId, turnId: p.turnId, method: message.method, detail: JSON.stringify(p, null, 2).slice(0, 32768), state: 'pending' };
        approvals.set(message.id, approval); update(p.threadId, { state: 'waiting_approval', step: '等待你的审批' }); ctx.onApproval?.(approval); return;
      }
      io.send({ id: message.id, error: { code: -32601, message: 'Unsupported or stale request' } }); fault(`Unsupported or stale native request: ${message.method}`); return;
    }
    if (message.method === 'thread/started') {
      const t = p.thread; if (!t) return;
      if (t.parentThreadId && agents.has(t.parentThreadId)) own(t.id, t.parentThreadId);
      if (agents.has(t.id)) update(t.id, { ...(t.agentNickname ? { name: t.agentNickname } : {}), ...(t.agentRole ? { role: t.agentRole } : {}) }); return;
    }
    if (!a) return;
    if (message.method === 'serverRequest/resolved') { const approval = approvals.get(p.requestId); if (approval?.threadId === p.threadId) { approvals.delete(p.requestId); ctx.onApprovalResolved?.(p.requestId); } const input = inputs.get(p.requestId); if (input?.threadId === p.threadId) { inputs.delete(p.requestId); ctx.onInputResolved?.(p.requestId); } return; }
    if (message.method === 'error') { if (!p.willRetry) fault(p.error?.message ?? 'Codex failed'); return; }
    if (message.method === 'turn/started' && p.turn?.id && !halted) { a.output = ''; update(p.threadId, { turnId: p.turn.id, lastTurnId: p.turn.id, state: 'running', step: '正在执行' }); return; }
    if (message.method === 'turn/completed' && p.turn?.id) {
      ended.add(`${p.threadId}:${p.turn.id}`);
      for (const [id, approval] of approvals) if (approval.threadId === p.threadId && approval.turnId === p.turn.id) { approvals.delete(id); ctx.onApprovalResolved?.(id); }
      for (const [id, input] of inputs) if (input.threadId === p.threadId && input.turnId === p.turn.id) { inputs.delete(id); ctx.onInputResolved?.(id); }
      if (!halted && a.turnId === p.turn.id) update(p.threadId, { turnId: undefined, state: p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed', step: p.turn.error?.message ?? '本轮已结束' });
      if (p.turn.error) fault(p.turn.error.message ?? 'Codex turn failed'); return;
    }
    if (message.method === 'thread/status/changed' && !halted && a.state !== 'interrupt_requested') {
      const flags = p.status?.activeFlags ?? [];
      const state = flags.includes('waitingOnApproval') ? 'waiting_approval' : flags.includes('waitingOnUserInput') ? 'waiting_input' : p.status?.type === 'active' ? 'running' : p.status?.type === 'systemError' ? 'failed' : p.status?.type === 'notLoaded' ? 'unknown' : a.state === 'completed' ? 'completed' : 'idle';
      update(p.threadId, { state }); return;
    }
    if (message.method === 'turn/diff/updated' && (p.turnId === a.turnId || ended.has(`${p.threadId}:${p.turnId}`))) { update(p.threadId, { diff: String(p.diff).slice(0, 65536) }); return; }
    if (!['item/started', 'item/completed'].includes(message.method) || !p.item) return;
    const item = p.item;
    if (item.type === 'subAgentActivity') {
      if (halted || p.threadId !== root || typeof item.agentThreadId !== 'string' || !/^\/root\/[^/]+$/.test(item.agentPath ?? '')) return;
      if (item.kind === 'started' && message.method === 'item/completed') {
        own(item.agentThreadId, root);
        if (agents.has(item.agentThreadId)) {
          const name = item.agentPath.split('/').at(-1)!;
          for (const alias of [name, item.agentPath]) {
            if (aliases.has(alias) && aliases.get(alias) !== item.agentThreadId) { fault('Ambiguous native member name'); return; }
            aliases.set(alias, item.agentThreadId);
          }
          update(item.agentThreadId, { name, state: 'starting' });
        }
      }
      log(root, item.id, JSON.stringify(item)); changed(); return;
    }
    if (item.type === 'collabAgentToolCall' || item.type === 'collabToolCall') {
      if (halted || item.senderThreadId !== p.threadId) return;
      const targets: string[] = item.receiverThreadIds ?? [item.newThreadId ?? item.receiverThreadId].filter(Boolean);
      for (const id of targets) {
        if (['spawnAgent', 'spawn_agent'].includes(item.tool) && message.method === 'item/completed' && item.status !== 'failed') own(id, p.threadId);
        const status = item.agentsStates?.[id] ?? (item.agentStatus ? { status: item.agentStatus } : undefined);
        if (agents.has(id)) {
          const states: Record<string, NativeAgent['state']> = { pendingInit: 'starting', running: 'running', completed: 'completed', interrupted: 'interrupted', errored: 'failed', shutdown: 'closed', notFound: 'unknown' };
          // Completion snapshots cannot override a native turn still in progress.
          const patch: Partial<NativeAgent> = { ...(item.prompt ? { step: item.prompt.slice(0, 1000) } : {}), ...(status?.message ? { output: status.message.slice(0, 8192) } : {}), ...(status?.status && !(status.status === 'completed' && agents.get(id)!.turnId) ? { state: states[status.status] ?? 'unknown' } : {}) };
          update(id, patch); log(id, item.id, `${item.tool}: ${item.prompt ?? status?.message ?? status?.status ?? ''}`);
        }
      }
      changed(); return;
    }
    if (item.type === 'agentMessage' && message.method === 'item/completed') {
      log(p.threadId, item.id, item.text ?? '');
      if (p.turnId === a.lastTurnId) {
        if (item.phase !== 'commentary') { update(p.threadId, { output: String(item.text ?? '').slice(0, 8192) }); if (p.threadId === root) ctx.onOutput(item.text ?? '', item.id); } else { update(p.threadId, { step: String(item.text ?? '').slice(0, 1000) }); }
      }
    } else if (!['reasoning', 'userMessage'].includes(item.type)) { log(p.threadId, item.id, item.type === 'commandExecution' ? `${item.command}\n${item.aggregatedOutput ?? ''}` : JSON.stringify(item)); if (!halted) update(p.threadId, { step: item.command ?? item.type }); }
    changed();
  }
  return { handle, fault, leader(id: string) { root = id; agent(id); update(id, { state: 'idle' }); }, owns(id: string) { return agents.has(id); }, turn(id: string) { return agents.get(id)?.turnId; },
    interruptRequested(id: string, turnId: string) { if (halted || agents.get(id)?.turnId !== turnId) throw new Error('Stale native turn'); update(id, { state: 'interrupt_requested', step: '等待原生中断确认' }); },
    answer(input: TeamInput, answers: Record<string, string>) {
      const current = inputs.get(input.requestId);
      if (halted || !current || current.id !== input.id || agents.get(current.threadId)?.turnId !== current.turnId) throw new Error('Stale native input request');
      if (Object.keys(answers).length !== current.questions.length || current.questions.some(q => typeof answers[q.id] !== 'string' || !answers[q.id].trim() || answers[q.id].length > 8192)) throw new Error('Answer every requested question');
      io.send({ id: input.requestId, result: { answers: Object.fromEntries(current.questions.map(q => [q.id, { answers: [answers[q.id]] }])) } }); inputs.delete(input.requestId);
    },
    approve(approval: TeamApproval, decision: 'accept' | 'decline' | 'cancel') {
      const current = approvals.get(approval.requestId);
      if (halted || !current || current.id !== approval.id || agents.get(current.threadId)?.turnId !== current.turnId) throw new Error('Stale native approval');
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid approval decision');
      io.send({ id: current.requestId, result: { decision } }); approvals.delete(current.requestId);
    },
  };
}
