// 终端里的项目现场。颜色只在真终端里用；输出到文件、管道，或者设了 NO_COLOR，就是纯文字。
import { readFileSync } from 'node:fs';
import { STATUS_LABEL, type ProjectView, type TaskStatus } from './contracts.ts';

export interface Opts {
  color: boolean;
}

export const useColor = (): boolean => !process.env.NO_COLOR && !!process.stdout.isTTY;

const paint = (code: string, s: string, o: Opts) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string, o: Opts) => paint('1', s, o);
const dim = (s: string, o: Opts) => paint('2', s, o);
const COLOR: Record<TaskStatus, string> = { done: '32', doing: '34', to_verify: '33', todo: '37', blocked: '31', cancelled: '2;9', pending_confirm: '2' };
const ORDER: TaskStatus[] = ['to_verify', 'blocked', 'doing', 'todo', 'pending_confirm', 'done'];
const chip = (s: TaskStatus, o: Opts) => paint(COLOR[s], `■ ${STATUS_LABEL[s].padEnd(3, '　')}`, o);
const short = (id: string) => id.split('/').at(-1)!;

/** 像素 logo：直接读 web/logo.svg 的方块，用半格字符（▀）两行拼一行画出来。没有颜色时不画。 */
export function renderLogo(o: Opts): string {
  if (!o.color) return '';
  const svg = readFileSync(new URL('../web/logo.svg', import.meta.url), 'utf8');
  const grid: (string | null)[][] = Array.from({ length: 16 }, () => new Array(16).fill(null));
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)"[^>]*fill="#([0-9A-Fa-f]{6})"/g)) grid[Number(m[2])][Number(m[1])] = m[3];
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 2) {
    let line = '';
    for (let x = 0; x < 16; x++) {
      const top = grid[y][x], bottom = grid[y + 1][x];
      if (!top && !bottom) line += ' ';
      else if (top && bottom) line += `\x1b[38;2;${rgb(top)};48;2;${rgb(bottom)}m▀\x1b[0m`;
      else if (top) line += `\x1b[38;2;${rgb(top)}m▀\x1b[0m`;
      else line += `\x1b[38;2;${rgb(bottom!)}m▄\x1b[0m`;
    }
    rows.push(line);
  }
  return rows.join('\n');
}

export function renderScene(project: { name: string; goal: string | null; paused?: boolean }, v: ProjectView, o: Opts): string {
  const out: string[] = [];
  out.push(bold(project.name, o) + (project.paused ? dim('  · 已暂停采集', o) : ''));
  out.push(`${dim('目标', o)}  ${project.goal ?? '还没填写'}`);
  const plan = v.plan.versions.at(-1);
  const planLine = plan
    ? plan.items.map((i) => (i.change === 'cancelled' ? paint('2;9', i.name, o) : i.change === 'added' ? `${i.name}${dim('（新增）', o)}` : i.name)).join('、')
    : '已读取的记录里没有明确规划';
  out.push(`${dim('规划', o)}  ${plan ? `第 ${plan.n} 版${plan.backfilled ? '（后补）' : ''}：` : ''}${planLine}`);
  if (v.lastPosition) out.push(`${dim('上次', o)}  ${v.lastPosition.label} · ${v.lastPosition.text.replace(/\s+/g, ' ').slice(0, 56)}`);
  if (v.coverageWarning) out.push(paint('33', '注意：有来源只读到一部分，结论只基于已读到的内容', o));
  out.push('');
  const active = v.tasks.filter((t) => t.status !== 'cancelled').sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  out.push(bold(`任务 · ${active.length} 项`, o));
  for (const t of active) out.push(`  ${chip(t.status, o)} ${short(t.id)} ${t.name}  ${dim(t.blocker ? `缺：${t.blocker}` : t.basisNote, o)}`);
  if (!active.length) out.push(dim('  还没有任务。同步整理之后会从对话里长出来', o));
  const cancelled = v.tasks.filter((t) => t.status === 'cancelled');
  if (cancelled.length) out.push(dim(`  不要做：${cancelled.map((t) => t.name).join('、')}`, o));
  out.push('');
  out.push(bold('下一步', o));
  v.next.forEach((n, i) => {
    out.push(`  ${paint('35', String(i + 1), o)}. ${n.action}  ${dim(n.reason, o)}`);
    if (n.precondition !== '无') out.push(dim(`     前置条件：${n.precondition}`, o));
  });
  if (!v.next.length) out.push(dim('  暂时没有可推荐的下一步', o));
  if (v.pending.length) out.push('', paint('33', `待确认 ${v.pending.length} 条：在窗口里处理（crew app）`, o));
  const firstTask = v.next[0] ?? null;
  out.push('', dim(firstTask ? `接着做：crew context --task ${short(firstTask.taskId)}    打开窗口：crew app` : '打开窗口：crew app', o));
  return out.join('\n');
}

export function renderHome(items: { project: { id: string; name: string }; view: ProjectView }[], o: Opts): string {
  const out: string[] = [];
  const logo = renderLogo(o);
  if (logo) out.push(logo.split('\n').map((l, i) => (i === 3 ? `${l}   ${bold('Crew', o)}` : i === 4 ? `${l}   ${dim('your local agent workbench', o)}` : l)).join('\n'), '');
  else out.push('Crew', '');
  if (!items.length) {
    out.push('还没有项目。', '', '  crew demo                                  用示例数据看看效果', '  crew project add "项目名" --dir <代码目录>   用在自己的项目上');
    return out.join('\n');
  }
  for (const { project, view } of items) {
    const c = view.counts;
    const parts = (['to_verify', 'blocked', 'doing', 'todo', 'done'] as TaskStatus[]).filter((s) => c[s]).map((s) => paint(COLOR[s], `${STATUS_LABEL[s]} ${c[s]}`, o));
    out.push(`  ${bold(project.name, o)}  ${parts.join(dim(' · ', o)) || dim('还没有任务', o)}${view.pending.length ? paint('33', `  待确认 ${view.pending.length}`, o) : ''}`);
    if (view.next[0]) out.push(dim(`    下一步：${view.next[0].action}`, o));
  }
  out.push('', dim('  crew show     在终端看项目现场（在项目目录里不用写 --project）', o), dim('  crew app      打开窗口', o), dim('  crew help     全部命令', o));
  return out.join('\n');
}
