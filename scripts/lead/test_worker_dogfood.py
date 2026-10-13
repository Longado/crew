"""10-13 第一次用 --write 派真活（视频道具 3D 化）踩到的三处，各一条检查。A fake codex stands in; no model runs."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_worker import FAKE_CODEX, WORKER  # noqa: E402

# 真 Codex 的 "tokens used" 是整段会话累计的（不含缓存命中），resume 之后接着往上加
TOKENS_LINE = "print('1,234')"
assert FAKE_CODEX.count(TOKENS_LINE) == 1
FAKE = FAKE_CODEX.replace(TOKENS_LINE, "print(os.environ.get('FAKE_TOKENS', '1,234'))")


class DogfoodTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        fake = self.tmp / 'codex'
        fake.write_text(FAKE)
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.work = self.tmp / 'work'
        self.work.mkdir()
        (self.work / 'a.js').write_text('old\n')
        self.run_dir = self.work / 'runs' / 'r1'
        (self.run_dir / 'cards').mkdir(parents=True)
        (self.run_dir / 'cards' / 't1.md').write_text('可写：a.js\n改 a')

    def worker(self, *args, env=None):
        return subprocess.run([sys.executable, str(WORKER), *args], env=env or self.env, capture_output=True, text=True, timeout=30)

    def go(self, *extra, env=None):
        r = self.worker('run', str(self.run_dir), '--cwd', str(self.work), *extra, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        for _ in range(60):
            status = json.loads(self.worker('status', str(self.run_dir)).stdout)
            if not any(c['state'] == 'running' for c in status['cards']):
                return {c['card']: c for c in status['cards']}
            self.worker('wait', str(self.run_dir), '--minutes', '1')
        self.fail('执行者一直没交回来')

    def prompt(self):
        return json.loads((self.tmp / 'calls.jsonl').read_text().splitlines()[-1])['prompt']

    def test_write_worker_gets_a_scratch_dir_that_changes_ignores(self):
        # 10-13：截图、浏览器缓存没地方放，执行者塞进了工程目录，changes 列出几百个文件
        self.go('--write')
        scratch = self.run_dir / 'scratch' / 't1'
        self.assertTrue(scratch.is_dir())
        self.assertIn(str(scratch), self.prompt())
        (scratch / 'shot.png').write_bytes(b'png')
        out = json.loads(self.worker('changes', str(self.run_dir)).stdout)
        self.assertEqual(out['added'], [])

    def test_worker_is_told_to_skip_the_interactive_session_rituals(self):
        # 10-13：执行者照工作区 AGENTS.md 的开场流程去查任务库、读会话记录
        self.go('--write')
        self.assertIn('开场流程', self.prompt())

    def test_resumed_card_reports_tokens_of_this_round_not_the_whole_session(self):
        self.go('--write', env={**self.env, 'FAKE_TOKENS': '146,003'})
        self.worker('reject', str(self.run_dir), 't1', '--note', '台子离地')
        cards = self.go('--write', '--retry', 't1', env={**self.env, 'FAKE_TOKENS': '295,544'})
        self.assertEqual(cards['t1']['tokens'], 149541)
        receipt = json.loads((self.run_dir / 't1.json').read_text())
        self.assertEqual(receipt['tokens_session'], 295544)


if __name__ == '__main__':
    unittest.main()
