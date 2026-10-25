// 生成在线演示站点（GitHub Pages）：用示例数据建一个内存库，把页面要的接口结果导成 JSON，
// 页面在只读模式下按路径读这些文件。默认输出到 site/（不进 git），也可以传一个目录。
import { pathToFileURL } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { loadDemo, SHOWCASE } from '../src/demo.ts';
import { messagesPayload, projectPayload, sourcesPayload, statePayload } from '../src/server.ts';
import { buildContext } from '../src/engine/context.ts';

const out = process.argv[2] ? pathToFileURL(`${process.argv[2].replace(/\/$/, '')}/`) : new URL('../site/', import.meta.url);
const web = new URL('../web/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('data/p/', out), { recursive: true });

const db = openDb(':memory:');
const ids = loadDemo(db, SHOWCASE);
const write = (file: string, data: unknown) => writeFileSync(new URL(`data/${file}`, out), JSON.stringify(data));

write('state.json', statePayload(db, '示例数据（未调用模型）', null));
write('sources.json', sourcesPayload(db, { installed: { claudeCode: true, codex: true, vscode: true }, lastSyncAt: null, badLines: 0, skippedDirs: [], model: '示例数据（未调用模型）' }));
for (const id of ids) {
  const payload = projectPayload(db, id);
  write(`p/${id}.json`, payload);
  write(`p/${id}.messages.json`, messagesPayload(db, id, db.messagesForProject(id).map((m) => m.id)));
  write(`p/${id}.context.json`, Object.fromEntries(payload.view.tasks.map((t) => [t.id, buildContext(db, id, t.id)])));
}

for (const f of ['app.js', 'style.css', 'logo.svg', 'team.js', 'team.css', 'team-dock.js', 'team-dock.css', 'workspace.js', 'workspace.css', 'security.js', 'security.css', 'today.js', 'today.css']) cpSync(new URL(f, web), new URL(f, out));
mkdirSync(new URL('vendor/', out));
for (const [source, target] of [['@xterm/xterm/lib/xterm.js', 'xterm.js'], ['@xterm/xterm/css/xterm.css', 'xterm.css'], ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js']]) {
  cpSync(new URL(`../node_modules/${source}`, import.meta.url), new URL(`vendor/${target}`, out));
}
const html = readFileSync(new URL('index.html', web), 'utf8')
  .replace(/<title>.*?<\/title>/, '<title>Crew · 项目现场只读演示</title>')
  .replace('</head>', '<meta name="description" content="Crew 本地 Agent 工作台的项目现场只读示例；任务编排和材料流程请装到本机运行。">\n</head>')
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="corpus-static" content="1">');
writeFileSync(new URL('index.html', out), html);
writeFileSync(new URL('.nojekyll', out), '');
// 讲解视频放在站点里，浏览器点开就能播（GitHub 仓库页面不能直接播仓库里的视频）
const video = new URL('../docs/media/explainer.mp4', import.meta.url);
if (existsSync(video)) cpSync(video, new URL('media/explainer.mp4', out));
console.log(`已生成在线演示：${ids.length} 个示例项目 → ${out.pathname}`);
