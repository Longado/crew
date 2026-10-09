// 桌面窗口录屏：无头 Chrome 按下面的分镜操作本地应用，边操作边截图，最后用 ffmpeg 合成 GIF 和 MP4。
// 运行：npm run record:window（需要 Chrome 和 ffmpeg）。
// 数据在临时目录里，HOME 也指向临时目录，所以服务读不到你本机的任何对话，画面里只有示例项目。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpeg, mixVoice, speakParagraph } from './tts.ts';
import { evaluate, openChrome, sleep, startRecording, waitFor, writeFrames, type Page } from './chrome.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// --voice：七句旁白连成一段一口气念完，念到哪句就做哪个镜头的动作；输出到 --out 目录的 window-voice.mp4 和字幕时间 window-voice.json
// （给 demo/explainer.ts 拼讲解视频用），不动 GIF。配音版不显示画面里的字幕条，字幕统一由讲解视频加。
const VOICED = process.argv.includes('--voice');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'docs', 'media');
const W = 1280;
const H = 800;
type Shot = { caption: string; voice?: string; act?: (p: Actions) => Promise<void>; hold: number };

// ---------- 分镜：改演示内容只改这里 ----------
// hold 是动作之后停留的毫秒数：字幕加画面，按每秒读 6 到 7 个字留足时间
const SHOTS: Shot[] = [
  { caption: '窗口里的项目现场：最上面是语料带，每个方块是一条消息，颜色是它支撑的任务状态', voice: '同一个项目，也可以在窗口里看。最上面这条语料带，每个方块是一条消息，颜色是它支撑的任务的状态。', hold: 5500 },
  { caption: 'AI 说“月度导出”做完了。点“依据”，看到的是 AI 的原话，所以只算待验证', voice: 'AI 说月度导出做完了。点一下依据，看到的是 AI 自己的原话，所以它只算待验证。', act: (a) => a.click('.line [data-act="ev"]', '月度导出', '.line'), hold: 7000 },
  { caption: '点“继续”，拿到交给下一个 AI 的背景：之前失败过、先确认完成条件、云同步不要做', voice: '点继续，拿到交给下一个 AI 的背景：之前失败过，要先确认完成条件，云同步不要做。', act: async (a) => { await a.click('[data-act="close-drawer"]'); await a.click('.line [data-act="cont"]', '月度导出', '.line'); }, hold: 8000 },
  { caption: '规划改过两版：第 2 版加了本地备份，取消了云同步', voice: '规划改过两版。第二版加了本地备份，取消了云同步。', act: async (a) => { await a.click('[data-act="close-modal"]'); await a.click('nav.tabs a', '规划'); }, hold: 6500 },
  { caption: 'AI 自己提的“预算提醒”先放在待确认，你点头才算任务', voice: 'AI 自己提的预算提醒，先放在待确认。你点头之前，它不算任务。', act: (a) => a.click('nav.tabs a', '待确认'), hold: 6000 },
  { caption: '你验证过“记账录入”，点“确认完成”，它才算已完成', voice: '你验证过记账录入，点确认完成，它才变成已完成。', act: async (a) => { await a.click('nav.tabs a', '概览'); await a.click('.line [data-act="confirm-done"]', '记账录入', '.line'); }, hold: 6000 },
  { caption: '下一步最多三条：先验证，再继续，最后才开始新任务', voice: '下一步最多三条：先验证，再继续，最后才开始新任务。', act: (a) => a.scrollTo('.next'), hold: 6500 },
  { caption: 'Crew · 数据都在本机，每条结论都能点回原话', act: (a) => a.scrollTo('.head'), hold: 4000 },
];

// ---------- 画面上的光标和字幕 ----------
const OVERLAY = `(() => {
  const s = document.createElement('style');
  s.textContent = \`
    #rec-cursor{position:fixed;left:0;top:0;z-index:9999;pointer-events:none;transition:transform .75s cubic-bezier(.45,0,.2,1);transform:translate(${W / 2}px,${H / 2}px)}
    #rec-ring{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #8C90F6;z-index:9998;pointer-events:none;opacity:0}
    #rec-ring.go{animation:rec-ring .5s ease-out}
    @keyframes rec-ring{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
    #rec-cap{position:fixed;left:0;right:0;bottom:26px;margin:0 auto;width:fit-content;max-width:90%;z-index:9997;pointer-events:none;background:rgba(9,10,14,.93);color:#F1F2F5;border:1px solid rgba(140,144,246,.55);border-radius:8px;padding:10px 20px;font:500 19px/1.5 "PingFang SC","Hiragino Sans GB",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);transition:opacity .25s}
    .toast{bottom:92px !important}\`;
  document.head.append(s);
  document.body.insertAdjacentHTML('beforeend', '<div id="rec-cursor"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div><div id="rec-ring"></div><div id="rec-cap"></div>');
})()`;

type Actions = { click: (sel: string, text?: string, row?: string) => Promise<void>; scrollTo: (sel: string) => Promise<void> };


function actions(page: Page): Actions {
  const run = (expr: string) => evaluate(page, expr);
  // 找目标元素：text 给了就按元素（或所在行）里的文字挑
  const find = (sel: string, text?: string, row?: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((el) => ${text ? `((${row ? `el.closest(${JSON.stringify(row)})` : 'el'})?.textContent ?? '').includes(${JSON.stringify(text)})` : 'true'})`;
  return {
    async click(sel, text, row) {
      const pos = await run(`(() => { const el = ${find(sel, text, row)}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!pos) throw new Error(`找不到要点的元素：${sel} ${text ?? ''}`);
      await run(`document.getElementById('rec-cursor').style.transform = 'translate(${pos.x - 3}px, ${pos.y - 2}px)'`);
      await sleep(850);
      await run(`(() => { const r = document.getElementById('rec-ring'); r.style.left = '${pos.x}px'; r.style.top = '${pos.y}px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); (${find(sel, text, row)}).click(); })()`);
      await sleep(600);
    },
    async scrollTo(sel) {
      await run(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ behavior: 'smooth', block: 'center' })`);
      await sleep(900);
    },
  };
}

// ---------- 主流程 ----------
const tmp = mkdtempSync(join(tmpdir(), 'corpus-rec-'));
const env = { ...process.env, HOME: tmp, CORPUS_HOME: tmp, NO_COLOR: '1' };
const cli = (...args: string[]) => [join(ROOT, 'src', 'cli.ts'), ...args];
const port = String(4900 + Math.floor(Math.random() * 300));
const procs: ChildProcess[] = [];
const closers: (() => void)[] = [];

try {
  const demo = spawnSync(process.execPath, ['--no-warnings', ...cli('demo')], { env, encoding: 'utf8' });
  if (demo.status !== 0) throw new Error(demo.stderr);
  procs.push(spawn(process.execPath, ['--no-warnings', ...cli('serve', '--port', port)], { env, stdio: 'ignore' }));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).ok || null, '本地服务启动');

  const chrome = await openChrome(join(tmp, 'chrome'), W, H);
  closers.push(chrome.close);
  const page = chrome.page;
  // 窗口现在有左侧导航，根地址不再直接是项目概览：直接进示例项目的概览页
  const { projects } = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as { projects: { id: string }[] };
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/#/p/${projects[0].id}` });
  const act = actions(page);
  await waitFor(async () => (await page.send('Runtime.evaluate', { expression: `!!document.querySelector('.line [data-act="ev"]')`, returnByValue: true })).result.value || null, '页面加载');
  await page.send('Runtime.evaluate', { expression: OVERLAY });
  await sleep(600); // 等字体加载完

  // 边操作边截图，记下每帧的时间，合成时按真实间隔排
  const voiced = SHOTS.filter((x) => x.voice);
  const para = VOICED ? await speakParagraph(voiced.map((x) => x.voice!)) : null;
  if (para) await page.send('Runtime.evaluate', { expression: `document.getElementById('rec-cap').style.display = 'none'` });
  const recording = startRecording(page);
  await sleep(300);
  const audioStart = Date.now();
  if (para) {
    for (const [k, shot] of voiced.entries()) {
      await sleep(Math.max(0, audioStart + para.partStarts[k] * 1000 - 150 - Date.now())); // 念到这句时开始动
      await shot.act?.(act);
    }
    await sleep(Math.max(0, audioStart + para.seconds * 1000 + 800 - Date.now()));
  } else {
    for (const shot of SHOTS) {
      await page.send('Runtime.evaluate', { expression: `document.getElementById('rec-cap').textContent = ${JSON.stringify(shot.caption)}` });
      await shot.act?.(act);
      await sleep(shot.hold);
    }
  }
  const frames = await recording.stop();

  const dir = join(tmp, 'frames');
  const listFile = writeFrames(frames, dir);
  mkdirSync(OUT, { recursive: true });
  if (para) {
    const silent = join(dir, 'silent.mp4');
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '22', silent]);
    const at = (audioStart - frames[0].t) / 1000;
    mixVoice(silent, [{ file: para.file, at }], join(OUT, 'window-voice.mp4'));
    writeFileSync(join(OUT, 'window-voice.json'), JSON.stringify(para.cues.map((c) => ({ ...c, start: c.start + at, end: c.end + at }))));
    console.log(`已生成 ${join(OUT, 'window-voice.mp4')}：${((frames.at(-1)!.t - frames[0].t) / 1000).toFixed(1)} 秒`);
  } else {
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '24', '-movflags', '+faststart', join(OUT, 'window.mp4')]);
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=10,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', join(OUT, 'window.gif')]);
    console.log(`已生成 docs/media/window.mp4 和 window.gif：${frames.length} 帧，${((frames.at(-1)!.t - frames[0].t) / 1000).toFixed(1)} 秒`);
  }
} finally {
  for (const c of closers) c();
  for (const p of procs) p.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
