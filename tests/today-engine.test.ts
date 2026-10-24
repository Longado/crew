import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { buildToday } from '../src/engine/today.ts';
import type { TaskSnapshot } from '../src/today/source.ts';

test('source status is preserved while paused projects and stale tasks wait for review', () => {
  const db = openDb(':memory:');
  try {
    const base = { projectId: 1, projectName: '示例', projectStatus: 'active', status: 'todo' as const, priority: 'high' as const, dueDate: null, updatedAt: '2026-10-20' };
    const snapshot: TaskSnapshot = { version: 1, refreshedAt: '2026-10-20T01:00:00Z', tasks: [
      { ...base, sourceId: 1, title: '普通事项' },
      { ...base, sourceId: 2, title: '有截止日期的事项', dueDate: '2026-10-21' },
      { ...base, sourceId: 3, title: '已暂停的事项', projectStatus: 'paused' },
      { ...base, sourceId: 4, title: '较久未更新', updatedAt: '2026-09-20' },
      { ...base, sourceId: 5, title: '已归档的事项', projectStatus: 'archived' },
    ] };
    const result = buildToday(db, { snapshot, sourceConfigured: true, now: new Date('2026-10-20T02:00:00Z'), timeZone: 'Asia/Taipei' });
    assert.deepEqual(result.suggested.map(item => item.sourceId), [2, 1]);
    assert.deepEqual(result.pending.map(item => item.sourceId).sort(), [3, 4, 5]);
    assert.equal(result.pending.every(item => item.status === 'todo' && item.holdReason), true);
    assert.equal(result.source.label, '外部任务库 · 只读快照');
    assert.equal(db.counts().tasks, 0);
  } finally { db.raw.close(); }
});

test('tasks due near today come first, nearest first, and staleness does not hide upcoming ones', () => {
  const db = openDb(':memory:');
  try {
    const base = { projectId: 1, projectName: '示例', projectStatus: 'active', status: 'todo' as const, priority: 'medium' as const, updatedAt: '2026-10-24' };
    const snapshot: TaskSnapshot = { version: 1, refreshedAt: '2026-10-26T01:00:00Z', tasks: [
      { ...base, sourceId: 11, title: '进行中但下月才到期', status: 'doing', dueDate: '2026-11-20' },
      { ...base, sourceId: 12, title: '后天到期', dueDate: '2026-10-28' },
      { ...base, sourceId: 13, title: '三天后到期、久未更新', dueDate: '2026-10-29', updatedAt: '2026-10-06' },
      { ...base, sourceId: 14, title: '昨天到期、刚更新过', dueDate: '2026-10-25' },
      { ...base, sourceId: 15, title: '两周前到期、久未更新', dueDate: '2026-10-12', updatedAt: '2026-10-06' },
      { ...base, sourceId: 16, title: '第七天到期、久未更新', dueDate: '2026-11-02', updatedAt: '2026-10-06' },
      { ...base, sourceId: 17, title: '第八天到期、久未更新', dueDate: '2026-11-03', updatedAt: '2026-10-06' },
      { ...base, sourceId: 18, title: '十一天前到期、刚更新过', dueDate: '2026-10-15' },
    ] };
    const result = buildToday(db, { snapshot, sourceConfigured: true, now: new Date('2026-10-26T01:00:00Z'), timeZone: 'Asia/Shanghai' });
    assert.deepEqual(result.suggested.map(item => item.sourceId), [14, 12, 13]);
    assert.deepEqual(result.remaining.map(item => item.sourceId), [16, 11, 18]);
    assert.equal(result.suggested[0].overdueDays, 1);
    assert.equal(result.suggested[1].overdueDays, undefined);
    assert.equal(result.remaining[2].overdueDays, 11);
    const held = new Map(result.pending.map(item => [item.sourceId, item.holdReason]));
    assert.deepEqual([...held.keys()].sort(), [15, 17]);
    assert.match(held.get(15)!, /已逾期 14 天/);
    assert.match(held.get(17)!, /超过 14 天未更新/);
  } finally { db.raw.close(); }
});

test('today completion uses the local day and excludes prior-day completions', () => {
  const db = openDb(':memory:');
  try {
    const projectId = db.createProject({ name: '事项', dirs: [], goal: null });
    const taskId = db.addTask({ projectId, name: '跨日完成', goal: null, createdAt: '2026-10-19T01:00:00Z' });
    const correctionId = db.addCorrection(projectId, { type: 'set_status', taskId, status: 'done' });
    db.raw.prepare('UPDATE corrections SET at=? WHERE id=?').run('2026-10-19T16:30:00Z', correctionId);
    assert.equal(buildToday(db, { now: new Date('2026-10-20T01:00:00Z'), timeZone: 'Asia/Taipei' }).completed.length, 1);
    assert.equal(buildToday(db, { now: new Date('2026-10-21T01:00:00Z'), timeZone: 'Asia/Taipei' }).completed.length, 0);
  } finally { db.raw.close(); }
});

test('source-number search is exact rather than matching a longer task number', () => {
  const db = openDb(':memory:');
  try {
    const snapshot: TaskSnapshot = { version: 1, refreshedAt: '2026-10-20T01:00:00Z', tasks: [17, 170].map(sourceId => ({
      sourceId, projectId: 1, projectName: '测试项目', projectStatus: 'active', title: '任务', status: 'todo', priority: 'medium', dueDate: null, updatedAt: '2026-10-20',
    })) };
    const result = buildToday(db, { snapshot, sourceConfigured: true, query: '#17', now: new Date('2026-10-20T01:00:00Z') });
    assert.equal(result.matchingTasks, 1);
    assert.equal(result.suggested[0].sourceId, 17);
  } finally { db.raw.close(); }
});
