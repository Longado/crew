# Crew 材料自动处理 Implementation Plan

> **For agentic workers:** Implementation is authorized. Use executing-plans inline; no delegated development is needed. Steps use checkbox syntax for tracking.

**Goal:** `crew intake` 接收文本文件或目录，自动生成带原文与项目依据的归属卡，重复输入复用结果，项目变化后重新判断用途。

**Architecture:** 单次命令、串行两阶段处理。第一阶段从材料提取事项并选择候选项目；第二阶段读取候选项目当前交接后判断用途。Claude 订阅 CLI 只做语义判断，不开放工具；程序负责只读来源、引用检查、版本缓存及本地保存。结果均为待确认建议，不写业务任务库。

**Tech Stack:** Python 标准库；现有 Node CLI 转发；Claude Code 的订阅登录。

## 从分享转成 Crew 行为

| 分享中的思路 | 本轮可落地的行为 |
|---|---|
| 模型识别意图，确定性机制处理可核查部分 | 模型判断相关性；程序检查项目 ID、原文引句与行号，错误结果不发布成成功卡 |
| 报告生成快，核实更费时间 | 每个事项有原文引用，每个项目关联有当前交接或项目记录引用 |
| 业务逻辑都堆进 Skill 后难维护 | 项目状态读取现有项目记录；提示词不写死私人项目、客户或具体路线图 |
| 专家审查、适用范围与变更影响 | 讲者主张／案例／设想分别记录；一份材料可关联多个项目，也可不产生任务；上下文变化使用途分析缓存失效 |

## 范围

输入仅 UTF-8 `.txt`／`.md`，目录只看直接子文件。视频、PDF、后台监测和 UI 不属于这一版。输出 JSON 与 Markdown；任务建议不会自动登记、执行或当成完成。个别工作线暂缓仅作为本轮 `--focus` 输入，不修改长期项目状态。其他项目只参与关联，不改代码或路线图。

## 执行

- [x] 在 `scripts/intake/test_intake.py` 先写失败测试：只读项目读取、按内容去重、错误引用／虚构项目拒绝、当前交接变化后重新分析、CLI 帮助和 dry-run 无副作用。执行 `python3 -B -m unittest discover -s scripts/intake -p 'test_*.py'`，观察新入口缺失的失败。
- [x] 新增 `scripts/intake/intake.py`：`read_sources`、`read_catalog`、`project_context`、`validate_analysis`、`validate_card`、`process`、`main`。模型输入为带行号的材料与项目快照；数据里的指令不执行。输出对象含 `state: pending_review`，事项、匹配、动作与引用分开。
- [x] 在 `src/cli.ts` 的 `loadEnv()` 之前转发 `intake` 参数给 Python，形式与 `worker` 一致：`spawnSync('python3', ['-B', script, ...process.argv.slice(3)], { stdio: 'inherit' })`。此入口不打开 Corpus 库、不加载 `.env`。
- [x] 加入 CLI 路由测试与 `docs/INTAKE.md`；运行新测试、现有 CLI／今日来源相关检查和 `npm run typecheck`。
- [x] 用本轮四份真实转写从 CLI 处理，最多每份两次模型请求；核对结果与原件。再跑同一命令确认复用已完成分析。实际输出保存在本地私有目录，代码仓只放合成样例。
- [ ] 更新项目 HANDOFF 和本轮内部接力记录，说明实际可用入口、模型用量、未完成范围及真实使用限制；核对改动范围后将本地结果接回正式工作目录，不推送。
