# Channel 接入口验证

这些脚本验证消息入口和两 Agent 自动往返，是正式 Bridge 的验证材料。消息表仅在内存中，退出后不恢复，不用于实际项目派单。测试运行目录在系统临时目录，配置含本地随机令牌，不要提交这些运行目录。

安装测试脚本自身的依赖，不改变 Working Corpus 主应用依赖：

```bash
npm ci --prefix scripts/probes/channel --ignore-scripts
npm test --prefix scripts/probes/channel
```

## Claude：推送到真实交互会话并获得工具回复

在可交互的终端启动：

```bash
node scripts/probes/channel/claude.mjs
```

若环境中的 ANTHROPIC_API_KEY 覆盖了现有订阅登录，可选择仅对测试子进程使用已登录账号：

```bash
node scripts/probes/channel/claude.mjs --use-login
```

这会创建专用测试目录并启动新的 Claude 会话。确认自己创建的测试目录和本地开发 Channel；等 Claude 显示 READY，再在另一个终端执行启动脚本打印的 `node .../send.mjs ...` 命令。

只有看到 `PASS` 且 message_id 匹配才表示往返成功。HTTP 202 只表示写入通道。脚本不接管已有会话，也不更改 API Key、登录方式或全局 MCP 配置。

退出测试 Claude 可在空提示处连续按两次 Ctrl-D。若要验证恢复，记下 CLI 显示的会话编号，按原启动参数加 `--resume` 重新启动并核对之前的消息。

## Codex：向明确会话 queue 一条消息

```bash
node scripts/probes/channel/codex.mjs
```

脚本启动独立本地 App Server，在其上创建测试 thread，先调用一次模型，再通过 `codex queue --remote ... --thread ...` 发送第二条消息；以同一 thread 的模型输出确认收到。脚本结束关闭自己启动的服务器，不停止用户现有 daemon。会消耗两次短模型调用，使用当前默认模型和现有登录。

这证明专用 App Server thread 的队列入口，尚不能证明任意旧终端都已支持接管。

## 当前实测边界

2026-09-29：交互模式的 Claude Channel 和 Codex queue 均实际收到并回复。Claude `-p` 的两个测试只完成 MCP 连接与 notification 写入，没有获得 Channel 回复；暂不采用该启动模式。

完整记录见 [接入验证报告](../../../docs/agent-team-runtime-capabilities.md)。新增自动往返脚本见下节；多会话绑定、持久化与画布尚未交付。

## Codex → Claude → 原 Codex：订阅模式自动往返

```bash
node scripts/probes/channel/bridge.mjs
```

在交互终端运行。脚本检查 Claude 的 claude.ai 付费订阅和 Codex 的 ChatGPT 付费登录，只对自己创建的子进程排除 API Key 与第三方路由变量，检查不通过就终止。它不修改账号、密钥或全局 MCP 配置；仍消耗各自订阅额度。

首次启动需要确认自己创建的临时目录与本地开发 Channel。当前 Claude 2.1.284 的首条提示可能早于 MCP 工具可用；若它说找不到工具，在同一终端输入 `Call corpus_bridge ready now.`。就绪之后，提问、Channel 推送、工具回复及回送原 Codex thread 均由脚本自动完成，不需要复制消息。

脚本仅给 Claude 一个随机测试标记，Codex 必须通过 Bridge 询问并从回复中得到它。输出 `ROUNDTRIP_PASS` 才算真实闭环成功；只看到连接或 HTTP 202 不算。成功回执在打印的临时目录中，未包含账号邮箱或令牌。`bridge-core.mjs` 保存进程内消息；`relay.mjs` 提供 MCP 工具与 Claude Channel；`subscription.mjs` 做登录检查。

Codex 只在专用 thread 中预先放行 Bridge 的三个工具。Claude 使用专用配置并尝试启动时加载工具；首轮加载仍有上述已知限制，不宣称全无人值守启动。没有验证任意旧 terminal 的接管、重启恢复、并发多团队或业务任务执行。
