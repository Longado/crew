"""第五轮：合成凭据、心跳阈值翻转和外部子路径链接环；只用假 Codex。"""
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX


REDACTED = '[已隐藏的凭证]'
FAKE = FAKE_CODEX.replace("out = args[args.index('-o') + 1]", """
print('Error: ' + os.environ['FAKE_R5_ERROR'])
sys.exit(7)
out = args[args.index('-o') + 1]
""")


class R5FixTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r5fix-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE, encoding='utf-8')
        fake.chmod(0o755)
        environment = mock.patch.dict(os.environ, {
            'CREW_HOME': str(self.tmp / 'registry'), 'CREW_CODEX_BIN': str(fake),
            'CODEX_HOME': str(self.tmp / 'codex-home'), 'FAKE_LOG': str(self.tmp / 'calls.jsonl'),
            'PYTHONDONTWRITEBYTECODE': '1'})
        environment.start()
        self.addCleanup(environment.stop)

    def card(self, name='a', body='合成任务'):
        (self.root / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def receipt(self, **extra):
        self.card()
        prompt = self.root / 'a.prompt'
        prompt.write_text('合成任务', encoding='utf-8')
        receipt = {'state': 'running', 'attempt_id': 'fixture-attempt', 'pid': os.getpid(),
                   'started_at': worker.now(), 'cwd': str(self.tmp), 'prompt': str(prompt),
                   'output': str(self.root / 'a.out'), 'log': str(self.root / 'a.log'), **extra}
        worker.write_json(self.root / 'a.json', receipt)
        return receipt

    def test_e1_failure_sources_redact_all_synthetic_credential_formats(self):
        samples = [
            ('sk-' + 'S' * 24, 'sk-' + 'S' * 24),
            ('sk-ant-' + 'A' * 24, 'sk-ant-' + 'A' * 24),
            ('ghp_' + 'G' * 24, 'ghp_' + 'G' * 24),
            ('AKIA' + 'W' * 16, 'AKIA' + 'W' * 16),
            ('xoxb-' + 'L' * 16, 'xoxb-' + 'L' * 16),
            ('API_KEY="fixture-api-credential"', 'fixture-api-credential'),
            ('api-key: fixture-api-hyphen', 'fixture-api-hyphen'),
            ('secret=fixture-secret-value', 'fixture-secret-value'),
            ('token: fixture-token-value', 'fixture-token-value'),
            ('password=fixture-password', 'fixture-password'),
            ('Authorization: Bearer fixture-bearer', 'fixture-bearer'),
            ('authorization: basic Zml4dHVyZTpwYXNzd29yZA==', 'Zml4dHVyZTpwYXNzd29yZA=='),
            ('https://fixture-user:fixture-pass@example.invalid/path', 'fixture-user:fixture-pass'),
        ]
        log = self.root / 'a.log'
        for sample, secret in samples:
            log.write_text('Error: ' + sample, encoding='utf-8')
            for source in ('log', 'error', 'stop', 'protocol'):
                with self.subTest(sample=sample, source=source):
                    receipt = {'state': 'failed', 'exit_code': 7}
                    if source == 'error':
                        receipt['error'] = sample
                    elif source == 'stop':
                        receipt.update(state='stopped', stop_requested={'note': sample})
                    elif source == 'protocol':
                        receipt.update(state='finished', result={'status': 'protocol_error', 'errors': [sample]})
                    reason = worker.failure_reason(receipt, log if source == 'log' else None)
                    self.assertNotIn(secret, reason)
                    self.assertIn(REDACTED, reason)

    def test_e1_typescript_word_boundaries_redact_next_to_chinese_text(self):
        samples = ['sk-' + 'S' * 24, 'sk-ant-' + 'A' * 24, 'ghp_' + 'G' * 24,
                   'AKIA' + 'W' * 16, 'xoxb-' + 'L' * 16,
                   'Authorization: Bearer fixture-bearer',
                   'https://fixture-user:fixture-pass@example.invalid/path']
        for sample in samples:
            with self.subTest(sample=sample):
                reason = worker.failure_reason({'state': 'failed', 'error': '凭据' + sample + '结束'})
                self.assertNotIn(sample, reason)
                self.assertIn(REDACTED, reason)

    def test_e1_redacts_before_truncating_error_and_log_excerpt(self):
        sample = 'Error: ' + 'x' * 104 + ' API_KEY=' + 'Z' * 300
        log = self.root / 'a.log'
        log.write_text(sample, encoding='utf-8')
        for source in ('error', 'log'):
            with self.subTest(source=source):
                reason = worker.failure_reason({'state': 'failed', 'error': sample if source == 'error' else ''},
                                               log if source == 'log' else None)
                self.assertNotIn('Z' * 8, reason)
                self.assertIn(REDACTED, reason)
                self.assertLessEqual(len(reason), 600)

    def test_e1_log_without_error_keywords_points_to_log_instead_of_tail(self):
        log = self.root / 'a.log'
        log.write_text('ordinary transcript\nAPI_KEY=fixture-tail-credential\ncleanup complete\n', encoding='utf-8')
        reason = worker.failure_reason({'state': 'failed', 'exit_code': 7}, log)
        self.assertNotIn('API_KEY', reason)
        self.assertNotIn('cleanup complete', reason)
        self.assertIn('查看日志', reason)
        self.assertIn(str(log), reason)

    def test_e1_fake_failure_receipt_status_and_wait_do_not_copy_credentials(self):
        secret = 'fixture-failed-bearer'
        receipt = self.receipt(pid=0)
        with mock.patch.dict(os.environ, FAKE_R5_ERROR='Authorization: Bearer ' + secret):
            worker.guard(self.root, 'a', 10, [os.environ['CREW_CODEX_BIN'], 'exec', '-o', receipt['output']],
                         receipt['attempt_id'], .05)
        final = self.run.receipt('a')
        self.assertEqual(final['state'], 'failed')
        for value in (final, self.run.status(), worker.wait_result(self.run, self.run.wait(1))):
            with self.subTest(source=type(value).__name__):
                self.assertNotIn(secret, json.dumps(value))
        self.assertIn(REDACTED, final['failure_reason'])
        self.assertIn(REDACTED, final['heartbeat']['last_output'])
        self.assertIn(secret, Path(receipt['log']).read_text(encoding='utf-8'))

    def test_e1_heartbeat_and_legacy_progress_redact_before_truncation(self):
        secret = 'Q' * 400
        sample = 'x' * 205 + ' API_KEY=' + secret
        log = self.root / 'a.log'
        log.write_text(sample, encoding='utf-8')
        receipt = self.receipt(state='failed', heartbeat={'last_output': sample}, failure_reason=sample)
        heartbeat = worker.log_heartbeat(receipt, log)
        self.assertNotIn('Q' * 8, heartbeat['last_output'])
        self.assertIn(REDACTED, heartbeat['last_output'])
        missing = self.root / 'missing.log'
        self.assertIn(REDACTED, worker.log_heartbeat(receipt, missing)['last_output'])
        self.assertNotIn(secret, worker.progress(receipt)[2])
        self.assertNotIn(secret, json.dumps(self.run.status()))
        self.assertIn(secret, self.run.receipt('a')['heartbeat']['last_output'])

    def test_e2_threshold_crossing_then_recovery_does_not_consume_notice(self):
        base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

        class Clock(dt.datetime):
            current = base + dt.timedelta(seconds=89.9)

            @classmethod
            def now(cls, tz=None):
                return cls.current.astimezone(tz)

        receipt = self.receipt(started_at=base.isoformat(), heartbeat_seconds=30,
                               heartbeat={'at': base.isoformat(), 'log_mtime': base.isoformat(), 'tokens': 1})
        original = self.run.state
        observed = []

        def recover(name, cards):
            Clock.current = base + dt.timedelta(seconds=90.1)
            state = original(name, cards)
            observed.append(state)
            receipt['heartbeat'].update(at=Clock.current.isoformat(), tokens=2)
            worker.write_json(self.root / 'a.json', receipt)
            return state

        with mock.patch.object(worker.dt, 'datetime', Clock), mock.patch.object(worker, 'guard_exited', return_value=False):
            with mock.patch.object(self.run, 'state', side_effect=recover):
                first = worker.poll_wait(self.run)
            self.assertEqual(observed, ['stalled'], '须确实跨过心跳阈值')
            self.assertEqual(first, ([], True))
            self.assertFalse((self.root / '.wait.json').exists(), '恢复不能占用去重键')
            self.assertEqual(worker.poll_wait(self.run), ([], True))
            Clock.current = base + dt.timedelta(seconds=180.2)
            self.assertEqual(worker.poll_wait(self.run), (['a'], True), '之后真正停更仍须提醒')
            self.assertEqual(worker.poll_wait(self.run), ([], True))

    def test_e2_output_stall_still_notifies_despite_normal_heartbeat_and_usage(self):
        old = (dt.datetime.now().astimezone() - dt.timedelta(minutes=5)).isoformat()
        receipt = self.receipt(state='stalled', heartbeat={'at': worker.now(), 'log_mtime': old, 'tokens': 1})
        original = self.run.state

        def refresh(name, cards):
            state = original(name, cards)
            receipt['heartbeat'].update(at=worker.now(), tokens=2)
            worker.write_json(self.root / 'a.json', receipt)
            return state

        with mock.patch.object(worker, 'guard_exited', return_value=False), \
                mock.patch.object(self.run, 'state', side_effect=refresh):
            self.assertEqual(worker.poll_wait(self.run), (['a'], True))
            self.assertEqual(worker.poll_wait(self.run), ([], True))

    def test_e3_external_cards_directory_symlink_loop_is_unreadable(self):
        external = self.tmp / 'external'
        external.mkdir()
        (external / 'cards').symlink_to('cards', target_is_directory=True)
        self.assert_external_unreadable()

    def test_e3_external_card_symlink_loop_is_unreadable(self):
        external = self.tmp / 'external'
        (external / 'cards').mkdir(parents=True)
        (external / 'cards' / 'a.md').symlink_to('a.md')
        self.assert_external_unreadable()

    def assert_external_unreadable(self):
        self.card('blocked', '依赖：../external/a\n等外部交付')
        self.card('free', '独立任务')
        rows = {row['card']: row for row in self.run.status()['cards']}
        self.assertEqual(rows['blocked']['state'], 'waiting')
        self.assertIn('外部依赖暂不可读', rows['blocked']['waiting_reason'])
        self.assertNotIn('不存在', rows['blocked']['waiting_reason'])
        self.assertIs(rows['blocked']['external_deps'][0]['accepted_valid'], False)
        self.assertEqual(rows['free']['state'], 'ready')


if __name__ == '__main__':
    unittest.main()
