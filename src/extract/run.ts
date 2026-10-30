// 证据整理流程。循环、分批、重试都在代码里，大模型每批只做一次判断。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Message, Session } from '../contracts.ts';
import { ExtractionOutput, STATUS_LABEL } from '../contracts.ts';
import type { Db } from '../db.ts';
import { storeEvidence, ms, timeOf } from './validate.ts';
import type { ModelCall } from './model.ts';
import { ModelError } from './model.ts';
import { buildProjectView } from '../engine/view.ts';
import { truncate } from '../ingest/common.ts';

const PROMPT = readFileSync(new URL('../../prompts/evidence.md', import.meta.url), 'utf8');
export const PROMPT_VERSION = PROMPT.match(/version:\s*([\w.-]+)/)?.[1] ?? 'unknown';
const SYSTEM = PROMPT.replace(/<!--[\s\S]*?-->\s*/, '');

// ponytail: 按字数切批，是为了控制单次调用的成本和耗时；换成长上下文模型时可以调大
const DEFAULT_MAX_CHARS = 12_000;
const AI_MAX = 1_500; // AI 的长回复多是代码和过程，保留开头和结尾

const shortTask = (id: string) => id.split('/').at(-1)!;
const when = (iso: string | null) => (iso ? new Date(ms(iso)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知');

function clip(m: Message): string {
  if (m.role !== 'assistant' || m.text.length <= AI_MAX) return m.text;
  return `${m.text.slice(0, AI_MAX - 400)}\n…[中间省略 ${m.text.length - AI_MAX} 字]…\n${m.text.slice(-400)}`;
}

export function buildPrompt(db: Db, projectId: string, session: Session, msgs: Message[]) {
  const project = db.getProject(projectId)!;
  const view = buildProjectView(db, projectId);
  const plan = view.plan.versions.at(-1);
  const refs = new Map<string, Message>();
  const lines = msgs.map((m, i) => {
    const ref = `m${i + 1}`;
    refs.set(ref, m);
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '工具报错';
    return `[${ref}] ${who} · ${when(m.ts)}\n${truncate(clip(m), 3_000)}`;
  });
  const renamed = db.correctionsForProject(projectId).map((c) => c.correction).filter((c) => c.type === 'rename' || c.type === 'merge');
  // 已有的、还有效的决定，编号 D1、D2……让模型在推翻旧决定时指回去
  const live = view.decisions.filter((d) => (d.kind === 'adopt' || d.kind === 'reject') && !d.supersededBy);
  const decisionRefs = new Map(live.map((d, i) => [`D${i + 1}`, d.evidenceId]));
  const user = [
    `项目：${project.name}`,
    `项目目标：${project.goal ?? '未填写'}`,
    `当前规划：${plan ? plan.items.filter((i) => i.change !== 'cancelled').map((i) => i.name).join('、') : '还没有'}`,
    '已有任务（引用时用编号）：',
    ...(view.tasks.length ? view.tasks.map((t) => `- ${shortTask(t.id)} ${t.name}（${STATUS_LABEL[t.status]}）`) : ['- 还没有']),
    ...(renamed.length ? ['用户做过的修正（必须遵守）：', ...renamed.map((c) => `- ${JSON.stringify(c)}`)] : []),
    ...(live.length ? ['已有决定（被推翻时在 replaces 里用编号）：', ...live.map((d, i) => `- D${i + 1} ${d.kind === 'adopt' ? '采用' : '否决'}：${d.text}`)] : []),
    `来源：${session.label}${session.title ? `「${session.title}」` : ''} · 覆盖：${session.coverage === 'partial' ? '部分，前文没有加载' : '完整'}`,
    '消息：',
    ...lines,
  ].join('\n');
  return { system: SYSTEM, user, refs, decisionRefs };
}

function chunks(msgs: Message[], maxChars: number): Message[][] {
  const out: Message[][] = [];
  let cur: Message[] = [];
  let size = 0;
  for (const m of msgs) {
    const len = Math.min(clip(m).length, 3_000);
    if (cur.length && size + len > maxChars) { out.push(cur); cur = []; size = 0; }
    cur.push(m);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface ExtractResult {
  batches: number;
  stored: number;
  dropped: { why: string }[];
  failed: number;
  errors: string[];
}

/** 整理一批。失败时对半拆开重试，拆到一条消息还失败才算失败。 */
async function runBatch(db: Db, projectId: string, model: ModelCall, session: Session, msgs: Message[], res: ExtractResult): Promise<boolean> {
  res.batches++;
  const key = createHash('sha1').update([session.id, msgs[0].id, msgs.at(-1)!.id, msgs.length, PROMPT_VERSION, model.name].join('|')).digest('hex');
  const upto = msgs.at(-1)!.seq;
  if (db.batchDone(key)) {
    db.setSkippedBySince(msgs.map((m) => m.id), false);
    db.setExtractedUpto(session.id, upto);
    return true;
  }

  const { system, user, refs, decisionRefs } = buildPrompt(db, projectId, db.getSession(session.id)!, msgs);
  let evidence: unknown[] | null = null;
  let lastError = '';
  let fatal = false;
  for (let attempt = 0; attempt < 2 && evidence === null; attempt++) { // 格式不对时带着错误重试一次
    const prompt = attempt === 0 ? user : `${user}\n\n上一次的输出不符合要求：${lastError}\n请只输出符合格式的 JSON。`;
    let raw: string;
    try {
      raw = await model.call(system, prompt);
    } catch (e) {
      lastError = (e as Error).message;
      if (e instanceof ModelError && !e.retryable) { fatal = true; break; }
      continue;
    }
    try {
      const parsed = ExtractionOutput.safeParse(JSON.parse(raw));
      if (parsed.success) evidence = parsed.data.evidence;
      else lastError = parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}：${x.message}`).join('；');
    } catch {
      lastError = '不是合法的 JSON';
    }
  }
  if (evidence === null) {
    // 长批次容易被截断：拆成两半再试（密钥无效、余额不足这类错误拆了也没用）
    if (!fatal && msgs.length > 1) {
      const mid = Math.ceil(msgs.length / 2);
      res.batches--;
      return (await runBatch(db, projectId, model, session, msgs.slice(0, mid), res)) && runBatch(db, projectId, model, session, msgs.slice(mid), res);
    }
    res.failed++;
    res.errors.push(`${session.label}${session.title ? `「${session.title}」` : ''}：${lastError}`);
    db.recordBatch({ key, projectId, sessionId: session.id, uptoSeq: upto, status: 'failed', error: lastError });
    return false;
  }
  // 模型用短编号回答已有任务，这里换回完整编号
  const mapped = evidence.map((e: any) => (e?.task?.id && !String(e.task.id).includes('/') ? { ...e, task: { id: `${projectId}/${e.task.id}` } } : e));
  const r = storeEvidence(db, projectId, mapped, refs, { model: model.name, promptVersion: PROMPT_VERSION, batchKey: key, decisionRefs });
  res.stored += r.stored.length;
  res.dropped.push(...r.dropped.map((d) => ({ why: d.why })));
  db.recordBatch({ key, projectId, sessionId: session.id, uptoSeq: upto, status: 'ok' });
  db.setSkippedBySince(msgs.map((m) => m.id), false);
  db.setExtractedUpto(session.id, upto);
  return true;
}

/** since（毫秒时间戳）：跳过之前的消息并记下标记；带 since 时补整理范围内的标记消息，不带时只整理新消息。 */
export async function extractProject(db: Db, projectId: string, model: ModelCall, opts: { maxChars?: number; since?: number; onBatch?: (i: number, n: number) => void } = {}): Promise<ExtractResult> {
  const res: ExtractResult = { batches: 0, stored: 0, dropped: [], failed: 0, errors: [] };
  if (opts.since !== undefined) {
    for (const s of db.sessionsForProject(projectId)) {
      const pending = db.messagesForSession(s.id, s.extractedUpto);
      const old = pending.filter((m) => m.ts && ms(m.ts) < opts.since!).at(-1);
      if (old) db.tx(() => {
        // 游标跨过的未整理消息一起留标记，避免时间戳与消息顺序不一致时漏掉消息。
        db.setSkippedBySince(pending.filter((m) => m.seq <= old.seq && !m.replacedBy).map((m) => m.id), true);
        db.setExtractedUpto(s.id, old.seq);
      });
    }
  }
  // 各会话的补整理消息和新消息一起切批。同一会话内严格按消息顺序；不同会话之间按时间交错，
  // 这样任务清单按事情发生的顺序长出来
  const queues = db.sessionsForProject(projectId)
    .map((s) => {
      const skipped = opts.since === undefined ? [] : db.messagesSkippedBySince(s.id)
        .filter((m) => m.seq <= s.extractedUpto && m.ts && ms(m.ts) >= opts.since!);
      const msgs = [...skipped, ...db.messagesForSession(s.id, s.extractedUpto)].filter((m) => !m.replacedBy);
      return chunks(msgs, opts.maxChars ?? DEFAULT_MAX_CHARS).map((msgs) => ({ session: s, msgs }));
    })
    .filter((q) => q.length > 0);
  const work: { session: Session; msgs: Message[] }[] = [];
  while (queues.some((q) => q.length > 0)) {
    const live = queues.filter((q) => q.length > 0);
    const earliest = live.reduce((a, b) => (ms(timeOf(b[0].msgs[0])) < ms(timeOf(a[0].msgs[0])) ? b : a));
    work.push(earliest.shift()!);
  }

  for (const [i, { session, msgs }] of work.entries()) {
    opts.onBatch?.(i + 1, work.length);
    const ok = await runBatch(db, projectId, model, session, msgs, res);
    if (!ok) break; // 后面的批次依赖前面的任务清单，失败就停在这里，下次从这里继续
  }
  return res;
}
