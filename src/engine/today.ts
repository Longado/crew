import type { Db } from '../db.ts';
import type { TaskStatus } from '../contracts.ts';
import { buildProjectView } from './view.ts';
import type { TaskSnapshot } from '../today/source.ts';

export interface TodayItem {
  projectId: string;
  projectName: string;
  taskId: string;
  name: string;
  status: TaskStatus;
  action: string;
  reason: string;
  precondition: string;
  doneStandard: string;
  updatedAt: string;
  sourceId?: number;
  sourceKind?: 'workspace';
  sourceUpdatedAt?: string;
  priority?: string;
  dueDate?: string | null;
  holdReason?: string;
}

const priority: Record<TaskStatus, number> = { to_verify: 0, doing: 1, todo: 2, blocked: 3, pending_confirm: 4, done: 5, cancelled: 6 };
const reasons: Record<TaskStatus, string> = {
  to_verify: '先核对已有产出，确认是否达到完成条件',
  doing: '已有任务在进行，优先接着做',
  todo: '尚未开始，按已有规划顺序安排',
  blocked: '先处理等待条件，再继续执行',
  pending_confirm: '需要先确认这是否是要做的任务',
  done: '已确认完成',
  cancelled: '已取消',
};

/** Read only the supplied Crew database. No discovery, imports, model or execution. */
export function buildToday(db: Db, { now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  snapshot, sourceConfigured = false, query = '' }: {
    now?: Date; timeZone?: string; snapshot?: TaskSnapshot; sourceConfigured?: boolean; query?: string;
  } = {}) {
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (value: string | Date) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = dateFormat.formatToParts(date);
    const part = (type: string) => parts.find(p => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const date = day(now);
  const projects = db.listProjects();
  const rows: { item: TodayItem; recommended: boolean; planIndex: number; completedToday: boolean }[] = [];
  for (const project of projects) {
    const view = buildProjectView(db, project.id);
    for (const task of view.tasks) {
      const next = view.next.find(step => step.taskId === task.id);
      const blocker = task.basis === 'manual' && !/^你在 .* 手动改为/.test(task.basisNote) ? task.basisNote : task.blocker;
      const action = next?.action ?? ({
        to_verify: `验证「${task.name}」`, doing: `继续「${task.name}」`, todo: `开始「${task.name}」`,
        blocked: `确认并解除「${task.name}」的阻塞`, pending_confirm: `确认「${task.name}」是否需要开展`,
        done: '已完成', cancelled: '已取消',
      }[task.status]);
      const index = view.planOrder.indexOf(task.id);
      rows.push({
        item: {
          projectId: project.id, projectName: project.name, taskId: task.id, name: task.name, status: task.status,
          action,
          reason: next ? `${reasons[task.status]}；${next.reason}` : reasons[task.status],
          precondition: task.status === 'blocked' ? (blocker || '等待条件尚未说明，请补充')
            : task.status === 'pending_confirm' ? '先确认任务范围和完成条件'
            : next?.precondition ?? '无',
          doneStandard: next?.doneStandard ?? task.doneCondition ?? '按你的标准确认可用后，再确认完成',
          updatedAt: [task.lastAt, ...task.history.map(h => h.at)].sort().at(-1)!,
        },
        recommended: !!next && ['to_verify', 'doing', 'todo'].includes(task.status),
        planIndex: index < 0 ? Number.MAX_SAFE_INTEGER : index,
        completedToday: task.status === 'done' && day(task.history.filter(h => h.to === 'done').at(-1)?.at ?? '') === date,
      });
    }
  }
  for (const task of snapshot?.tasks ?? []) {
    const age = (Date.parse(date) - Date.parse(task.updatedAt.slice(0, 10))) / 86_400_000;
    const projectState = ({ paused: '已暂停', archived: '已归档', done: '已结束' } as Record<string, string>)[task.projectStatus];
    const holdReason = projectState ? `所属项目${projectState}，先确认是否恢复`
      : task.projectStatus !== 'active' ? '所属项目状态不明确，先确认是否开展'
      : !Number.isFinite(age) || age > 14 ? '超过 14 天未更新或更新时间不明，先核对当前进度' : undefined;
    const due = task.dueDate ? `；截止日期：${task.dueDate}` : '';
    rows.push({
      item: {
        projectId: `workspace:${task.projectId ?? 'unassigned'}`, projectName: task.projectName,
        taskId: `workspace:${task.sourceId}`, name: task.title, status: task.status,
        sourceId: task.sourceId, sourceKind: 'workspace', sourceUpdatedAt: task.updatedAt,
        priority: task.priority, dueDate: task.dueDate, holdReason,
        action: holdReason ? '核对来源进度后，再决定是否纳入今日安排'
          : task.status === 'blocked' ? '先查清等待条件，再继续这项任务'
          : `${task.status === 'doing' ? '继续' : task.status === 'to_verify' ? '验收' : task.status === 'pending_confirm' ? '确认' : '推进'}：${task.title}`,
        reason: holdReason ?? `${reasons[task.status]}${due}`,
        precondition: holdReason ?? (task.status === 'blocked' ? '外部任务库标为受阻，未提供具体等待条件'
          : task.status === 'pending_confirm' ? '先确认任务范围' : '未从任务字段发现等待条件；执行前仍需核对项目交接'),
        doneStandard: '外部任务库没有独立的完成条件字段，请以任务要求和项目交接为准',
        updatedAt: task.updatedAt,
      },
      recommended: !holdReason && ['todo', 'doing', 'to_verify'].includes(task.status),
      planIndex: Number.MAX_SAFE_INTEGER,
      completedToday: false,
    });
  }
  const urgency: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const dueKey = (item: TodayItem) => item.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? item.dueDate : '9999-12-31';
  rows.sort((a, b) => priority[a.item.status] - priority[b.item.status]
    || dueKey(a.item).localeCompare(dueKey(b.item))
    || (urgency[a.item.priority ?? 'medium'] - urgency[b.item.priority ?? 'medium'])
    || (a.item.status === 'todo' ? a.planIndex - b.planIndex : b.item.updatedAt.localeCompare(a.item.updatedAt))
    || a.item.projectId.localeCompare(b.item.projectId) || a.item.taskId.localeCompare(b.item.taskId));
  const term = query.trim().toLocaleLowerCase();
  const sourceNumber = /^#\d+$/.test(term) ? Number(term.slice(1)) : undefined;
  const matching = rows.filter(({ item }) => sourceNumber !== undefined ? item.sourceId === sourceNumber
    : !term || `${item.name} ${item.projectName} ${item.taskId}`.toLocaleLowerCase().includes(term));
  const suggested = matching.filter(row => row.recommended).slice(0, 3).map(row => row.item);
  const selected = new Set(suggested.map(item => item.taskId));
  return {
    date, timeZone, generatedAt: now.toISOString(),
    source: {
      kind: sourceConfigured ? 'workspace_snapshot' : 'local_corpus',
      label: sourceConfigured ? '外部任务库 · 只读快照' : '当前 Crew 本地任务库',
      configured: sourceConfigured, automatic: false, refreshedAt: snapshot?.refreshedAt ?? null,
      importedCount: snapshot?.tasks.length ?? 0,
    },
    projects: projects.map(({ id, name }) => ({ id, name })),
    totalTasks: rows.length, matchingTasks: matching.length, query: term,
    suggested,
    remaining: matching.filter(({ item }) => !item.holdReason && ['to_verify', 'doing', 'todo'].includes(item.status) && !selected.has(item.taskId)).map(row => row.item),
    blocked: matching.filter(row => !row.item.holdReason && row.item.status === 'blocked').map(row => row.item),
    pending: matching.filter(row => row.item.holdReason || row.item.status === 'pending_confirm').map(row => row.item),
    completed: matching.filter(row => row.completedToday).map(row => row.item),
  };
}
