# 材料变行动

把会议转写或研究笔记交给 Crew，它会先提取案例、观点和设想，再对照现有项目的当前资料，生成带原文出处的待确认行动建议卡。卡片说明材料能用在哪、建议做什么，以及暂时不值得做什么。

## 先试一次离线演示

从仓库根目录运行，只需 macOS／Linux 和 Python 3.9+，不需要 Node、npm、Claude 登录或网络：

```sh
./bin/crew intake demo
```

这是**合成演示，使用预设分析，不调用模型**。演示读取仓库内既有的合成访谈、项目清单与交接文件，以手写分析经过正常的引用校验、快照和卡片流程。预设的 A1 是评估发布说明草稿里的出处与适用版本，A2 是建议暂缓自动发布；首次运行两条均为 `pending`，它们不是模型分析结果。

默认写入 `~/.local-sensitive/crew-intake-demo/`。可用 `--output DIR` 另选目录；`--json` 输出可解析的路径及 `mode: "demo"`。命令会给出实际卡片路径，以及可以直接复制的查看决定、采纳 A1 和导出命令。重复演示保留已有决定，采纳仍不会执行建议。

演示预设缓存单独保存在 `demo-cache/`，与真实分析的 `cache/` 隔离。卡片、运行报告、决定展示和导出均保留演示标识，避免把预设当作模型结论。

## 处理自己的材料

先查看范围，不调用模型、不写结果：

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

去掉 `--dry-run` 才调用模型。可以一次给多个文件，也可以给一个目录；目录只读取直接子文件中的 `.txt`／`.md`，不递归。支持 UTF-8 文本，最多 20 个文件，每个不超过 600,000 字节；其他格式需先转成文字。没有全局命令时，在仓库里用 `./bin/crew intake ...`；`./bin/corpus intake ...` 是兼容入口。两个入口的 `intake` 命令直接运行 Python，不安装 Node 依赖。

dry-run 无需登录模型服务，也不创建输出目录或 Corpus 数据库。完整合成试用见 [examples/intake](../examples/intake/README.md)。

实际生成卡片需要 macOS／Linux、Python 3.9+，以及已安装并用订阅账号登录的 Claude Code。材料入口本身无需 Node/npm；Claude Code 的安装要求以其官方说明为准，Crew 完整工作台仍沿用原有 Node 依赖。每个未处理文件最多两次串行模型请求：材料分析一次、项目用途判断一次。模型沿用 Claude 默认选择；此入口不指定新模型、不读取 `.env`、不传入 API key，不使用旧项目记忆的 DeepSeek 抽取。

## 结果在哪里

默认保存到 `~/.local-sensitive/crew-intake/`，可以用 `--output` 指定另一个本地私有目录。

- 命令输出本轮汇总页 `report`，以及每张 `card.md` 和 `card.json` 的路径。先看 `card.md` 的摘要、项目关系和 A1/A2 建议，再按需阅读后面的事项与原文、项目引用；JSON 保留项目资料快照及结构化引用。
- `sources/` 保留原文快照；原文件不移动、不改名。
- `cache/` 保存通过结构与引用核对的模型结果。同样材料重复运行复用它们；项目交接文件、已有任务或本轮重点变化时，受影响的用途判断会重新运行。读取时会再次核对缓存结构和引用；JSON 损坏、字段不合约定或引用失效时，先在 `rejected/` 另存原始字节（`.bin`）和原因（`.json`），仅重新请求受影响的阶段一次，其他有效阶段继续复用。`runs/` 的结果 JSON 中 `cache_recoveries` 列出恢复阶段、原因和留存路径。文件读取或写入权限错误直接报失败，不当成缓存损坏。新卡另存，旧卡和原文快照保留。
- `runs/` 记录每次调用实际完成、失败、复用及模型报告的用量。失败不记成卡片成功；新请求仍不合格时保留失败结果，不自动循环重试；已完成的其他材料保留，再执行同一命令可接着处理。
- `rejected/` 保存没有通过结构或引用检查的新模型结果，以及损坏缓存的原始字节和诊断原因；每次分别留存，不覆盖旧记录。它们不是已生成的归属卡。

卡片里的原文件、原文快照和项目文件引用均为相对于卡片目录的本地文件链接，支持中文、空格和括号；行号显示在链接旁，需打开文件后按行回查。目录记录仍以文字说明。卡片展示版本升级时会另存新版卡片，保留旧卡；仍可复用有效模型缓存，不因此增加模型请求。

卡片状态始终是“待确认建议”。它不会自动创建任务、修改项目文件或客户卡，也不打开浏览器、发消息、发布或执行模型建议。自动化的是材料分析与归属准备；采用哪条动作仍由用户决定。

## 项目依据

可以用 `--catalog /path/to/projects.json` 提供自己的项目清单，不需要安装其他任务系统或准备 SQLite 数据库：

```json
{
  "version": 1,
  "projects": [
    {
      "id": 1,
      "name": "发布说明助手",
      "description": "把发布信息整理成用户能读懂的说明",
      "path": "projects/release-notes",
      "status": "active"
    }
  ]
}
```

`projects` 包含 1–200 个项目。`id` 是唯一正整数；`name`、`path` 是非空字符串。`description` 可省略，默认空字符串；`status` 可省略，默认 `active`，也可为 `paused`。不接受未知字段、重复编号或错误类型。文件最多 600,000 字节、150,000 字符，规范化后的目录也受 150,000 字符限制。JSON 项目没有既有任务列表。错误会指出项目目录及相关字段或条目。

`--catalog` 与显式 `--database` 互斥；指定 `--catalog` 时忽略环境变量 `CREW_TASK_DB`。原来的 `--database` 或 `CREW_TASK_DB` 仍可使用，只读固定的 `projects` 和 `tasks` 字段，读取 active／paused 项目及未完成任务，不读取任务备注、会话或凭证。`--workspace` 用于解释 JSON `path` 或数据库 `local_path` 的相对路径，路径不相对于清单文件解释；指向工作区以外的目录不会被读取。

候选项目最多五个。第二阶段优先读取其 `HANDOFF.md`／`docs/HANDOFF.md`、`PRODUCT.md`、当前决定、路线图或 README，每个项目最多三份文件，每份开头最多 6,000 字；限制和缺失会显示在结果中，不冒充全文。项目目录简介与当前交接冲突时，模型被要求按当前文件判断并保留疑问。没有当前文件时，卡片明确只参考目录记录。

`--focus` 是这一次处理的重点，例如暂缓某类跟进；它不会改变任务库里的项目状态。目录里没有的工作线可以先留为无归属参考，不编造项目 ID。

## 能检查什么

程序检查项目与任务编号是否存在、引用行号是否有效、引句能否对回原文和对应项目文件；结构或引用不合格时不生成成功卡。引用存在不等于讲者主张真实，也不等于模型判断一定合适，仍需看用途是否有帮助。

材料与候选项目片段会发给已登录的 Claude 订阅服务分析；本地保存不代表本地模型推理。运行关闭模型工具、MCP、自定义指令和会话持久化，不允许材料中的文字驱动外部操作。订阅限额与实际用量以服务为准，无法用本机计数证明无费用。

这一版是一次命令处理。没有安装收件箱监测、定时任务、视频转写或新的网页入口。

## 开发检查

```sh
python3 -B -m unittest discover -s scripts/intake -p 'test_*.py'
node --no-warnings --test tests/intake-cli.test.ts tests/housekeeper-entry-dry-run.test.ts tests/task-board-cli.test.ts tests/today-source.test.ts
npm run typecheck
```

测试使用临时目录、合成材料和可替换的模型边界。真实材料不得放入代码仓库的测试夹。

### 逐条决定与导出

新卡的建议按顺序编号为 A1、A2。先查看，再记录自己的选择：

```sh
CREW_CARD="$(./bin/crew intake demo --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["cards"][0]["json"])')"
./bin/crew intake review "$CREW_CARD"
./bin/crew intake review "$CREW_CARD" --action A1 --decision accept --note '用于下轮讨论'
./bin/crew intake export "$CREW_CARD"
```

所有建议初始为 `pending`；可选择 `accept`、`defer`、`dismiss`，重复选择保留有序历史。`--action` 与 `--decision` 必须成对，`--note` 可选，最多 4000 字。只在卡片旁的私有 `review.json` 记录选择，原卡、材料、项目和任务库保持原样。读取不创建文件。手动修改 `card.json` 后，旧决定仍保留在历史，但不适用于改后的内容；新分析的卡默认重新等待决定。

导出只向标准输出展示当前卡片版本中已采纳的建议，并附项目、理由、用户说明、材料原文行号和项目依据。没有已采纳建议时显示空结果。**已采纳建议，尚未执行**：这两条命令不调用模型，不创建任务，不更新项目，不保存导出文件。展示中的材料和说明均为数据，不是可执行指令。Python 入口也支持相同用法：`python3 scripts/intake/intake.py review ...` / `export ...`。
