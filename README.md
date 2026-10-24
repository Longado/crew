<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="Crew" src="docs/logo-light.png" width="520">
  </picture>
</p>

<h1 align="center">Crew</h1>
<p align="center"><strong>你的本地 Agent 工作台：在一个窗口里开 Claude Code 和 Codex，让它们分头干活，再把散在各处的对话整理成一页你敢信的项目现场；本地管家把已有任务整理成今日安排。</strong></p>
<p align="center">给每天同时用几个 AI 做项目的人。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT"></a>
  <img src="https://img.shields.io/badge/tested%20on-macOS-black" alt="tested on macOS">
  <img src="https://img.shields.io/badge/Node-22.18%2B-green" alt="Node 22.18+">
  <img src="https://img.shields.io/badge/status-Alpha-orange" alt="Alpha">
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="https://longado.github.io/crew/">在线演示</a> ·
  <a href="https://longado.github.io/crew/media/explainer.mp4">讲解视频</a> ·
  <a href="#三分钟上手">三分钟上手</a> ·
  <a href="#一起做">一起做</a>
</p>

同类工具把记忆塞回给 AI。**Crew 把项目现场交给你，而且只认证据。**

**跑在本机。每条结论带原话。AI 说做完了，只算待验证。**

Crew 做三件事：

- **工作台**：在项目目录里同时开多个 Claude Code、Codex 终端，单窗、双栏、四宫格随时切；也可以让 Codex 组成小队、或由 Claude Code 当负责人拆成任务卡派给 Codex 执行者，执行者默认只读，写卡需声明可写路径并由 `--write` 授权。交回来的结论要带 `/路径:行号` 出处，验收时系统核对文件和行号是否存在、并把原文几行摘给负责人看，对不上不能验收，出处是否支撑结论由负责人判断。
- **项目现场**：读 Claude Code、Codex、VS Code 和网页 AI 的对话，整理成一页：最初想做什么、后来改了什么、哪些真做完了、哪些只是 AI 说做完了、现在卡在哪、下一步做什么。换个工具接着干，带过去一段准确的背景。
- **本地管家**：`crew housekeeper` 或双击 `scripts/housekeeper/打开本地管家.command`，一个入口打开今日安排（整理已有任务）和凭证与安全页（只读凭证元数据与使用记录，可选项目扫描），详见 [管家说明](docs/HOUSEKEEPER.md)。

它是一个跑在你电脑上的**本地应用**：终端里用 `crew` 命令，桌面上用一个独立窗口。数据都在本机。产品与仓库现都叫 Crew，早先叫 Working Corpus；旧的 `corpus` 命令继续可用。

> **早期版本。** 项目现场的整理逻辑、终端团队的离线演示和负责人模式都实际跑过；窗口里的终端工作台、布局切换、团队页还没在真实窗口里点过一遍，Codex 小队与委派的真实模型闭环也没验证完，整理的准确率没有真实项目上的长期数据。详见[现在的状态](#现在的状态)。

<p align="center"><a href="https://longado.github.io/crew/media/explainer.mp4"><b>▶ 4 分钟讲解视频</b></a>　·　<a href="https://longado.github.io/crew/"><b>在线演示</b></a>　·　<a href="examples/">示例文件</a>　·　<a href="docs/DEMO.md">演示脚本</a></p>

讲解视频和在线演示讲的是“项目现场”这一半：中文配音、带字幕，先讲为什么做、坚持哪几条原则，再演示终端和窗口。在线演示不用安装，打开就是一个“记账小程序”的示例项目：六段对话来自 Gemini 网页、Codex 和 Claude Code，页面上能看任务状态、规划的两个版本、被替代的决定、每条结论的原话，也能取续接上下文。演示是只读的。

<p align="center"><img alt="终端录屏：crew 看所有项目，crew show 看项目现场，crew context 取续接上下文" src="docs/media/terminal.gif" width="760"></p>

<p align="center"><img alt="窗口录屏：点依据看 AI 原话、点继续拿续接上下文、看两版规划、确认完成" src="docs/media/window.gif" width="760"></p>

<sub>两段录屏都是示例项目“记账小程序”，由脚本自动录制，不含真实对话。高清版：<a href="docs/media/terminal.mp4">终端 MP4</a> · <a href="docs/media/window.mp4">窗口 MP4</a>。怎么重录见 <a href="docs/DEMO.md">演示脚本</a>。</sub>

## 可以试试这些

装好以后先跑 `crew demo`，在示例项目“记账小程序”里试：

| 试试 | 看到什么 |
|---|---|
| `crew show` | 规划第 2 版；每个任务写明依据：你确认、原文明确，还是 AI 自述 |
| `crew context --task T04` | 交给下一个 AI 的背景：AI 说月度导出做完了，但还没有你的确认，所以只算待验证 |
| 窗口里点“月度导出”那行的“依据” | 打开是 AI 的原话 |
| `crew team --demo` | 终端里的团队演示，不调用模型；`/help` 看操作，`/quit` 退出 |
| `crew worker guide` | 负责人模式的完整用法，由命令自己打印 |

## 三分钟上手

需要 Node 22.18 或更新版本，不用构建。整理对话需要一个大模型的 key；负责人模式另外需要 Python 3 和已登录的对应执行者命令行（默认 Codex，也可选 Claude）。

### 方式 A：让你的 AI 帮你装

把下面这段贴进 Claude Code、Codex 或其他能用终端的 AI 工具：

```text
帮我在这台电脑上装好 https://github.com/Longado/crew（产品名叫 Crew）。
先读 README.md，检查 Node 是不是 22.18 或更新，把仓库克隆下来，运行 npm install
和 npm link，然后运行 crew demo 建示例项目，再运行 crew app 打开窗口给我看。
如果我还想试负责人模式，提醒我需要 Python 3 和已登录的对应执行者命令行（默认 Codex，也可选 Claude）。
```

### 方式 B：自己装

```
git clone https://github.com/Longado/crew && cd crew
npm install && npm link          # 装好全局命令 crew（旧的 corpus 命令也在）

crew demo                        # 用样本数据建一个示例项目：记账小程序
crew                             # 终端里：所有项目的概况
crew show                        # 终端里：一个项目的现场
crew app                         # 桌面窗口：后台启动本地服务，用独立窗口打开
crew stop                        # 停掉后台服务
```

macOS 上想要一个双击就能打开的应用：

```
npm run mac-app                  # 生成 dist/Crew.app，依赖当前仓库和 Node，不是独立安装包
```

## 用在自己的项目上

```
cp .env.example .env                                   # 填 DEEPSEEK_API_KEY
crew project add "项目名" --dir /你的/代码目录 --goal "一句话目标"
crew open /你的/代码目录                                 # 打开这个目录的工作台，自动关联项目
```

之后在项目目录里直接敲 `crew show` 看现场，`crew context --task T03` 打印某个任务的续接背景，贴进任何 AI 工具接着干。

## 让 Claude Code 当负责人，Codex／Claude 当执行者

Claude Code 把活拆成任务卡，并行派给 Codex 或 Claude 执行者，交回的结论要带出处，你验收后依赖它的下一步才开跑。最适合要读一大堆材料、能拆成互不依赖的几块、每条结论都要带出处的只读分析；也能派写卡改文件。执行者默认只读，写卡须声明可写路径并由 `--write` 授权。

```
crew worker run <运行目录> --cwd <材料所在目录> --goal "<要回答什么>"  # 就绪的卡同时开跑，立刻返回
crew worker wait <运行目录> --minutes 10               # 有卡交回或卡住就返回，附进度
crew worker check <运行目录>/t1.out                    # 核对交付里的 /绝对路径:行号 出处
crew worker accept <运行目录> t1 --note "抽查了哪几条"   # 验收；通过后自动派出本次解锁的下游
crew worker reject <运行目录> t1 --note "哪里不行"      # 退回
crew worker run <运行目录> --retry t1                  # 接着原会话改；--fresh 明确重开
crew worker status <运行目录>                          # 逐卡进度
crew worker guide                                      # 完整规则
```

卡头、写卡、接续、`watch`／`pause`、跨运行依赖、`result-v1` 等完整规则由 `crew worker guide` 打印。看板的“负责人运行”可只读查看卡片状态、用时、tokens、验收与结论摘要；命令行也可运行 `python3 scripts/lead/runs_registry.py list`。

## 用 AI 做项目的人，每天都在问这四个问题

1. 我最初想做什么？后来改过哪些要求？
2. 哪些真的做完了，哪些只是 AI 说做完了？
3. 现在卡在哪，下一步该做什么？
4. 换一个会话或工具，怎样不用把整个项目重新解释一遍？

聊天记录里都有答案，只是散在不同工具的几十段对话里。Crew 把它们读出来，整理成一页。

## 能做什么

| | |
|---|---|
| 项目终端 | 在绑定的目录里启动 Claude Code 或 Codex 终端，单窗、双栏、四宫格；每种布局各记一份显示的会话，来回切换不丢；会话命名、搜索；只管理 Crew 自己新建的终端，不接管已有的 |
| 终端团队 | `crew team`：Codex 拆分任务、分给成员、负责人验收；Tab 切成员，补充信息、回答提问、逐项审批、中断；默认只读，`--write` 在隔离副本里改，不自动合并回源项目；`--mode delegation` 改由 Claude 当负责人 |
| 负责人模式 | `crew worker`：任务卡、依赖、并行派出、先交先通知、验收或退回、核对出处的文件和行号 |
| 本地管家 | `crew housekeeper` 一键打开今日页；汇总已有任务的安排，安全页查看凭证元数据、使用记录及已配置的项目扫描；外部组件按需接入，见 [管家说明](docs/HOUSEKEEPER.md) |
| 任务看板 | `crew tasks`：读你工作区的任务库，把任务派给执行者，停止绑定到具体一次运行，服务重启后显式核对未结的运行；也有 MCP 入口 |
| 读对话 | Claude Code、Codex（命令行和 VS Code 扩展都算）、VS Code 自带聊天，直接读本机文件，按代码目录自动归到项目；网页 AI 可以粘贴导入、从 Google Takeout 的 zip 导入，Gemini 还能装浏览器扩展一键加入、之后自动补新消息 |
| 项目现场 | 当前目标和规划版本、上次停在哪、需要你处理的、下一步、任务列表、最近的决定；顶部的语料带里每个方块是一条消息，颜色是它支撑的任务的状态 |
| 任务状态 | 跨工具的同一件事只算一个任务；AI 说完成只算待验证，你确认了才算完成；返工重开原任务，不新增 |
| 规划和决定 | 最初规划、当前规划、每次变更都留着；AI 提议你没确认的不进范围；被新决定推翻的标为“已被替代”；原文没说原因就写“未说明” |
| 续接背景 | 目标、当前规划、这个任务的进展、相关决定、阻塞、前置条件，以及“不要做”的已取消事项；可复制、可导出 |
| 追溯和纠错 | 每条结论点开有原话；合并、拆分、改名、改状态、移到别的项目、从头重新整理；你改过的，自动整理不会悄悄覆盖；两段来源说法相反又分不出先后时，摆出来让你定 |

## 和别的工具哪里不一样

- **给人看，不是塞给 AI。** claude-mem、ai-memory 把记忆写回给 AI，SpecStory 把对话存成档案。Crew 给你一页扫一眼就懂的项目现场。
- **只认证据。** AI 说“做完了”“测试通过了”，只算待验证。每个状态都写明依据是你确认的、原文写明的，还是 AI 自述。
- **派活也只认证据。** 执行者交回来的结论，出处必须写成 `/绝对路径:行号`；验收时系统核对每条出处的文件和行号是否存在，并把那几行原文摘给负责人看，文件或行号不存在就不能验收，出处是否支撑结论由负责人判断；先验收，依赖它的下一步才会开跑。
- **大模型只做一件事。** 整理对话时，它只负责把消息标成证据，并且必须引用原话。状态、数量、规划版本、下一步、前置条件都由代码按固定规则算出来，同样的记录永远得到同样的结果。
- **你说了算。** 你的修正优先；和新证据冲突时放进“待确认”，让你决定。

## 接到 AI 工具里

这些都是薄连接器，离开本地应用用不了。

| 连接器 | 做什么 | 说明 |
|---|---|---|
| Claude Code 插件 | 在对话里直接取项目现场和续接背景；会话结束时在后台同步 | `/plugin marketplace add Longado/crew`，见 `docs/PLUGIN.md` |
| MCP 连接器 | 给 Codex、Cursor 等支持 MCP 的工具用 | 见 `docs/MCP.md` |
| Gemini 浏览器扩展 | 在 Gemini 对话页上点一下加入项目，之后自动补新消息 | 开发者模式加载 `extension/`，见 `docs/EXTENSION.md` |

## 它是怎么工作的

<p align="center"><img alt="架构：来源 → 读取与归属 → 大模型把消息标成带引用的证据 → 代码按规则折叠成项目现场 → 终端、窗口、续接上下文、连接器" src="docs/media/architecture.png" width="900"></p>

整理对话时，大模型只做一件事：读新消息，标出哪条消息说明了哪个任务发生了什么，并且必须引用原话。引用不存在的证据直接丢掉；谁说的按原文记，不听模型的；没有你的原话，就不算你确认。任务状态、规划版本、决定和下一步全部由代码按规则算出来，同样的证据永远算出同样的结果。

完整规则见 `docs/contracts.md`。工作台、团队和任务看板的设计见 `docs/CREW.md`、`docs/TEAM-WORKBENCH.md`、`docs/TASK-INTERFACES.md`。

## 数据和隐私

- 整理对话时只读取你绑定的目录下的会话，别的目录一概不读。
- 数据都存在本机 `~/.working-corpus/`；本地服务只监听 127.0.0.1，只对浏览器扩展放行跨域，网站来源一律拒绝。
- 网页里第一次整理前会说明发送什么内容，你同意后才把对话正文发给远程模型；命令行 `crew sync`、`crew extract` 不询问，只在发送前打印一句会发到哪个远程模型。读取时已把像密钥、令牌的内容换成“[已隐藏的凭证]”。
- 本地管家的钥匙库目录只读，页面只展示凭证元数据和使用记录，不读取钥匙串里的秘密。原生 helper、扫描器和外部任务库都须显式配置；未配置的组件不可用，配置见 [管家说明](docs/HOUSEKEEPER.md)。安全页与今日页接口拒绝跨域请求，包括浏览器扩展来源。
- 负责人模式里，任务卡的全文和执行者读到的文件内容，会发给对应执行者配置的模型；先想好哪些材料可以交出去。Claude 执行者默认不开放网页搜索与抓取，只有显式 `--allow-web` 才开启；模型推理仍需连接供应商。
- 可以暂停采集（已有数据保留），也可以删除项目（相关记录一起清掉）。

## 现在的状态

做过的检查：已有自动回归覆盖；整理对话的评估在七个样本场景里，硬红线从没失败过，用 `deepseek-flash` 整理一个 74 条消息的真实项目约 2 分钟，评估记录在 `docs/EVAL.md`，样本少，只说明这几种场景没出错，不代表真实对话里的准确率。负责人模式在多轮真实开发中用过，只读卡和写卡都派过，单卡用时从几分钟到几小时不等；Claude 只读执行者也真跑过；终端团队的离线演示在真实终端里能启动并正常退出。

还没验证的：

- 窗口里的项目终端、布局切换、团队页，没有在真实窗口里逐项点过；
- Codex 小队和 Claude/Codex 委派的真实模型闭环，没跑完；
- 原生凭证管家和真实扫描器的真实交互尚未验收，目前原生录入与检测仅供假 Key 隔离测试；
- 网页版 Gemini 的 Takeout 导出格式、浏览器扩展在登录后的真实页面上的表现、大模型在真实项目上的长期准确率。

已知限制：

- 编排工具（比如 Orca）派给 worker 的指令会被当成你说的话；Codex 的工具报错、Claude Code 子 agent 的会话暂时不读；
- 负责人模式按卡头区分只读与写卡，Codex 写卡须 `--write` 授权，Claude 只读；执行者不能中途提问，运行记录保存在指定运行目录，看板的“负责人运行”可只读查看；
- Claude 执行者到结束才返回完整输出，运行中用量未知，不按无输出时长判断停滞；看守心跳、失联、执行时限和停止确认仍生效；
- 任务看板重启后，未结运行保留回执并标为“待重新核对”；重新核对时 Crew 证实原运行已结束就自动结算，查不清的才由用户核对原运行编号、确认已结束后结算，都不自动续跑；
- 团队的任务、审批和消息在服务重启后不恢复，隔离副本保留；
- macOS 应用是依赖当前仓库和 Node 的启动器，不是独立安装包。

## 接下来

这些是方向，还没排期。

- 窗口里的团队条直接显示“待我处理”的审批和提问数，输入草稿在切换会话后不丢，已结束的会话可以折叠。
- 用真实项目校准：记录每次手动修正，修正最多的地方就是整理规则该改的地方。
- 证据不只来自对话：把 git 提交、测试结果、CI 状态也当证据，“待验证”可以有更硬的依据。
- 更多来源：ChatGPT 和 Claude 网页的扩展，页面上直接选文件导入，归属不明的对话先进“待归类”。
- 独立安装包：把 Node 打进去并签名，没有开发环境也能装。

## 一起做

这个项目想回答一个问题：**同时用好几个 AI 做项目，能不能既让它们分头干活，又让你始终敢信手里的项目现场？** 不用把整件事都解决，也能帮上忙。

| 你喜欢…… | 可以贡献 |
|---|---|
| 用 AI 做真实项目 | 一次整理出错的例子：哪条结论不对，原话是什么（先去掉敏感内容） |
| 研究某个 AI 工具 | 新的来源：ChatGPT、Claude 网页版的导入或浏览器扩展 |
| 多 agent 编排 | 负责人模式里的卡片、验收和退回流程怎么更省 token、更不容易被糊弄 |
| 评估 | 新的样本场景和硬红线，放进 `crew eval` |
| 前端和交互 | 窗口里的项目终端、团队条、项目现场、语料带 |
| 写作 | 英文文档、其他系统上的安装说明 |

欢迎提 issue 或 pull request。

## 开发

```
npm test                     # 单元测试，不调用模型
npm run typecheck
python3 scripts/lead/run_tests.py    # 负责人完整回归，临时登记目录与假 Codex，不调用模型
npm run test:lead                    # 同一测试入口
bash scripts/make-logo.sh    # 重新生成 logo（需要 Chrome）
crew eval                    # 用真模型跑样本，硬红线有一条没过就返回失败
```

| 文档 | 内容 |
|---|---|
| `docs/CREW.md` | 工作台、终端团队、负责人模式的入口和边界 |
| [docs/HOUSEKEEPER.md](docs/HOUSEKEEPER.md) | 本地管家启动、配置、未配置时的页面与安全边界 |
| `docs/TEAM-WORKBENCH.md` | 团队工作台 |
| `docs/TASK-INTERFACES.md` | 任务命令和任务 MCP |
| `docs/DEMO.md` | 演示脚本：终端和桌面窗口 |
| `docs/PLAN.md` | 项目现场部分到 2026 年 9 月中旬的开发计划和分步进度 |
| `docs/REQUIREMENTS-GAP.md` | 项目现场部分对照需求文档 v0.2 的完成情况（到 9 月中旬） |
| `docs/contracts.md` | 模块之间的约定、状态规则 |
| `docs/EVAL.md` | 每次改提示词或换模型的评估记录 |
| `docs/FORM.md` | 形态研判：为什么是本地应用加连接器 |
| `docs/PLUGIN.md` · `docs/MCP.md` · `docs/EXTENSION.md` | 三个连接器 |
| `docs/HANDOFF.md` | 交接：现在到哪了、下一步 |
| `prompts/evidence.md` | 整理对话用的提示词，文件头有版本号 |
| `scripts/lead/指南.md` | 负责人模式指南（`crew worker guide` 打印的就是它） |

## 许可证

MIT
