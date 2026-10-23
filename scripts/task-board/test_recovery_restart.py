"""Lost start responses across Crew restarts; temporary DBs and fake Crew only."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('restart_recovery_fixtures', Path(__file__).with_name('test_recovery_start.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class FakeCrew:
    def __init__(self, root):
        self.root = root
        self.current = {'status': 'idle', 'messages': [], 'members': []}
        self.calls = []

    def request(self, path, payload=None):
        self.calls.append((path, copy.deepcopy(payload)))
        if path == '/api/team/start':
            # The client times out; Crew can still finish starting afterward.
            self.payload = payload
            raise TimeoutError('Synthetic start response timeout')
        if path.startswith('/api/team?'):
            return copy.deepcopy(self.current)
        raise AssertionError('Unexpected fake Crew request: ' + path)

    def finish_late_start(self):
        worker = self.root / 'isolated'
        worker.mkdir()
        (worker / 'result.txt').write_text('Synthetic isolated result')
        self.current = {'status': 'running', 'run': {
            'id': 'run-late', 'clientRequestId': self.payload['clientRequestId'],
            'workerCwd': str(worker), 'baselinePath': str(self.root / 'baseline.json')},
            'agents': [{'state': 'running', 'output': 'Synthetic isolated result'}]}


class RestartRecoveryTests(unittest.TestCase):
    setUp = fixtures.StartRecoveryTests.setUp
    save_job = fixtures.StartRecoveryTests.save_job
    disk_job = fixtures.StartRecoveryTests.disk_job
    task_row = fixtures.StartRecoveryTests.task_row
    runner = fixtures.StartRecoveryTests.runner
    failed_start = fixtures.StartRecoveryTests.failed_start
    http_error = staticmethod(fixtures.StartRecoveryTests.http_error)

    def test_timeout_then_empty_restarted_crew_stays_unresolved_until_user_confirms(self):
        crew = FakeCrew(self.root)
        runner = self.runner(crew.current)
        runner.request = crew.request
        job = runner.jobs[0]
        job.update(snapshot={}, state='starting', access='workspace-write')
        runner.active = job
        runner.run(job, {'goal': 'Synthetic task', 'cwd': str(self.root / 'project'), 'access': 'workspace-write'})
        self.assertEqual(job['state'], 'recovery_required')
        original = copy.deepcopy(job['snapshot'])
        self.assertNotIn('run', original)
        crew.finish_late_start()
        crew.current['status'] = 'stopped'
        crew.current['agents'][0]['state'] = 'completed'

        # A fresh Crew instance has lost its run/claim/location metadata.
        restarted_crew = FakeCrew(self.root)
        runner.request = restarted_crew.request
        row = self.task_row()
        for _ in range(2):
            result = runner.reconcile(job['id'])
            self.assertEqual(result['outcome'], 'unresolved')
            self.assertEqual(result['job']['reconciliation_outcome'], 'unresolved')
            self.assertEqual(result['job']['state'], 'recovery_required')
            self.assertEqual(result['task']['status'], 'doing')
            self.assertIn('Crew 当前没有运行，可能已重启', result['job']['label'])
            self.assertIn('无法确认原运行是否启动过', result['job']['label'])
            self.assertIn('工作台或隔离副本目录', result['job']['label'])
            self.assertIn('确认原运行已结束', result['job']['label'])
            self.assertNotIn('确认本次没启动', result['job']['label'])
            self.assertFalse(result['job']['can_stop'])
            self.assertEqual(self.task_row(), row)
            self.assertEqual(self.disk_job()['snapshot'], original)
            self.assertEqual(self.disk_job()['reconciliation_outcome'], 'unresolved')

        result = runner.reconcile(job['id'], confirm_ended=True)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(result['job']['state'], 'blocked')
        self.assertEqual(result['task']['status'], 'blocked')
        self.assertTrue(result['job']['user_confirmed_ended'])
        self.assertIn('用户确认结束，未经 Crew 证实', result['job']['label'])
        self.assertIn('用户确认结束，未经 Crew 证实', self.task_row()[1])
        self.assertEqual(self.disk_job()['snapshot'], original)
        self.assertEqual((self.root / 'isolated/result.txt').read_text(), 'Synthetic isolated result')
        self.assertFalse((self.root / 'project/result.txt').exists())
        self.assertEqual(len(restarted_crew.calls), 3)
        self.assertTrue(all(path.startswith('/api/team?') for path, _ in restarted_crew.calls))

    def test_http_rejection_with_no_run_still_settles_immediately(self):
        runner, job = self.failed_start(self.http_error())
        self.assertEqual(job['state'], 'blocked')
        self.assertEqual(job['reconciliation_outcome'], 'finished')
        self.assertEqual(self.task_row()[0], 'blocked')
        self.assertIn('Crew 明确拒绝启动', job['label'])
        self.assertIn('确认没启动', job['label'])
        self.assertFalse(job.get('user_confirmed_ended'))
        self.assertIsNone(runner.active)
        self.assertTrue(any(path.startswith('/api/team?') for path, _ in runner.calls))
        self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))


if __name__ == '__main__':
    unittest.main()
