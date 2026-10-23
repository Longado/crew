"""Temporary synthetic DBs and mocked Crew HTTP; never starts a model."""
import copy
from contextlib import closing
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery_board_server', Path(__file__).with_name('server.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FixtureRunner(module.Runner):
    def __init__(self, store, snapshot):
        self.current = copy.deepcopy(snapshot)
        self.calls = []
        self.unreachable = False
        self.stop_pending = False
        super().__init__(store, 'http://127.0.0.1:1')

    def request(self, path, payload=None):
        self.calls.append((path, copy.deepcopy(payload)))
        if self.unreachable:
            raise ValueError('Synthetic Crew is unreachable')
        if path.startswith('/api/team?'):
            return copy.deepcopy(self.current)
        if path == '/api/team/stop':
            if payload.get('runId') != (self.current.get('run') or {}).get('id'):
                raise ValueError('Stale run rejected')
            if not self.stop_pending:
                self.current['status'] = 'stopped'
            return copy.deepcopy(self.current)
        if path == '/api/team/start':
            return copy.deepcopy(self.start_snapshot)
        raise AssertionError('Unexpected mocked request: ' + path)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='crew-recovery-fixture-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / '.data').mkdir()
        (self.root / 'project').mkdir()
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps({'tasks': [{'task_id': 1, 'sources': [1], 'line': 'Synthetic', 'owner': 'Codex', 'dependency': '', 'next': 'Read', 'acceptance': 'Check synthetic data'}]}))
        with closing(sqlite3.connect(self.root / '.data/tasks.db')) as db, db:
            db.executescript('''
                CREATE TABLE projects(id INTEGER PRIMARY KEY,local_path TEXT);
                CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,title TEXT,status TEXT,priority TEXT,notes TEXT);
                INSERT INTO projects VALUES(1,'project');
                INSERT INTO tasks VALUES(1,1,'Synthetic task','doing','medium','original history');
            ''')
        self.store = module.BoardStore(self.root, self.manifest)
        self.snapshot = {'status': 'running', 'run': {'id': 'run-old'}, 'agents': [{'state': 'running', 'output': 'partial original result'}], 'nativeTasks': []}
        self.job = {'id': 'job-old', 'task_id': 1, 'project_id': 'project-one', 'state': 'running', 'snapshot': copy.deepcopy(self.snapshot), 'previous': 'todo', 'access': 'read-only', 'created_at': '2026-10-01T01:00:00+00:00'}
        self.runs = self.manifest.parent / 'runs'
        self.runs.mkdir()
        self.save_job(self.job)

    def save_job(self, job):
        (self.runs / (job['id'] + '.json')).write_text(json.dumps(job))

    def disk_job(self, name='job-old'):
        return json.loads((self.runs / (name + '.json')).read_text())

    def runner(self, snapshot=None):
        return FixtureRunner(self.store, snapshot or self.snapshot)

    def reconcile(self, runner, name='job-old'):
        self.assertTrue(callable(getattr(runner, 'reconcile', None)), 'Runner needs explicit reconciliation')
        return runner.reconcile(name)

    def task_row(self):
        with closing(sqlite3.connect(self.store.db)) as db, db:
            return db.execute('SELECT status,notes FROM tasks WHERE id=1').fetchone()

    def terminal(self, accepted=False):
        return {**copy.deepcopy(self.snapshot), 'status': 'stopped', 'agents': [{'state': 'completed' if accepted else 'interrupted', 'output': 'preserved original result'}]}

    def test_restart_persists_recovery_state_for_board_and_offline_status_without_network(self):
        runner = self.runner()
        self.assertEqual(runner.jobs[0]['state'], 'recovery_required')
        self.assertEqual(self.disk_job()['state'], 'recovery_required')
        self.assertEqual(self.store.status(1)['jobs'][0]['state'], runner.view()['jobs'][0]['state'])
        self.assertEqual(self.task_row()[0], 'doing')
        self.assertEqual(runner.calls, [])

    def test_unreachable_reconciliation_keeps_doing_and_original_snapshot(self):
        runner = self.runner()
        runner.unreachable = True
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'unresolved')
        self.assertEqual(result['job']['state'], 'recovery_required')
        self.assertFalse(result['job']['can_stop'])
        self.assertEqual(self.task_row()[0], 'doing')
        self.assertEqual(self.disk_job()['snapshot'], self.snapshot)
        calls = list(runner.calls)
        runner.view()
        self.assertEqual(runner.calls, calls, 'Board reads must not perform network reconciliation')

    def test_live_original_run_can_be_stopped_and_then_reconciled_without_restart(self):
        runner = self.runner()
        live = self.reconcile(runner)
        self.assertEqual(live['outcome'], 'live')
        self.assertTrue(live['job']['can_stop'])
        self.assertEqual(live['job']['state'], 'recovery_required')
        result = runner.stop('job-old')
        self.assertTrue(result.get('stop_requested'), 'Successful stop must expose request acceptance')
        self.assertTrue(result['stopped'])
        self.assertIn(('/api/team/stop', {'projectId': 'project-one', 'runId': 'run-old'}), runner.calls)
        finished = self.reconcile(runner)
        self.assertEqual(finished['outcome'], 'finished')
        self.assertEqual(self.task_row()[0], 'todo')
        self.assertTrue(self.store.prepare(1, 'read-only', 'Read again')['eligible'])
        self.assertFalse(any(path == '/api/team/start' for path, _ in runner.calls))

    def test_confirmed_unfinished_run_restores_previous_status_and_keeps_results(self):
        runner = self.runner(self.terminal())
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(self.task_row()[0], 'todo')
        self.assertEqual(result['job']['snapshot']['agents'][0]['output'], 'preserved original result')
        self.assertIn('original history', self.task_row()[1])
        self.assertEqual(self.store.cancel(1, 'todo', 'End synthetic task')['task']['status'], 'cancelled')

    def test_accepted_results_keep_existing_settlement_rule(self):
        runner = self.runner(self.terminal(accepted=True))
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(result['job']['state'], 'completed')
        self.assertEqual(self.task_row()[0], 'todo')
        self.assertIn('只读检查完成', result['job']['label'])

    def test_terminal_leader_with_running_child_does_not_confirm_run_end(self):
        snapshot = {**self.snapshot, 'agents': [{'state': 'completed', 'output': 'leader result'}, {'parentThreadId': 'leader', 'state': 'running'}]}
        runner = self.runner(snapshot)
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'live')
        self.assertEqual(result['job']['state'], 'recovery_required')
        self.assertTrue(result['job']['can_stop'])
        self.assertEqual(self.task_row(), ('doing', 'original history'))

    def test_error_snapshot_with_live_run_requires_explicit_stop_confirmation(self):
        snapshot = {**self.snapshot, 'status': 'error', 'agents': [{'state': 'failed'}, {'parentThreadId': 'leader', 'state': 'running'}]}
        runner = self.runner(snapshot)
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'live')
        self.assertTrue(result['job']['can_stop'])
        self.assertEqual(self.task_row(), ('doing', 'original history'))

    def test_repeated_reconciliation_does_not_append_history_or_send_start(self):
        runner = self.runner(self.terminal())
        first = self.reconcile(runner)
        row = self.task_row()
        calls = list(runner.calls)
        second = self.reconcile(runner)
        self.assertEqual(second['outcome'], 'finished')
        self.assertEqual(second['job'], first['job'])
        self.assertEqual(self.task_row(), row)
        self.assertEqual(runner.calls, calls)

    def test_reconciliation_preserves_concurrent_done_or_cancelled_task(self):
        for status in ['done', 'cancelled']:
            with self.subTest(status=status):
                self.save_job(self.job)
                with closing(sqlite3.connect(self.store.db)) as db, db:
                    db.execute('UPDATE tasks SET status=?,notes=? WHERE id=1', (status, 'concurrent history'))
                runner = self.runner(self.terminal())
                result = self.reconcile(runner)
                self.assertEqual(result['outcome'], 'finished')
                self.assertEqual(result['task']['status'], status)
                self.assertEqual(self.task_row(), (status, 'concurrent history'))

    def test_reconciliation_does_not_overwrite_same_task_newer_job(self):
        newer = {**self.job, 'id': 'job-new', 'created_at': '2026-10-01T02:00:00+00:00', 'snapshot': {'status': 'running', 'run': {'id': 'run-new'}}}
        self.save_job(newer)
        runner = self.runner(self.terminal())
        before = self.disk_job('job-new')
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(self.task_row(), ('doing', 'original history'))
        self.assertEqual(self.disk_job('job-new'), before)

    def test_stale_stop_cannot_stop_new_run_or_set_stop_requested(self):
        current = {**self.snapshot, 'run': {'id': 'run-new'}}
        runner = self.runner(current)
        runner.active = runner.jobs[0]
        with self.assertRaises(ValueError):
            runner.stop('job-old')
        self.assertEqual(runner.current['status'], 'running')
        self.assertFalse(runner.active.get('stop_requested', False))
        self.assertIn(('/api/team/stop', {'projectId': 'project-one', 'runId': 'run-old'}), runner.calls)
        self.assertFalse(self.disk_job().get('stop_requested', False))

    def test_missing_run_identity_never_stops_or_settles(self):
        self.job['snapshot'] = {'status': 'running'}
        self.save_job(self.job)
        runner = self.runner()
        runner.active = runner.jobs[0]
        with self.assertRaises(ValueError):
            runner.stop('job-old')
        self.assertFalse(runner.active.get('stop_requested', False))
        result = self.reconcile(runner)
        self.assertEqual(result['outcome'], 'unresolved')
        self.assertEqual(self.task_row()[0], 'doing')
        self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))

    def test_different_or_missing_remote_run_stays_unresolved(self):
        for run in [{'id': 'run-new'}, None]:
            with self.subTest(run=run):
                runner = self.runner({**self.terminal(), 'run': run})
                result = self.reconcile(runner)
                self.assertEqual(result['outcome'], 'unresolved')
                self.assertEqual(result['job']['snapshot']['run']['id'], 'run-old')
                self.assertEqual(self.task_row()[0], 'doing')

    def test_active_receipt_blocks_prepare_and_cancel_even_if_database_was_changed_to_todo(self):
        runner = self.runner()
        with closing(sqlite3.connect(self.store.db)) as db, db:
            db.execute('UPDATE tasks SET status="todo" WHERE id=1')
        self.assertEqual(self.disk_job()['state'], 'recovery_required')
        with self.assertRaises(ValueError):
            self.store.prepare(1, 'read-only', 'Do not duplicate')
        with self.assertRaises(ValueError):
            self.store.cancel(1, 'todo', 'Do not overwrite pending recovery')

    def test_successful_stop_request_does_not_claim_ended_until_confirmation(self):
        runner = self.runner()
        runner.active = runner.jobs[0]
        runner.stop_pending = True
        try:
            result = runner.stop('job-old')
        except ValueError as error:
            self.fail('A stop bound to the live original run must be accepted: ' + str(error))
        self.assertTrue(result.get('stop_requested'), 'Successful stop must expose request acceptance')
        self.assertFalse(result['stopped'])
        self.assertFalse(runner.active.get('stop_confirmed', False))
        self.assertEqual(self.task_row()[0], 'doing')

    def test_run_cleanup_uses_original_run_id(self):
        runner = self.runner(self.terminal(accepted=True))
        job = runner.jobs[0]
        runner.active = job
        runner.start_snapshot = {**self.terminal(accepted=True), 'status': 'running'}
        runner.current = copy.deepcopy(runner.start_snapshot)
        task = {'goal': 'Synthetic read', 'cwd': str(self.root / 'project'), 'access': 'read-only'}
        runner.run(job, task)
        stops = [payload for path, payload in runner.calls if path == '/api/team/stop']
        self.assertEqual(stops, [{'projectId': 'project-one', 'runId': 'run-old'}])
        self.assertEqual(self.task_row()[0], 'todo')

    def test_unconfirmed_stop_request_keeps_polling_the_original_run(self):
        runner = self.runner()
        job = runner.jobs[0]
        job['stop_requested'] = True
        job['stop_confirmed'] = False
        runner.active = job
        runner.start_snapshot = copy.deepcopy(self.snapshot)
        request = runner.request
        polls = []
        def polling(path, payload=None):
            if path.startswith('/api/team?'):
                polls.append(path)
                if len(polls) >= 3:
                    runner.current = self.terminal()
            return request(path, payload)
        runner.request = polling
        task = {'goal': 'Synthetic read', 'cwd': str(self.root / 'project'), 'access': 'read-only'}
        with patch.object(module.time, 'sleep', return_value=None):
            runner.run(job, task)
        self.assertGreaterEqual(len(polls), 3, 'Request acceptance alone must not end the watcher')
        self.assertEqual(self.task_row()[0], 'blocked')

    def test_polling_never_adopts_another_runs_completed_result(self):
        runner = self.runner({**self.terminal(accepted=True), 'run': {'id': 'run-new'}, 'agents': [{'state': 'completed', 'output': 'new run result'}]})
        job = runner.jobs[0]
        runner.active = job
        runner.start_snapshot = copy.deepcopy(self.snapshot)
        task = {'goal': 'Synthetic read', 'cwd': str(self.root / 'project'), 'access': 'read-only'}
        with patch.object(module.time, 'sleep', return_value=None):
            runner.run(job, task)
        self.assertEqual(job['state'], 'recovery_required')
        self.assertEqual(job['snapshot']['run']['id'], 'run-old')
        self.assertEqual(job['snapshot']['agents'][0]['output'], 'partial original result')
        self.assertEqual(self.task_row()[0], 'doing')
        self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))

    def test_http_reconcile_is_explicit_and_returns_the_contract(self):
        runner = self.runner(self.terminal())
        cls = module.handler(runner, self.root)
        instance = object.__new__(cls)
        payload = json.dumps({'job_id': 'job-old'}).encode()
        instance.headers = {'Host': '127.0.0.1:6498', 'x-corpus': '1', 'Content-Length': str(len(payload))}
        instance.server = SimpleNamespace(server_port=6498)
        instance.path = '/api/reconcile'
        instance.rfile = io.BytesIO(payload)
        responses = []
        instance.respond = lambda status, value: responses.append((status, value))
        instance.do_POST()
        self.assertEqual(responses[0][0], 200, responses[0])
        self.assertEqual(responses[0][1]['outcome'], 'finished')
        self.assertEqual(responses[0][1]['task']['status'], 'todo')


if __name__ == '__main__':
    unittest.main()
