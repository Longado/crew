import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { MemberId, TeamSnapshot } from './types.ts';

export const Result = z.object({
  summary: z.string().trim().min(1).max(4000),
  artifacts: z.array(z.object({ path: z.string().min(1).max(4096), description: z.string().max(500) }).strict()).max(20),
  checks: z.array(z.object({ command: z.string().max(1000), status: z.enum(['passed', 'failed', 'not_run']), detail: z.string().max(1000) }).strict()).max(20),
  unresolved: z.array(z.string().max(500)).max(20),
}).strict();
const TaskInput = z.object({ request_id: z.string().min(1).max(100), title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(4000), context: z.string().max(4000), files: z.array(z.string().min(1).max(4096)).max(20), acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(10) }).strict();
const Ref = { task_id: z.string().min(1), attempt: z.union([z.literal(1), z.literal(2)]) };
export type TaskResult = z.infer<typeof Result>;
export interface DelegatedTask {
  id: string; requestId: string; runId: string; projectId: string; goalMessageId: string;
  leader: 'claude'; assignee: 'codex'; title: string; goal: string; context: string; files: string[]; acceptance: string[];
  access: 'read-only' | 'workspace-write'; state: 'queued' | 'running' | 'needs_input' | 'submitted' | 'accepted' | 'failed' | 'cancel_requested' | 'cancelled' | 'delivery_unknown';
  attempt: 1 | 2; createdAt: string; updatedAt: string; workerThreadId?: string; workerTurnId?: string;
  result?: TaskResult; lateResults?: TaskResult[]; diff?: string; review?: { decision: 'accept' | 'revise'; reason: string }; previousResults: TaskResult[]; revisionReason?: string; question?: string; error?: string; needsAttention?: boolean;
}
export function delegationError(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
export function validateTaskPath(root: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..') || path.includes('\\') || path.includes('\0')) delegationError('Task path must stay inside the project', 400);
  if (path === '.' || (existsSync(resolve(root, path)) && statSync(resolve(root, path)).isDirectory())) delegationError('Task paths must identify files, not project directories', 400);
  let parent = resolve(root, path);
  while (!existsSync(parent) && parent !== resolve(root)) parent = resolve(parent, '..');
  const rel = relative(realpathSync(root), realpathSync(parent));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) delegationError('Task path escapes the project', 400);
}

/** One bounded run. Transport completion never implies task completion. */
export function createDelegation(state: TeamSnapshot, io: {
  changed(): void;
  send(from: MemberId, to: MemberId, text: string, requestId: string): string;
  interrupt(threadId: string, turnId: string): Promise<void>;
}) {
  if (!state.run) throw new Error('Delegation run required');
  const run = state.run;
  state.tasks = [];
  let activeId: string | undefined, turnId: string | undefined, live = true, halted = false;
  const requestBodies = new Map<string, string>();
  const receipts = new Map<string, { body: string; result: unknown }>();
  const touched = (task: DelegatedTask) => { task.updatedAt = new Date().toISOString(); io.changed(); };
  const active = () => state.tasks!.find(t => t.id === activeId);
  function release() {
    const t = active();
    if (t && !turnId && ['accepted', 'failed', 'cancelled'].includes(t.state)) activeId = undefined;
    pump();
  }
  function pump() {
    if (!live || halted || activeId || turnId || !run.goalMessageId || state.status !== 'running') return;
    const task = state.tasks!.find(t => t.state === 'queued');
    if (!task) return;
    activeId = task.id;
    task.workerThreadId = state.members.find(m => m.id === 'codex')?.sessionId;
    const payload = { task_id: task.id, attempt: task.attempt, title: task.title, goal: task.goal, context: task.context, files: task.files, acceptance: task.acceptance, access: task.access, workspace: run.workerCwd ?? run.cwd, revision: task.revisionReason };
    try { io.send('claude', 'codex', `Crew task. Call accept_task before working, then submit_task_result.\n${JSON.stringify(payload)}`, `task:${task.id}:${task.attempt}`); }
    catch (error) { task.state = 'delivery_unknown'; task.error = (error as Error).message; }
    touched(task);
  }
  function target(input: { task_id: string; attempt: 1 | 2 }) {
    const task = state.tasks!.find(t => t.id === input.task_id && t.runId === run.id);
    if (!task || task.attempt !== input.attempt) delegationError('Unknown task or stale attempt');
    return task;
  }
  function receipt(key: string, body: unknown, action: () => unknown) {
    const serialized = JSON.stringify(body), old = receipts.get(key);
    if (old) { if (old.body !== serialized) delegationError('Duplicate operation has different content'); return old.result; }
    const result = action(); receipts.set(key, { body: serialized, result }); return result;
  }
  function call(member: MemberId, name: string, body: unknown): unknown {
    if (!live || (halted && name !== 'submit_task_result') || !run.goalMessageId) delegationError('No active authorized goal');
    if (name === 'delegate_task') {
      if (member !== 'claude') delegationError('Only the leader can delegate', 403);
      const input = TaskInput.parse(body), serialized = JSON.stringify(input);
      const existing = state.tasks!.find(t => t.requestId === input.request_id);
      if (existing) { if (requestBodies.get(input.request_id) !== serialized) delegationError('Request ID reused with different content'); return { task_id: existing.id }; }
      if (state.tasks!.length >= 3) delegationError('This goal allows at most three delegated tasks');
      input.files.forEach(path => validateTaskPath(run.cwd, path));
      const at = new Date().toISOString();
      const task: DelegatedTask = { id: randomUUID(), requestId: input.request_id, runId: run.id, projectId: state.projectId, goalMessageId: run.goalMessageId, leader: 'claude', assignee: 'codex', title: input.title, goal: input.goal, context: input.context, files: input.files, acceptance: input.acceptance, access: run.access, state: 'queued', attempt: 1, createdAt: at, updatedAt: at, previousResults: [] };
      state.tasks!.push(task); requestBodies.set(input.request_id, serialized); touched(task); pump(); return { task_id: task.id };
    }
    if (name === 'accept_task') {
      if (member !== 'codex') delegationError('Only the worker can accept', 403);
      const input = z.object(Ref).strict().parse(body), task = target(input);
      return receipt(`accept:${task.id}:${task.attempt}`, input, () => {
        if (activeId !== task.id || task.state !== 'queued') delegationError('Task is not dispatched');
        task.state = 'running'; task.workerTurnId = turnId; touched(task); return { accepted: true };
      });
    }
    if (name === 'request_task_input') {
      if (member !== 'codex') delegationError('Only the worker can request task input', 403);
      const input = z.object({ ...Ref, question: z.string().trim().min(1).max(2000) }).strict().parse(body), task = target(input);
      if (task.state === 'needs_input' && task.question === input.question) return { accepted: true };
      if (task.state !== 'running') delegationError('Task is not running');
      task.state = 'needs_input'; task.question = input.question; touched(task);
      io.send('codex', 'claude', JSON.stringify({ event: 'task_input_requested', task_id: task.id, attempt: task.attempt, question: input.question }), `question:${task.id}:${task.attempt}:${randomUUID()}`);
      return { accepted: true };
    }
    if (name === 'submit_task_result') {
      if (member !== 'codex') delegationError('Only the worker can submit', 403);
      const input = z.object({ ...Ref, result: Result }).strict().parse(body), task = target(input);
      return receipt(`submit:${task.id}:${task.attempt}`, input, () => {
        for (const artifact of input.result.artifacts) {
          validateTaskPath(run.workerCwd ?? run.cwd, artifact.path);
          if (!task.files.includes(artifact.path)) delegationError('Result artifact is outside the assigned files', 400);
        }
        if (['cancel_requested', 'cancelled', 'delivery_unknown'].includes(task.state)) { (task.lateResults ??= []).push(input.result); touched(task); return { submitted: false, late: true }; }
        if (activeId !== task.id || task.state !== 'running') delegationError('Task is not running');
        task.result = input.result; task.state = 'submitted'; touched(task);
        io.send('codex', 'claude', JSON.stringify({ event: 'task_result_submitted', task_id: task.id, attempt: task.attempt, workspace: run.workerCwd ?? run.cwd, baseline: run.baselinePath, files: task.files, acceptance: task.acceptance, result: task.result }), `result:${task.id}:${task.attempt}`);
        return { submitted: true };
      });
    }
    if (name === 'review_task_result') {
      if (member !== 'claude') delegationError('Only the leader can review', 403);
      const input = z.object({ ...Ref, decision: z.enum(['accept', 'revise']), reason: z.string().trim().min(1).max(2000) }).strict().parse(body), task = target(input);
      return receipt(`review:${task.id}:${task.attempt}`, input, () => {
        if (task.state !== 'submitted') delegationError('Task has no submitted result');
        if (input.decision === 'revise' && task.attempt === 2) delegationError('One revision allowed; user input required');
        task.review = { decision: input.decision, reason: input.reason };
        if (input.decision === 'accept') task.state = 'accepted';
        else { task.revisionReason = input.reason; task.previousResults.push(task.result!); delete task.result; task.attempt = 2; task.state = 'queued'; }
        touched(task);
        if (!turnId) activeId = undefined;
        release(); return { reviewed: true };
      });
    }
    delegationError('Unknown delegation tool', 400);
  }
  return {
    call, pump,
    input(member: MemberId, taskId: string, attempt: 1 | 2) {
      if (member !== 'claude') delegationError('Only the leader can supply task input', 403);
      const task = target({ task_id: taskId, attempt });
      if (task.state !== 'needs_input') delegationError('Task is not waiting for input');
      task.state = 'running'; delete task.question; touched(task);
    },
    diff(thread: string, turn: string, value: string) { const task = active(); if (task && task.workerThreadId === thread && task.workerTurnId === turn) { task.diff = value.length > 65536 ? value.slice(0, 65536) + '\n[diff truncated; inspect workspace files]' : value; touched(task); } },
    turn(thread: string, id: string, status: string) {
      if (!live || thread !== state.members.find(m => m.id === 'codex')?.sessionId) return;
      if (status === 'inProgress') { turnId = id; const t = active(); if (t) { t.workerTurnId = id; if (t.state === 'cancel_requested') void io.interrupt(thread, id).catch(error => { t.state = 'delivery_unknown'; t.error = String(error); touched(t); }); } }
      else if (turnId === id) {
        turnId = undefined; const t = active();
        if (t?.state === 'cancel_requested') t.state = 'cancelled';
        else if (t && (status === 'failed' || status === 'interrupted')) { t.state = 'failed'; t.error = `Native turn ${status}`; }
        else if (t?.state === 'running' || (t?.state === 'queued' && t.review?.decision !== 'revise')) { t.state = 'failed'; t.error = 'Native turn ended without a task result'; }
        if (t) { if (t.state === 'queued' && t.review?.decision === 'revise') activeId = undefined; touched(t); }
        release();
      }
    },
    async cancel(taskId: string) {
      const task = state.tasks!.find(t => t.id === taskId);
      if (!task || ['accepted', 'failed', 'cancelled'].includes(task.state)) delegationError('Task cannot be cancelled');
      if (activeId !== task.id) { task.state = 'cancelled'; touched(task); return; }
      halted = true;
      if (!turnId && ['submitted', 'needs_input'].includes(task.state)) { task.state = 'cancelled'; activeId = undefined; touched(task); release(); return; }
      task.state = 'cancel_requested'; touched(task);
      if (!turnId) return; // Dispatched but not yet observed: wait for its native turn.
      try { await io.interrupt(task.workerThreadId!, turnId); }
      catch (error) { task.state = 'delivery_unknown'; task.error = (error as Error).message; touched(task); }
    },
    fault(message: string) { halted = true; const task = active(); if (task && !['accepted', 'cancelled'].includes(task.state)) { task.state = 'delivery_unknown'; task.error = message; touched(task); } },
    attention() { const task = active(); if (task && Date.now() - Date.parse(task.createdAt) >= 600000 && !task.needsAttention) { task.needsAttention = true; touched(task); } },
    close() { live = false; for (const task of state.tasks!) { if (task.state === 'queued' && task.id !== activeId) task.state = 'cancelled'; else if (!['accepted', 'failed', 'cancelled'].includes(task.state)) task.state = 'delivery_unknown'; } io.changed(); },
  };
}
