import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { checkClaudeSubscription, checkCodexSubscription, subscriptionEnv } from '../bridge/subscription.ts';
const exec = promisify(execFile);
export type TerminalProvider = 'codex' | 'claude';
export function terminalEnv(): NodeJS.ProcessEnv {
  const env = subscriptionEnv();
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_(THREAD|SESSION|SANDBOX|APP_SERVER)|CORPUS_BRIDGE_)/.test(key) || /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

// account/read never starts a thread or a model turn. Do not log its response.
export async function probeCodexSubscription(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '-c', 'features.plugins=false', '-c', 'features.apps=false'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false, buffer = '';
    const timer = setTimeout(() => finish(new Error('Codex subscription check timed out')), 15000);
    function finish(error?: Error, label?: string) {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1000); kill.unref();
      error ? reject(error) : resolve(label!);
    }
    child.on('error', () => finish(new Error('Codex CLI unavailable')));
    child.on('exit', () => finish(new Error('Codex subscription check exited')));
    child.stderr.resume();
    child.stdin.on('error', () => finish(new Error('Codex subscription check disconnected')));
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error('Invalid Codex subscription response'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.id === 1) {
            if (response.error) return finish(new Error('Codex subscription initialization failed'));
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } }) + '\n');
          } else if (response.id === 2) {
            if (response.error) return finish(new Error('Codex subscription check failed'));
            finish(undefined, checkCodexSubscription(response.result));
          }
        } catch { finish(new Error('Codex paid ChatGPT login required; API-key fallback is disabled.')); }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'crew-terminal', version: '0.1.0' }, capabilities: {} } }) + '\n');
  });
}

export async function prepareProvider(provider: TerminalProvider, env: NodeJS.ProcessEnv): Promise<{ command: string; args: string[] }> {
  let help: string;
  try { help = (await exec(provider, ['--help'], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new Error(`${provider} CLI unavailable; install it and sign in with your subscription.`); }
  if (provider === 'claude') {
    await checkClaudeSubscription(env);
    return { command: 'claude', args: ['--permission-mode', /"manual"/.test(help) ? 'manual' : 'default', '--setting-sources', ''] };
  }
  await probeCodexSubscription(env);
  return { command: 'codex', args: ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', ...(help.includes('--no-daemon') ? ['--no-daemon'] : [])] };
}
