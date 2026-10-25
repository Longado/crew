# MCP 连接器

让 Claude Code、Codex、Cursor 这类支持 MCP 的工具直接读 Working Corpus 里的项目现场和续接上下文，也能自己报告开工、交活、受阻和新建议。

连接器不调用大模型。三个读工具查看现场，四个写工具只记录 Agent 自报：AI 说做完只算待验证，用户确认后才算完成；AI 新规划只算建议，用户采纳后才进入当前规划。连接器没有“确认完成”或“采纳”工具。整理其他对话仍在网页上点“同步”，或者命令行 `sync`。

## 三个读工具、四个写工具

| 工具 | 读／写 | 参数 | 返回或记录 |
|---|---|---|---|
| `list_projects` | 读 | 无 | 全部项目的名称、编号、绑定目录 |
| `project_status` | 读 | `project`（可选） | 目标、当前规划、任务状态和依据、已取消不要做的事、下一步、待确认条数 |
| `continue_context` | 读 | `task`（必填），`project`（可选） | 任务续接上下文，和网页上“继续”复制出来的是同一段 |
| `check_in` | 写 | `task`（必填），`note`、`project`（可选） | 记录开工，按现有规则进入进行中；`note` 可说明先做什么 |
| `hand_in` | 写 | `task`、`summary`（必填），`project`（可选） | 记录 AI 自述完成，进入待验证；`summary` 写做了什么、用户怎么验收 |
| `raise_hand` | 写 | `task`、`need`（必填），`project`（可选） | 记录受阻，在网页“等你”中显示；`need` 写缺什么、需要用户做什么 |
| `propose_task` | 写 | `name`、`why`（必填），`project`（可选） | 记录 AI 建议，进入待确认；用户采纳前不加入当前规划 |

- `project` 可以写项目名或编号。不写时按 AI 工具的当前目录找：先看所在 git 仓库的根目录，再看当前目录本身，绑定到哪个项目就用哪个。
- `task` 可以写 `T03` 这样的短编号、完整编号或任务名。名字先找完全一样的，找不到再找包含它的；匹配到多个会列出候选，让 AI 用编号再问一次。
- 找不到项目或任务时，返回的说明里会列出现有的项目或任务。
- 任务状态的规则和网页一致：AI 说做完了只算待验证，你确认了才算完成。
- 写工具仍遵守人工修正、已取消任务等现有规则，不会绕过它们强改状态。额外的状态、发言者或确认参数会报错。

## Agent 建议调用顺序

开工前调用 `project_status` 看清当前范围，接手具体任务时可再读 `continue_context`；随后调用 `check_in`，写明这轮先做什么。完成本轮工作后调用 `hand_in`，说明改动及用户验收方法；无法继续时调用 `raise_hand`，明确所缺输入和需要用户采取的行动。发现范围之外值得做的工作，用 `propose_task` 提建议，等待用户采纳。

建议顺序：`project_status` → `check_in` → 干活 → `hand_in` 或 `raise_hand`。不要把 `hand_in` 的回执当成用户验收。

## 注册

已经装好 `crew` 命令时，最短的写法：

```
claude mcp add crew --scope user -- crew mcp
```

Codex 在 `~/.codex/config.toml` 里写 `[mcp_servers.crew]`、`command = "crew"`、`args = ["mcp"]`。网页项目现场右上角的「让 Agent 自己报到」里有同样的两段。接上以后，Agent 的开工、交活、举手会在网页办公室里实时出现（页面每 5 秒比一次变化）。

没装 `crew` 命令时，用下面按仓库路径启动的写法。

下面的 `<仓库>` 是占位写法，使用时换成本仓库的绝对路径。

数据库默认用 `~/.working-corpus/corpus.db`，和从哪个目录启动无关。想用别的数据库，设环境变量 `CORPUS_DB`。

### Claude Code

```
claude mcp add corpus -- node --no-warnings --env-file-if-exists=<仓库>/.env <仓库>/src/cli.ts mcp
```

默认只在当前项目里生效；想所有项目都能用，加 `--scope user`。

本机实测过（Claude Code 2.1.269）：用同样的启动命令，从一个绑定了项目的目录里运行，不传 `project` 就认出了项目，两个工具的返回和预期一致。实测用的是一次性的 `--mcp-config`，没有真的执行 `claude mcp add`。

### Codex

在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.corpus]
command = "node"
args = ["--no-warnings", "--env-file-if-exists=<仓库>/.env", "<仓库>/src/cli.ts", "mcp"]
```

本机实测过（codex-cli 0.154.0）：用 `codex exec -c` 在命令行传入同样这几个键，从绑定目录里调用 `project_status`，认出了项目，返回正常。没有改过 `config.toml` 文件本身。

### Cursor

在项目的 `.cursor/mcp.json` 或全局的 `~/.cursor/mcp.json` 里加：

```json
{
  "mcpServers": {
    "corpus": {
      "command": "node",
      "args": ["--no-warnings", "--env-file-if-exists=<仓库>/.env", "<仓库>/src/cli.ts", "mcp"]
    }
  }
}
```

未在本机实测。Cursor 启动连接器时的当前目录不一定是你的项目目录，按目录认不出项目时，让它调用时写上 `project`。

## 自己试一下

不接任何 AI 工具，直接在终端里喂一行请求：

```
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}' \
  | node --no-warnings src/cli.ts mcp
```

## 实现说明

- 代码在 `src/mcp.ts`，没有新依赖：手写 JSON-RPC 2.0，stdin 一行读一条请求，stdout 一行写一条响应。
- stdout 只写协议消息，出错信息写到 stderr。
- 支持 `initialize`、`ping`、`tools/list`、`tools/call`；通知不回复；不认识的方法返回 -32601，读不懂的行返回 -32700。
- 找不到项目、任务，参数不对，这些按工具结果返回（`isError: true`），让 AI 能看到说明自己改正，不当成协议错误。
- 每个项目、每种调用方复用一个来源为 `mcp`、标题为“自报进度”的会话。调用方取自 `initialize.clientInfo.name`：含 claude、codex、cursor 时分别显示 Claude Code、Codex、Cursor（不区分大小写），其余原样，缺省显示 MCP。
- 每次自报写入一条带当前时间的 assistant 消息，再通过现有 `storeEvidence()` 写入引用它的证据；消息、证据、整理游标在同一事务内写入。“同步”不会重复抽取这些消息，“重新整理”也保留 MCP 会话的证据和游标。
- `GET /api/projects/:id/stamp` 返回 `{ "stamp": "…" }`，由该项目证据条数、修正条数、最新证据时间拼成。网页可定期比较，变化后再拉完整项目；此接口不构建项目视图、不记录打开项目次数。
