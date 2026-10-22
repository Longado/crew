"""跨运行依赖与逐卡读写：临时运行目录、假 Codex，不调用模型。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_worker import FAKE_CODEX, WORKER


class MixedRunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lead-mix-')
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name).resolve()
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.root = self.tmp / 'current'
        self.other = self.tmp / 'upstream'
        for root in (self.root, self.other):
            (root / 'cards').mkdir(parents=True)
        fake = self.tmp / 'codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'CREW_HOME': str(self.tmp / 'registry'),
                    'CODEX_HOME': str(self.tmp / 'codex-home'), 'PYTHONDONTWRITEBYTECODE': '1',
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl')}

    def card(self, name, body, root=None):
        ((root or self.root) / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=20)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def go(self, *args, root=None):
        root = root or self.root
        result = self.ok('run', root, '--cwd', self.work, '--seconds', '5', *args)
        for _ in range(15):
            status = self.ok('status', root)
            if not any(c['state'] in ('running', 'stalled') for c in status['cards']):
                return result
            self.ok('wait', root, '--minutes', '0.1')
        self.fail('假执行者未结束')

    def read(self, name, root=None):
        return json.loads(((root or self.root) / f'{name}.json').read_text())

    def rows(self):
        return {row['card']: row for row in self.ok('status', self.root)['cards']}

    def test_external_waits_then_uses_frozen_output_on_explicit_run(self):
        self.card('a', '上游任务', self.other)
        self.card('b', '依赖：../upstream/a\n下游任务')
        self.go(root=self.other)
        self.assertEqual(self.go()['dispatched'], [])
        row = self.rows()['b']
        self.assertEqual(row['state'], 'waiting')
        self.assertEqual(row['external_deps'][0]['state'], 'delivered')
        self.ok('accept', self.other, 'a', '--note', '已读')
        self.assertFalse((self.root / 'b.json').exists(), '外部验收不能自动派本运行')
        self.assertEqual(self.rows()['b']['state'], 'ready')
        self.assertEqual(self.go()['dispatched'], ['b'])
        frozen = self.read('a', self.other)['review']['accepted_output']
        self.assertIn(frozen, (self.root / 'b.prompt').read_text())

    def test_absolute_dependency_and_stale_acceptance(self):
        self.card('a', '上游任务', self.other)
        self.go(root=self.other)
        self.ok('accept', self.other, 'a', '--note', '已读', '--hold')
        self.card('b', f'依赖：{self.other}/a\n下游任务')
        self.assertEqual(self.rows()['b']['state'], 'ready')
        self.card('a', '上游已改版', self.other)
        self.assertEqual(self.go()['dispatched'], [])
        row = self.rows()['b']
        self.assertEqual(row['state'], 'waiting')
        self.assertIs(row['external_deps'][0]['accepted_valid'], False)
        self.assertIn('失效', row['waiting_reason'])
        self.card('a', '上游任务', self.other)
        self.assertEqual(self.go()['dispatched'], ['b'])

    def test_missing_external_directory_or_card_does_not_block_other_cards(self):
        self.card('missing_dir', '依赖：../absent/a\n等待目录')
        self.card('missing_card', '依赖：../upstream/absent\n等待卡')
        self.card('free', '可独立执行')
        self.assertEqual(self.go()['dispatched'], ['free'])
        for name, text in (('missing_dir', '目录不存在'), ('missing_card', '卡不存在')):
            row = self.rows()[name]
            self.assertEqual(row['state'], 'waiting')
            self.assertIn(text, row['waiting_reason'])

    def test_external_legacy_acceptance_keeps_existing_compatibility(self):
        self.card('a', '旧卡', self.other)
        (self.other / 'a.out').write_text('旧稿')
        (self.other / 'a.json').write_text(json.dumps({'state': 'finished', 'review': {'verdict': 'accepted'}}))
        self.card('b', '依赖：../upstream/a\n引用旧稿')
        self.assertIsNone(self.rows()['b']['external_deps'][0]['accepted_valid'])
        self.assertEqual(self.go()['dispatched'], ['b'])
        prompt = (self.root / 'b.prompt').read_text()
        self.assertIn(str(self.other / 'a.out'), prompt)
        self.assertIn('历史验收', prompt)

    def test_external_legacy_review_without_state_is_still_accepted(self):
        self.card('a', '旧卡', self.other)
        (self.other / 'a.json').write_text(json.dumps({'review': {'verdict': 'accepted'}}))
        self.card('b', '依赖：../upstream/a\n引用旧稿')
        self.assertEqual(self.rows()['b']['state'], 'ready')
        self.assertIsNone(self.rows()['b']['external_deps'][0]['accepted_valid'])

    def test_external_result_status_is_visible_while_waiting(self):
        self.card('a', '缺输入卡', self.other)
        (self.other / 'a.json').write_text(json.dumps({'state': 'finished', 'result': {'status': 'blocked'}}))
        self.card('b', '依赖：../upstream/a\n等输入')
        row = self.rows()['b']
        self.assertEqual(row['state'], 'waiting')
        self.assertEqual(row['external_deps'][0]['state'], 'blocked')

    def test_external_continuation_is_rejected(self):
        for dep in ('../upstream/a', str(self.other / 'a')):
            with self.subTest(dep=dep):
                self.card('b', f'依赖：{dep}\n接续：{dep}\n任务')
                result = self.cli('run', self.root, '--cwd', self.work)
                self.assertEqual(result.returncode, 2)
                self.assertIn('不支持跨运行接续', result.stderr)

    def test_external_graph_is_not_traversed_for_cycles(self):
        self.card('a', '依赖：../current/b\n外部卡', self.other)
        self.card('b', '依赖：../upstream/a\n本卡')
        self.assertEqual(self.go()['dispatched'], [])
        self.assertEqual(self.rows()['b']['state'], 'waiting')

    def test_without_write_dispatches_reader_and_defers_writer(self):
        self.card('read', '只读任务')
        self.card('write', '可写：result.txt\n写任务')
        result = self.go()
        self.assertEqual(result['dispatched'], ['read'])
        self.assertEqual(result['deferred'], [{'card': 'write', 'reason': '写卡需要 --write'}])
        self.assertEqual(self.read('read')['sandbox'], 'read-only')
        self.assertFalse((self.root / 'baseline.json').exists())
        self.assertFalse((self.root / 'scratch').exists())
        self.assertEqual(self.go('--write')['dispatched'], ['write'])
        self.assertEqual(self.read('write')['sandbox'], 'danger-full-access')

    def test_with_write_dispatches_both_with_individual_modes(self):
        self.card('read', '只读任务')
        self.card('write', '可写：result.txt\n写任务')
        self.assertEqual(self.go('--write')['dispatched'], ['read', 'write'])
        for name, mode in (('read', 'read-only'), ('write', 'danger-full-access')):
            self.assertEqual(self.read(name)['sandbox'], mode)
            self.assertIs(self.read(name)['write'], name == 'write')
        calls = [json.loads(line) for line in (self.tmp / 'calls.jsonl').read_text().splitlines()]
        by_card = {Path(call['args'][call['args'].index('-o') + 1]).stem: call for call in calls}
        for name, mode in (('read', 'read-only'), ('write', 'danger-full-access')):
            args = by_card[name]['args']
            self.assertEqual(args[args.index('-s') + 1], mode)
        self.assertTrue((self.root / 'baseline.json').is_file())
        self.assertTrue((self.root / 'scratch' / 'write').is_dir())
        self.assertFalse((self.root / 'scratch' / 'read').exists())
        self.assertIn('只读：不写文件', (self.root / 'read.prompt').read_text())
        self.assertIn('只改任务卡「可写」', (self.root / 'write.prompt').read_text())
        review = self.ok('accept', self.root, 'read', '--note', '已读', '--hold')
        self.assertTrue(review['source_warnings'])
        (self.work / 'result.txt').write_text('本卡改动')
        self.assertEqual(self.ok('changes', self.root)['added'][0]['cards'], ['write'])

    def test_body_writable_example_does_not_make_reader_writable(self):
        self.card('read', '核查下列示例\n可写：example.txt\n正文')
        self.go('--write')
        self.assertEqual(self.read('read')['sandbox'], 'read-only')
        self.assertFalse((self.root / 'baseline.json').exists())

    def test_latest_dispatch_permission_controls_auto_dispatch(self):
        self.card('old', '可写：old.txt\n写卡')
        self.go('--write')
        self.card('read', '读卡')
        self.card('next', '依赖：read\n可写：next.txt\n写卡')
        self.go()
        result = self.cli('accept', self.root, 'read', '--note', '已读')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('--write', result.stderr)
        review = json.loads(result.stdout)
        self.assertEqual(self.read('read')['review']['verdict'], 'accepted')
        self.assertEqual(review['dispatched'], [])
        self.assertEqual(review['deferred'][0]['reason'], '写卡需要 --write')
        self.assertEqual(self.go('--write')['dispatched'], ['next'])

    def test_legacy_writer_without_header_requires_explicit_fresh(self):
        for session in (None, 'legacy-session'):
            with self.subTest(session=session):
                self.card('old', '旧写卡没有可写头')
                (self.root / 'run.json').write_text(json.dumps({'write': True, 'cwd': str(self.work)}))
                receipt = {'state': 'finished', 'cwd': str(self.work), 'sandbox': 'danger-full-access',
                           'model': None, 'session_id': session, 'review': {'verdict': 'rejected', 'note': '重试'}}
                (self.root / 'old.json').write_text(json.dumps(receipt))
                before = (self.root / 'old.json').read_bytes()
                result = self.cli('run', self.root, '--retry', 'old', '--write')
                self.assertEqual(result.returncode, 2)
                self.assertIn('--fresh', result.stderr)
                self.assertEqual((self.root / 'old.json').read_bytes(), before)
                self.go('--retry', 'old', '--fresh')
                self.assertEqual(self.read('old')['sandbox'], 'read-only')

    def test_legacy_write_binding_and_explicit_write_permission_survive(self):
        self.card('write', '可写：result.txt\n旧运行新写卡')
        self.card('read', '旧运行新只读卡')
        (self.root / 'run.json').write_text(json.dumps({'write': True, 'cwd': str(self.work)}))
        result = self.go()
        self.assertEqual(result['dispatched'], ['read'])
        self.assertEqual(result['deferred'][0]['reason'], '写卡需要 --write')
        self.assertIs(self.read('run')['write'], True)
        wrong = self.cli('run', self.root, '--cwd', self.tmp, '--write')
        self.assertEqual(wrong.returncode, 2)
        self.assertIn('绑定', wrong.stderr)
        self.assertEqual(self.go('--write')['dispatched'], ['write'])

    def test_first_write_retry_cannot_use_another_receipts_directory(self):
        self.card('old', '只读任务')
        self.go()
        self.ok('reject', self.root, 'old', '--note', '改为写任务')
        self.card('old', '可写：result.txt\n写任务')
        # 只读运行曾换默认目录，重试仍优先继承旧卡目录，不能给另一目录拍底。
        meta = self.read('run')
        meta['cwd'] = str(self.tmp)
        (self.root / 'run.json').write_text(json.dumps(meta))
        before = (self.root / 'old.json').read_bytes()
        result = self.cli('run', self.root, '--write', '--retry', 'old', '--fresh')
        self.assertEqual(result.returncode, 2)
        self.assertIn('绑定', result.stderr)
        self.assertEqual((self.root / 'old.json').read_bytes(), before)
        self.assertFalse((self.root / 'baseline.json').exists())


if __name__ == '__main__':
    unittest.main()
