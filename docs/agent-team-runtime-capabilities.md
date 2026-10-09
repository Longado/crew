# Channel 与 Codex 自动桥接：逐步验证

日期：2026-09-29。交付状态：**基础入口与两会话自动往返已通过真实模型测试；目前是内存型验证 Bridge。**

用户要求改为直接推进、逐步验收；此次只验证专用会话，没有向原有工作会话发消息。

## 实际结果

| 项目 | 结果 | 依据及限制 |
|---|---|---|
| Claude 模型调用 | 通过 | 使用本机已有订阅登录，返回指定标记 |
| Claude 自定义 Channel | 通过，交互终端模式 | MCP 注册为 Channel；推送 message_id 后，Claude 实际调用 reply 返回同一编号及 `CORPUS_INTERACTIVE_CHANNEL_OK` |
| Claude 上下文恢复 | 通过 | 退出专用会话后按其编号恢复，模型正确返回此前通过 reply 发出的标记 |
| Codex queue | 通过，专用 App Server thread | 首轮返回 `CORPUS_CODEX_INITIAL_OK`；通过 queue 向同一 thread 发送另一条消息，模型返回 `CORPUS_CODEX_QUEUE_OK.` |
| 本地协议检查 | 通过 | 真实 stdio MCP＋HTTP 检查涵盖错误凭证、无效输入、消息推送、重复消息拒绝、未知回复拒绝与 transport／reply 区分 |
| Claude 非交互模式 | 本轮未通过 | 两次 `-p` 测试的 MCP 连接及通知写入成功，但未观察到 reply；交互模式日志出现 Channel notifications registered，非交互测试中未见相同记录。原因未完全确定，不宣称所有非交互模式均不支持 |

版本：Codex CLI 0.157.1、Claude Code 2.1.284、Node 25.8.2、MCP SDK 1.31.0。默认模型由各工具现有配置选择，本轮没有人为更换。

初次 Claude 调用受到环境里的 ANTHROPIC_API_KEY 覆盖，返回 Credit balance is too low。仅在专用测试子进程移除该变量后，已有订阅登录可用；未改写密钥、登录账号或全局 MCP 配置。Claude 首次进入新测试目录及加载自建开发 Channel 的本地信任提示已在测试终端确认。

## 可以复现的产物

- [验证脚本与使用说明](../scripts/probes/channel/README.md)：Claude 交互启动器、推送与回执检查、Codex queue 验证、协议回归检查。
- [脱敏的实测回执](verification/channel-entry-2026-09-29.json)：只包含合成消息、版本和结果，不含个人会话、凭证或账号信息。
- [执行任务清单](superpowers/plans/2026-09-29-channel-bridge-tasks.md)：已更新 T0 的已完成和剩余项。

当前检查命令：

```bash
npm test --prefix scripts/probes/channel
```

当前结果：5 个协议与订阅检查测试通过，0 失败。该测试不调用模型；上表真实模型结果是另行执行的测试，不混为同一验证层。

## 第二步：订阅模式自动往返已通过

真实测试：Codex 通过 MCP send_message 主动询问 → 本地 Bridge → Claude Channel 通知 → Claude reply_message → Bridge 自动调用 codex queue → 原 Codex thread 输出正确标记。随机标记仅在 Claude 的初始提示中提供，Codex 的初始提示没有答案；回执以同一 thread 的实际模型输出验收。期间没有手动复制两 Agent 的消息。

本机认证：Claude 为 claude.ai / Max；Codex 为 ChatGPT / Pro。脚本在调用模型前核对认证类型，子进程排除 API Key、第三方模型入口相关环境变量，不做 API 付费降级。这个结果证明本轮使用订阅登录；仍受各订阅额度与用户自己的额外用量设置约束。

- [实际往返回执](verification/auto-bridge-2026-09-29.json)
- [运行方式](../scripts/probes/channel/README.md#codex--claude--原-codex订阅模式自动往返)
- `bridge.mjs`：专用会话与测试驱动；`bridge-core.mjs`：身份绑定、路由、去重及回复关联；`relay.mjs`：MCP 工具与 Channel；`subscription.mjs`：认证检查。

五项自动测试覆盖子进程凭证隔离、认证方式拒绝、鉴权与发送者绑定、重复请求与回复去重、错误回复拒绝、投递失败状态，以及真实 stdio MCP → HTTP → Channel 通知 → 回复链路。协议测试不调用真实模型，上述模型往返另行运行。

### 本次遇到并记录的问题

1. Claude 的开发 Channel 参数会吞掉紧邻的初始提示；用 `--` 分隔修复。
2. Codex 在 `approvalPolicy: never` 下默认拒绝写入型 MCP 工具。只在专用 thread 预先放行本地 Bridge 的三个工具，未改变全局权限。
3. Claude 首轮提示未获得 Bridge 工具，即使声明 `alwaysLoad` 并尝试关闭工具延迟加载，本机这版仍需后续输入一次 `Call corpus_bridge ready now.`。最终成功测试保留了这一步人工启动；消息往返之后全自动。没有把它描述为无人值守启动。具体首轮行为仍需定位。

配置依据：[Claude MCP 工具加载](https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral)、[Codex MCP 工具权限](https://learn.chatgpt.com/docs/config-file/config-reference)。本机实测结果优先于对文档的推断。

## 下一项及边界

下一步先解决会话接入体验：让用户从统一入口启动两个可见终端，明确绑定会话编号，并等待工具就绪后再发首条任务。验收是新启动时不需要补发 ready，能连续往返三次且不串会话。

随后加入消息持久化和重启恢复，再接最小团队视图：两个 Agent 工牌、一条连接、实时消息记录。原有只读 Corpus MCP 保持独立。

仍需验收：用户已有交互终端接入、Codex 忙碌时排队、多会话并发不串线、跨进程恢复、真实业务派单及画布。当前消息仅在内存中，传输写入不代表模型收到，投递结果不明时不会盲目重发；不用于生产任务，也不代表整个产品完成。
