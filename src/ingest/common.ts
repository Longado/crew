// 各来源读取器共用的小工具。
import { execFileSync } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { sep } from 'node:path';
import type { Db } from '../db.ts';

const rootCache = new Map<string, string>();

/** 工作目录所在的 git 仓库根目录；不是仓库或目录已不存在时，返回原目录。 */
export function gitRoot(dir: string): string {
  const hit = rootCache.get(dir);
  if (hit) return hit;
  let root = dir;
  try {
    root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir;
  } catch {
    // 不是 git 仓库或目录不存在：按原目录归属
  }
  rootCache.set(dir, root);
  return root;
}

/** 从字节位置 from 读到文件末尾，只返回完整的行，以及读完后新的位置。 */
export function readNewLines(file: string, from: number): { lines: string[]; next: number; reset: boolean } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const reset = size < from; // 文件变短：被重写过，从头再读，重复的消息靠编号去重
    const start = reset ? 0 : from;
    if (size === start) return { lines: [], next: start, reset };
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], next: start, reset };
    const text = buf.subarray(0, lastNl).toString('utf8');
    return { lines: text.split('\n').filter((l) => l.trim() !== ''), next: start + lastNl + 1, reset };
  } finally {
    closeSync(fd);
  }
}

/** 只读文件开头一段，找第一个出现的字段，用来在不读全文的情况下判断归属。 */
export function peekHead(file: string, bytes = 256 * 1024): string[] {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, fstatSync(fd).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').split('\n').slice(0, -1);
  } finally {
    closeSync(fd);
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[已截断 ${text.length - max} 字]`;
}

export const TOOL_ERROR_MAX = 500;

export interface Worktree { dir: string; projectId: string }

/** 已登记项目仓库在别处的 git worktree（很多开发在 worktree 里做）。每个项目目录一次 git 调用。 */
export function projectWorktrees(db: Db): Worktree[] {
  const out: Worktree[] = [];
  for (const p of db.listProjects()) {
    for (const dir of p.dirs) {
      let text = '';
      try {
        text = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        continue; // 不是 git 仓库
      }
      for (const line of text.split('\n')) {
        const wt = line.startsWith('worktree ') ? line.slice(9) : null;
        if (wt && !db.projectForDir(wt)) out.push({ dir: wt, projectId: p.id });
      }
    }
  }
  return out;
}

// 绝对路径：前面不能紧跟字母数字或冒号、斜杠（排除 https://、相对路径里的片段）
const ABS_PATH = /(?<![\w:/.~-])\/[^\s"'`<>|;,(){}[\]\\]+/g;
const MIN_HITS = 2; // 只顺手读过一次某项目文件的会话不算那个项目的活

/**
 * 工作目录没绑定项目时（比如从上层目录开、中途才进项目），看会话里出现过的工作目录和工具参数：
 * 某个项目占了一半以上的路径，就归这个项目。起点目录本身不算（从哪开不说明在哪干活）；
 * 主要在没登记的目录里干活、只是路过某个项目的会话不归属（10-29 用一天的真实会话核过：
 * 归对的占 52%–84%，路过的都在 4% 以下）。没落在项目里的片段要磁盘上真有才算，
 * 不然代码和正则里的 /g、// 之类会被当成「在别处干活」。
 */
const isPlace = (path: string) => !/^\/+$/.test(path) && !path.startsWith('/dev/') && existsSync(path);

export function projectByPaths(db: Db, texts: Iterable<string>, start: string, worktrees: Worktree[] = []): string | null {
  const hits = new Map<string, number>();
  const known = new Map<string, string | undefined>(); // 项目编号；'' 是没登记的真实位置，undefined 不算路径
  const origin = start.replace(/\/$/, '');
  let total = 0;
  for (const text of texts) {
    for (const path of text.match(ABS_PATH) ?? []) {
      if (path.replace(/\/$/, '') === origin) continue;
      if (!known.has(path)) {
        const id = db.projectForDir(path) ?? worktrees.find((w) => path === w.dir || path.startsWith(w.dir + sep))?.projectId ?? null;
        known.set(path, id ?? (isPlace(path) ? '' : undefined));
      }
      const id = known.get(path);
      if (id === undefined) continue; // 不是真实路径
      total++;
      if (id) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
  }
  const [first] = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  if (!first || first[1] < MIN_HITS || first[1] * 2 <= total) return null;
  return first[0];
}
