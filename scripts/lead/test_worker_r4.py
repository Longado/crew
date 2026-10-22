"""第四轮：失败原因随回执交回，写卡交付能隔离复跑；只用假 Codex。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX, WORKER


FAKE = FAKE_CODEX.replace("out = args[args.index('-o') + 1]", """
if os.environ.get('FAKE_R4_ERROR'):
    print('\\x1b[31mError: ' + os.environ['FAKE_R4_ERROR'] + '\\x1b[0m')
    print('tokens used')
    print('1,234')
    sys.exit(7)
out = args[args.index('-o') + 1]
""")


class R4Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crew-r4-')
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        self.fake = self.tmp / 'codex'
        self.fake.write_text(FAKE, encoding='utf-8')
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'registry'),
                    'CREW_CODEX_BIN': str(self.fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
                    'CODEX_HOME': str(self.tmp / 'codex-home'), 'PYTHONDONTWRITEBYTECODE': '1'}
        environment = mock.patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)

    def card(self, name='a', body='任务'):
        (self.root / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def receipt(self, name='a', **extra):
        self.card(name)
        prompt = self.root / f'{name}.prompt'
        prompt.write_text('任务', encoding='utf-8')
        receipt = {'state': 'running', 'pid': 0, 'attempt_id': 'fixture-' + name,
                   'started_at': worker.now(), 'cwd': str(self.tmp), 'prompt': str(prompt),
                   'output': str(self.root / f'{name}.out'), 'log': str(self.root / f'{name}.log'),
                   **extra}
        worker.write_json(self.root / f'{name}.json', receipt)
        return receipt

    def guard(self, receipt, seconds=3, cmd=None):
        worker.guard(self.root, 'a', seconds,
                     cmd or [str(self.fake), 'exec', '-o', receipt['output']], receipt['attempt_id'], .05)
        return self.run.receipt('a')

    def cli(self, *args):
        result = subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_d1_failed_receipt_status_and_wait_include_error_not_token_footer(self):
        error = 'flagged for possible cybersecurity risk'
        with mock.patch.dict(os.environ, FAKE_R4_ERROR=error):
            final = self.guard(self.receipt())
        self.assertEqual(final['state'], 'failed')
        reason = final.get('failure_reason', '')
        self.assertIn(error, reason)
        self.assertIn('退出码 7', reason)
        self.assertNotIn('tokens used', reason)
        self.assertNotIn('\x1b', reason)
        status = self.cli('status', self.root)
        waited = self.cli('wait', self.root, '--minutes', '.01')
        self.assertEqual(status['cards'][0].get('failure_reason'), reason)
        self.assertEqual(waited['cards'][0].get('failure_reason'), reason)
        self.assertEqual(waited['fresh'], ['a'])
        original = Path.open

        def no_log(path, *args, **kwargs):
            if path.suffix == '.log':
                self.fail('status/wait 不应重读已收尾日志')
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'open', no_log):
            self.assertEqual(self.run.status()['cards'][0]['failure_reason'], reason)
            self.assertEqual(worker.wait_result(self.run, [])['cards'][0]['failure_reason'], reason)

    def test_d1_guard_exception_includes_existing_error(self):
        final = self.guard(self.receipt(), cmd=[str(self.tmp / 'missing-codex')])
        self.assertEqual(final['state'], 'failed')
        self.assertIn('missing-codex', final.get('failure_reason', ''))

    def test_d1_timeout_has_reason_even_without_error_line(self):
        receipt = self.receipt()
        Path(receipt['prompt']).write_text('SLEEP', encoding='utf-8')
        final = self.guard(receipt, seconds=.2)
        self.assertEqual(final['state'], 'timed_out')
        self.assertIn('超时', final.get('failure_reason', ''))

    def test_d1_requested_stop_includes_note(self):
        receipt = self.receipt()
        private = self.root / '.attempts' / receipt['attempt_id']
        private.mkdir(parents=True)
        worker.write_json(private / 'stop.json', {'attempt_id': receipt['attempt_id'], 'note': '调整任务'})
        final = self.guard(receipt)
        self.assertEqual(final['state'], 'stopped')
        self.assertIn('调整任务', final.get('failure_reason', ''))

    def test_d1_protocol_error_keeps_process_state_and_explains_invalid_delivery(self):
        final = self.guard(self.receipt(result_contract={'version': 'result-v1', 'expected': ['D1']}))
        self.assertEqual(final['state'], 'finished')
        self.assertEqual(final['exit_code'], 0)
        self.assertEqual(final['result']['status'], 'protocol_error')
        self.assertIn('json', final.get('failure_reason', '').lower())
        self.assertEqual(self.run.status()['cards'][0].get('failure_reason'), final.get('failure_reason'))

    def test_d1_failure_reason_is_bounded_and_keeps_at_most_two_tail_lines(self):
        receipt = self.receipt()
        log = self.root / 'large.log'
        log.write_bytes(b'Error: old failure\n' + b'x' * 200000 +
                        b'\nError: first\nFatal: second\nError: ' + b'z' * 2000 + b'\n')
        reads = []
        original = Path.open

        class BoundedReader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def seek(self, *args):
                return self.stream.seek(*args)

            def read(self, size=-1):
                data = self.stream.read(size)
                reads.append(len(data))
                return data

        def tracked(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            return BoundedReader(stream) if path == log else stream

        receipt.update(state='failed', exit_code=9, error='已有异常')
        with mock.patch.object(Path, 'open', tracked):
            reason = getattr(worker, 'failure_reason', lambda *args, **kwargs: '')(receipt, log)
        self.assertIn('退出码 9', reason)
        self.assertIn('已有异常', reason)
        self.assertIn('Fatal: second', reason)
        self.assertNotIn('Error: first', reason)
        self.assertNotIn('old failure', reason)
        self.assertLessEqual(len(reason), 600)
        self.assertTrue(reads, '须读取日志末尾')
        self.assertLessEqual(sum(reads), 65536)

    def test_d1_lost_status_uses_metadata_and_wait_caches_private_log_reason_once(self):
        receipt = self.receipt(pid=99999999)
        private = self.root / '.attempts' / receipt['attempt_id']
        private.mkdir(parents=True)
        (private / 'a.log').write_text('Error: executor connection lost\n', encoding='utf-8')
        original = Path.open

        def no_log(path, *args, **kwargs):
            if path.suffix == '.log':
                self.fail('status 不应读取失联执行者日志')
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'open', no_log):
            row = self.run.status()['cards'][0]
        self.assertEqual(row['state'], 'lost')
        self.assertIn('看守', row.get('failure_reason', ''))
        fresh, active = worker.poll_wait(self.run)
        self.assertEqual((fresh, active), (['a'], False))
        final = self.run.receipt('a')
        self.assertIn('executor connection lost', final.get('failure_reason', ''))
        self.assertEqual(final['state'], 'running')  # 失联不等于执行者已停止。
        with mock.patch.object(Path, 'open', no_log):
            self.assertEqual(worker.poll_wait(self.run), ([], False))
            self.assertEqual(self.run.status()['cards'][0]['failure_reason'], final['failure_reason'])

    def test_d1_stop_after_guard_loss_records_reason(self):
        receipt = self.receipt(pid=99999999, executor_pid=99999998, executor_pgid=99999998)
        self.run.stop('a', note='负责人收尾')
        final = self.run.receipt('a')
        self.assertEqual(final['state'], 'stopped')
        self.assertIn('负责人收尾', final.get('failure_reason', ''))

    def test_d1_guard_launch_failure_records_reason(self):
        self.card()
        with mock.patch.object(worker, 'lean_args', return_value=([], [])), \
                mock.patch.object(worker.subprocess, 'Popen', side_effect=OSError('fixture watcher unavailable')):
            with self.assertRaises(OSError):
                self.run.run(self.tmp, 3, 'high', None, [], False)
        final = self.run.receipt('a')
        self.assertEqual(final['state'], 'failed')
        self.assertIn('fixture watcher unavailable', final.get('failure_reason', ''))

    def test_d1_legacy_receipts_without_reason_still_display(self):
        for state in ('failed', 'timed_out', 'lost', 'stopped', 'finished'):
            with self.subTest(state=state):
                self.card()
                worker.write_json(self.root / 'a.json', {'state': state, 'pid': 99999999})
                row = self.run.status()['cards'][0]
                self.assertEqual(row['state'], 'delivered' if state == 'finished' else state)
                self.assertFalse(row.get('failure_reason'))

    def test_d2_only_write_prompt_requires_replay_environment_and_temporary_data(self):
        self.card('write', '可写：result.txt\n任务')
        self.card('read', '只读任务')
        self.cli('run', self.root, '--cwd', self.tmp, '--write')
        self.cli('wait', self.root, '--minutes', '.1')
        self.cli('wait', self.root, '--minutes', '.1')
        calls = [json.loads(line) for line in (self.tmp / 'calls.jsonl').read_text().splitlines()]
        write = next(call['prompt'] for call in calls if '只改任务卡「可写」' in call['prompt'])
        read = next(call['prompt'] for call in calls if '只读：不写文件' in call['prompt'])
        for required in ('一行能直接复跑验证的命令', '环境变量', 'PLAYWRIGHT_BROWSERS_PATH',
                         '临时目录', '临时库', '不启动会连真实数据的应用'):
            self.assertIn(required, write)
            self.assertNotIn(required, read)


if __name__ == '__main__':
    unittest.main()
