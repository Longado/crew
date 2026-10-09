# Crew：Codex 负责人和底部团队面板

用户确认学习新版 Claude Code 的底部成员面板，并要求继续改进 Crew。本轮只实现独立的 Codex 原生团队模式、跨页面底部成员条及其任务、记录、回答、审批和中断入口；保留跨工具委派和日常终端。

## 决策记录

- 执行使用专用 Codex App Server 的原生子 Agent，不创建固定数量的假工牌。成员来自 thread / collab 事件，兼容当前 CLI schema 与文档中的旧 collab 形状。
- 底部条在当前项目各页常驻，详情展开在条上方；不重排终端。任务比例只统计负责人已接受的项目。执行结束、成果提交与验收分别记录。
- 负责人专用动态工具记录最多三项任务、独占文件职责、真实成员绑定及检查结论；每项最多一次返工。普通对话不改验收状态。
- 原生审批和输入请求绑定原请求、会话、turn 和本轮运行；不自动批准。中断请求不等于中断确认。迟到输出留在记录，不成为新一轮的成果。
- 读写沿用隔离副本与基线策略，不自动应用到源项目。付费 ChatGPT 登录检查沿用原工具，禁用 API key 回退和无关 MCP/apps/plugins/web search。成员继承本轮目录与审批设置，接入子会话时检查生效策略。
- 接入使用 App Server 标准 stdio，不另开 Claude Channel；Crew 网页仍使用原有 HTTP/SSE。

## 实现与验证

- [x] 原生团队协议、专用进程接入、快照及 HTTP 控制。
- [x] 底部条、成员详情、草稿保留、原生问答和断线禁用。
- [x] 无模型协议、进程替身、内存 HTTP 和 DOM 交互检查；确切结果见本轮验证回执。
- [ ] 真实模型、原生子会话、审批/问答/中断闭环。
- [ ] 浏览器桌面及窄屏视觉检查。

真实启动在建立会话前断开；没有重复启动或调用模型。浏览器工具返回 request-header policy 错误，未绕过。下一步按 [固定验收入口](../../../scripts/probes/codex-team/README.md) 在正常桌面环境验证。

参考：[Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)。当前安装的 Codex CLI 为 0.159.2；具体字段另核对该版本生成的实验性 JSON schema。
