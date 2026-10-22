"""第四轮：真实归档竞争、看守心跳、链接环与目录大小写别名；只用假 Codex。"""
from contextlib import contextmanager
import datetime as dt
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX, WORKER


def case_insensitive_tempfs():
    with tempfile.TemporaryDirectory(prefix='lead-case-probe-') as temporary:
        root = Path(temporary) / 'Current'
        root.mkdir()
        alias = root.with_name(root.name.swapcase())
        return alias.exists() and alias.samefile(root)


CASE_INSENSITIVE_TEMPFS = case_insensitive_tempfs()


class R4FixTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r4fix-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'Current'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake),
                    'CREW_HOME': str(self.tmp / 'registry'), 'CODEX_HOME': str(self.tmp / 'codex-home'),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'PYTHONDONTWRITEBYTECODE': '1'}
        environment = mock.patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)
        self.addCleanup(self.stop_owned)

    def card(self, name, body):
        (self.root / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=60)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def until(self, predicate):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.01)
        self.fail('真实文件或假执行者未到达预期状态')

    def stop_owned(self):
        for path in (self.root / 'cards').glob('*.md'):
            receipt = self.run.receipt(path.stem) or {}
            if receipt.get('executor_pid') and receipt.get('state') in worker.ACTIVE_STATES:
                self.ok('stop', self.root, path.stem)
                self.until(lambda: self.run.receipt(path.stem)['state'] not in worker.ACTIVE_STATES)

    @contextmanager
    def archive_during_read(self, occurrence):
        self.card('a', '重试交付')
        worker.write_json(self.root / 'a.json', {'state': 'failed', 'attempt_id': 'old-attempt'})
        (self.root / 'a.out').write_text('旧交付', encoding='utf-8')
        archived = self.tmp / 'archived'
        release = self.tmp / 'release'
        # 子进程走真正 --retry，仅在 archive 已改名、新回执尚未发布的窗口暂停。
        script = '''
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import worker
archive = worker.Run.archive
def pause(run, name):
    archive(run, name)
    Path(sys.argv[4]).touch()
    deadline = time.monotonic() + 60
    while not Path(sys.argv[5]).exists():
        if time.monotonic() >= deadline:
            raise RuntimeError('测试未放行归档')
        time.sleep(.01)
worker.Run.archive = pause
sys.exit(worker.main(['run', sys.argv[2], '--cwd', sys.argv[3], '--retry', 'a', '--seconds', '30']))
'''
        original = Path.is_file
        seen, processes = [], []

        def probe(path):
            exists = original(path)
            if path == self.root / 'a.json':
                seen.append(exists)
                if len(seen) == occurrence:
                    self.assertTrue(exists, '须在存在性检查通过后才触发归档')
                    processes.append(subprocess.Popen(
                        [sys.executable, '-B', '-c', script, str(WORKER.parent), str(self.root),
                         str(self.tmp), str(archived), str(release)], env=self.env,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
                    self.until(archived.exists)
                    self.assertFalse((self.root / 'a.json').exists())
                    history = list((self.root / 'history').glob('a-*.json'))
                    self.assertEqual(len(history), 1)
                    self.assertEqual(worker.read_json(history[0])['attempt_id'], 'old-attempt')
            return exists

        try:
            with mock.patch.object(Path, 'is_file', probe):
                yield
        finally:
            release.touch()
            for process in processes:
                stdout, stderr = process.communicate(timeout=60)
                self.assertEqual(process.returncode, 0, stdout + stderr)
                self.until(lambda: (self.run.receipt('a') or {}).get('state') == 'finished')
        self.assertTrue(processes, '必须实际触发跨进程改名')

    def test_g1_first_receipt_read_survives_real_retry_archive(self):
        with self.archive_during_read(1):
            self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertEqual(self.run.wait(2), ['a'])
        self.assertEqual(worker.read_json(self.root / '.wait.json')['a'][0],
                         self.run.receipt('a')['attempt_id'])

    def test_g1_state_reread_survives_real_retry_archive(self):
        with self.archive_during_read(2):
            self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertEqual(self.run.wait(2), ['a'])
        self.assertNotEqual(worker.read_json(self.root / '.wait.json')['a'][0], 'old-attempt')

    def test_g1_wait_result_survives_real_retry_archive(self):
        with self.archive_during_read(2):
            self.assertEqual(worker.wait_result(self.run, [])['fresh'], [])
        self.assertEqual(self.run.state('a', self.run.cards()), 'delivered')

    def test_g2_real_guard_heartbeat_during_slow_read_still_notifies_once(self):
        self.card('a', 'SLEEP')
        self.ok('run', self.root, '--cwd', self.tmp, '--seconds', '60',
                '--heartbeat-seconds', '.05', '--stall-minutes', '.001')
        self.until(lambda: (self.run.receipt('a') or {}).get('state') == 'stalled')
        original = self.run.state
        changes = []

        def slow_state(name, cards):
            state = original(name, cards)
            before = self.run.receipt(name)
            self.until(lambda: self.run.receipt(name)['heartbeat']['at'] != before['heartbeat']['at'])
            after = self.run.receipt(name)
            self.assertEqual(before['attempt_id'], after['attempt_id'])
            self.assertEqual(before['heartbeat']['log_mtime'], after['heartbeat']['log_mtime'])
            self.assertEqual(after['state'], 'stalled')
            changes.append((before['heartbeat']['at'], after['heartbeat']['at']))
            return state

        with mock.patch.object(self.run, 'state', side_effect=slow_state):
            self.assertEqual(self.run.wait(1), ['a'], '真实看守更新心跳不能持续压掉停滞通知')
            self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertGreaterEqual(len(changes), 2)
        self.assertTrue((self.tmp / 'calls.jsonl').is_file(), '必须实际启动假 Codex')

    def stalled_receipt(self, state='stalled'):
        self.card('a', '停滞场景')
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        receipt = {'state': state, 'attempt_id': 'current-attempt', 'pid': os.getpid(),
                   'started_at': old, 'heartbeat_seconds': .05,
                   'heartbeat': {'at': old, 'log_mtime': old, 'tokens': 1}}
        worker.write_json(self.root / 'a.json', receipt)
        return receipt

    def poll_after_change(self, receipt):
        original = self.run.state

        def change(name, cards):
            state = original(name, cards)
            worker.write_json(self.root / f'{name}.json', receipt)
            return state

        with mock.patch.object(self.run, 'state', side_effect=change):
            return worker.poll_wait(self.run)

    def test_g2_usage_and_heartbeat_only_changes_do_not_suppress_notice(self):
        receipt = self.stalled_receipt()
        receipt['heartbeat'].update(at=worker.now(), tokens=2, tokens_session=20)
        receipt.update(tokens=2, tokens_session=20)
        self.assertEqual(self.poll_after_change(receipt), (['a'], True))
        self.assertEqual(worker.poll_wait(self.run), ([], True))

    def test_g2_new_attempt_same_stall_cannot_receive_old_notice(self):
        receipt = self.stalled_receipt()
        receipt['attempt_id'] = 'new-attempt'
        self.assertEqual(self.poll_after_change(receipt), ([], True))
        self.assertFalse((self.root / '.wait.json').exists())
        self.assertEqual(worker.poll_wait(self.run), (['a'], True))
        self.assertEqual(worker.read_json(self.root / '.wait.json')['a'][0], 'new-attempt')

    def test_g2_output_recovery_and_new_stall_evidence_invalidate_snapshot(self):
        for state in ('running', 'stalled'):
            with self.subTest(state=state):
                receipt = self.stalled_receipt()
                receipt['state'] = state
                receipt['heartbeat'].update(at=worker.now(), log_mtime=worker.now())
                self.assertEqual(self.poll_after_change(receipt), ([], True))
                self.assertFalse((self.root / '.wait.json').exists())

    def test_g2_heartbeat_recovery_invalidates_derived_stall(self):
        receipt = self.stalled_receipt('running')
        receipt['heartbeat']['at'] = worker.now()
        self.assertEqual(self.poll_after_change(receipt), ([], True))
        self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertFalse((self.root / '.wait.json').exists())

    def test_g2_terminal_status_change_invalidates_snapshot(self):
        self.card('a', '终态变化')
        for changed in ({'review': {'verdict': 'accepted'}}, {'result': {'status': 'blocked'}}):
            with self.subTest(changed=changed):
                receipt = {'state': 'finished', 'attempt_id': 'same-attempt'}
                worker.write_json(self.root / 'a.json', receipt)
                receipt.update(changed)
                self.assertEqual(self.poll_after_change(receipt), ([], True))
                self.assertFalse((self.root / '.wait.json').exists())

    def make_loop(self):
        loop = self.tmp / 'loop'
        loop.symlink_to('loop', target_is_directory=True)
        self.card('blocked', '依赖：../loop/a\n等待外部')
        self.card('free', '独立交付')
        return loop

    def assert_unreadable(self):
        rows = {row['card']: row for row in self.run.status()['cards']}
        self.assertEqual(rows['blocked']['state'], 'waiting')
        self.assertIn('外部依赖暂不可读', rows['blocked']['waiting_reason'])
        self.assertIs(rows['blocked']['external_deps'][0]['accepted_valid'], False)
        return rows

    def test_g3_real_symlink_loop_waits_without_blocking_other_card(self):
        self.make_loop()
        self.assertEqual(self.assert_unreadable()['free']['state'], 'ready')
        result = self.ok('run', self.root, '--cwd', self.tmp, '--seconds', '30')
        self.assertEqual(result['dispatched'], ['free'])
        self.until(lambda: (self.run.receipt('free') or {}).get('state') == 'finished')
        self.assertEqual(self.assert_unreadable()['free']['state'], 'delivered')

    def test_g3_runtimeerror_at_both_resolve_boundaries_is_isolated(self):
        loop = self.make_loop()
        original = Path.resolve

        def legacy_resolve(path, *args, **kwargs):
            if path.name == 'a' and path.parent.name == loop.name:
                raise RuntimeError('Symlink loop from fixture')
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', legacy_resolve):
            with self.subTest(boundary='dependencies'):
                self.assertEqual(self.run.dependencies('依赖：../loop/a'), ['../loop/a'])
            with self.subTest(boundary='dependency'):
                info = self.run.dependency('../loop/a', {})
                self.assertIs(info['accepted_valid'], False)
                self.assertIn('外部依赖暂不可读', info['reason'])
            with self.subTest(boundary='status'):
                self.assertEqual(self.assert_unreadable()['free']['state'], 'ready')

    def case_alias(self):
        alias = self.root.with_name(self.root.name.swapcase())
        if not alias.exists() or not alias.samefile(self.root):
            self.skipTest('当前临时文件系统区分大小写，无法真实复现同目录大小写别名')
        return alias

    @unittest.skipUnless(CASE_INSENSITIVE_TEMPFS, '需要临时文件系统支持同目录的大小写别名')
    def test_g4_case_alias_rejects_self_missing_and_cycle(self):
        alias = self.case_alias()
        for target, reason in (('a', '依赖的 a 不在 cards/'),
                               ('missing', '依赖的 missing 不在 cards/'), ('b', '任务卡依赖循环')):
            with self.subTest(target=target):
                self.card('a', f'依赖：{alias}/{target}\n任务 A')
                self.card('b', '依赖：a\n任务 B')
                for action in ('run', 'status'):
                    result = self.cli(action, self.root)
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn(reason, result.stderr)
        self.assertFalse((self.tmp / 'calls.jsonl').exists())

    @unittest.skipUnless(CASE_INSENSITIVE_TEMPFS, '需要临时文件系统支持同目录的大小写别名')
    def test_g4_case_alias_acceptance_advances_local_downstream(self):
        alias = self.case_alias()
        self.card('a', '上游交付')
        self.card('b', f'依赖：{alias}/a\n下游交付')
        self.assertEqual(self.run.cards()['b']['deps'], ['a'])
        self.assertEqual(self.ok('run', self.root, '--cwd', self.tmp, '--seconds', '30')['dispatched'], ['a'])
        self.until(lambda: (self.run.receipt('a') or {}).get('state') == 'finished')
        self.assertEqual(self.ok('accept', self.root, 'a', '--note', '已读交付')['dispatched'], ['b'])
        self.until(lambda: (self.run.receipt('b') or {}).get('state') == 'finished')
        self.assertNotIn('external_deps', next(row for row in self.run.status()['cards'] if row['card'] == 'b'))

    @unittest.skipUnless(CASE_INSENSITIVE_TEMPFS, '需要临时文件系统支持同目录的大小写别名')
    def test_g4_samefile_probe_failure_keeps_dependency_external(self):
        alias = self.case_alias()
        self.card('a', '上游')
        self.card('b', f'依赖：{alias}/a\n下游')
        original = Path.samefile

        def denied(path, other):
            if path.name == alias.name:
                raise PermissionError(errno.EACCES, '目录身份暂不可读')
            return original(path, other)

        with mock.patch.object(Path, 'samefile', denied):
            self.assertEqual(self.run.cards()['b']['deps'], [str(alias / 'a')])
            row = next(row for row in self.run.status()['cards'] if row['card'] == 'b')
            self.assertEqual(row['state'], 'waiting')
            self.assertIs(row['external_deps'][0]['accepted_valid'], False)


if __name__ == '__main__':
    unittest.main()
