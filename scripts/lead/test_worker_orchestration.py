"""负责人编排：用假 Codex 检查参数、结论卡、验收推进和复审差异，不调用模型。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_worker import FAKE_CODEX, WORKER


class OrchestrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        fake = self.tmp / 'codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.run_dir = self.tmp / 'run'
        (self.run_dir / 'cards').mkdir(parents=True)

    def card(self, name, body):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def worker(self, *args):
        return subprocess.run([sys.executable, str(WORKER), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def ok(self, *args):
        result = self.worker(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def read(self, name):
        return json.loads((self.run_dir / f'{name}.json').read_text(encoding='utf-8'))

    def calls(self):
        log = self.tmp / 'calls.jsonl'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def finish(self):
        for _ in range(20):
            status = json.loads(self.ok('status', self.run_dir).stdout)
            if not any(c['state'] == 'running' for c in status['cards']):
                return
            self.ok('wait', self.run_dir, '--minutes', '0.1')
        self.fail('假执行者没有结束')

    def go(self, *args):
        self.ok('run', self.run_dir, '--cwd', self.tmp, *args)
        self.finish()

    def test_model_and_extended_effort_are_forwarded_and_recorded(self):
        for effort in ('max', 'ultra'):
            with self.subTest(effort=effort):
                self.card(effort, '任务')
                self.go('--model', 'fixture-model', '--effort', effort, '--minutes', '0.1')
                args = self.calls()[-1]['args']
                self.assertEqual(args[args.index('--model') + 1], 'fixture-model')
                self.assertIn(f'model_reasoning_effort={effort}', args)
                for record in (self.read('run'), self.read(effort)):
                    self.assertEqual(record.get('model'), 'fixture-model')
                    self.assertEqual(record.get('effort'), effort)
                meta = self.read('run')
                self.assertEqual(meta.get('cwd'), str(self.tmp))
                self.assertEqual(meta.get('minutes'), 0.1)
                self.assertIs(meta['write'], False)

    def test_omitting_model_keeps_codex_configuration_default(self):
        self.card('t1', '任务')
        self.go()
        self.assertNotIn('--model', self.calls()[0]['args'])
        for record in (self.read('run'), self.read('t1')):
            self.assertIn('model', record)
            self.assertIsNone(record['model'])
            self.assertEqual(record['effort'], 'high')

    def test_retry_inherits_the_cards_model_and_effort(self):
        self.card('t1', '任务')
        self.go('--model', 'original-model', '--effort', 'xhigh')
        self.ok('reject', self.run_dir, 't1', '--note', '补充依据')
        # 其他卡改过整批的默认参数，续改仍应沿用本卡的参数。
        self.card('t2', '另一任务')
        self.go('--model', 'other-model', '--effort', 'low')
        self.go('--retry', 't1')
        args = self.calls()[-1]['args']
        self.assertIn('resume', args)
        self.assertIn('model_reasoning_effort=xhigh', args)
        self.assertEqual(args[args.index('--model') + 1], 'original-model')
        self.assertEqual(self.read('t1').get('model'), 'original-model')
        self.assertEqual(self.read('t1').get('effort'), 'xhigh')

    def test_retry_can_override_each_parameter_independently(self):
        self.card('t1', '任务')
        self.go('--model', 'original-model', '--effort', 'high')
        session = self.read('t1')['session_id']
        self.ok('reject', self.run_dir, 't1', '--note', '补充依据')
        # 只改 effort 仍续原会话，命令和回执都记录新档位。
        self.go('--retry', 't1', '--effort', 'max')
        self.assertEqual(self.calls()[-1]['args'][:3], ['exec', 'resume', session])
        self.assertIn('model_reasoning_effort=max', self.calls()[-1]['args'])
        self.assertEqual(self.read('t1').get('resumed_from'), session)
        self.assertEqual(self.read('t1').get('model'), 'original-model')
        self.assertEqual(self.read('t1').get('effort'), 'max')
        self.ok('reject', self.run_dir, 't1', '--note', '再核一处')
        # 换模型未加 --fresh 时拒绝，旧交付、回执和历史归档保持原样。
        before = {p.relative_to(self.run_dir): p.read_bytes() for p in self.run_dir.rglob('*') if p.is_file()}
        calls = self.calls()
        result = self.worker('run', self.run_dir, '--cwd', self.tmp,
                             '--retry', 't1', '--model', 'replacement-model')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('--fresh', result.stderr)
        self.assertEqual({p.relative_to(self.run_dir): p.read_bytes() for p in self.run_dir.rglob('*') if p.is_file()}, before)
        self.assertEqual(self.calls(), calls)
        # 显式重开后才允许换模型，继续沿用刚请求的 effort。
        self.go('--retry', 't1', '--fresh', '--model', 'replacement-model')
        args = self.calls()[-1]['args']
        self.assertNotIn('resume', args)
        self.assertEqual(args[args.index('--model') + 1], 'replacement-model')
        self.assertEqual(self.read('t1').get('fresh_after'), session)
        self.assertNotIn('resumed_from', self.read('t1'))
        self.assertEqual(self.read('t1').get('model'), 'replacement-model')
        self.assertEqual(self.read('t1').get('effort'), 'max')

    def test_both_rules_require_the_five_field_conclusion_card(self):
        self.card('t1', '可写：result.txt\n任务')
        self.go()
        for flag in (False, True):
            if flag:
                self.run_dir = self.tmp / 'write-run'
                (self.run_dir / 'cards').mkdir(parents=True)
                self.card('t1', '可写：result.txt\n任务')
                self.go('--write')
            prompt = self.calls()[-1]['prompt']
            for required in ('## 结论卡', '300—500', '问题／本次结论', '依据', '反证／尚缺什么', '交回决定', '产物'):
                self.assertIn(required, prompt)

    def test_wait_includes_only_the_new_conclusion_section(self):
        summary = ('## 结论卡\n问题／本次结论：完成\n依据：测试产物\n'
                   '### 补充\n反证／尚缺什么：无\n交回决定：继续\n产物：result.txt')
        self.env['FAKE_REPLY'] = summary + '\n\n## 细节\n这里不应进入结论卡\n'
        self.card('t1', '任务')
        self.ok('run', self.run_dir, '--cwd', self.tmp)
        first = json.loads(self.ok('wait', self.run_dir, '--minutes', '0.1').stdout)
        self.assertEqual(first.get('fresh'), ['t1'])
        self.assertEqual(first['cards'][0].get('conclusion'), summary)
        second = json.loads(self.ok('wait', self.run_dir, '--minutes', '0.1').stdout)
        self.assertEqual(second.get('fresh'), [])
        self.assertNotIn('conclusion', second['cards'][0])

    def test_wait_marks_a_missing_conclusion(self):
        self.card('t1', '任务')
        self.ok('run', self.run_dir, '--cwd', self.tmp)
        result = json.loads(self.ok('wait', self.run_dir, '--minutes', '0.1').stdout)
        self.assertIn('缺少', result['cards'][0].get('conclusion', ''))
        self.assertIn('## 结论卡', result['cards'][0]['conclusion'])

    def test_accept_dispatches_newly_ready_downstream_with_saved_parameters(self):
        self.card('t1', '可写：a.txt\n任务')
        self.card('t2', '依赖：t1\n可写：b.txt\n下游')
        self.go('--write', '--model', 'fixture-model', '--effort', 'ultra', '--minutes', '0.1')
        result = json.loads(self.ok('accept', self.run_dir, 't1', '--note', '已抽查').stdout)
        self.assertEqual(result.get('dispatched'), ['t2'])
        self.finish()
        self.assertEqual(len(self.calls()), 2)
        downstream = self.calls()[-1]
        self.assertEqual(Path(downstream['cwd']), self.tmp)
        self.assertIn('danger-full-access', downstream['args'])
        self.assertIn('model_reasoning_effort=ultra', downstream['args'])
        self.assertEqual(self.read('t2')['model'], 'fixture-model')
        self.assertIn(str(self.run_dir / 't1.out'), downstream['prompt'])
        self.assertEqual(self.read('run')['minutes'], 0.1)

    def test_hold_only_accepts_and_other_accepts_do_not_release_held_branches(self):
        self.card('t1', '任务')
        self.card('t2', '依赖：t1\n下游')
        self.card('other', '另一任务')
        self.card('next', '依赖：other\n另一下游')
        self.go()
        held = json.loads(self.ok('accept', self.run_dir, 't1', '--note', '稍后派', '--hold').stdout)
        self.assertEqual(held.get('dispatched'), [])
        self.assertEqual(self.read('t1')['review']['verdict'], 'accepted')
        self.assertFalse((self.run_dir / 't2.json').exists())
        result = json.loads(self.ok('accept', self.run_dir, 'other', '--note', '继续').stdout)
        self.assertEqual(result.get('dispatched'), ['next'])
        self.finish()
        self.assertFalse((self.run_dir / 't2.json').exists())
        self.go()
        self.assertEqual(self.read('t2')['state'], 'finished')

    def test_accept_waits_for_all_dependencies(self):
        self.card('a', '任务 A')
        self.card('b', '任务 B')
        self.card('join', '依赖：a, b\n综合')
        self.go()
        result = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '看过').stdout)
        self.assertEqual(result.get('dispatched'), [])
        self.assertFalse((self.run_dir / 'join.json').exists())
        result = json.loads(self.ok('accept', self.run_dir, 'b', '--note', '看过').stdout)
        self.assertEqual(result.get('dispatched'), ['join'])
        self.finish()

    def test_old_runs_without_dispatch_parameters_only_accept(self):
        self.card('t1', '任务')
        self.card('t2', '依赖：t1\n下游')
        self.go()
        meta = self.read('run')
        for key in ('cwd', 'minutes', 'effort', 'model'):
            meta.pop(key, None)
        (self.run_dir / 'run.json').write_text(json.dumps(meta), encoding='utf-8')
        result = json.loads(self.ok('accept', self.run_dir, 't1', '--note', '看过').stdout)
        self.assertEqual(result.get('dispatched'), [])
        self.assertFalse((self.run_dir / 't2.json').exists())
        self.assertEqual(self.read('t1')['review']['verdict'], 'accepted')

    def test_failed_citation_check_does_not_dispatch_downstream(self):
        self.card('t1', '任务')
        self.card('t2', '依赖：t1\n下游')
        self.env['FAKE_REPLY'] = f'{self.tmp}/missing.txt:1'
        self.go()
        result = self.worker('accept', self.run_dir, 't1', '--note', '看过')
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.run_dir / 't2.json').exists())
        self.assertNotIn('review', self.read('t1'))

    def test_dispatch_failure_keeps_acceptance_and_reports_the_remaining_work(self):
        self.card('t1', '任务')
        self.card('t2', '依赖：t1\n下游')
        self.go()
        self.env['FAKE_STUCK'] = '1'
        result = self.worker('accept', self.run_dir, 't1', '--note', '已看过')
        self.assertEqual(result.returncode, 2)
        self.assertIn('已验收', result.stderr)
        self.assertIn('下游未能全部派出', result.stderr)
        self.assertEqual(self.read('t1')['review']['verdict'], 'accepted')
        self.assertFalse((self.run_dir / 't2.json').exists())

    def test_diff_compares_latest_archive_of_this_card_with_current_output(self):
        self.card('t1', '任务')
        history = self.run_dir / 'history'
        history.mkdir()
        (history / 't1-20260101-000001.out').write_text('过早版本\n', encoding='utf-8')
        latest = history / 't1-20260101-000002.out'
        latest.write_text('不变\n旧结论\n', encoding='utf-8')
        (history / 't1-other-20260101-000003.out').write_text('其他卡\n', encoding='utf-8')
        current = self.run_dir / 't1.out'
        current.write_text('不变\n新结论\n', encoding='utf-8')
        result = self.ok('diff', self.run_dir, 't1')
        self.assertIn(f'--- {latest}', result.stdout)
        self.assertIn(f'+++ {current}', result.stdout)
        self.assertIn('-旧结论\n+新结论', result.stdout)
        self.assertNotIn('过早版本', result.stdout)
        self.assertNotIn('其他卡', result.stdout)

    def test_diff_reports_no_previous_delivery_and_unknown_card(self):
        self.card('t1', '任务')
        self.assertIn('没有旧交付', self.ok('diff', self.run_dir, 't1').stdout)
        self.assertEqual(self.worker('diff', self.run_dir, 'missing').returncode, 2)

    def test_diff_orders_old_and_precise_timestamps_in_the_same_second(self):
        self.card('t1', '任务')
        history = self.run_dir / 'history'
        history.mkdir()
        (history / 't1-20260101-000001.out').write_text('整秒旧稿\n', encoding='utf-8')
        (history / 't1-20260101-000001-000001.out').write_text('稍后旧稿\n', encoding='utf-8')
        (self.run_dir / 't1.out').write_text('当前稿\n', encoding='utf-8')
        result = self.ok('diff', self.run_dir, 't1')
        self.assertIn('-稍后旧稿\n+当前稿', result.stdout)
        self.assertNotIn('-整秒旧稿', result.stdout)

    def test_diff_uses_real_retry_archives(self):
        self.card('t1', '任务')
        self.env['FAKE_REPLY'] = '初稿\n'
        self.go()
        self.ok('reject', self.run_dir, 't1', '--note', '改结论')
        self.env['FAKE_REPLY'] = '第二稿\n'
        self.go('--retry', 't1')
        self.assertIn('-初稿\n+第二稿', self.ok('diff', self.run_dir, 't1').stdout)
        self.ok('reject', self.run_dir, 't1', '--note', '再核')
        self.env['FAKE_REPLY'] = '第三稿\n'
        self.go('--retry', 't1')
        self.assertIn('-第二稿\n+第三稿', self.ok('diff', self.run_dir, 't1').stdout)
        self.assertEqual(len(list((self.run_dir / 'history').glob('*.out'))), 2)


if __name__ == '__main__':
    unittest.main()
