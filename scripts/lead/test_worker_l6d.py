"""逐卡派发与短心跳回归；派发仅使用本地假 Codex。"""
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import worker


class HeartbeatFloorTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-l6d-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'cards').mkdir()
        (self.root / 'cards' / 'a.md').write_text('任务')
        self.run = worker.Run(self.root)
        current = dt.datetime.now().astimezone()

        class Clock(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return current if tz is None else current.astimezone(tz)

        clock = mock.patch.object(worker.dt, 'datetime', Clock)
        clock.start()
        self.addCleanup(clock.stop)
        self.current = current

    def receipt(self, age, interval=.04, state='running'):
        stamp = (self.current - dt.timedelta(seconds=age)).isoformat()
        receipt = {'state': state, 'pid': os.getpid(), 'started_at': stamp,
                   'attempt_id': 'fixture-l6d', 'heartbeat_seconds': interval,
                   'heartbeat': {'at': stamp, 'log_mtime': stamp, 'last_output': '处理中'}}
        worker.write_json(self.root / 'a.json', receipt)
        return receipt

    def test_short_heartbeat_scheduling_delay_does_not_notify_or_release_capacity(self):
        receipt = self.receipt(.5)
        self.assertEqual(worker.receipt_state(receipt), 'running')
        self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertTrue(worker.capacity_held(receipt))
        self.assertNotIn('看守停更', worker.progress(receipt)[2])

    def test_short_heartbeat_real_stall_still_notifies_once_and_holds_capacity(self):
        receipt = self.receipt(3)
        self.assertEqual(worker.receipt_state(receipt), 'stalled')
        self.assertEqual(worker.poll_wait(self.run), (['a'], True))
        self.assertEqual(worker.poll_wait(self.run), ([], True))
        self.assertTrue(worker.capacity_held(receipt))
        self.assertIn('看守停更', worker.progress(receipt)[2])

    def test_default_heartbeat_keeps_three_period_threshold(self):
        self.assertFalse(worker.heartbeat_stalled(self.receipt(89, interval=30)))
        self.assertTrue(worker.heartbeat_stalled(self.receipt(91, interval=30)))

    def test_output_stall_is_not_hidden_by_heartbeat_floor(self):
        receipt = self.receipt(.05, state='stalled')
        self.assertEqual(worker.receipt_state(receipt), 'stalled')
        self.assertEqual(worker.poll_wait(self.run), (['a'], True))


class DispatchIsolationTest(unittest.TestCase):
    def setUp(self):
        import test_worker_l6b
        self.case = test_worker_l6b.DispatchL6bTest()
        self.case.setUp()
        self.guards = []
        spawn = worker.subprocess.Popen
        def track(command, *args, **kwargs):
            proc = spawn(command, *args, **kwargs)
            if '_guard' in command:
                self.guards.append(proc)
            return proc
        tracking = mock.patch.object(worker.subprocess, 'Popen', side_effect=track)
        tracking.start()
        self.addCleanup(tracking.stop)
        self.addCleanup(self.reap_guards)
        self.addCleanup(self.case.tearDown)

    def reap_guards(self):
        # 夹具先停止仍活的尝试，再回收本进程启动的看守句柄。
        for proc in self.guards:
            proc.wait(timeout=30)

    def children(self):
        for name in ('b', 'c'):
            self.case.card(name, f'依赖：a\n接续：a\n任务 {name}')
        self.case.card('d', '依赖：a\n独立会话')

    def check_mixed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response['dispatched'], ['b', 'd'])
        self.assertEqual([item['card'] for item in response['deferred']], ['c'])
        self.assertIn('接续', response['deferred'][0]['reason'])
        self.assertIn('c', result.stderr)
        self.assertEqual(self.case.run.receipt('a')['continued_by'], 'b')
        self.assertIsNone(self.case.run.receipt('c'))
        self.assertFalse((self.case.root / 'c.prompt').exists())
        self.case.finish('b')
        self.case.finish('d')

    def test_run_dispatches_valid_siblings_without_spending_rejected_cards_slot(self):
        self.case.accepted()
        self.children()
        self.check_mixed(self.case.cli('run', self.case.root, '--max-parallel', '2'))

    def test_accept_dispatches_valid_siblings_and_keeps_upstream_accepted(self):
        case = self.case
        case.card()
        case.start('--cwd', case.work, '--model', 'fixture-model')
        case.finish()
        self.children()
        self.check_mixed(case.cli('accept', case.root, 'a', '--note', '继续'))
        self.assertEqual(case.run.receipt('a')['review']['verdict'], 'accepted')

    def test_all_rejected_run_lists_every_reason_without_reserving_or_archiving(self):
        case = self.case
        case.accepted()
        original = case.run.receipt('a')
        case.card('b', '依赖：a\n接续：a\n模型：other-model\n任务')
        case.card('c', '依赖：a\n接续：a\n特性：different_feature\n任务')
        result = case.cli('run', case.root)
        self.assertEqual(result.returncode, 2)
        response = json.loads(result.stdout)
        self.assertEqual(response['dispatched'], [])
        self.assertEqual([item['card'] for item in response['deferred']], ['b', 'c'])
        for name in ('b', 'c'):
            self.assertIn('卡 ' + name, result.stderr)
            self.assertIsNone(case.run.receipt(name))
        self.assertEqual(case.run.receipt('a'), original)
        self.assertFalse((case.root / 'history').exists())

    def test_all_rejected_accept_returns_two_but_persists_successful_acceptance(self):
        case = self.case
        case.card()
        case.start('--cwd', case.work, '--model', 'fixture-model')
        case.finish()
        case.card('b', '依赖：a\n接续：a\n模型：other-model\n任务')
        result = case.cli('accept', case.root, 'a', '--note', '上游通过')
        self.assertEqual(result.returncode, 2)
        response = json.loads(result.stdout)
        self.assertEqual(response['verdict'], 'accepted')
        self.assertEqual(response['dispatched'], [])
        self.assertEqual(response['deferred'][0]['card'], 'b')
        self.assertIn('已验收', result.stderr)
        self.assertTrue(Path(case.run.receipt('a')['review']['accepted_output']).is_file())
        self.assertNotIn('continued_by', case.run.receipt('a'))

    def test_unknown_and_accepted_retries_do_not_prevent_a_ready_card(self):
        case = self.case
        case.accepted()
        original = case.run.receipt('a')
        case.card('b', '任务')
        result = case.cli('run', case.root, '--retry', 'missing', '--retry', 'a')
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response['dispatched'], ['b'])
        self.assertEqual([item['card'] for item in response['deferred']], ['missing', 'a'])
        self.assertEqual(case.run.receipt('a'), original)
        self.assertFalse((case.root / 'history').exists())
        case.finish('b')

    def test_bad_continuation_does_not_reserve_upstream_or_consume_capacity(self):
        case = self.case
        case.accepted()
        case.card('b', '依赖：a\n接续：a\n模型：other-model\n任务')
        case.card('c', '依赖：a\n接续：a\n任务')
        result = case.ok('run', case.root, '--max-parallel', '1')
        self.assertEqual(result['dispatched'], ['c'])
        self.assertEqual(result['deferred'][0]['card'], 'b')
        self.assertEqual(case.run.receipt('a')['continued_by'], 'c')
        self.assertIsNone(case.run.receipt('b'))
        case.finish('c')

    def test_changed_retry_is_checked_before_archive_and_other_card_still_runs(self):
        case = self.case
        case.card()
        case.start('--cwd', case.work)
        case.reject()
        saved = {ext: (case.root / ('a.' + ext)).read_bytes() for ext in ('json', 'out', 'log', 'prompt')}
        case.card('b', '任务')
        def changed():
            case.card(body='预检期间改卡')
            return [], []
        with mock.patch.object(worker, 'lean_args', side_effect=changed):
            self.assertEqual(case.run.run(None, None, None, None, ['a']), ['b'])
        self.assertIn('版本已变化', case.run.deferred[0]['reason'])
        self.assertEqual({ext: (case.root / ('a.' + ext)).read_bytes() for ext in saved}, saved)
        self.assertFalse((case.root / 'history').exists())
        case.finish('b')

    def test_changed_dependency_defers_only_its_child(self):
        case = self.case
        case.accepted()
        case.card('b', '依赖：a\n任务')
        case.card('c', '独立任务')
        def changed():
            Path(case.run.receipt('a')['output']).write_text('预检期间修改交付')
            return [], []
        with mock.patch.object(worker, 'lean_args', side_effect=changed):
            self.assertEqual(case.run.run(None, None, None, None, []), ['c'])
        self.assertIn('依赖未验收', case.run.deferred[0]['reason'])
        self.assertIsNone(case.run.receipt('b'))
        case.finish('c')

    def test_feature_that_reenables_mcp_defers_only_its_card(self):
        case = self.case
        case.card('a', '特性：unsafe_feature\n任务')
        case.card('b', '任务')
        with mock.patch.object(worker, 'lean_args', return_value=([], [])), \
                mock.patch.object(worker, 'enabled_mcp', return_value=['fixture-mcp']):
            self.assertEqual(case.run.run(case.work, None, None, None, []), ['b'])
        self.assertIn('MCP', case.run.deferred[0]['reason'])
        self.assertIsNone(case.run.receipt('a'))
        case.finish('b')

    def test_guard_launch_failure_leaves_upstream_available_for_next_card(self):
        case = self.case
        case.accepted()
        for name in ('b', 'c'):
            case.card(name, f'依赖：a\n接续：a\n任务 {name}')
        spawn = worker.subprocess.Popen
        def fail_first(command, *args, **kwargs):
            if '_guard' in command and command[5] == 'b':
                raise OSError('fixture launch failure')
            return spawn(command, *args, **kwargs)
        with mock.patch.object(worker.subprocess, 'Popen', side_effect=fail_first):
            self.assertEqual(case.run.run(None, None, None, None, [], max_parallel=1), ['c'])
        self.assertEqual(case.run.receipt('a')['continued_by'], 'c')
        self.assertFalse(worker.capacity_held(case.run.receipt('b')))
        self.assertIn('fixture launch failure', case.run.deferred[0]['reason'])
        case.finish('c')

    def test_failed_retry_launch_preserves_prior_receipt_and_does_not_archive(self):
        case = self.case
        case.card()
        case.start('--cwd', case.work)
        case.reject()
        saved = {ext: (case.root / ('a.' + ext)).read_bytes() for ext in ('json', 'out', 'log', 'prompt')}
        case.card('b', '任务')
        spawn = worker.subprocess.Popen
        def fail_retry(command, *args, **kwargs):
            if '_guard' in command and command[5] == 'a':
                raise OSError('fixture retry launch failure')
            return spawn(command, *args, **kwargs)
        with mock.patch.object(worker.subprocess, 'Popen', side_effect=fail_retry):
            self.assertEqual(case.run.run(None, None, None, None, ['a']), ['b'])
        self.assertEqual({ext: (case.root / ('a.' + ext)).read_bytes() for ext in saved}, saved)
        self.assertFalse((case.root / 'history').exists())
        case.finish('b')


if __name__ == '__main__':
    unittest.main()
