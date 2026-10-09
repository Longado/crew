import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Only child-process environments change; never change login files or global settings.
export function subscriptionEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]) delete env[key];
  return env;
}

export async function checkClaudeSubscription(env) {
  const { stdout } = await exec('claude', ['auth', 'status', '--json'], { env, timeout: 15000 });
  const auth = JSON.parse(stdout);
  if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' ||
      !['max', 'pro', 'team', 'enterprise'].includes(auth.subscriptionType)) {
    throw new Error('Claude subscription login required; API-key fallback is disabled.');
  }
  return { authMethod: auth.authMethod, subscriptionType: auth.subscriptionType };
}

export function checkCodexSubscription(accountResult) {
  const account = accountResult?.account;
  if (account?.type !== 'chatgpt' || !account.planType || account.planType === 'free') {
    throw new Error('Codex paid ChatGPT login required; API-key fallback is disabled.');
  }
  return { authMethod: account.type, planType: account.planType };
}
