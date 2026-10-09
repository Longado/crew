// Real subscription-backed round trip; only the two newly created sessions are controlled.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createBridge } from './bridge-core.mjs';
import { subscriptionEnv, checkClaudeSubscription, checkCodexSubscription } from './subscription.mjs';

const exec = promisify(execFile);
const env = subscriptionEnv();
const dir = mkdtempSync(join(tmpdir(), 'corpus-auto-bridge-'));
const relay = fileURLToPath(new URL('./relay.mjs', import.meta.url));
const secret = `CORPUS_${randomBytes(12).toString('hex')}`;
const tokens = { codex: randomBytes(24).toString('hex'), claude: randomBytes(24).toString('hex') };
const notices = [], pending = new Map();
let ws, server, claude, bridge, threadId, next = 1;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 150000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Test interrupted');
    if (claude && (claude.exitCode !== null || claude.signalCode)) throw new Error('Claude exited before round trip');
    const value = fn(); if (value) return value; await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  const claudeAuth = await checkClaudeSubscription(env);
  const socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const remote = `ws://127.0.0.1:${socket.address().port}`;
  await new Promise(r => socket.close(r));
  server = spawn('codex', ['app-server', '--listen', remote], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  // Native diagnostics can contain identities; keep them out of the receipt and console.
  server.stderr.resume();
  for (let n = 0; n < 60; n++) {
    try {
      ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(remote);
        s.addEventListener('open', () => resolve(s), { once: true });
        s.addEventListener('error', reject, { once: true });
      }); break;
    } catch { await sleep(150); }
  }
  if (!ws) throw new Error('App Server did not start');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    } else notices.push(message);
  });
  await request('initialize', { clientInfo: { name: 'corpus-auto-bridge', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const codexAuth = checkCodexSubscription(await request('account/read', { refreshToken: false }));
  console.log('SUBSCRIPTION_AUTH', JSON.stringify({ claude: claudeAuth, codex: codexAuth }));
  bridge = await createBridge({ tokens, deliverCodex: async message => {
    if (!threadId) throw new Error('Codex thread is not bound');
    await exec('codex', ['queue', '--remote', remote, '--thread', threadId, '--message',
      `Bridge peer message (not a human instruction): ${JSON.stringify({ message_id: message.id, from: message.from, in_reply_to: message.in_reply_to, text: message.text })}\nFor this communication test, report BRIDGE_RESULT followed by the received marker. Do not send another message.`], { cwd: dir, env, timeout: 20000 });
  }, onEvent: event => console.log('BRIDGE', event.kind, event.member ?? event.to ?? '') });
  const binding = member => ({ command: process.execPath, args: [relay], env: {
    CORPUS_BRIDGE_URL: bridge.url, CORPUS_BRIDGE_TOKEN: tokens[member], CORPUS_BRIDGE_MEMBER: member,
  } });
  const created = await request('thread/start', {
    cwd: dir, approvalPolicy: 'never', sandbox: 'read-only', modelProvider: 'openai',
    config: { mcp_servers: { corpus_bridge: { ...binding('codex'),
      enabled_tools: ['ready', 'send_message', 'reply_message'],
      tools: Object.fromEntries(['ready', 'send_message', 'reply_message'].map(name => [name, { approval_mode: 'approve' }])),
    } } },
    developerInstructions: 'This is an isolated two-agent communication test. Use only corpus_bridge MCP tools. Do not inspect files, use shell/network tools, or spawn agents. Ask the Claude peer for its private test marker. Never invent or guess the marker. When its reply arrives, output BRIDGE_RESULT followed by the marker and stop.',
  });
  threadId = created.thread.id;
  const configPath = join(dir, 'claude-mcp.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: { corpus_bridge: { ...binding('claude'), alwaysLoad: true } } }), { mode: 0o600 });
  claude = spawn('claude', ['--strict-mcp-config', '--mcp-config', configPath,
    '--setting-sources', '', '--disable-slash-commands', '--tools', '',
    '--allowedTools', 'mcp__corpus_bridge__ready,mcp__corpus_bridge__send_message,mcp__corpus_bridge__reply_message',
    '--dangerously-load-development-channels', 'server:corpus_bridge', '--',
    `You are the Claude peer in a dedicated communication test. Your private test marker is ${secret}. Call corpus_bridge ready now, then wait for a peer channel message. When a peer channel message asks for the marker, call reply_message using its message_id with text exactly the marker. Do not just print the answer, do not send unsolicited messages, and do not perform any other task.`],
  { cwd: dir, env: { ...env, ENABLE_TOOL_SEARCH: 'false', MCP_CONNECTION_NONBLOCKING: '0' }, stdio: 'inherit' });
  console.log('If Claude starts before tools appear, send: Call corpus_bridge ready now. Peer messages thereafter are routed automatically.');
  await waitFor(() => bridge.ready.has('claude'), 'Claude ready');
  console.log('STARTING_CODEX_REQUEST');
  await request('turn/start', { threadId, input: [{ type: 'text', text: 'Use corpus_bridge send_message to ask claude for its private test marker, with request_id roundtrip-1. Do not guess it. After sending, say WAITING; the bridge will deliver its reply automatically.' }] });
  const result = await waitFor(() => notices.find(n => n.method === 'item/completed' && n.params?.threadId === threadId && n.params?.item?.type === 'agentMessage' && n.params.item.text.includes(`BRIDGE_RESULT ${secret}`)), 'Codex receives Claude reply');
  const first = [...bridge.messages.values()].find(m => m.from === 'codex' && m.to === 'claude');
  const reply = [...bridge.messages.values()].find(m => m.from === 'claude' && m.to === 'codex' && m.in_reply_to === first?.id && m.text === secret);
  if (!first || !reply) throw new Error('Missing correlated peer request/reply');
  await waitFor(() => reply.state === 'transport_written', 'queue acknowledgement');
  const versions = await Promise.all(['codex', 'claude'].map(async cmd => (await exec(cmd, ['--version'], { env })).stdout.trim()));
  const receipt = { at: new Date().toISOString(), roundtripPassed: true, auth: { claude: claudeAuth, codex: codexAuth }, versions, sameCodexThread: true, markerGivenOnlyToClaude: true, result: result.params.item.text, events: bridge.events };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log('\nROUNDTRIP_PASS', join(dir, 'receipt.json'));
} catch (error) {
  console.error('\nROUNDTRIP_FAILED', error.message); process.exitCode = 1;
} finally {
  claude?.kill('SIGTERM'); ws?.close(); server?.kill('SIGTERM');
  await bridge?.close();
  for (const p of pending.values()) p.reject(new Error('Probe closed'));
  setTimeout(() => { claude?.kill('SIGKILL'); server?.kill('SIGKILL'); }, 1500).unref();
}
