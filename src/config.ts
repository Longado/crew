// 数据和配置的位置。网页、命令行、MCP、插件无论从哪个目录启动，读的都是同一份数据。
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const homeDir = (env = process.env) => env.CORPUS_HOME ?? join(homedir(), '.working-corpus');
export const dbPath = (env = process.env) => env.CORPUS_DB ?? join(homeDir(env), 'corpus.db');
export const evalDir = () => join(homeDir(), 'eval');

/** Security integrations are opt-in; the local vault is read-only metadata. */
export const securityConfig = () => ({
  helperPath: process.env.CREW_ASKKEY_HELPER?.trim() || undefined,
  scriptPath: process.env.CREW_SECURITY_SCANNER?.trim() || undefined,
  localCatalogPath: join(process.env.CREW_VAULT_DIR?.trim() || join(homedir(), '.local-sensitive', 'housekeeper-vault'), 'catalog.json'),
});

const HOUSEKEEPER_ENV = {
  helperPath: 'CREW_ASKKEY_HELPER',
  launcherPath: 'CREW_ASKKEY_LAUNCHER',
  scannerPath: 'CREW_SECURITY_SCANNER',
  vaultDir: 'CREW_VAULT_DIR',
  taskDatabase: 'CREW_TASK_DB',
  taskSnapshotPath: 'CREW_TASK_SNAPSHOT',
} as const;
export type HousekeeperConfig = Partial<Record<keyof typeof HOUSEKEEPER_ENV, string>>;

/** Inspect each component before normalizing '..', including dangling links. */
export function rejectHousekeeperSymlinks(path: string, stat: (path: string) => { isSymbolicLink(): boolean } | undefined = lstatSync): void {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/')) {
    current = join(current, part);
    try {
      if (stat(current)?.isSymbolicLink()) throw Error(`本地管家路径不能包含符号链接：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Only the manual entry reads this optional file; other Crew commands keep their configuration. */
export function housekeeperConfig(env: NodeJS.ProcessEnv = process.env): HousekeeperConfig {
  rejectHousekeeperSymlinks(homeDir(env));
  const file = join(homeDir(env), 'housekeeper.json');
  const pathValue = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
      throw Error(`本地管家配置 ${label} 必须是非空的绝对路径字符串`);
    }
    rejectHousekeeperSymlinks(value);
    return resolve(value);
  };
  rejectHousekeeperSymlinks(file);
  let raw: unknown = {};
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 65536) throw Error(`本地管家配置 ${file} 必须是小于 64 KiB 的普通 JSON 文件`);
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw Error(`本地管家配置 ${file} 无法解析，请检查 JSON 格式和读取权限`); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`本地管家配置 ${file} 必须是 JSON 对象`);
  const config: HousekeeperConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(HOUSEKEEPER_ENV, key)) throw Error(`本地管家配置 ${file} 含未知配置项：${key}`);
    config[key as keyof HousekeeperConfig] = pathValue(value, `${file} 的 ${key}`);
  }
  for (const [key, name] of Object.entries(HOUSEKEEPER_ENV)) {
    if (env[name] !== undefined) config[key as keyof HousekeeperConfig] = pathValue(env[name], name);
  }
  if (Boolean(config.taskDatabase) !== Boolean(config.taskSnapshotPath)) throw Error('外部任务库与任务快照路径必须成对配置：CREW_TASK_DB / CREW_TASK_SNAPSHOT，或 taskDatabase / taskSnapshotPath');
  return config;
}

const REPO_ENV = fileURLToPath(new URL('../.env', import.meta.url));

/** 读配置：已有的环境变量优先，其次仓库里的 .env，最后用户目录里的 .env。 */
export function loadEnv(): void {
  for (const file of [REPO_ENV, join(homeDir(), '.env')]) {
    if (existsSync(file)) process.loadEnvFile(file); // 不覆盖已经存在的变量
  }
}
