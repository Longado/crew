// 调用大模型。整个项目只有证据整理这一处用到它。
// 模型版本在 .env 的 CORPUS_MODEL 里固定：claude- 开头走本机已登录的 Claude 订阅，其余走 DeepSeek（兼容 OpenAI 的接口）。
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export interface ModelCall {
  name: string; // 记进每条证据，方便事后追查
  call(system: string, user: string): Promise<string>;
}

export class ModelError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const TIMEOUT_MS = 300_000; // 推理模型一批要几十秒，给足余量

export function deepseek(opts: { apiKey?: string; model?: string; baseUrl?: string } = {}): ModelCall {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const model = opts.model ?? process.env.CORPUS_MODEL ?? 'deepseek-flash';
  const baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
  return {
    name: model,
    async call(system, user) {
      if (!apiKey) throw new ModelError('没有配置 DEEPSEEK_API_KEY：复制 .env.example 为 .env 并填写', false);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model, temperature: 0, max_tokens: 8192, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new ModelError(`连不上模型接口：${(e as Error).message}`, true);
      }
      const body = await res.text();
      if (res.status === 401) throw new ModelError('模型接口密钥无效，请检查 DEEPSEEK_API_KEY', false);
      if (res.status === 402) throw new ModelError('模型接口余额不足', false);
      if (res.status === 429 || res.status >= 500) throw new ModelError(`模型接口暂时不可用（${res.status}），稍后重试`, true);
      if (!res.ok) throw new ModelError(`模型接口返回错误（${res.status}）：${body.slice(0, 300)}`, false);
      const choice = JSON.parse(body)?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new ModelError('模型输出被截断（批次太长）', true);
      const content = choice?.message?.content;
      if (typeof content !== 'string') throw new ModelError('模型没有返回内容', true);
      return content;
    },
  };
}

export interface ClaudeUsage { calls: number; input: number; output: number; cacheRead: number; cacheCreate: number }

// 只带这些环境变量，ANTHROPIC_API_KEY 之类不会传下去，保证走订阅登录（和材料接入同一套做法）
const CLAUDE_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'];

function runClaude(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(CLAUDE_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
    const child = spawn(bin, args, { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', (e) => { clearTimeout(timer); reject(new ModelError(`找不到 claude 命令：${e.message}`, false)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new ModelError(`Claude 超时（${TIMEOUT_MS / 1000} 秒）`, true));
      else if (code) reject(new ModelError(`Claude 命令失败：${err.slice(-300) || out.slice(-300)}`, true));
      else resolve(out);
    });
    child.stdin.end(input);
  });
}

/** 本机已登录的 Claude 订阅（claude -p），关掉工具、MCP、自定义设置和会话记录；usage 累计本进程里的用量。 */
export function claudeCli(opts: { model?: string; bin?: string } = {}): ModelCall & { usage: ClaudeUsage } {
  const model = opts.model ?? process.env.CORPUS_MODEL ?? 'claude-sonnet-5-5';
  const bin = opts.bin ?? process.env.CREW_CLAUDE_BIN ?? 'claude';
  const usage: ClaudeUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let checked = false;
  return {
    name: model,
    usage,
    async call(system, user) {
      if (!checked) {
        const auth = JSON.parse(await runClaude(bin, ['auth', 'status'], ''));
        if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty') {
          throw new ModelError('整理要用 Claude 订阅登录，不用独立 API key 或其他模型服务', false);
        }
        checked = true;
      }
      const raw = await runClaude(bin, ['-p', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', '', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
        '--output-format', 'json', '--model', model, '--system-prompt', system], user);
      let env: Record<string, any>;
      try {
        env = JSON.parse(raw);
      } catch {
        throw new ModelError('Claude 返回的不是 JSON', true);
      }
      const u = env.usage ?? {};
      usage.calls++;
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
      if (env.is_error || env.subtype !== 'success' || typeof env.result !== 'string') {
        throw new ModelError(`Claude 没有交回结果：${String(env.result ?? env.subtype).slice(0, 200)}`, true);
      }
      return env.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    },
  };
}

/** 按 CORPUS_MODEL 选模型。 */
export function defaultModel(): ModelCall & { usage?: ClaudeUsage } {
  return (process.env.CORPUS_MODEL ?? '').startsWith('claude') ? claudeCli() : deepseek();
}
