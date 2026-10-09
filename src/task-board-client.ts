// Shared task adapter for the CLI and MCP. Task truth remains in Workspace/.data/tasks.db.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const DEFAULT_TASK_WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskResult = Record<string, unknown>;
export interface TaskBoardOptions {
  workspace?: string;
  manifest?: string;
  boardUrl?: string;
  timeoutMs?: number;
  runCommand?: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
  fetch?: typeof globalThis.fetch;
}

export class TaskBoardClient {
  readonly workspace: string;
  readonly manifest: string;
  readonly boardUrl: string;
  private readonly timeoutMs: number;
  private readonly runCommand: NonNullable<TaskBoardOptions['runCommand']>;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: TaskBoardOptions = {}) {
    this.workspace = resolve(options.workspace ?? DEFAULT_TASK_WORKSPACE);
    this.manifest = resolve(options.manifest ?? resolve(this.workspace, 'docs/任务清单-2026-10-01/清单.json'));
    const url = new URL(options.boardUrl ?? 'http://127.0.0.1:6480');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('--board-url 必须是本地 HTTP 服务地址，例如 http://127.0.0.1:6480');
    }
    this.boardUrl = url.origin;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.runCommand = options.runCommand ?? ((file, args, limits) => execute(file, args, { ...limits, encoding: 'utf8' }));
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private taskId(task: number): void {
    if (!Number.isSafeInteger(task) || task <= 0) throw new Error('任务编号必须是正整数。');
  }

  private async store(action: string, args: string[] = []): Promise<TaskResult> {
    const script = fileURLToPath(new URL('../scripts/task-board/command.py', import.meta.url));
    try {
      const result = await this.runCommand('python3', [script, '--workspace', this.workspace, '--manifest', this.manifest, '--action', action, ...args], { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(result.stdout) as TaskResult;
    } catch (error) {
      const detail = error as Error & { stderr?: string; code?: string; killed?: boolean };
      if (detail.killed) throw new Error('读取任务接口超时，请检查本地任务库。');
      if (detail.code === 'ENOENT') throw new Error('找不到 python3，任务接口需要本地 Python 3。');
      throw new Error(detail.stderr?.trim() || `任务接口失败：${detail.message}`);
    }
  }

  list(): Promise<TaskResult> { return this.store('list'); }
  async get(task: number): Promise<TaskResult> { this.taskId(task); return this.store('get', ['--task', String(task)]); }
  async status(task: number): Promise<TaskResult> { this.taskId(task); return this.store('status', ['--task', String(task)]); }
  async cancel(task: number, expectedStatus: string, note: string): Promise<TaskResult> {
    this.taskId(task);
    if (!TASK_STATUSES.includes(expectedStatus as TaskStatus)) throw new Error('expected-status 必须是 todo、doing、blocked、done 或 cancelled。');
    if (!note?.trim() || note.length > 2800) throw new Error('请填写终止原因，最多2800字。');
    return this.store('cancel', ['--task', String(task), '--expected-status', expectedStatus, '--note', note.trim()]);
  }

  private async request(path: string, body?: TaskResult): Promise<TaskResult> {
    let response: Response;
    try {
      response = await this.fetch(this.boardUrl + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-corpus': '1' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new Error('本地任务看板请求超时；请检查运行记录后重试。');
      throw new Error(`无法连接本地任务看板 ${this.boardUrl}；请先打开 Crew Tasks App 或启动看板服务。`);
    }
    let value: TaskResult;
    try { value = await response.json() as TaskResult; }
    catch { throw new Error(`本地任务看板返回非 JSON 响应（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `本地任务看板返回 HTTP ${response.status}。`);
    return value;
  }

  private async verifyBoard(): Promise<void> {
    const board = await this.request('/api/board');
    if (board.workspace !== this.workspace || board.manifest !== this.manifest) throw new Error('本地看板的工作区或清单与接口配置不同，请核对 --workspace、--manifest 和 --board-url。');
  }

  async dispatch(task: number, goal: string, write = false): Promise<TaskResult> {
    this.taskId(task);
    if (!goal?.trim() || goal.length > 2800) throw new Error('请填写本次具体目标，最多2800字。');
    await this.verifyBoard();
    return this.request('/api/dispatch', { task_id: task, access: write ? 'workspace-write' : 'read-only', goal: goal.trim() });
  }

  async stop(job: string): Promise<TaskResult> {
    if (!job?.trim()) throw new Error('请指定要停止的运行编号 --job。');
    await this.verifyBoard();
    return this.request('/api/stop', { job_id: job.trim() });
  }
}
