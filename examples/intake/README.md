# 合成材料试用

这里全部是合成材料与虚构项目，不含真实客户信息，也不附模型生成的假结果。示例展示如何把访谈里的需求对照当前项目，整理成带出处的待确认建议。

从仓库根目录运行；dry-run 不需要 Claude 登录、不调用模型、不创建输出或 Corpus 数据库：

```sh
node --no-warnings src/cli.ts intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

实际生成卡片前，安装并用订阅账号登录 Claude Code。以下命令会向该服务发送合成材料和候选项目片段，将结果保存到自己的私有目录：

```sh
node --no-warnings src/cli.ts intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --output "$HOME/.local-sensitive/crew-intake-demo"
```

打开命令返回的 `report` 阅读汇总，并检查卡片的原文引用和项目引用。合理的用途是评估发布说明的出处与版本需求；花园日志没有明显关联。具体模型输出可能不同，需要人工判断。Crew 不创建任务或执行建议；示例目录不会保存处理结果。
