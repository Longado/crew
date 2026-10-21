"""验收绑定版本：默认拒绝模型执行，派发场景才显式使用假 Codex。"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import notes
import stats
import worker
from test_worker import FAKE_CODEX, WORKER


class AcceptanceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        reject = self.tmp / 'reject-codex'
        reject.write_text('#!/bin/sh\necho "模型执行未获测试授权" >&2\nexit 97\n', encoding='utf-8')
        reject.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(reject),
                    'PYTHONDONTWRITEBYTECODE': '1', 'CODEX_HOME': str(self.tmp / 'codex-home'),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        environment = patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        worker.write_json(self.root / 'run.json', {'created_at': '2025-01-01T00:00:00Z'})
        self.run = worker.Run(self.root)

    def card(self, name='a', body='核对任务\n'):
        path = self.root / 'cards' / f'{name}.md'
        path.write_text(body, encoding='utf-8')
        return path

    def delivery(self, name='a', body='第一稿\n'):
        card = self.card(name)
        output = self.root / f'{name}.out'
        output.write_text(body, encoding='utf-8')
        receipt = {'card': str(card), 'card_sha256': hashlib.sha256(card.read_bytes()).hexdigest(),
                   'output': str(output), 'state': 'finished', 'started_at': '2025-01-01T00:00:01Z',
                   'ended_at': '2025-01-01T00:00:02Z', 'tokens': 0}
        worker.write_json(self.root / f'{name}.json', receipt)
        return output

    def accept(self, name='a', force=False):
        return self.run.review(name, 'accepted', '已抽查', force=force, hold=True)

    def legacy_receipt(self, name='a', verdict='accepted', card_hash=False):
        """沿用第一轮回执字段，覆盖完全无 hash 及仅派发时有 card_sha256 两种旧记录。"""
        self.delivery(name)
        receipt = self.run.receipt(name)
        if not card_hash:
            receipt.pop('card_sha256')
        receipt.update(deps=[], cwd=str(self.tmp), sandbox='read-only', disabled_mcp=[],
                       model=None, effort='high', pid=0, seconds=1, exit_code=0,
                       log=str(self.root / f'{name}.log'), prompt=str(self.root / f'{name}.prompt'),
                       session_id=None, tokens=12, tokens_session=12)
        if verdict:
            receipt['review'] = {'verdict': verdict, 'note': '旧版验收说明',
                                 'at': '2025-01-01T00:00:03Z', 'citations': 0, 'citations_bad': 0}
        worker.write_json(self.root / f'{name}.json', receipt)
        return receipt

    def states(self):
        return {c['card']: c['state'] for c in self.run.status()['cards']}

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def dispatch(self):
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env['CREW_CODEX_BIN'] = str(fake)
        result = self.cli('run', self.root, '--cwd', self.tmp, '--seconds', '2')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for _ in range(10):
            result = self.cli('wait', self.root, '--minutes', '0.05')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if not any(c['state'] == 'running' for c in json.loads(result.stdout)['cards']):
                return
        self.fail('假 Codex 未交回')

    def test_dispatched_card_change_cannot_be_forced(self):
        self.card()
        self.dispatch()
        self.card(body='改了任务\n')
        before = (self.root / 'a.json').read_bytes()
        for force in (False, True):
            (self.root / 'a.json').write_bytes(before)
            with self.subTest(force=force), self.assertRaisesRegex(ValueError, '卡片版本'):
                self.accept(force=force)
        self.assertEqual((self.root / 'a.json').read_bytes(), before)

    def test_missing_or_blank_delivery_cannot_be_forced(self):
        for content in (None, '', ' \n\t　'):
            for force in (False, True):
                output = self.delivery()
                if content is None:
                    output.unlink()
                else:
                    output.write_text(content, encoding='utf-8')
                with self.subTest(content=content, force=force):
                    result = self.cli('accept', self.root, 'a', '--note', '检查', '--hold',
                                      *(['--force'] if force else []))
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn('交付文件不存在或为空', result.stderr)
                    self.assertNotIn('review', self.run.receipt('a'))
        self.assertFalse((self.root / '.accepted').exists())

    def test_acceptance_records_card_output_and_frozen_hashes(self):
        output = self.delivery()
        review = self.accept()
        self.assertEqual(review.get('card_sha256'), self.run.receipt('a')['card_sha256'])
        self.assertEqual(review.get('output_sha256'), hashlib.sha256(output.read_bytes()).hexdigest())
        frozen = Path(review.get('accepted_output', 'missing'))
        self.assertTrue(frozen.is_file())
        self.assertNotEqual(frozen, output)
        self.assertEqual(frozen.read_bytes(), output.read_bytes())
        self.assertEqual(self.states()['a'], 'accepted')

    def test_output_change_stales_acceptance_and_blocks_unstarted_downstream(self):
        output = self.delivery()
        self.card('b', '依赖：a\n下游')
        self.accept()
        self.assertEqual(self.states()['b'], 'ready')
        output.write_text('第二稿\n', encoding='utf-8')
        self.assertEqual(self.states(), {'a': 'stale', 'b': 'waiting'})
        self.dispatch()
        self.assertIsNone(self.run.receipt('b'))

    def test_card_or_frozen_change_stales_acceptance(self):
        self.delivery()
        self.card('b', '依赖：a\n下游')
        review = self.accept()
        frozen = Path(review.get('accepted_output', self.tmp / 'missing'))
        self.assertTrue(frozen.is_file(), '验收应保存独立冻结稿')
        frozen.write_text('冻结稿被改动', encoding='utf-8')
        self.assertEqual(self.states(), {'a': 'stale', 'b': 'waiting'})
        self.accept()
        self.card(body='任务改动')
        self.assertEqual(self.states(), {'a': 'stale', 'b': 'waiting'})

    def test_reaccept_keeps_started_downstream_on_old_frozen_output(self):
        output = self.delivery()
        self.card('b', '依赖：a\n下游')
        first = self.accept()
        self.assertIn('accepted_output', first)
        frozen = Path(first['accepted_output'])
        self.dispatch()
        prompt = (self.root / 'b.prompt').read_text(encoding='utf-8')
        self.assertIn(f'- a：{frozen}', prompt)
        output.write_text('第二稿\n', encoding='utf-8')
        self.assertEqual(frozen.read_text(encoding='utf-8'), '第一稿\n')
        second = self.accept()
        self.assertNotEqual(first['accepted_output'], second['accepted_output'])
        self.assertEqual(Path(second['accepted_output']).read_text(encoding='utf-8'), '第二稿\n')
        self.assertEqual(frozen.read_text(encoding='utf-8'), '第一稿\n')
        self.assertEqual((self.root / 'b.prompt').read_text(encoding='utf-8'), prompt)
        self.assertEqual(self.states(), {'a': 'accepted', 'b': 'delivered'})

    def test_late_preflight_card_change_is_not_dispatched(self):
        self.card()
        def changed():
            self.card(body='预检期间改卡')
            return [], []
        with patch.object(worker, 'lean_args', side_effect=changed), patch.object(worker.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, '卡片.*变化'):
                self.run.run(self.tmp, 2, 'high', None, [])
            spawn.assert_not_called()
        self.assertIsNone(self.run.receipt('a'))

    def test_late_preflight_dependency_change_is_not_dispatched(self):
        output = self.delivery()
        self.card('b', '依赖：a\n下游')
        self.accept()
        def changed():
            output.write_text('预检期间换稿', encoding='utf-8')
            return [], []
        with patch.object(worker, 'lean_args', side_effect=changed), patch.object(worker.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, '依赖.*验收'):
                self.run.run(self.tmp, 2, 'high', None, [])
            spawn.assert_not_called()
        self.assertIsNone(self.run.receipt('b'))

    def test_version_checks_and_freeze_share_review_lock(self):
        self.delivery()
        original = worker.write_json
        def inspect(path, value):
            if path == self.root / 'a.json' and value.get('review', {}).get('verdict') == 'accepted':
                self.assertIn('accepted_output', value['review'])
                self.assertTrue(Path(value['review']['accepted_output']).is_file())
                with self.assertRaisesRegex(ValueError, '正在派单'):
                    with worker.Run(self.root).lock():
                        pass
            original(path, value)
        with patch.object(worker, 'write_json', side_effect=inspect):
            self.accept()

    def test_legacy_receipt_keeps_accepted_and_releases_dependencies(self):
        self.legacy_receipt()
        self.card('b', '依赖：a\n下游')
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(self.states(), {'a': 'accepted', 'b': 'ready'})
        result = self.cli('status', self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        rows = {c['card']: c for c in json.loads(result.stdout)['cards']}
        self.assertEqual(rows['a']['state'], 'accepted')
        self.assertEqual(rows['a'].get('acceptance'), 'legacy')
        self.assertEqual(rows['b']['state'], 'ready')
        m = stats.summarize_crew(self.root)
        a = next(c for c in m['cards'] if c['card'] == 'a')
        self.assertIs(a.get('ever_accepted'), True)
        self.assertEqual(a.get('acceptance'), 'legacy')
        self.assertIn('accepted_valid', a)
        self.assertIsNone(a['accepted_valid'])
        self.assertEqual(next(c for c in m['cards'] if c['card'] == 'b')['state'], 'ready')
        self.assertEqual(m['attempts'][0].get('acceptance'), 'legacy')
        rendered = stats.render_crew(m)
        self.assertIn('有效性未知', rendered)
        self.assertIn('legacy', rendered)
        source = notes.run_source(self.root)
        self.assertIn('当前仍有效: 有效性未知', source)
        self.assertIn('acceptance: legacy', source)
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_legacy_accepted_retry_stays_blocked_without_archiving(self):
        for card_hash in (False, True):
            with self.subTest(card_hash=card_hash):
                self.legacy_receipt(card_hash=card_hash)
                # 第一轮的验收未绑定版本，后来改稿仍按历史验收放行。
                self.card(body='旧验收后的修改')
                before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
                result = self.cli('run', self.root, '--cwd', self.tmp, '--retry', 'a')
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('已验收，不重派', result.stderr)
                self.assertFalse((self.root / 'history').exists())
                after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file() and p.name != '.lock'}
                self.assertEqual({p: v for p, v in before.items() if Path(p).name != '.lock'}, after)

    def test_legacy_dependency_dispatch_uses_prior_output_without_rewriting_receipt(self):
        self.legacy_receipt()
        self.delivery('bound')
        bound = self.accept('bound')
        self.card('b', '依赖：a, bound\n下游')
        before = (self.root / 'a.json').read_bytes()
        self.dispatch()
        self.assertIsNotNone(self.run.receipt('b'), '旧版验收的下游应继续派出')
        prompt = (self.root / 'b.prompt').read_text(encoding='utf-8')
        self.assertIn(f'- a：{self.root / "a.out"}', prompt)
        self.assertIn('版本未绑定', prompt)
        self.assertIn(f'- bound：{bound["accepted_output"]}', prompt)
        self.assertEqual((self.root / 'a.json').read_bytes(), before)

    def test_legacy_delivered_can_be_accepted_without_inventing_dispatch_hash(self):
        self.legacy_receipt(verdict=None)
        self.card('b', '依赖：a\n下游')
        result = self.cli('accept', self.root, 'a', '--note', '继续旧运行', '--hold')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.states(), {'a': 'accepted', 'b': 'ready'})
        self.assertNotIn('card_sha256', self.run.receipt('a'))
        row = next(c for c in self.run.status()['cards'] if c['card'] == 'a')
        self.assertEqual(row.get('acceptance'), 'legacy')
        self.assertIsNone(row.get('accepted_valid'))

    def test_accept_auto_dispatches_with_a_legacy_other_dependency(self):
        self.legacy_receipt()
        self.delivery('bound')
        self.card('b', '依赖：a, bound\n下游')
        self.dispatch()  # 尚未就绪，只记录旧运行继续派发所需的执行配置。
        result = self.cli('accept', self.root, 'bound', '--note', '补齐前置')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['dispatched'], ['b'])
        # 自动派发的看守仍可能持锁；先等交付落盘，再执行补派检查。
        for _ in range(10):
            waiting = self.cli('wait', self.root, '--minutes', '0.05')
            self.assertEqual(waiting.returncode, 0, waiting.stdout + waiting.stderr)
            if not any(c['state'] in worker.ACTIVE_STATES for c in json.loads(waiting.stdout)['cards']):
                break
        else:
            self.fail('自动派发的假 Codex 未交回')
        self.dispatch()
        self.assertEqual(self.states()['b'], 'delivered')
        prompt = (self.root / 'b.prompt').read_text(encoding='utf-8')
        self.assertIn(f'- a：{self.root / "a.out"}', prompt)
        self.assertIn(self.run.receipt('bound')['review']['accepted_output'], prompt)

    def test_legacy_rejected_can_retry_and_new_attempt_becomes_bound(self):
        self.legacy_receipt(verdict='rejected')
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env['CREW_CODEX_BIN'] = str(fake)
        result = self.cli('run', self.root, '--cwd', self.tmp, '--retry', 'a', '--seconds', '2')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = self.cli('wait', self.root, '--minutes', '0.05')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.states()['a'], 'delivered')
        self.assertIn('card_sha256', self.run.receipt('a'))
        self.accept()
        row = self.run.status()['cards'][0]
        self.assertEqual(row.get('acceptance'), 'bound')
        self.assertIs(row.get('accepted_valid'), True)

    def test_stats_and_notes_read_validity_without_writing(self):
        output = self.delivery()
        self.accept()
        for valid in (True, False):
            if not valid:
                output.write_text('改过的稿', encoding='utf-8')
            before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
            m = stats.summarize_crew(self.root)
            self.assertIs(m['cards'][0].get('ever_accepted'), True)
            self.assertIs(m['cards'][0].get('accepted_valid'), valid)
            self.assertIs(m['attempts'][0].get('accepted_valid'), valid)
            rendered = stats.render_crew(m)
            self.assertIn('曾验收', rendered)
            self.assertIn('当前仍有效', rendered)
            source = notes.run_source(self.root)
            self.assertIn('曾验收: 是', source)
            self.assertIn('当前仍有效: ' + ('有效' if valid else '无效'), source)
            after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
            self.assertEqual(before, after)

    def test_archived_legacy_acceptance_remains_unknown(self):
        self.delivery()
        receipt = self.run.receipt('a')
        receipt.pop('card_sha256')
        receipt['review'] = {'verdict': 'accepted', 'at': '2025-01-01T00:00:03Z'}
        history = self.root / 'history'
        history.mkdir()
        worker.write_json(history / 'a-20250101-000003.json', receipt)
        m = stats.summarize_crew(self.root)
        archived = next(a for a in m['attempts'] if a['receipt'].startswith('history/'))
        self.assertIs(archived.get('ever_accepted'), True)
        self.assertIsNone(archived.get('accepted_valid'))
        self.assertIn('有效性未知', stats.render_crew(m))

    def test_missing_delivery_or_freeze_invalidates_current_acceptance(self):
        output = self.delivery()
        self.card('b', '依赖：a\n下游')
        first = self.accept()
        frozen = Path(first['accepted_output'])
        frozen.unlink()
        self.assertEqual(self.states(), {'a': 'stale', 'b': 'waiting'})
        self.accept()
        output.unlink()
        self.assertEqual(self.states(), {'a': 'stale', 'b': 'waiting'})
        with self.assertRaisesRegex(ValueError, '交付文件不存在或为空'):
            self.accept(force=True)

    def test_shared_validity_checks_every_version_field(self):
        from acceptance import accepted_valid
        self.delivery()
        self.accept()
        receipt = self.run.receipt('a')
        card = self.root / 'cards' / 'a.md'
        self.assertIs(accepted_valid(receipt, card), True)
        for section, key in ((receipt, 'card_sha256'), (receipt['review'], 'card_sha256'),
                             (receipt['review'], 'output_sha256')):
            original = section[key]
            section[key] = '0' * 64
            self.assertIs(accepted_valid(receipt, card), False)
            del section[key]
            self.assertIsNone(accepted_valid(receipt, card))
            section[key] = original

    def test_frozen_name_does_not_collide_with_a_card_named_accepted(self):
        self.delivery()
        other = self.card('a.accepted', '另一张卡')
        original = other.read_bytes()
        review = self.accept()
        self.assertEqual(Path(review['accepted_output']).parent, self.root / '.accepted')
        self.assertEqual(other.read_bytes(), original)
        self.assertFalse((self.root / 'a.accepted.out').exists())

    def test_pdf_without_pdftotext_is_unverified(self):
        with patch.object(worker.shutil, 'which', return_value=None):
            self.assertEqual(worker.pdf_page(self.tmp / 'sample.pdf', 1)[0], '未核页码')


if __name__ == '__main__':
    unittest.main()
