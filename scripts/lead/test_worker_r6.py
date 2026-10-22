"""第六轮：纯网络日志不算进展，失败摘要保留路径末尾；只用假 Codex。"""
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


# 按断网样本合成，去掉地址、路径和会话信息。
NETWORK_LINES = (
    'ERROR: Reconnecting... waiting for network',
    'ERROR: Reconnecting... 2/5',
    '2026-01-01T00:00:00.000Z ERROR codex_api::endpoint::responses_websocket: '
    'failed to connect to websocket: IO error: failed to lookup address information: '
    'nodename nor servname provided, or not known',
    '2026-01-01T00:00:00.000Z ERROR codex_models_manager::manager: '
    'failed to refresh available models: Connection failed: error sending request',
    'warning: Falling back from WebSockets to HTTPS transport. stream disconnected '
    'before completion: failed to lookup address information',
)
FAKE = FAKE_CODEX.replace("out = args[args.index('-o') + 1]", """
from pathlib import Path
gate = Path(os.environ['FAKE_R6_PHASE'])
network_lines = json.loads(os.environ['FAKE_R6_NETWORK'])
deadline, index = time.monotonic() + 45, 0
while time.monotonic() < deadline:
    phase = gate.read_text()
    if phase == 'finish':
        break
    print(network_lines[index % len(network_lines)] if phase == 'network'
          else ('已恢复正常输出' if phase == 'recovered' else '正常执行中'), flush=True)
    index += 1
    time.sleep(.08)
out = args[args.index('-o') + 1]
""")


class R6Test(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r6-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        self.log = self.root / 'a.log'
        self.phase = self.tmp / 'phase'
        self.phase.write_text('normal')
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'registry'),
                    'CREW_CODEX_BIN': str(fake), 'CODEX_HOME': str(self.tmp / 'codex-home'),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'FAKE_NO_SESSION': '1',
                    'FAKE_R6_PHASE': str(self.phase), 'FAKE_R6_NETWORK': json.dumps(NETWORK_LINES),
                    'PYTHONDONTWRITEBYTECODE': '1'}
        environment = mock.patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)
        self.addCleanup(self.finish_owned)
        self.receipt = {'started_at': worker.now()}
        self.mtime = time.time()

    def cli(self, *args):
        result = subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def until(self, predicate):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.04)
        self.fail('假执行者未到达预期状态：' + str(self.run.receipt('a')))

    def finish_owned(self):
        self.phase.write_text('finish')
        if self.run.receipt('a'):
            self.until(lambda: self.run.receipt('a')['state'] not in worker.ACTIVE_STATES)

    def append(self, text):
        with self.log.open('a', encoding='utf-8') as stream:
            stream.write(text)
        self.mtime += 1
        os.utime(self.log, (self.mtime, self.mtime))
        heartbeat = worker.log_heartbeat(self.receipt, self.log)
        self.receipt['heartbeat'] = heartbeat
        return heartbeat

    def test_n1_each_network_diagnostic_freezes_activity_and_wait_start(self):
        normal = self.append('正常执行中\n')
        since = None
        for line in NETWORK_LINES * 2:
            with self.subTest(line=line):
                heartbeat = self.append('\x1b[31m' + line + '\x1b[0m\n')
                self.assertEqual(heartbeat['log_mtime'], normal['log_mtime'])
                self.assertTrue(heartbeat.get('network_wait_since'))
                since = since or heartbeat['network_wait_since']
                self.assertEqual(heartbeat['network_wait_since'], since)
                self.assertIn('执行者在等网络（自 ' + since + '）', worker.progress(self.receipt)[2])
        unchanged = worker.log_heartbeat(self.receipt, self.log)
        self.assertTrue(unchanged.get('network_wait_since'))
        self.assertEqual(unchanged['network_wait_since'], since)

    def test_n1_network_only_start_uses_started_at_then_normal_output_recovers(self):
        heartbeat = self.append(NETWORK_LINES[0] + '\n')
        self.assertEqual(heartbeat['log_mtime'], self.receipt['started_at'])
        recovered = self.append('已恢复正常输出\n')
        self.assertFalse(recovered.get('network_wait_since'))
        self.assertNotEqual(recovered['log_mtime'], heartbeat['log_mtime'])
        self.assertNotIn('执行者在等网络', worker.progress(self.receipt)[2])

    def test_n1_normal_lines_and_quoted_diagnostics_count_as_activity(self):
        self.append(NETWORK_LINES[0] + '\n')
        for line in ('已恢复正常输出', '正在检查 ERROR: Reconnecting... waiting for network',
                     'Error: file not found', 'failed to refresh available models: invalid response'):
            with self.subTest(line=line):
                before = self.receipt['heartbeat']
                heartbeat = self.append(line + '\n')
                self.assertNotEqual(heartbeat['log_mtime'], before['log_mtime'])
                self.assertFalse(heartbeat.get('network_wait_since'))
        mixed = self.append(NETWORK_LINES[0] + '\n有正常进展\n' + NETWORK_LINES[1] + '\n')
        self.assertNotEqual(mixed['log_mtime'], heartbeat['log_mtime'])
        self.assertTrue(mixed.get('network_wait_since'))
        self.assertEqual(self.append(NETWORK_LINES[0] + '\n')['log_mtime'], mixed['log_mtime'])

    def test_n1_split_line_and_large_network_tail_do_not_refresh_activity(self):
        normal = self.append('正常执行中\n')
        self.append(NETWORK_LINES[0])
        split = self.append(' again\n')
        self.assertEqual(split['log_mtime'], normal['log_mtime'])
        large = self.append((NETWORK_LINES[2] + '\n') * 2000)
        self.assertEqual(large['log_mtime'], normal['log_mtime'])
        self.assertTrue(large.get('network_wait_since'))

    def test_n1_heartbeat_reads_are_bounded_and_status_never_opens_log(self):
        self.append('正常执行中\n' + (NETWORK_LINES[0] + '\n') * 4000)
        original, reads = Path.open, []

        class Reader:
            def __init__(self, stream):
                self.stream = stream

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def seek(self, *args):
                return self.stream.seek(*args)

            def read(self, size=-1):
                self_outer.assertGreaterEqual(size, 0, '不能无界读到文件结尾')
                self_outer.assertLessEqual(size, 65536)
                data = self.stream.read(size)
                reads.append(len(data))
                return data

        self_outer = self
        def tracked(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            return Reader(stream) if path == self.log else stream

        with mock.patch.object(Path, 'open', tracked):
            heartbeat = worker.log_heartbeat(self.receipt, self.log)
        self.assertLessEqual(sum(reads), 2 * 65536)  # 既有会话头与日志尾各有界。
        (self.root / 'cards/a.md').write_text('合成任务')
        worker.write_json(self.root / 'a.json', {**self.receipt, 'state': 'running', 'heartbeat': heartbeat})

        def no_log(path, *args, **kwargs):
            if path.suffix == '.log':
                self.fail('status 不应读取日志')
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'open', no_log):
            row = self.run.status()['cards'][0]
        self.assertIn('执行者在等网络', row['progress'])
        # 此回执不是进程，避免清理时把它当成活看守。
        worker.write_json(self.root / 'a.json', {**self.receipt, 'state': 'finished'})

    def test_n1_fake_codex_network_stalls_notifies_once_and_recovers(self):
        (self.root / 'cards/a.md').write_text('合成任务')
        self.cli('run', self.root, '--cwd', self.tmp, '--heartbeat-seconds', '.1',
                 '--stall-minutes', '.025', '--seconds', '45')
        self.until(lambda: (self.run.receipt('a') or {}).get('heartbeat', {}).get('last_output') == '正常执行中')
        self.phase.write_text('network')
        self.until(lambda: self.run.receipt('a').get('heartbeat', {}).get('network_wait_since'))
        waiting = self.run.receipt('a')['heartbeat']
        self.until(lambda: self.run.receipt('a')['state'] == 'stalled')
        row = self.cli('status', self.root)['cards'][0]
        self.assertEqual(row['state'], 'stalled')
        self.assertGreater(row['heartbeat']['log_bytes'], waiting['log_bytes'])
        self.assertEqual(row['heartbeat']['log_mtime'], waiting['log_mtime'])
        self.assertIn('执行者在等网络（自 ' + waiting['network_wait_since'] + '）', row['progress'])
        self.assertTrue(row['capacity_held'])
        self.assertEqual(self.cli('wait', self.root, '--minutes', '.01')['fresh'], ['a'])
        self.assertEqual(self.cli('wait', self.root, '--minutes', '.01')['fresh'], [])
        self.phase.write_text('recovered')
        self.until(lambda: self.run.receipt('a')['heartbeat']['last_output'] == '已恢复正常输出')
        recovered = self.cli('status', self.root)['cards'][0]
        self.assertEqual(recovered['state'], 'running')
        self.assertFalse(recovered['heartbeat'].get('network_wait_since'))
        self.assertNotIn('执行者在等网络', recovered['progress'])
        self.phase.write_text('network')
        self.until(lambda: self.run.receipt('a')['state'] == 'stalled')
        self.assertEqual(self.cli('wait', self.root, '--minutes', '.01')['fresh'], ['a'])
        self.assertEqual(self.cli('wait', self.root, '--minutes', '.01')['fresh'], [])

    def test_n2_long_exception_and_log_keep_both_ends_after_redaction(self):
        path = '/fixture/' + 'nested/' * 100 + 'missing-report.json'
        secret = 'Z' * 250
        message = 'Error: cannot open ' + path + ' API_KEY=' + secret + ' tail.txt'
        self.log.write_text(message)
        for source in ('error', 'log'):
            with self.subTest(source=source):
                receipt = {'state': 'failed', 'error': message if source == 'error' else ''}
                reason = worker.failure_reason(receipt, self.log if source == 'log' else None)
                self.assertIn('Error: cannot open /fixture/', reason)
                self.assertIn('missing-report.json', reason)
                self.assertIn('tail.txt', reason)
                self.assertIn('…', reason)
                self.assertIn(worker.REDACTED, reason)
                self.assertNotIn('Z' * 8, reason)
                self.assertLessEqual(len(reason), 600)

    def test_n2_combined_reason_keeps_tail_with_original_total_limit(self):
        receipt = {'state': 'stopped', 'exit_code': 7, 'error': 'Error: ' + 'e' * 1000 + 'exception.txt',
                   'stop_requested': {'note': '停止说明' + 'n' * 1000 + 'note.txt'}}
        self.log.write_text('Error: ' + 'a' * 1000 + 'first.txt\nError: ' + 'b' * 1000 + 'last.txt\n')
        reason = worker.failure_reason(receipt, self.log)
        self.assertEqual(len(reason), 600)
        self.assertTrue(reason.startswith('已请求停止；退出码 7；Error: '))
        self.assertTrue(reason.endswith('last.txt'))
        self.assertIn('…', reason)


if __name__ == '__main__':
    unittest.main()
