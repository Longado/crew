# Crew 材料变行动 · 本地发布候选验收

基线：`5751855`。工作分支：`crew/github-ready-20261025`。本记录只描述本轮实际操作，不代替真人采用、远端 CI 或发布结果。

## 范围

用户选择材料变行动作为首版公开入口。先完成独立上手、回查与恢复、建议决定、示例和发布准备。每轮有需求复审、质量复审及实际命令操作。

## 初始观察

- 当前入口只认 Workspace 特定 SQLite 字段，无法直接用 Crew 原生项目库，且 README 首次体验没有材料处理。
- Markdown 的 `文件:行号` 链接依赖特定客户端；损坏缓存没有恢复路径。
- npm link 包装脚本在缺少 realpath 时不能可靠解析符号链接。
- Finder Node 版本管理器支持和带单引号的 macOS 打包路径也有问题，但不属于选定材料入口，本轮不修改。
- GitHub `Longado/crew` 已公开，默认分支 main；当前远端简介仍是旧 Working Corpus 项目现场描述。本轮尚未对远端写入。

## 第 1 轮：独立项目目录 · 已通过

- 版本：`8b1cfc3`。新增显式 JSON 目录入口与两项目合成样本，原外部 SQLite 用法保留。
- 基线 Python 16 项通过。实现者先看到缺失 catalog 参数/选项导致失败，再实现；当前 Python 18 项、Node CLI 3 项、typecheck 通过。
- 主线程正式 CLI 运行样本 dry-run：project_count=2、max_model_calls=2、database=null；没有输出目录/Corpus库创建。命令与示例README一致。
- 独立需求复审 catalog_spec：PASS；独立质量复审 catalog_quality：可接受，未发现新增阻塞。复审均读取实际 diff 并运行相关检查。
- 隔离工作树首次 npm ci 下载超时；registry 可达，使用已下载缓存做有界重试后 npm ci 退出0并安装101包。未改依赖版本、lockfile或全局npm配置。
- 合成材料真实 Claude 订阅分析另在进行，记录到后续整体验收；本轮通过不冒称模型用途判断已有用户采纳。

## 合成材料真实分析

- 在第1轮代码上通过正式 Node CLI 发起 Claude 订阅分析，输出到 Workspace 私有目录 `crew-release-2026-10-25/catalog-round`，运行 `fbb3f8dc6be6a8ad6eee4745` 完成，2 次模型请求。
- 实际关联发布说明助手一个项目；花园日志没有被硬关联。生成一条留作参考的建议，引用发布说明出处和适用版本的原句，并引用项目当前缺口；未把合成讨论写成实施结果。
- 主线程读完实际卡片，观察到文字仍偏长、Markdown 首行标题重复 `#`；前者作为展示优化输入，后者在后续展示轮修正。此运行使用第1轮旧renderer，不能算第2轮链接检查。
- 第2轮补丁后设置 `CREW_CLAUDE_BIN=/usr/bin/false` 再走正式CLI，运行 `e4cb473f47a95d3568ff29a9`：0模型请求，新卡 key `6d12eaa091800b5a004f2ce434046f94cb7f70b3df8717eeac0db838daf9714a`，旧卡 key `1b5c2774b07d7ce99d52aad51ea22b298c7312d64b4ae1bfe105fb6d43cb420c` 保留。

## 第 2 轮：回查与恢复 · 已通过

- 初版 `50256aa` 新增恢复与相对链接，测试先红6项后绿24项；首次需求复审发现已有卡片重跑仍返回旧链接。
- 补丁 `bde02d6` 以独立 CARD_RENDER_VERSION 更新卡片key，保留模型缓存和旧卡。升级测试先红后绿，Python25项、CLI3项。
- 独立需求复审 recovery_spec 用基线真实生成旧卡再升级：新版链接可解析、旧卡/快照/缓存字节和修改时间不变、0模型调用、再次复跑稳定，PASS。
- 质量复审 recovery_quality 进一步发现恢复后答案变化仍返回旧卡；`e63bbbd` 将实际 analysis/card_data 摘要纳入卡片key。针对不同答案的测试先红后绿，Python26项、CLI3项。
- 两位原审阅者定向复审分别确认：analyze/relate的新答案会生成新卡，相同答案复用；旧卡不变，JSON/Markdown/汇总一致，后续0请求稳定。最终需求PASS、质量可接受。
- 主线程在真实合成结果上用禁用模型的正式CLI再运行，最终卡 `4368326417e7c9652332c701a1b249cdb86aa6c98288cba76b26c210cb29efbc`，0请求，13个文件链接均解析到实际文件。

## 后续回归范围

- 独立检查发现全量 npm test 的 mac-app.test.ts 会启动headless Chrome，extension-extract.test.ts 在CI环境也会启动Chrome；本机本轮不运行这两项。
- plugin.test.ts 的 sync --no-extract 会读真实会话目录，也排除。本轮改动不涉及这些功能。
- 最终Node回归使用临时CORPUS_HOME、删除继承的CORPUS_DB和真实外部集成变量、临时vault目录；不改HOME，也不读取主检出的.env。剩余用例使用合成模型/执行者或本地HTTP/PTY。

## 第 3 轮：逐条决定与导出 · 已通过

- 实现 `6681875`，修复 `4942dbd`。新增review/export、A编号、绑定原卡字节摘要的有序决定历史；原卡不改，导出仅本版本当前采纳项。
- 首次需求复审发现缺少项目映射的坏卡会先写再报错；先红后修项目/context/doc/item关联校验，坏卡现在exit2且不生成review.json。
- 最终Python33项、Node CLI4项、typecheck、diff检查通过；review_spec定向复审PASS，review_quality可接受。
- 主线程正式CLI使用已生成的合成真实分析卡：初始pending→accept导出1条→defer导出0条→accept，历史3条；卡JSON与Markdown指纹不变，review.json权限0600，模型调用0。
- 操作样本卡 `3670a867b1bc5c23b9fe28428c9e347e3de943abca05ed42ad631ecdd6e36f61`。每条试验说明均明确是合成验收，不代表Eddie实际采纳；没有项目或任务库写入。
- 限制：同时写同一卡的锁竞争明确失败，用户可重试；纯读和导出不创建存储。

## 第 4 轮：轻入口与离线示例 · 已通过

- 实现 `65e9ed2`，计数修正 `04ac509`。intake经bash入口直接Python；其余命令保留Node路径。符号链接解析不再依赖realpath。
- 离线预设示例和真实模型缓存分离，演示标识传播到卡片、决定与导出；动作优先展示，Markdown标题不再重复井号。
- 初次计数仍把预设函数记成model_calls，新增红测后改为model_calls=0、preset_calls独立。测试不覆盖HOME，默认位置通过mock Path.home验证。
- 独立需求demo_spec PASS、质量demo_quality可接受；Python36项、Node CLI5项、typecheck与diff检查通过。
- 主线程实际用PATH=/usr/bin:/bin且CREW_CLAUDE_BIN=/usr/bin/false从bin入口运行demo→review→accept A1→export→再次demo。无需Node/npm/Claude，导出mode=demo且只有一条，重复demo保留accept，model_calls=0。中文“已采纳/待决定”显示正确。
- 卡片：私有offline-demo目录中的 `20d8149e9cbf93483152e8f995c47cdb0731fa85f585be46082229101c733677`；本次选择仅是合成演示操作。

## 静态演示检查边界

- 共享浏览器ws://127.0.0.1:9339/pw连接被拒（ECONNREFUSED），未启动其他浏览器，尚未在浏览器里看过本轮静态说明。
- 本轮静态页面只准备调整旧项目现场演示的标题/说明，不增加材料上传、在线分析或新交互。构建与源码核对不能称作浏览器视觉检查。

## 第 5 轮：公开入口与发布准备 · 已通过本地验收

- 版本 `57bebc0`、文案补丁 `a2bd950`、既有安装契约补丁 `2b276f4`。中英README聚焦材料流程，完整工作台保留为可选入口；MIT/Alpha与私有保存、远程分析边界明确。package/lock=0.3.0，private与依赖版本不变。
- CI只增加Python3.9材料检查与禁用Claude的离线demo；现有jobs保留。旧Pages的生成标题/description、静态角标与局部防溢出已更新，构建产物核对完成，本机工作台标题不改。
- release_spec独立需求PASS，release_quality质量及整轮集成审阅可接受；两个文案补丁分别定向复审通过。
- 独立git archive源码副本（`a2bd950`，后续只有README安装文字改变）无node_modules，PATH只保留系统工具，Claude替身禁止调用：demo首次两条pending、采纳A1只导出一条、重复demo保留选择且0请求、catalog dry-run两项目且无输出，样本原件指纹不变。回执在私有validation/fresh-source.json。
- 扩大回归：92个Node测试文件（排除范围见前文），首次538项中535通过、3失败（README契约一项，终端超时子项及其父项）。README克隆/插件入口按原契约恢复，先红后绿。终端失败在首次ready等待，并非输入丢字断言；相关终端代码及测试本轮无diff。两文件单独串行复测49/49通过。没有据一次并行超时改动无关终端，也不将首轮记录改写成全通过。
- 相关Python最终36项、Node intake CLI5项、typecheck、JS语法、版本/lock与文档目标核对通过。详细Node日志位于私有validation/node-regression.log与terminal-and-readme-recheck.log。
- 正式检出已从5751855快进到2b276f4；正式全局crew入口实际生成mode=demo且model_calls=0的卡，证明本地入口已接回。开发工作树和原材料工作树继续保留。
- 对外状态：未push、未创建PR或Release，远端main仍是本轮开始时核对的d340672。公开发布须在具体候选确认后进行。

## 2026-10-25：批准后公开发布

- Eddie 明确确认将候选推送、合并main并发布Alpha。候选分支已推送，创建PR #1。上一节“未发布”仅描述候选交付时点。
- 首次GitHub run `40169107439` 的intake job在安装Python前失败：该次ubuntu-latest分配Ubuntu26.04，官方没有对应Python3.9 x64包，测试未开始。`b742732` 仅将intake运行环境固定为仍提供Python3.9构建的ubuntu-22.04；其他jobs、最低Python版本和产品代码不改。独立复审确认最小范围与官方版本依据，旧失败run在新run启动后取消。
- 新head的run [40169297887](https://github.com/Longado/crew/actions/runs/40169297887) 中test、lead、intake全部success；按该精确head合并 [PR #1](https://github.com/Longado/crew/pull/1)，合并版本 `2865ec54aac480a79841266796153109fd704ac9`，时间2026-10-25 06:36:36 UTC。合并后的git tree与b742732完全一致。
- [v0.3.0](https://github.com/Longado/crew/releases/tag/v0.3.0) 于2026-10-25 06:37:48 UTC发布，isDraft=false、isPrerelease=true，tag指向上述合并版本。未移动已发布标签，未覆盖先前本地候选包。
- 上传的源码包 `crew-0.3.0-b742732.tar.gz` 为13,841,346字节；SHA-256 `42324a611d8e2d4b7bb83a375856804e7fcef2db03e2379cd5012b49fdea55e1` 与GitHub资产digest一致，校验文件也已上传并核对digest。包内无node_modules、真实.env、数据库或私有目录；旧ef1d560包仅保留在本地。
- 仓库简介已更新。Pages部署 [40169699253](https://github.com/Longado/crew/actions/runs/40169699253) success，公开HTTP读回标题“Crew · 项目现场只读演示”及材料本机处理说明；未把HTTP内容核对写成浏览器视觉检查。
- 发布回执、候选更新和私有日志保存在既有publication/validation目录；这次发布不构成真实用户采用或受欢迎程度的证据。
- main合并版本的再次运行 [40169699303](https://github.com/Longado/crew/actions/runs/40169699303) 也已success。匿名访问源码包HEAD返回200，公开校验文件GET成功且内容一致。
- 发布后本机完整取回的额外尝试未完成：正式tag浅克隆在180秒超时；Release源码包下载在约90秒收到406,437/13,841,346字节后超时。因此不声称完成了“从远端完整下载后本机重跑”。此前独立源码副本运行、GitHub完整运行和上传资产digest核对分别成立；本次未为网络慢而改代理、凭证或产品代码。
