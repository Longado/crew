# MCP 连接器

让 Claude Code、Codex、Cursor 这类支持 MCP 的工具直接读 Working Corpus 里的项目现场和续接上下文，不用再开网页复制粘贴。

连接器只读：不调用大模型，不改数据库。整理对话还是在网页上点"同步"，或者命令行 `sync`。

## 三个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_projects` | 无 | 全部项目的名称、编号、绑定目录 |
| `project_status` | `project`（可选） | 目标、当前规划、每个任务的状态和依据、已取消不要做的事、下一步、待确认条数 |
| `continue_context` | `task`（必填），`project`（可选） | 这个任务的续接上下文，和网页上"继续"复制出来的是同一段 |

- `project` 可以写项目名或编号。不写时按 AI 工具的当前目录找：先看所在 git 仓库的根目录，再看当前目录本身，绑定到哪个项目就用哪个。
- `task` 可以写 `T03` 这样的短编号、完整编号或任务名。名字先找完全一样的，找不到再找包含它的；匹配到多个会列出候选，让 AI 用编号再问一次。
- 找不到项目或任务时，返回的说明里会列出现有的项目或任务。
- 任务状态的规则和网页一致：AI 说做完了只算待验证，你确认了才算完成。

## 注册

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
