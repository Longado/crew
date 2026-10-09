import { stripVTControlCharacters } from 'node:util';
import type { TeamView } from './session.ts';

const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const graphemes = (text: string) => [...segments.segment(text)].map(s => s.segment);
export function displayText(text: string): string {
  return stripVTControlCharacters(String(text)).replace(/\r\n/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
function cells(g: string) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\ufe0f/u.test(g)) return 2;
  const c = g.codePointAt(0)!;
  return (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe19) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000)) ? 2 : /^\p{Mark}+$/u.test(g) ? 0 : 1;
}
export const textWidth = (text: string) => graphemes(displayText(text)).reduce((n, g) => n + cells(g), 0);
export function clip(text: string, width: number) {
  let result = '', count = 0;
  for (const g of graphemes(displayText(text).replace(/\n/g, ' '))) { if (count + cells(g) > width) break; result += g; count += cells(g); }
  return result;
}
function clipEnd(text: string, width: number) {
  const out: string[] = []; let count = 0;
  for (const g of graphemes(displayText(text).replace(/\n/g, ' ')).reverse()) { if (count + cells(g) > width) break; out.push(g); count += cells(g); }
  return out.reverse().join('');
}
export function wrap(text: string, width: number) {
  return displayText(text).split('\n').flatMap(line => {
    const out: string[] = []; let row = '', n = 0;
    for (const g of graphemes(line)) { if (n + cells(g) > width && row) { out.push(row); row = ''; n = 0; } row += g; n += cells(g); }
    out.push(row); return out;
  });
}
const STATES: Record<string, string> = { idle: '待命', starting: '启动中', running: '执行中', completed: '本轮完成', waiting_approval: '等审批', waiting_input: '等回答', interrupt_requested: '等待中断确认', interrupted: '已中断', failed: '失败', closed: '已结束', unknown: '待核对', ready: '就绪', disconnected: '未连接', connecting: '连接中', error: '异常', stopped: '已停止' };

/** Fixed-height plain-text frame, with terminal-width-aware Chinese/emoji clipping. */
export function renderTeamScreen(view: TeamView, options: { columns: number; rows: number; input: string; cursor: number; scroll?: number }) {
  const width = Math.max(1, options.columns - 1), height = Math.max(1, options.rows), area = height - 6;
  if (height < 6) {
    const lines = Array.from({ length: height }, (_, i) => i === 0 ? clip('请放大终端窗口', width) : '');
    return { lines, text: lines.join('\n'), cursorRow: height, cursorColumn: 1, scroll: 0, totalLines: 0 };
  }
  const { snapshot: s } = view, run = s.run, native = run?.mode === 'codex-team';
  const out: string[] = [], member = s.agents?.find(a => a.threadId === view.selected);
  if (s.error) out.push(`运行异常：${s.error}`);
  if (s.setup?.command) out.push(`连接 Claude：在另一个终端执行\n${s.setup.command}`);
  if (view.detail) {
    out.push(`源目录：${run?.cwd || ''}\n执行目录：${run?.workerCwd || '准备中'}\n基线：${run?.baselinePath || '只读，无副本'}`);
    for (const t of native ? s.nativeTasks || [] : s.tasks || []) out.push(`任务：${t.title} · ${t.state}\n文件：${t.files.join('、') || '只读 / 说明'}\n验收：${t.acceptance.join('；')}`);
  }
  if (!native || !member?.parentThreadId) for (const m of s.messages.slice(-30)) out.push(`${m.from === 'user' ? '你' : m.from} → ${m.to === 'user' ? '你' : m.to} [${m.state}]\n${m.text}`);
  if (member) {
    out.push(`${member.name} · ${STATES[member.state] || member.state}${member.step ? `：${member.step}` : ''}`);
    for (const event of member.events.slice(-15)) out.push(event.text);
    if (member.output && view.detail) out.push(`成果：\n${member.output}`);
    if (member.diff && view.detail) out.push(`变更：\n${member.diff}`);
  }
  for (const a of view.approvals) out.push(`${a.slot} 等待审批 · ${a.threadId}\n${a.detail}\n/approve ${a.slot} y|n|c`);
  for (const q of view.inputs) out.push(`${q.slot} 等待回答 · ${q.questions.map(q => q.header).join('、')}  /answer ${q.slot}`);
  if (view.prompt.question) {
    const q = view.prompt.question; out.push(q.question);
    q.options?.forEach((o, i) => out.push(`${i + 1}. ${o.label}：${o.description}`));
    if (q.isSecret) out.push('此项输入会隐藏，回答不会加入本地对话记录。');
  }
  out.push(view.notice);
  const all = out.flatMap(line => wrap(line, width));
  const scroll = Math.max(0, Math.min(options.scroll || 0, Math.max(0, all.length - area)));
  const end = all.length - scroll, content = all.slice(Math.max(0, end - area), end);
  while (content.length < area) content.push('');
  const tasks = native ? s.nativeTasks || [] : s.tasks || [], accepted = tasks.filter(t => t.state === 'accepted').length;
  let bar = `TEAM ${accepted}/${tasks.length} 已验收`;
  const ordered = [...view.members].sort((a, b) => Number(b.id === view.selected) - Number(a.id === view.selected));
  let shown = 0;
  for (const [i, a] of ordered.entries()) {
    const remainder = ordered.length - i - 1, tail = remainder ? ` +${remainder}` : '';
    const head = ` | ${a.id === view.selected ? '>' : ''}${a.slot}`, state = `:${STATES[a.state] || a.state}`;
    const name = native ? a.name.replace(/^Codex\s+/, '') : a.name;
    const availableName = width - textWidth(bar + head + state + tail) - 1;
    const label = shown ? name : clip(name, Math.max(0, availableName));
    const token = head + (label ? ` ${label}` : '') + state;
    if (shown && textWidth(bar + token + tail) > width) break;
    bar += token; shown++;
  }
  if (shown < ordered.length) bar += ` +${ordered.length - shown}`;
  const prefix = clip(view.prompt.label, Math.floor(width / 2)), available = Math.max(1, width - textWidth(prefix) - 1);
  const input = graphemes(options.input).map(g => view.prompt.secret ? '*' : g === '\n' ? '↵' : displayText(g));
  const cursor = Math.max(0, Math.min(options.cursor, input.length));
  let start = cursor, used = 0;
  while (start > 0 && used + cells(input[start - 1]!) <= available - 1) { used += cells(input[--start]!); }
  const shownInput = clip((start ? '<' : '') + input.slice(start).join(''), available);
  const cursorColumn = 1 + textWidth(prefix) + textWidth((start ? '<' : '') + input.slice(start, cursor).join(''));
  const lines = [
    `Crew · ${run?.access === 'workspace-write' ? '修改隔离副本' : '只读'}${view.demo ? ' · 演示（无模型）' : ''} · ${STATES[s.status] || s.status}`,
    `项目：${textWidth(run?.cwd || s.projectId.replace(/^cli:/, '')) > width - 6 ? `...${clipEnd(run?.cwd || s.projectId.replace(/^cli:/, ''), width - 9)}` : run?.cwd || s.projectId.replace(/^cli:/, '')}`,
    `目标：${run?.goal || '输入后开始'}`,
    ...content, bar,
    view.busy ? '处理中 · Ctrl+D 退出' : scroll ? 'PgUp/PgDn 翻阅 · /quit 退出' : width < 65 ? 'Tab 成员 · F2 详情 · /quit 退出' : 'Tab 成员 · F2 详情 · /help · /quit 退出',
    prefix + shownInput,
  ].map(line => clip(line, width));
  return { lines, text: lines.join('\n'), cursorRow: height, cursorColumn: Math.min(width, cursorColumn), scroll, totalLines: all.length };
}
