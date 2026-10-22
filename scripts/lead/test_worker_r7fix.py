"""第七轮展示与心跳边界：合成凭据、临时目录、假 Codex。"""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import stats
import worker
from test_stats import event
from test_worker import FAKE_CODEX
from test_worker_r6 import NETWORK_LINES


# 两端共读这一组 JSON；tests/redact.test.ts 直接读取，不另存一份易漂移的样例。
R7_CASES = json.loads(r'''[
  ["--api-key fixture-cli123", "--api-key [已隐藏的凭证]"],
  ["--token short", "--token [已隐藏的凭证]"],
  ["--password 'fixture pass' --verbose", "--password '[已隐藏的凭证]' --verbose"],
  ["--api_key\tfixture-cli123", "--api_key\t[已隐藏的凭证]"],
  ["AWS_SECRET_ACCESS_KEY=fixture-aws123", "AWS_SECRET_ACCESS_KEY=[已隐藏的凭证]"],
  ["SERVICE_TOKEN_VALUE=short", "SERVICE_TOKEN_VALUE=[已隐藏的凭证]"],
  ["DB_PASSWORD_FILE=fixture-file123", "DB_PASSWORD_FILE=[已隐藏的凭证]"],
  ["MY_API_KEY_PRIMARY=\"fixture value\"", "MY_API_KEY_PRIMARY=\"[已隐藏的凭证]\""],
  ["export AWS_SECRET_ACCESS_KEY='fixture value'", "export AWS_SECRET_ACCESS_KEY='[已隐藏的凭证]'"],
  ["Cookie: sessionid=fixture-cookie123; theme=light", "Cookie: [已隐藏的凭证]"],
  ["Set-Cookie: session=fixture-cookie123; HttpOnly\nContent-Type: text/plain", "Set-Cookie: [已隐藏的凭证]\nContent-Type: text/plain"],
  ["cookie: short", "cookie: [已隐藏的凭证]"],
  ["https://:pass@example.invalid/path", "https://[已隐藏的凭证]@example.invalid/path"],
  ["redis://:fixture:pass@example.invalid:6379", "redis://[已隐藏的凭证]@example.invalid:6379"],
  ["password: \"first-line\nfixture-Error-leaked12345\"", "password: \"[已隐藏的凭证]\""],
  ["--tokens 123 --password-policy strict --api-key", "--tokens 123 --password-policy strict --api-key"],
  ["--token --help", "--token --help"],
  ["--token\nnormal output", "--token\nnormal output"],
  ["PUBLIC_MODE=fixture-value", "PUBLIC_MODE=fixture-value"],
  ["CookieJar: fixture-value", "CookieJar: fixture-value"],
  ["Cookie policy is documented", "Cookie policy is documented"],
  ["https://user@example.invalid/path", "https://user@example.invalid/path"],
  ["https://:no-password-host/path", "https://:no-password-host/path"],
  ["password: |\n  yaml-block-out-of-scope", "password: |\n  yaml-block-out-of-scope"]
]''')


class R7FixTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r7fix-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        (self.root / 'cards/a.md').write_text('合成任务', encoding='utf-8')
        self.run = worker.Run(self.root)
        self.log = self.root / 'a.log'
        self.receipt = {'started_at': worker.now()}
        self.mtime = time.time()
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        environment = mock.patch.dict(os.environ, {
            'CREW_HOME': str(self.tmp / 'registry'), 'CREW_CODEX_BIN': str(fake),
            'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'FAKE_NO_SESSION': '1',
            'PYTHONDONTWRITEBYTECODE': '1'})
        environment.start()
        self.addCleanup(environment.stop)
        # 不查真实原生会话库；本卡只验证日志与展示。
        tokens = mock.patch.object(worker, 'native_tokens', return_value=None)
        tokens.start()
        self.addCleanup(tokens.stop)

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = worker.main(list(map(str, args)))
        return code, out.getvalue(), err.getvalue()

    def append(self, text):
        with self.log.open('a', encoding='utf-8') as stream:
            stream.write(text)
        self.mtime += 1
        os.utime(self.log, (self.mtime, self.mtime))
        self.receipt['heartbeat'] = worker.log_heartbeat(self.receipt, self.log)
        return self.receipt['heartbeat']

    def save_receipt(self, **extra):
        receipt = {'state': 'finished', 'attempt_id': 'fixture-attempt', 'pid': 0,
                   'started_at': worker.now(), 'output': str(self.root / 'a.out'), **extra}
        worker.write_json(self.root / 'a.json', receipt)
        return receipt

    def test_s1_status_wait_hide_nested_extensions_and_preserve_raw_receipt(self):
        secret = 'fixture-display12345'
        text = 'api_key=' + secret
        extension = {'details': [text, {'output': text, 'status': text, 'at': text}]}
        receipt = self.save_receipt(result={
            'status': 'partial', 'questions': [text], 'errors': [text], 'covered': [],
            'skipped': [{'id': 'S1', 'reason': text, **extension}], 'raw': text},
            review={'verdict': 'rejected', 'note': text,
                    'accepted_gaps': [{'id': 'S1', 'reason': text, **extension}]})
        worker.write_json(self.root / 'run.json', {'goal': text, 'cwd': str(self.tmp)})
        Path(receipt['output']).write_text('## 结论卡\n' + text, encoding='utf-8')
        before = (self.root / 'a.json').read_bytes()
        for value in (self.run.status(), worker.wait_result(self.run, ['a'])):
            with self.subTest(value=value):
                self.assertNotIn(secret, json.dumps(value))
                self.assertEqual(value['cards'][0]['skipped'][0]['id'], 'S1')
                self.assertEqual(value['cards'][0]['output'], receipt['output'])
        self.assertEqual((self.root / 'a.json').read_bytes(), before)
        self.assertEqual(worker.read_json(self.root / 'a.json')['result']['raw'], text)

    def test_s1_cli_accept_reject_stop_and_protocol_error_hide_text(self):
        secret = 'fixture-command12345'
        text = 'api_key=' + secret
        for action in ('accept', 'reject', 'stop', 'protocol'):
            with self.subTest(action=action):
                output = self.root / 'a.out'
                output.write_text('交付', encoding='utf-8')
                self.save_receipt(state='lost' if action == 'stop' else 'finished')
                args = [action, self.root, 'a', '--note', text]
                if action == 'accept':
                    args.append('--hold')
                elif action == 'stop':
                    self.save_receipt(state='lost', attempt_id=None)
                    args.append('--confirm-exited')
                elif action == 'protocol':
                    self.save_receipt(result_contract={'version': 'result-v1', 'expected': ['S1']})
                    output.write_text('```json\n' + json.dumps({
                        'status': 'complete', 'covered': [text], 'skipped': []}) + '\n```', encoding='utf-8')
                    args = ['accept', self.root, 'a', '--note', '已抽查', '--hold']
                code, out, err = self.cli(*args)
                self.assertEqual(code, 2 if action == 'protocol' else 0, err)
                self.assertNotIn(secret, out + err)
                self.assertIn(worker.REDACTED, out + err)
                if action != 'protocol':
                    self.assertIn(secret, (self.root / 'a.json').read_text())

    def test_s1_fake_run_output_hides_goal_and_preserves_metadata(self):
        secret = 'fixture-goal12345'
        code, out, err = self.cli('run', self.root, '--cwd', self.tmp, '--seconds', '5',
                                  '--goal', 'api_key=' + secret)
        self.assertEqual(code, 0, err)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            receipt = self.run.receipt('a') or {}
            if receipt and receipt['state'] not in worker.ACTIVE_STATES:
                break
            time.sleep(.03)
        self.assertEqual(receipt['state'], 'finished')
        self.assertNotIn(secret, out + err)
        self.assertIn(secret, (self.root / 'run.json').read_text())

    def test_s1_native_stats_only_copy_declared_manifest_fields(self):
        root_log, child_log = self.tmp / 'root.jsonl', self.tmp / 'child.jsonl'
        for path, records in ((root_log, [event(0, 'task_started'), event(10, 'task_complete')]),
                              (child_log, [event(1, 'task_started', 'child', 'root'),
                                           event(5, 'task_complete', 'child', 'root')])):
            path.write_text(''.join(json.dumps(row) + '\n' for row in records), encoding='utf-8')
        agent = {'id': 'fixture-child', 'agent_path': '/root/child', 'rollout_path': str(child_log)}
        metrics = stats.summarize([{**agent, 'note': 'api_key=fixture-stats12345',
                                    'extra': {'details': 'fixture-extra'}}], root_log, 'root')
        self.assertEqual({k: metrics['children'][0][k] for k in agent}, agent)
        self.assertNotIn('note', metrics['children'][0])
        self.assertNotIn('extra', metrics['children'][0])

    def test_s1_external_generated_paths_survive_display(self):
        external = self.tmp / 'token=fixture-external123'
        dependency = {'card': '../token=fixture-external123/a', 'dir': str(external),
                      'original': str(external / 'a.out'), 'output': str(external / '.accepted/a.out'),
                      'state': 'accepted', 'accepted_valid': True, 'reason': 'api_key=fixture-reason123'}
        (self.root / 'cards/a.md').write_text('依赖：' + dependency['card'] + '\n任务', encoding='utf-8')
        with mock.patch.object(self.run, 'dependency', return_value=dependency):
            result = self.run.status()['cards'][0]['external_deps'][0]
        for key in ('card', 'dir', 'original', 'output'):
            self.assertEqual(result[key], dependency[key])
        self.assertNotIn('fixture-reason123', result['reason'])

    def test_s2_multiline_log_value_hidden_before_selecting_lines(self):
        secret = 'fixture-Error-leaked12345'
        self.log.write_text('password: "first-line\n' + secret + '"\n', encoding='utf-8')
        for value in (worker.log_heartbeat(self.receipt, self.log)['last_output'],
                      worker.failure_reason({'state': 'failed'}, self.log)):
            with self.subTest(value=value):
                self.assertNotIn(secret, value)
        self.assertIn(secret, self.log.read_text())

    def test_s2_tail_window_discards_incomplete_first_line_for_display(self):
        secret = 'fixture-Error-tail12345'
        self.log.write_text('password="' + 'x' * 70000 + secret + '"\n', encoding='utf-8')
        for value in (worker.log_heartbeat(self.receipt, self.log)['last_output'],
                      worker.failure_reason({'state': 'failed'}, self.log)):
            with self.subTest(value=value):
                self.assertNotIn(secret, value)
                self.assertNotIn('x' * 30, value)

    def test_s2_redact_before_discarding_partial_line_with_visible_key(self):
        secret = 'fixture-Error-window12345'
        self.log.write_text('x' * 70000 + ' password: "first-line\n' + secret + '"\n', encoding='utf-8')
        for value in (worker.log_heartbeat(self.receipt, self.log)['last_output'],
                      worker.failure_reason({'state': 'failed'}, self.log)):
            with self.subTest(value=value):
                self.assertNotIn(secret, value)

    def test_s2_complete_window_first_line_is_kept_for_display(self):
        first = 'Error: recovered\n'
        self.log.write_text('old line\n' + first + '\n' * (65536 - len(first)), encoding='utf-8')
        self.assertEqual(worker.log_heartbeat(self.receipt, self.log)['last_output'], first.strip())
        self.assertIn(first.strip(), worker.failure_reason({'state': 'failed'}, self.log))

    def test_s3_shared_positive_and_negative_cases(self):
        for text, expected in R7_CASES:
            with self.subTest(text=text):
                self.assertEqual(worker.redact(text), expected)
                self.assertEqual(worker.redact(expected), expected)

    def test_s4_guide_states_display_only_and_yaml_limit(self):
        guide = (worker.HERE / '指南.md').read_text(encoding='utf-8')
        for required in ('尽力而为', 'YAML 多行块', '回执文件不是脱敏导出，分享用 `status` 输出'):
            self.assertIn(required, guide)

    def test_h1_each_reconnect_split_waits_for_newline(self):
        normal = self.append('正常输出\n')
        waiting = self.append(NETWORK_LINES[0] + '\n')
        line = NETWORK_LINES[1] + '\n'
        for cut in range(1, len(line)):
            with self.subTest(cut=cut):
                partial = self.append(line[:cut])
                self.assertEqual(partial['log_mtime'], normal['log_mtime'])
                self.assertEqual(partial['network_wait_since'], waiting['network_wait_since'])
                full = self.append(line[cut:])
                self.assertEqual(full['log_mtime'], normal['log_mtime'])
                self.assertEqual(full['network_wait_since'], waiting['network_wait_since'])

    def test_h1_partial_normal_line_recovers_only_after_newline(self):
        waiting = self.append(NETWORK_LINES[0] + '\n')
        partial = self.append('正常恢复')
        self.assertEqual(partial['log_mtime'], waiting['log_mtime'])
        self.assertEqual(partial['network_wait_since'], waiting['network_wait_since'])
        full = self.append('\n')
        self.assertNotEqual(full['log_mtime'], waiting['log_mtime'])
        self.assertIsNone(full['network_wait_since'])

    def test_h2_exact_tail_boundary_preserves_complete_recovery_line(self):
        waiting = self.append(NETWORK_LINES[0] + '\n')
        line = NETWORK_LINES[1] + '\n'
        added = 'recovered\n'
        added += '\n' * ((65536 - len(added)) % len(line))
        added += line * ((65536 - len(added)) // len(line))
        self.assertEqual(len(added.encode()), 65536)
        full = self.append(added)
        self.assertNotEqual(full['log_mtime'], waiting['log_mtime'])
        self.assertNotEqual(full['network_wait_since'], waiting['network_wait_since'])

    def test_h2_overlong_unfinished_normal_line_clears_old_network_wait(self):
        waiting = self.append(NETWORK_LINES[0] + '\n')
        full = self.append('正常恢复' * 30000)
        self.assertNotEqual(full['log_mtime'], waiting['log_mtime'])
        self.assertIsNone(full['network_wait_since'])

    def test_h5_diagnostic_prefix_in_explanation_is_normal_output(self):
        for line in (*NETWORK_LINES, 'ERROR: Reconnecting...'):
            with self.subTest(line=line):
                waiting = self.append(NETWORK_LINES[0] + '\n')
                full = self.append(line + ' 是待核对的旧日志，当前任务正在正常分析。\n')
                self.assertNotEqual(full['log_mtime'], waiting['log_mtime'])
                self.assertIsNone(full['network_wait_since'])


if __name__ == '__main__':
    unittest.main()
