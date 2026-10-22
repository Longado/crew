"""第六轮：凭据隐藏的耗时、带引号格式、展示副本与诊断误伤；只用临时目录和假 Codex。"""
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX


SAMPLES = [
    ('{"api_key": "fixture-json-secret"}', 'fixture-json-secret'),
    ('{"Authorization": "Bearer fixture-bearer-secret"}', 'fixture-bearer-secret'),
    ("{'token': 'fixture-dict-secret'}", 'fixture-dict-secret'),
    ("{'Authorization': 'Basic Zml4dHVyZTpwYXNz'}", 'Zml4dHVyZTpwYXNz'),
    ('{"PASSWORD":"fixture-password","ok":true}', 'fixture-password'),
    ('{"secret": "fixture secret with spaces"}', 'fixture secret with spaces'),
    (r'{"api-key": "fixture\"escaped-secret"}', r'fixture\"escaped-secret'),
    ('api_key="fixture-assignment-secret"', 'fixture-assignment-secret'),
    ('Authorization: Bearer fixture-header-secret', 'fixture-header-secret'),
    ('https://fixture-user:fixture-pass@example.invalid/path', 'fixture-user:fixture-pass'),
]


class R6FixTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r6fix-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'token=regression-card'
        (self.root / 'cards').mkdir(parents=True)
        self.run = worker.Run(self.root)
        self.name = 'token=fixture-card-123'
        (self.root / 'cards' / f'{self.name}.md').write_text('合成任务', encoding='utf-8')
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX.replace("out = args[args.index('-o') + 1]", """
print('Error: ' + os.environ['FAKE_R6_ERROR'])
sys.exit(7)
out = args[args.index('-o') + 1]
"""), encoding='utf-8')
        fake.chmod(0o755)
        environment = mock.patch.dict(os.environ, {
            'CREW_HOME': str(self.tmp / 'registry'), 'CREW_CODEX_BIN': str(fake),
            'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'PYTHONDONTWRITEBYTECODE': '1'})
        environment.start()
        self.addCleanup(environment.stop)

    def receipt(self, **extra):
        prompt = self.root / f'{self.name}.prompt'
        prompt.write_text('合成任务', encoding='utf-8')
        receipt = {'state': 'failed', 'attempt_id': 'fixture-attempt', 'pid': 0,
                   'started_at': worker.now(), 'cwd': str(self.tmp), 'prompt': str(prompt),
                   'output': str(self.root / f'{self.name}.out'),
                   'log': str(self.root / f'{self.name}.log'), **extra}
        worker.write_json(self.root / f'{self.name}.json', receipt)
        return receipt

    def test_r1_long_plain_line_finishes_within_one_second(self):
        text = 'a-' * 32768
        started = time.perf_counter()
        self.assertEqual(worker.redact(text), text)
        self.assertLess(time.perf_counter() - started, 1)

    def test_r1_long_colon_authority_finishes_within_one_second(self):
        text = 'https://' + ':' * (65536 - 8)
        started = time.perf_counter()
        self.assertEqual(worker.redact(text), text)
        self.assertLess(time.perf_counter() - started, 1)

    def test_r1_url_credentials_still_hide_with_colons_in_password(self):
        text = '凭据git+ssh://fixture-user:fixture:pass@example.invalid/path'
        self.assertEqual(worker.redact(text), '凭据git+ssh://' + worker.REDACTED + '@example.invalid/path')

    def test_r1_url_after_punctuation_still_hides_credentials(self):
        self.assertEqual(worker.redact('-https://fixture-user:fixture-pass@example.invalid'),
                         '-https://' + worker.REDACTED + '@example.invalid')

    def test_r2_quoted_credentials_hide_in_all_failure_sources(self):
        log = self.root / 'sample.log'
        for sample, secret in SAMPLES:
            for source in ('error', 'stop', 'protocol', 'log', 'heartbeat'):
                with self.subTest(sample=sample, source=source):
                    receipt = {'state': 'failed', 'started_at': worker.now()}
                    log.write_text('Error: ' + sample, encoding='utf-8')
                    if source == 'error':
                        receipt['error'] = sample
                    elif source == 'stop':
                        receipt.update(state='stopped', stop_requested={'note': sample})
                    elif source == 'protocol':
                        receipt.update(state='finished', result={'status': 'protocol_error', 'errors': [sample]})
                    text = (worker.log_heartbeat(receipt, log)['last_output'] if source == 'heartbeat' else
                            worker.failure_reason(receipt, log if source == 'log' else None))
                    self.assertNotIn(secret, text)
                    self.assertIn(worker.REDACTED, text)

    def test_r2_quoted_replacement_keeps_json_punctuation_and_is_idempotent(self):
        text = '{"api_key":"fixture-secret", "ok":true}'
        hidden = worker.redact(text)
        self.assertEqual(json.loads(hidden), {'api_key': worker.REDACTED, 'ok': True})
        self.assertEqual(worker.redact(hidden), hidden)

    def test_r2_legacy_unclosed_quote_and_punctuation_in_values_still_hide(self):
        for text in ('api_key="fixture-secret', "password='fixture-secret", 'secret=abc,123456'):
            with self.subTest(text=text):
                self.assertNotIn('fixture-secret', worker.redact(text))
                self.assertNotIn('123456', worker.redact(text))
                self.assertIn(worker.REDACTED, worker.redact(text))

    def test_r2_fake_failure_hides_credentials_but_keeps_raw_log(self):
        receipt = self.receipt(state='running')
        sample, secret = SAMPLES[0]
        with mock.patch.dict(os.environ, FAKE_R6_ERROR=sample):
            worker.guard(self.root, self.name, 10,
                         [os.environ['CREW_CODEX_BIN'], 'exec', '-o', receipt['output']],
                         receipt['attempt_id'], .05)
        self.assertEqual(self.run.receipt(self.name)['state'], 'failed')
        for value in (self.run.receipt(self.name), self.run.status(),
                      worker.wait_result(self.run, self.run.wait(0))):
            self.assertNotIn(secret, json.dumps(value))
        self.assertIn(secret, Path(receipt['log']).read_text(encoding='utf-8'))

    def test_r3_status_and_wait_hide_free_text_without_changing_structure_or_receipts(self):
        text = 'Authorization: Bearer fixture-display-secret'
        identifier = 'token=fixture-coverage-123'
        receipt = self.receipt(
            stop_requested={'note': text, 'attempt_id': 'fixture-attempt'},
            heartbeat={'last_output': text}, failure_reason=text,
            review={'verdict': 'rejected', 'note': text, 'accepted_output': str(self.root / 'accepted.out'),
                    'accepted_gaps': [{'id': identifier, 'reason': text}], 'source_warnings': [text]},
            result={'status': 'partial', 'questions': [text], 'errors': [text],
                    'covered': [identifier], 'skipped': [{'id': identifier, 'reason': text}]})
        Path(receipt['output']).write_text('## 结论卡\n' + text + '\n## 正文\n原始交付', encoding='utf-8')
        originals = {path: path.read_bytes() for path in (self.root / f'{self.name}.json', Path(receipt['output']))}
        for result in (self.run.status(), worker.wait_result(self.run, [self.name])):
            row = result['cards'][0]
            fields = [row['stop_requested']['note'], row['heartbeat']['last_output'], row['failure_reason'],
                      row['review']['note'], row['review']['accepted_gaps'][0]['reason'],
                      row['review']['source_warnings'][0], row['questions'][0], row['errors'][0],
                      row['skipped'][0]['reason']]
            if 'conclusion' in row:
                fields.append(row['conclusion'])
            for field in fields:
                with self.subTest(field=field):
                    self.assertNotIn('fixture-display-secret', field)
                    self.assertIn(worker.REDACTED, field)
            self.assertEqual(row['card'], self.name)
            self.assertEqual(row['covered'], [identifier])
            self.assertEqual(row['skipped'][0]['id'], identifier)
            self.assertEqual(row['review']['accepted_gaps'][0]['id'], identifier)
            self.assertEqual(row['output'], receipt['output'])
            self.assertEqual(row['review']['accepted_output'], receipt['review']['accepted_output'])
        for path, content in originals.items():
            self.assertEqual(path.read_bytes(), content)
        with mock.patch.object(self.run, 'receipt', return_value=receipt):
            self.run.status()
        self.assertEqual(receipt['result']['questions'], [text])
        self.assertEqual(receipt['review']['accepted_gaps'][0]['reason'], text)

    def test_r3_private_stop_request_and_wait_conclusion_hide_credentials(self):
        receipt = self.receipt(state='stopped')
        private = self.root / '.attempts' / receipt['attempt_id']
        private.mkdir(parents=True)
        request = {'note': SAMPLES[0][0], 'attempt_id': receipt['attempt_id']}
        worker.write_json(private / 'stop.json', request)
        Path(receipt['output']).write_text('## 结论卡\n' + SAMPLES[1][0], encoding='utf-8')
        result = worker.wait_result(self.run, self.run.wait(0))
        self.assertEqual(result['fresh'], [self.name])
        self.assertNotIn(SAMPLES[0][1], result['cards'][0]['stop_requested']['note'])
        self.assertNotIn(SAMPLES[1][1], result['cards'][0]['conclusion'])
        self.assertEqual(worker.read_json(private / 'stop.json'), request)

    def test_r3_external_dependency_exception_is_hidden_in_waiting_reason(self):
        (self.root / 'cards' / f'{self.name}.md').write_text('依赖：../external/a\n合成任务', encoding='utf-8')
        with mock.patch.object(Path, 'stat', side_effect=OSError('api_key=fixture-external-secret')):
            dependency = self.run.dependency('../external/a', {})
        self.assertNotIn('fixture-external-secret', dependency['reason'])
        with mock.patch.object(self.run, 'dependency', return_value=dependency):
            row = self.run.status()['cards'][0]
        self.assertEqual(row['external_deps'][0]['card'], '../external/a')
        self.assertNotIn('fixture-external-secret', row['waiting_reason'])

    def test_r4_bare_token_diagnostics_survive_but_credential_shaped_values_hide(self):
        for value in ('function', 'identifier', 'unexpected', 'configuration'):
            text = 'SyntaxError: Unexpected token: ' + value
            with self.subTest(value=value):
                self.assertEqual(worker.redact(text), text)
                self.assertIn(text, worker.failure_reason({'state': 'failed', 'error': text}))
        for text in ('token: fixture12345', 'token: aBcDefGhIjKlMnOp', 'token: fixture-token-value',
                     'token=configuration', '"token": "configuration"', 'token: "configuration"'):
            with self.subTest(text=text):
                self.assertIn(worker.REDACTED, worker.redact(text))

    def test_r4_generated_log_paths_survive_failure_status_and_wait(self):
        receipt = self.receipt(error='api_key=fixture-real-secret')
        paths = [Path(receipt['log']), self.root / '.attempts' / receipt['attempt_id'] / f'{self.name}.log']
        for log in paths:
            with self.subTest(log=log):
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_text('普通日志，没有诊断关键词', encoding='utf-8')
                reason = worker.failure_reason(receipt, log)
                self.assertIn(str(log), reason)
                self.assertNotIn('fixture-real-secret', reason)
                self.receipt(failure_reason=reason)
                for result in (self.run.status(), worker.wait_result(self.run, [self.name])):
                    self.assertIn(str(log), result['cards'][0]['failure_reason'])

    def test_r4_untrusted_log_path_hint_does_not_bypass_redaction(self):
        self.receipt(failure_reason='未见错误关键词，请查看日志：/untrusted/token=fixture-secret-123/a.log')
        self.assertNotIn('fixture-secret-123', self.run.status()['cards'][0]['failure_reason'])

    def test_first_empty_log_uses_file_time_without_refreshing_known_activity(self):
        started = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).astimezone()
        created = started + dt.timedelta(seconds=30)
        log = self.root / 'empty.log'
        log.touch()
        os.utime(log, (created.timestamp(), created.timestamp()))
        receipt = {'started_at': started.isoformat(timespec='milliseconds')}
        heartbeat = worker.log_heartbeat(receipt, log)
        self.assertEqual(heartbeat['log_mtime'], created.isoformat(timespec='milliseconds'))
        self.assertEqual(heartbeat['log_bytes'], 0)
        self.assertIsNone(heartbeat['network_wait_since'])
        # 空日志的后续采样已有活动基准，单纯 touch 不算执行者取得进展。
        receipt['heartbeat'] = heartbeat
        later = created + dt.timedelta(seconds=10)
        os.utime(log, (later.timestamp(), later.timestamp()))
        self.assertEqual(worker.log_heartbeat(receipt, log)['log_mtime'], heartbeat['log_mtime'])


if __name__ == '__main__':
    unittest.main()
