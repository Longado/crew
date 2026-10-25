<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img alt="Crew" src="docs/logo-light.png" width="420">
  </picture>
</p>

# Crew

**材料变行动：资料 + 当前项目 → 带出处的建议 → 逐条决定 → 导出已采纳行动。**

访谈讨论如何补充发布说明草稿的出处与适用版本，并明确暂缓自动发布。Crew 把材料原话和项目依据放在建议旁，你可以采纳“先检查发布说明”，保留“暂缓自动发布”的建议等待决定，再导出已采纳的下一步。

[English](README.en.md) · [材料流程说明](docs/INTAKE.md) · [0.3.0 版本说明](docs/releases/0.3.0.md) · MIT · **Alpha**

## 先试预设示例

只需 **Python 3.9+、Git 和 macOS／Linux**。无需 Node/npm、模型账号或私人数据库。

```sh
git clone https://github.com/Longado/crew
cd crew
./bin/crew intake demo
```

这是合成材料和预设分析的本地演示，不调用模型。命令会显示卡片位置和下一步命令；A1 是检查发布说明的出处与适用版本，A2 是暂缓自动发布。演示不代表模型分析质量。

完整走一遍查看、采纳和导出：

```sh
CREW_CARD="$(./bin/crew intake demo --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["cards"][0]["json"])')"
./bin/crew intake review "$CREW_CARD"
./bin/crew intake review "$CREW_CARD" --action A1 --decision accept --note '用于下轮讨论'
./bin/crew intake export "$CREW_CARD"
```

首次生成的建议都是 `pending`。也可用 `--decision defer` 暂缓或 `--decision dismiss` 不采纳，选择保留历史。导出只包含当前卡片中已采纳的建议及其出处，**尚未执行**；可加 `--format json`。重复演示保留之前的选择。

## 用自己的资料和项目

先用仓库内的合成资料查看输入范围：

```sh
./bin/crew intake examples/intake/meeting.md --workspace examples/intake --catalog examples/intake/projects.json --dry-run
```

把资料放进自己的目录，按 [项目清单契约](docs/INTAKE.md#项目依据) 写 JSON，再将命令中的材料、`--workspace` 和 `--catalog` 改为对应路径。项目路径相对于 `--workspace`，不是清单文件；候选项目的当前交接或说明文件提供判断依据。已有任务库可通过 `--database` 兼容接入，不是首次使用的前提。

项目清单的最小结构如下；`id` 为唯一正整数，`name` 和 `path` 必填，`description` 可省略，`status` 默认为 `active`（也可为 `paused`）。

```json
{"version":1,"projects":[{"id":1,"name":"Release notes","description":"Draft release notes with sources","path":"projects/release-notes","status":"active"}]}
```

去掉 `--dry-run` 才开始真实分析，需要已安装并用订阅账号登录的 **Claude Code**。材料和候选项目片段会发送给该服务。材料入口不使用 API key；Claude Code 本身的安装要求以其官方说明为准。

支持 UTF-8 `.txt`／`.md`，目录只读直接子文件，不递归；PDF、音频和视频先转文本。当前提示词和卡片主要为简体中文。引用校验能发现无效出处，不能保证讲者主张真实或建议合适。

## 数据与边界

默认真实分析结果在 `~/.local-sensitive/crew-intake/`，演示在 `~/.local-sensitive/crew-intake-demo/`；`--output` 可指定其他本地私有目录。这里会保存原文快照、缓存、卡片、决定和运行记录，仍需自己管理目录权限和备份。原件不改，采纳只影响导出，不会创建任务、修改项目、发消息或自动执行。真实分析会使用远程 Claude 服务，并非所有处理都在本机完成。

**0.3.0 仍是早期版本。** 没有自动监测收件箱、PDF/音视频解析或材料网页操作入口；先用合成材料理解流程，再判断哪些资料适合发送。详见 [完整范围与隐私说明](docs/INTAKE.md)。

## 已有工作台与项目现场

Crew 也保留本地终端工作台、对话项目现场、负责人模式和本地管家。它们使用可选的完整安装路径，需要 Node 22.18+：

```sh
npm ci
npm link
crew demo
crew app
```

[项目现场旧版演示](https://longado.github.io/crew/)是记账项目的只读样例；其中的页面、录屏和讲解视频展示项目现场，不是材料变行动流程。

[工作台](docs/CREW.md) · [团队工作台](docs/TEAM-WORKBENCH.md) · [本地管家](docs/HOUSEKEEPER.md) · [MCP](docs/MCP.md) · [Claude Code 插件](docs/PLUGIN.md) · [旧版演示说明](docs/DEMO.md)

## 反馈与贡献

欢迎用不含私人资料的合成例子说明：输入是什么、建议哪里不合适、希望怎样决定或导出。请到 [Issues](https://github.com/Longado/crew/issues) 反馈，或阅读 [贡献说明](CONTRIBUTING.md) 后提交 PR。

## 许可

[MIT](LICENSE)
