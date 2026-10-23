// 命令行入口：npm run corpus -- <命令>
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dbPath, loadEnv } from './config.ts';
import { openDb } from './db.ts';
import { syncClaudeCode } from './ingest/claude-code.ts';
import { syncCodex } from './ingest/codex.ts';
import { syncVscode } from './ingest/vscode.ts';
import { importText } from './ingest/paste.ts';
import { readTakeoutPath, importConversations } from './ingest/takeout.ts';
import { extractProject } from './extract/run.ts';
import { deepseek } from './extract/model.ts';
import { buildProjectView } from './engine/view.ts';
import { buildContext } from './engine/context.ts';
import { runEval, formatReport } from './eval.ts';
import { gitRoot } from './ingest/common.ts';
import { renderScene, renderHome, useColor } from './tui.ts';

const HELP = `Crew · 用法：crew <命令>

  （不带命令）                                    所有项目的概况
  open <目录> [--port 4173] [--no-open]             打开目录的团队工作台（自动关联项目）
  team [目录] [--goal <目标>] [--write]             终端团队：默认 Codex、只读；--write 修改隔离副本
       [--mode codex-team|delegation] [--demo]       可选跨工具委派；--demo 离线演示，不调用模型
  app [--port 4173] [--no-open]                     打开窗口：后台启动本地服务，用独立窗口打开
  stop                                             停掉后台的本地服务
  show [--project <编号>]                           在终端看项目现场；在项目目录里可以不写 --project
  context --task <T01> [--project <编号>]           打印续接上下文，贴进任何 AI 工具接着干

  project add <名称> --dir <目录> [--goal <目标>]   建项目并绑定目录（可多次 --dir）
  project list                                     列出项目
  project pause|resume --project <编号>              暂停或恢复采集（已有数据保留）
  sync [--no-extract] [--quiet]                    读取 Claude Code、Codex、VS Code 聊天的新对话，并整理
  import <文件> --project <编号> --label <来源> --title <标题> [--partial] [--date YYYY-MM-DD]
  takeout <zip、文件夹或 json> --project <编号> [--pick 编号,编号 | --all]
                                                   Google Takeout 的 Gemini 历史：不带 --pick 先列出对话
  extract [--project <编号>] [--fresh]              只整理，不读取；--fresh 清掉旧证据从头整理（任务编号和修正保留）
  serve [--port 4173]                              在前台运行本地服务
  mcp                                              以 MCP 连接器方式运行（stdio），见 docs/MCP.md
  tasks list                                       读 Workspace 本批次任务（JSON）
  tasks get|status --task <编号>                    读取单项任务／运行回执
  tasks cancel --task <编号> --expected-status <状态> --note <终止原因>
  tasks dispatch --task <编号> --goal <目标> [--write]  默认只读，显式 --write 隔离修改
  tasks stop --job <运行编号>                       停止明确指定的看板运行
  tasks mcp                                        Workspace 任务 MCP（stdio，六个工具）
       [--workspace <目录>] [--manifest <清单.json>] [--board-url http://127.0.0.1:6480]
  worker run <运行目录> [--cwd <目录>] [--goal <目标>] [--retry <卡名>] [--executor codex|claude] [--allow-web]
                                                   负责人模式：默认 Codex，卡头执行者优先；Claude 仅只读，--allow-web 仅为 Claude 开联网
  worker wait <运行目录>                            等到有一张卡交回来（先交的先通知）；--retry 接着原会话改
  worker watch <运行目录> [--minutes N]              前台自动补位，沿用 run 设置与并发上限；默认不限时，退出不停止已派卡
  worker pause|resume <运行目录>                    持久暂停／恢复自动派卡（含 accept）；手工 run 仍允许，resume 不后台启动 watch
  worker status <运行目录>                          每张卡在哪一步，以及自动派卡 active／paused／ended／interrupted 状态
  worker accept|reject <运行目录> <卡名> --note <说明>  负责人验收或退回；暂停中仍验收但不自动派下游
  worker check <交付.out>                           把交付里的 路径:行号 引用对回原文
  worker run … --write / worker changes <运行目录>   不开沙箱改文件（卡里写「可写：」）；changes 列出改动、标出越界
  worker guide                                     打印负责人指南
  eval [--only S1]                                 用真模型跑样本评估
  demo                                             用样本数据建一个示例项目（不调用模型）

凭证与安全（可选环境变量）：
  CREW_ASKKEY_HELPER      原生 helper 可执行文件；未配置时原生录入与检测不可用
  CREW_SECURITY_SCANNER   只读扫描器 Python 脚本；未配置时项目扫描不可用
  CREW_VAULT_DIR          只读凭证目录；默认 ~/.local-sensitive/housekeeper-vault

没装全局命令时，把 crew 换成 npm run crew --；原有 corpus 命令继续可用`;

// 负责人模式的参数原样交给 Python，不进下面的统一参数表
if (process.argv[2] === 'worker') {
  const r = spawnSync('python3', [fileURLToPath(new URL('../scripts/lead/worker.py', import.meta.url)), ...process.argv.slice(3)], { stdio: 'inherit' });
  if (r.error) console.error('找不到 python3，负责人模式需要本地 Python 3。');
  process.exit(r.status ?? 1);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    dir: { type: 'string', multiple: true }, goal: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' },
    label: { type: 'string' }, title: { type: 'string' }, partial: { type: 'boolean' }, date: { type: 'string' },
    workspace: { type: 'string' }, manifest: { type: 'string' }, 'board-url': { type: 'string' },
    'expected-status': { type: 'string' }, note: { type: 'string' }, job: { type: 'string' },
    mode: { type: 'string' }, write: { type: 'boolean' }, demo: { type: 'boolean' },
    json: { type: 'boolean' }, reason: { type: 'string' },
    'no-extract': { type: 'boolean' }, fresh: { type: 'boolean' }, quiet: { type: 'boolean' }, 'no-open': { type: 'boolean' }, pick: { type: 'string' }, all: { type: 'boolean' }, port: { type: 'string' }, only: { type: 'string' },
  },
});

// 默认数据库跟着仓库走，不跟着当前目录：MCP 连接器是从别的目录启动的
loadEnv();
const LEGACY_DB = fileURLToPath(new URL('../data/gongpai.db', import.meta.url));
if (!process.env.CORPUS_DB && !process.env.CORPUS_HOME && existsSync(LEGACY_DB) && !existsSync(dbPath())) {
  console.error(`提示：旧版本的数据库在 ${LEGACY_DB}，新位置是 ${dbPath()}。需要旧数据的话手动移动过去。`);
}
const db = () => openDb(dbPath());
const need = (v: string | undefined, name: string): string => {
  if (!v) { console.error(`缺少 --${name}\n\n${HELP}`); process.exit(2); }
  return v;
};

/** 项目参数可以省略：先按当前目录找，只有一个项目时就用它。 */
function pickProject(d: ReturnType<typeof db>, given: string | undefined): string {
  if (given) return given;
  const cwd = process.cwd();
  const hit = d.projectForDir(gitRoot(cwd)) ?? d.projectForDir(cwd);
  if (hit) return hit;
  const all = d.listProjects();
  if (all.length === 1) return all[0].id;
  console.error(all.length ? `当前目录没有绑定项目，请用 --project 指定：\n${all.map((p) => `  ${p.id}  ${p.name}`).join('\n')}` : '还没有项目。先运行 corpus demo 或 corpus project add');
  process.exit(2);
}

async function extractAll(d: ReturnType<typeof db>, projectIds: string[]) {
  const model = deepseek();
  for (const id of projectIds) {
    if (d.isPaused(id)) continue;
    console.log(`整理「${d.getProject(id)?.name}」：对话正文会发送到远程模型 ${model.name}，读取时已隐藏凭证`);
    const r = await extractProject(d, id, model, { onBatch: (i, n) => process.stdout.write(`\r整理 ${d.getProject(id)?.name}：第 ${i}/${n} 批`) });
    if (r.batches) process.stdout.write('\n');
    console.log(`整理完成：新证据 ${r.stored} 条，丢弃 ${r.dropped.length} 条${r.failed ? `，失败 ${r.failed} 批：${r.errors.join('；')}` : ''}`);
  }
}

async function main() {
  const [cmd, sub, arg] = positionals;
  if (values.help) { console.log(HELP); return; }
  if (cmd === 'tasks') {
    if (positionals.length > 3 || (arg && !['show', 'get', 'cancel', 'status', 'dispatch'].includes(sub ?? ''))) throw new Error('用法：crew tasks list|get|cancel|status|dispatch|stop|mcp，任务编号通过 --task 指定。');
    const { TaskBoardClient } = await import('./task-board-client.ts');
    const client = new TaskBoardClient({ workspace: values.workspace, manifest: values.manifest, boardUrl: values['board-url'] });
    if (sub === 'mcp') {
      const { runTaskBoardMcp } = await import('./task-board-mcp.ts');
      await runTaskBoardMcp(client); // stdout 仅协议；这条入口不打开 Corpus 数据库
      return;
    }
    let result: Record<string, unknown>;
    switch (sub) {
      case 'list': result = await client.list(); break;
      case 'show':
      case 'get': result = await client.get(Number(need(values.task ?? arg, 'task'))); break;
      case 'status': result = await client.status(Number(need(values.task ?? arg, 'task'))); break;
      case 'cancel': result = await client.cancel(Number(need(values.task ?? arg, 'task')), need(values['expected-status'], 'expected-status'), need(values.note ?? values.reason, 'note')); break;
      case 'dispatch': result = await client.dispatch(Number(need(values.task ?? arg, 'task')), need(values.goal, 'goal'), !!values.write); break;
      case 'stop': result = await client.stop(need(values.job, 'job')); break;
      default: throw new Error('用法：crew tasks list|get|cancel|status|dispatch|stop|mcp');
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'project' && sub === 'add') {
    const d = db();
    const id = d.createProject({ name: need(arg, '名称'), goal: values.goal ?? null, dirs: (values.dir ?? []).map((x) => resolve(x)) });
    console.log(`已建项目 ${id}`);
  } else if (cmd === 'project' && (sub === 'pause' || sub === 'resume')) {
    db().setPaused(need(values.project, 'project'), sub === 'pause');
    console.log(sub === 'pause' ? '已暂停采集，已有数据保留' : '已恢复采集');
  } else if (cmd === 'project' && sub === 'list') {
    for (const p of db().listProjects()) console.log(`${p.id}  ${p.name}  ${p.dirs.join('，')}`);
  } else if (cmd === 'sync') {
    const d = db();
    const cc = syncClaudeCode(d);
    const cx = syncCodex(d);
    const vs = syncVscode(d);
    d.logUsage(null, 'sync');
    if (values.quiet && values['no-extract']) return; // 钩子调用：只读，什么都不输出
    console.log(`Claude Code：新消息 ${cc.newMessages}（${cc.files} 个会话）；Codex：新消息 ${cx.newMessages}（${cx.files} 个会话）；VS Code 聊天：新消息 ${vs.newMessages}（${vs.files} 个会话）；未绑定目录的会话 ${cc.skippedSessions + cx.skippedSessions + vs.skippedSessions} 个没有读取`);
    if (cc.badLines + cx.badLines) console.log(`格式异常的行 ${cc.badLines + cx.badLines} 条，已跳过，已有数据不受影响`);
    if (!values['no-extract']) await extractAll(d, d.listProjects().map((p) => p.id));
  } else if (cmd === 'import') {
    const d = db();
    const r = importText(d, { projectId: need(values.project, 'project'), text: readFileSync(need(sub, '文件'), 'utf8'), label: need(values.label, 'label'), title: need(values.title, 'title'), coverage: values.partial ? 'partial' : 'full', date: values.date });
    console.log(`导入 ${r.newMessages} 条新消息${r.unsure ? '；有一段认不出发言者，请在页面上核对' : ''}`);
  } else if (cmd === 'takeout') {
    const convs = readTakeoutPath(need(sub, '文件'));
    const pid = need(values.project, 'project');
    if (!values.pick && !values.all) {
      if (!convs.length) console.log('没有找到 Gemini 对话。网页版的聊天要在 Takeout 里勾“我的活动 → Gemini Apps”，格式选 JSON');
      for (const c of convs) console.log(`${c.key.padEnd(20)} ${c.start.slice(0, 10)} ${String(c.turns.length).padStart(3)} 条${c.missingResponse ? '（缺回复）' : ''}  ${c.source}  ${c.title}`);
      if (convs.length) console.log('\n用 --pick 编号,编号 导入挑选的对话，或 --all 全部导入');
    } else {
      const r = importConversations(db(), pid, convs, values.all ? 'all' : values.pick!.split(',').map((x) => x.trim()));
      console.log(`导入 ${r.sessions} 段对话，新消息 ${r.newMessages} 条。点“同步”整理`);
    }
  } else if (cmd === 'extract') {
    const d = db();
    if (values.fresh) for (const id of values.project ? [values.project] : d.listProjects().map((p) => p.id)) d.resetExtraction(id);
    await extractAll(d, values.project ? [values.project] : d.listProjects().map((p) => p.id));
  } else if (cmd === 'show') {
    const d = db();
    const id = pickProject(d, values.project);
    console.log(renderScene(d.getProject(id)!, buildProjectView(d, id), { color: useColor() }));
    d.logUsage(id, 'show_cli');
  } else if (cmd === 'context') {
    const d = db();
    const pid = pickProject(d, values.project);
    console.log(buildContext(d, pid, `${pid}/${need(values.task, 'task')}`));
    d.logUsage(pid, 'context_cli');
  } else if (cmd === 'team') {
    if (arg) throw new Error('用法：crew team [目录] [--goal <目标>] [--write] [--mode codex-team|delegation] [--demo]');
    const mode = values.mode ?? 'codex-team';
    if (mode !== 'codex-team' && mode !== 'delegation') throw new Error('--mode 仅支持 codex-team 或 delegation');
    if (values.demo && (mode !== 'codex-team' || values.write)) throw new Error('--demo 仅用于离线 Codex 团队展示，不支持 --write 或其他模式');
    const cwd = realpathSync(resolve(sub || process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('team 需要存在的项目目录');
    const { runTeamTui } = await import('./team/tui.ts');
    const workbench = values.demo ? (await import('./team/demo.ts')).createDemoWorkbench() : undefined;
    await runTeamTui({ cwd, mode, access: values.write ? 'workspace-write' : 'read-only', goal: values.goal || (values.demo ? '体验终端成员、提问与审批' : undefined), workbench, demo: !!values.demo });
  } else if (cmd === 'open') {
    if (!sub || arg) throw new Error('用法：crew open <目录> [--port 4173] [--no-open]');
    let dir: string;
    try {
      dir = realpathSync(resolve(sub));
      if (!statSync(dir).isDirectory()) throw new Error('不是目录');
    } catch {
      throw new Error(`无法打开目录：${sub}。请指定存在的目录。`);
    }
    const d = db();
    let id: string;
    try {
      // 历史项目可能绑定了软链接；比较真实路径，避免同一目录重复建项目。
      const existing = d.listProjects().find((p) => p.dirs.some((bound) => {
        try { return realpathSync(bound) === dir; } catch { return false; }
      }));
      id = existing?.id ?? d.createProject({ name: basename(dir) || dir, goal: null, dirs: [dir] });
      if (existing && !existing.dirs.includes(dir)) d.addProjectDir(id, dir);
    } finally {
      d.raw.close();
    }
    const { startServer, openWindow } = await import('./app.ts');
    const port = Number(values.port ?? 4173);
    await startServer(port);
    const url = `http://127.0.0.1:${port}/#/p/${encodeURIComponent(id)}/workspace`;
    console.log(values['no-open'] ? url : `已用${openWindow(url)}打开 ${url}`);
  } else if (cmd === 'app') {
    const { startServer, openWindow } = await import('./app.ts');
    const port = Number(values.port ?? 4173);
    const state = await startServer(port);
    const url = `http://127.0.0.1:${port}/#/`;
    if (values['no-open']) console.log(`本地服务${state === 'running' ? '已经在运行' : '已启动'}：${url}`);
    else console.log(`已用${openWindow(url)}打开 ${url}${state === 'started' ? '。停掉服务：crew stop' : ''}`);
  } else if (cmd === 'stop') {
    const { stopServer } = await import('./app.ts');
    console.log(stopServer() ? '已停掉后台的本地服务' : '后台没有在运行的本地服务');
  } else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.ts');
    const database = db();
    const server = serve(database, Number(values.port ?? 4173));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => database.raw.close());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (cmd === 'mcp') {
    const { runMcp } = await import('./mcp.ts'); // stdout 只留给协议消息，这里不能打印任何东西
    runMcp(db());
  } else if (cmd === 'demo') {
    const { loadDemo, SHOWCASE } = await import('./demo.ts');
    const ids = loadDemo(db(), SHOWCASE);
    console.log(`已建示例项目：${ids.join('、')}。在终端看：corpus show --project ${ids[0]}；打开窗口：corpus app`);
  } else if (cmd === 'eval') {
    console.log('用真模型跑样本，推理模型每批要几十秒……');
    const { reports, outDir } = await runEval(deepseek(), values.only);
    const { text, redLineFailed } = formatReport(reports);
    console.log(text);
    console.log(`\n原始输出存在 ${outDir}`);
    process.exit(redLineFailed ? 1 : 0);
  } else if (!cmd) {
    const d = db();
    console.log(renderHome(d.listProjects().map((p) => ({ project: p, view: buildProjectView(d, p.id) })), { color: useColor() }));
  } else {
    console.error(`不认识的命令：${cmd}\n`);
    console.log(HELP);
    process.exit(2);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
