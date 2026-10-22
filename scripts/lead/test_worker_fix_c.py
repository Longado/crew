"""总复审 C：只用临时目录、假 Codex 与可控的进程查询复现 H1—H4。"""
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


FAKE = FAKE_CODEX.replace(
    "print('session id: abc-123')",
    "print('session id: ' + (args[2] if 'resume' in args else os.environ.get('FAKE_SESSION', 'fixture-new')))"
).replace("print('tokens used')\nprint('1,234')",
          "if os.environ.get('FAKE_NO_TOKENS') != '1':\n"
          "    print('tokens used')\n    print(os.environ.get('FAKE_TOKENS', '1234'))"
).replace("if 'SLEEP' in prompt:",
          "if os.environ.get('FAKE_FAIL') == '1':\n    sys.exit(1)\nif 'SLEEP' in prompt:")


class FixCTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-fix-c-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'CREW_HOME': str(self.tmp / 'registry'),
                    'CODEX_HOME': str(self.tmp / 'codex'), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        patch = mock.patch.dict(os.environ, self.env)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.stop_owned)

    def stop_owned(self):
        for name in self.run.cards():
            receipt = self.run.receipt(name) or {}
            if receipt.get('state') in worker.ACTIVE_STATES and worker.alive(receipt.get('pid')):
                self.cli('stop', self.root, name)
                self.until(lambda: self.run.receipt(name)['state'] not in worker.ACTIVE_STATES)

    def card(self, name='a', body='任务'):
        (self.root / 'cards' / (name + '.md')).write_text(body, encoding='utf-8')

    def cli(self, *args):
        # ponytail: 活跃的其他卡仍会写心跳；成功派发等锁就绪，不把抢锁当成执行失败。
        deadline = time.monotonic() + 30
        while True:
            result = subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)], env=self.env,
                                    capture_output=True, text=True, timeout=60)
            if (not args or args[0] != 'run' or result.returncode != 2
                    or result.stderr.strip() != '这个运行目录正在派单，等它结束再来。'
                    or time.monotonic() >= deadline):
                return result
            time.sleep(.05)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start(self, *args):
        return self.ok('run', self.root, '--cwd', self.tmp, '--heartbeat-seconds', '.05', *args)

    def until(self, predicate):
        end = time.monotonic() + 30
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.02)
        self.fail('假执行者未到达预期状态')

    def finished(self, name='a'):
        self.until(lambda: (self.run.receipt(name) or {}).get('state') not in (None, *worker.ACTIVE_STATES))
        return self.run.receipt(name)

    def calls(self):
        return [json.loads(line) for line in Path(self.env['FAKE_LOG']).read_text().splitlines()]

    def upstream(self):
        self.card()
        self.env.update(FAKE_SESSION='fixture-upstream', FAKE_TOKENS='9000')
        self.start()
        self.finished()
        self.ok('accept', self.root, 'a', '--note', '已核对', '--hold')

    def test_h1_failed_fresh_retry_does_not_rejoin_session_used_by_downstream(self):
        self.upstream()
        self.card('b', '依赖：a\n接续：a\n任务 B')
        self.env['FAKE_TOKENS'] = '10200'
        self.start()
        self.finished('b')
        self.ok('accept', self.root, 'b', '--note', '已核对', '--hold')
        self.card('c', '依赖：b\n接续：b\nSLEEP')
        self.start()
        self.until(lambda: bool((self.run.receipt('c') or {}).get('heartbeat', {}).get('log_bytes')))
        downstream = self.run.receipt('c')
        (self.root / 'b.out').write_text('验收后改稿，需重新核对')
        self.ok('reject', self.root, 'b', '--note', '补充依据')
        self.env.update(FAKE_SESSION='fixture-fresh', FAKE_TOKENS='100', FAKE_FAIL='1')
        self.start('--retry', 'b', '--fresh')
        self.assertEqual(self.finished('b')['state'], 'failed')
        self.env.update(FAKE_FAIL='0', FAKE_TOKENS='150')
        self.start('--retry', 'b')
        receipt = self.finished('b')
        call = next(call for call in reversed(self.calls()) if '任务 B' in call['prompt'])
        self.assertEqual(call['args'][:3], ['exec', 'resume', 'fixture-fresh'])
        self.assertEqual((receipt['tokens_before'], receipt['tokens']), (100, 50))
        self.assertEqual(self.run.receipt('c')['attempt_id'], downstream['attempt_id'])
        self.assertEqual(self.run.receipt('c')['resumed_from'], 'fixture-upstream')
        self.assertIn(self.run.receipt('c')['state'], worker.ACTIVE_STATES)

    def test_h1_timed_out_continuation_retries_from_its_latest_total(self):
        self.upstream()
        self.card('b', '依赖：a\n接续：a\nSLEEP')
        self.env['FAKE_TOKENS'] = '10200'
        self.start('--seconds', '.5')
        self.assertEqual(self.finished('b')['state'], 'timed_out')
        self.card('b', '依赖：a\n接续：a\n补齐任务')
        self.env['FAKE_TOKENS'] = '10500'
        self.start('--retry', 'b', '--seconds', '30')
        receipt = self.finished('b')
        self.assertEqual((receipt['tokens_before'], receipt['tokens']), (10200, 300))

    def test_h1_retry_without_own_session_never_falls_back_to_header(self):
        self.upstream()
        self.card('b', '依赖：a\n接续：a\n任务 B')
        worker.write_json(self.root / 'b.json', {'state': 'failed', 'cwd': str(self.tmp),
                          'sandbox': 'read-only', 'model': None, 'fresh_after': 'fixture-upstream'})
        self.start('--retry', 'b')
        self.finished('b')
        self.assertNotIn('resume', self.calls()[-1]['args'])

    def test_h1_stopped_retry_uses_selected_session_and_last_heartbeat_total(self):
        self.card()
        worker.write_json(self.root / 'a.json', {'state': 'stopped', 'cwd': str(self.tmp),
                          'sandbox': 'read-only', 'model': None, 'resumed_from': 'fixture-own',
                          'tokens': 1200, 'tokens_session': None, 'heartbeat': {'tokens_session': 10200}})
        self.env['FAKE_TOKENS'] = '10500'
        self.start('--retry', 'a')
        receipt = self.finished()
        self.assertEqual(self.calls()[-1]['args'][:3], ['exec', 'resume', 'fixture-own'])
        self.assertEqual((receipt['tokens_before'], receipt['tokens']), (10200, 300))

    def dead_guard(self):
        self.card()
        guards = []
        spawn = subprocess.Popen
        def track(command, *args, **kwargs):
            proc = spawn(command, *args, **kwargs)
            if '_guard' in command:
                guards.append(proc)
            return proc
        # 持调度锁，确保看守尚未登记执行者；只终止本用例启动的看守。
        with mock.patch.object(worker.subprocess, 'Popen', side_effect=track), self.run.lock():
            self.run._run(self.tmp, 5, None, None, [])
            receipt = self.run.receipt('a')
            guards[0].kill()
            guards[0].wait(timeout=30)
        return receipt

    def test_h2_dispatch_records_guard_identity_before_guard_can_write(self):
        receipt = self.dead_guard()
        self.assertGreater(receipt['pid'], 0)
        self.assertTrue(receipt.get('guard_identity'))
        self.assertNotIn('executor_pid', receipt)

    def test_h2_dead_guard_without_executor_can_be_confirmed_and_retried(self):
        receipt = self.dead_guard()
        # 兼容旧实现的复现输入：补上已知死 PID，让失败落在恢复入口而非未登记 PID。
        if not receipt['pid']:
            receipt['pid'] = 99999999
            worker.write_json(self.root / 'a.json', receipt)
        self.assertTrue(worker.capacity_held(receipt))
        attempt = receipt['attempt_id']
        result = self.cli('stop', self.root, 'a', '--confirm-exited', '--attempt-id', attempt,
                          '--note', '已人工核实无遗留执行者')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        confirmed = self.run.receipt('a')
        for key in ('by', 'at', 'note', 'attempt_id'):
            self.assertTrue(confirmed['exit_confirmation'][key])
        self.assertEqual(confirmed['exit_confirmation']['attempt_id'], attempt)
        self.assertFalse(worker.capacity_held(confirmed))
        self.start('--retry', 'a')
        self.assertEqual(self.finished()['state'], 'finished')

    def test_h2_confirmation_requires_current_attempt_dead_guard_and_no_executor(self):
        receipt = self.dead_guard()
        original = {**receipt, 'pid': 99999999}
        for fields, attempt, note in (({}, None, '已核实'), ({}, 'wrong-attempt', '已核实'),
                                     ({}, receipt['attempt_id'], ''),
                                     ({'pid': os.getpid()}, receipt['attempt_id'], '已核实'),
                                     ({'pid': 0}, receipt['attempt_id'], '已核实'),
                                     ({'executor_pid': 123, 'executor_pgid': 123}, receipt['attempt_id'], '已核实')):
            with self.subTest(fields=fields, attempt=attempt, note=note):
                current = {**original, **fields}
                # 活 PID 用当前身份，不能误当复用后的旧看守。
                if fields.get('pid') == os.getpid():
                    current.pop('guard_identity', None)
                worker.write_json(self.root / 'a.json', current)
                args = ['stop', self.root, 'a', '--confirm-exited', '--note', note]
                if attempt:
                    args += ['--attempt-id', attempt]
                self.assertEqual(self.cli(*args).returncode, 2)
                self.assertEqual(self.run.receipt('a'), current)
        worker.write_json(self.root / 'a.json', original)

    def test_h2_confirmation_never_signals_even_after_guard_pid_reuse(self):
        receipt = self.dead_guard()
        receipt.update(pid=123, guard_identity={'started_at': 'old-start', 'state': 'S'})
        worker.write_json(self.root / 'a.json', receipt)
        with mock.patch.object(worker, 'alive', return_value=True), \
                mock.patch.object(worker, 'guard_identity', return_value={'started_at': 'new-start', 'state': 'S'}), \
                mock.patch.object(worker.os, 'killpg') as group_signal, \
                mock.patch.object(worker.os, 'kill') as process_signal:
            self.run.stop('a', '已核实旧看守与执行者退出', confirm_exited=True,
                          attempt_id=receipt['attempt_id'])
            self.assertFalse(worker.capacity_held(self.run.receipt('a')))
        group_signal.assert_not_called()
        process_signal.assert_not_called()

    def test_h2_unknown_guard_query_cannot_release_capacity(self):
        receipt = self.dead_guard()
        receipt.update(pid=123, guard_identity={'started_at': 'old-start', 'state': 'S'})
        worker.write_json(self.root / 'a.json', receipt)
        with mock.patch.object(worker, 'alive', return_value=True), \
                mock.patch.object(worker.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ps', .5)):
            with self.assertRaisesRegex(ValueError, '看守尚未确认退出'):
                self.run.stop('a', '已核实', confirm_exited=True, attempt_id=receipt['attempt_id'])
            self.assertTrue(worker.capacity_held(receipt))
        self.assertEqual(self.run.receipt('a'), receipt)
        # 后续夹具清理不用这个模拟 PID。
        worker.write_json(self.root / 'a.json', {**receipt, 'pid': 99999999})

    def test_h3_stop_and_timeout_keep_last_heartbeat_total_without_console_tokens(self):
        for mode in ('stop', 'timeout'):
            with self.subTest(mode=mode):
                name = mode
                self.card(name, 'SLEEP')
                self.env.update(FAKE_NO_TOKENS='1', FAKE_SESSION='fixture-usage')
                native = Path(self.env['CODEX_HOME']) / 'sessions' / 'rollout-test-fixture-usage.jsonl'
                native.parent.mkdir(parents=True, exist_ok=True)
                native.write_text(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count',
                    'info': {'total_token_usage': {'input_tokens': 12000, 'cached_input_tokens': 2000,
                                                  'output_tokens': 200}}}}) + '\n')
                # 旧轮次累计 9000，本轮应保留 10200 / 1200。
                worker.write_json(self.root / (name + '.json'), {'state': 'failed', 'cwd': str(self.tmp),
                    'sandbox': 'read-only', 'model': None, 'session_id': 'fixture-usage',
                    'tokens_session': 9000, 'review': {'verdict': 'rejected', 'note': '继续'}})
                self.start('--retry', name, '--seconds', '1.2')
                self.until(lambda: (self.run.receipt(name) or {}).get('heartbeat', {}).get('tokens_session') == 10200)
                native.unlink()  # 只删本例新建文件，终态必须沿用最后一次有效心跳。
                if mode == 'stop':
                    self.ok('stop', self.root, name)
                final = self.finished(name)
                self.assertEqual(final['state'], 'stopped' if mode == 'stop' else 'timed_out')
                self.assertEqual((final['tokens_session'], final['tokens']), (10200, 1200))

    def test_h3_stop_after_guard_death_keeps_heartbeat_usage(self):
        self.card()
        receipt = {'state': 'running', 'pid': 99999999, 'attempt_id': 'fixture-dead',
                   'started_at': worker.now(), 'executor_pid': 123, 'executor_pgid': 123,
                   'tokens_before': 9000, 'heartbeat': {'tokens_session': 10200, 'tokens': 1200}}
        worker.write_json(self.root / 'a.json', receipt)
        with mock.patch.object(worker, 'executor_group_free', return_value=True), \
                mock.patch.object(worker.os, 'killpg') as killing:
            self.run.stop('a', '核实退出')
        killing.assert_not_called()
        final = self.run.receipt('a')
        self.assertEqual((final.get('tokens_session'), final.get('tokens')), (10200, 1200))
        self.assertTrue(final.get('executor_exit_confirmed_at'))

    def test_h4_confirmed_exit_does_not_hold_capacity_when_group_number_is_reused(self):
        self.card()
        self.start()
        receipt = self.finished()
        self.assertTrue(receipt.get('executor_exit_confirmed_at'))
        with mock.patch.object(worker, 'executor_group_free', return_value=False) as check:
            self.assertFalse(worker.capacity_held(receipt))
        check.assert_not_called()

    def test_h4_unconfirmed_residual_group_still_holds_capacity(self):
        receipt = {'state': 'finished', 'executor_pid': 123, 'executor_pgid': 123,
                   'cleanup_unconfirmed': True}
        with mock.patch.object(worker, 'executor_group_free', return_value=False):
            self.assertTrue(worker.capacity_held(receipt))
        with mock.patch.object(worker, 'executor_group_free', return_value=True):
            self.assertFalse(worker.capacity_held(receipt))

    def test_h4_guard_keeps_first_exit_confirmation_during_stop(self):
        self.card()
        prompt = self.root / 'a.prompt'
        prompt.write_text('任务')
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'fixture-stop-race',
                   'started_at': worker.now(), 'cwd': str(self.tmp), 'prompt': str(prompt),
                   'output': str(self.root / 'a.out'), 'log': str(self.root / 'a.log')}
        worker.write_json(self.root / 'a.json', receipt)
        queries = []
        def group_free(current):
            queries.append(current)
            if len(queries) == 1:
                # 假执行者已交稿；先模拟残留组，让下一轮进入停止路径。
                worker.write_json(self.root / '.attempts' / receipt['attempt_id'] / 'stop.json',
                                  {'attempt_id': receipt['attempt_id'], 'note': '停止残留组'})
                return False
            # 停止路径首次确认空组，之后同号已被无关进程复用。
            return len(queries) == 2
        with mock.patch.object(worker, 'executor_group_free', side_effect=group_free):
            worker.guard(self.root, 'a', 30, [self.env['CREW_CODEX_BIN'], 'exec', '-o', receipt['output']],
                         receipt['attempt_id'], .05)
            final = self.run.receipt('a')
            self.assertEqual(final['state'], 'stopped')
            self.assertTrue(final.get('executor_exit_confirmed_at'))
            self.assertFalse(worker.capacity_held(final))


if __name__ == '__main__':
    unittest.main()
