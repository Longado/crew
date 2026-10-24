import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_SNAPSHOT_BYTES = 8_000_000;

export class TaskSnapshotSizeError extends Error {
  constructor(operation: 'read' | 'refresh') {
    super(`任务快照大小超过约 8 MB（${MAX_SNAPSHOT_BYTES} 字节），${operation === 'refresh' ? '已保留旧快照' : '已保存的快照无法读取'}；请缩小来源范围${operation === 'read' ? '后重新搜索' : ''}`);
    this.name = 'TaskSnapshotSizeError';
  }
}

const SourceTask = z.object({
  sourceId: z.number().int().positive(),
  projectId: z.number().int().nullable(),
  projectName: z.string().max(500),
  projectStatus: z.string().max(40),
  title: z.string().min(1).max(2000),
  status: z.enum(['todo', 'doing', 'blocked', 'to_verify', 'pending_confirm']),
  priority: z.enum(['urgent', 'high', 'medium', 'low']),
  dueDate: z.string().max(40).nullable(),
  updatedAt: z.string().max(40),
}).strict();
const Snapshot = z.object({
  version: z.literal(1), refreshedAt: z.string().datetime(),
  tasks: z.array(SourceTask).max(5000),
}).strict();
export type TaskSnapshot = z.infer<typeof Snapshot>;
export interface TaskSource {
  read(): TaskSnapshot | undefined;
  refresh(): TaskSnapshot;
  /** 每次打开今日页记一行：日期和当时显示的前三编号，用来对照实际做了什么 */
  recordView?(date: string, top: (number | string)[]): void;
}

function rejectLinks(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw Error('任务存储路径不能是符号链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Explicitly configured source only. Never uses BoardStore or its write-capable CLI. */
export function createTaskSource({ database, snapshotPath }: { database: string; snapshotPath: string }): TaskSource {
  if (resolve(database) === resolve(snapshotPath)) throw Error('快照必须与任务来源分开保存');
  return {
    read() {
      rejectLinks(snapshotPath);
      if (!existsSync(snapshotPath)) return undefined;
      const info = lstatSync(snapshotPath);
      if (info.isFile() && info.size > MAX_SNAPSHOT_BYTES) throw new TaskSnapshotSizeError('read');
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) {
        throw Error('任务快照不可读取，请检查本地文件权限');
      }
      return Snapshot.parse(JSON.parse(readFileSync(snapshotPath, 'utf8')));
    },
    refresh() {
      let db: DatabaseSync | undefined;
      let snapshot: TaskSnapshot;
      try {
        rejectLinks(database);
        db = new DatabaseSync(database, { readOnly: true });
        // Fixed SELECT, no notes, credentials, project paths, sessions or arbitrary SQL.
        const rows = db.prepare(`SELECT t.id AS sourceId,t.project_id AS projectId,
          COALESCE(p.name,'未归类') AS projectName,COALESCE(p.status,'unknown') AS projectStatus,
          t.title,t.status,t.priority,t.due_date AS dueDate,
          COALESCE(t.updated_at,t.created_at,'') AS updatedAt
          FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
          WHERE t.status IN ('todo','doing','blocked','to_verify','pending_confirm')
          ORDER BY t.id LIMIT 5001`).all();
        snapshot = Snapshot.parse({ version: 1, refreshedAt: new Date().toISOString(), tasks: rows });
      } catch {
        throw Error('任务来源暂时无法读取，已保留上次快照；请稍后重新搜索');
      } finally { db?.close(); }
      const content = JSON.stringify(snapshot, null, 2) + '\n';
      if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new TaskSnapshotSizeError('refresh');
      }
      rejectLinks(snapshotPath);
      const directory = dirname(snapshotPath);
      // mkdir's mode applies only to new directories; shared existing parents keep their permissions.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${snapshotPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
        renameSync(temp, snapshotPath);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
      return snapshot;
    },
    recordView(date, top) {
      const file = join(dirname(snapshotPath), 'today-views.jsonl');
      rejectLinks(file);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), date, top }) + '\n', { mode: 0o600 });
    },
  };
}
