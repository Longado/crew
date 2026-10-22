"""L6b 派发与进度回归：只用临时目录和假 Codex，不调用模型。"""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import result_contract
import runs_registry
import worker


FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
if 'mcp' in args:
    print('[]')
    sys.exit(0)
prompt = sys.stdin.read()
output = Path(args[args.index('-o') + 1])
with open(os.environ['FAKE_LOG'], 'a') as stream:
    stream.write(json.dumps({'args': args, 'prompt': prompt, 'cwd': os.getcwd()}) + '\n')
session = args[2] if 'resume' in args else 'fixture-' + output.stem
tokens = int(os.environ.get('FAKE_TOKENS', '10200' if 'resume' in args else '1200' if 'fork' in args else '9000'))
print('session id: ' + session, flush=True)
print('tokens used\n' + str(tokens), flush=True)
output.write_text('## 结论卡\n问题／本次结论：假执行者交付。\n')
'''


class DispatchL6bTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lead-l6b-')
        self.tmp = Path(self.temp.name).resolve()
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        self.fake = self.tmp / 'fake-codex'
        self.fake.write_text(FAKE_CODEX)
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(self.fake),
                    'CREW_HOME': str(self.tmp / 'crew'), 'CODEX_HOME': str(self.tmp / 'codex'),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.patch = mock.patch.dict(os.environ, {k: self.env[k] for k in
                                    ('CREW_HOME', 'CODEX_HOME', 'CREW_CODEX_BIN', 'FAKE_LOG')})
        self.patch.start()

    def tearDown(self):
        # 即使用例断言失败，也只收掉本用例创建的看守，再清理临时文件。
        for path in self.root.glob('*.json'):
            receipt = worker.read_json(path)
            if isinstance(receipt, dict) and receipt.get('attempt_id') and receipt.get('state') in worker.ACTIVE_STATES:
                self.cli('stop', self.root, path.stem)
                self.finish(path.stem)
        self.patch.stop()
        self.temp.cleanup()

    def card(self, name='a', body='任务正文'):
        (self.root / 'cards' / f'{name}.md').write_text(body)

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', worker.__file__, *map(str, args)],
                              env=self.env, cwd=self.tmp, capture_output=True, text=True, timeout=15)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start(self, *args):
        return self.ok('run', self.root, *args)

    def finish(self, name='a'):
        end = time.monotonic() + 6
        while time.monotonic() < end:
            receipt = self.run.receipt(name) or {}
            if receipt.get('state') not in (None, *worker.ACTIVE_STATES):
                return receipt
            time.sleep(.02)
        self.fail('假执行者未按期结束：' + name)

    def calls(self):
        log = Path(self.env['FAKE_LOG'])
        return [json.loads(line) for line in log.read_text().splitlines()] if log.is_file() else []

    def reject(self, name='a'):
        self.finish(name)
        self.ok('reject', self.root, name, '--note', '补充依据')

    def accepted(self, *args):
        self.card(body='可写：file.txt\n任务正文' if '--write' in args else '任务正文')
        self.start('--cwd', self.work, '--model', 'fixture-model', *args)
        self.finish()
        self.ok('accept', self.root, 'a', '--note', '已核对', '--hold')

    def test_e1_live_guard_with_old_heartbeat_is_stalled(self):
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        receipt = {'state': 'running', 'pid': os.getpid(), 'started_at': old,
                   'heartbeat': {'at': old}, 'heartbeat_seconds': 30}
        self.assertEqual(worker.receipt_state(receipt), 'stalled')
        self.assertIn('看守停更', worker.progress(receipt)[2])
        self.assertTrue(worker.capacity_held(receipt))
        self.assertEqual(receipt['state'], 'running', '读状态不改看守回执')
        with mock.patch.object(worker, 'alive', return_value=False):
            self.assertEqual(worker.receipt_state(receipt), 'lost')

    def test_e1_guard_and_output_stalls_share_one_notification_until_output_changes(self):
        self.card()
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        receipt = {'state': 'running', 'pid': os.getpid(), 'started_at': old,
                   'heartbeat': {'at': old, 'log_mtime': old}, 'heartbeat_seconds': 30}
        worker.write_json(self.root / 'a.json', receipt)
        self.assertEqual(worker.poll_wait(self.run)[0], ['a'])
        # 看守恢复落盘，但执行者仍无新输出；不应把它当成另一轮停滞。
        receipt.update(state='stalled', stalled_at=worker.now())
        receipt['heartbeat']['at'] = worker.now()
        worker.write_json(self.root / 'a.json', receipt)
        self.assertEqual(worker.poll_wait(self.run), ([], True))
        receipt['heartbeat']['at'] = old
        worker.write_json(self.root / 'a.json', receipt)
        self.assertEqual(worker.poll_wait(self.run), ([], True))
        # 新输出后再次停滞是新事件，仍只通知一次。
        receipt['heartbeat']['log_mtime'] = worker.now()
        worker.write_json(self.root / 'a.json', receipt)
        self.assertEqual(worker.poll_wait(self.run), (['a'], True))
        self.assertEqual(worker.poll_wait(self.run), ([], True))

    def test_e2_append_inherits_run_settings_and_limits(self):
        self.card()
        self.start('--cwd', self.work, '--model', 'fixture-model', '--effort', 'xhigh',
                   '--minutes', '2', '--stall-minutes', '3', '--max-parallel', '1')
        self.finish()
        self.card('b')
        self.start()
        receipt = self.finish('b')
        self.assertEqual((receipt['cwd'], receipt['model'], receipt['effort']),
                         (str(self.work), 'fixture-model', 'xhigh'))
        meta = worker.read_json(self.root / 'run.json')
        self.assertEqual((meta['minutes'], meta['stall_seconds'], meta['max_parallel']), (2, 180, 1))
        self.assertEqual(self.calls()[-1]['cwd'], str(self.work))

    def test_e2_retry_inherits_receipt_even_after_run_defaults_change(self):
        self.card()
        self.start('--cwd', self.work, '--model', 'first-model', '--effort', 'xhigh')
        self.reject()
        other = self.tmp / 'other'
        other.mkdir()
        self.card('b')
        self.start('--cwd', other, '--model', 'second-model', '--effort', 'low')
        self.finish('b')
        self.start('--retry', 'a')
        receipt = self.finish()
        self.assertEqual((receipt['cwd'], receipt['model'], receipt['effort']),
                         (str(self.work), 'first-model', 'xhigh'))
        self.assertEqual(self.calls()[-1]['args'][:3], ['exec', 'resume', 'fixture-a'])
        self.assertIn('cwd=' + json.dumps(str(self.work)), self.calls()[-1]['args'])

    def test_e2_retry_does_not_need_unused_run_directory_to_exist(self):
        self.card()
        self.start('--cwd', self.work)
        self.reject()
        meta = worker.read_json(self.root / 'run.json')
        meta['cwd'] = str(self.tmp / 'removed-work')
        worker.write_json(self.root / 'run.json', meta)
        self.start('--retry', 'a')
        self.assertEqual(self.finish()['cwd'], str(self.work))

    def test_e2_write_dispatch_requires_explicit_flag_with_clear_deferral(self):
        self.card(body='可写：file.txt\n任务正文')
        self.start('--cwd', self.work, '--write')
        self.reject()
        before = self.run.receipt('a')
        for args in ((), ('--retry', 'a')):
            result = self.cli('run', self.root, *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(data['dispatched'], [])
            self.assertEqual(data['deferred'], [{'card': 'a', 'reason': '写卡需要 --write'}] if args else [])
            self.assertEqual(self.run.receipt('a'), before)
        self.start('--write', '--retry', 'a')
        self.assertEqual(self.finish()['sandbox'], 'danger-full-access')

    def test_e3_card_settings_override_run_and_auto_dispatch(self):
        self.card('a', '# 上游\n模型：card-model\n档位：max\n任务')
        self.card('b', '依赖：a\n模型：next-model\n档位：ultra\n任务')
        self.start('--cwd', self.work, '--model', 'run-model', '--effort', 'low')
        self.assertEqual(self.finish()['model'], 'card-model')
        self.ok('accept', self.root, 'a', '--note', '已核对')
        receipt = self.finish('b')
        self.assertEqual((receipt['model'], receipt['effort']), ('next-model', 'ultra'))
        self.assertIn('model_reasoning_effort=ultra', self.calls()[-1]['args'])
        self.assertEqual(worker.read_json(self.root / 'run.json')['model'], 'run-model')

    def test_e3_changed_card_model_requires_fresh_before_archiving(self):
        self.card(body='模型：first-model\n任务')
        self.start('--cwd', self.work)
        self.reject()
        original = self.run.receipt('a')
        self.card(body='模型：second-model\n任务')
        result = self.cli('run', self.root, '--retry', 'a')
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn('--fresh', result.stderr)
        self.assertEqual(self.run.receipt('a'), original)
        self.assertFalse((self.root / 'history').exists())
        self.start('--retry', 'a', '--fresh')
        self.assertEqual(self.finish()['model'], 'second-model')

    def test_e3_headers_do_not_disable_result_contract_or_read_body_examples(self):
        body = '# 示例\n模型：fixture-model\n档位：max\n特性：multi_agent_v2\n接续：a\n结果：result-v1\n覆盖：C1\n依赖：a\n\n正文'
        self.assertEqual(result_contract.from_card(body), {'version': 'result-v1', 'expected': ['C1']})
        self.card(body='任务正文\n模型：example-only\n档位：ultra')
        self.start('--cwd', self.work, '--model', 'run-model')
        self.assertEqual(self.finish()['model'], 'run-model')

    def test_e3_invalid_effort_fails_before_dispatch(self):
        self.card(body='档位：typo\n任务')
        result = self.cli('run', self.root)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn('档位', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_e4_features_forwarded_saved_inherited_and_card_override(self):
        self.card()
        self.start('--cwd', self.work, '--enable', 'multi_agent_v2', '--enable', 'shell_tool')
        receipt = self.finish()
        self.assertEqual(receipt['features'], ['multi_agent_v2', 'shell_tool'])
        self.assertEqual(worker.read_json(self.root / 'run.json')['features'], receipt['features'])
        for name in receipt['features']:
            self.assertIn('features.' + name + '=true', self.calls()[-1]['args'])
        self.card('b', '依赖：a\n特性：feature_b, feature_a\n任务')
        self.ok('accept', self.root, 'a', '--note', '已核对')
        self.assertEqual(self.finish('b')['features'], ['feature_a', 'feature_b'])
        self.assertNotIn('features.multi_agent_v2=true', self.calls()[-1]['args'])
        self.card('c')
        self.start()
        self.assertEqual(self.finish('c')['features'], receipt['features'])

    def test_e4_invalid_feature_names_fail_before_dispatch(self):
        for name in ('MixedCase', 'a.b', 'a-b', 'x=true', 'bad name'):
            with self.subTest(name=name):
                self.card(body='特性：' + name + '\n任务')
                result = self.cli('run', self.root)
                self.assertEqual(result.returncode, 2, result.stdout)
        self.assertEqual(self.calls(), [])

    def test_e4_retry_checks_effective_features(self):
        self.card()
        self.start('--cwd', self.work, '--enable', 'feature_a')
        self.reject()
        original = self.run.receipt('a')
        result = self.cli('run', self.root, '--retry', 'a', '--enable', 'feature_b')
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn('特性', result.stderr)
        self.assertEqual(self.run.receipt('a'), original)
        self.start('--retry', 'a')
        self.assertEqual(self.finish()['features'], ['feature_a'])

    def test_e4_cli_validation_and_empty_card_override(self):
        self.card(body='特性：\n任务')
        result = self.cli('run', self.root, '--enable', 'bad.name')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.calls(), [])
        self.start('--enable', 'feature_a')
        self.assertEqual(self.finish()['features'], [])
        self.assertNotIn('features.feature_a=true', self.calls()[-1]['args'])

    def test_e5_accept_resumes_once_and_refuses_second_child(self):
        self.card()
        self.card('b', '依赖：a\n接续：a\n任务 B')
        self.start('--cwd', self.work, '--model', 'fixture-model')
        self.finish()
        result = self.ok('accept', self.root, 'a', '--note', '已核对')
        self.assertEqual(result['dispatched'], ['b'])
        upstream = self.run.receipt('a')
        self.assertEqual(upstream['continued_by'], 'b')
        receipt = self.finish('b')
        self.assertEqual(receipt.get('continued_from'), {'card': 'a', 'session_id': 'fixture-a'})
        self.assertEqual(receipt['session_id'], 'fixture-a')
        self.assertEqual((receipt['tokens'], receipt['tokens_session']), (1200, 10200))
        self.assertEqual(receipt['tokens_before'], 9000)
        self.assertEqual(receipt['resumed_from'], 'fixture-a')
        call = self.calls()[-1]
        self.assertEqual(call['args'][:3], ['exec', 'resume', 'fixture-a'])
        self.assertNotIn('-C', call['args'])
        self.assertNotIn('-s', call['args'])
        self.assertIn('cwd=' + json.dumps(str(self.work)), call['args'])
        self.assertIn('sandbox_mode="read-only"', call['args'])
        self.assertIn(upstream['review']['accepted_output'], call['prompt'])
        self.assertIn('接续：a', call['prompt'])
        self.card('c', '依赖：a\n接续：a\n任务 C')
        calls = self.calls()
        refused = self.cli('run', self.root)
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertIn('接续：b', refused.stderr)
        self.assertIn('链式', refused.stderr)
        self.assertIn('依赖：', refused.stderr)
        self.assertEqual(self.calls(), calls)
        self.assertIsNone(self.run.receipt('c'))
        self.assertEqual(self.run.receipt('a'), upstream)
        self.card('c', '依赖：b\n接续：b\n任务 C')
        self.reject('b')
        self.env['FAKE_TOKENS'] = '10500'
        self.start('--retry', 'b')
        receipt = self.finish('b')
        self.assertEqual(self.calls()[-1]['args'][:3], ['exec', 'resume', 'fixture-a'])
        self.assertEqual(receipt['tokens'], 300)

    def test_e5_continuation_must_be_a_dependency(self):
        self.card()
        self.card('b', '接续：a\n任务')
        result = self.cli('run', self.root)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn('依赖', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_e5_write_resume_and_explicit_fresh_retry(self):
        self.accepted('--write')
        self.card('b', '依赖：a\n接续：a\n可写：file.txt\n任务')
        self.start('--write')
        receipt = self.finish('b')
        self.assertEqual(receipt['continued_from']['card'], 'a')
        self.assertEqual(self.calls()[-1]['args'][:3], ['exec', 'resume', 'fixture-a'])
        self.assertIn('sandbox_mode="danger-full-access"', self.calls()[-1]['args'])
        self.assertIn('只改任务卡「可写」', self.calls()[-1]['prompt'])
        self.reject('b')
        self.start('--write', '--retry', 'b', '--fresh')
        receipt = self.finish('b')
        self.assertNotIn('continued_from', receipt)
        self.assertNotIn('fork', self.calls()[-1]['args'])
        self.assertNotIn('resume', self.calls()[-1]['args'])
        self.assertEqual(receipt['fresh_after'], 'fixture-a')

    def test_e5_continuation_checks_cwd_model_sandbox_features(self):
        self.accepted()
        self.card('b', '依赖：a\n接续：a\n任务')
        original = self.run.receipt('a')
        for field, value in (('cwd', str(self.tmp)), ('model', 'other-model'),
                             ('sandbox', 'danger-full-access'), ('features', ['feature_a'])):
            with self.subTest(field=field):
                worker.write_json(self.root / 'a.json', {**original, field: value})
                result = self.cli('run', self.root)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('接续', result.stderr)
                self.assertFalse((self.root / 'b.json').exists())
        worker.write_json(self.root / 'a.json', original)

    def test_e5_missing_session_or_frozen_output_refuses_resume(self):
        self.accepted()
        self.card('b', '依赖：a\n接续：a\n任务')
        original = self.run.receipt('a')
        for missing in ('session_id', 'accepted_output'):
            receipt = json.loads(json.dumps(original))
            (receipt if missing == 'session_id' else receipt['review']).pop(missing)
            worker.write_json(self.root / 'a.json', receipt)
            result = self.cli('run', self.root)
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn('接续', result.stderr)
        worker.write_json(self.root / 'a.json', original)

    def test_e6_last_output_skips_hooks_blank_lines_and_fences(self):
        log = self.tmp / 'progress.log'
        log.write_text('正在核对来源\n```python\n```\n~~~\n\nhook: PostToolUse Completed\n')
        heartbeat = worker.log_heartbeat({'started_at': worker.now()}, log)
        self.assertEqual(heartbeat['last_output'], '正在核对来源')

    def test_e6_only_noise_does_not_reuse_old_hook_as_last_output(self):
        log = self.tmp / 'progress.log'
        log.write_text('hook: PostToolUse Completed\n```\n')
        receipt = {'started_at': worker.now(), 'heartbeat': {'last_output': 'hook: Earlier'}}
        self.assertEqual(worker.log_heartbeat(receipt, log)['last_output'], '')
        receipt['heartbeat']['last_output'] = '上次有效进度'
        self.assertEqual(worker.log_heartbeat(receipt, log)['last_output'], '上次有效进度')

    def test_e6_native_tokens_update_before_executor_finishes(self):
        log = self.tmp / 'progress.log'
        log.write_text('session id: fixture-live\n' + '材料\n' * 30000)
        native = Path(self.env['CODEX_HOME']) / 'sessions' / 'year' / 'rollout-date-fixture-live.jsonl'
        native.parent.mkdir(parents=True)
        def event(tokens):
            return json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count',
                               'info': {'total_token_usage': {'total_tokens': tokens}}}}) + '\n'
        native.write_text(event(1000) + event(1400) + '{incomplete')
        receipt = {'started_at': worker.now(), 'tokens_before': 1000}
        first = worker.log_heartbeat(receipt, log)
        self.assertEqual((first['tokens_session'], first['tokens']), (1400, 400))
        receipt['heartbeat'] = first
        native.write_text(event(1800))
        self.assertEqual(worker.log_heartbeat(receipt, log)['tokens'], 800)
        log.write_text('session id: fixture-live\ntokens used\n2,000\n')
        self.assertEqual(worker.log_heartbeat(receipt, log)['tokens'], 1000)

    def test_e6_missing_or_bad_native_log_keeps_unknown(self):
        log = self.tmp / 'progress.log'
        log.write_text('session id: fixture-missing\n')
        self.assertIsNone(worker.log_heartbeat({'started_at': worker.now()}, log)['tokens'])
        with mock.patch.object(Path, 'glob', side_effect=PermissionError('不可读')):
            self.assertIsNone(worker.log_heartbeat({'started_at': worker.now()}, log)['tokens'])

    def test_e7_cross_run_write_warning_lists_run_and_card_without_refusing(self):
        other = self.tmp / 'other-run'
        (other / 'cards').mkdir(parents=True)
        (other / 'cards' / 'busy.md').write_text('可写：file.txt\n任务')
        worker.write_json(other / 'run.json', {'cwd': str(self.work), 'write': True})
        worker.write_json(other / 'busy.json', {'state': 'running', 'pid': os.getpid(),
                          'started_at': worker.now(), 'cwd': str(self.work), 'sandbox': 'danger-full-access'})
        runs_registry.register(other)
        self.card()
        result = self.start('--cwd', self.work, '--write')
        self.assertIn('warnings', result)
        self.assertIn(str(other), json.dumps(result['warnings']))
        self.assertIn('busy', json.dumps(result['warnings']))
        self.assertEqual(self.finish()['state'], 'finished')

    def test_e7_unreadable_registry_does_not_prevent_write_dispatch(self):
        Path(self.env['CREW_HOME']).write_text('不是目录')
        self.card()
        self.start('--cwd', self.work, '--write')
        self.assertEqual(self.finish()['state'], 'finished')

    def test_e7_stale_heartbeat_live_writer_still_warns(self):
        other = self.tmp / 'other-run'
        (other / 'cards').mkdir(parents=True)
        (other / 'cards' / 'busy.md').write_text('任务')
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        worker.write_json(other / 'busy.json', {'state': 'running', 'pid': os.getpid(),
                          'started_at': old, 'heartbeat': {'at': old},
                          'cwd': str(self.work), 'sandbox': 'danger-full-access'})
        runs_registry.register(other)
        self.card()
        result = self.start('--cwd', self.work, '--write')
        self.assertIn('busy', json.dumps(result['warnings']))
        self.assertEqual(self.finish()['state'], 'finished')


if __name__ == '__main__':
    unittest.main()
