"""巡检与尝试隔离：只启动本地替身，默认拒绝任何 Codex 调用。"""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import worker as runner

WORKER = Path(runner.__file__).resolve()
FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
if 'mcp' in args:
    print('[]')
    sys.exit(0)
prompt = sys.stdin.read()
out = Path(args[args.index('-o') + 1])
print('session id: fixture-inspect', flush=True)
print('tokens used\n1,234', flush=True)
if 'SLOW' in prompt:
    out.write_text('部分稿')
    print('\x1b[31m正在处理\x1b[0m\x00', flush=True)
    time.sleep(5)
if 'SEGMENTS' in prompt:
    for i in range(8):
        print('进度 ' + str(i), flush=True)
        time.sleep(.1)
if 'RECOVER' in prompt:
    time.sleep(.25)
    print('恢复输出', flush=True)
    time.sleep(.25)
if 'TREE' in prompt:
    child = subprocess.Popen([sys.executable, '-c',
        'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("子进程就绪", flush=True); time.sleep(15)'])
    time.sleep(15)
out.write_text('## 结论卡\n问题／本次结论：完成\n')
'''


class InspectTest(unittest.TestCase):
    def setUp(self):
        self.tmp_obj = tempfile.TemporaryDirectory(prefix='lead-inspect-')
        self.tmp = Path(self.tmp_obj.name).resolve()
        self.run_dir = self.tmp / 'run'
        (self.run_dir / 'cards').mkdir(parents=True)
        self.reject = self.tmp / 'reject-codex'
        self.reject.write_text('#!/bin/sh\necho "禁止启动真实 Codex" >&2\nexit 97\n')
        self.reject.chmod(0o755)
        self.fake = self.tmp / 'fake-codex'
        self.fake.write_text(FAKE_CODEX)
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(self.reject), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.env_patch = mock.patch.dict(os.environ, {'CREW_CODEX_BIN': str(self.reject)})
        self.env_patch.start()
        self.children = []
        self.run = runner.Run(self.run_dir)

    def tearDown(self):
        for name in self.run.cards():
            r = self.run.receipt(name)
            if r and r.get('attempt_id') and r.get('state') in ('running', 'stalled'):
                self.cli('stop', self.run_dir, name)
        for proc in self.children:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        end = time.monotonic() + 3
        while time.monotonic() < end:
            if all((self.run.receipt(n) or {}).get('state') not in ('running', 'stalled')
                   or not runner.alive((self.run.receipt(n) or {}).get('pid', 0)) for n in self.run.cards()):
                break
            time.sleep(.05)
        self.env_patch.stop()
        self.tmp_obj.cleanup()

    def card(self, name='a', body='任务'):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body)

    def cli(self, *args, execute=False):
        env = {**self.env, **({'CREW_CODEX_BIN': str(self.fake)} if execute else {})}
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=env, capture_output=True, text=True, timeout=12)

    def ok(self, *args, execute=False):
        result = self.cli(*args, execute=execute)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def start(self, *args):
        return self.ok('run', self.run_dir, '--cwd', self.tmp, *args, execute=True)

    def until(self, predicate, timeout=6):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.04)
        self.fail('替身未在期限内到达预期状态')

    def finish(self, name='a'):
        self.until(lambda: (self.run.receipt(name) or {}).get('state') not in (None, 'running', 'stalled'))
        return self.run.receipt(name)

    def orphan(self, unknown=False):
        self.card()
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(15)'], start_new_session=True)
        self.children.append(proc)
        dead = subprocess.Popen(['true'])
        dead.wait()
        receipt = {'state': 'running', 'pid': dead.pid, 'attempt_id': 'old-attempt',
                   'started_at': runner.now(), 'output': str(self.run_dir / 'a.out'),
                   'log': str(self.run_dir / 'a.log')}
        if not unknown:
            receipt.update(executor_pid=proc.pid, executor_pgid=proc.pid)
        runner.write_json(self.run_dir / 'a.json', receipt)
        return proc, receipt

    def test_default_run_has_no_deadline_and_outlives_short_hard_limit(self):
        self.card(body='SEGMENTS')
        self.start()
        self.assertIsNone(runner.read_json(self.run_dir / 'run.json')['minutes'])
        self.assertNotIn('绝对截止时间', (self.run_dir / 'a.prompt').read_text())
        receipt = self.finish()
        self.assertEqual(receipt['state'], 'finished')
        self.assertGreater(receipt['seconds'], .3)
        self.card('limited', 'SEGMENTS')
        self.start('--seconds', '.3')
        self.assertEqual(self.finish('limited')['state'], 'timed_out')

    def test_unlimited_guard_survives_equivalent_of_old_thirty_minutes(self):
        self.card()
        prompt, output = self.run_dir / 'a.prompt', self.run_dir / 'a.out'
        prompt.write_text('SEGMENTS')
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'scaled-clock', 'started_at': runner.now(),
                   'cwd': str(self.tmp), 'prompt': str(prompt), 'output': str(output),
                   'log': str(self.run_dir / 'a.log')}
        runner.write_json(self.run_dir / 'a.json', receipt)
        monotonic = time.monotonic
        # 0.3 秒真实时间相当于旧上限 1800 秒，替身持续分段输出 0.8 秒。
        with mock.patch.object(runner.time, 'monotonic', side_effect=lambda: monotonic() * 6000):
            runner.guard(self.run_dir, 'a', None, [str(self.fake), 'exec', '-o', str(output)], 'scaled-clock', .04)
        self.assertEqual(self.run.receipt('a')['state'], 'finished')
        self.assertGreater(self.run.receipt('a')['seconds'], 1800)

    def test_explicit_limit_over_thirty_minutes_is_allowed(self):
        self.card()
        self.start('--minutes', '31')
        self.assertIn('31 分钟', (self.run_dir / 'a.prompt').read_text())
        self.assertEqual(self.finish()['state'], 'finished')

    def test_heartbeat_stall_does_not_kill_and_wait_notifies_once(self):
        self.card(body='SLOW')
        self.start('--stall-minutes', '.002', '--heartbeat-seconds', '.04')
        self.until(lambda: (self.run.receipt('a') or {}).get('state') == 'stalled')
        r = self.run.receipt('a')
        self.assertTrue(runner.alive(r['executor_pid']))
        h = r['heartbeat']
        self.assertGreater(h['log_bytes'], 0)
        self.assertIn('log_mtime', h)
        self.assertIn('at', h)
        self.assertEqual(h['tokens'], 1234)
        self.assertEqual(h['last_output'], '正在处理')
        first = self.ok('wait', self.run_dir, '--minutes', '.01')
        self.assertEqual(first['fresh'], ['a'])
        second = self.ok('wait', self.run_dir, '--minutes', '.001')
        self.assertEqual(second['fresh'], [])
        self.assertEqual(second['cards'][0]['state'], 'stalled')

    def test_wait_timeout_returns_progress_without_stopping(self):
        self.card(body='SLOW')
        self.start('--heartbeat-seconds', '.04')
        self.until(lambda: bool((self.run.receipt('a') or {}).get('heartbeat', {}).get('log_bytes')))
        start = time.monotonic()
        result = self.ok('wait', self.run_dir, '--minutes', '.003')
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(result['fresh'], [])
        card = result['cards'][0]
        self.assertEqual(card['state'], 'running')
        self.assertIn('已跑', card['progress'])
        self.assertIn('1234', card['progress'])
        self.assertIn('正在处理', card['progress'])
        self.assertIn('最后动静', card['progress'])
        self.assertEqual(card['tokens'], 1234)

    def test_wait_over_thirty_minutes_is_allowed_when_nothing_running(self):
        self.card()
        self.assertEqual(self.ok('wait', self.run_dir, '--minutes', '31')['fresh'], [])

    def test_stop_preserves_partial_output_and_retry_isolated(self):
        self.card(body='SLOW')
        self.start('--heartbeat-seconds', '.04')
        self.until(lambda: bool((self.run.receipt('a') or {}).get('heartbeat', {}).get('log_bytes')))
        old = self.run.receipt('a')
        result = self.ok('stop', self.run_dir, 'a', '--note', '调整任务')
        self.assertTrue(result['requested'])
        r = self.finish()
        self.assertEqual(r['state'], 'stopped')
        self.assertEqual((self.run_dir / 'a.out').read_text(), '部分稿')
        self.assertTrue(runner.executor_group_free(r))
        self.card(body='新版任务')
        self.start('--retry', 'a')
        self.assertEqual(self.finish()['state'], 'finished')
        self.assertNotEqual(self.run.receipt('a')['attempt_id'], old['attempt_id'])
        self.assertTrue(list((self.run_dir / 'history').glob('a-*.out')))
        diff = self.cli('diff', self.run_dir, 'a')
        self.assertIn('-部分稿', diff.stdout)

    def test_lost_guard_holds_capacity_and_retry_until_group_exits(self):
        proc, original = self.orphan()
        self.card('b')
        status = self.ok('status', self.run_dir)['cards'][0]
        self.assertEqual(status['state'], 'lost')
        self.assertTrue(status['capacity_held'])
        self.assertTrue(status['retry_blocked'])
        blocked = self.cli('run', self.run_dir, '--cwd', self.tmp, '--retry', 'a', execute=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertEqual(self.run.receipt('a'), original)
        result = self.start('--max-parallel', '1')
        self.assertEqual(result['dispatched'], [])
        self.assertEqual(result['deferred'][0]['card'], 'b')
        self.assertFalse((self.run_dir / 'history').exists())
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=5)
        self.start('--retry', 'a', '--max-parallel', '1')
        self.assertEqual(self.finish()['state'], 'finished')

    def test_unknown_executor_identity_blocks_retry_even_after_reject(self):
        _, original = self.orphan(unknown=True)
        self.ok('reject', self.run_dir, 'a', '--note', '失联')
        result = self.cli('run', self.run_dir, '--cwd', self.tmp, '--retry', 'a', execute=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run.receipt('a')['attempt_id'], original['attempt_id'])

    def test_actual_guard_loss_archives_private_result_only_after_executor_exit(self):
        self.card(body='SLOW')
        self.start('--heartbeat-seconds', '.04')
        self.until(lambda: bool((self.run.receipt('a') or {}).get('heartbeat', {}).get('log_bytes')))
        old = self.run.receipt('a')
        os.kill(old['pid'], signal.SIGKILL)  # 仅杀本用例刚创建的看守，模拟失联。
        self.until(lambda: self.run.state('a', self.run.cards()) == 'lost')
        self.assertTrue(self.ok('status', self.run_dir)['cards'][0]['capacity_held'])
        self.assertNotEqual(self.cli('run', self.run_dir, '--cwd', self.tmp, '--retry', 'a', execute=True).returncode, 0)
        self.assertFalse((self.run_dir / 'history').exists())
        self.until(lambda: runner.executor_group_free(old))
        self.card(body='重派后的任务')
        self.start('--retry', 'a')
        self.assertEqual(self.finish()['state'], 'finished')
        self.assertTrue(list((self.run_dir / 'history').glob('a-*.out')))
        self.assertTrue(list((self.run_dir / 'history').glob('a-*.log')))

    def test_stored_lost_without_identity_remains_blocked(self):
        self.assertTrue(runner.capacity_held({'state': 'lost'}))

    def test_unrelated_transient_ps_state_does_not_hold_exited_group(self):
        receipt = {'executor_pid': 123, 'executor_pgid': 123}
        listing = subprocess.CompletedProcess([], 0, '456 456 ?E\n789 789 R\n', '')
        with mock.patch.object(runner.subprocess, 'run', return_value=listing):
            self.assertTrue(runner.executor_group_free(receipt))
        listing.stdout = '123 123 ?E\n789 789 R\n'
        with mock.patch.object(runner.subprocess, 'run', return_value=listing):
            self.assertFalse(runner.executor_group_free(receipt))

    def test_late_guard_cannot_publish_into_new_attempt(self):
        self.card(body='SLOW')
        self.start('--heartbeat-seconds', '.04')
        self.until(lambda: bool((self.run.receipt('a') or {}).get('heartbeat', {}).get('log_bytes')))
        old = self.run.receipt('a')
        replacement = {**old, 'attempt_id': 'replacement', 'state': 'finished', 'tokens': 99}
        with self.run.lock():
            runner.write_json(self.run_dir / 'a.json', replacement)
            (self.run_dir / 'a.out').write_text('新稿')
            (self.run_dir / 'a.log').write_text('新日志')
        self.until(lambda: runner.executor_group_free(old))
        time.sleep(.1)
        self.assertEqual(self.run.receipt('a'), replacement)
        self.assertEqual((self.run_dir / 'a.out').read_text(), '新稿')
        self.assertEqual((self.run_dir / 'a.log').read_text(), '新日志')

    def test_max_parallel_keeps_ready_cards_and_accept_obeys_saved_limit(self):
        self.card('a')
        self.card('b', 'SLOW')
        self.card('c', '依赖：a\n下游')
        result = self.start('--max-parallel', '1')
        self.assertEqual(result['dispatched'], ['a'])
        self.assertEqual(result['deferred'][0]['card'], 'b')
        self.assertIn('上限', result['deferred'][0]['reason'])
        self.assertEqual({c['card']: c['state'] for c in result['cards']}['b'], 'ready')
        self.finish()
        self.start('--max-parallel', '1')
        accepted = self.ok('accept', self.run_dir, 'a', '--note', '继续', execute=True)
        self.assertEqual(accepted['dispatched'], [])
        self.assertEqual(accepted['deferred'][0]['card'], 'c')
        self.assertFalse((self.run_dir / 'c.json').exists())

    def test_accept_can_dispatch_without_a_hard_limit(self):
        self.card('a')
        self.card('b', '依赖：a\n下游')
        self.start()
        self.finish()
        result = self.ok('accept', self.run_dir, 'a', '--note', '继续', execute=True)
        self.assertEqual(result['dispatched'], ['b'])
        self.assertEqual(self.finish('b')['state'], 'finished')

    def test_deferred_retry_keeps_old_receipt_until_it_can_start(self):
        self.card('a')
        self.start()
        self.finish()
        self.ok('reject', self.run_dir, 'a', '--note', '补来源')
        original = self.run.receipt('a')
        self.card('b', 'SLOW')
        self.start('--max-parallel', '1')
        result = self.start('--retry', 'a', '--max-parallel', '1')
        self.assertEqual(result['dispatched'], [])
        self.assertEqual(result['deferred'][0]['card'], 'a')
        self.assertEqual(self.run.receipt('a'), original)
        self.assertFalse((self.run_dir / 'history').exists())

    def test_stop_kills_stubborn_descendant_but_not_other_card(self):
        self.card('a', 'TREE')
        self.card('b', 'SLOW')
        self.start('--heartbeat-seconds', '.04')
        self.until(lambda: (self.run.receipt('a') or {}).get('heartbeat', {}).get('last_output') == '子进程就绪')
        self.ok('stop', self.run_dir, 'a')
        receipt = self.finish()
        self.assertEqual(receipt['state'], 'stopped')
        self.assertTrue(runner.executor_group_free(receipt))
        self.assertEqual(self.run.receipt('b')['state'], 'running')
        self.assertTrue(runner.alive(self.run.receipt('b')['executor_pid']))

    def test_stall_recovery_and_delivery_are_separate_notifications(self):
        self.card(body='RECOVER')
        self.start('--stall-minutes', '.002', '--heartbeat-seconds', '.02')
        self.until(lambda: (self.run.receipt('a') or {}).get('state') == 'stalled')
        self.assertEqual(self.ok('wait', self.run_dir, '--minutes', '.001')['fresh'], ['a'])
        self.until(lambda: (self.run.receipt('a') or {}).get('heartbeat', {}).get('last_output') == '恢复输出')
        self.assertEqual(self.run.receipt('a')['state'], 'running')
        self.finish()
        delivered = self.ok('wait', self.run_dir, '--minutes', '.001')
        self.assertEqual(delivered['fresh'], ['a'])
        self.assertIn('## 结论卡', delivered['cards'][0]['conclusion'])

    def test_cleanup_unconfirmed_stays_held_after_review(self):
        _, receipt = self.orphan()
        receipt.update(state='failed', cleanup_unconfirmed=True)
        runner.write_json(self.run_dir / 'a.json', receipt)
        self.ok('reject', self.run_dir, 'a', '--note', '重试前需清理')
        status = self.ok('status', self.run_dir)['cards'][0]
        self.assertTrue(status['capacity_held'])
        self.assertNotEqual(self.cli('run', self.run_dir, '--cwd', self.tmp, '--retry', 'a', execute=True).returncode, 0)

    def test_wait_default_is_ten_minutes(self):
        self.card()
        with mock.patch.object(runner.Run, 'wait', return_value=[]) as waiting, mock.patch('builtins.print'):
            self.assertEqual(runner.main(['wait', str(self.run_dir)]), 0)
        waiting.assert_called_once_with(600)

    def test_wait_deadline_includes_time_waiting_for_dispatch_lock(self):
        self.card()
        with (self.run_dir / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            release = threading.Timer(.6, lambda: fcntl.flock(lock, fcntl.LOCK_UN))
            release.start()
            try:
                started = time.monotonic()
                self.ok('wait', self.run_dir, '--minutes', '.001')
                self.assertLess(time.monotonic() - started, .4)
            finally:
                release.join()

    def test_delayed_initial_guard_does_not_start_or_touch_replacement(self):
        self.card()
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'new', 'started_at': runner.now()}
        runner.write_json(self.run_dir / 'a.json', receipt)
        with mock.patch.object(runner.subprocess, 'Popen') as launch:
            runner.guard(self.run_dir, 'a', None, [str(self.reject)], 'old')
        launch.assert_not_called()
        self.assertEqual(self.run.receipt('a'), receipt)
        # 仅为这个没有看守的测试回执结束清理，不涉及真实进程。
        receipt['state'] = 'failed'
        runner.write_json(self.run_dir / 'a.json', receipt)

    def test_heartbeat_uses_latest_tokens_and_keeps_resume_delta(self):
        log = self.tmp / 'log'
        log.write_text('tokens used\n146,003\ntokens used\n295,544\n完成\n')
        receipt = {'started_at': runner.now(), 'tokens_before': 146003}
        heartbeat = runner.log_heartbeat(receipt, log)
        self.assertEqual(heartbeat['tokens_session'], 295544)
        self.assertEqual(heartbeat['tokens'], 149541)
        self.assertEqual(runner.read_log(log)[1], 295544)

    def test_guard_spawn_failure_returns_terminal_receipt(self):
        self.card()
        prompt = self.run_dir / 'a.prompt'
        prompt.write_text('任务')
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'failed-launch', 'started_at': runner.now(),
                   'cwd': str(self.tmp), 'prompt': str(prompt), 'output': str(self.run_dir / 'a.out'),
                   'log': str(self.run_dir / 'a.log')}
        runner.write_json(self.run_dir / 'a.json', receipt)
        runner.guard(self.run_dir, 'a', None, [str(self.tmp / 'missing-executor')], 'failed-launch', .02)
        self.assertEqual(self.run.receipt('a')['state'], 'failed')
        self.assertFalse(runner.capacity_held(self.run.receipt('a')))


if __name__ == '__main__':
    unittest.main()
