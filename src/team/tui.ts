import { emitKeypressEvents, type Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { createTeamSession, type TeamSessionOptions } from './session.ts';
import { graphemes, renderTeamScreen } from './screen.ts';

/** Owns terminal rendering and input only. The session owns the dedicated team. */
export async function runTeamTui(options: TeamSessionOptions, io: { input?: ReadStream; output?: WriteStream } = {}) {
  const input = io.input ?? process.stdin, output = io.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('crew team 需要交互终端。请在终端直接运行；不是网页入口，也不接受管道输入。');
  const session = createTeamSession(options), wasRaw = !!input.isRaw;
  let buffer = '', cursor = 0, scroll = 0, pasting = false, timer: NodeJS.Timeout | undefined;
  let promptKey = '', promptSecret = false, exiting = false, restored = false;
  let exitError: unknown;
  const drafts = new Map<string, { text: string; cursor: number }>();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  function context() {
    const prompt = session.view().prompt;
    if (promptKey !== prompt.key) {
      if (promptKey && !promptKey.startsWith('answer:')) drafts.set(promptKey, { text: buffer, cursor });
      const draft = prompt.key.startsWith('answer:') ? undefined : drafts.get(prompt.key);
      buffer = draft?.text || ''; cursor = draft?.cursor || 0; promptKey = prompt.key; promptSecret = prompt.secret;
    }
  }
  function draw() {
    timer = undefined; if (restored || exiting) return;
    context();
    const frame = renderTeamScreen(session.view(), { columns: output.columns || 80, rows: output.rows || 24, input: buffer, cursor, scroll }); scroll = frame.scroll;
    output.write(`\x1b[H${frame.lines.map(line => `\x1b[2K${line}`).join('\r\n')}\x1b[${frame.cursorRow};${frame.cursorColumn}H`);
  }
  function changed() {
    if (session.closed) { finish(); return; }
    if (!timer) timer = setTimeout(draw, 20);
  }
  function restore() {
    if (restored) return; restored = true; clearTimeout(timer);
    input.off('keypress', keypress); input.off('end', exit); output.off('resize', draw);
    process.off('SIGTERM', exit); process.off('SIGHUP', exit); process.off('SIGINT', exit);
    try { input.setRawMode(wasRaw); } finally { input.pause(); output.write('\x1b[?2004l\x1b[?1049l\x1b[?25h'); }
    buffer = ''; drafts.clear();
  }
  async function exit() { if (exiting) return; exiting = true; try { await session.close(); } catch (error) { exitError = error; } finally { finish(); } }
  function insert(text: string) {
    // Preserve pasted line breaks, never treat a pasted newline as Enter.
    text = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    const parts = graphemes(buffer);
    if (buffer.length + text.length > 8192) return;
    const head = parts.slice(0, cursor).join(''), tail = parts.slice(cursor).join('');
    buffer = head + text + tail;
    const insertionEnd = head.length + text.length; cursor = 0;
    let units = 0;
    for (const g of graphemes(buffer)) { if (units >= insertionEnd) break; units += g.length; cursor++; }
  }
  async function submit() {
    if (session.view().busy || !buffer.trim()) return;
    const value = buffer, key = promptKey, secret = promptSecret;
    buffer = ''; cursor = 0; if (!key.startsWith('answer:')) drafts.delete(key); scroll = 0;
    const success = await session.submit(value);
    context();
    if (!success && promptKey === key && !secret && !buffer) { buffer = value; cursor = graphemes(value).length; }
    draw();
  }
  function keypress(text: string | undefined, key: Key = {}) {
    if (exiting || restored) return;
    if (key.sequence === '\x1b[200~') { pasting = true; return; }
    if (key.sequence === '\x1b[201~') { pasting = false; draw(); return; }
    if (pasting) { if (key.name === 'return' || key.name === 'enter') insert('\n'); else if (text) insert(text); draw(); return; }
    if (key.ctrl && key.name === 'd') { void exit(); return; }
    if (key.ctrl && key.name === 'c') {
      if (buffer) { buffer = ''; cursor = 0; draw(); }
      else if (session.view().snapshot.status === 'running') void session.submit('/interrupt').then(draw);
      else void exit();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') { void submit(); return; }
    if (key.name === 'tab') { session.cycle(key.shift ? -1 : 1); draw(); return; }
    if (key.name === 'f2') { session.details(); draw(); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') { scroll = Math.max(0, scroll + (key.name === 'pageup' ? 1 : -1) * Math.max(1, (output.rows || 24) - 7)); draw(); return; }
    const parts = graphemes(buffer);
    if (key.name === 'left') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'right') cursor = Math.min(parts.length, cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = parts.length;
    else if (key.name === 'backspace') { if (cursor) parts.splice(--cursor, 1); buffer = parts.join(''); }
    else if (key.name === 'delete') { parts.splice(cursor, 1); buffer = parts.join(''); }
    else if ((key.ctrl && key.name === 'u') || key.name === 'escape') { buffer = ''; cursor = 0; }
    else if (key.ctrl && key.name === 'k') buffer = parts.slice(0, cursor).join('');
    else if (text && !key.ctrl && !key.meta && !text.startsWith('\x1b')) insert(text);
    draw();
  }
  const unsubscribe = session.subscribe(changed);
  try {
    output.write('\x1b[?1049h\x1b[?2004h\x1b[?25h');
    emitKeypressEvents(input); input.setRawMode(true); input.on('keypress', keypress); input.on('end', exit); input.resume();
    output.on('resize', draw); process.on('SIGTERM', exit); process.on('SIGHUP', exit); process.on('SIGINT', exit);
    draw(); if (options.goal) void session.start();
    await done;
  } finally { unsubscribe(); try { await session.close(); } finally { restore(); } }
  if (exitError) throw exitError;
  output.write('Crew 团队已停止；记录仅保留在本次进程，隔离成果未自动合并。\n');
}
