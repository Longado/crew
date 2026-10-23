"""Tests for reviewing and accepting an isolated (workspace-write) Crew run."""
import hashlib
import importlib.util
import json
import sqlite3
from contextlib import closing
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('board_review', Path(__file__).with_name('review.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ReviewTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.workspace = self.tmp / 'ws'
        (self.workspace / '.data').mkdir(parents=True)
        db = sqlite3.connect(self.workspace / '.data/tasks.db')
        db.executescript("CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT, local_path TEXT);"
                         "CREATE TABLE tasks(id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, status TEXT, priority TEXT, notes TEXT);"
                         "INSERT INTO projects VALUES(1,'p','proj');"
                         "INSERT INTO tasks VALUES(7,1,'t','blocked','high','');")
        db.commit(); db.close()
        self.source = self.workspace / 'proj'
        (self.source / 'src').mkdir(parents=True)
        files = {'src/keep.py': b'keep\n', 'src/edit.py': b'old\n', 'gone.txt': b'bye\n'}
        for path, data in files.items():
            (self.source / path).write_bytes(data)
        root = self.tmp / 'crew-worker-x'
        self.worker = root / 'workspace'
        (self.worker / 'src').mkdir(parents=True)
        for path, data in files.items():
            (self.worker / path).write_bytes(data)
        baseline = {'source': str(self.source), 'cwd': str(self.worker),
                    'files': [{'path': p, 'sha256': sha(d), 'mode': 0o644} for p, d in files.items()]}
        (root / 'baseline.json').write_text(json.dumps(baseline))
        # Worker edits one file, adds one, deletes one.
        (self.worker / 'src/edit.py').write_bytes(b'new\n')
        (self.worker / 'src/added.py').write_bytes(b'added\n')
        (self.worker / 'gone.txt').unlink()
        self.manifest_dir = self.workspace / 'docs/batch'
        (self.manifest_dir / 'runs').mkdir(parents=True)
        self.manifest = self.manifest_dir / 'manifest.json'
        self.manifest.write_text('{"tasks": []}')
        self.receipt = {'id': 'job1', 'task_id': 7, 'access': 'workspace-write', 'state': 'blocked',
                        'snapshot': {'run': {'workerCwd': str(self.worker), 'baselinePath': str(root / 'baseline.json')}}}
        (self.manifest_dir / 'runs/job1.json').write_text(json.dumps(self.receipt))

    def run_review(self, accept=False):
        return review.review(self.workspace, self.manifest, 'job1', accept=accept)

    def test_lists_changes_and_archives_worker(self):
        before = (self.workspace / '.data/tasks.db').read_bytes()
        report = self.run_review()
        self.assertEqual(report['changed'], ['src/edit.py'])
        self.assertEqual(report['added'], ['src/added.py'])
        self.assertEqual(report['deleted'], ['gone.txt'])
        archived = Path(report['archive'])
        self.assertTrue(archived.resolve().is_relative_to((self.manifest_dir / 'runs').resolve()))
        self.assertEqual((archived / 'workspace/src/edit.py').read_bytes(), b'new\n')
        self.assertEqual((self.source / 'src/edit.py').read_bytes(), b'old\n')
        self.assertFalse((self.source / 'src/added.py').exists())
        self.assertEqual((self.workspace / '.data/tasks.db').read_bytes(), before)
        self.assertFalse((self.manifest_dir / 'runs/job1-worker.partial').exists())

    def test_accept_copies_changed_and_added_but_not_deletions(self):
        before = (self.workspace / '.data/tasks.db').read_bytes()
        report = self.run_review(accept=True)
        self.assertEqual((self.workspace / '.data/tasks.db').read_bytes(), before)
        self.assertFalse((self.workspace / '.data/backups').exists())
        self.assertEqual((self.source / 'src/edit.py').read_bytes(), b'new\n')
        self.assertEqual((self.source / 'src/added.py').read_bytes(), b'added\n')
        self.assertTrue((self.source / 'gone.txt').exists())
        self.assertEqual(report['merged'], ['src/added.py', 'src/edit.py'])
        self.assertEqual(report['deleted'], ['gone.txt'])

    def test_accept_refuses_everything_when_source_changed_meanwhile(self):
        (self.source / 'src/edit.py').write_bytes(b'someone else\n')
        with self.assertRaises(ValueError):
            self.run_review(accept=True)
        self.assertFalse((self.source / 'src/added.py').exists())
        self.assertEqual((self.source / 'src/edit.py').read_bytes(), b'someone else\n')
        with closing(sqlite3.connect(self.workspace / '.data/tasks.db')) as db:
            self.assertEqual(db.execute('SELECT status FROM tasks WHERE id=7').fetchone()[0], 'blocked')

    def test_accept_refuses_when_added_path_now_exists_in_source(self):
        (self.source / 'src/added.py').write_bytes(b'created in source\n')
        with self.assertRaises(ValueError):
            self.run_review(accept=True)
        self.assertEqual((self.source / 'src/edit.py').read_bytes(), b'old\n')

    def test_works_from_archive_after_temporary_worker_is_gone(self):
        self.run_review()
        import shutil
        shutil.rmtree(self.worker.parent)
        report = self.run_review(accept=True)
        self.assertEqual(report['merged'], ['src/added.py', 'src/edit.py'])

    def test_read_only_run_is_rejected(self):
        self.receipt['access'] = 'read-only'
        (self.manifest_dir / 'runs/job1.json').write_text(json.dumps(self.receipt))
        with self.assertRaises(ValueError):
            self.run_review()
        self.assertFalse((self.manifest_dir / 'runs/job1-worker').exists())

    def test_source_outside_workspace_is_rejected(self):
        baseline = Path(self.receipt['snapshot']['run']['baselinePath'])
        data = json.loads(baseline.read_text())
        data['source'] = str(self.tmp / 'outside')
        baseline.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, '不在当前工作区'):
            self.run_review(accept=True)
        self.assertFalse((self.tmp / 'outside').exists())

    def test_report_and_merge_skip_generated_directories_and_symlinks(self):
        for name in ('.git', 'node_modules', '__pycache__'):
            directory = self.worker / name
            directory.mkdir()
            (directory / 'ignored.txt').write_text('ignored')
        (self.worker / 'linked.txt').symlink_to(self.source / 'src/keep.py')
        (self.worker / 'linked-directory').symlink_to(self.source / 'src', target_is_directory=True)
        (self.worker / 'dangling').symlink_to(self.tmp / 'missing')
        report = self.run_review(accept=True)
        self.assertEqual(report['changed'], ['src/edit.py'])
        self.assertEqual(report['added'], ['src/added.py'])
        self.assertEqual(report['deleted'], ['gone.txt'])
        self.assertEqual(report['merged'], ['src/added.py', 'src/edit.py'])
        self.assertFalse((self.source / 'linked.txt').exists())
        for name in ('.git', 'node_modules', '__pycache__'):
            self.assertFalse((self.source / name).exists())

    def test_interrupted_archive_is_not_used_as_complete(self):
        with patch.object(review.shutil, 'copy2', side_effect=OSError('synthetic interruption')):
            with self.assertRaisesRegex(OSError, 'synthetic interruption'):
                self.run_review()
        self.assertFalse((self.manifest_dir / 'runs/job1-worker').exists())
        self.assertEqual(self.run_review()['changed'], ['src/edit.py'])
        self.assertFalse((self.manifest_dir / 'runs/job1-worker.partial').exists())

    def test_missing_worker_without_archive_is_rejected(self):
        import shutil
        shutil.rmtree(self.worker.parent)
        with self.assertRaisesRegex(ValueError, '成果无法找回'):
            self.run_review()

    def test_missing_worker_path_does_not_archive_callers_directory(self):
        del self.receipt['snapshot']['run']['workerCwd']
        (self.manifest_dir / 'runs/job1.json').write_text(json.dumps(self.receipt))
        caller = self.tmp / 'caller'
        caller.mkdir()
        (caller / 'unrelated.txt').write_text('not the isolated worker')
        result = subprocess.run([sys.executable, '-B', review.__file__,
                                 '--workspace', str(self.workspace), '--manifest', str(self.manifest),
                                 '--job', 'job1'], cwd=caller, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('未记录隔离副本或基线位置', result.stderr)
        self.assertFalse((self.manifest_dir / 'runs/job1-worker').exists())

    def test_cli_accept_reports_merge_without_touching_task_database(self):
        before = (self.workspace / '.data/tasks.db').read_bytes()
        result = subprocess.run([sys.executable, '-B', review.__file__,
                                 '--workspace', str(self.workspace), '--manifest', str(self.manifest),
                                 '--job', 'job1', '--accept'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['merged'], ['src/added.py', 'src/edit.py'])
        self.assertEqual(report['deleted'], ['gone.txt'])
        self.assertEqual((self.workspace / '.data/tasks.db').read_bytes(), before)
        self.assertEqual(sorted(p.name for p in (self.workspace / '.data').iterdir()), ['tasks.db'])


if __name__ == '__main__':
    unittest.main()
