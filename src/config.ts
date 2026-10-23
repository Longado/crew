// 数据和配置的位置。网页、命令行、MCP、插件无论从哪个目录启动，读的都是同一份数据。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Working Corpus';

export const homeDir = () => process.env.CORPUS_HOME ?? join(homedir(), '.working-corpus');
export const dbPath = () => process.env.CORPUS_DB ?? join(homeDir(), 'corpus.db');
export const evalDir = () => join(homeDir(), 'eval');

/** Security integrations are opt-in; the local vault is read-only metadata. */
export const securityConfig = () => ({
  helperPath: process.env.CREW_ASKKEY_HELPER?.trim() || undefined,
  scriptPath: process.env.CREW_SECURITY_SCANNER?.trim() || undefined,
  localCatalogPath: join(process.env.CREW_VAULT_DIR?.trim() || join(homedir(), '.local-sensitive', 'housekeeper-vault'), 'catalog.json'),
});

const REPO_ENV = fileURLToPath(new URL('../.env', import.meta.url));

/** 读配置：已有的环境变量优先，其次仓库里的 .env，最后用户目录里的 .env。 */
export function loadEnv(): void {
  for (const file of [REPO_ENV, join(homeDir(), '.env')]) {
    if (existsSync(file)) process.loadEnvFile(file); // 不覆盖已经存在的变量
  }
}
