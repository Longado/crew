"""修复 A：假执行者与临时目录复现看守、续跑及验收边界。"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import result_contract
import worker
from test_worker import FAKE_CODEX, WORKER


FAKE = FAKE_CODEX.replace("print('1,234')", "print(os.environ.get('FAKE_TOKENS', '1,234'))")
FAKE += '''
if 'LEAVE_CHILD' in prompt:
    import subprocess
    child = subprocess.Popen([sys.executable, '-c',
        'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)'])
    print('child pid: ' + str(child.pid), flush=True)
    time.sleep(.25)
'''


class FixATest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lead-fix-a-')
        self.tmp = Path(self.temp.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        self.fake = self.tmp / 'fake-codex'
        self.fake.write_text(FAKE, encoding='utf-8')
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(self.fake),
                    'CREW_HOME': str(self.tmp / 'registry'), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        self.environment = mock.patch.dict(os.environ, self.env)
        self.environment.start()
        self.owned = []

    def tearDown(self):
        # 仅清理本用例启动的进程；不根据任意旧回执杀进程。
        for receipt in self.owned + [self.run.receipt(n) or {} for n in self.run.cards()]:
            pgid = receipt.get('executor_pgid')
            if pgid and receipt.get('cwd') == str(self.tmp):
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        end = time.monotonic() + 3
        while time.monotonic() < end:
            if all(not worker.alive((self.run.receipt(n) or {}).get('pid')) for n in self.run.cards()):
                break
            time.sleep(.02)
        self.environment.stop()
        self.temp.cleanup()

    def card(self, name='a', body='任务'):
        path = self.root / 'cards' / f'{name}.md'
        path.write_text(body, encoding='utf-8')
        return path

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start(self, *args):
        return self.ok('run', self.root, '--cwd', self.tmp, '--heartbeat-seconds', '.05', *args)

    def until(self, predicate, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.02)
        self.fail('假执行者未在期限内到达预期状态')

    def finished(self, name='a'):
        self.until(lambda: (self.run.receipt(name) or {}).get('state') not in (None, *worker.ACTIVE_STATES))
        return self.run.receipt(name)

    def running(self):
        self.until(lambda: bool((self.run.receipt('a') or {}).get('heartbeat', {}).get('log_bytes')))
        return self.run.receipt('a')

    def calls(self):
        return [json.loads(line) for line in (self.tmp / 'calls.jsonl').read_text().splitlines()]

    def delivery(self, name='a', text='旧稿'):
        self.card(name)
        output = self.root / f'{name}.out'
        output.write_text(text, encoding='utf-8')
        receipt = {'state': 'finished', 'started_at': worker.now(), 'ended_at': worker.now(),
                   'card_sha256': worker.card_sha256(self.root / 'cards' / f'{name}.md'),
                   'output': str(output), 'cwd': str(self.tmp), 'sandbox': 'read-only',
                   'session_id': 'fixture-original', 'tokens_session': 1000, 'model': None, 'effort': 'high'}
        worker.write_json(self.root / f'{name}.json', receipt)
        return receipt

    def test_a1_legacy_lost_confirmation_releases_only_capacity_and_allows_retry(self):
        self.card()
        # 第一轮格式：无 attempt_id、heartbeat、executor_pid/pgid；不碰真实旧目录。
        old = {'state': 'running', 'pid': 0, 'started_at': '2025-01-01T00:00:00+00:00',
               'output': str(self.root / 'a.out'), 'log': str(self.root / 'a.log'),
               'cwd': str(self.tmp), 'sandbox': 'read-only', 'session_id': 'fixture-legacy'}
        worker.write_json(self.root / 'a.json', old)
        (self.root / 'a.out').write_text('第一轮旧稿')
        self.assertEqual(self.run.state('a', self.run.cards()), 'lost')
        self.assertTrue(worker.capacity_held(old))
        self.assertEqual(self.cli('stop', self.root, 'a', '--confirm-exited').returncode, 2)
        self.ok('stop', self.root, 'a', '--confirm-exited', '--note', '负责人已核实原执行者退出')
        confirmed = self.run.receipt('a')
        self.assertEqual(self.run.state('a', self.run.cards()), 'lost')
        for key in ('by', 'at', 'note'):
            self.assertTrue(confirmed['exit_confirmation'][key])
        self.assertFalse(worker.capacity_held(confirmed))
        self.assertEqual({k: confirmed[k] for k in old}, old)
        self.start('--retry', 'a')
        self.assertEqual(self.finished()['state'], 'finished')
        archived = next((self.root / 'history').glob('a-*.json'))
        self.assertEqual(worker.read_json(archived)['exit_confirmation'], confirmed['exit_confirmation'])

    def test_a2_frozen_guard_is_stalled_and_still_holds_capacity(self):
        self.card(body='SLEEP')
        self.start()
        receipt = self.running()
        os.kill(receipt['pid'], signal.SIGSTOP)
        try:
            time.sleep(.4)
            row = self.ok('status', self.root)['cards'][0]
            self.assertEqual(row['state'], 'stalled')
            self.assertIn('看守停更', row['progress'])
            self.assertTrue(row['capacity_held'])
            self.assertTrue(worker.alive(receipt['executor_pid']))
        finally:
            os.kill(receipt['pid'], signal.SIGCONT)
            self.ok('stop', self.root, 'a')
            self.finished()

    def test_a1_confirmation_never_signals_or_rewrites_legacy_acceptance(self):
        old = self.delivery()
        old.pop('card_sha256')
        old['review'] = {'verdict': 'accepted', 'at': '2025-01-01T00:00:00Z', 'note': '旧验收'}
        worker.write_json(self.root / 'a.json', old)
        before = self.run.status()['cards'][0]
        with mock.patch.object(worker.os, 'killpg') as killing:
            self.run.stop('a', '已核实退出', confirm_exited=True)
        killing.assert_not_called()
        self.assertEqual(self.run.status()['cards'][0], before)
        self.assertEqual(self.run.receipt('a')['review'], old['review'])
        self.assertEqual(self.cli('run', self.root, '--cwd', self.tmp, '--retry', 'a').returncode, 2)

    def test_a1_confirmation_refuses_live_or_pending_new_guard(self):
        self.card()
        for fields in ({'pid': os.getpid()}, {'pid': 0, 'attempt_id': 'fixture-pending'}):
            receipt = {'state': 'running', 'started_at': worker.now(), **fields}
            worker.write_json(self.root / 'a.json', receipt)
            with self.assertRaises(ValueError):
                self.run.stop('a', '不能绕过仍活的执行者', confirm_exited=True)
            self.assertEqual(self.run.receipt('a'), receipt)
        worker.write_json(self.root / 'a.json', {'state': 'failed'})

    def test_a3_pending_stop_is_visible_even_if_guard_is_frozen(self):
        self.card(body='SLEEP')
        self.start()
        receipt = self.running()
        os.kill(receipt['pid'], signal.SIGSTOP)
        try:
            request = self.ok('stop', self.root, 'a', '--note', '停止本轮')
            self.assertEqual(self.ok('status', self.root)['cards'][0]['stop_requested'], request['stop_requested'])
        finally:
            os.kill(receipt['pid'], signal.SIGCONT)
            self.finished()

    def test_a3_deadline_stops_executor_while_dispatch_lock_is_held(self):
        self.card(body='SLEEP')
        self.start('--seconds', '.8')
        receipt = self.running()
        with self.run.lock():
            time.sleep(1.1)
            self.assertTrue(worker.executor_group_free(receipt), '共享锁不能延后执行硬上限')
        self.assertEqual(self.finished()['state'], 'timed_out')

    def test_a3_stop_request_reaches_guard_while_dispatch_lock_is_held(self):
        self.card(body='SLEEP')
        self.start()
        receipt = self.running()
        with self.run.lock():
            proc = subprocess.Popen([sys.executable, '-B', str(WORKER), 'stop', str(self.root), 'a'],
                                    env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                out, err = proc.communicate(timeout=.8)
                self.assertEqual(proc.returncode, 0, out + err)
                self.until(lambda: worker.executor_group_free(receipt), timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                self.fail('stop 被共享锁阻塞')
        self.assertEqual(self.finished()['state'], 'stopped')

    def test_a3_citation_check_runs_outside_dispatch_lock(self):
        self.delivery()
        def slow_check(output):
            try:
                with self.run.lock():
                    pass
            except ValueError:
                self.fail('慢出处核查仍持有调度锁')
            return {'citations': [], 'bad': 0, 'no_source': 0}
        with mock.patch.object(worker, 'check', side_effect=slow_check):
            self.run.review('a', 'accepted', '抽查', hold=True)
        self.assertEqual(self.run.state('a', self.run.cards()), 'accepted')

    def test_a3_review_rejects_changes_during_unlocked_citation_check(self):
        self.delivery()
        def changed(output):
            output.write_text('核查期间改动正文')
            return {'citations': [], 'bad': 0, 'no_source': 0}
        with mock.patch.object(worker, 'check', side_effect=changed):
            with self.assertRaisesRegex(ValueError, '版本已变化'):
                self.run.review('a', 'accepted', '抽查', hold=True)
        self.assertNotIn('review', self.run.receipt('a'))
        self.assertFalse((self.root / '.accepted').exists())

    def test_a4_residual_group_remains_supervised_and_stop_survives_guard_death(self):
        self.card(body='LEAVE_CHILD')
        self.start()
        self.until(lambda: 'child pid:' in (self.run.receipt('a') or {}).get('heartbeat', {}).get('last_output', ''))
        receipt = self.run.receipt('a')
        self.owned.append(receipt)
        time.sleep(.4)
        current = self.run.receipt('a')
        self.assertIn(current['state'], worker.ACTIVE_STATES, '主进程退出后仍应监管残留进程组')
        self.assertTrue(worker.capacity_held(current))
        os.kill(receipt['pid'], signal.SIGKILL)
        self.until(lambda: not worker.alive(receipt['pid']))
        stopped = self.ok('stop', self.root, 'a', '--note', '清理残留子进程')
        self.assertTrue(stopped['requested'])
        self.until(lambda: worker.executor_group_free(current))
        self.assertEqual(self.run.receipt('a')['state'], 'stopped')

    def test_a5_guard_popen_failure_is_terminal_and_does_not_hold_capacity(self):
        self.card()
        with mock.patch.object(worker, 'lean_args', return_value=([], [])), \
                mock.patch.object(worker.subprocess, 'Popen', side_effect=OSError('fixture spawn failure')):
            with self.assertRaises(OSError):
                self.run.run(self.tmp, 5, None, None, [])
        receipt = self.run.receipt('a')
        self.assertEqual(receipt['state'], 'failed')
        self.assertIn('fixture spawn failure', receipt['error'])
        self.assertTrue(receipt['ended_at'])
        self.assertFalse(worker.capacity_held(receipt))

    def test_a4_unknown_or_reused_group_identity_never_receives_signal(self):
        receipt = {'executor_pid': 123, 'executor_pgid': 123, 'executor_identity': {'123': 'old-start'}}
        with mock.patch.object(worker, 'executor_group_free', return_value=False), \
                mock.patch.object(worker, 'executor_identity', return_value={'123': 'new-start'}), \
                mock.patch.object(worker.os, 'killpg') as killing:
            with self.assertRaisesRegex(ValueError, '身份未能确认'):
                worker.stop_confirmed_group(receipt)
        killing.assert_not_called()

    def test_a4_terminal_receipt_with_confirmed_residual_group_can_stop(self):
        self.card(body='LEAVE_CHILD')
        self.start()
        self.until(lambda: 'child pid:' in (self.run.receipt('a') or {}).get('heartbeat', {}).get('last_output', ''))
        receipt = self.run.receipt('a')
        os.kill(receipt['pid'], signal.SIGKILL)
        self.until(lambda: not worker.alive(receipt['pid']))
        receipt = self.run.receipt('a')
        receipt['state'] = 'finished'
        worker.write_json(self.root / 'a.json', receipt)
        self.ok('stop', self.root, 'a')
        self.assertTrue(worker.executor_group_free(receipt))
        self.assertEqual(self.run.receipt('a')['state'], 'stopped')

    def test_a6_collect_exception_does_not_lose_terminal_receipt(self):
        self.card(body='结果：result-v1\n任务')
        prompt = self.root / 'a.prompt'
        prompt.write_text('任务')
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'fixture-read-error', 'started_at': worker.now(),
                   'cwd': str(self.tmp), 'prompt': str(prompt), 'output': str(self.root / 'a.out'),
                   'log': str(self.root / 'a.log'), 'result_contract': {'version': 'result-v1', 'expected': None}}
        worker.write_json(self.root / 'a.json', receipt)
        caught = None
        with mock.patch.object(result_contract, 'collect', side_effect=PermissionError('fixture unreadable')):
            try:
                worker.guard(self.root, 'a', 5, [str(self.fake), 'exec', '-o', receipt['output']],
                             receipt['attempt_id'], .05)
            except PermissionError as error:
                caught = error
        final = self.run.receipt('a')
        self.assertEqual(final['state'], 'finished', str(caught))
        self.assertEqual(final['result']['status'], 'protocol_error')
        self.assertIn('fixture unreadable', ' '.join(final['result']['errors']))
        self.assertEqual(final['exit_code'], 0)
        self.assertEqual(final['tokens'], 1234)
        self.assertTrue(final['ended_at'])

    def test_a7_chinese_gap_ids_match_exactly(self):
        output = self.root / 'partial.out'
        output.write_text('```json\n' + json.dumps({'status': 'partial', 'questions': [],
            'covered': ['样本二'], 'skipped': [{'id': '样本', 'reason': '缺输入'}]}, ensure_ascii=False) + '\n```')
        receipt = {'output': str(output), 'result_contract': {'version': 'result-v1', 'expected': ['样本', '样本二']}}
        with self.assertRaisesRegex(ValueError, '样本'):
            result_contract.acceptance(receipt, '接受 样本二 缺口', True)
        self.assertEqual(result_contract.acceptance(receipt, '接受「样本」缺口', True)['accepted_gaps'][0]['id'], '样本')

    def test_a8_blocked_and_partial_resume_with_previous_gaps(self):
        for status in ('blocked', 'partial'):
            with self.subTest(status=status):
                name = status
                old = self.delivery(name)
                old['result'] = {'status': status, 'questions': ['请补样本路径'],
                                 'covered': [], 'skipped': [{'id': 'sample', 'reason': '缺少样本内容'}]}
                worker.write_json(self.root / f'{name}.json', old)
                self.card(name, '负责人补答：当前样本已提供')
                self.start('--retry', name)
                final = self.finished(name)
                call = self.calls()[-1]
                self.assertEqual(call['args'][:3], ['exec', 'resume', 'fixture-original'])
                self.assertIn('请补样本路径', call['prompt'])
                self.assertIn('缺少样本内容', call['prompt'])
                self.assertIn('当前样本已提供', call['prompt'])
                self.assertEqual(final['tokens'], 234)

    def test_a9_resume_and_fresh_use_current_frozen_dependency(self):
        self.delivery('base', '依赖第一稿')
        first = self.run.review('base', 'accepted', '第一稿通过', hold=True)
        self.delivery('a')
        self.card('a', '依赖：base\n下游任务')
        self.run.review('a', 'rejected', '更新引用', hold=True)
        (self.root / 'base.out').write_text('依赖第二稿')
        second = self.run.review('base', 'accepted', '第二稿通过', hold=True)
        for fresh in (False, True):
            with self.subTest(fresh=fresh):
                self.start('--retry', 'a', *(['--fresh'] if fresh else []))
                self.finished()
                prompt = self.calls()[-1]['prompt']
                self.assertIn(second['accepted_output'], prompt)
                self.assertNotIn(first['accepted_output'], prompt)
                self.assertIn('- base：' + second['accepted_output'], prompt)
                self.run.review('a', 'rejected', '再核一次', hold=True)

    def test_a8_blocked_model_change_needs_fresh_and_fresh_keeps_gaps(self):
        old = self.delivery()
        old['result'] = {'status': 'blocked', 'questions': ['请补样本路径'],
                         'covered': [], 'skipped': [{'id': 'sample', 'reason': '缺样本'}]}
        worker.write_json(self.root / 'a.json', old)
        before = (self.root / 'a.json').read_bytes()
        refused = self.cli('run', self.root, '--cwd', self.tmp, '--retry', 'a', '--model', 'fixture-other')
        self.assertEqual(refused.returncode, 2)
        self.assertIn('--fresh', refused.stderr)
        self.assertEqual((self.root / 'a.json').read_bytes(), before)
        self.assertFalse((self.root / 'history').exists())
        self.start('--retry', 'a', '--fresh', '--model', 'fixture-other')
        final = self.finished()
        self.assertNotIn('resume', self.calls()[-1]['args'])
        self.assertIn('请补样本路径', self.calls()[-1]['prompt'])
        self.assertIn('缺样本', self.calls()[-1]['prompt'])
        self.assertEqual(final['fresh_after'], 'fixture-original')
        self.assertEqual(final['tokens'], 1234)

    def test_a10_stale_reject_and_retry_keep_original_acceptance_event(self):
        self.delivery()
        self.run.review('a', 'accepted', '原验收说明', hold=True)
        original = self.run.receipt('a')['review']
        (self.root / 'a.out').write_text('后续改稿')
        self.assertEqual(self.run.state('a', self.run.cards()), 'stale')
        self.run.review('a', 'rejected', '需要重做', hold=True)
        self.assertIn(original, self.run.receipt('a').get('review_history', []))
        self.start('--retry', 'a')
        self.finished()
        archive = worker.read_json(next((self.root / 'history').glob('a-*.json')))
        self.assertIn(original, archive['review_history'])
        self.assertEqual(Path(original['accepted_output']).read_text(), '旧稿')

    def test_a11_queued_fresh_keeps_receipt_for_dependency_and_capacity(self):
        self.delivery()
        self.run.review('a', 'rejected', '保留这次退回', hold=True)
        original = (self.root / 'a.json').read_bytes()
        self.card('base', 'SLEEP')
        self.card('a', '依赖：base\n下游任务')
        self.start('--retry', 'a', '--fresh', '--max-parallel', '1')
        self.assertEqual((self.root / 'a.json').read_bytes(), original)
        self.assertFalse((self.root / 'history').exists())
        self.until(lambda: bool((self.run.receipt('base') or {}).get('heartbeat', {}).get('log_bytes')))
        self.card('a', '不依赖前序')
        self.start('--retry', 'a', '--fresh', '--max-parallel', '1')
        self.assertEqual((self.root / 'a.json').read_bytes(), original)
        self.assertFalse((self.root / 'history').exists())
        self.ok('stop', self.root, 'base')
        self.finished('base')


if __name__ == '__main__':
    unittest.main()
