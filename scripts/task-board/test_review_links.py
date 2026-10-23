"""Real symlinks in temporary synthetic workspaces; no production files."""
import importlib.util
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_link_fixtures', Path(__file__).with_name('test_review.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
review = fixtures.review


class ReviewLinkTests(unittest.TestCase):
    setUp = fixtures.ReviewTest.setUp
    run_review = fixtures.ReviewTest.run_review

    def assert_refused(self, expected):
        outside = {p: p.read_bytes() for p in self.outside.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(ValueError, '符号链接.*整批拒绝') as caught:
            self.run_review(accept=True)
        for path in expected:
            self.assertIn(path, str(caught.exception))
        self.assertEqual(outside, {p: p.read_bytes() for p in self.outside.rglob('*') if p.is_file()})
        self.assertEqual((self.source / 'safe.txt').read_bytes(), b'original')

    def prepare_links(self):
        self.outside = self.tmp / 'outside'
        self.outside.mkdir()
        (self.outside / 'keep.txt').write_bytes(b'outside unchanged')
        (self.source / 'safe.txt').write_bytes(b'original')
        # A normal changed file sorts before the unsafe path: refusal must be batch-wide.
        (self.source / 'src/keep.py').write_bytes(b'keep\n')
        (self.worker / 'src/keep.py').write_bytes(b'changed\n')

    def test_ancestor_directory_link_refuses_whole_batch(self):
        self.prepare_links()
        shutil.copytree(self.source / 'src', self.outside / 'linked')
        (self.source / 'src').rename(self.source / 'original-src')
        (self.source / 'src').symlink_to(self.outside / 'linked', target_is_directory=True)
        self.assert_refused(['src/added.py', 'src/edit.py', 'src/keep.py'])
        self.assertEqual((self.source / 'original-src/edit.py').read_bytes(), b'old\n')

    def test_target_file_link_refuses_whole_batch_even_when_baseline_bytes_match(self):
        self.prepare_links()
        outside = self.outside / 'edit.py'
        (self.source / 'src/edit.py').rename(outside)
        (self.source / 'src/edit.py').symlink_to(outside)
        self.assert_refused(['src/edit.py'])
        self.assertFalse((self.source / 'src/added.py').exists())
        self.assertEqual((self.source / 'src/keep.py').read_bytes(), b'keep\n')

    def test_dangling_added_target_link_does_not_create_external_file(self):
        self.prepare_links()
        missing = self.outside / 'missing.py'
        (self.source / 'src/added.py').symlink_to(missing)
        self.assert_refused(['src/added.py'])
        self.assertFalse(missing.exists())
        self.assertEqual((self.source / 'src/edit.py').read_bytes(), b'old\n')

    def test_link_inside_source_root_is_also_refused(self):
        self.prepare_links()
        (self.source / 'src/edit.py').rename(self.source / 'internal.py')
        (self.source / 'src/edit.py').symlink_to(self.source / 'internal.py')
        self.assert_refused(['src/edit.py'])
        self.assertEqual((self.source / 'internal.py').read_bytes(), b'old\n')

    def test_source_root_link_inside_workspace_refuses_whole_batch(self):
        self.prepare_links()
        actual = self.workspace / 'original-project'
        self.source.rename(actual)
        self.source.symlink_to(actual, target_is_directory=True)
        self.assertEqual(self.run_review()['source'], str(actual.resolve()))
        self.assert_refused(['src/added.py', 'src/edit.py', 'src/keep.py'])
        self.assertFalse((actual / 'src/added.py').exists())
        self.assertEqual((actual / 'src/edit.py').read_bytes(), b'old\n')

    def test_links_introduced_during_conflict_check_are_rechecked_before_copy(self):
        self.prepare_links()
        self.run_review()  # Freeze archive before installing the synthetic race.
        original_digest = review.digest
        def replace_after_digest(path):
            value = original_digest(path)
            if path == self.source / 'src/edit.py':
                path.rename(self.outside / 'edit.py')
                path.symlink_to(self.outside / 'edit.py')
            return value
        with patch.object(review, 'digest', side_effect=replace_after_digest):
            with self.assertRaisesRegex(ValueError, '符号链接.*整批拒绝'):
                self.run_review(accept=True)
        self.assertEqual((self.outside / 'edit.py').read_bytes(), b'old\n')
        self.assertFalse((self.source / 'src/added.py').exists())
        self.assertEqual((self.source / 'src/keep.py').read_bytes(), b'keep\n')


if __name__ == '__main__':
    unittest.main()
