// Launch a dedicated interactive test session, leaving existing sessions untouched.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'corpus-claude-probe-'));
const config = join(dir, 'mcp.json');
writeFileSync(config, JSON.stringify({ mcpServers: { 'corpus-probe': {
  command: process.execPath,
  args: [fileURLToPath(new URL('./channel.mjs', import.meta.url))],
  env: { CORPUS_PROBE_DIR: dir, CORPUS_PROBE_TOKEN: randomBytes(24).toString('hex') },
} } }), { mode: 0o600 });

const env = { ...process.env };
if (process.argv.includes('--use-login')) delete env.ANTHROPIC_API_KEY;
console.log('Dedicated test directory:', dir);
console.log('Once Claude says READY, run in another terminal:');
console.log('node', fileURLToPath(new URL('./send.mjs', import.meta.url)), dir);
const child = spawn('claude', [
  '--strict-mcp-config', '--mcp-config', config,
  '--setting-sources', '', '--disable-slash-commands', '--tools', '',
  '--allowedTools', 'mcp__corpus-probe__reply',
  '--dangerously-load-development-channels', 'server:corpus-probe',
  'This is an isolated communication test. Say READY. When a channel message arrives, call reply with its message_id and requested text. Do not use other tools.',
], { cwd: dir, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
