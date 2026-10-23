# 本地管家

本地管家把 Crew 的“今日安排”和“凭证与安全”放在一个本机入口里：先看已有任务中哪些可以推进，再按需查看凭证元数据、使用记录和项目扫描结果。今日页只整理安排，不自动执行任务，也不回写外部任务库；派活仍用任务看板或负责人模式。

## 怎么打开

需要 Node 22.18 或更新版本，并已在仓库安装依赖。当前打开浏览器和原生管家的入口面向 macOS。

```sh
crew housekeeper --dry-run       # 只打印解析后的配置、数据位置和启动计划
crew housekeeper                 # 启动本次 Crew 服务，打开今日页，默认端口 4198
crew housekeeper --port 4201     # 需要时换端口
```

没有安装全局命令时，在仓库目录把 `crew` 换成 `npm run crew --`。也可双击仓库里的 `scripts/housekeeper/打开本地管家.command`；它定位同一份正式代码，不安装组件、不导入其他副本的数据。

入口读取正式 Crew 数据目录（默认 `~/.working-corpus/`），先成功监听，再请求打开 `http://127.0.0.1:4198/#/today`。左侧“凭证与安全”进入全局安全页；选择项目后，从“项目凭证与安全”进入绑定目录的扫描页。端口被占用时会报错，不接管已有服务；用 `--port` 另选端口。关闭该终端或按 Ctrl-C 停止本次 Crew 服务。

`--dry-run` 会读取并校验配置文件和路径，只打印计划，不建数据库、不监听端口、不运行 helper 或扫描器，也不打开浏览器或原生 App。它不读取仓库或用户的 `.env`，不能代替实际启动和组件可用性检查。

## 配置

仅 `crew housekeeper` 及其双击入口读取 `<Crew 数据目录>/housekeeper.json`；环境变量覆盖同名 JSON 项。这个 JSON 可以省略，空对象 `{}` 也有效；本入口不从 `.env` 载入配置。双击启动时，配置文件通常比依赖终端环境变量更方便。

| 环境变量 | `housekeeper.json` 键名 | 用途与未配置时的行为 |
|---|---|---|
| `CREW_ASKKEY_HELPER` | `helperPath` | 原生 helper 可执行文件；未配置则原生录入与检测不可用 |
| `CREW_ASKKEY_LAUNCHER` | `launcherPath` | 原生管家启动程序，须为不带参数的可执行文件路径；已配 helper 但原生服务未就绪时才请求启动，未配置则只提示 |
| `CREW_SECURITY_SCANNER` | `scannerPath` | 只读扫描器 Python 脚本；未配置则项目扫描不可用 |
| `CREW_VAULT_DIR` | `vaultDir` | 只读钥匙库目录，读取其中的目录与使用记录元数据；本入口未配置就不读取钥匙库 |
| `CREW_TASK_DB` | `taskDatabase` | 外部任务 SQLite 库，只读打开；未配置时今日页只展示 Crew 本地任务 |
| `CREW_TASK_SNAPSHOT` | `taskSnapshotPath` | 外部任务的本地快照输出文件；必须与外部任务库成对配置，不能与来源库、Crew 库及其日志文件或管家配置文件重合 |

数据位置沿用 Crew 的 `CORPUS_HOME`（默认 `~/.working-corpus/`）和 `CORPUS_DB`（默认 `<Crew 数据目录>/corpus.db`）。这两项没有 JSON 键名，不能写入 `housekeeper.json`。

配置中的路径必须是非空绝对路径，不能含符号链接或控制字符；JSON 中不展开 `~`，也不接受未知键。配置文件须为普通 JSON 对象文件，不超过 64 KiB。只填写需要接入的组件；不会猜测仓外程序位置、自行安装或回退到其他代码目录。

例如将以下内容放进 `<Crew 数据目录>/housekeeper.json`，并将合成路径替换为自己准备好的组件和数据位置：

```json
{
  "helperPath": "/opt/example/bin/credential-helper",
  "launcherPath": "/opt/example/bin/open-credential-manager",
  "scannerPath": "/opt/example/scanner/scan.py",
  "vaultDir": "/opt/example/vault",
  "taskDatabase": "/opt/example/tasks/tasks.db",
  "taskSnapshotPath": "/opt/example/crew-snapshots/tasks.json"
}
```

也可只用环境变量选择数据目录并预览配置：

```sh
CORPUS_HOME=/opt/example/crew-data \
CREW_TASK_DB=/opt/example/tasks/tasks.db \
CREW_TASK_SNAPSHOT=/opt/example/crew-snapshots/tasks.json \
crew housekeeper --dry-run
```

普通 `crew app`／`crew serve` 不读取这个 JSON；它们的安全页使用环境变量，未设 `CREW_VAULT_DIR` 时仍按原规则查看 `~/.local-sensitive/housekeeper-vault` 的只读元数据。需要所有外部组件都显式配置时，用上述管家入口。

## 页面会显示什么

- **今日安排**：未配置外部来源时说明“尚未配置外部任务来源，仅展示 Crew 本地任务”；本地没有任务就显示空状态。配置后，打开页面或点击“搜索并更新安排”会只读查询外部库并保存本地快照；搜索框只筛选已保存的内容。读取来源失败时保留上次快照并提示更新时间。页面区分优先建议、受阻、先核对和其余可推进事项，不据此改任务状态。
- **凭证与安全**：未配置或无法读取钥匙库时显示未加载／不可用；未配置 helper 时禁用原生录入与检测。只读目录可独立展示元数据，不代表原生授权已经接通。配置 helper 后，录入和授权留在原生 App；网页不接收 Key。
- **项目凭证与安全**：未配置扫描器时显示项目扫描不可用；没有绑定目录时提示先绑定。扫描只针对所选项目的已绑定目录，显示文件位置、规则、优先级和扫描覆盖情况，不展示命中的秘密内容，也不修改项目文件。
- **静态演示站**：今日页说明没有加载个人任务；安全页说明需要本机服务。只展示公开合成示例，不调用本机任务库、钥匙库、helper 或扫描器。

## 安全边界与当前限制

- 本次服务只监听 `127.0.0.1`。今日页与安全页接口拒绝跨域请求，包括浏览器扩展来源；写操作还须带 `x-corpus: 1` 请求头。
- Crew 只读钥匙库的目录与使用记录元数据，不读取系统钥匙串中的秘密，不向钥匙库写入，也不提供网页复制或导出 Key 的入口。元数据可能包含名称、发起方、命令和目录，分享页面前仍应检查。
- 外部任务库只做固定查询，不读取备注、会话或凭据；刷新写入的是单独的本地快照。只对新建的快照目录设 `0700`，已有目录的权限不改；快照文件为 `0600`。读写共用 8,000,000 字节（UTF-8）上限，刷新超限时保留旧快照并提示缩小来源范围；读取时大小超限与权限问题分开说明。仍建议配置专用目录。
- 原生 helper、启动程序和扫描器由用户显式准备与配置。本入口不停止或替换已有原生服务；检测授权取用只检查变量是否存在，不验证 Key 有效性，也不代表服务已连接。
- 原生凭证管家和真实扫描器的真实交互尚未验收。当前原生录入与检测仅用于假 Key 隔离测试；自动化替身与静态页面检查不能替代这项验收。
