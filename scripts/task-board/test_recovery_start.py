"""Start failures and explicit recovery exits; temporary DBs and fake Crew only."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
from contextlib import closing
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('start_recovery_fixtures', Path(__file__).with_name('test_recovery.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
module = fixtures.module


class StartRecoveryTests(unittest.TestCase):
    setUp = fixtures.RecoveryTests.setUp
    save_job = fixtures.RecoveryTests.save_job
    disk_job = fixtures.RecoveryTests.disk_job
    task_row = fixtures.RecoveryTests.task_row
    runner = fixtures.RecoveryTests.runner
    terminal = fixtures.RecoveryTests.terminal

    def failed_start(self, error, current=None):
        runner = self.runner(current or {'status': 'idle'})
        job = runner.jobs[0]
        job.update(snapshot={}, state='starting')
        runner.active = job
        request = runner.request
        def failed(path, payload=None):
            if path == '/api/team/start':
                runner.calls.append((path, payload))
                return module.Runner.request(runner, path, payload)
            return request(path, payload)
        runner.request = failed
        with patch.object(module.urllib.request, 'urlopen', side_effect=error):
            runner.run(job, {'goal': 'Synthetic task', 'cwd': str(self.root / 'project'), 'access': 'read-only'})
        return runner, job

    @staticmethod
    def http_error():
        return urllib.error.HTTPError('http://127.0.0.1:1/api/team/start', 409, 'Conflict', {}, io.BytesIO(b'synthetic rejected start'))

    def assert_dispatch_available(self, runner):
        # The failed task remains blocked; a separate eligible task must be dispatchable.
        manifest = json.loads(self.manifest.read_text())
        manifest['tasks'].append({**manifest['tasks'][0], 'task_id': 2, 'line': 'Synthetic next task'})
        self.manifest.write_text(json.dumps(manifest))
        with closing(sqlite3.connect(self.store.db)) as db, db:
            db.execute("INSERT INTO tasks VALUES(2,1,'Synthetic next task','todo','medium','')")
        runner.current = {'status': 'idle'}
        request = runner.request
        def ready(path, payload=None):
            if path == '/api/state':
                return {'projects': [{'id': 'project-one', 'dirs': [str((self.root / 'project').resolve())]}]}
            return request(path, payload)
        runner.request = ready
        with patch.object(module.threading, 'Thread') as thread:
            job = runner.dispatch(2, 'read-only', 'Synthetic next task')
        self.assertEqual(job['state'], 'starting')
        thread.return_value.start.assert_called_once()

    def test_http_error_without_live_run_settles_immediately_and_allows_dispatch(self):
        runner, job = self.failed_start(self.http_error())
        self.assertEqual(job['state'], 'blocked')
        self.assertEqual(self.task_row()[0], 'blocked')
        self.assertIn('没启动', job['label'])
        self.assertIn('synthetic rejected start', job['snapshot']['error'])
        self.assertTrue(any(path.startswith('/api/team?') for path, _ in runner.calls))
        self.assertIsNone(runner.active)
        self.assert_dispatch_available(runner)

    def test_http_error_with_live_run_remains_pending_and_never_stops_unknown_run(self):
        runner, job = self.failed_start(self.http_error(), self.snapshot)
        self.assertEqual(job['state'], 'recovery_required')
        self.assertEqual(self.task_row()[0], 'doing')
        self.assertIn('run-old', job['label'])
        self.assertIn('running', job['label'])
        self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))

    def test_timeout_or_disconnect_queries_without_id_and_stays_unresolved_when_no_run_exists(self):
        for error in [TimeoutError('synthetic timeout'), urllib.error.URLError('synthetic disconnect')]:
            with self.subTest(error=type(error).__name__):
                with closing(sqlite3.connect(self.store.db)) as db, db:
                    db.execute("UPDATE tasks SET status='doing',notes='original history' WHERE id=1")
                self.save_job(self.job)
                runner, job = self.failed_start(error)
                self.assertEqual(job['state'], 'recovery_required')
                self.assertEqual(self.task_row()[0], 'doing')
                result = runner.reconcile(job['id'])
                self.assertEqual(result['outcome'], 'unresolved')
                self.assertEqual(result['task']['status'], 'doing')
                self.assertEqual(result['job']['state'], 'recovery_required')
                self.assertIn('可能已重启', result['job']['label'])
                self.assertNotIn('确认本次没启动', result['job']['label'])
                self.assertTrue(any(path.startswith('/api/team?') for path, _ in runner.calls))
                row = self.task_row()
                runner.reconcile(job['id'])
                self.assertEqual(self.task_row(), row)

    def test_missing_id_with_live_run_reports_remote_id_and_status(self):
        runner, job = self.failed_start(TimeoutError('synthetic timeout'), self.snapshot)
        result = runner.reconcile(job['id'])
        self.assertEqual(result['outcome'], 'unresolved')
        self.assertEqual(result['job'].get('reconciliation_outcome'), 'unresolved')
        self.assertIn('run-old', result['job']['label'])
        self.assertIn('running', result['job']['label'])
        self.assertIn('工作台', result['job']['label'])
        self.assertFalse(result['job']['can_stop'])
        self.assertEqual(job['snapshot'].get('run'), None)

    def test_missing_id_old_ended_run_settles_but_recent_or_undated_run_does_not(self):
        for updated, expected in [('2026-09-30T01:00:00+00:00', 'finished'),
                                  ('2026-10-02T01:00:00+00:00', 'unresolved'), (None, 'unresolved')]:
            with self.subTest(updated=updated):
                with closing(sqlite3.connect(self.store.db)) as db, db:
                    db.execute("UPDATE tasks SET status='doing',notes='original history' WHERE id=1")
                self.save_job(self.job)
                current = self.terminal(accepted=True)
                if updated:
                    current['updatedAt'] = updated
                runner, job = self.failed_start(TimeoutError('synthetic timeout'), current)
                result = runner.reconcile(job['id'])
                self.assertEqual(result['outcome'], expected)
                self.assertNotIn('agents', job['snapshot'], 'Never adopt an unattributed result')
                if expected == 'finished':
                    self.assertEqual(result['task']['status'], 'blocked')

    def test_lost_known_run_can_be_user_confirmed_blocked_without_accepting_results(self):
        runner = self.runner({'status': 'idle'})
        job = runner.jobs[0]
        job['access'] = 'workspace-write'
        job['snapshot'] = self.terminal(accepted=True)
        original = copy.deepcopy(job['snapshot'])
        self.assertEqual(runner.reconcile(job['id'])['outcome'], 'unresolved')
        result = runner.reconcile(job['id'], confirm_ended=True)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(result['job']['state'], 'blocked')
        self.assertEqual(result['task']['status'], 'blocked')
        self.assertIn('用户确认结束，未经 Crew 证实', result['job']['label'])
        self.assertIn('用户确认结束，未经 Crew 证实', self.task_row()[1])
        self.assertEqual(result['job']['snapshot'], original)
        self.assertTrue(result['job'].get('user_confirmed_ended'))
        row = self.task_row()
        runner.reconcile(job['id'])
        self.assertEqual(self.task_row(), row)
        self.assertFalse(any(path in ('/api/team/start', '/api/team/stop') for path, _ in runner.calls))
        self.assert_dispatch_available(runner)

    def test_pre_dispatch_run_identity_proves_an_ended_run_is_older_even_after_updates(self):
        runner = self.runner(self.terminal())
        runner.reconcile('job-old')
        request = runner.request
        def fake(path, payload=None):
            if path == '/api/state':
                return {'projects': [{'id': 'project-one', 'dirs': [str((self.root / 'project').resolve())]}]}
            if path == '/api/team/start':
                raise TimeoutError('synthetic timeout')
            return request(path, payload)
        runner.request = fake
        with patch.object(module.threading, 'Thread'):
            dispatched = runner.dispatch(1, 'read-only', 'Synthetic next task')
        self.assertEqual(dispatched['prior_run_id'], 'run-old')
        job = runner.find_job(dispatched['id'])
        runner.current['updatedAt'] = '2999-01-01T00:00:00+00:00'
        runner.run(job, {'goal': 'Synthetic task', 'cwd': str(self.root / 'project'), 'access': 'read-only'})
        self.assertEqual(job['state'], 'recovery_required')
        result = runner.reconcile(job['id'])
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(result['task']['status'], 'blocked')
        self.assertNotIn('agents', result['job']['snapshot'])

    def test_confirmation_is_only_allowed_for_unresolved_recovery_and_boolean_true(self):
        runner = self.runner()
        job = runner.jobs[0]
        with self.assertRaises(ValueError):
            runner.reconcile(job['id'], confirm_ended=True)
        self.assertEqual(runner.reconcile(job['id'])['outcome'], 'live')
        with self.assertRaises(ValueError):
            runner.reconcile(job['id'], confirm_ended=True)
        runner.current = {'status': 'idle'}
        runner.reconcile(job['id'])
        with self.assertRaises(ValueError):
            runner.reconcile(job['id'], confirm_ended='true')
        runner.reconcile(job['id'], confirm_ended=True)
        row = self.task_row()
        with self.assertRaises(ValueError):
            runner.reconcile(job['id'], confirm_ended=True)
        self.assertEqual(self.task_row(), row)

    def test_confirmation_preserves_concurrent_task_state_and_newer_receipt(self):
        for status in ('done', 'cancelled', 'doing'):
            with self.subTest(status=status):
                self.save_job(self.job)
                with closing(sqlite3.connect(self.store.db)) as db, db:
                    db.execute('UPDATE tasks SET status=?,notes=? WHERE id=1', (status, 'concurrent history'))
                if status == 'doing':
                    self.save_job({**self.job, 'id': 'job-new', 'created_at': '2026-10-02T00:00:00+00:00'})
                runner = self.runner({'status': 'idle'})
                runner.reconcile('job-old')
                result = runner.reconcile('job-old', confirm_ended=True)
                self.assertEqual(result['outcome'], 'finished')
                self.assertEqual(result['job']['state'], 'blocked')
                self.assertEqual(self.task_row(), (status, 'concurrent history'))
                self.assertIn('用户确认结束，未经 Crew 证实', result['job']['label'])

    def test_http_confirmation_forwards_explicit_flag(self):
        runner = self.runner({'status': 'idle'})
        runner.reconcile('job-old')
        cls = module.handler(runner, self.root)
        instance = object.__new__(cls)
        payload = json.dumps({'job_id': 'job-old', 'confirm_ended': True}).encode()
        instance.headers = {'Host': '127.0.0.1:6498', 'x-corpus': '1', 'Content-Length': str(len(payload))}
        instance.server = SimpleNamespace(server_port=6498)
        instance.path = '/api/reconcile'
        instance.rfile = io.BytesIO(payload)
        responses = []
        instance.respond = lambda status, value: responses.append((status, value))
        instance.do_POST()
        self.assertEqual(responses[0][0], 200, responses)
        self.assertEqual(responses[0][1]['outcome'], 'finished')
        self.assertEqual(responses[0][1]['task']['status'], 'blocked')


if __name__ == '__main__':
    unittest.main()
