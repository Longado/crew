import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnPty } from 'node-pty';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { codexTeamFixture } from './helpers/codex-team-fixture.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const messageInput = (text: string) => [{ type: 'text', text: `Human input for this Crew run. Keep the existing goal, file ownership, sandbox and acceptance boundaries unless explicitly changed by the human:\n${text}` }];
async function until(check: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Crew input transition test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function terminal() {
  const f = codexTeamFixture(), env = { ...process.env, PATH: `${f.directory}:${process.env.PATH}`, CORPUS_HOME: join(f.directory, 'data') } as Record<string, string>;
  const pty = spawnPty(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', f.directory, '--goal', 'Inspect fixture'], { cwd: repo, env, name: 'xterm-256color', cols: 100, rows: 26 });
  let raw = '', pending = '', frame = '', code: number | undefined;
  pty.onData(data => {
    raw += data; pending += data;
    // PTY output may split anywhere; inspect only fully received frames.
    const frames = [...pending.matchAll(/\x1b\[H([\s\S]*?)\x1b\[\d+;\d+H/g)], last = frames.at(-1);
    if (last) { frame = stripVTControlCharacters(last[1]!).replace(/\r/g, ''); pending = pending.slice(last.index! + last[0].length); }
  });
  pty.onExit(exit => { code = exit.exitCode; });
  const records = () => existsSync(f.log) ? readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return {
    write: (text: string) => pty.write(text), prompt: () => frame.split('\n').at(-1) || '', raw: () => raw, records, idle: () => !frame.includes('处理中 · Ctrl+D 退出'),
    ready: () => until(() => frame.includes('Q1 等待回答') && frame.includes('A1 等待审批') && frame.endsWith('Codex 负责人 › ') && !frame.includes('处理中 · Ctrl+D 退出')),
    async close() {
      if (code !== undefined) { assert.equal(code, 0); return; }
      try { pty.write('\x04'); await until(() => code !== undefined); assert.equal(code, 0); }
      finally { if (code === undefined) pty.kill(); }
    },
  };
}

test('same-write private answer and text after leaving the answer retain every character in 20 PTY runs', { timeout: 120000 }, async t => {
  for (let trial = 1; trial <= 20; trial++) await t.test(`private answer trial ${trial}`, { timeout: 15000 }, async () => {
    const ui = terminal(), answer = 'fixture-private-note', message = 'After private answer';
    try {
      await ui.ready();
      ui.write(`/answer Q1\r${answer}`);
      await until(() => ui.prompt().startsWith('Private fixture note › ') && ui.prompt().includes('***'));
      assert.equal(ui.raw().includes(answer), false, 'private answer must stay masked');
      ui.write(`\r${message}`);
      await until(() => ui.records().some(m => m.id === 500 && m.result));
      assert.deepEqual(ui.records().find(m => m.id === 500 && m.result).result.answers, { note: { answers: [answer] } });
      await until(() => ui.prompt().endsWith('private answer') && ui.idle());
      assert.equal(ui.prompt(), `Checker › ${message}`, 'text after the answer belongs to the ordinary message prompt');
      ui.write('\r');
      await until(() => ui.records().some(m => m.method === 'turn/steer'));
      const sent = ui.records().find(m => m.method === 'turn/steer');
      assert.equal(sent.params.threadId, 'worker');
      assert.deepEqual(sent.params.input, messageInput(message));
      assert.equal(ui.raw().includes(answer), false, 'submitted private answer must not reappear');
    } finally { await ui.close(); }
  });
});

test('same-write member command and ordinary message retain every character in 20 PTY runs', { timeout: 120000 }, async t => {
  for (let trial = 1; trial <= 20; trial++) await t.test(`member message trial ${trial}`, { timeout: 15000 }, async () => {
    const ui = terminal(), message = 'Inspect empty case';
    try {
      await ui.ready();
      ui.write(`/member M2\r${message}`);
      await until(() => ui.prompt().startsWith('Checker › ') && ui.prompt().endsWith('empty case'));
      ui.write('\r');
      await until(() => ui.records().some(m => m.method === 'turn/steer'));
      const sent = ui.records().find(m => m.method === 'turn/steer');
      assert.equal(sent.params.threadId, 'worker');
      assert.equal(sent.params.expectedTurnId, 'worker-turn');
      assert.deepEqual(sent.params.input, messageInput(message));
    } finally { await ui.close(); }
  });
});

test('cancel clears private text before accepting same-write message text and re-entry starts empty', { timeout: 15000 }, async () => {
  const ui = terminal();
  try {
    await ui.ready();
    ui.write('/member M2\r'); await until(() => ui.prompt() === 'Checker › ');
    ui.write('member draft\t'); await until(() => ui.prompt() === 'Codex 负责人 › ');
    ui.write('/answer Q1\r'); await until(() => ui.prompt() === 'Private fixture note › ');
    ui.write('unsubmitted-private-text'); await until(() => ui.prompt().endsWith('*'.repeat(24)));
    ui.write('\x15/cancel\r appended'); await until(() => ui.prompt().endsWith('appended'));
    assert.equal(ui.prompt(), 'Checker › member draft appended');
    assert.equal(ui.records().some(m => m.id === 500 && m.result), false, 'cancel must not submit the private draft');
    ui.write('\x15/answer Q1\r'); await until(() => ui.prompt() === 'Private fixture note › ');
    assert.equal(ui.raw().includes('unsubmitted-private-text'), false);
  } finally { await ui.close(); }
});

test('member switching restores the old draft and cursor before inserting same-write text', { timeout: 15000 }, async () => {
  const ui = terminal();
  try {
    await ui.ready();
    ui.write('old-draft\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\t');
    await until(() => ui.prompt() === 'Checker › ');
    ui.write('/member M1\rnew-'); await until(() => ui.prompt().endsWith('w-draft'));
    assert.equal(ui.prompt(), 'Codex 负责人 › old-new-draft');
    ui.write('\tworker-draft'); await until(() => ui.prompt() === 'Checker › worker-draft');
    ui.write('\t'); await until(() => ui.prompt() === 'Codex 负责人 › old-new-draft');
  } finally { await ui.close(); }
});

test('approval followed by a same-write message preserves text while awaiting the fixture response', { timeout: 15000 }, async () => {
  const ui = terminal(), message = 'After approval';
  try {
    await ui.ready();
    ui.write('/member M2\r'); await until(() => ui.prompt() === 'Checker › ');
    ui.write(`/approve A1 n\r${message}`);
    await until(() => ui.records().some(m => m.id === 501 && m.result));
    assert.deepEqual(ui.records().find(m => m.id === 501 && m.result).result, { decision: 'decline' });
    await until(() => ui.prompt().endsWith('approval') && ui.idle());
    assert.equal(ui.prompt(), `Checker › ${message}`);
    ui.write('\r'); await until(() => ui.records().some(m => m.method === 'turn/steer'));
    assert.deepEqual(ui.records().find(m => m.method === 'turn/steer').params.input, messageInput(message));
  } finally { await ui.close(); }
});
