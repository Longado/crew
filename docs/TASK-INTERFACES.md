# Crew 任务接口：CLI 与 MCP

这批手写 20 项保留原编号，重复工作合并为 18 条任务。任务状态来自工作区 `.data/tasks.db`，来源编号、下一步和验收条件来自 `docs/任务清单-2026-10-01/清单.json`。App、Orca 内的看板、CLI 和本页 MCP 复用同一个 `BoardStore`，不另建待办库。

Crew 的项目、会话和团队运行库仍独立存在。任务在明确派发后才建立运行关联，负责人验收结果通过原有看板回写任务主库。这里的任务接口不导入或同步 Orca／Claude Code 的会话记录。

## CLI

在本仓库运行以下命令；`npm run crew --` 与 `./bin/crew` 是相同入口。

```sh
./bin/crew tasks list
./bin/crew tasks get --task 219
./bin/crew tasks status --task 231
./bin/crew tasks cancel --task 219 --expected-status blocked --note '用户决定终止，已有结果仅作沉淀，不继续实验。'
```

`cancel` 将任务标为 `cancelled`，保留记录。它要求单行明确原因和此前读到的状态，先备份再更新主库，并同步清单；正在执行的任务须先停止运行，已完成任务不能转为终止。重复终止同一任务不会重复追加记录。`manifest_synced=false` 或 `sync_warning` 表示主库与快照未全部同步，须查看返回结果。

查询与终止不依赖后台服务，也不调用模型。派发和停止运行复用原看板服务：

```sh
./bin/crew tasks dispatch --task 221 --goal '只读核对指定实验记录与旧任务验收条件，列出完成范围和缺口，不启动新计算。'
./bin/crew tasks stop --job '<本次返回的运行ID>'
```

派发默认只读；明确加入 `--write` 才申请原有隔离修改模式。任务是否可执行、同一时刻仅一个运行、清单核对仅只读等约束继续由原执行接口检查。`stop` 停止指定运行，不等于终止待办任务。

所有命令支持 `--workspace` 和 `--manifest` 指定工作区与清单；默认使用本工作区与上述清单。派发支持 `--board-url`，默认 `http://127.0.0.1:6480`，只接受本机 HTTP 服务，并核对服务的工作区和清单。服务未启动或端口访问被当前环境限制时会明确报错，不会自动启动模型或换数据源。

## MCP

独立 stdio 入口为 `crew tasks mcp`。保留旧 `crew mcp` 的项目／上下文工具；两者不是同一个工具集。

| 工具 | 用途 |
|---|---|
| `crew_tasks_list` | 读取本批任务及来源编号 |
| `crew_tasks_get` | 按真实 task ID 读取一项 |
| `crew_tasks_cancel` | 根据明确终止决定、原因与预期状态终止任务 |
| `crew_tasks_status` | 读取任务与关联持久运行回执 |
| `crew_tasks_dispatch` | 按具体目标派发，默认只读 |
| `crew_tasks_stop` | 停止指定运行 |

Claude Code 的配置示例如下；按使用的客户端添加此 server。此示例不会自动修改全局配置。

```json
{
  "mcpServers": {
    "crew-tasks": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--no-warnings",
        "/Users/eddie/Desktop/Workspace/01_项目/working-corpus/src/cli.ts",
        "tasks", "mcp",
        "--workspace", "/Users/eddie/Desktop/Workspace",
        "--manifest", "/Users/eddie/Desktop/Workspace/docs/任务清单-2026-10-01/清单.json"
      ]
    }
  }
}
```

Codex 的相应配置为：

```toml
[mcp_servers.crew-tasks]
command = "/opt/homebrew/bin/node"
args = ["--no-warnings", "/Users/eddie/Desktop/Workspace/01_项目/working-corpus/src/cli.ts", "tasks", "mcp", "--workspace", "/Users/eddie/Desktop/Workspace", "--manifest", "/Users/eddie/Desktop/Workspace/docs/任务清单-2026-10-01/清单.json"]
```

新工具集需在客户端配置加载后才能调用。MCP 的 stdout 仅输出协议消息；具体结果以工具返回的主库状态和回执为准。

## 本轮验证

2026-10-01 的25项任务／旧MCP相关Node检查、21项Python存储与HTTP边界检查、类型检查通过。真实stdio已发现六工具并回读18项任务；#219和#220通过新CLI终止，MCP确认两项均为`cancelled`且不可派发，主库和清单一致。原#231的完成及2/2验收回执仍保留，没有新增模型运行。

另有3项既有App／服务启动测试被当前环境的`listen EPERM`阻断；未将它们记为通过，派发与停止的服务调用本轮只验证了请求边界。Computer Use未批准访问Orca，终止后的实际界面显示未复查。用户全局MCP配置未修改，配置示例尚需在客户端加载。[本轮回执](../../../docs/任务清单-2026-10-01/任务接口验收-2026-10-01.json)记录实际结果和源文件哈希。
