// Manual entry. Importing this module never starts services or reads configuration.
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { dbPath, homeDir, housekeeperConfig, rejectHousekeeperSymlinks } from '../../src/config.ts';
import type { createSecurityService } from '../../src/security/adapter.ts';
import type { createTaskSource } from '../../src/today/source.ts';
import type { serve as serveLocal } from '../../src/server.ts';

const execute = promisify(execFile);
function validatedPort(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw Error('端口须为 1–65535 的整数');
  return Number(raw);
}
const browserUrl = (port: number) => `http://127.0.0.1:${validatedPort(String(port))}/#/today`;
const databaseFiles = (database: string) => [database, `${database}-wal`, `${database}-shm`, `${database}-journal`];
export function createPlan(args: string[], env: NodeJS.ProcessEnv = process.env) {
  let port = 4198; let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--port') port = validatedPort(args[++i]);
    else throw Error(`未知参数：${arg}`);
  }
  const config = housekeeperConfig(env);
  rejectHousekeeperSymlinks(dbPath(env));
  const corpus = resolve(homeDir(env));
  const database = resolve(dbPath(env));
  // A refresh must never replace the Crew database, its journals, or its source.
  if (config.taskSnapshotPath && [...databaseFiles(database), config.taskDatabase, join(corpus, 'housekeeper.json')].includes(config.taskSnapshotPath)) {
    throw Error('任务快照必须与 Crew 数据库、配置文件和外部任务来源分开保存');
  }
  return { corpus, database, config, port, dryRun, url: browserUrl(port) };
}
type Plan = ReturnType<typeof createPlan>;
function existingStat(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function prepareStorage(plan: Plan) {
  for (const path of databaseFiles(plan.database)) rejectHousekeeperSymlinks(path);
  for (const directory of new Set([plan.corpus, dirname(plan.database)])) {
    rejectHousekeeperSymlinks(directory);
    const info = existingStat(directory);
    if (info && !info.isDirectory()) throw Error(`存储路径不是目录：${directory}`);
    if (!info) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (existingStat(plan.database) && !existingStat(plan.database)!.isFile()) throw Error('数据库路径不是普通文件');
}
type NativeStat = { mode: number; isDirectory(): boolean; isSymbolicLink(): boolean };
type NativeDependencies = {
  home(): string;
  stat(path: string): NativeStat | undefined;
  realpath(path: string): string;
  execute(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string }>;
  launch(file: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' }): void;
};
function safeEnvironment(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
}
function manualNativeDependencies(log: (value: string) => void): NativeDependencies {
  return {
    home: homedir, stat: existingStat, realpath: realpathSync,
    execute: async (file, args, options) => { const result = await execute(file, args, options); return { stdout: result.stdout }; },
    launch: (file, args, options) => {
      const child = spawn(file, args, options);
      child.on('error', () => log('凭证管家未能打开，请检查配置的启动程序。'));
      child.unref();
    },
  };
}
export async function openManualInterfaces(plan: Plan, log: (value: string) => void = console.log, injected?: NativeDependencies, signal?: AbortSignal) {
  // No implicit native fallback: omitted or partial dependencies fail before I/O.
  if (!injected || ['home', 'stat', 'realpath', 'execute', 'launch'].some(key => typeof injected[key as keyof NativeDependencies] !== 'function')) {
    throw Error('原生边界必须显式提供完整依赖；不会自动打开应用或浏览器');
  }
  const native = injected;
  const requireActive = () => { if (signal?.aborted) throw Error('本次本地管家已关闭'); };
  requireActive();
  const url = browserUrl(plan.port); // Never use a caller-provided URL.
  const home = native.home();
  const environment = safeEnvironment(home);
  const { helperPath, launcherPath } = plan.config;
  if (!helperPath) log('未配置原生 helper，原生凭证管家不可用；本次仅打开 Crew。');
  else {
    // Keep the helper's existing broker namespace; never read or repair its contents.
    const namespace = join(home, '.local-sensitive/askkey-local-scan');
    let healthy = false; let namespaceSafe = true; let namespaceExists = false;
    try {
      rejectHousekeeperSymlinks(namespace, native.stat);
      const info = native.stat(namespace);
      namespaceExists = !!info;
      if (info && (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || native.realpath(namespace) !== namespace)) namespaceSafe = false;
    } catch { namespaceSafe = false; }
    try {
      if (!namespaceSafe || !namespaceExists) throw Error('没有可检查的原生服务目录');
      requireActive();
      const { stdout } = await native.execute(helperPath, ['health'], { env: { ...environment, ASKKEY_DEBUG_RUN_DIRECTORY: namespace }, timeout: 3000, maxBuffer: 16384, signal });
      requireActive();
      const response = JSON.parse(stdout);
      healthy = response?.success?._0?.health?._0?.status === 'ok';
    } catch { /* Health is optional; never inspect vault contents or repair a broker. */ }
    requireActive();
    if (!namespaceSafe) log('凭证管家的服务目录不可用，请手动检查；本次仅打开 Crew。');
    else if (!healthy) {
      if (launcherPath) {
        requireActive();
        native.launch(launcherPath, [], { env: environment, detached: true, stdio: 'ignore' });
        log('已请求打开配置的凭证管家；本入口不会停止或替换已有服务。');
      } else log('原生凭证管家未就绪，且未配置启动程序；本次仅打开 Crew。');
    }
  }
  requireActive();
  await native.execute('/usr/bin/open', [url], { env: environment, timeout: 5000, signal });
  requireActive();
}
type OwnedDb = { raw: { close(): void } };
type Dependencies = {
  env?: NodeJS.ProcessEnv; log?: (value: string) => void;
  prepare?: (plan: Plan) => void;
  openDb?: (path: string) => OwnedDb;
  serve?: typeof serveLocal;
  createSecurity?: typeof createSecurityService;
  createTasks?: typeof createTaskSource;
  openNative?: (plan: Plan, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};
// Read-only probe: only the shape of the Crew today page decides whether the busy port already runs Crew.
async function crewAlreadyRunning(port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/today`, { signal: AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]) });
    if (response.status !== 200) return false;
    const body = await response.json() as { date?: unknown; source?: unknown } | null;
    return typeof body?.date === 'string' && typeof body?.source === 'object' && body.source !== null && !Array.isArray(body.source);
  } catch { return false; }
}
export async function runHousekeeper(args: string[], dependencies: Dependencies = {}) {
  const plan = createPlan(args, dependencies.env);
  const log = dependencies.log ?? console.log;
  const openNative = dependencies.openNative ?? ((p: Plan, signal: AbortSignal) => openManualInterfaces(p, log, manualNativeDependencies(log), signal));
  if (plan.dryRun) { log(JSON.stringify({ ...plan, action: 'plan-only', native: plan.config.helperPath ? 'manual-after-listening' : 'unavailable' }, null, 2)); return; }
  if (Object.keys(dependencies).length > 0 && !dependencies.openNative) {
    throw Error('注入启动依赖时必须显式提供 openNative；不会回退到真实原生操作');
  }
  if (dependencies.signal?.aborted) throw Error('本次本地管家已关闭');
  const openDb = dependencies.openDb ?? (await import('../../src/db.ts')).openDb;
  const serve = dependencies.serve ?? (await import('../../src/server.ts')).serve;
  const createSecurity = dependencies.createSecurity ?? (await import('../../src/security/adapter.ts')).createSecurityService;
  const createTasks = dependencies.createTasks ?? (await import('../../src/today/source.ts')).createTaskSource;
  if (dependencies.signal?.aborted) throw Error('本次本地管家已关闭');
  (dependencies.prepare ?? prepareStorage)(plan);
  const taskSource = plan.config.taskDatabase ? createTasks({ database: plan.config.taskDatabase, snapshotPath: plan.config.taskSnapshotPath! }) : undefined;
  const security = createSecurity({
    helperPath: plan.config.helperPath, nativeEnabled: !!plan.config.helperPath,
    scriptPath: plan.config.scannerPath,
    localCatalogPath: plan.config.vaultDir ? join(plan.config.vaultDir, 'catalog.json') : false,
  });
  let db: OwnedDb | undefined; let server: Server | undefined;
  let closing = false; let databaseClosed = false;
  let rejectStartup: ((error: Error) => void) | undefined;
  const shutdown = new AbortController();
  const closeDatabase = () => { if (db && !databaseClosed) { databaseClosed = true; db.raw.close(); } };
  const close = () => {
    if (closing) return; closing = true;
    shutdown.abort();
    rejectStartup?.(Error('本次本地管家在监听完成前已关闭'));
    process.off('SIGINT', close); process.off('SIGTERM', close); process.off('SIGHUP', close);
    dependencies.signal?.removeEventListener('abort', close);
    if (server) { try { server.close(closeDatabase); } catch { closeDatabase(); } }
    else { closeDatabase(); void security.close().catch(() => {}); }
  };
  process.once('SIGINT', close); process.once('SIGTERM', close); process.once('SIGHUP', close);
  dependencies.signal?.addEventListener('abort', close, { once: true });
  try {
    if (dependencies.signal?.aborted) throw Error('本次本地管家已关闭');
    db = openDb(plan.database);
    server = serve(db as Parameters<typeof serveLocal>[0], plan.port, undefined, undefined, security, taskSource);
    await new Promise<void>((accept, reject) => {
      const cleanup = () => { server!.off('error', failed); server!.off('listening', listening); rejectStartup = undefined; };
      const listening = () => { cleanup(); accept(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      rejectStartup = failed;
      server!.once('listening', listening); server!.once('error', failed);
      if (closing) failed(Error('本次本地管家已关闭'));
    });
    if (closing) throw Error('本次本地管家已关闭');
    log(`本地管家：${plan.url}（关闭此终端或按 Ctrl-C 停止本次 Crew 服务）`);
    await openNative(plan, shutdown.signal);
    if (closing) throw Error('本次本地管家已关闭');
    return { plan, close, reused: false };
  } catch (error) {
    close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // The port already serves Crew: the double-click only wants the today page; this process keeps no service.
      if (await crewAlreadyRunning(plan.port, dependencies.signal)) {
        log(`本地管家已在运行（端口 ${plan.port}），直接打开今日页。`);
        await openNative(plan, new AbortController().signal);
        return { plan, close: () => {}, reused: true };
      }
      throw Error(`端口 ${plan.port} 已被占用；本次没有接管已有服务，请使用 --port 指定其他端口。`);
    }
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHousekeeper(process.argv.slice(2)).catch((error: unknown) => { console.error(`本地管家未启动：${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
}
