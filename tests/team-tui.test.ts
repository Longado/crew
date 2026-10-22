import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnPty } from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { codexTeamFixture } from './helpers/codex-team-fixture.ts';
import { textWidth } from '../src/team/screen.ts';
import { runTeamTui } from '../src/team/tui.ts';
import { createTeamWorkbench } from '../src/bridge/workbench.ts';
import { PassThrough, Writable } from 'node:stream';

const repo = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile);
async function until(check: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Crew TUI test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
test('shipped CLI in a real PTY routes native input, explicit approval, member steering, resize and interrupt; exits cleanly', { timeout: 20000 }, async () => {
  const f = codexTeamFixture(), env = { ...process.env, PATH: `${f.directory}:${process.env.PATH}`, CORPUS_HOME: join(f.directory, 'data') } as Record<string, string>;
  const pty = spawnPty(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', f.directory, '--goal', 'Inspect fixture'], { cwd: repo, env, name: 'xterm-256color', cols: 100, rows: 26 });
  let raw = '', code: number | undefined;
  pty.onData(data => { raw += data; }); pty.onExit(exit => { code = exit.exitCode; });
  const records = () => existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const screen = () => stripVTControlCharacters(raw.slice(raw.lastIndexOf('\x1b[H'))).replace(/\r/g, '');
  try {
    await until(() => raw.includes('Q1 等待回答') && raw.includes('A1 等待审批'));
    assert.equal(records().some(m => m.id === 501 && m.result), false, 'approval never auto-accepted');
    // 标题在待答列表中也会出现；等底部输入提示切换后再写字。
    pty.write('/answer Q1\r'); await until(() => screen().split('\n').at(-1)?.startsWith('Private fixture note › ') === true);
    pty.write('dummy-secret-note'); await until(() => screen().includes('***')); assert.equal(raw.includes('dummy-secret-note'), false);
    pty.write('\r'); await until(() => records().some(m => m.id === 500 && m.result));
    assert.deepEqual(records().find(m => m.id === 500 && m.result).result.answers, { note: { answers: ['dummy-secret-note'] } });
    pty.write('/approve A1 n\r'); await until(() => records().some(m => m.id === 501 && m.result));
    assert.deepEqual(records().find(m => m.id === 501 && m.result).result, { decision: 'decline' });
    pty.write('/member M2\r'); await until(() => screen().includes('>M2 Checker'));
    pty.write('Inspect empty case\r'); await until(() => records().some(m => m.method === 'turn/steer' && m.params.threadId === 'worker'));
    assert.equal(records().find(m => m.method === 'turn/steer').params.expectedTurnId, 'worker-turn');
    pty.resize(42, 16); await until(() => screen().split('\n').length === 16);
    assert.ok(screen().split('\n').every(line => textWidth(line) <= 41), 'narrow frame must fit terminal cells');
    pty.write('/interrupt\r'); await until(() => records().some(m => m.method === 'turn/interrupt' && m.params.threadId === 'worker'));
    await until(() => raw.includes('已中断')); assert.match(screen(), /TEAM 0\/0 已验收/);
    pty.write('/quit\r'); await until(() => code !== undefined);
    assert.equal(code, 0); assert.ok(raw.includes('\x1b[?2004l\x1b[?1049l\x1b[?25h')); assert.match(raw, /Crew 团队已停止/);
  } finally { if (code === undefined) pty.kill(); }
});

test('offline TUI demo handles bracketed paste, edits graphemes, preserves member drafts and restores on Ctrl+D', { timeout: 15000 }, async () => {
  const f = codexTeamFixture(), env = { ...process.env, PATH: `${f.directory}:${process.env.PATH}`, CORPUS_HOME: join(f.directory, 'data') } as Record<string, string>;
  const pty = spawnPty(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', '--demo'], { cwd: repo, env, name: 'xterm-256color', cols: 110, rows: 26 });
  let raw = '', code: number | undefined;
  pty.onData(data => { raw += data; }); pty.onExit(exit => { code = exit.exitCode; });
  const screen = () => stripVTControlCharacters(raw.slice(raw.lastIndexOf('\x1b[H'))).replace(/\r/g, '');
  const prompt = () => screen().split('\n').at(-1)!;
  try {
    await until(() => raw.includes('演示（无模型）') && raw.includes('A1 等待审批'));
    pty.write('\x1b[200~pasted\n/approve A1 y\x1b[201~'); await until(() => prompt().includes('pasted'));
    assert.equal(raw.includes('演示审批决定：accept'), false); assert.ok(screen().includes('A1 等待审批'));
    pty.write('\x03'); await until(() => !prompt().includes('pasted'));
    pty.write('中文👩🏽‍💻'); await until(() => prompt().includes('👩🏽‍💻'));
    pty.write('\x7f'); await until(() => !prompt().includes('👩'));
    assert.match(prompt(), /中文/);
    pty.write('\t'); await until(() => screen().includes('>M2'));
    assert.equal(prompt().includes('中文'), false);
    pty.write('\t'); await until(() => screen().includes('>M1'));
    assert.match(prompt(), /中文/);
    pty.write('\x04'); await until(() => code !== undefined);
    assert.equal(code, 0); assert.ok(raw.includes('\x1b[?1049l')); assert.equal(existsSync(f.log), false);
  } finally { if (code === undefined) pty.kill(); }
});

test('team CLI validates flags and rejects piped input without starting a model or binding a server', async () => {
  const f = codexTeamFixture(), env = { ...process.env, PATH: `${f.directory}:${process.env.PATH}`, CORPUS_HOME: join(f.directory, 'data') };
  await assert.rejects(exec(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', f.directory, '--goal', 'Inspect'], { cwd: repo, env }), error => /需要交互终端/.test(String((error as any).stderr)));
  assert.equal(existsSync(f.log), false);
  await assert.rejects(exec(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', f.directory, '--mode', 'invalid'], { cwd: repo, env }), error => /--mode/.test(String((error as any).stderr)));
  await assert.rejects(exec(process.execPath, ['--no-warnings', 'src/cli.ts', 'team', f.directory, '--demo', '--write'], { cwd: repo, env }), error => /--demo/.test(String((error as any).stderr)));
  assert.equal(existsSync(f.log), false);
});

test('terminal restores raw mode and the original screen even when /quit shutdown rejects', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  let text = '';
  const output = Object.assign(new Writable({ write(data, _, callback) { text += data.toString(); callback(); } }), { isTTY: true, columns: 70, rows: 18 });
  const wb = createTeamWorkbench(); wb.close = async () => { throw new Error('Fixture shutdown failed'); };
  const before = process.listenerCount('SIGTERM');
  const pending = runTeamTui({ cwd: repo, mode: 'codex-team', access: 'read-only', workbench: wb }, { input: input as any, output: output as any });
  assert.equal(input.isRaw, true); input.write('/quit\r');
  await assert.rejects(pending, /Fixture shutdown failed/);
  assert.equal(input.isRaw, false); assert.match(text, /\x1b\[\?1049l/); assert.equal(process.listenerCount('SIGTERM'), before);
  input.destroy(); output.destroy();
});
