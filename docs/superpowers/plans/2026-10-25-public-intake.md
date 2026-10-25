# Crew 材料变行动 · GitHub 发布候选实施计划

> **For agentic workers:** Implementation is authorized. Use subagent-driven-development, keep one implementation owner at a time, then review requirements and code quality before accepting each round.

**Goal:** 陌生用户从公开仓库安装 Crew 后，可以用合成样本理解结果、用自己的项目和材料生成有出处的建议，并记录采用决定。

**Architecture:** 保留现有两阶段 intake 和外部 SQLite 接口。增加独立 JSON 项目目录、离线示例、可回查的结果和单独保存的用户决定；不把建议自动执行或写进业务任务库。现有工作台、管家和派工功能保留，不在本轮扩建。

**Tech Stack:** 现有 Node CLI、Python 标准库、Markdown/JSON；不新增生产依赖。

## 授权与验收

- 2026-10-25 Eddie 要求尽可能持续推进、每轮验收，目标是可上线且有人愿意用的 GitHub 工具；随后选择首版突出“材料变行动”。这替代此前仅按四张旧卡反馈再开发的限制。
- 本地实现、隔离安装、合成材料运行、独立复审可以连续进行。实际 push、GitHub Release 或更新线上页面留到具体版本可审阅后由 Eddie 确认。
- 基线：`5751855`，分支 `crew/github-ready-20261025`。主检出 `lead/orchestration-fold` 和已有 intake 工作树保持原状。
- 每轮先实现用户可观察行为，再运行对应检查和真实命令，随后分别做需求与质量复审；未解决的阻塞不记通过。测试回执保存在 `docs/verification/public-intake-2026-10-25.md`。

## 第 1 轮：不用私人任务库也能开始

文件：`scripts/intake/intake.py`、`scripts/intake/test_intake.py`、`tests/intake-cli.test.ts`、`src/cli.ts` 的 intake 帮助、`docs/INTAKE.md`、`examples/intake/`。

- [x] 新增 `--catalog <projects.json>`，和显式 `--database` 互斥；选 catalog 时忽略环境里的 `CREW_TASK_DB`，不误读私人库。旧 database 参数和环境变量用法保留。
- [x] JSON 契约：`{"version":1,"projects":[{"id":1,"name":"Release Notes","description":"Turn release notes into a reader-friendly changelog","path":"projects/release-notes","status":"active"}]}`。id 是唯一正整数；name/path 非空；description 默认空；status 默认 active，只接受 active/paused；不支持的字段、重复编号、错误类型、过大文件和超出数量上限明确报错。规范化为既有内部项目结构，tasks 为空。
- [x] 增加合成材料与两个项目的当前文档；无真实客户、个人信息或绝对机器路径。README 给能复制运行的 `--dry-run` 和正式分析命令。
- [x] 先写失败用例，再实现；验证 dry-run 不创建输出、不调用模型，catalog 全流程保留引用与原件，旧 SQLite 用例继续通过。
- [x] 独立需求复审、代码复审与正式 CLI 样本操作通过。

验收命令：

```sh
python3 -B -m unittest discover -s scripts/intake -p 'test_*.py'
node --no-warnings --test tests/intake-cli.test.ts
node --no-warnings src/cli.ts intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

## 第 2 轮：回查与恢复

文件：`scripts/intake/intake.py`、`scripts/intake/test_intake.py`、`docs/INTAKE.md`。

- [x] 卡片原文、原文快照和项目文件的 Markdown 链接都指向存在的文件，行号单独显示；用相对路径和 URL 编码支持空格、中文和括号。保留源引用文字，不把行号拼进文件名。
- [x] 缓存存在但不能解析或未通过当前结构/引用校验时，先把坏缓存及原因保存在 rejected 中，再仅对这个阶段重新请求一次。结果中列出恢复记录；验证失败的新模型结果仍按原流程失败，不进行循环重试。
- [x] 原始资料、来源快照和旧卡保持不变；重跑不删除已有成果，不覆盖 rejected 记录，不能经输出符号链接写到别处。
- [x] 先用损坏 JSON 和不再符合引用的缓存制造失败，再做最小修复；验证只重跑相应阶段，正常缓存仍为零请求。
- [x] 独立需求复审、质量复审及生成卡的本地文件链接检查通过。

验收：`python3 -B -m unittest discover -s scripts/intake -p 'test_*.py'`，以及 `node --no-warnings --test tests/intake-cli.test.ts`。真实合成卡继续作为人工阅读样本。

第 2 轮升级场景补充：卡片渲染版本必须进入卡片目录 key，独立于模型缓存版本。旧卡存在时重跑产生带新链接的卡，模型请求仍为零，旧文件不改。

## 第 3 轮：逐条决定与导出

文件：新增 `scripts/intake/review.py`、`scripts/intake/test_review.py`；修改 `scripts/intake/intake.py` 的命令分发与动作显示、`tests/intake-cli.test.ts`、`src/cli.ts` 的 intake 帮助、`docs/INTAKE.md`。

- [x] 卡片建议按原数组顺序显示 A1、A2 等编号。新增 `crew intake review <card.json>` 展示每条建议及当前决定；`--json` 给结构化结果。
- [x] `crew intake review <card.json> --action A1 --decision accept|defer|dismiss [--note 说明]` 只保存用户对该建议的选择；没有 action/decision 就只读，有且只有一个时清楚报错。错误编号、坏卡片、坏review文件不写入。
- [x] 决定保存在卡片旁的 `review.json`，包含有序历史；原 card.json/card.md、来源、项目和任务库不改。每条决定绑定 card.json 原始字节 SHA256 和动作编号；卡片内容变更或新分析生成新卡时，旧决定保留为历史，但不自动套用。
- [x] 默认所有建议为待决定；同一建议多次决定以本版本最后一条为当前值，展示历史供回看。所有写入沿用私有权限和输出路径保护；同目录锁内重新读卡、追加事件并原子保存。
- [x] `crew intake export <card.json> [--format markdown|json]` 仅向stdout输出当前版本已采纳建议，包括来源、所关联项目、原文引句/行号、项目引用及用户说明。输出明确“已采纳建议，尚未执行”，没有采纳时说明为空；不会自动调用工具、修改项目、建任务或写文件。
- [x] 先红后绿覆盖：初始待决定；accept→defer→accept留历史；两个建议只导出被采纳的；卡片被改后旧决定不适用；错误输入、损坏review和符号链接不写；正式CLI不创建Corpus库、不调用模型；源与卡片字节不变。
- [x] 独立需求/质量复审，以及在本轮合成真实卡上记录一条试验决定并导出通过。该试验决定不是 Eddie 对产品建议的实际采纳。

## 第 4 轮：轻量入口与离线示例

文件：新增 `scripts/intake/demo.py`、`scripts/intake/test_demo.py`；修改 `bin/crew`、`bin/corpus`、`scripts/intake/intake.py` 的demo分发/标识、`examples/intake/README.md`、`docs/INTAKE.md`，对应入口测试。

- [x] `./bin/crew intake ...` 和 corpus兼容入口直接调用Python，不加载Node、不安装npm依赖；其余命令沿用原有Node路径。两层包装脚本可靠解析绝对/相对符号链接，不依赖可选realpath，支持路径空格和单引号。
- [x] `crew intake demo [--output 私有目录]` 用仓库合成材料和手写固定分析，走真实的校验/卡片/回查/决定链路，不运行Claude、不读登录态、不调用网络或读真实项目。
- [x] 示例输出明确标注“合成演示，使用预设分析，不调用模型”，不冒称实际模型结果。示例缓存和实际分析缓存的namespace隔离，即使用户指定同一输出目录也不能把手写分析当实际模型结果复用；真实分析原缓存key保持兼容。
- [x] demo生成两条可决定建议，给出实际卡片路径和可直接复制的review/export命令。默认用独立demo输出目录；无默认采纳。再次运行可以复用，但不重置用户决定。
- [x] 结果展示先呈现摘要、项目和编号动作，详细原文事项与引用仍可回看；去掉Markdown输入首行导致的双#标题。展示变化独立提高renderer版本，旧结果不覆写。
- [x] 无node/npm/claude的受控PATH、临时源码副本与符号链接入口下完整demo→review→export成功；目录有空格、中文、单引号；原件不变，无额外依赖或模型调用。
- [x] 独立需求/质量复审通过。

## 第 5 轮：公开仓库入口与发布候选

文件：`README.md`、`README.en.md`、`docs/INTAKE.md`（最终一致性）、`.github/workflows/test.yml`、简明贡献/发布说明、`package.json`和lock根版本字段、`scripts/build-site.ts`与`web/app.js`的静态演示标题/说明、`docs/HANDOFF.md`；主线程维护本计划和验收记录。

- [x] 中英文首页突出材料变行动，一眼可见输入、输出和用途；最短试用以Python3.9+和`./bin/crew intake demo`为准。完整工作台的Node安装作为可选项，保留已有功能文档入口。
- [x] 给真实资料处理、项目JSON、逐条review/export的完整命令；说明文本格式、macOS/Linux边界、Claude订阅登录前提、向模型发送的内容和本地保存目录；演示/真实分析/用户采纳/实际执行不能混同。
- [x] 已有CI增加intake Python与无账户demo/决定/导出操作，不调用真实模型；不因改新入口扩大老工作台的测试/配置改造。
- [x] 现有GitHub Pages仍保留项目现场只读样例，只修标题/提示，明确材料处理需要在本机运行；不新建在线上传或分析入口。
- [x] 从独立源码副本按README执行完整路径，不依赖当前工作树未提交文件、Eddie任务库、浏览器或秘密配置。
- [x] 发布说明包含具体用户变化、已知限制、安装方式和反馈入口；给出准确候选commit/产物，实际push和线上发布仍等Eddie对该版本确认。
- [x] 最终独立审阅、相关回归和原范围核对通过；更新主HANDOFF和session_log，留下下一入口。

## 迭代边界

根据前一轮的实际结果细化下一轮，不重复开展全面审查。这里的验收不等于外部用户已经喜欢或采纳。

不增加后台监听、自动执行、云托管、新模型服务、任务数据库迁移、全仓库重构或无关桌面打包修复。
