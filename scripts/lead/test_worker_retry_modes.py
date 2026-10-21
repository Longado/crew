"""退回后续原会话或重开：只用本地假 Codex，默认拒绝执行。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_worker import FAKE_CODEX, WORKER


FAKE_RETRY = FAKE_CODEX.replace(
    "print('1,234')", "print(os.environ.get('FAKE_TOKENS', '1,234'))"
).replace("print('session id: abc-123')",
          "print('session id: ' + os.environ.get('FAKE_SESSION', 'fixture-original'))")


class RetryModesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name).resolve()
        refuse = self.tmp / 'refuse-codex'
        refuse.write_text('#!/usr/bin/env python3\nraise SystemExit("测试未启用假 Codex")\n', encoding='utf-8')
        refuse.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(refuse),
                    'PYTHONDONTWRITEBYTECODE': '1', 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.run_dir = self.work / 'runs' / 'r1'
        (self.run_dir / 'cards').mkdir(parents=True)

    def enable_fake(self):
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_RETRY, encoding='utf-8')
        fake.chmod(0o755)
        self.env['CREW_CODEX_BIN'] = str(fake)

    def card(self, name, body):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def worker(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def ok(self, *args):
        result = self.worker(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def go(self, *args):
        self.ok('run', self.run_dir, '--cwd', self.work, '--seconds', '5', *args)
        for _ in range(15):
            status = json.loads(self.ok('status', self.run_dir).stdout)
            if not any(c['state'] == 'running' for c in status['cards']):
                self.assertFalse(any(c['state'] in ('failed', 'timed_out', 'lost') for c in status['cards']), status)
                return
            self.ok('wait', self.run_dir, '--minutes', '0.1')
        self.fail('假执行者没有结束')

    def read(self, name):
        return json.loads((self.run_dir / f'{name}.json').read_text(encoding='utf-8'))

    def calls(self):
        path = self.tmp / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []

    def rejected(self, *args):
        self.card('t1', '可写：allowed.txt\n初版任务')
        self.go(*args)
        self.ok('reject', self.run_dir, 't1', '--note', '请补充缺失来源')

    def preserved(self):
        return {p.relative_to(self.run_dir): p.read_bytes() for p in self.run_dir.rglob('*')
                if p.is_file() and p.name != '.lock'}

    def assert_refused(self, *args, hint='--fresh'):
        before, calls = self.preserved(), self.calls()
        result = self.worker('run', self.run_dir, '--cwd', self.work, '--seconds', '5', *args)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(hint, result.stderr)
        self.assertEqual(self.preserved(), before, '拒绝前不能归档或覆盖旧结果')
        self.assertEqual(self.calls(), calls, '拒绝后不能启动执行者')

    def test_default_retry_uses_original_session_and_current_card(self):
        self.enable_fake()
        self.rejected('--model', 'fixture-model', '--effort', 'high')
        body = '可写：allowed.txt\n负责人更新后的任务：按新版材料核对'
        self.card('t1', body)
        self.go('--retry', 't1', '--effort', 'max')
        call = self.calls()[-1]
        self.assertEqual(call['args'][:3], ['exec', 'resume', 'fixture-original'])
        self.assertIn(body, call['prompt'])
        self.assertIn('请补充缺失来源', call['prompt'])
        self.assertIn('model_reasoning_effort=max', call['args'])
        self.assertEqual(self.read('t1')['effort'], 'max')
        self.assertEqual(self.read('t1')['model'], 'fixture-model')
        self.assertNotIn('fresh_after', self.read('t1'))

    def test_fresh_includes_current_card_reason_history_and_dependencies(self):
        self.enable_fake()
        self.card('before', '前序任务')
        self.go()
        self.ok('accept', self.run_dir, 'before', '--note', '可供后续引用', '--hold')
        self.card('t1', '依赖：before\n初版任务')
        self.go()
        self.ok('reject', self.run_dir, 't1', '--note', '请补充缺失来源')
        old_output = (self.run_dir / 't1.out').read_text(encoding='utf-8')
        body = '依赖：before\n负责人更新后的任务：补齐来源'
        self.card('t1', body)
        self.env['FAKE_SESSION'] = 'fixture-new'
        self.env['FAKE_REPLY'] = '新交付'
        self.go('--retry', 't1', '--fresh')
        call, receipt = self.calls()[-1], self.read('t1')
        self.assertNotIn('resume', call['args'])
        self.assertNotIn('fixture-original', call['args'])
        self.assertIn(body, call['prompt'])
        self.assertIn('请补充缺失来源', call['prompt'])
        previous = self.read('before')['review'].get('accepted_output', str(self.run_dir / 'before.out'))
        self.assertIn(previous, call['prompt'])
        archived = list((self.run_dir / 'history').glob('t1-*.out'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_text(encoding='utf-8'), old_output)
        self.assertIn(str(archived[0]), call['prompt'])
        self.assertEqual(receipt['fresh_after'], 'fixture-original')
        self.assertEqual(receipt['session_id'], 'fixture-new')
        self.assertNotIn('resumed_from', receipt)

    def test_model_change_requires_fresh_and_preserves_old_results(self):
        self.enable_fake()
        self.rejected('--model', 'fixture-model')
        self.assert_refused('--retry', 't1', '--model', 'fixture-other')
        self.go('--retry', 't1', '--fresh', '--model', 'fixture-other')
        self.assertNotIn('resume', self.calls()[-1]['args'])
        self.assertEqual(self.read('t1')['model'], 'fixture-other')

    def test_explicit_model_from_codex_default_also_requires_fresh(self):
        self.enable_fake()
        self.rejected()
        self.assert_refused('--retry', 't1', '--model', 'fixture-model')

    def test_read_only_directory_change_requires_fresh(self):
        self.enable_fake()
        self.rejected()
        other = self.tmp / 'other'
        other.mkdir()
        self.assert_refused('--retry', 't1', '--cwd', other)
        self.go('--retry', 't1', '--fresh', '--cwd', other)
        self.assertEqual(self.calls()[-1]['cwd'], str(other))
        self.assertNotIn('resume', self.calls()[-1]['args'])

    def test_incompatible_retry_keeps_its_files_while_other_retry_runs(self):
        self.enable_fake()
        self.rejected('--model', 'fixture-first')
        self.card('t2', '另一张任务')
        self.go('--model', 'fixture-second')
        self.ok('reject', self.run_dir, 't2', '--note', '补充另一处来源')
        before = {ext: (self.run_dir / ('t2.' + ext)).read_bytes() for ext in ('json', 'out', 'log', 'prompt')}
        calls = self.calls()
        self.go('--retry', 't1', '--retry', 't2', '--model', 'fixture-first')
        self.assertEqual({ext: (self.run_dir / ('t2.' + ext)).read_bytes() for ext in before}, before)
        self.assertEqual(len(self.calls()), len(calls) + 1)
        self.assertTrue(list((self.run_dir / 'history').glob('t1-*.json')))
        self.assertFalse(list((self.run_dir / 'history').glob('t2-*')))

    def test_fresh_tokens_do_not_subtract_previous_session(self):
        self.enable_fake()
        self.env['FAKE_TOKENS'] = '90,000'
        self.rejected()
        self.env.update(FAKE_TOKENS='2,000', FAKE_SESSION='fixture-new')
        self.go('--retry', 't1', '--fresh')
        receipt = self.read('t1')
        self.assertEqual(receipt['tokens'], 2000)
        self.assertEqual(receipt['tokens_session'], 2000)
        self.assertNotIn('tokens_before', receipt)
        self.assertEqual(receipt['fresh_after'], 'fixture-original')
        self.ok('reject', self.run_dir, 't1', '--note', '再补一处')
        self.env['FAKE_TOKENS'] = '2,500'
        self.go('--retry', 't1')
        self.assertEqual(self.read('t1')['tokens'], 500)
        self.assertEqual(self.read('t1')['resumed_from'], 'fixture-new')

    def test_fresh_write_keeps_rules_baseline_and_changes_boundary(self):
        self.enable_fake()
        (self.work / 'allowed.txt').write_text('原文', encoding='utf-8')
        self.rejected('--write')
        baseline = (self.run_dir / 'baseline.json').read_bytes()
        self.go('--write', '--retry', 't1', '--fresh')
        call = self.calls()[-1]
        self.assertNotIn('resume', call['args'])
        self.assertIn('danger-full-access', call['args'])
        self.assertIn('只改任务卡「可写」', call['prompt'])
        self.assertIn('可写：allowed.txt', call['prompt'])
        scratch = self.run_dir / 'scratch' / 't1'
        self.assertTrue(scratch.is_dir())
        self.assertIn(str(scratch), call['prompt'])
        self.assertEqual((self.run_dir / 'baseline.json').read_bytes(), baseline)
        (self.work / 'allowed.txt').write_text('修改后的内容', encoding='utf-8')
        (self.work / 'outside.txt').write_text('越界示例', encoding='utf-8')
        result = self.worker('changes', self.run_dir)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['out_of_bounds'], ['outside.txt'])

    def test_fresh_cannot_change_write_binding(self):
        self.enable_fake()
        self.rejected('--write')
        other = self.tmp / 'other'
        other.mkdir()
        for fresh in ([], ['--fresh']):
            with self.subTest(fresh=fresh):
                self.assert_refused('--retry', 't1', *fresh, hint='--write')
                self.assert_refused('--retry', 't1', '--write', '--cwd', other, *fresh,
                                    hint='工作目录')

    def test_fresh_cannot_upgrade_read_only_to_write(self):
        self.enable_fake()
        self.rejected()
        self.assert_refused('--retry', 't1', '--fresh', '--write', hint='另开')

    def test_retry_without_session_keeps_rejection_reason(self):
        self.enable_fake()
        self.env['FAKE_NO_SESSION'] = '1'
        self.rejected()
        self.go('--retry', 't1')
        self.assertNotIn('resume', self.calls()[-1]['args'])
        self.assertIn('请补充缺失来源', self.calls()[-1]['prompt'])

    def test_fresh_without_retry_is_rejected_before_dispatch(self):
        self.card('t1', '不得派出的任务')
        self.assert_refused('--fresh', hint='--retry')


if __name__ == '__main__':
    unittest.main()
