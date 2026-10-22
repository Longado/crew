# Claude Code 插件

装上之后，Claude Code 里多了三样东西：

- MCP 工具 `corpus`：列出项目、看项目现场、生成某个任务的续接上下文。只读，不调用模型。
- 技能 `working-corpus`：你说"按现场继续""接着做 T03"时，先看现场、再取续接上下文，按里面的范围和完成标准干活，不自己宣布完成。
- 会话结束时在后台只读同步一次（不整理、不调用模型），下次打开网页或调用工具时数据是新的。

## 安装

需要本机有 Node 22.18 或更新版本。在 Claude Code 里：

```
/plugin marketplace add Longado/crew
/plugin install working-corpus@working-corpus
```

仓库地址已更新为 `Longado/crew`；插件名和市场名保留 `working-corpus`，`/plugin install` 命令不变。

第一次调用工具时，插件会在自己的目录里装依赖（只有 zod 一个），需要联网，之后不再装。数据和网页共用 `~/.working-corpus/`。

整理对话（调用模型）仍然在网页或命令行里做：`corpus serve` 打开网页，点"同步"。

## 不装插件也能用

- 只要 MCP：见 `docs/MCP.md`。
- 想在终端里直接用 `corpus` 命令：在仓库目录运行 `npm install && npm link`。

## 已验证

2026-09-13 用 `claude --plugin-dir <仓库> -p` 在示例数据上实测：`list_projects` 工具正常返回；会话结束钩子在后台跑完了同步。`claude plugin validate` 对插件清单、插件市场清单、技能目录都通过。通过插件市场安装的完整流程没有实测，因为会改全局配置。
