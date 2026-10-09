// 讲解视频，四分钟左右，中文配音：理念卡片 → 终端 → 桌面窗口 → 架构图 → 接下来。输出 docs/media/explainer.mp4。
// 运行：npm run record:explainer。需要 vhs、Chrome、ffmpeg，以及仓库 .env 里的 ELEVENLABS_API_KEY（.env 不会提交）。
// 每个段落的旁白一口气念完（不按句切开），ElevenLabs 返回每个字的时间点：画面在念到对应那句时切换，字幕也按这个时间烧进画面。
// 改文案：卡片、终端、架构图的旁白都在下面；窗口部分的旁白在 demo/window.ts 的分镜里；卡片画面在 demo/slides.html。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, openChrome, sleep, startRecording, waitFor, writeFrames } from './chrome.ts';
import { ffmpeg, mixVoice, probeSeconds, speakParagraph, type Cue } from './tts.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'docs', 'media', 'explainer.mp4');

// ---------- 旁白 ----------
// 每个方括号是一个段落，一口气念完；段落里每句对应一张卡片，念到这句时切过去
const INTRO: [slide: string, voice: string][][] = [
  [
    ['title', '用 AI 做项目，难的常常不是开头，而是隔了几天，再接着做下去。'],
    ['scatter', '需求在网页上和 Gemini 聊，功能在 Claude Code 里写，bug 交给 Codex 去修。过两天回来，得翻好几段长对话，才想得起做到哪了。'],
    ['questions', '每次回来都在问：哪些真做完了，哪些只是 AI 说做完了？现在卡在哪，下一步做什么？'],
  ],
  [
    ['evidence', 'Crew 的第一条规矩，是只认证据。AI 说做完了，只算待验证；你说试过了、没问题，才算完成。每个状态，都能点回那句原话。'],
    ['judgment', '大模型在这里只做一件事：读对话，标出哪句话说明了哪个任务发生了什么，而且必须引用原话。状态、规划版本、下一步，都由代码按规则算。同样的对话，算出来的结果永远一样。'],
    ['people', '很多记忆工具，是把记忆写回给 AI。我们先把现场交给你，一眼看清楚；要换工具接着干，再给下一个 AI 一段准确的背景。'],
    ['local', '对话都留在你的电脑上。整理时只发送绑定项目的对话，发之前先问你；密钥在读取时就替换掉了。'],
  ],
  [
    ['example', '来看一个例子：一个记账小程序，五天，六段对话，来自三个工具。'],
  ],
];
const TERMINAL_VOICE = [
  '在终端里敲 crew，每个项目一行：各个状态有几项，下一步做什么。',
  'crew show 看一个项目的现场。规划改过两版，每个任务都写着依据：是你确认的、原文写明的，还是 AI 自己说的。',
  '要换个工具接着做，crew context 给出一段背景：之前失败过，要先确认完成条件，哪些事不要做。',
];
const ARCH_VOICE = '整体就是五步：读取你用过的工具，按代码目录归到项目；大模型把消息标成证据，代码再验一遍；最后按规则折叠成现场，交给终端、窗口，和下一个 AI。';
const OUTRO: [slide: string, voice: string][][] = [[
  ['next', '接下来想做两件事：让证据也能来自 git 提交和测试结果；再给每个 AI 记一张工牌，看看谁说的“做完了”最靠谱。'],
  ['end', 'Crew 已经开源。在线演示不用安装，打开就能看。'],
]];

type Beat = { voice: string; js: string };
type Timed = { cues: Cue[] };

/** 打开一个页面，逐段配音；段落里念到哪句就执行那句对应的动作，一段念完稍停再下一段。输出带配音的 MP4，返回字幕（按这段视频的时间）。 */
async function recordBeats(url: string, size: [number, number], prep: string, paragraphs: Beat[][], out: string, tmp: string): Promise<Timed> {
  const paras = [];
  for (const p of paragraphs) paras.push(await speakParagraph(p.map((b) => b.voice))); // 一段一段请求：入门套餐最多同时 3 个
  const chrome = await openChrome(join(tmp, `chrome-${Date.now()}`), size[0], size[1]);
  try {
    const { page } = chrome;
    await page.send('Page.navigate', { url });
    await waitFor(async () => (await evaluate(page, 'document.readyState === "complete"')) || null, '页面加载');
    await evaluate(page, 'document.fonts.ready.then(() => true)');
    if (prep) await evaluate(page, prep);
    await sleep(400);
    const rec = startRecording(page);
    await sleep(300);
    const begins: number[] = [];
    for (const [i, beats] of paragraphs.entries()) {
      const t = Date.now();
      begins.push(t);
      for (const [k, b] of beats.entries()) {
        await sleep(Math.max(0, t + paras[i].partStarts[k] * 1000 - 150 - Date.now()));
        await evaluate(page, b.js);
      }
      await sleep(Math.max(0, t + paras[i].seconds * 1000 + 900 - Date.now())); // 段落之间停一下
    }
    const frames = await rec.stop();
    const list = writeFrames(frames, join(tmp, `frames-${Date.now()}`));
    const silent = join(tmp, `silent-${Date.now()}.mp4`);
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-crf', '20', silent]);
    const at = begins.map((t) => (t - frames[0].t) / 1000);
    mixVoice(silent, paras.map((p, i) => ({ file: p.file, at: at[i] })), out);
    return { cues: paras.flatMap((p, i) => p.cues.map((c) => ({ ...c, start: c.start + at[i], end: c.end + at[i] }))) };
  } finally {
    chrome.close();
  }
}

const slides = (paras: [string, string][][]): Beat[][] => paras.map((p) => p.map(([id, voice]) => ({ voice, js: `show(${JSON.stringify(id)})` })));
const slidesUrl = `${pathToFileURL(join(ROOT, 'demo', 'slides.html')).href}#none`;

const tmp = mkdtempSync(join(tmpdir(), 'corpus-explainer-'));
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} 失败：${(r.stderr || r.stdout).slice(-400)}`);
};

/** 按给定的停留毫秒数录一遍终端，返回三次命令输出出现的时刻（秒）。 */
function recordTerminal(holdsMs: number[], out: string): number[] {
  let n = 0;
  const tape = readFileSync(join(ROOT, 'demo', 'terminal.tape'), 'utf8')
    .replace(/^Output .*$/gm, '')
    .replace(/^(# voice-hold.*\n)Sleep (\d+)s$/gm, (_, mark: string) => `${mark}Sleep ${Math.round(holdsMs[n++])}ms`)
    .replace(/^Set Shell/m, `Output ${JSON.stringify(out)}\nSet Shell`);
  if (n !== holdsMs.length) throw new Error(`terminal.tape 里的 voice-hold 标记有 ${n} 个，旁白有 ${holdsMs.length} 句`);
  const tapeFile = `${out}.tape`;
  writeFileSync(tapeFile, tape);
  run('vhs', [tapeFile]);
  const scene = spawnSync('ffmpeg', ['-v', 'info', '-i', out, '-vf', "select='gt(scene,0.015)',showinfo", '-f', 'null', '-'], { encoding: 'utf8' });
  const changes = [...scene.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  // 画面大变化依次是：输出、清屏、输出、清屏、输出
  if (changes.length !== 5) throw new Error(`终端录屏里认出 ${changes.length} 次画面切换，应该是 5 次：${changes.join(', ')}`);
  return [changes[0], changes[2], changes[4]];
}

/** 把字幕渲染成透明底的图片，一条一张。 */
async function renderSubtitles(cues: Cue[], dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const chrome = await openChrome(join(tmp, 'chrome-subs'), 1280, SUB_H);
  try {
    const { page } = chrome;
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const body = `margin:0;background:transparent;height:${SUB_H}px;display:flex;align-items:flex-end;justify-content:center`;
    const box = 'margin-bottom:22px;max-width:1120px;padding:8px 20px;border-radius:8px;background:rgba(8,9,12,.82);color:#fff;font:500 30px/1.45 "PingFang SC","Hiragino Sans GB",sans-serif;letter-spacing:.5px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    await evaluate(page, `(() => { document.body.style.cssText = ${JSON.stringify(body)}; const d = document.createElement('div'); d.id = 's'; d.style.cssText = ${JSON.stringify(box)}; document.body.append(d); })()`);
    const files: string[] = [];
    for (const [i, c] of cues.entries()) {
      await evaluate(page, `document.getElementById('s').textContent = ${JSON.stringify(c.text)}`);
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const f = join(dir, `${String(i).padStart(3, '0')}.png`);
      writeFileSync(f, Buffer.from(data, 'base64'));
      files.push(f);
    }
    return files;
  } finally {
    chrome.close();
  }
}
const SUB_H = 150;

try {
  // 1. 开场和理念：卡片
  const intro = await recordBeats(slidesUrl, [1280, 800], '', slides(INTRO), join(tmp, 'intro.mp4'), tmp);

  // 2. 终端：三句连成一段。先录一遍量出敲命令要花的时间，再录一遍，让每次输出正好出现在念到那句时
  const tp = await speakParagraph(TERMINAL_VOICE);
  const partSecs = tp.partStarts.map((s, i) => (tp.partStarts[i + 1] ?? tp.seconds + 0.8) - s);
  const first = partSecs.map((d) => d * 1000);
  const probe = recordTerminal(first, join(tmp, 'terminal-probe.mp4'));
  const lag = [0, 1].map((i) => probe[i + 1] - probe[i] - first[i] / 1000); // 清屏加敲下一条命令用掉的时间
  const holds = partSecs.map((d, i) => Math.max(1000, (d - (lag[i] ?? 0)) * 1000));
  const outs = recordTerminal(holds, join(tmp, 'terminal.mp4'));
  const tAt = outs[0] + 0.2 - tp.partStarts[0];
  console.log(`  终端对齐误差：${outs.map((o, i) => (o - (tAt + tp.partStarts[i])).toFixed(2)).join(' / ')} 秒`);
  mixVoice(join(tmp, 'terminal.mp4'), [{ file: tp.file, at: tAt }], join(tmp, 'terminal-voice.mp4'));
  const terminal: Timed = { cues: tp.cues.map((c) => ({ ...c, start: c.start + tAt, end: c.end + tAt })) };

  // 3. 桌面窗口：七句连成一段，念到哪句点哪里
  run(process.execPath, ['--no-warnings', join(ROOT, 'demo', 'window.ts'), '--voice', '--out', tmp]);
  const windowPart: Timed = { cues: JSON.parse(readFileSync(join(tmp, 'window-voice.json'), 'utf8')) };

  // 4. 架构图：五列跟着旁白依次亮起
  const archPara = await speakParagraph([ARCH_VOICE]);
  const step = Math.round((archPara.seconds * 1000) / 5.5);
  const hide = `(() => { const s = document.createElement('style'); s.textContent = '.flow > *, footer { opacity: 0; transform: translateY(10px); transition: opacity .6s, transform .6s } .flow > .shown, footer.shown { opacity: 1; transform: none }'; document.head.append(s); })()`;
  const reveal = `(() => { [...document.querySelectorAll('.flow > *')].forEach((el, i) => setTimeout(() => el.classList.add('shown'), Math.ceil(i / 2) * ${step} + 300)); setTimeout(() => document.querySelector('footer').classList.add('shown'), ${step * 5}); })()`;
  const arch = await recordBeats(pathToFileURL(join(ROOT, 'docs', 'diagram', 'architecture.html')).href, [1600, 720], hide, [[{ voice: ARCH_VOICE, js: reveal }]], join(tmp, 'arch.mp4'), tmp);

  // 5. 接下来和片尾
  const outro = await recordBeats(slidesUrl, [1280, 800], '', slides(OUTRO), join(tmp, 'outro.mp4'), tmp);

  // 6. 统一成 1280×800，淡入淡出后接起来，再按时间叠上字幕
  const parts = [
    { file: 'intro.mp4', bg: '0x0B0C0F', timed: intro },
    { file: 'terminal-voice.mp4', bg: '0x1E1E2E', timed: terminal },
    { file: 'window-voice.mp4', bg: '0x0B0C0F', timed: windowPart },
    { file: 'arch.mp4', bg: '0x0B0C0F', timed: arch },
    { file: 'outro.mp4', bg: '0x0B0C0F', timed: outro },
  ];
  let offset = 0;
  const cues: Cue[] = [];
  const filters = parts.flatMap((p, i) => {
    const d = probeSeconds(join(tmp, p.file));
    console.log(`  ${p.file.padEnd(20)} ${d.toFixed(1)} 秒`);
    cues.push(...p.timed.cues.map((c) => ({ ...c, start: c.start + offset, end: Math.min(c.end, d) + offset })));
    offset += d;
    return [
      `[${i}:v]scale=1280:800:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=${p.bg},fps=25,format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4,fade=t=out:st=${(d - 0.4).toFixed(2)}:d=0.4[v${i}]`,
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,afade=t=in:st=0:d=0.2,afade=t=out:st=${(d - 0.3).toFixed(2)}:d=0.3[a${i}]`,
    ];
  });
  const concat = `${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[c0][araw];[araw]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[a]`; // 响度统一，峰值留余量不破音
  const subs = await renderSubtitles(cues, join(tmp, 'subs'));
  const base = parts.length;
  const overlays = cues.map((c, i) => `[c${i}][${base + i}:v]overlay=0:${800 - SUB_H}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[c${i + 1}]`);
  writeFileSync(join(tmp, 'filter.txt'), [...filters, concat, ...overlays].join(';\n'));
  ffmpeg([...parts.flatMap((p) => ['-i', join(tmp, p.file)]), ...subs.flatMap((f) => ['-i', f]), '-filter_complex_script', join(tmp, 'filter.txt'), '-map', `[c${cues.length}]`, '-map', '[a]', '-c:v', 'libx264', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', OUT]);
  writeFileSync(OUT.replace(/\.mp4$/, '.srt'), cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));
  const total = probeSeconds(OUT);
  console.log(`已生成 docs/media/explainer.mp4 和 explainer.srt：${Math.floor(total / 60)} 分 ${Math.round(total % 60)} 秒，字幕 ${cues.length} 条`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function srtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
