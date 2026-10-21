"""L6c 进度用量回归：临时目录、假 Codex，不调用模型。"""
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


FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
if 'mcp' in args:
    print('[]')
    sys.exit(0)
sys.stdin.read()
mode = args[1] if args[1] in ('resume', 'fork') else 'new'
session = args[2] if mode == 'resume' else 'fixture-' + mode
usage = ({'input_tokens': 90000, 'cached_input_tokens': 58000, 'output_tokens': 8000,
          'total_tokens': 98000} if mode == 'resume' else
         {'input_tokens': 60000, 'cached_input_tokens': 40000, 'output_tokens': 5000,
          'total_tokens': 65000})
native = Path(os.environ['CODEX_HOME']) / 'sessions' / ('rollout-date-' + session + '.jsonl')
native.parent.mkdir(parents=True, exist_ok=True)
with native.open('a') as stream:
    stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count',
                            'info': {'total_token_usage': usage}}}) + '\n')
with open(os.environ['FAKE_LOG'], 'a') as stream:
    stream.write(json.dumps({'args': args, 'mode': mode, 'session': session}) + '\n')
print('session id: ' + session, flush=True)
release = Path(os.environ['FAKE_RELEASE'])
deadline = time.monotonic() + 10
while not release.is_file():
    if time.monotonic() > deadline:
        sys.exit('测试未释放假执行者')
    time.sleep(.02)
print('tokens used\n' + str(usage['input_tokens'] - usage['cached_input_tokens'] + usage['output_tokens']), flush=True)
Path(args[args.index('-o') + 1]).write_text('## 结论卡\n假执行者交付。\n')
'''


class TokensL6cTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lead-l6c-')
        self.tmp = Path(self.temp.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX)
        fake.chmod(0o755)
        self.release = self.tmp / 'release'
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'crew'),
                    'CREW_CODEX_BIN': str(fake), 'CODEX_HOME': str(self.tmp / 'codex'),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'FAKE_RELEASE': str(self.release),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        self.patch = mock.patch.dict(os.environ, self.env)
        self.patch.start()

    def tearDown(self):
        self.release.touch()
        try:
            if self.run.receipt('a'):
                self.wait_for(lambda r: r.get('state') not in worker.ACTIVE_STATES)
        finally:
            self.patch.stop()
            self.temp.cleanup()

    def cli(self, *args):
        result = subprocess.run([sys.executable, '-B', worker.__file__, *map(str, args)],
                                env=self.env, cwd=self.tmp, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def wait_for(self, predicate):
        end = time.monotonic() + 6
        while time.monotonic() < end:
            receipt = self.run.receipt('a') or {}
            if predicate(receipt):
                return receipt
            time.sleep(.02)
        self.fail('假执行者状态未按期更新：' + repr(receipt))

    def native(self, usage):
        path = Path(self.env['CODEX_HOME']) / 'sessions' / 'rollout-date-fixture-live.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'type': 'event_msg', 'payload': {'type': 'token_count',
                                   'info': {'total_token_usage': usage}}}) + '\n{incomplete')

    def test_f2_native_usage_excludes_cache_and_does_not_add_reasoning_twice(self):
        self.native({'input_tokens': 60000, 'cached_input_tokens': 40000,
                     'output_tokens': 5000, 'reasoning_output_tokens': 3000, 'total_tokens': 65000})
        self.assertEqual(worker.native_tokens('fixture-live'), 25000)

    def test_f2_resume_heartbeat_subtracts_same_basis_and_keeps_last_known_value(self):
        self.native({'input_tokens': 90000, 'cached_input_tokens': 58000,
                     'output_tokens': 8000, 'total_tokens': 98000})
        log = self.tmp / 'progress.log'
        log.write_text('session id: fixture-live\n正在核对材料\n')
        receipt = {'started_at': worker.now(), 'tokens_before': 25000}
        first = worker.log_heartbeat(receipt, log)
        self.assertEqual((first['tokens_session'], first['tokens']), (40000, 15000))
        receipt['heartbeat'] = first
        self.native({'input_tokens': '坏数据', 'cached_input_tokens': 58000,
                     'output_tokens': 8000, 'total_tokens': 98000})
        self.assertEqual(worker.log_heartbeat(receipt, log)['tokens'], 15000)

    def test_f2_incomplete_or_invalid_components_do_not_fall_back_to_cached_total(self):
        for usage in (
            {'input_tokens': 10, 'output_tokens': 2, 'total_tokens': 12},
            {'input_tokens': 10, 'cached_input_tokens': 11, 'output_tokens': 2, 'total_tokens': 12},
            {'input_tokens': 10, 'cached_input_tokens': -1, 'output_tokens': 2, 'total_tokens': 12},
            {'input_tokens': 10, 'cached_input_tokens': True, 'output_tokens': 2, 'total_tokens': 12},
        ):
            with self.subTest(usage=usage):
                self.native(usage)
                self.assertIsNone(worker.native_tokens('fixture-live'))

    def test_f2_zero_cache_and_legacy_total_only_remain_readable(self):
        self.native({'input_tokens': 10, 'cached_input_tokens': 0, 'output_tokens': 2, 'total_tokens': 12})
        self.assertEqual(worker.native_tokens('fixture-live'), 12)
        self.native({'total_tokens': 12})
        self.assertEqual(worker.native_tokens('fixture-live'), 12)

    def test_f2_live_guard_and_retry_match_final_receipt(self):
        (self.root / 'cards' / 'a.md').write_text('任务正文')
        for retry, expected, mode in ((False, 25000, 'new'), (True, 15000, 'resume')):
            with self.subTest(mode=mode):
                if retry:
                    self.cli('reject', self.root, 'a', '--note', '补充依据')
                    self.release.unlink()
                self.cli('run', self.root, '--cwd', self.tmp, '--heartbeat-seconds', '.02',
                         *(['--retry', 'a'] if retry else []))
                running = self.wait_for(lambda r: r.get('heartbeat', {}).get('last_output', '').startswith('session id:'))
                self.release.touch()
                finished = self.wait_for(lambda r: r.get('state') not in worker.ACTIVE_STATES)
                self.assertEqual(running['state'], 'running')
                self.assertEqual(running['heartbeat']['tokens'], expected)
                self.assertEqual(finished['state'], 'finished')
                self.assertEqual(finished['tokens'], expected)
                self.assertEqual(finished['heartbeat']['tokens'], expected)
                call = json.loads(Path(self.env['FAKE_LOG']).read_text().splitlines()[-1])
                self.assertEqual(call['mode'], mode)
                self.assertEqual(finished['session_id'], 'fixture-new')
                if retry:
                    self.assertEqual(call['args'][:3], ['exec', 'resume', 'fixture-new'])
                    self.assertEqual(finished['tokens_before'], 25000)


class ContinuationL6cTest(unittest.TestCase):
    def setUp(self):
        # 只复用假执行者夹具，不重复收集 L6b 的测试。
        import test_worker_l6b
        self.case = test_worker_l6b.DispatchL6bTest()
        self.case.setUp()
        self.addCleanup(self.case.tearDown)
        fake = self.case.fake
        fake.write_text(fake.read_text().replace("else 'fixture-' + output.stem",
                        "else os.environ.get('FAKE_SESSION', 'fixture-' + output.stem)"))

    def child(self, name='b', parent='a'):
        case = self.case
        case.card(name, f'依赖：{parent}\n接续：{parent}\n任务 {name}')
        case.start()
        return case.finish(name)

    def test_f1_continuation_and_retry_keep_session_and_only_count_delta(self):
        case = self.case
        case.accepted()
        before = case.run.receipt('a')
        child = self.child()
        self.assertEqual(case.calls()[-1]['args'][:3], ['exec', 'resume', before['session_id']])
        self.assertEqual(child['session_id'], before['session_id'])
        self.assertEqual(child['tokens_before'], 9000)
        self.assertEqual((child['tokens'], child['tokens_session']), (1200, 10200))
        self.assertEqual(case.run.receipt('a')['continued_by'], 'b')
        case.reject('b')
        case.env['FAKE_TOKENS'] = '10500'
        case.start('--retry', 'b')
        retried = case.finish('b')
        self.assertEqual(retried['session_id'], before['session_id'])
        self.assertEqual((retried['tokens_before'], retried['tokens']), (10200, 300))
        self.assertEqual(retried['continued_from'], child['continued_from'])
        self.assertEqual(case.run.receipt('a')['tokens'], before['tokens'])

    def test_f1_chain_uses_latest_upstream_cumulative_value(self):
        case = self.case
        case.accepted()
        self.child()
        case.card('c', '依赖：b\n接续：b\n任务 C')
        case.env['FAKE_TOKENS'] = '11400'
        accepted = case.ok('accept', case.root, 'b', '--note', '已核对')
        self.assertEqual(accepted['dispatched'], ['c'])
        child = case.finish('c')
        self.assertEqual(child['session_id'], case.run.receipt('a')['session_id'])
        self.assertEqual(child['continued_from']['card'], 'b')
        self.assertEqual((child['tokens_before'], child['tokens']), (10200, 1200))
        self.assertEqual(case.run.receipt('a')['continued_by'], 'b')
        self.assertEqual(case.run.receipt('b')['continued_by'], 'c')

    def test_f1_same_wave_duplicate_claim_refused_before_dispatch(self):
        case = self.case
        case.accepted()
        for name in ('b', 'c'):
            case.card(name, f'依赖：a\n接续：a\n任务 {name}')
        upstream, calls = case.run.receipt('a'), case.calls()
        refused = case.cli('run', case.root)
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertIn('接续：b', refused.stderr)
        self.assertIn('链式', refused.stderr)
        self.assertIn('依赖：', refused.stderr)
        self.assertEqual(case.run.receipt('a'), upstream)
        self.assertEqual(case.calls(), calls)
        for name in ('b', 'c'):
            self.assertIsNone(case.run.receipt(name))
            self.assertFalse((case.root / f'{name}.prompt').exists())

    def test_f1_used_upstream_retry_requires_fresh_before_archive(self):
        case = self.case
        case.accepted()
        child = self.child()
        # 修改已验收卡让其失效，再走正式退回入口。
        case.card(body='修订后的上游任务')
        case.reject()
        before, calls = case.run.receipt('a'), case.calls()
        refused = case.cli('run', case.root, '--retry', 'a')
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertIn('--fresh', refused.stderr)
        self.assertIn('下游', refused.stderr)
        self.assertIn('b', refused.stderr)
        self.assertEqual(case.run.receipt('a'), before)
        self.assertEqual(case.calls(), calls)
        self.assertFalse((case.root / 'history').exists())
        case.env.update(FAKE_SESSION='fixture-fresh', FAKE_TOKENS='2000')
        case.start('--retry', 'a', '--fresh')
        fresh = case.finish()
        self.assertEqual(fresh['fresh_after'], before['session_id'])
        self.assertEqual(fresh['session_id'], 'fixture-fresh')
        self.assertEqual(fresh['tokens'], 2000)
        self.assertNotIn('continued_by', fresh)
        self.assertNotIn('resumed_from', fresh)
        self.assertNotIn('tokens_before', fresh)
        self.assertNotIn('resume', case.calls()[-1]['args'])
        self.assertEqual(case.run.receipt('b'), child)
        archived = next((case.root / 'history').glob('a-*.json'))
        self.assertEqual(worker.read_json(archived)['continued_by'], 'b')

    def test_f1_zero_upstream_cumulative_value_is_not_replaced_by_delta(self):
        case = self.case
        case.accepted()
        upstream = case.run.receipt('a')
        upstream.update(tokens_session=0, tokens=99)
        worker.write_json(case.root / 'a.json', upstream)
        case.env['FAKE_TOKENS'] = '1200'
        child = self.child()
        self.assertEqual(child.get('tokens_before'), 0)
        self.assertEqual(child['tokens'], 1200)

    def test_f1_missing_upstream_usage_refused_before_dispatch(self):
        case = self.case
        case.accepted()
        upstream = case.run.receipt('a')
        upstream.pop('tokens_session')
        upstream.pop('tokens')
        worker.write_json(case.root / 'a.json', upstream)
        case.card('b', '依赖：a\n接续：a\n任务 B')
        calls = case.calls()
        refused = case.cli('run', case.root)
        self.assertEqual(refused.returncode, 2, refused.stdout)
        self.assertIn('累计用量', refused.stderr)
        self.assertEqual(case.run.receipt('a'), upstream)
        self.assertEqual(case.calls(), calls)
        self.assertIsNone(case.run.receipt('b'))


if __name__ == '__main__':
    unittest.main()
