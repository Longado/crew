"""Checks for the lead-mode write runs (--write). A fake codex stands in; no model runs."""
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


class WriteRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        fake = self.tmp / 'codex'
        fake.write_text(FAKE_CODEX)
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.work = self.tmp / 'work'
        (self.work / 'seg').mkdir(parents=True)
        (self.work / 'seg' / 'a.js').write_text('old\n')
        (self.work / 'shared.js').write_text('shared\n')
        (self.work / 'gone.txt').write_text('x\n')
        self.run_dir = self.work / 'runs' / 'r1'  # 运行目录在工作目录里面：它自己的回执不能算成改动
        (self.run_dir / 'cards').mkdir(parents=True)
        (self.run_dir / 'cards' / 't1.md').write_text('可写：seg/a.js, props/a-*\n换掉 a 段的道具')

    def worker(self, *args):
        return subprocess.run([sys.executable, str(WORKER), *args], env=self.env, capture_output=True, text=True, timeout=30)

    def go(self, *extra):
        r = self.worker('run', str(self.run_dir), '--cwd', str(self.work), *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        for _ in range(60):
            status = json.loads(self.worker('status', str(self.run_dir)).stdout)
            if not any(c['state'] == 'running' for c in status['cards']):
                return status
            self.worker('wait', str(self.run_dir), '--minutes', '1')
        self.fail('执行者一直没交回来')

    def calls(self):
        return [json.loads(line) for line in (self.tmp / 'calls.jsonl').read_text().splitlines()]

    def test_write_run_drops_the_sandbox_and_says_so(self):
        self.go('--write')
        call = self.calls()[-1]
        self.assertIn('danger-full-access', call['args'])
        self.assertNotIn('read-only', call['args'])
        self.assertIn('只改任务卡「可写」', call['prompt'])
        self.assertNotIn('只读：不写文件', call['prompt'])
        receipt = json.loads((self.run_dir / 't1.json').read_text())
        self.assertEqual(receipt['sandbox'], 'danger-full-access')

    def test_changes_lists_edits_and_flags_paths_no_card_may_write(self):
        self.go('--write')
        (self.work / 'seg' / 'a.js').write_text('new, longer\n')
        (self.work / 'props').mkdir()
        (self.work / 'props' / 'a-sofa.png').write_bytes(b'png')
        (self.work / 'shared.js').write_text('touched by someone\n')
        (self.work / 'gone.txt').unlink()
        r = self.worker('changes', str(self.run_dir))
        self.assertEqual(r.returncode, 1, r.stderr)  # 有越界改动
        out = json.loads(r.stdout)
        self.assertEqual({c['path']: c['cards'] for c in out['modified']}, {'seg/a.js': ['t1'], 'shared.js': []})
        self.assertEqual([c['path'] for c in out['added']], ['props/a-sofa.png'])
        self.assertEqual([c['path'] for c in out['deleted']], ['gone.txt'])
        self.assertEqual(sorted(out['out_of_bounds']), ['gone.txt', 'shared.js'])

    def test_changes_is_clean_when_only_owned_paths_move(self):
        self.go('--write')
        (self.work / 'seg' / 'a.js').write_text('new, longer\n')
        r = self.worker('changes', str(self.run_dir))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)['out_of_bounds'], [])

    def test_retry_resumes_without_the_sandbox_too(self):
        self.go('--write')
        r = self.worker('reject', str(self.run_dir), 't1', '--note', '沙发太小')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.go('--write', '--retry', 't1')
        call = self.calls()[-1]
        self.assertIn('resume', call['args'])
        self.assertIn('sandbox_mode="danger-full-access"', call['args'])

    def test_a_write_run_cannot_continue_read_only_and_vice_versa(self):
        self.go('--write')
        self.worker('reject', str(self.run_dir), 't1', '--note', '重来')
        r = self.worker('run', str(self.run_dir), '--cwd', str(self.work), '--retry', 't1')
        self.assertEqual(r.returncode, 2)
        self.assertIn('--write', r.stderr)

    def test_changes_refuses_a_read_only_run(self):
        self.go()
        r = self.worker('changes', str(self.run_dir))
        self.assertEqual(r.returncode, 2)


if __name__ == '__main__':
    unittest.main()
