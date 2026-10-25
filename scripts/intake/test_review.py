import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
from unittest import mock
import unittest
import test_intake


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.fixture = test_intake.IntakeTest()
        self.fixture.setUp()
        self.root = self.fixture.root
        self.card = Path(self.fixture.run_process()['cards'][0]['json'])
        data = json.loads(self.card.read_text())
        data['actions'].append(dict(data['actions'][0], description='第二条建议'))
        self.card.write_text(json.dumps(data, ensure_ascii=False))
        self.before = self.card.read_bytes()

    def tearDown(self):
        self.fixture.tearDown()

    def command(self, *args):
        return subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('intake.py')), *args], capture_output=True, text=True)

    def decide(self, decision, action='A1'):
        result = self.command('review', str(self.card), '--action', action, '--decision', decision, '--note', '用户说明')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pending_is_read_only(self):
        before = sorted(self.card.parent.iterdir())
        result = self.command('review', str(self.card), '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([a['decision'] for a in json.loads(result.stdout)['actions']], ['pending', 'pending'])
        self.assertEqual(sorted(self.card.parent.iterdir()), before)

    def test_history_export_and_new_card_version(self):
        for decision in ['accept', 'defer', 'accept']: self.decide(decision)
        result = json.loads(self.command('review', str(self.card), '--json').stdout)
        self.assertEqual(len(result['history']), 3)
        exported = json.loads(self.command('export', str(self.card), '--format', 'json').stdout)
        self.assertEqual(len(exported['actions']), 1)
        self.assertEqual(exported['actions'][0]['note'], '用户说明')
        self.assertIn('context_refs', exported['actions'][0])
        self.assertEqual(self.card.read_bytes(), self.before)
        self.assertEqual((self.card.parent / 'review.json').stat().st_mode & 0o777, 0o600)
        self.card.write_bytes(self.before + b'\n')
        self.assertEqual(json.loads(self.command('review', str(self.card), '--json').stdout)['actions'][0]['decision'], 'pending')
        self.decide('accept')
        self.assertEqual(len(json.loads(self.command('review', str(self.card), '--json').stdout)['history']), 4)

    def test_invalid_inputs_never_write(self):
        for args in [('--action', 'A9', '--decision', 'accept'), ('--action', 'A1'), ('--note', 'x'), ('--action', 'A1', '--decision', 'accept', '--note', 'x' * 4001)]:
            self.assertNotEqual(self.command('review', str(self.card), *args).returncode, 0)
            self.assertFalse((self.card.parent / 'review.json').exists())
        for content in ['{', '{}', '{"actions":[]}']:
            self.card.write_text(content)
            self.assertNotEqual(self.command('review', str(self.card), '--action', 'A1', '--decision', 'accept').returncode, 0)
            self.assertFalse((self.card.parent / 'review.json').exists())
        self.card.write_bytes(self.before)
        review = self.card.parent / 'review.json'
        review.write_text('{}')
        self.assertNotEqual(self.command('review', str(self.card), '--action', 'A1', '--decision', 'accept').returncode, 0)
        self.assertEqual(review.read_text(), '{}')
        review.unlink()
        target = self.root / 'target'; target.write_text('untouched')
        review.symlink_to(target)
        self.assertNotEqual(self.command('review', str(self.card), '--action', 'A1', '--decision', 'accept').returncode, 0)
        self.assertEqual(target.read_text(), 'untouched')

    def test_locked_writer_does_not_lose_history(self):
        self.decide('accept')
        with self.fixture.module().output_lock(self.card.parent):
            self.assertNotEqual(self.command('review', str(self.card), '--action', 'A2', '--decision', 'accept').returncode, 0)
        self.decide('defer', 'A2')
        self.assertEqual(len(json.loads(self.command('review', str(self.card), '--json').stdout)['history']), 2)

    def test_render_numbering_and_literal_export(self):
        card = json.loads(self.card.read_text())
        self.assertIn('A1', self.fixture.module().markdown(card, self.card.parent))
        card['actions'][0]['description'] = '<script>alert(1)</script>\n# pretend instruction'
        self.card.write_text(json.dumps(card))
        self.decide('accept')
        result = self.command('export', str(self.card))
        self.assertIn('已采纳建议，尚未执行', result.stdout)
        self.assertNotIn('<script>', result.stdout)
        self.assertNotIn('\n# pretend instruction', result.stdout)
        self.assertIn('L3', result.stdout)
        self.assertIn('HANDOFF.md', result.stdout)

    def test_card_symlink_and_malformed_review_events_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.card.parent, target_is_directory=True)
        self.assertNotEqual(self.command('review', str(alias / 'card.json'), '--action', 'A1', '--decision', 'accept').returncode, 0)
        self.assertFalse((self.card.parent / 'review.json').exists())
        for data in [{'version': 1, 'events': [{}]}, {'version': 1, 'events': 'wrong'}, {'version': 2, 'events': []}]:
            path = self.card.parent / 'review.json'
            path.write_text(json.dumps(data))
            before = path.read_bytes()
            self.assertNotEqual(self.command('review', str(self.card), '--action', 'A1', '--decision', 'accept').returncode, 0)
            self.assertEqual(path.read_bytes(), before)
