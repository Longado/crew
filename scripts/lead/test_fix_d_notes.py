"""修复 D：日志根目录防误传，历史验收与当前有效性分开。"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import notes
import stats


class FixDNotesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        environment = patch.dict(os.environ, CREW_HOME=str(self.tmp / 'crew'),
                                 CREW_CODEX_BIN='/usr/bin/false', CODEX_HOME=str(self.tmp / 'codex'))
        environment.start()
        self.addCleanup(environment.stop)

    def snapshot(self, root):
        return {str(p.relative_to(root)): p.read_bytes() if p.is_file() else None
                for p in root.rglob('*')}

    def test_notes_child_is_rejected_before_lock_or_directory_creation(self):
        base = self.tmp / 'log'
        notes.new(base, 'tester', 'original', '原记录')
        child = base / 'notes'
        before = self.snapshot(base)
        for action in ('new', 'index'):
            args = [action, '--dir', str(child)]
            if action == 'new':
                args += ['--agent', 'tester', '--topic', 'mistake', '--title', '误传']
            error = io.StringIO()
            with self.subTest(action=action), contextlib.redirect_stderr(error), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(notes.main(args), 2)
                self.assertIn(str(base), error.getvalue())
                self.assertIn('notes', error.getvalue())
                self.assertEqual(self.snapshot(base), before)

    def test_directory_name_alone_does_not_change_the_requested_root(self):
        base = self.tmp / 'notes'
        base.mkdir()
        record = notes.new(base, 'tester', 'valid', '合法根目录')
        self.assertEqual(record.parent, base / 'notes')
        self.assertEqual(notes.build(base), 1)
        self.assertTrue((base / 'LOG.md').is_file())
        self.assertFalse((self.tmp / 'LOG.md').exists())

    def run_fixture(self, current='rejected', history=True, archived=False):
        root = self.tmp / 'run'
        (root / 'cards').mkdir(parents=True)
        (root / 'run.json').write_text('{"created_at": "2025-01-01T00:00:00Z"}')
        card = root / 'cards' / 'a.md'
        card.write_text('核对任务\n', encoding='utf-8')
        output = root / 'a.out'
        output.write_text('交付正文\n', encoding='utf-8')
        frozen = root / 'accepted.out'
        frozen.write_bytes(output.read_bytes())
        accepted = {'verdict': 'accepted', 'at': '2025-01-01T00:00:03Z',
                    'card_sha256': hashlib.sha256(card.read_bytes()).hexdigest(),
                    'output_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                    'accepted_output': str(frozen)}
        receipt = {'card': str(card), 'card_sha256': accepted['card_sha256'],
                   'output': str(output), 'state': 'finished', 'tokens': 0,
                   'started_at': '2025-01-01T00:00:01Z', 'ended_at': '2025-01-01T00:00:02Z'}
        if current:
            receipt['review'] = accepted if current == 'accepted' else {
                'verdict': current, 'at': '2025-01-01T00:00:04Z'}
        if history:
            receipt['review_history'] = [accepted]
        path = root / 'a.json'
        if archived:
            path = root / 'history' / 'a-20250101-000004.json'
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(receipt), encoding='utf-8')
        return root

    def test_stats_counts_historical_acceptance_without_reviving_rejected_card(self):
        root = self.run_fixture()
        before = self.snapshot(root)
        metrics = stats.summarize_crew(root)
        for row in (metrics['cards'][0], metrics['attempts'][0]):
            self.assertIs(row['ever_accepted'], True)
            self.assertIs(row['accepted_valid'], False)
            self.assertEqual(row['state'], 'rejected' if row is metrics['cards'][0] else 'finished')
        self.assertEqual(self.snapshot(root), before)

    def test_notes_counts_historical_acceptance_without_reviving_rejected_card(self):
        root = self.run_fixture()
        before = self.snapshot(root)
        source = notes.run_source(root)
        self.assertIn('验收: rejected；曾验收: 是；当前仍有效: 无效', source)
        self.assertEqual(self.snapshot(root), before)

    def test_stats_counts_acceptance_in_archived_review_history(self):
        root = self.run_fixture(archived=True)
        metrics = stats.summarize_crew(root)
        self.assertIs(metrics['attempts'][0]['ever_accepted'], True)
        self.assertIs(metrics['cards'][0]['ever_accepted'], True)
        self.assertIs(metrics['cards'][0]['accepted_valid'], False)

    def test_current_acceptance_stays_valid_without_history(self):
        root = self.run_fixture(current='accepted', history=False)
        metrics = stats.summarize_crew(root)
        self.assertIs(metrics['cards'][0]['ever_accepted'], True)
        self.assertIs(metrics['cards'][0]['accepted_valid'], True)
        self.assertIn('验收: accepted；曾验收: 是；当前仍有效: 有效', notes.run_source(root))

    def test_card_without_acceptance_stays_unaccepted(self):
        root = self.run_fixture(current=None, history=False)
        metrics = stats.summarize_crew(root)
        self.assertIs(metrics['cards'][0]['ever_accepted'], False)
        self.assertIs(metrics['cards'][0]['accepted_valid'], False)
        self.assertIn('验收: 未验收；曾验收: 否；当前仍有效: 无效', notes.run_source(root))


if __name__ == '__main__':
    unittest.main()
