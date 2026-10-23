"""M6a：Claude 只读执行者；全部使用临时目录、合成卡片和假 CLI。"""
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
import stats
import worker
from test_worker import FAKE_CODEX


USAGE = {'input_tokens': 3, 'output_tokens': 5,
         'cache_read_input_tokens': 7, 'cache_creation_input_tokens': 11}
FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
args = sys.argv[1:]
prompt = sys.stdin.read()
with open(os.environ['FAKE_LOG'], 'a') as stream:
    stream.write(json.dumps({'args': args, 'prompt': prompt, 'cwd': os.getcwd(), 'pid': os.getpid()}) + '\n')
if os.environ.get('FAKE_STDERR'):
    print(os.environ['FAKE_STDERR'], file=sys.stderr, flush=True)
time.sleep(float(os.environ.get('FAKE_DELAY', '0')))
if 'FAKE_RAW' in os.environ:
    print(os.environ['FAKE_RAW'], end='')
else:
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False,
                     'session_id': 'fixture-claude-session',
                     'result': os.environ.get('FAKE_REPLY', '合成交付'),
                     'usage': json.loads(os.environ.get('FAKE_USAGE', '{}'))}))
sys.exit(int(os.environ.get('FAKE_EXIT', '0')))
'''


class ClaudeWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='lead-claude-')
        self.tmp = Path(self.temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-claude'
        fake.write_text(FAKE_CLAUDE, encoding='utf-8')
        fake.chmod(0o755)
        self.codex = self.tmp / 'fake-codex'
        self.codex.write_text(FAKE_CODEX, encoding='utf-8')
        self.codex.chmod(0o755)
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'crew-home'),
                    'CODEX_HOME': str(self.tmp / 'codex-home'), 'CREW_CODEX_BIN': '/usr/bin/false',
                    'CREW_CLAUDE_BIN': str(fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'FAKE_USAGE': json.dumps(USAGE), 'PYTHONDONTWRITEBYTECODE': '1'}

    def tearDown(self):
        for path in self.root.glob('*.json'):
            receipt = worker.read_json(path)
            if isinstance(receipt, dict) and receipt.get('state') in worker.ACTIVE_STATES:
                self.cli('stop', self.root, path.stem, '--note', '合成测试收尾')
                self.finish(path.stem)
        self.temporary.cleanup()

    def card(self, name='a', body='执行者：claude\n合成任务'):
        (self.root / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', worker.__file__, *map(str, args)],
                              cwd=self.tmp, env=self.env, capture_output=True, text=True, timeout=30)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start(self, *args):
        return self.ok('run', self.root, '--cwd', self.work, '--seconds', '10', *args)

    def finish(self, name='a'):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            receipt = self.run.receipt(name) or {}
            if receipt.get('state') not in (None, *worker.ACTIVE_STATES):
                return receipt
            time.sleep(.02)
        self.fail('假执行者没有结束：' + name)

    def go(self, *args, name='a'):
        self.start(*args)
        return self.finish(name)

    def calls(self):
        path = Path(self.env['FAKE_LOG'])
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def rejected(self, body='执行者：claude\n合成任务', *args):
        self.card(body=body)
        self.go(*args)
        self.ok('reject', self.root, 'a', '--note', '补充合成来源')

    def refused(self, *args, hint):
        before = {p.name: p.read_bytes() for p in self.root.glob('a.*')}
        count = len(self.calls())
        result = self.cli('run', self.root, '--cwd', self.work, *args)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(hint, result.stderr)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.glob('a.*')})
        self.assertEqual(count, len(self.calls()))
        return result

    def test_headers_keep_result_contract_and_ignore_body_executor(self):
        body = '# 合成卡\n执行者：claude\n结果：result-v1\n覆盖：C1\n模型：fixture\n档位：high\n正文'
        self.card(body=body)
        self.assertEqual(self.run.cards()['a']['options'].get('executor'), 'claude')
        self.assertEqual(result_contract.from_card(body), {'version': 'result-v1', 'expected': ['C1']})
        self.card(body='正文\n执行者：claude')
        self.assertNotIn('executor', self.run.cards()['a']['options'])
        for invalid in ('', 'unknown', 'Claude'):
            with self.subTest(executor=invalid):
                self.card(body=f'执行者：{invalid}\n正文')
                self.refused(hint='执行者')

    def test_claude_default_model_and_exact_readonly_tools(self):
        self.card()
        receipt = self.go()
        args, prompt = self.calls()[0]['args'], self.calls()[0]['prompt']
        self.assertEqual(args[0], '-p')
        self.assertNotIn('--model', args)
        self.assertIn('--safe-mode', args)
        self.assertIn('--strict-mcp-config', args)
        self.assertEqual(args[args.index('--mcp-config') + 1], '{"mcpServers":{}}')
        self.assertEqual(args[args.index('--tools') + 1], 'Read,Grep,Glob')
        self.assertEqual(args[args.index('--allowedTools') + 1], 'Read,Grep,Glob')
        self.assertEqual(args[args.index('--permission-mode') + 1], 'dontAsk')
        self.assertIn('--disable-slash-commands', args)
        self.assertIn('--no-chrome', args)
        self.assertIn('用 Read 原生读取', prompt)
        self.assertIn('不联网', prompt)
        self.assertFalse(receipt['allow_web'])
        self.assertEqual(receipt['sandbox'], 'tool-allowlist')
        self.assertEqual(receipt['executor'], 'claude')
        self.assertIsNone(receipt['model'])

    def test_cli_executor_and_card_priority_and_codex_default(self):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.card(body='合成任务')
        first = self.go()
        self.assertEqual(self.calls()[0]['args'][0], 'exec')
        self.assertEqual(first['executor'], 'codex')
        self.assertNotIn('--model', self.calls()[0]['args'])
        self.card('b', '执行者：codex\n合成任务')
        self.card('c', '合成任务')
        self.start('--executor', 'claude', '--max-parallel', '1')
        self.assertEqual(self.finish('b')['executor'], 'codex')
        self.start()
        self.assertEqual(self.finish('c')['executor'], 'claude')
        self.card('d', '执行者：claude\n模型：fixture-card\n档位：xhigh\n合成任务')
        self.start('--executor', 'codex', '--model', 'fixture-cli')
        self.assertEqual(self.finish('d')['model'], 'fixture-card')
        args = self.calls()[-1]['args']
        self.assertEqual(args[args.index('--model') + 1], 'fixture-card')
        self.assertEqual(args[args.index('--effort') + 1], 'xhigh')

    def test_executor_override_does_not_inherit_other_executor_model(self):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.card(body='合成任务')
        self.go('--model', 'fixture-codex')
        self.card('b')
        receipt = self.go(name='b')
        self.assertIsNone(receipt['model'])
        self.assertNotIn('--model', self.calls()[-1]['args'])

    def test_claude_rejects_ultra_write_and_codex_features(self):
        for body, args, hint in (
            ('执行者：claude\n档位：ultra\n正文', (), '档位'),
            ('执行者：claude\n正文', ('--effort', 'ultra'), '档位'),
            ('执行者：claude\n可写：allowed.txt\n正文', ('--write',), '暂不支持写卡'),
            ('可写：\n执行者：claude\n正文', (), '暂不支持写卡'),
            ('执行者：claude\n正文', ('--enable', 'fixture_feature'), '特性'),
        ):
            with self.subTest(body=body, args=args):
                self.card(body=body)
                self.refused(*args, hint=hint)
        self.assertFalse((self.root / 'baseline.json').exists())

    def test_allow_web_is_explicit_claude_only(self):
        self.card(body='执行者：codex\n合成任务')
        self.refused('--allow-web', hint='只适用于 claude')
        self.card()
        receipt = self.go('--allow-web')
        args, prompt = self.calls()[0]['args'], self.calls()[0]['prompt']
        self.assertEqual(args[args.index('--tools') + 1], 'Read,Grep,Glob,WebSearch,WebFetch')
        self.assertTrue(receipt['allow_web'])
        self.assertNotIn('不联网', prompt)
        self.assertIn('需负责人保存来源文本后再核', prompt)

    def test_json_delivery_usage_and_stderr_separation(self):
        self.card()
        self.env['FAKE_STDERR'] = '合成诊断提示，不是 JSON'
        receipt = self.go()
        self.assertEqual(receipt['state'], 'finished')
        self.assertEqual((self.root / 'a.out').read_text(), '合成交付')
        self.assertEqual(receipt['tokens'], 26)
        self.assertEqual(receipt['usage'], USAGE)
        self.assertEqual(receipt['usage_basis'], 'claude_json_input_output_cache')
        self.assertEqual(receipt['session_id'], 'fixture-claude-session')
        self.assertEqual(json.loads((self.root / 'a.log').read_text())['type'], 'result')
        self.assertIn('合成诊断', (self.root / 'a.stderr').read_text())

    def test_invalid_json_or_missing_result_is_failed_with_reason(self):
        cases = [('', '输出缺失'), ('{oops', 'JSON'), ('[]', '对象'), ('null', '对象'),
                 ('{}', 'result'), ('{"result": 4}', 'result'), ('{"result": "  "}', 'result')]
        for index, (raw, hint) in enumerate(cases):
            with self.subTest(raw=raw):
                name = f'a{index}'
                self.card(name)
                self.env['FAKE_RAW'] = raw
                receipt = self.go(name=name)
                self.assertEqual(receipt['state'], 'failed')
                self.assertIn(hint, receipt['failure_reason'])
                self.assertFalse(worker.capacity_held(receipt))

    def test_error_result_and_failure_reason_redact_credentials(self):
        secret = 'sk-ant-' + 'x' * 30
        for index, flags in enumerate(({'is_error': True}, {'subtype': 'error_max_turns'}, {'subtype': None})):
            with self.subTest(flags=flags):
                name = f'a{index}'
                self.card(name)
                self.env['FAKE_RAW'] = json.dumps({'result': '合成错误 ' + secret,
                                                 'session_id': 'fixture-error', **flags})
                receipt = self.go(name=name)
                self.assertEqual(receipt['state'], 'finished' if index == 2 else 'failed')
                if index < 2:
                    self.assertIn('error result', receipt['failure_reason'])
                    self.assertNotIn(secret, receipt['failure_reason'])
                    self.assertIn(worker.REDACTED, receipt['failure_reason'])
                    self.assertEqual(receipt['session_id'], 'fixture-error')
                    status = self.cli('status', self.root)
                    self.assertNotIn(secret, status.stdout)

    def test_nonzero_exit_preserves_stderr_failure_reason(self):
        self.card()
        self.env.update(FAKE_RAW='', FAKE_EXIT='7', FAKE_STDERR='ERROR fixture denied --token synthetic-password')
        receipt = self.go()
        self.assertEqual(receipt['state'], 'failed')
        self.assertIn('退出码 7', receipt['failure_reason'])
        self.assertIn('fixture denied', receipt['failure_reason'])
        self.assertNotIn('synthetic-password', receipt['failure_reason'])

    def test_usage_requires_four_nonnegative_integers(self):
        values = [None, {}, [], {**USAGE, 'input_tokens': True}, {**USAGE, 'output_tokens': -1},
                  {**USAGE, 'cache_read_input_tokens': '7'}, {**USAGE, 'cache_creation_input_tokens': 1.5},
                  dict.fromkeys(USAGE, 0)]
        for index, value in enumerate(values):
            with self.subTest(value=value):
                self.card(f'a{index}')
                self.env['FAKE_USAGE'] = json.dumps(value)
                receipt = self.go(name=f'a{index}')
                self.assertEqual(receipt['state'], 'finished')
                self.assertEqual(receipt['tokens'], 0 if index == len(values) - 1 else None)
                self.assertEqual(receipt['heartbeat']['tokens'], receipt['tokens'])

    def test_reject_retry_resumes_and_counts_invocation_usage(self):
        self.rejected('合成任务', '--executor', 'claude', '--model', 'fixture-model', '--allow-web')
        old = self.run.receipt('a')
        self.env['FAKE_USAGE'] = json.dumps(dict.fromkeys(USAGE, 1))
        receipt = self.go('--retry', 'a')
        args = self.calls()[-1]['args']
        self.assertEqual(args[args.index('--resume') + 1], 'fixture-claude-session')
        self.assertEqual(args[args.index('--model') + 1], 'fixture-model')
        self.assertEqual(receipt['tokens'], 4, 'Claude 本次 JSON 用量不能扣上次调用')
        self.assertTrue(receipt['allow_web'])
        self.assertNotEqual(old['attempt_id'], receipt['attempt_id'])
        self.assertTrue(list((self.root / 'history').glob('a-*.json')))
        self.assertTrue(list((self.root / 'history').glob('a-*.stderr')))
        self.assertIn('补充合成来源', self.calls()[-1]['prompt'])

    def test_retry_setting_changes_require_fresh_and_preserve_delivery(self):
        self.rejected('合成任务', '--executor', 'claude')
        other = self.tmp / 'other'
        other.mkdir()
        for args in (('--executor', 'codex'), ('--model', 'fixture-new'), ('--cwd', other), ('--allow-web',)):
            with self.subTest(args=args):
                self.refused('--retry', 'a', *args, hint='--fresh')
        receipt = self.go('--retry', 'a', '--fresh', '--allow-web')
        self.assertNotIn('--resume', self.calls()[-1]['args'])
        self.assertTrue(receipt['allow_web'])
        self.ok('reject', self.root, 'a', '--note', '关闭联网')
        self.refused('--retry', 'a', '--no-allow-web', hint='--fresh')
        receipt = self.go('--retry', 'a', '--fresh', '--no-allow-web')
        self.assertFalse(receipt['allow_web'])

    def test_card_executor_change_from_legacy_codex_requires_fresh(self):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.rejected('合成任务')
        receipt = self.run.receipt('a')
        receipt.pop('executor', None)
        receipt.pop('allow_web', None)
        worker.write_json(self.root / 'a.json', receipt)
        self.card()
        self.refused('--retry', 'a', hint='--fresh')
        receipt = self.go('--retry', 'a', '--fresh')
        self.assertEqual(receipt['executor'], 'claude')
        self.assertNotIn('--resume', self.calls()[-1]['args'])

    def test_quiet_claude_keeps_heartbeat_without_output_stall(self):
        self.card()
        self.env['FAKE_DELAY'] = '3'
        self.env['FAKE_STDERR'] = 'ERROR: Reconnecting... 1/5'
        self.start('--heartbeat-seconds', '.05', '--stall-minutes', '.001')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            receipt = self.run.receipt('a')
            if self.calls() and receipt.get('heartbeat') and worker.progress(receipt)[1] >= .3:
                break
            time.sleep(.02)
        self.assertTrue(self.calls(), '须先确认假 Claude 已启动，再检查静默运行与停止')
        self.assertEqual(receipt['state'], 'running')
        self.assertFalse(receipt['heartbeat']['network_wait_since'])
        self.assertIsNone(receipt['heartbeat']['tokens'])
        self.assertTrue(worker.capacity_held(receipt))
        self.ok('stop', self.root, 'a', '--note', '合成停止')
        receipt = self.finish()
        self.assertEqual(receipt['state'], 'stopped')
        self.assertIn('合成停止', receipt['failure_reason'])
        self.assertFalse(worker.capacity_held(receipt))
        with self.assertRaises(ProcessLookupError):
            os.kill(self.calls()[0]['pid'], 0)

    def test_claude_still_detects_stale_guard_and_timeout(self):
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        receipt = {'state': 'running', 'executor': 'claude', 'pid': os.getpid(),
                   'started_at': old, 'heartbeat': {'at': old}, 'heartbeat_seconds': 30}
        self.assertEqual(worker.receipt_state(receipt), 'stalled')
        self.card()
        self.env['FAKE_DELAY'] = '3'
        receipt = self.go('--seconds', '.2', '--heartbeat-seconds', '.05')
        self.assertEqual(receipt['state'], 'timed_out')
        self.assertIn('执行超时', receipt['failure_reason'])
        self.assertFalse(worker.capacity_held(receipt))

    def test_claude_heartbeat_never_reads_codex_usage_or_network_lines(self):
        log = self.tmp / 'fixture.log'
        log.write_text('session id: fixture\ntokens used\n999\nERROR: Reconnecting... 1/5\n')
        receipt = {'executor': 'claude', 'started_at': worker.now()}
        with mock.patch.object(worker, 'native_tokens', side_effect=AssertionError('不能查 Codex')):
            heartbeat = worker.log_heartbeat(receipt, log)
        self.assertIsNone(heartbeat['tokens'])
        self.assertIsNone(heartbeat['network_wait_since'])

    def test_result_protocol_and_frozen_continuation_remain_active(self):
        self.card(body='执行者：claude\n结果：result-v1\n覆盖：C1\n合成任务')
        self.env['FAKE_REPLY'] = '## 结论卡\n合成交付\n```json\n' + json.dumps(
            {'status': 'complete', 'questions': [], 'covered': ['C1'], 'skipped': []}) + '\n```\n'
        receipt = self.go()
        self.assertEqual(receipt['result']['status'], 'complete')
        self.ok('accept', self.root, 'a', '--note', '合成来源已核对', '--hold')
        frozen = self.run.receipt('a')['review']['accepted_output']
        self.card('b', '执行者：claude\n依赖：a\n接续：a\n合成任务')
        receipt = self.go(name='b')
        self.assertIn('--resume', self.calls()[-1]['args'])
        self.assertIn(frozen, self.calls()[-1]['prompt'])
        self.assertEqual(receipt['tokens'], 26)
        self.assertEqual(self.run.receipt('a')['continued_by'], 'b')

    def test_continuation_refuses_executor_or_web_scope_change(self):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.card()
        self.go()
        self.ok('accept', self.root, 'a', '--note', '合成来源已核对', '--hold')
        self.card('b', '执行者：codex\n依赖：a\n接续：a\n合成任务')
        result = self.cli('run', self.root, '--cwd', self.work)
        self.assertEqual(result.returncode, 2)
        self.assertIn('不能接续', result.stderr)
        self.card('b', '执行者：claude\n依赖：a\n接续：a\n合成任务')
        result = self.cli('run', self.root, '--cwd', self.work, '--allow-web')
        self.assertEqual(result.returncode, 2)
        self.assertIn('不能接续', result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_accept_auto_dispatch_respects_executor_specific_model_default(self):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.card(body='执行者：codex\n合成任务')
        self.card('b', '执行者：claude\n依赖：a\n合成任务')
        self.go('--model', 'fixture-codex')
        self.ok('accept', self.root, 'a', '--note', '合成验收')
        receipt = self.finish('b')
        self.assertEqual(receipt['executor'], 'claude')
        self.assertIsNone(receipt['model'])
        self.assertNotIn('--model', self.calls()[-1]['args'])

    def test_pending_status_does_not_mislabel_claude_as_codex(self):
        self.card()
        row = self.ok('status', self.root)['cards'][0]
        self.assertEqual(row.get('executor'), 'claude')

    def test_stats_separates_executors_and_never_looks_up_claude_as_codex(self):
        self.card()
        self.go()
        with mock.patch.dict(os.environ, self.env), mock.patch.object(
                stats, 'read_log', side_effect=AssertionError('Claude 不读 Codex 会话日志')):
            metrics = stats.summarize_crew(self.root)
        row = metrics['attempts'][0]
        self.assertEqual(row.get('executor'), 'claude')
        self.assertEqual(row.get('usage_basis'), 'claude_json_input_output_cache')
        self.assertEqual(row.get('reported_usage'), USAGE)
        self.assertEqual(row['log_status'], 'Claude JSON')
        self.assertIn('Claude', stats.render_crew(metrics))
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        self.card('b', '执行者：codex\n合成任务')
        self.go(name='b')
        with mock.patch.dict(os.environ, self.env):
            metrics = stats.summarize_crew(self.root)
        grouped = metrics['receipt_usage_by_executor']
        self.assertEqual(grouped['claude']['tokens'], 26)
        self.assertEqual(grouped['codex']['tokens'], 1234)
        self.assertIsNone(metrics['receipt_tokens'], '不同口径不合成一个 token 总数')
        self.assertIn('claude_json_input_output_cache', stats.render_crew(metrics))

    def test_stats_unknown_claude_usage_remains_unknown(self):
        self.env['FAKE_USAGE'] = '{}'
        self.card()
        self.go()
        with mock.patch.dict(os.environ, self.env):
            metrics = stats.summarize_crew(self.root)
        group = metrics['receipt_usage_by_executor']['claude']
        self.assertIsNone(group['tokens'])
        self.assertIsNone(metrics['receipt_tokens'])
        self.assertEqual(group['missing_attempts'], 1)
        self.assertEqual(metrics['attempts'][0]['log_status'], 'Claude 用量未知')


if __name__ == '__main__':
    unittest.main()
