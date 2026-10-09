import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePicks, withPicks } from '../web/workspace.js';

test('四宫格 → 单窗 → 四宫格：原来那四个会话和顺序都回来', () => {
  let picks = restorePicks({ layout: 'grid', selected: ['c', 'd', 'e', 'f'] }); // 旧存档只有 selected
  assert.deepEqual(picks.grid, ['c', 'd', 'e', 'f']);
  picks = withPicks(picks, 'grid', ['c', 'd', 'e', 'f']);
  picks = withPicks(picks, 'single', ['c']); // 在单窗里点了 c
  assert.deepEqual(picks.grid, ['c', 'd', 'e', 'f']);
  assert.deepEqual(picks.single, ['c']);
});

test('withPicks 返回新对象，不改原来的', () => {
  const before = restorePicks({});
  const after = withPicks(before, 'split', ['a', 'b']);
  assert.deepEqual(before.split, []);
  assert.deepEqual(after.split, ['a', 'b']);
});

test('新存档按布局分开读，坏数据丢掉', () => {
  const picks = restorePicks({ layout: 'split', selected: ['x'], picks: { grid: ['a', 'b', 7, null], split: 'oops', single: ['a'], huge: ['z'] } });
  assert.deepEqual(picks.grid, ['a', 'b']);
  assert.deepEqual(picks.split, []); // 不是数组就当没有
  assert.deepEqual(picks.single, ['a']);
  assert.equal('huge' in picks, false);
});
