# Working Corpus Channel + Bridge 任务规划 Implementation Plan

> 后续执行入口已更新为 [团队工作台执行计划](../../2026-09-29-team-workbench-plan.md)。本文件保留原设计与技术任务作参考；当前实测状态以新计划和接入报告为准。

> 执行约定：按用户要求直接推进，每一步给出实际产物和验收结果；由实现需要决定检查方式，不强制套用 executing-plans 或 TDD Skill。

**Goal:** 用户在两个终端中分别与 Codex、Claude Code 对话时，可以让双方定向发送协作消息、提问和回传成果；随后扩展到多个会话，并在 Working Corpus 中看到真实连接与交接状态。

**Architecture:** 本地 Bridge 统一保存会话绑定、消息和投递记录；Claude Channel 作为 Claude Code 启动的 stdio MCP 子进程连接 Bridge，提供入站推送与回复工具；Codex 通过受限 MCP 工具发件，通过已验证的 queue／App Server 接收。Hooks 补充生命周期观测，不承担消息路由或推理循环。

**Tech Stack:** 沿用 Node.js 22.18+、TypeScript、node:sqlite、zod、原生网页和 node:test。Channel 拟采用官方 MCP SDK；具体兼容版本在 T0 验证后锁入 package-lock.json，不同时升级现有依赖。

---

日期：2026-09-29。状态：T0 基础消息入口已通过实测；Codex 忙碌／恢复等剩余场景未验收，T1–T8 未开始。详见[接入验证报告](../../agent-team-runtime-capabilities.md)。

本文件将[完整产品体验计划](2026-09-29-agent-team-experience.md)中的通信基础拆为可排期任务。它是任务级规划，不是已验证实现或完整源码。团队环境配置、复杂任务依赖、成果整合及完整画布体验仍按总计划交付；本文件的通信闭环完成不代表整个产品完成。

## 1. 本轮交付的具体体验

1. 用户将 terminal A 的 Codex 与 terminal B 的 Claude Code 接入同一个团队，保留各自的独立对话。
2. 用户告诉 Codex：“问一下 Claude Code，这个接口是否方便做页面。”
3. Codex 使用桥接工具发送消息；Claude 在自己的会话中收到、分析并回复。
4. 回复送回原 Codex 会话，Codex 据此继续工作；全过程不需要用户搬运消息。
5. Claude 也可以主动向 Codex 发问。加入第三个会话后仍能准确指定收件人。
6. 页面显示消息去了哪里、是否得到处理回执、是否已回复；异常时可以定位原因。

允许在首次启用 Channel 时显式重启并恢复原会话。不能用一个没有原上下文的新后台 Agent 冒充原终端；更不能把写入数据库或发出 notification 等同于对方已处理。

## 2. 开发顺序与里程碑

```text
T0 接入口验证 → T1 身份与协议 → T2 本地 Bridge
                                  ↓
                         T3 Claude Channel
                                  ↓
                         T4 Codex 适配器
                                  ↓
                         T5 双向与多会话闭环
                                  ↓
                         T6 Hooks 与中断恢复
                                  ↓
                         T7 连接与交接界面
                                  ↓
                         T8 回归、真实验收与说明
```

| 里程碑 | 用户能看到什么 | 完成条件 |
|---|---|---|
| M1：接入可行 | 两端能力和启用方式清楚 | T0 的实际测试有结果，支持范围没有靠推测填写 |
| M2：双向通信 | A 发给 B，B 回复到 A，也可反向发起 | T1–T5 通过；第三会话不串线 |
| M3：可观察、可恢复 | 知道哪里卡住，重启后不重复乱发 | T6–T8 通过，原有只读功能回归通过 |

按步骤推进和交付，不设本轮工期预估。每次报告实际完成、验证结果和下一项；接口限制以真实测试结果为准。

## 3. 固定的模块职责

| 文件 | 职责与变更类型 |
|---|---|
| `src/bridge/contracts.ts` | 新增：会话绑定、消息、投递尝试、接口校验 |
| `src/schema.sql`、`src/db.ts` | 修改：桥接表、迁移、持久化方法；遵循当前 SQL 集中在 db.ts 的约定 |
| `src/bridge/router.ts` | 新增：授权范围、目标选择、排队、投递状态及回执关联 |
| `src/bridge/http.ts` | 新增：本地 Bridge 的认证、接口和 Channel 收件通道 |
| `src/bridge/client.ts` | 新增：连接器调用 Bridge 的客户端，共用消息校验 |
| `src/bridge/channel.ts` | 新增：Claude Channel、notification、工具注册及回复 |
| `src/bridge/codex.ts` | 新增：向指定 Codex 会话投递，不从输出标题猜身份 |
| `src/bridge/control.ts` | 新增：给 Codex 等工具使用的独立发件 MCP 入口 |
| `src/bridge/hooks.ts` | 新增：已验证的生命周期事件接收与关联 |
| `src/cli.ts`、`src/server.ts` | 修改：独立连接器入口、本地路由与页面查询接入 |
| `web/bridge.js`、`web/bridge.css` | 新增：连接列表、协作关系和交接详情 |
| `web/app.js` | 修改：加入连接页面入口；不重写既有项目现场 |
| `package.json`、`package-lock.json` | 仅在 T0 确认 SDK 方案后添加必要依赖 |
| `docs/CHANNEL-BRIDGE.md` | 新增：接入、启用、恢复与使用说明 |

保持 `src/mcp.ts` 原有三个工具的只读行为。开发阶段使用隔离的配置和样本数据库；不因运行连接测试而改全局配置、重启用户正在工作的会话或向其发消息。

## 4. 接口约定

**成员绑定**包含项目、团队、memberId、provider、nativeSessionId、bindingVersion 和能力集合。连接凭证与具体绑定关联，模型不能在参数中伪造发件人。终端名称可展示，不用于唯一寻址。

**消息**包含 messageId、发件和收件绑定、kind、body、inReplyTo、可选 taskId、创建时间和有效期。kind 使用 question、task_request、reply、notice；回复的收件人由原消息确定。

**投递尝试**单独记录 attemptId、绑定版本、开始时间和结果。状态区分 queued、transport_written、agent_seen、replied、failed、delivery_unknown、cancelled。`agent_seen` 由接收工具调用证明；允许有效回复直接证明对方已处理，不要求网络事件按理想顺序到达。

**拟定 Agent 工具**：`list_members`、`send_message`、`ack_message`、`reply_message`、`get_message_status`。收件人可选择，发件身份来自连接；回复不能任意改投其他会话。ack 是技术回执，不再推给另一侧模型生成回复。

**传输建议**：连接器主动订阅 Bridge 的本地收件 SSE，发件和回执用 HTTP POST；Bridge 是唯一持久化位置。每个 Claude 会话有自己的 stdio Channel 子进程，避免多会话争用一个固定 HTTP 监听端口。SSE 重连恢复投递记录；对已写出但未确认的消息不盲目重放。

所有消息接口仅监听本机，校验连接身份和所属项目。初版不加入远程服务器、自动授权工具调用或向公网暴露端口。

## 5. 任务清单

### T0：核实两端接入口

责任：接入验证。依赖：无。产出：`docs/agent-team-runtime-capabilities.md`；隔离验证材料放 `tests/fixtures/bridge/`，仅保存无个人信息的协议样本。

- [x] 记录本机 Codex／Claude 版本及原生消息入口；复核官方 Channel 通知与回复约定。
- [x] 在专用 Claude 交互测试会话验证自定义 Channel 能启用、接收消息并调用回复工具；API Key 覆盖及非交互模式差异已记录。
- [x] 在专用 Codex App Server 会话验证按 UUID 空闲投递，并观察同一 thread 的模型回复。
- [ ] 检查 Codex 正在工作时的投递表现；验证连接用户既有交互终端的路径。
- [x] Claude 测试会话退出后按指定编号恢复，正确回忆之前的 Channel 回复标记。
- [ ] Codex 跨进程恢复后继续投递的验证。
- [x] 首轮使用 queue 向明确 App Server thread 投递；该路径已跑通。既有 terminal 连接能力继续核对，不同时建设第二套控制实现。

验收：记录请求、目标身份、目标实际收到内容及回复。帮助输出只证明有命令；模型自述收到了不代替匹配 messageId 的回传。某端不可用时说明具体失败和替代方案，停止依赖该能力的实现，不默默降为手工查收。

### T1：固定身份与消息契约

责任：核心协议。依赖：T0。文件：`src/bridge/contracts.ts`、`tests/bridge-contracts.test.ts`。

- [ ] 按第 4 节定义 zod 校验和 TypeScript 类型，固定状态、消息类型和绑定版本。
- [ ] 为缺少收件人、未知消息类型、跨项目目标、过期绑定、回复缺少原消息写输入样例与预期错误。
- [ ] 明确 send 的响应只返回已入队，不返回已收到或已完成。
- [ ] 固定原生协议可能标为 user 的消息来源记录，来源始终保留“协作 Agent”，不升级为人类授权。

验证命令：`node --no-warnings --test tests/bridge-contracts.test.ts`。预期：合法消息通过，上述非法输入均被拒绝；名称相同的两个会话依然按身份区分。

### T2：消息存储与本地 Bridge

责任：本地路由。依赖：T1。文件：`src/schema.sql`、`src/db.ts`、`src/bridge/router.ts`、`src/bridge/http.ts`、`src/bridge/client.ts`、`src/server.ts`；测试：`tests/bridge-store.test.ts`、`tests/bridge-http.test.ts`。

- [ ] 增加绑定、消息和投递尝试表；可在旧数据库上增量创建，不改旧表的任务完成含义。
- [ ] 在 db.ts 提供事务内入队、查询、关联回复和状态更新；重复 messageId＋同内容返回原记录，不同内容返回冲突。
- [ ] 实现已认证连接的成员查询、发件、回执、回复、状态查询及收件订阅。
- [ ] 发件人从连接读取；消息由服务端路由到指定收件绑定；回复目标从原消息查出。
- [ ] 错误输入返回明确错误；未知会话、断开的连接和过期绑定不执行静默替换。

验证命令：`node --no-warnings --test tests/bridge-store.test.ts tests/bridge-http.test.ts`。用临时 SQLite 验证重启后记录存在、身份隔离、重复入队不新增、未认证请求被拒绝。

### T3：自定义 Claude Channel

责任：Claude 接入。依赖：T2。文件：`src/bridge/channel.ts`、`src/cli.ts`、必要的 package 文件；测试：`tests/bridge-channel.test.ts`。

- [ ] 使用已验证的 MCP SDK 声明 `experimental['claude/channel']` 和工具能力，stdout 仅写协议，日志写 stderr。
- [ ] Channel 启动后以专属绑定连接 Bridge，订阅收件消息并发送 `notifications/claude/channel`。
- [ ] 提供第 4 节五个工具并定义说明，要求使用原 messageId 确认或回复；工具处理通过 Bridge 完成，不直接调用 Codex。
- [ ] 通知写出只报告 transport_written；断连或写入结果不确定时报告实际情况。
- [ ] 提供独立启动入口 `corpus channel`（拟定），用隔离 MCP 配置运行，不自动向用户插件清单注册。

验证命令：`node --no-warnings --test tests/bridge-channel.test.ts`。模拟 MCP 客户端验证能力声明、通知 payload、回复工具、未知消息被拒绝，以及通知成功不会自动变成 agent_seen；再用 T0 测试会话收发一条。

### T4：Codex 发件与收件适配器

责任：Codex 接入。依赖：T2；真实往返依赖 T3。文件：`src/bridge/control.ts`、`src/bridge/codex.ts`、`src/cli.ts`；测试：`tests/bridge-control.test.ts`、`tests/bridge-codex.test.ts`。

- [ ] 新增独立 `corpus bridge-mcp` 入口（拟定），暴露与 Channel 一致的五个工具；原 corpus mcp 不增加写能力。
- [ ] 使用 T0 验证的入口向明确 UUID 投递；调用程序时使用参数数组，不把消息拼进 shell 命令。
- [ ] 将 messageId、来源、消息类型和任务边界随正文送入 Codex，要求用桥接工具确认或回复。
- [ ] 原生命令成功只视作相应投递回执；命令报错、超时及无法判定是否送达分别记录。
- [ ] 在现有 Codex 会话不能加载连接器时，说明恢复步骤并验证指定会话连续性。

验证命令：`node --no-warnings --test tests/bridge-control.test.ts tests/bridge-codex.test.ts`。使用假进程执行器检查精确 UUID、特殊字符按原文传递、无 shell 解释、错误与超时状态正确；真实测试单独记录。

### T5：双向、多会话和协作消息闭环

责任：联调。依赖：T3、T4。文件：`tests/bridge-integration.test.ts`、`docs/agent-team-runtime-capabilities.md`。

- [ ] A（Codex）提问，B（Claude）答复，A 实际收到并继续；用唯一 messageId 串起记录。
- [ ] B 主动提问，A 回答；证明通信不依赖固定主从方向。
- [ ] 加入 C（另一 Codex），同目录同显示名也不串线；B 回复 A 时 C 不接收。
- [ ] 验证 B 忙碌时的实际排队行为，界面状态不伪装成马上处理。
- [ ] 将回复、通知和新任务区分处理；ack 不触发模型回复，普通回复不自动发起无限对话。
- [ ] 对一次请求设置有效期和往返上限；超限显示需要处理，用户可明确开启新请求。

验证命令：`node --no-warnings --test tests/bridge-integration.test.ts`。自动测试用模拟适配器验证路由；真实验收另做 A→B→A、B→A→B 及 A/B/C 定向通信，不能以模拟结果替代。

### T6：Hooks、断连恢复与取消

责任：运行可靠性。依赖：T5。文件：`src/bridge/hooks.ts`、`src/bridge/router.ts`、`src/bridge/channel.ts`、`src/db.ts`；测试：`tests/bridge-recovery.test.ts`；只在原事件已验证时修改 `plugin/hooks.json`。

- [ ] 接入已验证的会话生命周期事件，保留现有 SessionEnd 只读同步；没有稳定 hook 的工具使用适配器观测，不虚构事件。
- [ ] Bridge 重启时恢复未发送消息；已写出但未确认的消息标为 delivery_unknown，核对后再决定是否重发。
- [ ] 验证重复事件、延迟回复、断开再连接；换绑后旧版本不能领取新的消息，迟到结果保留在原尝试。
- [ ] 取消阻止后续派发，不宣称已停止目标正在执行的工具；停止能力另按适配器实际确认。
- [ ] 单个 Channel 退出只影响绑定会话；其他成员继续工作。

验证命令：`node --no-warnings --test tests/bridge-recovery.test.ts`。覆盖通知前崩溃、通知后落回执前崩溃、回复先于 ack、重复 reply、取消后迟到结果等具体时间点。

### T7：连接与交接界面

责任：用户操作。依赖：T5；异常状态依赖 T6。文件：`web/bridge.js`、`web/bridge.css`、`web/app.js`、`src/server.ts`；测试：`tests/bridge-view.test.ts`。

- [ ] 连接列表展示成员、工具、会话、可用操作及最后观测时间；用户选择明确会话后绑定。
- [ ] 提供关系视图和列表视图：选择成员看收发，选择连线看交接详情。
- [ ] 展示 queued、transport_written、agent_seen、replied 与异常对应的中文状态；显示推理中的状态必须有真实观测。
- [ ] 提供断连处理、取消待发消息、查看原会话入口；恢复／停止按钮按能力展示。
- [ ] 桌面和窄窗口实际操作检查，避免仅靠颜色或拖拽表达状态与操作。

验证命令：`node --no-warnings --test tests/bridge-view.test.ts` 检查接口与显示状态映射；随后浏览器实际操作 1440 与 1024 像素窗口。完整无限画布和团队模板仍属于总计划，不在这里另做通用白板。

### T8：回归、真实验收和接入说明

责任：交付验证。依赖：T6、T7。文件：`docs/CHANNEL-BRIDGE.md`、`docs/HANDOFF.md`、必要时 `.claude-plugin/plugin.json`；涉及插件清单时同步相关测试。

- [ ] 写明安装、开发 Channel 启用、连接身份、恢复指定会话、查看状态和卸载连接的步骤；示例不用真实会话编号、凭证或个人对话。
- [ ] 标明 Channels 的预览和账号条件；以开发入口跑通不等于插件已可正式分发。
- [ ] 用一次真实工作执行“Codex 给 Claude 任务 → Claude 反问 → Codex 补充 → Claude 交付 → Codex 检查”。
- [ ] 中途断开一个测试连接再恢复，核对上下文、消息关联和无重复投递。
- [ ] 运行全部相关回归，记录完成层次、工具版本、运行限制，更新 HANDOFF；不沿用历史测试数字。

验证命令：`npm test`、`npm run typecheck`。预期测试与类型检查通过；真实跨工具往返、恢复测试、浏览器检查分别保留结果。未跑某层就明确写未跑。

## 6. 完成与不完成的分界

必须同时满足：

- [ ] 消息实际到达原目标会话，接入需要重启恢复时上下文连续。
- [ ] 两端都能主动发起并收到回复，第三个成员不串线。
- [ ] 不需要用户复制粘贴，Bridge 与模型处理回执区分准确。
- [ ] 重复消息不重复推进；崩溃后的不确定投递不会盲目重发。
- [ ] 旧 corpus MCP 仍只读，既有项目现场可用。
- [ ] 页面反映真实状态，真实任务成果可打开检查。

只有 Channel 通知发出、只有 curl 返回成功、只有数据库存在消息、只有一个新后台会话完成任务，均不算上述目标完成。

## 7. 执行前已知条件

- 本机曾核对 codex-cli 0.157.1 的 queue 帮助和 Claude Code 2.1.284 版本；当前未完成模型调用与双向测试，T0 重新核对。
- Claude Channels 官方说明：notification 写入不带处理确认；忙碌时消息进入后续处理；需要回复工具跟踪实际处理。参考：[Channel 协议](https://code.claude.com/docs/en/channels-reference)。
- 自定义 Channel 开发入口需要用户在 Claude 终端确认，组织策略仍适用。不能通过改配置绕开组织限制。参考：[开发 Channel 测试](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)。
- 当前已交付隔离验证脚本与接入报告，依赖仅安装在 scripts/probes/channel；没有改主应用依赖或既有 corpus MCP，也未操作用户原有会话。
