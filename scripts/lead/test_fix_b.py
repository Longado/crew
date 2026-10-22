"""修复 B：旧统计迁移、登记容错、巡检兼容与隔离回归入口。"""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import notes
import runs_registry as registry
import stats
import test_stats as fixtures
from test_worker import FAKE_CODEX, WORKER

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


class FixBStatsTests(unittest.TestCase):
    setUp = fixtures.StatsTest.setUp
    write = fixtures.StatsTest.write
    log = fixtures.StatsTest.log
    card = fixtures.StatsTest.card
    receipt = fixtures.StatsTest.receipt
    cli = fixtures.StatsTest.cli
    metrics = fixtures.StatsTest.metrics
    fixture = fixtures.StatsTest.fixture

    def legacy_pair(self, revision='414f05a'):
        # 执行固定的真实旧生成器，源码包运行不依赖 Git 历史。
        fixture_dir = HERE / 'fixtures' / 'legacy_stats' / revision
        source = (fixture_dir / 'stats.py').read_text()
        legacy = {'__name__': 'legacy_stats_fixture'}
        dependency = fixture_dir / 'acceptance.py'
        modules = {}
        if dependency.is_file():
            acceptance = types.ModuleType('acceptance')
            exec(compile(dependency.read_text(), str(dependency), 'exec'), acceptance.__dict__)
            modules['acceptance'] = acceptance
        with mock.patch.dict(sys.modules, modules):
            exec(compile(source, str(fixture_dir / 'stats.py'), 'exec'), legacy)
        self.fixture()
        self.card('waiting', ('draft',))
        self.card('unfinished')
        self.receipt('unfinished', 0, None, state='running', history=True)
        with mock.patch.dict(os.environ, self.env):
            metrics = legacy['summarize_crew'](self.run)
        self.write(self.run / 'metrics.json', metrics)
        (self.run / 'summary.md').write_text(legacy['render_crew'](metrics))

    def test_b1_baseline_pair_refreshes_in_place(self):
        self.legacy_pair()
        before = (self.run / 'summary.md').read_text()
        metrics = self.metrics(self.run)
        self.assertIn('当前仍有效', (self.run / 'summary.md').read_text())
        self.assertNotEqual(before, (self.run / 'summary.md').read_text())
        self.assertEqual(metrics, self.metrics(self.run))

    def test_b1_second_round_pair_also_refreshes(self):
        self.legacy_pair('982ff82')
        metrics = self.metrics(self.run)
        self.assertEqual(len(metrics['attempts']), 5)

    def test_b1_manual_summary_and_metrics_are_preserved(self):
        for edited in ('summary.md', 'metrics.json'):
            with self.subTest(edited=edited):
                self.legacy_pair()
                path = self.run / edited
                if edited.endswith('.md'):
                    path.write_text(path.read_text() + '\n人工备注\n')
                else:
                    metrics = json.loads(path.read_text())
                    metrics['receipt_tokens'] += 1
                    self.write(path, metrics)
                before = {p.name: p.read_bytes() for p in self.run.glob('*') if p.is_file()}
                result = self.cli(self.run)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('冲突', result.stderr)
                self.assertEqual(before, {p.name: p.read_bytes() for p in self.run.glob('*') if p.is_file()})

    def test_b7_attempt_copies_and_heartbeats_are_not_extra_attempts(self):
        for name, state, start, end, tokens in (
                ('stopped', 'stopped', 0, 10, 7),
                ('stalled', 'stalled', 20, None, None),
                ('lost', 'lost', 30, None, 11),
                ('done', 'finished', 50, 60, 13)):
            self.card(name)
            path = self.receipt(name, start, end, state=state, tokens=tokens, session='fixture-' + name)
            receipt = json.loads(path.read_text())
            receipt.update(attempt_id='attempt-' + name,
                           heartbeat={'at': fixtures.at(90), 'log_mtime': fixtures.at(55),
                                      'tokens': 999, 'tokens_session': 9999, 'last_output': '进度'})
            self.write(path, receipt)
            self.write(self.run / '.attempts' / receipt['attempt_id'] / path.name, receipt)
        metrics = self.metrics(self.run)
        self.assertEqual(len(metrics['attempts']), 4)
        self.assertEqual(metrics['receipt_tokens'], 31)
        self.assertEqual(metrics['wall_seconds'], 60)
        self.assertEqual(metrics['worker_active_sum_seconds'], 60)
        self.assertEqual(metrics['peak_active_workers'], 2)
        lost = next(a for a in metrics['attempts'] if a['card'] == 'lost')
        self.assertTrue(lost['end_unknown'])
        self.assertIsNone(lost['usage'])
        before = {str(p): p.read_bytes() for p in self.run.rglob('*') if p.is_file()}
        source = notes.run_source(self.run)
        self.assertEqual(source.count('卡名:'), 4)
        self.assertNotIn('.attempts', source)
        self.assertNotIn('9999', source)
        note = notes.new(self.tmp / 'notes', 'fixture', 'inspect', '巡检兼容', run=self.run)
        self.assertIn('metrics.json', note.read_text())
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.run.rglob('*') if p.is_file()})


class FixBRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.run = self.root / 'run'
        (self.run / 'cards').mkdir(parents=True)
        self.home = self.root / 'crew-home'
        env = mock.patch.dict(os.environ, CREW_HOME=str(self.home), CREW_CODEX_BIN='/usr/bin/false')
        env.start()
        self.addCleanup(env.stop)
        self.started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=120)).isoformat()
        self.write(self.run / 'run.json', {'created_at': self.started, 'goal': '正常运行'})
        (self.run / 'cards/a.md').write_text('任务')

    def write(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False))

    def test_b2_registry_io_failure_warns_and_returns(self):
        self.home.write_text('不能作为目录')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            try:
                registry.register(self.run)
            except OSError as error:
                self.fail('登记异常不应传给派发入口：' + str(error))
        self.assertIn('本次未登记', stderr.getvalue())
        self.assertEqual(self.home.read_text(), '不能作为目录')

    def test_b2_unwritable_registry_does_not_block_fake_retry(self):
        self.home.mkdir()
        (self.home / 'lead-runs.jsonl').mkdir()
        fake = self.root / 'fake-codex'
        fake.write_text(FAKE_CODEX)
        fake.chmod(0o755)
        env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.root / 'calls.jsonl'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        for retry in (False, True):
            args = ['run', str(self.run), '--cwd', str(self.root)]
            if retry:
                rejected = subprocess.run([sys.executable, '-B', str(WORKER), 'reject', str(self.run),
                                           'a', '--note', '重试'], env=env, capture_output=True, text=True)
                self.assertEqual(rejected.returncode, 0, rejected.stderr)
                args += ['--retry', 'a']
            result = subprocess.run([sys.executable, '-B', str(WORKER), *args], env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('本次未登记', result.stderr)
            subprocess.run([sys.executable, '-B', str(WORKER), 'wait', str(self.run), '--minutes', '.5'],
                           env=env, capture_output=True, timeout=60, check=True)
            self.assertEqual(json.loads((self.run / 'a.json').read_text())['state'], 'finished')
        self.assertEqual(len((self.root / 'calls.jsonl').read_text().splitlines()), 2)

    def test_b2_permission_denied_keeps_existing_registry(self):
        registry.register(self.run)
        path = self.home / 'lead-runs.jsonl'
        before = path.read_bytes()
        stderr = io.StringIO()
        with mock.patch.object(Path, 'open', side_effect=PermissionError('登记文件不可写')), \
                contextlib.redirect_stderr(stderr):
            registry.register(self.root / 'another-run')
        self.assertIn('本次未登记', stderr.getvalue())
        self.assertEqual(path.read_bytes(), before)

    def test_b3_bad_structures_only_mark_their_run(self):
        registry.register(self.run)
        broken = self.root / 'broken'
        (broken / 'cards').mkdir(parents=True)
        (broken / 'cards/a.md').write_text('任务')
        registry.register(broken, '损坏运行')
        moved = self.root / 'moved'
        registry.register(moved, '移走运行')
        for target, value in (('run.json', [{}]), ('run.json', []), ('run.json', None),
                              ('a.json', [{}]), ('a.json', []),
                              ('a.json', {'state': 'finished', 'review': [{}]}),
                              ('a.json', {'state': 'running', 'heartbeat': [{}]})):
            with self.subTest(target=target, value=value):
                self.write(broken / 'run.json', {})
                self.write(broken / 'a.json', {'state': 'finished'})
                self.write(broken / target, value)
                try:
                    rows = {Path(row['dir']).name: row for row in registry.read_runs()}
                except (AttributeError, TypeError, KeyError) as error:
                    self.fail('单个坏运行中断了整个列表：' + str(error))
                self.assertEqual(rows['run']['status'], 'available')
                self.assertEqual(rows['broken']['status'], 'error')
                self.assertEqual(rows['moved']['status'], 'moved')
                with contextlib.redirect_stdout(io.StringIO()):
                    registry.print_runs(list(rows.values()))

    def test_b4_live_progress_uses_output_time_and_heartbeat_tokens(self):
        registry.register(self.run)
        heartbeat = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'log_mtime': self.started,
                     'tokens': 1234, 'tokens_session': 9999, 'last_output': '正在处理 <样本>'}
        for state in ('running', 'stalled', 'lost', 'stopped'):
            with self.subTest(state=state):
                self.write(self.run / 'a.json', {'state': state, 'pid': os.getpid(), 'started_at': self.started,
                                               'heartbeat': heartbeat, 'output': str(self.run / 'a.out')})
                card = registry.read_runs()[0]['cards'][0]
                self.assertEqual(card['state'], state)
                self.assertEqual(card['tokens'], 1234)
                self.assertEqual(card['last_output'], '正在处理 <样本>')
                if state in ('running', 'stalled'):
                    self.assertGreaterEqual(card['seconds'], 120)
                    self.assertGreaterEqual(card['idle_seconds'], 120)
                    self.assertEqual(card['conclusion'], '')
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        registry.print_runs(registry.read_runs())
                    self.assertIn('最后动静距今', output.getvalue())
                    self.assertIn('正在处理 <样本>', output.getvalue())
                    self.assertNotIn('stalled', output.getvalue())
                else:
                    self.assertIsNone(card['seconds'])

    def test_b4_old_receipt_tokens_and_missing_activity_stay_compatible(self):
        registry.register(self.run)
        self.write(self.run / 'a.json', {'state': 'stalled', 'pid': os.getpid(), 'started_at': self.started,
                                       'tokens': 23, 'heartbeat': {'tokens': None}})
        card = registry.read_runs()[0]['cards'][0]
        self.assertEqual(card['tokens'], 23)
        self.assertGreaterEqual(card['idle_seconds'], 120)


class FixBTestEntryTests(unittest.TestCase):
    def test_b6_runner_isolates_children_defaults_to_deny_and_propagates_failure(self):
        path = HERE / 'run_tests.py'
        self.assertTrue(path.is_file(), '缺少统一隔离回归入口')
        spec = importlib.util.spec_from_file_location('lead_test_entry', path)
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        calls = []
        real_run = subprocess.run

        def run(command, *, env, cwd):
            self.assertNotEqual(env['CREW_HOME'], '/inherited/registry')
            self.assertTrue(Path(env['CREW_HOME']).is_dir())
            self.assertEqual(env['PYTHONDONTWRITEBYTECODE'], '1')
            self.assertEqual(Path(cwd), ROOT)
            # 真子进程读取环境并试运行拒绝程序，不调用模型。
            probe = real_run([sys.executable, '-B', '-c',
                'import os,subprocess; print(os.environ["CREW_HOME"]); '
                'print(subprocess.call([os.environ["CREW_CODEX_BIN"], "exec"]))'],
                env=env, text=True, capture_output=True, check=True).stdout
            self.assertIn(env['CREW_HOME'], probe)
            self.assertNotEqual(probe.splitlines()[-1], '0')
            calls.append((command, env['CREW_HOME']))
            return subprocess.CompletedProcess(command, 7 if len(calls) == 2 else 0)

        with mock.patch.dict(os.environ, {'CREW_HOME': '/inherited/registry'}, clear=True), \
                mock.patch.object(entry.subprocess, 'run', side_effect=run):
            self.assertNotEqual(entry.main(), 0)
        self.assertEqual(len(calls), 4)
        self.assertTrue(any('discover' in command and 'test_*.py' in command for command, _ in calls))
        for name in ('test_server.py', 'test_lead_runs.py', 'test_fix_b_board.py'):
            self.assertTrue(any(any(str(arg).endswith(name) for arg in command) for command, _ in calls))
        self.assertEqual(len({home for _, home in calls}), 1)
        self.assertFalse(Path(calls[0][1]).exists())

    def test_b6_package_exposes_test_lead(self):
        package = json.loads((ROOT / 'package.json').read_text())
        self.assertEqual(package['scripts'].get('test:lead'), 'python3 scripts/lead/run_tests.py')


if __name__ == '__main__':
    unittest.main()
