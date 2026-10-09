import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamSession } from '../src/team/session.ts';
import { createDemoWorkbench } from '../src/team/demo.ts';
import { renderTeamScreen, textWidth, displayText } from '../src/team/screen.ts';
import { tmpdir } from 'node:os';

test('terminal frames fit desktop and narrow terminals with Chinese, combining marks and emoji', async () => {
  assert.equal(textWidth('中文👩🏽‍💻e\u0301'), 7);
  const session = createTeamSession({ cwd: tmpdir(), mode: 'codex-team', access: 'read-only', demo: true, workbench: createDemoWorkbench() });
  try {
    await session.submit('检查中文与 emoji 👩🏽‍💻');
    for (const [columns, rows] of [[100, 30], [42, 16], [20, 8], [4, 3]]) {
      const frame = renderTeamScreen(session.view(), { columns: columns!, rows: rows!, input: '很长的输入'.repeat(20), cursor: 100 });
      assert.equal(frame.lines.length, rows); assert.ok(frame.lines.every(line => textWidth(line) <= columns! - 1));
      assert.ok(frame.cursorRow <= rows!); assert.ok(frame.cursorColumn < columns!);
    }
  } finally { await session.close(); }
});

test('terminal rendering blocks escape injection and masks private answers', async () => {
  assert.equal(displayText('\x1b]52;c;malicious\x07safe\x1b[2J\r\b'), 'safe');
  const session = createTeamSession({ cwd: tmpdir(), mode: 'codex-team', access: 'read-only' });
  try {
    const view = session.view(); view.prompt.secret = true; view.notice = '\x1b[2J\x1b]0;fake title\x07Visible';
    const frame = renderTeamScreen(view, { columns: 60, rows: 14, input: 'dummy-private-note', cursor: 18 });
    assert.equal(frame.text.includes('dummy-private-note'), false); assert.match(frame.text, /\*{5}/);
    assert.equal(/[\x00-\x1f\x7f]/.test(frame.text.replace(/\n/g, '')), false);
  } finally { await session.close(); }
});

test('terminal progress counts acceptance, leaves completed work unaccepted and supports scrolling', async () => {
  const session = createTeamSession({ cwd: tmpdir(), mode: 'codex-team', access: 'read-only' });
  try {
    const view = session.view();
    view.snapshot.run = { id: 'r', mode: 'codex-team', cwd: tmpdir(), goal: 'Inspect', access: 'read-only' };
    view.snapshot.nativeTasks = [{ id: 'a', title: 'A', files: [], acceptance: ['Check'], state: 'accepted', reviews: [] }, { id: 'b', title: 'B', files: [], acceptance: ['Check'], state: 'submitted', reviews: [] }];
    view.snapshot.messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), from: 'codex', to: 'user', state: 'transport_written', createdAt: '', text: `Message ${i}` }));
    const latest = renderTeamScreen(view, { columns: 80, rows: 14, input: '', cursor: 0 });
    const older = renderTeamScreen(view, { columns: 80, rows: 14, input: '', cursor: 0, scroll: 15 });
    assert.match(latest.text, /TEAM 1\/2 已验收/); assert.notEqual(latest.text, older.text); assert.equal(older.scroll, 15);
  } finally { await session.close(); }
});

test('narrow terminal retains access, directory identity, selected state, hidden member count and quit hint', async () => {
  const session = createTeamSession({ cwd: tmpdir(), mode: 'codex-team', access: 'read-only', demo: true, workbench: createDemoWorkbench() });
  try {
    await session.submit('Inspect'); const view = session.view();
    view.snapshot.run!.cwd = '/Users/example/Workspace/projects/my-current-project';
    const frame = renderTeamScreen(view, { columns: 42, rows: 16, input: '', cursor: 0 });
    assert.match(frame.lines[0]!, /只读/); assert.match(frame.lines[1]!, /my-current-project/);
    assert.match(frame.lines.at(-3)!, /待命/); assert.match(frame.lines.at(-3)!, /\+1$/);
    assert.match(frame.lines.at(-2)!, /\/quit 退出/);
    assert.ok(frame.lines.every(line => textWidth(line) <= 41));
  } finally { await session.close(); }
});
