"""出处边界与多运行巡检；临时数据、假 Codex，不启动真实模型。"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import worker as runner
from test_worker import FAKE_CODEX

WORKER = Path(runner.__file__).resolve()


class L6aTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='lead-l6a-')
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        from unittest.mock import patch
        registry_environment = patch.dict(os.environ, CREW_HOME=str(self.tmp / 'registry'))
        registry_environment.start()
        self.addCleanup(registry_environment.stop)
        self.fake = self.tmp / 'fake-codex'
        self.fake.write_text(FAKE_CODEX)
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'registry'),
                    'CREW_CODEX_BIN': str(self.fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        self.source = self.tmp / 'api' / '原文.ts'
        self.source.parent.mkdir()
        self.source.write_text('第一行\n第二行\n第三行\n')

    def cli(self, *args, cwd=None):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              cwd=cwd, env=self.env, capture_output=True, text=True, timeout=10)

    def ok(self, *args, cwd=None):
        result = self.cli(*args, cwd=cwd)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def check_sample(self, body):
        report = self.tmp / 'delivery.out'
        report.write_text(body)
        good = self.ok('check', report)
        self.assertEqual(good['bad'], 0)
        self.assertEqual({c['path'] for c in good['citations']}, {str(self.source)})
        # 不能靠忽略所有引用来消除误报；缺文件与越界仍须拦下。
        report.write_text(body + f'\n{self.tmp}/missing.md:1\n{self.source}:99\n')
        result = self.cli('check', report)
        self.assertEqual(result.returncode, 1, result.stderr)
        bad = json.loads(result.stdout)
        self.assertEqual(bad['bad'], 2)
        self.assertEqual({c['status'] for c in bad['citations'] if c['status'] != 'ok'},
                         {'文件不存在', '行号越界'})

    def test_check_chinese_sentence_does_not_swallow_path(self):
        self.check_sample(f'读实例。{self.source}:3\nObject/Relation读实例。{self.source}:2\n')

    def test_check_urls_are_not_local_citations(self):
        self.check_sample(f'http://127.0.0.1:6480\n`https://example.test/api/loop.ts:1`\n'
                          f'[api/loop.ts:1](http://127.0.0.1:6480/api/loop.ts:1)\n{self.source}:1\n')

    def test_check_markdown_uses_target_not_label(self):
        self.check_sample(f'[api/loop.ts:1]({self.source}:1)\n'
                          f'[/missing/label.md:1]({self.source}:L2-L3)\n')
        report = self.tmp / 'delivery.out'
        report.write_text(f'[api/loop.ts:1]({self.tmp}/missing.md:1)\n'
                          f'[正确标签]({self.source}:99)\n')
        result = self.cli('check', report)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['bad'], 2)

    def run_dir(self, name, state=None):
        root = self.tmp / name
        (root / 'cards').mkdir(parents=True)
        (root / 'cards' / 'a.md').write_text('任务')
        if state:
            self.receipt(root, state)
        return root

    def receipt(self, root, state):
        output = root / 'a.out'
        output.write_text('## 结论卡\n问题／本次结论：完成\n\n## 细节\n不放入摘录\n')
        runner.write_json(root / 'a.json', {'state': state, 'pid': os.getpid(),
                                          'attempt_id': root.name, 'started_at': runner.now(),
                                          'output': str(output)})

    def grouped(self, result, roots):
        self.assertEqual([r['dir'] for r in result['runs']], [str(p) for p in roots])
        return result['runs']

    def test_wait_returns_second_delivery_while_first_runs(self):
        first = self.run_dir('first', 'running')
        second = self.run_dir('second')
        self.ok('run', second, '--cwd', self.tmp, '--seconds', '3')
        try:
            result = self.ok('wait', first, second, '--minutes', '.05')
            a, b = self.grouped(result, [first, second])
            self.assertEqual(a['fresh'], [])
            self.assertEqual(a['cards'][0]['state'], 'running')
            self.assertEqual(b['fresh'], ['a'])
            self.assertEqual(b['cards'][0]['state'], 'delivered')
            self.assertIn('conclusion', b['cards'][0])
            again = self.ok('wait', second, '--minutes', '.001')
            self.assertEqual(again['fresh'], [])
            self.assertNotIn('conclusion', again['cards'][0])
        finally:
            # 若旧 CLI 拒绝多目录，仍等本测试启动的假执行者退出再清理。
            end = time.monotonic() + 5
            while time.monotonic() < end:
                if (runner.Run(second).receipt('a') or {}).get('state') not in runner.ACTIVE_STATES:
                    break
                time.sleep(.05)

    def test_wait_stall_notifies_once_and_does_not_stop_other_run(self):
        first = self.run_dir('first', 'running')
        second = self.run_dir('second', 'stalled')
        a, b = self.grouped(self.ok('wait', first, second, '--minutes', '.01'), [first, second])
        self.assertEqual(a['fresh'], [])
        self.assertEqual(b['fresh'], ['a'])
        self.assertNotIn('conclusion', b['cards'][0])
        again = self.ok('wait', first, second, '--minutes', '.001')
        self.assertTrue(all(not r['fresh'] for r in again['runs']))
        self.assertEqual(runner.Run(first).receipt('a')['state'], 'running')

    def test_wait_deadline_is_shared_and_includes_locked_run(self):
        first = self.run_dir('first', 'running')
        second = self.run_dir('second', 'running')
        with (first / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            started = time.monotonic()
            result = self.ok('wait', first, second, '--minutes', '.002')
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, .12)
        self.assertLess(elapsed, .5)
        self.assertTrue(all(not r['fresh'] for r in self.grouped(result, [first, second])))

    def test_wait_locked_first_run_does_not_hide_second_event(self):
        first = self.run_dir('first', 'running')
        second = self.run_dir('second', 'finished')
        with (first / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.ok('wait', first, second, '--minutes', '.01')
        a, b = self.grouped(result, [first, second])
        self.assertEqual(a['fresh'], [])
        self.assertEqual(b['fresh'], ['a'])

    def test_wait_idle_run_does_not_finish_wait_for_active_run(self):
        first = self.run_dir('first')
        second = self.run_dir('second', 'running')
        delivery = threading.Timer(.15, self.receipt, args=(second, 'finished'))
        delivery.start()
        try:
            result = self.ok('wait', first, second, '--minutes', '.02')
        finally:
            delivery.join()
        a, b = self.grouped(result, [first, second])
        self.assertEqual(a['fresh'], [])
        self.assertEqual(b['fresh'], ['a'])
        self.assertNotIn('细节', b['cards'][0]['conclusion'])

    def test_wait_all_idle_returns_and_single_keeps_existing_shape(self):
        first = self.run_dir('first')
        second = self.run_dir('second')
        result = self.ok('wait', first, second, '--minutes', '10')
        self.assertTrue(all(not r['fresh'] for r in self.grouped(result, [first, second])))
        single = self.ok('wait', first, '--minutes', '10')
        self.assertEqual(set(single), {'run', 'dir', 'cards', 'fresh'})
        self.assertEqual(single, {**self.ok('status', first), 'fresh': []})


if __name__ == '__main__':
    unittest.main()
