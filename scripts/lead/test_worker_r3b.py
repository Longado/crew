"""第三轮修复 B：点名未派出须反馈，轮询不能饿死心跳；只用假 Codex。"""
import json
import fcntl
from contextlib import contextmanager
import threading
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


class R3BCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r3b-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'CREW_HOME': str(self.tmp / 'registry'),
                    'CODEX_HOME': str(self.tmp / 'codex-home'), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        environment = mock.patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)
        self.addCleanup(self.stop_owned)

    def card(self, name, body, root=None):
        ((root or self.root) / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=60)

    def start(self, *args):
        return self.cli('run', self.root, '--cwd', self.tmp, '--seconds', '30', *args)

    def until(self, predicate):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.02)
        self.fail('假执行者未到达预期状态')

    def stop_owned(self):
        for name in self.run.cards():
            receipt = self.run.receipt(name) or {}
            if receipt.get('state') in worker.ACTIVE_STATES and worker.alive(receipt.get('pid')):
                result = self.cli('stop', self.root, name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.until(lambda: self.run.receipt(name)['state'] not in worker.ACTIVE_STATES)

    def failed(self, name):
        worker.write_json(self.root / f'{name}.json', {'state': 'failed', 'attempt_id': f'old-{name}'})
        (self.root / f'{name}.out').write_text('保留旧交付', encoding='utf-8')


class ExplicitDispatchTest(R3BCase):
    def assert_deferred(self, result, name, *reasons):
        data = json.loads(result.stdout)
        rows = [row for row in data['deferred'] if row['card'] == name]
        self.assertEqual(len(rows), 1, data)
        for reason in reasons:
            self.assertIn(reason, rows[0]['reason'])
            self.assertIn(reason, result.stderr)
        return data

    def test_b1_retry_local_dependency_reports_state_without_archiving(self):
        self.card('a', '上游')
        self.card('b', '依赖：a\n下游')
        self.failed('a')
        self.failed('b')
        before = (self.root / 'b.json').read_bytes()
        result = self.start('--retry', 'b')
        data = self.assert_deferred(result, 'b', 'a', 'failed')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data['dispatched'], [])
        self.assertEqual((self.root / 'b.json').read_bytes(), before)
        self.assertEqual((self.root / 'b.out').read_text(), '保留旧交付')
        self.assertFalse((self.root / 'history').exists())

    def test_b1_retry_external_missing_and_unaccepted_dependencies_report_reasons(self):
        upstream = self.tmp / 'upstream'
        (upstream / 'cards').mkdir(parents=True)
        self.card('a', '外部上游', upstream)
        worker.write_json(upstream / 'a.json', {'state': 'finished'})
        for dep, reason in (('../absent/a', '目录不存在'), ('../upstream/missing', '卡不存在'),
                            ('../upstream/a', 'delivered'), (str(upstream / 'a'), 'delivered')):
            with self.subTest(dep=dep):
                self.card('b', f'依赖：{dep}\n下游')
                self.failed('b')
                result = self.start('--retry', 'b')
                self.assert_deferred(result, 'b', reason)
                self.assertEqual(result.returncode, 2)
                self.assertFalse((self.root / 'history').exists())

    def test_b1_ordinary_waiting_cards_remain_quiet(self):
        self.card('a', '上游')
        self.failed('a')
        self.card('b', '依赖：a\n下游')
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['dispatched'], [])
        self.assertEqual(data['deferred'], [])
        self.assertEqual(result.stderr, '')

    def test_b1_only_names_waiting_terminal_and_unknown_cards_are_not_silent(self):
        self.card('a', '上游')
        self.failed('a')
        self.card('b', '依赖：a\n下游')
        for name, reason in (('b', 'a'), ('a', 'failed'), ('missing', '没有这张卡')):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.run.run(self.tmp, 8, None, None, [], only=[name])
                self.assertEqual([row['card'] for row in self.run.deferred], [name])
                self.assertIn(reason, self.run.deferred[0]['reason'])

    def test_b2_missing_write_permission_requires_action_even_without_retry(self):
        self.card('write', '可写：result.txt\n任务')
        result = self.start()
        data = self.assert_deferred(result, 'write', '--write')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(data['dispatched'], [])
        self.assertFalse((self.root / 'write.json').exists())
        self.assertFalse((self.root / 'baseline.json').exists())

    def test_b2_successful_dispatch_still_prints_write_and_dependency_reasons(self):
        self.card('a', '上游')
        self.failed('a')
        self.card('b', '依赖：a\n下游')
        self.failed('b')
        self.card('free', '独立任务')
        self.card('write', '可写：result.txt\n任务')
        result = self.start('--retry', 'b')
        data = self.assert_deferred(result, 'b', 'a', 'failed')
        self.assert_deferred(result, 'write', '--write')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(data['dispatched'], ['free'])
        self.until(lambda: self.run.receipt('free')['state'] not in worker.ACTIVE_STATES)

    def test_b2_capacity_queue_alone_keeps_success_exit_and_quiet_stderr(self):
        self.card('busy', 'SLEEP')
        result = self.start('--max-parallel', '1', '--heartbeat-seconds', '.1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.until(lambda: bool(self.run.receipt('busy').get('heartbeat', {}).get('log_bytes')))
        self.card('queued', '等待空位')
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data['dispatched'], [])
        self.assertEqual([row['card'] for row in data['deferred']], ['queued'])
        self.assertIn('并发上限', data['deferred'][0]['reason'])
        self.assertEqual(result.stderr, '')


class HeartbeatPollingTest(R3BCase):
    def test_b3_heartbeat_retries_after_real_flock_collision_under_fast_polling(self):
        self.card('busy', '假执行者持续输出')
        prompt = self.root / 'busy.prompt'
        prompt.write_text('SLEEP')
        Path(self.env['CREW_CODEX_BIN']).write_text(FAKE_CODEX.replace(
            'time.sleep(60)', "while True:\n        print('working', flush=True)\n        time.sleep(.02)"))
        worker.write_json(self.root / 'busy.json', {
            'state': 'running', 'attempt_id': 'attempt-b3', 'started_at': worker.now(),
            'heartbeat': {'at': worker.now()}, 'heartbeat_seconds': .6,
            'cwd': str(self.tmp), 'prompt': str(prompt),
            'log': str(self.root / 'busy.log'), 'output': str(self.root / 'busy.out'),
            'stall_seconds': 30})
        original_lock = worker.Run.lock
        denied = []
        errors = []

        @contextmanager
        def collision(run, blocking=False, name='.lock'):
            # 只在看守完整周期后的首次请求占锁；短重试有窗口，整周期退避会一直撞锁。
            if not blocking and threading.current_thread() is guard_thread:
                stamp = time.monotonic()
                if not denied or stamp - denied[-1] >= .45:
                    denied.append(stamp)
                    with (run.root / name).open('a') as held:
                        fcntl.flock(held, fcntl.LOCK_EX)
                        with original_lock(run, blocking=False, name=name):
                            yield
                    return
            with original_lock(run, blocking=blocking, name=name):
                yield

        def execute():
            try:
                worker.guard(self.root, 'busy', 3.3,
                             [self.env['CREW_CODEX_BIN'], 'exec', '-o', str(self.root / 'busy.out')],
                             'attempt-b3', .6)
            except BaseException as exc:
                errors.append(exc)

        guard_thread = threading.Thread(target=execute)
        samples = []
        notices = []
        with mock.patch.object(worker.Run, 'lock', collision):
            guard_thread.start()
            try:
                deadline = time.monotonic() + 2.8
                while time.monotonic() < deadline:
                    fresh, _ = worker.poll_wait(self.run)
                    notices.extend(fresh)
                    receipt = self.run.receipt('busy')
                    samples.append((worker.heartbeat_stalled(receipt),
                                    worker.receipt_state(receipt)))
                    time.sleep(.01)
            finally:
                guard_thread.join(30)
        self.assertFalse(guard_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.run.receipt('busy')['state'], 'timed_out')
        self.assertIsNone(self.run.receipt('busy')['error'])
        self.assertGreaterEqual(len(denied), 3)
        self.assertGreater((self.root / 'busy.log').stat().st_size, 100)
        self.assertFalse(any(expired for expired, _ in samples),
                         '持续输出时心跳因整周期退避超过真实 2 秒容忍窗')
        self.assertTrue(all(state == 'running' for _, state in samples), samples[-10:])
        self.assertEqual(notices, [], '持续输出不应发 stalled 通知')

    def test_b3_poll_reads_outside_lock_and_deduplicates_current_attempt_inside(self):
        self.card('done', '交付')
        self.failed('done')

        def locked():
            with (self.root / '.lock').open('a') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return True
            return False

        for method in ('cards', 'state'):
            with self.subTest(slow_read=method):
                observations = []
                original = getattr(self.run, method)
                def read(*args, _original=original):
                    observations.append(locked())
                    time.sleep(.01)
                    return _original(*args)
                with mock.patch.object(self.run, method, side_effect=read):
                    worker.poll_wait(self.run)
                self.assertTrue(observations)
                self.assertFalse(any(observations), method + '慢读不应持调度锁')

        with self.subTest(slow_read='accepted_valid'):
            receipt = {'state': 'finished', 'attempt_id': 'accepted',
                       'review': {'verdict': 'accepted'}}
            worker.write_json(self.root / 'done.json', receipt)
            observations = []
            def acceptance(*args):
                observations.append(locked())
                time.sleep(.01)
                return True
            with mock.patch.object(worker, 'accepted_valid', side_effect=acceptance):
                worker.poll_wait(self.run)
            self.assertTrue(observations)
            self.assertFalse(any(observations), '验收读不应持调度锁')

        with self.subTest(race='attempt_replaced_during_state_read'):
            self.failed('done')
            (self.root / '.wait.json').unlink(missing_ok=True)
            original = self.run.state
            def replace_attempt(name, cards):
                old_state = original(name, cards)
                worker.write_json(self.root / 'done.json', {
                    'state': 'running', 'attempt_id': 'new-attempt', 'started_at': worker.now()})
                return old_state
            with mock.patch.object(self.run, 'state', side_effect=replace_attempt):
                fresh, active = worker.poll_wait(self.run)
            self.assertEqual(fresh, [], '旧 failed 不能以新 attempt 身份发通知')
            self.assertTrue(active)

        with self.subTest(notification='deduplicated_under_lock'):
            self.failed('done')
            (self.root / '.wait.json').unlink(missing_ok=True)
            original_write = worker.write_json
            writes = []
            def write(path, value):
                if Path(path).name == '.wait.json':
                    writes.append(locked())
                return original_write(path, value)
            with mock.patch.object(worker, 'write_json', side_effect=write):
                self.assertEqual(worker.poll_wait(self.run)[0], ['done'])
                self.assertEqual(worker.poll_wait(self.run)[0], [])
            self.assertEqual(writes, [True])
            self.assertEqual(worker.read_json(self.root / '.wait.json')['done'][:2],
                             ['old-done', 'failed'])


if __name__ == '__main__':
    unittest.main()
