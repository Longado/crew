# 合成材料试用

这里全部是合成材料与虚构项目，不含真实客户信息，也不附模型生成的假结果。示例展示如何把访谈里的需求对照当前项目，整理成带出处的待确认建议。

## 离线演示

从仓库根目录运行 `./bin/crew intake demo`。只需 Python 3.9+，无需 Node/npm、Claude 登录或网络。

**合成演示，使用预设分析，不调用模型。** `demo-answers.json` 是手写预设，沿用下方既有材料与项目交接的原文行号；它不是模型结果，也不代表已实现或验收。预设建议为 A1 评估发布说明草稿的出处与适用版本、A2 建议暂缓自动发布。首次两条都是 `pending`。

默认输出 `~/.local-sensitive/crew-intake-demo/`；可加 `--output DIR` 或 `--json`。命令打印实际卡片路径和可复制的 review／accept A1／export 命令。先读摘要、项目关系与编号建议，再回查原文及项目引用。重复运行保留已有决定，演示缓存与真实分析分开，导出继续保留演示标识。

## 用真实模型分析合成材料

从仓库根目录运行；dry-run 不需要 Claude 登录、不调用模型、不创建输出或 Corpus 数据库：

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

实际生成卡片前，安装并用订阅账号登录 Claude Code。以下命令会向该服务发送合成材料和候选项目片段，将结果保存到自己的私有目录：

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --output "$HOME/.local-sensitive/crew-intake-synthetic-analysis"
```

打开命令返回的 `report` 阅读汇总，并检查卡片的原文引用和项目引用。合理的用途是评估发布说明的出处与版本需求；花园日志没有明显关联。具体模型输出可能不同，需要人工判断。Crew 不创建任务或执行建议；示例目录不会保存处理结果。
