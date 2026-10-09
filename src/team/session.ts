import { randomUUID } from 'node:crypto';
import { createTeamWorkbench, type TeamWorkbench } from '../bridge/workbench.ts';
import type { TeamSnapshot, TeamRunOptions, TeamApproval, TeamInput } from '../bridge/types.ts';

export interface TeamSessionOptions extends Omit<TeamRunOptions, 'goal'> { goal?: string; workbench?: TeamWorkbench; demo?: boolean }
type Bound<T> = { runId: string; value: T };
export const TEAM_HELP = [
  '输入目标开始；运行后直接输入消息。Tab 切换成员，F2 查看详情，PgUp/PgDn 翻阅。',
  '/start [目标]  启动或重试   /stop  停止团队   /quit  停止并退出',
  '/member M1  选择成员   /details  展开或收起成果和变更',
  '/approve A1 y|n|c  允许本次 / 拒绝本次 / 拒绝并中断',
  '/answer Q1  回答提问   /cancel  取消填写   /interrupt  中断所选成员',
].join('\n');

/** Frontend controller over the same workbench as the web UI; no shell commands. */
export function createTeamSession(options: TeamSessionOptions) {
  const wb = options.workbench ?? createTeamWorkbench(), projectId = `cli:${options.cwd}`;
  let snapshot = wb.snapshot(projectId), selected = '', detail = false, busy = false, closed = false;
  let goal = options.goal?.trim() || '', notice = '输入目标后开始。/help 查看操作。';
  let shutdown: Promise<void> | undefined;
  let interruption: { runId: string; threadId?: string; turnId?: string; taskId?: string } | undefined;
  let answering: { bound: Bound<TeamInput>; index: number; answers: Record<string, string> } | undefined;
  const listeners = new Set<() => void>(), memberSlots = new Map<string, string>();
  const approvalSlots = new Map<string, Bound<TeamApproval>>(), inputSlots = new Map<string, Bound<TeamInput>>();
  const attempts = new Map<string, string>();
  const emit = () => { for (const listener of listeners) listener(); };
  const agents = () => (snapshot.run?.mode || options.mode) === 'codex-team' ? (snapshot.agents || []).map(a => ({ id: a.threadId, name: a.name, state: a.state, turnId: a.turnId }))
    : snapshot.members.map(m => ({ id: m.id, name: m.name, state: m.connection, turnId: undefined }));
  function update(next: TeamSnapshot) {
    snapshot = next;
    if (interruption) {
      if (interruption.runId !== next.run?.id) interruption = undefined;
      else if (interruption.threadId) {
        const a = next.agents?.find(a => a.threadId === interruption!.threadId);
        if (a && !a.turnId && a.lastTurnId === interruption.turnId && ['interrupted', 'completed', 'failed'].includes(a.state)) {
          notice = a.state === 'interrupted' ? '成员已中断，保留成果待核对。' : a.state === 'completed' ? '成员本轮已完成，请核对成果。' : '成员本轮执行失败，请核对记录。'; interruption = undefined;
        }
      } else if (next.tasks?.some(t => t.id === interruption!.taskId && t.state === 'cancelled')) { notice = '委派任务已取消，保留成果待核对。'; interruption = undefined; }
    }
    for (const a of agents()) if (![...memberSlots.values()].includes(a.id)) memberSlots.set(`M${memberSlots.size + 1}`, a.id);
    if (!agents().some(a => a.id === selected)) selected = agents()[0]?.id || '';
    for (const a of next.approvals || []) {
      const key = [...approvalSlots].find(([, b]) => b.runId === next.run?.id && b.value.id === a.id)?.[0] || `A${approvalSlots.size + 1}`;
      approvalSlots.set(key, { runId: next.run!.id, value: a });
    }
    for (const q of next.inputs || []) {
      const key = [...inputSlots].find(([, b]) => b.runId === next.run?.id && b.value.id === q.id)?.[0] || `Q${inputSlots.size + 1}`;
      inputSlots.set(key, { runId: next.run!.id, value: q });
    }
    if (answering && (next.run?.id !== answering.bound.runId || next.status !== 'running' || !next.inputs?.some(q => q.id === answering!.bound.value.id && q.state === 'pending'))) {
      answering = undefined; notice = '原提问已结束，停止填写。';
    }
    emit();
  }
  const unsubscribe = wb.subscribe(projectId, update);
  function current<T extends { state: string }>(bound: Bound<T> | undefined): Bound<T> {
    if (!bound || bound.runId !== snapshot.run?.id || bound.value.state !== 'pending' || snapshot.status !== 'running') throw new Error('请求已结束或团队不可操作，请核对当前状态。');
    return bound;
  }
  function view() {
    const member = agents().find(a => a.id === selected), question = answering?.bound.value.questions[answering.index];
    const isGoal = ['idle', 'stopped'].includes(snapshot.status);
    return { snapshot, selected, detail, busy, notice, demo: !!options.demo,
      members: agents().map(a => ({ ...a, slot: [...memberSlots].find(([, id]) => id === a.id)![0] })),
      approvals: [...approvalSlots].filter(([, b]) => b.runId === snapshot.run?.id && b.value.state === 'pending').map(([slot, b]) => ({ slot, ...b.value })),
      inputs: [...inputSlots].filter(([, b]) => b.runId === snapshot.run?.id && b.value.state === 'pending').map(([slot, b]) => ({ slot, ...b.value })),
      prompt: question ? { key: `answer:${answering!.bound.runId}:${answering!.bound.value.id}:${question.id}`, label: `${question.header} › `, secret: !!question.isSecret, question }
        : { key: isGoal ? 'goal' : `message:${snapshot.run?.id || ''}:${selected}`, label: isGoal ? '目标 › ' : snapshot.status !== 'running' ? '命令 › ' : options.mode === 'delegation' ? 'Claude 负责人 › ' : `${member?.name || '负责人'} › `, secret: false, question: undefined },
    };
  }
  async function start(nextGoal = goal) {
    if (!nextGoal.trim()) throw new Error('请输入本次目标。');
    if (['starting', 'running'].includes(snapshot.status)) throw new Error('团队正在运行；先 /stop，再启动新的目标。');
    if (snapshot.status === 'error') await wb.stop(projectId);
    goal = nextGoal.trim(); notice = '正在启动专用团队…'; emit();
    update(await wb.start(projectId, { cwd: options.cwd, mode: options.mode, access: options.access, goal }));
    if (snapshot.status === 'error') throw new Error(snapshot.error || '启动未成功。');
    notice = '团队已启动，输入消息可补充信息。';
  }
  function choose(id: string) {
    if (answering) { notice = '正在回答提问；完成后切换，或 /cancel 取消填写。'; emit(); return; }
    selected = memberSlots.get(id.toUpperCase()) || id;
    if (!agents().some(a => a.id === selected)) selected = agents()[0]?.id || '';
    emit();
  }
  async function submit(line: string): Promise<boolean> {
    if (closed || busy) return false;
    const text = line.trim(); if (!text) return false;
    if (text === '/cancel') { answering = undefined; notice = '已取消填写，原请求仍待回答。'; emit(); return true; }
    if (text === '/quit') { try { await close(); return true; } catch (error) { notice = `关闭未完成：${(error as Error).message}`; emit(); return false; } }
    busy = true; emit();
    try {
      if (answering && !/^\/(?:help|stop|interrupt)(?:\s|$)/.test(text)) {
        const bound = current(inputSlots.get([...inputSlots].find(([, b]) => b.runId === answering!.bound.runId && b.value.id === answering!.bound.value.id)![0]));
        const question = bound.value.questions[answering.index]!;
        const choice = /^\d+$/.test(text) ? question.options?.[Number(text) - 1] : undefined;
        answering.answers[question.id] = choice?.label || (text.startsWith('//') ? text.slice(1) : text);
        answering.index++;
        if (answering.index === bound.value.questions.length) {
          const answers = answering.answers; answering = undefined;
          update(await wb.answer(projectId, bound.runId, bound.value.id, answers)); notice = '回答已提交给原提问。';
        }
      } else if (text.startsWith('/') && !text.startsWith('//')) {
        const [, command, rest = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)!;
        if (command === '/help') notice = TEAM_HELP;
        else if (command === '/start') await start(rest || goal);
        else if (command === '/stop') { update(await wb.stop(projectId)); notice = '团队已停止，记录和隔离成果保留。'; }
        else if (command === '/details') detail = !detail;
        else if (command === '/member') choose(rest);
        else if (command === '/approve') {
          const [slot, decision, extra] = rest.split(/\s+/), bound = current(approvalSlots.get(slot?.toUpperCase() || ''));
          const decisions = { y: 'accept', n: 'decline', c: 'cancel' } as const;
          if (extra || !Object.hasOwn(decisions, decision || '')) throw new Error('用法：/approve A1 y|n|c（允许 / 拒绝 / 拒绝并中断）。');
          update(await wb.approve(projectId, bound.runId, bound.value.id, decisions[decision as keyof typeof decisions])); notice = '审批决定已提交。';
        } else if (command === '/answer') {
          const bound = current(inputSlots.get(rest.toUpperCase()));
          if (!bound.value.questions.length) throw new Error('原提问没有可回答的问题。');
          if (agents().some(a => a.id === bound.value.threadId)) selected = bound.value.threadId;
          answering = { bound, index: 0, answers: Object.create(null) }; notice = '逐项输入回答；选项可输入编号，/cancel 取消填写。';
        } else if (command === '/interrupt') {
          if (!snapshot.run || snapshot.status !== 'running') throw new Error('没有可中断的运行。');
          notice = '已请求中断，等待原生执行结束确认。';
          if (snapshot.run.mode === 'codex-team') {
            const a = snapshot.agents?.find(a => a.threadId === selected);
            if (!a?.turnId) throw new Error('所选成员没有活动中的执行。');
            interruption = { runId: snapshot.run.id, threadId: a.threadId, turnId: a.turnId };
            update(await wb.agentInterrupt(projectId, snapshot.run.id, a.threadId, a.turnId));
          } else {
            if (selected !== 'codex') throw new Error('选择 Codex 执行者后中断委派；/stop 可停止整个团队。');
            const task = snapshot.tasks?.find(t => t.assignee === 'codex' && ['running', 'needs_input', 'submitted'].includes(t.state));
            if (!task) throw new Error('没有活动中的委派任务。');
            interruption = { runId: snapshot.run.id, taskId: task.id };
            update(await wb.cancel(projectId, snapshot.run.id, task.id));
          }
        } else throw new Error('未知操作。/help 查看命令；消息以 / 开头时请写成 //。');
      } else if (['idle', 'stopped'].includes(snapshot.status)) await start(text);
      else {
        if (snapshot.status !== 'running' || !snapshot.run) throw new Error('团队尚未就绪。/start 重试，或 /quit 退出。');
        const message = text.startsWith('//') ? text.slice(1) : text;
        const key = JSON.stringify([snapshot.run.id, selected, message]), requestId = attempts.get(key) || randomUUID(); attempts.set(key, requestId);
        if (snapshot.run.mode === 'codex-team' && selected) update(await wb.agentMessage(projectId, snapshot.run.id, selected, message, requestId));
        else update(await wb.send(projectId, { to: 'claude', runId: snapshot.run.id, text: message, requestId }));
        attempts.delete(key); notice = '消息已提交，请以成员实际回应判断。';
      }
      return true;
    } catch (error) { notice = `操作未完成：${(error as Error).message}`; return false; }
    finally { busy = false; emit(); }
  }
  function close(): Promise<void> {
    if (shutdown) return shutdown;
    closed = true; answering = undefined; unsubscribe();
    shutdown = (async () => { try { await wb.close(); } finally { emit(); } })();
    return shutdown;
  }
  update(snapshot);
  return { view, submit, start: () => submit(`/start${goal ? ` ${goal}` : ''}`), choose,
    cycle(delta = 1) { const list = agents(), index = list.findIndex(a => a.id === selected); if (list.length) choose(list[(index + delta + list.length) % list.length]!.id); },
    details() { detail = !detail; emit(); }, close, get closed() { return closed; },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
export type TeamSession = ReturnType<typeof createTeamSession>;
export type TeamView = ReturnType<TeamSession['view']>;
