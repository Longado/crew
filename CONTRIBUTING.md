# Contributing

欢迎提交 issue 或 pull request。先说明用户想完成什么，再给出最小合成复现、实际结果和预期结果。请勿提交个人材料、真实项目片段、私有卡片、缓存、凭证或运行记录；用合成资料替换。

材料流程只需 Python 3.9+，离线检查：

```sh
python3 -B -m unittest discover -s scripts/intake -p 'test_*.py'
CREW_DEMO_OUT="$(python3 -c 'import tempfile; from pathlib import Path; print(Path(tempfile.mkdtemp()).resolve())')"
CREW_CLAUDE_BIN=/usr/bin/false ./bin/crew intake demo --output "$CREW_DEMO_OUT" --json
```

演示使用预设分析，不需要模型账号。完整工作台变更另需 Node 22.18+，运行 `npm ci`、`npm run typecheck`、`npm test`；负责人变更运行 `python3 scripts/lead/run_tests.py`。

PR 请保持范围集中，说明用户可见变化和运行过的相关检查。反馈入口：[Issues](https://github.com/Longado/crew/issues)；代码入口：[Pull requests](https://github.com/Longado/crew/pulls)。
