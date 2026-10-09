import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function subscriptionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/API_KEY|AUTH_TOKEN|BASE_URL|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)/i.test(key)));
}
export async function checkClaudeSubscription(env: NodeJS.ProcessEnv) {
  const { stdout } = await exec('claude', ['auth', 'status', '--json'], { env, timeout: 15000 });
  const auth = JSON.parse(stdout);
  if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' || !['max', 'pro', 'team', 'enterprise'].includes(auth.subscriptionType)) throw new Error('Claude subscription login required; API-key fallback is disabled.');
  return `Claude ${auth.subscriptionType}`;
}
export function checkCodexSubscription(result: { account?: { type?: string; planType?: string } }) {
  const account = result.account;
  if (account?.type !== 'chatgpt' || !account.planType || account.planType === 'free') throw new Error('Codex paid ChatGPT login required; API-key fallback is disabled.');
  return `ChatGPT ${account.planType}`;
}
