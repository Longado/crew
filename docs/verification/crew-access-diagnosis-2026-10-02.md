# Crew 页面访问与审批拒绝诊断 · 2026-10-02

当前直接原因已经确认：**Browser Use 对 `http://127.0.0.1:6480` 存在已保存的用户阻止偏好**。正式入口在访问页面前即被拒绝，尚未进入 Crew 页面；本次拒绝不能归因于 Crew JS／CSS 或服务响应。历史“用户拒绝”与当前“保存偏好阻止”形成证据链，但工具没有给出保存偏好的操作主体、点击过程或存储位置。

## 原始证据

主会话：`<用户目录>/.codex/sessions/<会话记录>.jsonl`。下表行号为调用 → 工具返回，时间均 UTC+8；只摘录相关返回，不附带浏览器全量记录或私密内容。

| 时间 | 行号 | 动作与原始结果 | 判断 |
|---|---|---|---|
| 10-01 15:21 | 529 → 532 | `createBrowserTab("iab", 原地址)`：`Browser is not available: iab` | IAB 入口不可用，非用户拒绝 |
| 10-01 15:55 | 857 → 860 | Chrome `getTab`：`Unable to load browser request-header policy. Retry the browser command.` | 策略加载故障，内部原因未公开 |
| 10-01 20:48 | 2298 → 2301 | `getApp('/Applications/Orca.app')`：`Computer Use was not approved to use Orca` | 应用访问未批准，决定来源未公开 |
| 10-02 00:19 | 2438 → 2441 | 原地址 `getTab(..., {browser:'1'})`：`Reason: The user declined permission for this action.` | 当次网站访问被拒；无法区分本人点击、误点或审批映射 |
| 10-02 19:28 | 4635 → 4640 | `orca computer capabilities --json`：`runtime_access_denied`；`The Codex sandbox blocked this command from connecting to Orca (EPERM). Orca may be running normally.` | 沙箱阻止 Orca IPC 连接，独立于网站偏好 |
| 10-02 19:31:04 | 4697 → 4700 | 原地址与 browser 1 的 `getTab`：`Tab not found in browser 1.` | 旧标签已不存在，无页面内容证据 |
| 10-02 19:31:13 | 4704 → 4707 | 同浏览器 `createBrowserTab`：`Reason: A saved user permission setting blocks this action.`；`the user has a saved preference that blocks it` | 确认持续阻塞来自保存的用户偏好 |

本轮 `cua.getState()` 能列出应用与 Chrome 浏览器，说明正式工具入口并非整体失效；这不代表具体网站已获准。浏览器拒绝同时明确禁止间接执行、CDP、其他浏览器入口或其他规避方式，该页面访问已停止。

权限配置只读核对：`<用户目录>/.codex/config.toml` 存在，但顶层未设置 `sandbox_mode`／`approval_policy`／`approvals_reviewer`；工作区 `.codex/config.toml` 不存在。当前 `workspace-write`／`never` 来自会话已提供的执行约束；宿主或管理策略具体哪层选定它，现有工具未公开。不应把修改一个本地配置文件当作当前受管理会话已恢复权限的证据。

## 正式恢复与验证

1. 本人打开 ChatGPT 桌面端 **Settings → Browser**，在允许／阻止网站中找到 `http://127.0.0.1:6480`，解除这个具体地址的阻止或恢复为询问，再告知本窗口。网站列表入口由 [官方 Browser 文档](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser) 说明；实际菜单名称随版本可能不同。本轮没有代改设置或扩大浏览器访问范围。
2. 收到设置已改变的反馈后，使用同一 Browser Use 入口复测一次，再检查实际页面加载与视觉。若仍为 saved preference 拒绝，记录返回并停止，交产品支持核对该条保存决定；不切地址、端口或控制通道。
3. Orca CLI 的 EPERM 需要另行恢复命令执行授权。当前会话为 `workspace-write`、网络受限、`approval_policy: never`，不能请求沙箱提权；`never` 不等于所有动作已允许。工具明确提示不要重启 Orca，重启不能授予这条命令连接权限。正常桌面终端可由本人运行 `orca computer capabilities --json` 作对照；若需本窗口操作，在宿主权限控件恢复可交互审批后再验证。[官方沙箱说明](https://learn.chatgpt.com/docs/sandboxing#how-permissions-work) 区分执行边界与审批模式；本轮没有改变该边界。
4. macOS 屏幕录制／辅助功能、ChatGPT 应用审批和沙箱权限分别管理。[官方 Computer Use 文档](https://learn.chatgpt.com/docs/computer-use#permissions-and-approvals) 明确区分它们；仅在返回具体 OS 权限缺失时处理对应权限。本轮没有取得 OS 权限缺失证据，不重置 TCC、不关闭安全保护。

网站许可恢复后，若仍出现 request-header policy 加载故障，再单独采集正式工具返回及产品诊断。现有记录不足以判定网络、缓存、版本或策略服务哪个是内部原因。若设置页没有该条目，可向产品支持提供目标 origin、上述时间和调用返回；不需要上传全会话、全量浏览历史或凭据。

## 当前完成程度

直接拒绝原因与不同权限层已定位；恢复操作尚待本人改变保存偏好。真实页面仍未打开、渲染或捕获。已保存偏好是谁设置的、策略加载故障内部原因、Orca 应用审批决定来源仍未知，不能声称所有内部机制已查明。
