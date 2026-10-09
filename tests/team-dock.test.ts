import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser modules have no TypeScript declarations; exercise their actual exports.
import { teamProgress, dockMembers } from '../web/team-dock.js';

test('footer progress counts accepted tasks and reports offline observations honestly', () => {
  const snapshot = { run: { mode: 'codex-team' }, nativeTasks: [{ state: 'accepted' }, { state: 'submitted' }, { state: 'running' }] };
  assert.deepEqual(teamProgress(snapshot, true), { accepted: 1, total: 3, ratio: 1 / 3, label: '已验收 1/3' });
  assert.match(teamProgress(snapshot, false).label, /最后观测/);
  assert.equal(teamProgress({ run: { mode: 'codex-team' }, nativeTasks: [] }, true).ratio, 0);
  assert.equal(teamProgress({}, true).label, '尚未启动');
});
test('footer distinguishes child activity, pending approval, input and cancellation from completion', () => {
  const snapshot = { run: { mode: 'codex-team' }, agents: [{ threadId: 'child', name: '<img onerror=alert(1)>', state: 'waiting_input' }] };
  assert.equal(dockMembers(snapshot, true)[0].label, '等待输入');
  assert.equal(dockMembers(snapshot, false)[0].label, '连接中断 · 最后观测');
  const legacy = { members: [{ id: 'codex', sessionId: 'worker', connection: 'ready' }], tasks: [{ assignee: 'codex', state: 'cancel_requested' }], approvals: [] as any[] };
  assert.equal(dockMembers(legacy, true)[0].state, 'interrupt_requested');
  legacy.approvals.push({ threadId: 'worker', state: 'pending' });
  assert.equal(dockMembers(legacy, true)[0].state, 'waiting_approval');
});
