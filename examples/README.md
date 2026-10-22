# 示例

这里的文件都是编出来的示例数据，项目是一个“记账小程序”。它们和 [在线演示](https://longado.github.io/crew/) 用的是同一份样本（`samples/S8-showcase`）。

| 文件 | 是什么 | 怎么用 |
|---|---|---|
| [corpus-show.txt](corpus-show.txt) | 在终端看项目现场的输出 | `corpus demo` 之后运行 `corpus show` |
| [continue-context.md](continue-context.md) | 给 AI 的续接上下文，任务是“月度导出” | `corpus context --task T04`，或在页面上点“继续” |
| [gemini-chat.md](gemini-chat.md) | 一段网页 AI 对话，用“你：”“Gemini：”分开说话人 | 页面“接入设置 → 粘贴导入”，把全文贴进去 |
| [takeout/](takeout/) | Google Takeout 导出的目录结构，含网页版 Gemini 和 Gemini in Workspace 两种格式 | 页面“接入设置 → 从 Takeout 导入”，选这个目录打成的 zip |

## 自己跑一遍

```bash
npm install && npm link
corpus demo                              # 建示例项目，不调用模型
corpus show                              # 终端里看现场
corpus context --task T04                # 取“月度导出”的续接上下文
corpus app                               # 打开桌面窗口，可以改状态、看原文
```

## 这份示例能看到什么

- 不同工具的对话拼成一个项目：Gemini 网页里定需求，Codex 写登录、报告导出文件打不开，Claude Code 写记账、统计、导出和图表。
- AI 说完成不算完成：“记账录入”和“月度导出”停在待验证，等你确认。
- 失败会重开：“月度导出”第一次导出的文件打不开，被打回进行中，第二次又报完成。
- 规划改过就有版本：第 2 版加了“本地备份”，取消了“云同步”。
- 决定会被替代：“先用本地存储”后来改成“封装好的存储层”，旧决定标为已替代。
- AI 的建议先进待确认：“预算提醒”是 AI 提的，你没点头之前不算任务。
- 受阻写清缺什么：“图表页”缺设计稿。
