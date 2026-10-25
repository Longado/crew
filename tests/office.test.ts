// 办公室：任务摆到最近一次变化发生的那段对话的来源桌上；文字一律转义。
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 浏览器脚本没有类型声明；直接测它导出的函数
import { seats, officeHtml } from '../web/office.js';

const task = (id: string, name: string, status: string, evidenceIds: (string | null)[]) => ({
  id: `p/${id}`, name, status, blocker: status === 'blocked' ? '缺设计稿' : null,
  history: evidenceIds.map((evidenceId) => ({ evidenceId })),
});
const data = {
  sessions: [
    { id: 'p:cc-1', label: 'Claude Code', source: 'claude_code' },
    { id: 'p:cc-10', label: 'Gemini 网页', source: 'import' },
    { id: 'p:cx-1', label: 'Codex', source: 'codex' },
    { id: 'p:mc', label: 'Codex（从「旧项目」移来）', source: 'mcp' },
  ],
  evidence: {
    e1: { session: 'p:cc-1', cite: ['p:cc-1:m1'], speaker: 'assistant', at: '2026-09-10T10:00:00Z' },
    e2: { session: 'p:cx-1', cite: ['p:cx-1:m2'], speaker: 'assistant', at: '2026-09-12T10:00:00Z' },
    e3: { session: 'p:cc-1', cite: ['p:cc-1:m3'], speaker: 'user', at: '2026-09-11T10:00:00Z' },
    e4: { session: 'p:cc-10', cite: ['p:cc-10:m1'], speaker: 'user', at: '2026-09-01T10:00:00Z' },
    e5: { session: 'p:mc', cite: ['p:mc:m1'], speaker: 'assistant', at: '2026-09-12T09:00:00Z' },
  },
  view: {
    tasks: [
      task('T01', '月度导出', 'to_verify', ['e2']),
      task('T02', '分类统计', 'doing', ['e3']), // 用户在 Claude Code 里说开工，也算 Claude Code 桌上
      task('T03', '云同步', 'cancelled', ['e1']),
      task('T04', '记账录入', 'to_verify', ['e1', null]), // 最后一次是人工改的，往前找出处
      task('T05', '图表页', 'blocked', ['e5']),
    ],
    plan: { versions: [{ n: 2, items: [{ taskId: 'p/T01', name: '月度导出', change: 'kept' }, { taskId: 'p/T03', name: '云同步', change: 'cancelled' }] }] },
    lastPosition: { label: 'Claude Code', text: '设计稿还没给' },
  },
};

test('tasks sit at the desk of the conversation where they last moved', () => {
  const byName = Object.fromEntries(seats(data).map((d: any) => [d.name, d]));
  assert.deepEqual(Object.keys(byName), ['Claude Code', 'Gemini 网页', 'Codex']);
  assert.deepEqual(byName['Codex'].asks.map((t: any) => t.name), ['月度导出']);
  assert.deepEqual(byName['Codex'].blocks.map((t: any) => t.name), ['图表页']); // 移来的会话坐回同一张桌
  assert.equal(byName['Codex'].selfReport, true);
  assert.deepEqual(byName['Claude Code'].doing.map((t: any) => t.name), ['分类统计']);
  assert.deepEqual(byName['Claude Code'].asks.map((t: any) => t.name), ['记账录入']);
  assert.equal(byName['Claude Code'].state, 'waiting_approval');
  // Gemini 十几天没动静，睡着了
  assert.equal(byName['Gemini 网页'].asks.length + byName['Gemini 网页'].doing.length, 0);
  assert.equal(byName['Gemini 网页'].state, 'closed');
});

test('office markup escapes task and source names and skips cancelled plan items', () => {
  const hostile = structuredClone(data);
  hostile.sessions[2].label = 'Codex<img src=x onerror=alert(1)>';
  hostile.view.tasks[0].name = '<script>x</script>';
  const html = officeHtml(hostile, 'p', { asks: 3 });
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /等你<b>3<\/b>/);
  assert.doesNotMatch(html, /云同步<\/span>/);
});
