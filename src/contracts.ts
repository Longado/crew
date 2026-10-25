// 各模块之间的约定。改这里要通知所有人。
import { z } from 'zod';

// ---------- 采集层产出 ----------

export type Source = 'claude_code' | 'codex' | 'vscode' | 'import' | 'mcp';
export type Role = 'user' | 'assistant' | 'tool_error';

/** 统一消息。id 用来源自带的稳定编号，重复同步靠它去重。 */
export interface Message {
  id: string; // cc:<uuid> | cx:<会话编号>:<ordinal> | im:<指纹>
  sessionId: string;
  seq: number; // 会话内顺序
  role: Role;
  text: string;
  ts: string | null; // 原始时间，拿不到就是 null，不伪造
  capturedAt: string; // 采集时间
  parent?: string | null; // 上级消息（Claude Code 的 parentUuid），用来认出改过重发的分叉
  replacedBy?: string | null; // 被哪条新版本替代；旧版本保留但不再参与判断
}

export type Coverage = 'full' | 'partial';

export interface Session {
  id: string;
  source: Source;
  label: string; // 给人看的来源名：Claude Code / Codex / Gemini 网页 / 手动导入
  projectId: string | null; // null 表示待归类
  cwd: string | null;
  title: string | null;
  coverage: Coverage; // 网页只加载了一部分时是 partial
}

// ---------- 大模型产出：证据 ----------

export const EvidenceKind = z.enum([
  'plan_item', // 用户提出或确认的规划条目
  'plan_add', // 规划变更：新增
  'plan_cancel', // 规划变更：取消，不再做
  'started', // 开始执行
  'ai_claims_done', // AI 说做完了
  'user_confirms_done', // 用户确认做完、可用
  'failure', // 报告失败、退回、打不开
  'blocked', // 受阻：缺输入、缺凭证、缺依赖
  'unblocked', // 阻塞解除
  'decision_adopt', // 采用某个方案
  'decision_reject', // 否决某个方案
  'out_of_scope', // 范围外的新想法
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** 证据指向哪个任务。none 表示和具体任务无关（比如项目级决定），unknown 表示拿不准。 */
export const TaskRef = z.union([
  z.object({ id: z.string() }),
  z.object({ newName: z.string().min(1), goal: z.string().optional() }),
  z.literal('unknown'),
  z.literal('none'),
]);
export type TaskRef = z.infer<typeof TaskRef>;

export const Evidence = z.object({
  reasoning: z.string(), // 判断理由，放在最前
  task: TaskRef,
  kind: EvidenceKind,
  cite: z.array(z.string()).min(1), // 引用的消息编号（提示词里的短编号）
  detail: z.string(), // 一句话
  reason: z.string().optional(), // 决定、取消的原因；原文没说就不填，页面显示“未说明”
  replaces: z.array(z.string()).optional(), // 新决定推翻了哪些旧决定：本批的消息编号（m3）或提示词里的决定编号（D2）
});
export type Evidence = z.infer<typeof Evidence>;

export const ExtractionOutput = z.object({ evidence: z.array(Evidence) });

/** 校验之后入库的证据。task 已经解析成任务编号或 unknown/none。 */
export interface StoredEvidence {
  id: string;
  projectId: string;
  taskId: string | 'unknown' | 'none';
  kind: EvidenceKind;
  cite: string[]; // 消息 id
  speaker: Role; // 由代码从被引用的消息里取，不让大模型判断
  detail: string;
  reason: string | null;
  at: string; // 被引用消息里最晚的时间，用来排序
  order: number; // 同一时间内的先后
  downgraded: string | null; // 被代码降级时写明原因
  replaces?: string[]; // “e:<证据编号>”或“m:<消息编号>”；旧数据没有这个字段
  model: string;
  promptVersion: string;
}

/** 任务登记。名字和目标来自第一次出现它的证据。 */
export interface TaskRecord {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  createdAt: string;
}

// ---------- 人工修正 ----------

export type Correction =
  | { type: 'rename'; taskId: string; name: string }
  | { type: 'merge'; from: string; into: string }
  | { type: 'set_status'; taskId: string; status: TaskStatus; note?: string }
  | { type: 'assign'; evidenceId: string; taskId: string }
  | { type: 'confirm_condition'; taskId: string; condition: string }
  | { type: 'dismiss_next'; key: string }
  | { type: 'backfill_plan'; taskIds: string[] }
  | { type: 'set_role'; messageId: string; role: Role }
  | { type: 'ack'; evidenceId: string }; // 待确认事项已处理

export interface CorrectionRecord {
  id: string;
  projectId: string;
  at: string;
  correction: Correction;
}

// ---------- 记忆引擎产出 ----------

export type TaskStatus =
  | 'pending_confirm'
  | 'todo'
  | 'doing'
  | 'to_verify'
  | 'done'
  | 'blocked'
  | 'cancelled';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending_confirm: '待确认',
  todo: '待开始',
  doing: '进行中',
  to_verify: '待验证',
  done: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
};

/** 依据类型：用户确认 / 原文明确 / AI 自述 / 人工修正 */
export type Basis = 'user' | 'text' | 'ai' | 'manual';

export interface StatusChange {
  at: string;
  from: TaskStatus | null;
  to: TaskStatus;
  evidenceId: string | null; // 人工修正时为 null
  basis: Basis;
  note: string;
}

export interface TaskView {
  id: string;
  name: string;
  goal: string | null;
  doneCondition: string | null;
  doneConditionConfirmed: boolean;
  status: TaskStatus;
  basis: Basis;
  basisNote: string;
  basisEvidenceId: string | null;
  inPlan: boolean;
  blocker: string | null;
  sessions: string[];
  history: StatusChange[];
  lastAt: string;
  evidenceIds: string[]; // 实际折叠进这个任务的证据（合并、改派之后）
}

export interface PlanItem {
  taskId: string;
  name: string;
  change: 'kept' | 'added' | 'cancelled';
}
export interface PlanVersion {
  n: number;
  at: string;
  backfilled: boolean;
  items: PlanItem[];
  evidenceIds: string[];
}

export interface Decision {
  evidenceId: string;
  kind: 'adopt' | 'reject' | 'cancel';
  text: string;
  reason: string | null; // null 显示为“未说明”
  at: string;
  supersededBy: string | null; // 被哪条新决定替代（证据编号）
}

export interface PendingItem {
  kind: 'unknown_task' | 'conflict' | 'source_conflict' | 'ai_suggestion';
  evidenceId: string;
  text: string;
  taskId?: string;
  suggestedStatus?: TaskStatus; // 冲突时新证据指向的状态
}

export interface NextStep {
  key: string; // 用于驳回后不再推荐
  taskId: string;
  action: string;
  reason: string;
  doneStandard: string;
  precondition: string; // 动手之前要先满足什么；没有就是“无”
  evidenceId: string | null;
}

export interface ProjectView {
  tasks: TaskView[];
  plan: { versions: PlanVersion[]; noPlan: boolean };
  decisions: Decision[];
  ideas: { evidenceId: string; text: string }[];
  pending: PendingItem[];
  next: NextStep[];
  counts: Record<TaskStatus, number>;
  doneEvents: { at: string; taskId: string }[]; // 每次进入已完成记一次，按天统计由页面做
  coverageWarning: boolean; // 有来源只读到一部分
  lastPosition: LastPosition | null;
}

export interface LastPosition {
  at: string;
  sessionId: string;
  label: string;
  title: string | null;
  text: string;
  taskId: string | null;
}
