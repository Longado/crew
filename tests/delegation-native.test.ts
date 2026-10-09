import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeProtocol, delegationSettings, isolateProject, workerSandboxConfig, verifyDelegationThread } from '../src/bridge/delegation-native.ts';
import type { AdapterContext, TeamApproval, TeamRunOptions } from '../src/bridge/types.ts';

const run: TeamRunOptions = { mode: 'delegation', cwd: '/project', access: 'read-only', goal: 'Check' };
function fixture() {
  const approvals: TeamApproval[] = [], responses: unknown[] = [], sent: any[] = [], turns: string[] = [], faults: string[] = [], interrupts: string[] = [], resolved: (string | number)[] = [], diffs: string[] = [], output: string[] = [];
  const ctx: AdapterContext = { url: '', tokens: { codex: '', claude: '' }, run: { ...run, id: 'run' }, onMember() {}, onOutput(text) { output.push(text); }, onApproval(a) { approvals.push(a); }, onTurn(thread, turn, status) { turns.push(`${thread}:${turn}:${status}`); }, onFault(text) { faults.push(text); }, onApprovalResolved(id) { resolved.push(id); }, onDiff(_thread, _turn, diff) { diffs.push(diff); } };
  const rpc = createNativeProtocol(ctx, { thread: () => 'thread', send(message) { sent.push(message); }, async interrupt(thread, turn) { interrupts.push(`${thread}:${turn}`); }, response(m) { responses.push(m); } });
  const start = () => rpc.handle({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } });
  const approval = (method = 'item/commandExecution/requestApproval', id: number | string = 1) => rpc.handle({ id, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'echo hello', cwd: '/isolated', reason: 'Test approval' } });
  return { rpc, start, approval, approvals, responses, sent, turns, faults, interrupts, resolved, diffs, output };
}
test('delegation settings explicitly bind access and approval; communication remains read-only', () => {
  assert.deepEqual(delegationSettings(undefined, '/scratch'), { cwd: '/scratch', approvalPolicy: 'never', sandbox: 'read-only', shell: false });
  assert.deepEqual(delegationSettings(run, '/project'), { cwd: '/project', approvalPolicy: 'on-request', sandbox: 'read-only', shell: true });
  assert.equal(delegationSettings({ ...run, access: 'workspace-write' }, '/isolated').sandbox, 'workspace-write');
});
test('isolated copy keeps dirty and untracked bytes plus baseline, without sharing source writes', async () => {
  const source = await mkdtemp(join(tmpdir(), 'crew-source-test-'));
  await mkdir(join(source, '.git')); await mkdir(join(source, 'src')); await mkdir(join(source, 'node_modules'));
  await writeFile(join(source, 'src/add.ts'), 'return a - b; // dirty'); await writeFile(join(source, 'notes.txt'), 'untracked');
  const copy = await isolateProject(source);
  assert.equal(await readFile(join(copy.cwd, 'src/add.ts'), 'utf8'), 'return a - b; // dirty');
  assert.equal(await readFile(join(copy.cwd, 'notes.txt'), 'utf8'), 'untracked');
  const baseline = JSON.parse(await readFile(copy.baseline, 'utf8'));
  assert.deepEqual(baseline.files.map((f: any) => f.path).sort(), ['notes.txt', 'src/add.ts']);
  assert.ok(baseline.files.every((f: any) => /^[a-f0-9]{64}$/.test(f.sha256)));
  await writeFile(join(copy.cwd, 'src/add.ts'), 'return a + b;');
  assert.equal(await readFile(join(source, 'src/add.ts'), 'utf8'), 'return a - b; // dirty');
});
test('isolation fails explicitly for symlinks instead of following an external tree', async () => {
  const source = await mkdtemp(join(tmpdir(), 'crew-symlink-test-'));
  await symlink(tmpdir(), join(source, 'escape'));
  await assert.rejects(isolateProject(source), /Cannot isolate symlink safely/);
});
test('server request IDs never consume client responses, and decline targets the original ID', () => {
  const f = fixture(); f.start(); f.approval();
  assert.equal(f.responses.length, 0); assert.equal(f.approvals.length, 1);
  f.rpc.handle({ id: 1, result: { client: true } }); assert.equal(f.responses.length, 1);
  f.rpc.approve(f.approvals[0]!, 'decline');
  assert.deepEqual(f.sent[0], { id: 1, result: { decision: 'decline' } });
  assert.throws(() => f.rpc.approve(f.approvals[0]!, 'accept'), /Stale/);
});
test('file approval includes actual file-change event; native resolved/turn ended invalidates actions', () => {
  const f = fixture(); f.start();
  f.rpc.handle({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'fileChange', changes: [{ path: '/isolated/add.ts', diff: '- a-b\n+ a+b' }] } } });
  f.approval('item/fileChange/requestApproval', 'file'); assert.match(f.approvals[0]!.detail, /a\+b/);
  f.rpc.handle({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'file' } });
  assert.throws(() => f.rpc.approve(f.approvals[0]!, 'accept'), /Stale/);
  f.approval('item/commandExecution/requestApproval', 'cmd');
  f.rpc.handle({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
  assert.throws(() => f.rpc.approve(f.approvals[1]!, 'accept'), /Stale/);
  assert.deepEqual(f.resolved, ['file', 'cmd']);
});
test('unsupported requests fail closed and interrupt only the bound native turn', () => {
  const f = fixture(); f.start(); f.approval('item/tool/requestUserInput');
  assert.equal(f.sent[0].error.code, -32601); assert.equal(f.approvals.length, 0);
  assert.deepEqual(f.interrupts, ['thread:turn']); assert.match(f.faults[0]!, /Unsupported/);
});
test('unrelated threads and stale diffs do not update current tasks; text never becomes acceptance', () => {
  const f = fixture(); f.start();
  f.rpc.handle({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn', status: 'completed' } } });
  f.rpc.handle({ method: 'turn/diff/updated', params: { threadId: 'thread', turnId: 'old', diff: 'wrong' } });
  f.rpc.handle({ method: 'turn/diff/updated', params: { threadId: 'thread', turnId: 'turn', diff: 'actual' } });
  f.rpc.handle({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'text', type: 'agentMessage', text: 'Done' } } });
  assert.deepEqual(f.diffs, ['actual']); assert.deepEqual(f.output, ['Done']); assert.equal(f.turns.length, 1);
  f.rpc.handle({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'Limit reached' } } } });
  assert.deepEqual(f.faults, ['Limit reached']);
});

test('effective native sandbox must exclude temporary roots and retain human approvals', () => {
  const write = { ...run, access: 'workspace-write' as const };
  const applied = { cwd: '/isolated', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['/isolated'], excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
  verifyDelegationThread(write, '/isolated', applied);
  assert.equal(workerSandboxConfig.approvals_reviewer, 'user');
  assert.throws(() => verifyDelegationThread(write, '/isolated', { ...applied, approvalsReviewer: 'auto_review' }), /human approval/);
  assert.throws(() => verifyDelegationThread(write, '/isolated', { ...applied, sandbox: { ...applied.sandbox, excludeSlashTmp: false } }), /outside/);
  assert.throws(() => verifyDelegationThread(write, '/isolated', { ...applied, sandbox: { ...applied.sandbox, writableRoots: ['/source'] } }), /outside/);
  assert.throws(() => verifyDelegationThread(run, '/isolated', applied), /unexpected sandbox/);
});

test('relay advertises only mode and role-specific tools, without opening an inbound stream', async () => {
  const { spawn } = await import('node:child_process');
  async function list(member: string, mode?: string) {
    const child = spawn(process.execPath, ['src/bridge/relay.mjs'], { env: { ...process.env, CORPUS_BRIDGE_URL: 'http://127.0.0.1:19091', CORPUS_BRIDGE_TOKEN: 'synthetic-fixture', CORPUS_BRIDGE_MEMBER: member, CORPUS_BRIDGE_MODE: mode ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Relay list timed out: ' + stderr)), 5000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', bytes => { stdout += bytes; for (const line of stdout.split('\n').filter(Boolean)) { const value = JSON.parse(line); if (value.id === 2) { clearTimeout(timer); resolve(value.result); } } });
        // No notifications/initialized: oninitialized never calls fetch('/events').
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      });
      return result.tools;
    } finally { child.kill(); }
  }
  assert.deepEqual((await list('claude')).map((t: any) => t.name), ['ready', 'send_message', 'reply_message']);
  assert.deepEqual((await list('claude', 'delegation')).map((t: any) => t.name), ['ready', 'send_message', 'reply_message', 'delegate_task', 'review_task_result']);
  const worker = await list('codex', 'delegation');
  assert.deepEqual(worker.map((t: any) => t.name), ['ready', 'send_message', 'reply_message', 'accept_task', 'request_task_input', 'submit_task_result']);
  assert.equal(worker.find((t: any) => t.name === 'submit_task_result').inputSchema.properties.result.additionalProperties, false);
});
