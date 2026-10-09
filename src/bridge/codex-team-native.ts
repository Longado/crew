import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isolateProject, workerSandboxConfig, verifyDelegationThread } from './delegation-native.ts';
import { subscriptionEnv, checkCodexSubscription } from './subscription.ts';
import { createCodexTeamProtocol, codexTeamInstructions, codexTeamTools } from './codex-team.ts';
import { redact } from '../redact.ts';
import { stripVTControlCharacters } from 'node:util';
import type { AdapterContext, TeamAdapter } from './types.ts';
const exec = promisify(execFile);

/** Dedicated native Codex session tree; no Claude launcher or bridge listener. */
export function createCodexTeamAdapter(): TeamAdapter {
  let child: ChildProcessWithoutNullStreams | undefined, protocol: ReturnType<typeof createCodexTeamProtocol> | undefined, ctx: AdapterContext | undefined;
  let root = '', next = 1, stopped = false, halted = false, stderr = '';
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const attached = new Map<string, Promise<void>>();
  function send(message: unknown) { if (stopped || !child?.stdin.writable) throw new Error('Codex connection unavailable'); child.stdin.write(`${JSON.stringify(message)}\n`); }
  function request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); fault(`Codex request timed out: ${method}`); }, 30000);
      pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } });
      try { send({ id, method, params }); } catch (error) { pending.get(id)!.reject(error as Error); pending.delete(id); }
    });
  }
  function fault(message: string) { if (stopped || halted) return; halted = true; protocol?.fault(message); if (!protocol) ctx?.onFault?.(message); }
  async function verified(threadId: string) { await attached.get(threadId); if (stopped || halted || !protocol?.owns(threadId)) throw new Error('Inactive or unknown Codex member'); }
  return {
    async start(context) {
      ctx = context; if (ctx.run?.mode !== 'codex-team') throw new Error('Codex team run required');
      const run = ctx.run, env = subscriptionEnv(), directory = await mkdtemp(join(tmpdir(), 'crew-codex-team-')); await chmod(directory, 0o700);
      const isolated = run.access === 'workspace-write' ? await isolateProject(run.cwd) : undefined;
      const cwd = isolated?.cwd ?? run.cwd; run.workerCwd = cwd; ctx.onWorkspace?.(cwd, isolated?.baseline);
      const listed = JSON.parse((await exec('codex', ['mcp', 'list', '--json'], { cwd: directory, env, timeout: 15000 })).stdout) as { name: string; transport: { type: string; command?: string; url?: string } }[];
      const mcp = Object.fromEntries(listed.map(s => [s.name, { enabled: false, ...(s.transport.type === 'stdio' ? { command: s.transport.command } : { url: s.transport.url }) }]));
      const config = { ...workerSandboxConfig, features: { shell_tool: true, multi_agent: true, apps: false, plugins: false }, agents: { enabled: true, max_concurrent_threads_per_session: 3, max_threads: 3, max_depth: 1 }, web_search: 'disabled', mcp_servers: mcp };
      const policy = { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: run.access, modelProvider: 'openai', config };
      const args = ['app-server', ...listed.flatMap(s => ['-c', `mcp_servers.${s.name}.enabled=false`, '-c', `mcp_servers.${s.name}.${s.transport.type === 'stdio' ? 'command' : 'url'}=${JSON.stringify(s.transport.command ?? s.transport.url)}`]), '-c', 'features.multi_agent=true', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"'];
      if (stopped) throw new Error('Team stopped');
      child = spawn('codex', args, { cwd: directory, env, stdio: 'pipe' });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr = (stderr + text).slice(-4096); });
      protocol = createCodexTeamProtocol({ ...ctx, onFault(message) {
        halted = true; ctx!.onFault?.(message);
        for (const id of [root, ...attached.keys()]) { const turnId = protocol?.turn(id); if (turnId) void request('turn/interrupt', { threadId: id, turnId }).catch(() => {}); }
      } }, { send, response(message) { const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); } }, attach(threadId) {
        if (attached.has(threadId) || stopped || halted) return;
        // Resume subscribes this client to the owned child, applying the same policy.
        const promise = request('thread/resume', { ...policy, threadId }).then(created => {
          verifyDelegationThread(run, cwd, created);
          if (created.thread.parentThreadId !== root) throw new Error('Nested or unrelated agent outside this team');
          protocol!.handle({ method: 'thread/started', params: { thread: created.thread } });
          for (const turn of created.thread.turns ?? []) if (turn.status === 'inProgress') protocol!.handle({ method: 'turn/started', params: { threadId, turn } });
        }).catch(error => { fault(`Cannot observe Codex member: ${error}`); throw error; });
        attached.set(threadId, promise); void promise.catch(() => {});
      } });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { try { protocol!.handle(JSON.parse(line)); } catch (error) { fault(`Invalid Codex event: ${error}`); } });
      const disconnected = (reason: string) => {
        const detail = redact(stripVTControlCharacters(stderr)).replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏的凭证]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
        const message = `Codex App Server disconnected (${reason})${detail ? `: ${detail}` : ''}`;
        fault(message); if (!stopped) ctx!.onMember('codex', { connection: 'disconnected', error: message });
        for (const waiter of pending.values()) waiter.reject(new Error(message)); pending.clear();
      };
      child.on('error', error => disconnected(error.message)); child.on('close', (code, signal) => disconnected(signal || `exit ${code}`)); child.stdin.on('error', error => disconnected(error.message));
      await request('initialize', { clientInfo: { name: 'crew-codex-team', version: '0.1.0' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized' });
      const authLabel = checkCodexSubscription(await request('account/read', { refreshToken: false }));
      const created = await request('thread/start', { ...policy, dynamicTools: codexTeamTools, developerInstructions: `${codexTeamInstructions}\n源项目：${run.cwd}\n执行目录：${cwd}\n基线记录：${isolated?.baseline ?? '只读，无副本'}\n本轮权限：${run.access}` });
      verifyDelegationThread(run, cwd, created); root = created.thread.id; protocol.leader(root);
      ctx.onMember('codex', { connection: 'ready', sessionId: root, authLabel });
      return { setup: { command: '', instructions: 'Codex 负责人和原生成员已绑定本次专用会话。可在底部团队条查看成员、发送补充信息或中断成员。' } };
    },
    async deliver(message) { await this.steer!(root, message.text); },
    async steer(threadId, text) {
      await verified(threadId); const turnId = protocol!.turn(threadId);
      const input = [{ type: 'text', text: `Human input for this Crew run. Keep the existing goal, file ownership, sandbox and acceptance boundaries unless explicitly changed by the human:\n${text}` }];
      if (turnId) await request('turn/steer', { threadId, expectedTurnId: turnId, input });
      else await request('turn/start', { threadId, input });
    },
    async interrupt(threadId, turnId) { await verified(threadId); protocol!.interruptRequested(threadId, turnId); await request('turn/interrupt', { threadId, turnId }); },
    async answer(input, answers) { await verified(input.threadId); protocol!.answer(input, answers); },
    async approve(approval, decision) { await verified(approval.threadId); protocol!.approve(approval, decision); },
    async close() {
      if (stopped) return; stopped = true;
      for (const waiter of pending.values()) waiter.reject(new Error('Team stopped')); pending.clear();
      child?.stdin.end(); child?.kill('SIGTERM'); const owned = child;
      setTimeout(() => { if (owned && owned.exitCode === null && !owned.signalCode) owned.kill('SIGKILL'); }, 1500).unref();
    },
  };
}
