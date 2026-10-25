// 数据库访问。所有 SQL 都在这里，其他模块不直接写 SQL。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Session, StoredEvidence, TaskRecord, Correction, CorrectionRecord, Role } from './contracts.ts';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const now = () => new Date().toISOString();
const shortId = (prefix: string) => `${prefix}${randomUUID().slice(0, 8)}`;

type Row = Record<string, unknown>;

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // 老数据库补字段
  const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('paused')) db.exec('ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('remote_ok')) db.exec('ALTER TABLE projects ADD COLUMN remote_ok INTEGER NOT NULL DEFAULT 0');
  const scols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
  if (!scols.includes('excluded')) db.exec('ALTER TABLE sessions ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
  if (!scols.includes('tool_version')) db.exec('ALTER TABLE sessions ADD COLUMN tool_version TEXT');
  if (!scols.includes('url')) db.exec('ALTER TABLE sessions ADD COLUMN url TEXT');
  const mcols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes('parent')) db.exec('ALTER TABLE messages ADD COLUMN parent TEXT');
  if (!mcols.includes('replaced_by')) db.exec('ALTER TABLE messages ADD COLUMN replaced_by TEXT');
  const ecols = (db.prepare('PRAGMA table_info(evidence)').all() as { name: string }[]).map((c) => c.name);
  if (!ecols.includes('replaces')) db.exec("ALTER TABLE evidence ADD COLUMN replaces TEXT NOT NULL DEFAULT '[]'");

  const all = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).all(...args) as Row[];
  const get = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).get(...args) as Row | undefined;
  const run = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).run(...args);

  const toSession = (r: Row): Session & { file: string | null; cursor: number; extractedUpto: number; excluded: boolean; toolVersion: string | null; url: string | null } => ({
    id: r.id as string, source: r.source as Session['source'], label: r.label as string,
    projectId: (r.project_id as string) ?? null, cwd: (r.cwd as string) ?? null, title: (r.title as string) ?? null,
    coverage: r.coverage as Session['coverage'], file: (r.file as string) ?? null,
    cursor: Number(r.cursor), extractedUpto: Number(r.extracted_upto),
    excluded: Number(r.excluded) === 1, toolVersion: (r.tool_version as string) ?? null, url: (r.url as string) ?? null,
  });
  const toMessage = (r: Row): Message => ({
    id: r.id as string, sessionId: r.session_id as string, seq: Number(r.seq), role: r.role as Role,
    text: r.text as string, ts: (r.ts as string) ?? null, capturedAt: r.captured_at as string,
    parent: (r.parent as string) ?? null, replacedBy: (r.replaced_by as string) ?? null,
  });
  const toEvidence = (r: Row): StoredEvidence => ({
    id: r.id as string, projectId: r.project_id as string, taskId: r.task_id as string,
    kind: r.kind as StoredEvidence['kind'], cite: JSON.parse(r.cite as string), speaker: r.speaker as Role,
    detail: r.detail as string, reason: (r.reason as string) ?? null, at: r.at as string, order: Number(r.ord),
    downgraded: (r.downgraded as string) ?? null, replaces: JSON.parse((r.replaces as string) ?? '[]'), model: r.model as string, promptVersion: r.prompt_version as string,
  });

  // 可重入：只有最外层开始和提交事务，里层直接执行（SQLite 不允许事务嵌套）
  let depth = 0;
  const tx = <T>(fn: () => T): T => {
    if (depth > 0) return fn();
    db.exec('BEGIN');
    depth++;
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
  };

  return {
    raw: db,
    tx,

    createProject(p: { name: string; goal: string | null; dirs: string[] }): string {
      const id = shortId('p_');
      tx(() => {
        run('INSERT INTO projects (id, name, goal, created_at) VALUES (?, ?, ?, ?)', id, p.name, p.goal, now());
        for (const dir of p.dirs) run('INSERT OR IGNORE INTO project_dirs (project_id, dir) VALUES (?, ?)', id, dir);
      });
      return id;
    },
    addProjectDir(projectId: string, dir: string) {
      run('INSERT OR IGNORE INTO project_dirs (project_id, dir) VALUES (?, ?)', projectId, dir);
    },
    listProjects() {
      return all('SELECT id, name, goal, created_at, paused, remote_ok FROM projects ORDER BY created_at').map((r) => ({
        id: r.id as string, name: r.name as string, goal: (r.goal as string) ?? null,
        paused: Number(r.paused) === 1, remoteOk: Number(r.remote_ok) === 1,
        dirs: all('SELECT dir FROM project_dirs WHERE project_id = ?', r.id as string).map((d) => d.dir as string),
      }));
    },
    getProject(id: string) {
      return this.listProjects().find((p) => p.id === id) ?? null;
    },
    /** 目录本身或它的子目录绑定到哪个项目。取最长匹配。 */
    projectForDir(dir: string): string | null {
      const rows = all('SELECT project_id, dir FROM project_dirs');
      const hit = rows
        .filter((r) => dir === r.dir || dir.startsWith((r.dir as string).replace(/\/$/, '') + sep))
        .sort((a, b) => (b.dir as string).length - (a.dir as string).length)[0];
      return hit ? (hit.project_id as string) : null;
    },
    setPaused(id: string, paused: boolean) {
      run('UPDATE projects SET paused = ? WHERE id = ?', paused ? 1 : 0, id);
    },
    setRemoteOk(id: string, ok: boolean) {
      run('UPDATE projects SET remote_ok = ? WHERE id = ?', ok ? 1 : 0, id);
    },
    isPaused(id: string): boolean {
      return Number(get('SELECT paused FROM projects WHERE id = ?', id)?.paused ?? 0) === 1;
    },
    usageSummary(projectId: string): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of all('SELECT kind, COUNT(*) AS c FROM usage_events WHERE project_id = ? GROUP BY kind', projectId)) out[r.kind as string] = Number(r.c);
      return out;
    },
    deleteProject(id: string) {
      tx(() => {
        run('DELETE FROM evidence WHERE project_id = ?', id); // 显式删，和级联结果一致
        run('DELETE FROM projects WHERE id = ?', id);
      });
    },

    upsertSession(s: Session & { file?: string | null; toolVersion?: string | null; url?: string | null }) {
      run(
        `INSERT INTO sessions (id, source, label, project_id, cwd, title, coverage, file, tool_version, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, cwd = excluded.cwd,
           title = COALESCE(excluded.title, sessions.title), coverage = excluded.coverage, file = COALESCE(excluded.file, sessions.file),
           tool_version = COALESCE(excluded.tool_version, sessions.tool_version), url = COALESCE(excluded.url, sessions.url),
           project_id = COALESCE(sessions.project_id, excluded.project_id)`,
        s.id, s.source, s.label, s.projectId, s.cwd, s.title, s.coverage, s.file ?? null, s.toolVersion ?? null, s.url ?? null,
      );
    },
    getSession(id: string) {
      const r = get('SELECT * FROM sessions WHERE id = ?', id);
      return r ? toSession(r) : null;
    },
    sessionsForProject(projectId: string) {
      return all('SELECT * FROM sessions WHERE project_id = ?', projectId).map(toSession);
    },
    unassignedSessions() {
      return all('SELECT * FROM sessions WHERE project_id IS NULL').map(toSession);
    },
    assignSession(sessionId: string, projectId: string) {
      run('UPDATE sessions SET project_id = ? WHERE id = ?', projectId, sessionId);
    },
    /** 重新整理模型提取的证据；MCP 已直接入库，保留其引用证据和整理游标，任务登记与人工修正也保留。 */
    resetExtraction(projectId: string) {
      tx(() => {
        run(`DELETE FROM evidence WHERE project_id = ? AND NOT EXISTS (
          SELECT 1 FROM json_each(evidence.cite) ref
          JOIN messages m ON m.id = ref.value
          JOIN sessions s ON s.id = m.session_id
          WHERE s.source = 'mcp'
        )`, projectId);
        run('DELETE FROM batches WHERE project_id = ?', projectId);
        run("UPDATE sessions SET extracted_upto = -1 WHERE project_id = ? AND source <> 'mcp'", projectId);
      });
    },
    /** 把误归类的会话移出项目：删掉它的消息和引用了这些消息的证据；会话标记为已移出，之后同步不再读它。 */
    excludeSession(projectId: string, sessionId: string) {
      const ids = new Set(all('SELECT id FROM messages WHERE session_id = ?', sessionId).map((r) => r.id as string));
      tx(() => {
        for (const e of all('SELECT id, cite FROM evidence WHERE project_id = ?', projectId)) {
          if ((JSON.parse(e.cite as string) as string[]).some((id) => ids.has(id))) run('DELETE FROM evidence WHERE id = ?', e.id as string);
        }
        run('DELETE FROM messages WHERE session_id = ?', sessionId);
        run('DELETE FROM batches WHERE session_id = ?', sessionId);
        run('UPDATE sessions SET project_id = NULL, excluded = 1 WHERE id = ? AND project_id = ?', sessionId, projectId);
      });
    },
    /** 读进来了但还没整理的消息条数。 */
    unextractedCount(projectId: string): number {
      return Number(get('SELECT COUNT(*) AS c FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.project_id = ? AND m.seq > s.extracted_upto AND m.replaced_by IS NULL', projectId)?.c ?? 0);
    },
    latestToolVersion(source: string): string | null {
      return (get('SELECT tool_version FROM sessions WHERE source = ? AND tool_version IS NOT NULL ORDER BY rowid DESC LIMIT 1', source)?.tool_version as string) ?? null;
    },
    setCursor(sessionId: string, cursor: number) {
      run('UPDATE sessions SET cursor = ? WHERE id = ?', cursor, sessionId);
    },
    setExtractedUpto(sessionId: string, seq: number) {
      // 只能前进：已整理的位置不会因为处理顺序而倒退
      run('UPDATE sessions SET extracted_upto = MAX(extracted_upto, ?) WHERE id = ?', seq, sessionId);
    },

    /** 按来源编号去重写入，返回新增条数。 */
    insertMessages(msgs: Message[]): number {
      const stmt = db.prepare('INSERT OR IGNORE INTO messages (id, session_id, seq, role, text, ts, captured_at, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      return tx(() => msgs.reduce((n, m) => n + Number(stmt.run(m.id, m.sessionId, m.seq, m.role, m.text, m.ts, m.capturedAt, m.parent ?? null).changes), 0));
    },
    /** 标记旧版本：被哪条新版本替代。已经标过的不改。 */
    markReplaced(ids: string[], by: string) {
      const stmt = db.prepare('UPDATE messages SET replaced_by = ? WHERE id = ? AND replaced_by IS NULL AND id <> ?');
      tx(() => ids.forEach((id) => stmt.run(by, id, by)));
    },
    /**
     * 认出改过重发的分叉：同一段会话里，同一个上级下挂着多条用户提问时，最晚的那条是当前版本；
     * 更早的那条，以及它到新提问之间的回复（被放弃的分支），都标为旧版本。会话文件只追加，这一段正好夹在两条提问中间。
     * 可以重复跑。
     */
    detectBranches(sessionId: string) {
      const msgs = this.messagesForSession(sessionId);
      const groups = new Map<string, Message[]>();
      for (const m of msgs) if (m.role === 'user' && m.parent) groups.set(m.parent, [...(groups.get(m.parent) ?? []), m]);
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const sorted = [...g].sort((a, b) => a.seq - b.seq);
        const latest = sorted[sorted.length - 1];
        for (const old of sorted.slice(0, -1)) {
          this.markReplaced(msgs.filter((m) => m.seq >= old.seq && m.seq < latest.seq).map((m) => m.id), latest.id);
        }
      }
    },
    maxSeq(sessionId: string): number {
      return Number(get('SELECT COALESCE(MAX(seq), -1) AS s FROM messages WHERE session_id = ?', sessionId)?.s ?? -1);
    },
    messagesForSession(sessionId: string, afterSeq = -1) {
      return all('SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, afterSeq).map(toMessage);
    },
    messagesForProject(projectId: string) {
      return all(
        'SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.project_id = ? ORDER BY COALESCE(m.ts, m.captured_at), m.seq',
        projectId,
      ).map(toMessage);
    },
    messagesByIds(ids: string[], projectId?: string) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => '?').join(',');
      if (!projectId) return all(`SELECT * FROM messages WHERE id IN (${marks})`, ...ids).map(toMessage);
      return all(`SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id IN (${marks}) AND s.project_id = ?`, ...ids, projectId).map(toMessage);
    },

    /**
     * 把任务移到别的项目。一段会话里可能有好几个任务，所以不整段挪：这个任务引用的消息复制一份到目标项目，
     * 证据改指向复制品，针对这个任务的修正一起带走。复制过去的会话标为已整理，免得同步时重复整理；
     * 它没有对应的源文件，读取器本来就不会碰它。
     */
    moveTask(fromProject: string, taskId: string, toProject: string): string {
      const rec = this.tasksForProject(fromProject).find((t) => t.id === taskId);
      if (!rec) throw new Error('任务不属于这个项目');
      const fromName = this.getProject(fromProject)?.name ?? '另一个项目';
      return tx(() => {
        const newId = this.addTask({ projectId: toProject, name: rec.name, goal: rec.goal, createdAt: rec.createdAt });
        const evs = this.evidenceForProject(fromProject).filter((e) => e.taskId === taskId);
        const msgs = this.messagesByIds([...new Set(evs.flatMap((e) => e.cite))], fromProject);
        const copyId = (id: string) => `${id}@${toProject}`;
        for (const sid of new Set(msgs.map((m) => m.sessionId))) {
          const src = this.getSession(sid)!;
          const dst = `mv-${sid}-${toProject}`;
          this.upsertSession({ id: dst, source: src.source, label: `${src.label}（从「${fromName}」移来）`, projectId: toProject, cwd: src.cwd, title: src.title, coverage: src.coverage, url: src.url });
        }
        this.insertMessages(msgs.map((m) => ({ ...m, id: copyId(m.id), sessionId: `mv-${m.sessionId}-${toProject}` })));
        for (const sid of new Set(msgs.map((m) => m.sessionId))) this.setExtractedUpto(`mv-${sid}-${toProject}`, this.maxSeq(`mv-${sid}-${toProject}`));
        for (const e of evs) {
          run('UPDATE evidence SET project_id = ?, task_id = ?, cite = ? WHERE id = ?', toProject, newId, JSON.stringify(e.cite.map(copyId)), e.id);
        }
        for (const c of this.correctionsForProject(fromProject)) {
          const body = c.correction as Record<string, unknown>;
          if (body.taskId !== taskId) continue;
          run('UPDATE corrections SET project_id = ?, body = ? WHERE id = ?', toProject, JSON.stringify({ ...body, taskId: newId }), c.id);
        }
        return newId;
      });
    },

    addTask(t: Omit<TaskRecord, 'id'>): string {
      const n = Number(get('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?', t.projectId)?.c ?? 0) + 1;
      const id = `${t.projectId}/T${String(n).padStart(2, '0')}`;
      run('INSERT INTO tasks (id, project_id, name, goal, created_at) VALUES (?, ?, ?, ?, ?)', id, t.projectId, t.name, t.goal, t.createdAt);
      return id;
    },
    tasksForProject(projectId: string): TaskRecord[] {
      return all('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id', projectId).map((r) => ({
        id: r.id as string, projectId: r.project_id as string, name: r.name as string, goal: (r.goal as string) ?? null, createdAt: r.created_at as string,
      }));
    },

    addEvidence(list: StoredEvidence[], batchKey: string | null = null) {
      const stmt = db.prepare(
        `INSERT INTO evidence (id, project_id, task_id, kind, cite, speaker, detail, reason, at, ord, downgraded, model, prompt_version, batch_key, replaces)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      tx(() => {
        for (const e of list) {
          stmt.run(e.id, e.projectId, e.taskId, e.kind, JSON.stringify(e.cite), e.speaker, e.detail, e.reason, e.at, e.order, e.downgraded, e.model, e.promptVersion, batchKey, JSON.stringify(e.replaces ?? []));
        }
      });
    },
    evidenceCount(projectId: string): number {
      return Number(get('SELECT COUNT(*) AS c FROM evidence WHERE project_id = ?', projectId)?.c ?? 0);
    },
    /** MCP 受阻自报保留 need 原文，包括首尾空白；不改变证据种类和引用。 */
    setEvidenceReason(projectId: string, evidenceId: string, reason: string) {
      run('UPDATE evidence SET reason = ? WHERE project_id = ? AND id = ?', reason, projectId, evidenceId);
    },
    /** 轮询只取聚合值，不加载项目视图或解析证据正文。 */
    projectStamp(projectId: string): string {
      const row = get(`SELECT COUNT(*) AS evidence_count, COALESCE(MAX(at), '') AS latest_at,
        (SELECT COUNT(*) FROM corrections WHERE project_id = ?) AS correction_count
        FROM evidence WHERE project_id = ?`, projectId, projectId)!;
      return `${row.evidence_count}:${row.correction_count}:${row.latest_at}`;
    },
    evidenceForProject(projectId: string): StoredEvidence[] {
      return all('SELECT * FROM evidence WHERE project_id = ? ORDER BY at, ord', projectId).map(toEvidence);
    },

    batchDone(key: string) {
      return get("SELECT status FROM batches WHERE key = ? AND status = 'ok'", key) !== undefined;
    },
    recordBatch(b: { key: string; projectId: string; sessionId: string; uptoSeq: number; status: 'ok' | 'failed'; error?: string }) {
      run(
        `INSERT INTO batches (key, project_id, session_id, upto_seq, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status, error = excluded.error`,
        b.key, b.projectId, b.sessionId, b.uptoSeq, b.status, b.error ?? null, now(),
      );
    },
    failedBatches(projectId: string) {
      return all("SELECT key, session_id, error FROM batches WHERE project_id = ? AND status = 'failed'", projectId);
    },

    addCorrection(projectId: string, c: Correction): string {
      const id = shortId('c_');
      run('INSERT INTO corrections (id, project_id, at, body) VALUES (?, ?, ?, ?)', id, projectId, now(), JSON.stringify(c));
      return id;
    },
    correctionsForProject(projectId: string): CorrectionRecord[] {
      return all('SELECT * FROM corrections WHERE project_id = ? ORDER BY at, id', projectId).map((r) => ({
        id: r.id as string, projectId: r.project_id as string, at: r.at as string, correction: JSON.parse(r.body as string),
      }));
    },

    /** 改正导入对话里认错的发言者。改的是原始记录，同时留一条修正记录。 */
    setMessageRole(projectId: string, messageId: string, role: Role) {
      run('UPDATE messages SET role = ? WHERE id = ?', role, messageId);
      this.addCorrection(projectId, { type: 'set_role', messageId, role });
    },

    logUsage(projectId: string | null, kind: string) {
      run('INSERT INTO usage_events (project_id, kind, at) VALUES (?, ?, ?)', projectId, kind, now());
    },

    counts() {
      const c = (t: string) => Number(get(`SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0);
      return { projects: c('projects'), sessions: c('sessions'), messages: c('messages'), tasks: c('tasks'), evidence: c('evidence'), corrections: c('corrections') };
    },
  };
}
