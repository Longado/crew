"""隔离负责人回归：临时登记目录贯穿整组测试和所有子进程。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='crew-lead-tests-') as home:
        # ponytail: 本项目执行环境为 Unix；false 拒绝意外执行，测试按需改用本地替身。
        env = {**os.environ, 'CREW_HOME': home, 'PYTHONDONTWRITEBYTECODE': '1'}
        env['CREW_CODEX_BIN'] = env.get('CREW_CODEX_BIN') or '/usr/bin/false'
        commands = [[sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'scripts/lead', '-p', 'test_*.py']]
        # 服务与恢复共享一组隔离进程，保留现有四组回归入口。
        commands += [[sys.executable, '-B', '-m', 'unittest',
                      *['scripts/task-board/' + name for name in ('test_server.py', 'test_recovery.py')]]]
        commands += [[sys.executable, '-B', 'scripts/task-board/' + name]
                     for name in ('test_lead_runs.py', 'test_fix_b_board.py')]
        failed = False
        for command in commands:
            failed = subprocess.run(command, env=env, cwd=root).returncode != 0 or failed
        return int(failed)


if __name__ == '__main__':
    sys.exit(main())
