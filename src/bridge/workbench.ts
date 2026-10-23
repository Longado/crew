import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDelegation } from './delegation.ts';
import { realpathSync, statSync } from 'node:fs';
import { createNativeAdapter } from './native.ts';
import { createCodexTeamAdapter } from './codex-team-native.ts';
import type { MemberId, Sender, TeamAdapter, TeamMessage, TeamSnapshot, TeamRunOptions } from './types.ts';
export type { TeamSnapshot, TeamMessage } from './types.ts';
const now = () => new Date().toISOString();
function fail(text: string, status = 400): never { throw Object.assign(new Error(text), { status }); }
function validate(text: unknown, requestId: unknown) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8192) fail('Invalid message text');
  if (typeof requestId !== 'string' || !requestId || requestId.length > 100) fail('Invalid request ID');
}
export function createTeamWorkbench(options: { adapterFactory?: () => TeamAdapter } = {}) {
  const teams = new Map<string, TeamSnapshot>();
  const listeners = new Map<string, Set<(snapshot: TeamSnapshot) => void>>();
  let active: { projectId: string; adapter: TeamAdapter; shutdown: () => Promise<void>; live: boolean; stopping?: Promise<void> } | undefined;
  let closing = false;
  function team(projectId: string) {
    if (!teams.has(projectId)) teams.set(projectId, { projectId, status: 'idle', updatedAt: now(), messages: [], members: [
      { id: 'codex', name: 'Codex', provider: 'Codex App Server', role: '协作成员', connection: 'disconnected' },
      { id: 'claude', name: 'Claude', provider: 'Claude Code', role: '协作成员', connection: 'disconnected' },
    ] });
    return teams.get(projectId)!;
  }
  const snapshot = (projectId: string) => structuredClone(team(projectId));
  function emit(projectId: string) { team(projectId).updatedAt = now(); for (const listener of listeners.get(projectId) ?? []) { try { listener(snapshot(projectId)); } catch { /* subscriber cannot break routing */ } } }
  let enqueueUser: ((to: MemberId, text: string, requestId: string) => void) | undefined;
  let delegation: ReturnType<typeof createDelegation> | undefined;
  function current(projectId: string, runId: string) {
    const state = team(projectId);
    if (active?.projectId !== projectId || !active.live || !state.run || state.run.id !== runId) fail('Stale or inactive delegation run', 409);
    return state;
  }
  function shutdown(run: NonNullable<typeof active>) {
    if (!run.stopping) {
      run.live = false;
      run.stopping = Promise.resolve().then(() => run.shutdown());
    }
    return run.stopping;
  }
  async function start(projectId: string, config?: TeamRunOptions): Promise<TeamSnapshot> {
    if (closing) fail('Workbench is closed', 409);
    if (config) {
      if (!['delegation', 'codex-team'].includes(config.mode) || !['read-only', 'workspace-write'].includes(config.access) || !config.goal.trim() || config.goal.length > 4000 || !statSync(config.cwd).isDirectory()) fail('Invalid delegation configuration');
      config = { ...config, cwd: realpathSync(config.cwd), goal: config.goal.trim() };
    }
    if (active) {
      if (!active.live) fail('Team is stopping; wait before starting another run', 409);
      const existing = team(active.projectId).run;
      if (active.projectId !== projectId) fail('Another project already has an active team', 409);
      if ((!config && !existing) || (config && existing && config.mode === existing.mode && config.cwd === existing.cwd && config.goal === existing.goal && config.access === existing.access)) return snapshot(projectId);
      fail('Stop the active team before starting a different run', 409);
    }
    const state = team(projectId);
    state.members = [
      { id: 'codex', name: 'Codex', provider: 'Codex App Server', role: '协作成员', connection: 'disconnected' },
      { id: 'claude', name: 'Claude', provider: 'Claude Code', role: '协作成员', connection: 'disconnected' },
    ];
    delete state.agents; delete state.nativeTasks; delete state.inputs;
    state.run = config ? { ...config, id: randomUUID() } : undefined; state.tasks = config ? [] : undefined; state.approvals = config ? [] : undefined;
    for (const member of state.members) member.role = config ? member.id === 'claude' ? '任务负责人' : '执行者' : '协作成员';
    state.status = 'starting'; delete state.error; delete state.setup;
    state.messages = []; for (const member of state.members) { member.connection = 'connecting'; delete member.error; delete member.sessionId; }
    if (config?.mode === 'codex-team') {
      delegation = undefined; state.tasks = undefined; state.agents = []; state.nativeTasks = []; state.inputs = [];
      state.members = [{ id: 'codex', name: 'Codex', provider: 'Codex App Server', role: '任务负责人', connection: 'connecting' }];
      const adapter = (options.adapterFactory ?? createCodexTeamAdapter)();
      const run = { projectId, adapter, live: true, shutdown: async () => { run.live = false; await adapter.close(); } }; active = run;
      const requests = new Map<string, TeamMessage>();
      const changed = () => { if (run.live) emit(projectId); };
      enqueueUser = (to, text, requestId) => {
        validate(text, requestId); if (to !== 'codex') fail('Send Codex team input to the leader');
        if (state.status !== 'running') fail('Codex team is not ready', 409);
        const previous = requests.get(requestId); if (previous) { if (previous.text !== text) fail('Request ID reused with different content', 409); return; }
        const message: TeamMessage = { id: randomUUID(), from: 'user', to: 'codex', text, state: 'queued', createdAt: now() };
        requests.set(requestId, message); state.messages.push(message); changed();
        void adapter.deliver(message).then(() => { if (run.live) { message.state = 'transport_written'; changed(); } }).catch(error => { if (run.live) { message.state = 'delivery_unknown'; state.status = 'error'; state.error = String(error); changed(); } });
      };
      emit(projectId);
      try {
        const result = await adapter.start({ url: '', tokens: { codex: '', claude: '' }, run: state.run,
          onWorkspace(cwd, baselinePath) { if (run.live && state.run) { state.run.workerCwd = cwd; state.run.baselinePath = baselinePath; changed(); } },
          onNativeState(agents, tasks) { if (run.live) { state.agents = agents; state.nativeTasks = tasks; changed(); } },
          onMember(id, patch) { if (!run.live || id !== 'codex') return; Object.assign(state.members[0]!, patch); if (state.status !== 'error') state.status = patch.connection === 'ready' ? 'running' : patch.connection === 'disconnected' || patch.connection === 'error' ? 'error' : state.status; changed(); },
          onFault(error) { if (run.live) { state.status = 'error'; state.error = error; changed(); } },
          onInput(input) { if (run.live) { state.inputs!.push(input); changed(); } },
          onInputResolved(requestId) { const input = state.inputs?.find(i => i.requestId === requestId); if (run.live && input) { input.state = 'resolved'; changed(); } },
          onApproval(approval) { if (run.live) { state.approvals!.push(approval); changed(); } },
          onApprovalResolved(requestId) { const a = state.approvals?.find(a => a.requestId === requestId); if (run.live && a) { a.state = 'resolved'; changed(); } },
          onOutput(text, id) { if (run.live && text.trim() && !state.messages.some(m => m.id === id)) { state.messages.push({ id, from: 'codex', to: 'user', text: text.slice(0, 8192), state: 'transport_written', createdAt: now() }); changed(); } },
        });
        if (run.live) { state.setup = result.setup; if (snapshot(projectId).status === 'running') { enqueueUser('codex', state.run!.goal, `goal:${state.run!.id}`); state.run!.goalMessageId = requests.get(`goal:${state.run!.id}`)!.id; } changed(); }
      } catch (error) { if (run.live) { state.status = 'error'; state.error = String(error); await shutdown(run); if (active === run) { state.members[0]!.connection = 'disconnected'; active = undefined; enqueueUser = undefined; emit(projectId); } } }
      return snapshot(projectId);
    }
    const adapter = (options.adapterFactory ?? createNativeAdapter)();
    const tokens: Record<MemberId, string> = { codex: randomBytes(32).toString('hex'), claude: randomBytes(32).toString('hex') };
    const inflight = new Set<string>();
    const streams = new Map<MemberId, ServerResponse>(); const requests = new Map<string, TeamMessage>();
    const run = { projectId, adapter, live: true, shutdown: async () => {} }; active = run;
    function changed() { if (run.live) emit(projectId); }
    function connected(id: MemberId, connection: TeamSnapshot['members'][number]['connection']) { if (!run.live) return; const member = state.members.find(m => m.id === id)!; member.connection = connection; member.lastActivityAt = now(); if (state.status !== 'error' && state.members.every(m => m.connection === 'ready')) state.status = 'running'; else if (state.status === 'running') state.status = 'starting'; if (state.status === 'running' && state.run && !state.run.goalMessageId) {
        const goal = enqueue('user', 'claude', `本次用户目标（权限 ${state.run.access}，项目 ${state.run.cwd}，执行目录 ${state.run.workerCwd ?? state.run.cwd}）：\n${state.run.goal}`, `goal:${state.run.id}`, null, true);
        state.run.goalMessageId = goal.id;
      }
      delegation?.pump(); changed(); }
    function deliver(message: TeamMessage) {
      if (!run.live || message.state !== 'queued' || inflight.has(message.id)) return;
      if (message.to === 'user') { message.state = 'transport_written'; changed(); return; }
      if (state.members.find(m => m.id === message.to)?.connection !== 'ready') return;
      if (message.to === 'claude') { const stream = streams.get('claude'); if (!stream) return; stream.write(`data: ${JSON.stringify(message)}\n\n`); message.state = 'transport_written'; changed(); }
      else { inflight.add(message.id); void adapter.deliver({ ...message }).then(() => { if (run.live && message.state === 'queued') { message.state = 'transport_written'; changed(); } }).catch(() => { if (run.live && message.state !== 'replied') { message.state = 'delivery_unknown'; delegation?.fault('Worker message delivery could not be confirmed'); changed(); } }).finally(() => inflight.delete(message.id)); }
    }
    function enqueue(from: Sender, to: Sender, text: string, requestId: string, inReplyTo: string | null = null, internal = false) {
      if (!run.live) fail('Team stopped', 409);
      if (internal) { if (!text.trim() || text.length > 262144) fail('Invalid task event'); validate('task', requestId); } else validate(text, requestId);
      const key = `${from}:${requestId}`; const existing = requests.get(key);
      if (existing) { if (existing.to !== to || existing.text !== text || existing.inReplyTo !== inReplyTo) fail('Request ID reused with different content', 409); return existing; }
      const message: TeamMessage = { id: randomUUID(), from, to, text, inReplyTo, state: 'queued', createdAt: now() };
      requests.set(key, message); state.messages.push(message);
      if (from !== 'user') state.members.find(member => member.id === from)!.lastActivityAt = message.createdAt;
      changed(); deliver(message); return message;
    }
    delegation = state.run ? createDelegation(state, { changed, send(from, to, text, requestId) { return enqueue(from, to, text, requestId, null, true).id; }, async interrupt(threadId, turnId) { if (!adapter.interrupt) fail('Adapter does not support interrupt', 503); await adapter.interrupt(threadId, turnId); } }) : undefined;
    const attentionTimer = setInterval(() => delegation?.attention(), 30000); attentionTimer.unref();
    enqueueUser = (to, text, requestId) => { if (state.run && to !== 'claude') fail('Send delegation input to the leader', 400); if (!['codex', 'claude'].includes(to)) fail('Invalid recipient'); enqueue('user', to, text, requestId); };
    const server = createServer(async (req, res) => {
      const respond = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const principal = (Object.keys(tokens) as MemberId[]).find(id => req.headers.authorization === `Bearer ${tokens[id]}`);
      if (!principal || !run.live) return respond(401, { error: 'Invalid connection identity' });
      if (req.method === 'GET' && req.url === '/alive') return respond(200, { alive: true });
      if (req.method === 'GET' && req.url === '/events') {
        if (streams.has(principal)) return respond(409, { error: 'Already connected' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': connected\n\n'); streams.set(principal, res); connected(principal, 'connected');
        res.on('close', () => { if (streams.get(principal) === res) { streams.delete(principal); delegation?.fault(`${principal} channel disconnected`); if (state.run) { state.status = 'error'; state.error = `${principal} channel disconnected; stop and restart the team after checking current artifacts`; } connected(principal, 'disconnected'); for (const m of state.messages) if (m.to === principal && m.state === 'transport_written') m.state = 'delivery_unknown'; changed(); } }); return;
      }
      if (req.method !== 'POST') return respond(404, { error: 'Not found' });
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1048576) fail('Request too large'); }
        const body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body) || 'from' in body || 'sender' in body) fail('Invalid request identity');
        if (!run.live) fail('Team stopped', 409);
        if (req.url === '/ready') { if (!streams.has(principal)) fail('Connection is not established', 409); connected(principal, 'ready'); for (const m of state.messages) if (m.to === principal) deliver(m); return respond(200, { ready: true }); }
        if (delegation && ['/delegate_task', '/accept_task', '/request_task_input', '/submit_task_result', '/review_task_result'].includes(req.url ?? '')) return respond(200, delegation.call(principal, req.url!.slice(1), body));
        let message: TeamMessage;
        if (req.url === '/send') { if (!['codex', 'claude'].includes(body.to) || body.to === principal) fail('Invalid recipient'); validate(body.text, body.request_id);
          if (requests.has(`${principal}:${body.request_id}`)) { const previous = requests.get(`${principal}:${body.request_id}`)!; if (previous.to !== body.to || previous.text !== body.text || previous.inReplyTo != null) fail('Request ID reused with different content', 409); return respond(202, { message_id: previous.id, accepted: true }); }
          if (body.task_id !== undefined) { if (!delegation || body.to !== 'codex') fail('Invalid task input'); delegation.input(principal, body.task_id, body.attempt); }
          else if (state.run && body.to === 'codex') fail('Use delegate_task or task-bound input for the worker');
          message = enqueue(principal, body.to, body.text, body.request_id); }
        else if (req.url === '/reply') { const original = state.messages.find(m => m.id === body.message_id); if (!original || original.to !== principal) fail('Message does not belong to this connection'); if (state.run && original.from === 'codex') fail('Use task-bound input or review_task_result for the worker'); message = enqueue(principal, original.from, body.text, `reply:${original.id}`, original.id); original.state = 'replied'; changed(); }
        else return respond(404, { error: 'Not found' });
        respond(202, { message_id: message.id, accepted: true });
      } catch (error) { respond((error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
    });
    run.shutdown = async () => { delegation?.close(); clearInterval(attentionTimer); run.live = false; for (const m of state.messages) if (inflight.has(m.id) && m.state === 'queued') m.state = 'delivery_unknown'; for (const stream of streams.values()) stream.end(); server.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), adapter.close()]); };
    emit(projectId);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bridge listener unavailable');
      const result = await adapter.start({ url: `http://127.0.0.1:${address.port}`, tokens, run: state.run,
        onWorkspace(cwd, baselinePath) { if (run.live && state.run) { state.run.workerCwd = cwd; state.run.baselinePath = baselinePath; changed(); } },
        onDiff(threadId, turnId, diff) { if (run.live) delegation?.diff(threadId, turnId, diff); },
        onTurn(threadId, turnId, status) { if (run.live) delegation?.turn(threadId, turnId, status); },
        onFault(message) { if (run.live) { delegation?.fault(message); if (state.run) state.status = 'error'; state.error = message; changed(); } },
        onApproval(approval) { if (run.live && state.approvals) { state.approvals.push(approval); changed(); } },
        onApprovalResolved(requestId) { const approval = state.approvals?.find(a => a.requestId === requestId); if (run.live && approval) { approval.state = 'resolved'; changed(); } },
        onMember(id, patch) { if (!run.live) return; Object.assign(state.members.find(m => m.id === id)!, patch); if (patch.connection) { connected(id, patch.connection); if (patch.connection === 'disconnected' || patch.connection === 'error') { delegation?.fault(`${id} disconnected`); for (const m of state.messages) if (m.to === id && (m.state === 'transport_written' || inflight.has(m.id)) && m.state !== 'replied') m.state = 'delivery_unknown'; } } changed(); },
        onOutput(text, itemId) { if (run.live && text.trim()) enqueue('codex', 'user', text.slice(0, 8192), `output:${itemId}`); },
      });
      if (run.live) { state.setup = result.setup; changed(); }
    } catch (error) { if (run.live) { state.status = 'error'; state.error = (error as Error).message; await shutdown(run); if (active === run) { for (const member of state.members) member.connection = 'disconnected'; active = undefined; enqueueUser = undefined; emit(projectId); } } }
    return snapshot(projectId);
  }
  async function stop(projectId: string, expectedRunId?: string) {
    const state = team(projectId);
    if (expectedRunId !== undefined && state.run?.id !== expectedRunId) fail('Stale or inactive team run', 409);
    if (active?.projectId === projectId) {
      const run = active, stateRun = state.run;
      await shutdown(run);
      if (state.run !== stateRun || (active?.projectId === projectId && active !== run)) return snapshot(projectId);
      if (active === run) { active = undefined; enqueueUser = undefined; }
      else if (state.status === 'stopped') return snapshot(projectId);
    } else if (state.status === 'stopped') return snapshot(projectId);
    for (const a of state.agents || []) if (!['completed', 'closed', 'interrupted', 'failed'].includes(a.state)) { a.state = 'unknown'; a.step = '团队已停止；保留成果待核对'; a.turnId = undefined; }
    state.status = 'stopped'; delete state.setup; for (const member of state.members) member.connection = 'disconnected'; for (const m of state.messages) { if (m.state === 'queued') m.state = 'failed'; else if (m.state === 'transport_written' && m.to !== 'user') m.state = 'delivery_unknown'; } emit(projectId); return snapshot(projectId);
  }
  return { snapshot, start, stop, async cancel(projectId: string, runId: string, taskId: string) { current(projectId, runId); if (!delegation) fail('Use native member interruption for Codex teams'); await delegation.cancel(taskId); return snapshot(projectId); },
    async answer(projectId: string, runId: string, inputId: string, answers: Record<string, string>) {
      const state = current(projectId, runId), input = state.inputs?.find(i => i.id === inputId);
      if (state.status !== 'running' || !input || input.state !== 'pending' || !active!.adapter.answer) fail('Stale or unavailable input request', 409);
      await active!.adapter.answer(input, answers); input.state = 'resolved'; emit(projectId); return snapshot(projectId);
    },
    async agentMessage(projectId: string, runId: string, threadId: string, text: string, requestId: string) {
      const state = current(projectId, runId); validate(text, requestId);
      if (state.run?.mode !== 'codex-team' || state.status !== 'running' || !state.agents?.some(a => a.threadId === threadId) || !active!.adapter.steer) fail('Inactive or unknown native member', 409);
      const id = `human:${runId}:${requestId}`, existing = state.messages.find(m => m.id === id);
      const labelled = `[${threadId}] ${text}`;
      if (existing) { if (existing.text !== labelled) fail('Request ID reused with different content', 409); return snapshot(projectId); }
      const message: TeamMessage = { id, from: 'user', to: 'codex', text: labelled, state: 'queued', createdAt: now() }; state.messages.push(message); emit(projectId);
      try { await active!.adapter.steer(threadId, text); message.state = 'transport_written'; } catch (error) { message.state = 'delivery_unknown'; state.error = String(error); emit(projectId); throw error; }
      emit(projectId); return snapshot(projectId);
    },
    async agentInterrupt(projectId: string, runId: string, threadId: string, turnId: string) {
      const state = current(projectId, runId), member = state.agents?.find(a => a.threadId === threadId);
      if (state.run?.mode !== 'codex-team' || state.status !== 'running' || !member || !turnId || member.turnId !== turnId || !active!.adapter.interrupt) fail('Stale or unavailable native turn', 409);
      await active!.adapter.interrupt(threadId, turnId); return snapshot(projectId);
    },
    async approve(projectId: string, runId: string, approvalId: string, decision: 'accept' | 'decline' | 'cancel') {
      const state = current(projectId, runId), approval = state.approvals?.find(a => a.id === approvalId);
      if (state.run?.mode === 'codex-team' && state.status !== 'running') fail('Codex team is not active', 409);
      if (!approval || approval.state !== 'pending') fail('Approval is no longer pending', 409);
      if (!['accept', 'decline', 'cancel'].includes(decision)) fail('Invalid approval decision');
      if (!active!.adapter.approve) fail('Adapter does not support approval', 503);
      approval.state = 'resolved'; approval.decision = decision; emit(projectId);
      try { await active!.adapter.approve(approval, decision); } catch (error) { delegation?.fault('Approval delivery unknown'); state.error = (error as Error).message; emit(projectId); throw error; }
      return snapshot(projectId);
    }, async send(projectId: string, input: { to: MemberId; text: string; requestId: string; runId?: string }) { if (active?.projectId !== projectId || !active.live || !enqueueUser) fail('Team is not active', 409); if (team(projectId).run) current(projectId, input.runId ?? ''); enqueueUser(input.to, input.text, input.requestId); return snapshot(projectId); }, subscribe(projectId: string, listener: (snapshot: TeamSnapshot) => void) { if (!listeners.has(projectId)) listeners.set(projectId, new Set()); listeners.get(projectId)!.add(listener); return () => { listeners.get(projectId)?.delete(listener); }; }, async close() { closing = true; if (active) await stop(active.projectId); listeners.clear(); } };
}
export type TeamWorkbench = ReturnType<typeof createTeamWorkbench>;
