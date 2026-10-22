"""本机运行登记与只读快照；所有执行入口默认拒绝启动模型。"""
import concurrent.futures
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'crew-home'
        self.deny = self.root / 'deny-codex'
        self.deny.write_text('#!/bin/sh\nexit 99\n')
        self.deny.chmod(0o755)
        env = patch.dict(os.environ, CREW_HOME=str(self.home), CREW_CODEX_BIN=str(self.deny))
        env.start()
        self.addCleanup(env.stop)
        path = HERE / 'runs_registry.py'
        self.assertTrue(path.is_file(), '缺少负责人运行登记模块')
        spec = importlib.util.spec_from_file_location('runs_registry', path)
        self.registry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.registry)
        self.run = self.root / 'run'
        (self.run / 'cards').mkdir(parents=True)
        self.created = (dt.datetime.now().astimezone() - dt.timedelta(seconds=90)).isoformat()
        self.write('run.json', {'created_at': self.created, 'goal': '检查负责人运行'})
        (self.run / 'cards/a.md').write_text('任务 A')
        (self.run / 'cards/b.md').write_text('依赖：a\n任务 B')

    def write(self, name, data):
        (self.run / name).write_text(json.dumps(data, ensure_ascii=False))

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.root.rglob('*') if p.is_file()}

    def test_registration_deduplicates_canonical_path_and_concurrent_calls(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: self.registry.register(self.run / '..' / 'run', '首次目标'), range(12)))
        self.registry.register(self.run, '重复目标')
        records = [json.loads(line) for line in (self.home / 'lead-runs.jsonl').read_text().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0], {'dir': str(self.run), 'goal': '首次目标', 'created_at': self.created})

    def test_moved_directory_preserves_goal_and_is_read_only(self):
        self.registry.register(self.run, '旧目录目标')
        self.run.rename(self.root / 'moved')
        before = self.snapshot()
        rows = self.registry.read_runs()
        self.assertEqual(rows[0]['status'], 'moved')
        self.assertEqual(rows[0]['goal'], '旧目录目标')
        self.assertEqual(rows[0]['cards'], [])
        self.assertEqual(before, self.snapshot())

    def test_reader_shows_current_cards_elapsed_tokens_review_and_conclusion(self):
        self.registry.register(self.run)
        (self.run / 'a.out').write_text('## 结论卡\n问题／本次结论：已找到入口。\n### 依据\n本地材料。\n## 细节\n不应出现在摘要')
        self.write('a.json', {'state': 'finished', 'started_at': self.created, 'seconds': 8.5,
                              'tokens': 1234, 'tokens_session': 9000, 'output': str(self.run / 'a.out')})
        before = self.snapshot()
        row = self.registry.read_runs()[0]
        self.assertEqual(row['goal'], '检查负责人运行')
        a, b = row['cards']
        self.assertEqual((a['state'], a['seconds'], a['tokens']), ('delivered', 8.5, 1234))
        self.assertEqual(b['state'], 'waiting')
        self.assertIsNone(b['tokens'])
        self.assertIn('### 依据', a['conclusion'])
        self.assertNotIn('不应出现在摘要', a['conclusion'])
        self.assertEqual(before, self.snapshot())
        # 与第二轮的验收版本绑定兼容，合并后仍使用真实卡片和冻结稿。
        output = self.run / 'a.out'
        frozen = self.run / 'a.accepted.out'
        frozen.write_bytes(output.read_bytes())
        card_hash = hashlib.sha256((self.run / 'cards/a.md').read_bytes()).hexdigest()
        self.write('a.json', {'state': 'finished', 'seconds': 8.5, 'tokens': 1234,
                              'card_sha256': card_hash, 'output': str(output),
                              'review': {'verdict': 'accepted', 'note': '已核原文',
                                         'card_sha256': card_hash, 'accepted_output': str(frozen),
                                         'output_sha256': hashlib.sha256(output.read_bytes()).hexdigest()}})
        a, b = self.registry.read_runs()[0]['cards']
        self.assertEqual(a['review']['note'], '已核原文')
        self.assertEqual(b['state'], 'ready')

    def test_running_card_elapsed_is_live_and_unknown_tokens_stay_unknown(self):
        self.registry.register(self.run)
        self.write('a.json', {'state': 'running', 'pid': os.getpid(), 'started_at': self.created})
        a = self.registry.read_runs()[0]['cards'][0]
        self.assertEqual(a['state'], 'running')
        self.assertGreaterEqual(a['seconds'], 90)
        self.assertIsNone(a['tokens'])

    def test_broken_run_and_partial_registry_line_do_not_hide_other_runs(self):
        self.registry.register(self.run)
        broken = self.root / 'broken'
        broken.mkdir()
        self.registry.register(broken, '损坏运行')
        with (self.home / 'lead-runs.jsonl').open('a') as stream:
            stream.write('{"dir":')
        rows = self.registry.read_runs()
        self.assertEqual(len(rows), 2)
        self.assertEqual(next(r for r in rows if r['dir'] == str(self.run))['status'], 'available')
        self.assertEqual(next(r for r in rows if r['dir'] == str(broken))['status'], 'error')

    def test_empty_list_does_not_create_registry_and_cli_uses_same_rows(self):
        self.assertEqual(self.registry.read_runs(), [])
        self.assertFalse(self.home.exists())
        self.registry.register(self.run)
        result = subprocess.run([sys.executable, '-B', str(HERE / 'runs_registry.py'), 'list'],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        for text in ('检查负责人运行', str(self.run), '可派', '等待依赖', '未知'):
            self.assertIn(text, result.stdout)

    def test_worker_run_registers_once_with_fake_codex(self):
        from test_worker import FAKE_CODEX
        fake = self.root / 'fake-codex'
        fake.write_text(FAKE_CODEX)
        fake.chmod(0o755)
        env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.root / 'calls.jsonl')}
        for _ in range(2):
            result = subprocess.run([sys.executable, '-B', str(HERE / 'worker.py'), 'run', str(self.run),
                                     '--cwd', str(self.root), '--goal', '假执行者运行'],
                                    env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            subprocess.run([sys.executable, '-B', str(HERE / 'worker.py'), 'wait', str(self.run), '--minutes', '0.5'],
                           env=env, capture_output=True, text=True, timeout=60, check=True)
        records = (self.home / 'lead-runs.jsonl').read_text().splitlines()
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0])['goal'], '假执行者运行')


if __name__ == '__main__':
    unittest.main()
