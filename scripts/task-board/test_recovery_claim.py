"""Claim timed-out starts and recheck confirmations using temporary fixtures only."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('claim_recovery_fixtures', Path(__file__).with_name('test_recovery_start.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
module = fixtures.module
review_spec = importlib.util.spec_from_file_location('claim_review', Path(__file__).with_name('review.py'))
review = importlib.util.module_from_spec(review_spec)
review_spec.loader.exec_module(review)


class ClaimRecoveryTests(unittest.TestCase):
    setUp = fixtures.StartRecoveryTests.setUp
    save_job = fixtures.StartRecoveryTests.save_job
    disk_job = fixtures.StartRecoveryTests.disk_job
    task_row = fixtures.StartRecoveryTests.task_row
    runner = fixtures.StartRecoveryTests.runner
    terminal = fixtures.StartRecoveryTests.terminal
    failed_start = fixtures.StartRecoveryTests.failed_start

    def claimed_snapshot(self, status='running', claim='job-old'):
        return {**self.terminal(), 'status': status,
                'run': {'id': 'run-claimed', 'clientRequestId': claim,
                        'workerCwd': str(self.root / 'isolated'), 'baselinePath': str(self.root / 'baseline.json')},
                'agents': [{'state': 'running' if status in ('running', 'starting') else 'completed',
                            'output': 'Synthetic isolated result'}]}

    def test_start_sends_receipt_claim_before_the_response_times_out(self):
        runner, job = self.failed_start(TimeoutError('Synthetic timeout'))
        sent = next(body for path, body in runner.calls if path == '/api/team/start')
        self.assertEqual(sent.get('clientRequestId'), job['id'])

    def test_timeout_claim_recovers_live_run_and_persists_artifact_locations_after_stop(self):
        runner, job = self.failed_start(TimeoutError('Synthetic timeout'), self.claimed_snapshot())
        job['access'] = 'workspace-write'
        live = runner.reconcile(job['id'])
        self.assertEqual(live['outcome'], 'live')
        self.assertTrue(live['job']['can_stop'])
        self.assertEqual(self.disk_job()['snapshot']['run'], runner.current['run'])
        runner.stop(job['id'])
        result = runner.reconcile(job['id'])
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(self.disk_job()['snapshot']['run'], runner.current['run'])
        self.assertEqual(self.disk_job()['snapshot']['agents'][0]['output'], 'Synthetic isolated result')

    def test_timeout_can_claim_an_already_stopped_run_without_losing_results(self):
        current = self.claimed_snapshot('stopped')
        runner, job = self.failed_start(TimeoutError('Synthetic timeout'), current)
        job['access'] = 'workspace-write'
        result = runner.reconcile(job['id'])
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(result['task']['status'], 'blocked')
        self.assertEqual(result['job']['label'], '隔离成果待确认')
        self.assertEqual(self.disk_job()['snapshot']['run'], current['run'])
        self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))

    def test_different_valid_claim_settles_without_adopting_or_stopping_other_run(self):
        for status in ('starting', 'running', 'stopped'):
            with self.subTest(status=status):
                self.setUp()
                runner, job = self.failed_start(TimeoutError('Synthetic timeout'), self.claimed_snapshot(status, 'another-job'))
                result = runner.reconcile(job['id'])
                self.assertEqual(result['outcome'], 'finished')
                self.assertEqual(result['task']['status'], 'blocked')
                self.assertIn('没启动', result['job']['label'])
                self.assertNotIn('run', result['job']['snapshot'])
                self.assertFalse(any(path == '/api/team/stop' for path, _ in runner.calls))

    def test_absent_or_invalid_claim_keeps_legacy_unresolved_behavior(self):
        for claim in (None, '', 'bad claim', 42):
            with self.subTest(claim=claim):
                current = self.claimed_snapshot()
                if claim is None:
                    del current['run']['clientRequestId']
                else:
                    current['run']['clientRequestId'] = claim
                runner, job = self.failed_start(TimeoutError('Synthetic timeout'), current)
                result = runner.reconcile(job['id'])
                self.assertEqual(result['outcome'], 'unresolved')
                self.assertEqual(self.task_row()[0], 'doing')
                self.assertNotIn('run', result['job']['snapshot'])

    def test_confirmation_rechecks_recovered_live_run_by_id_or_claim_and_refuses_to_settle(self):
        for identity in ('id', 'claim'):
            for status in ('starting', 'running'):
                with self.subTest(identity=identity, status=status):
                    self.setUp()
                    current = self.claimed_snapshot(status) if identity == 'claim' else {**self.snapshot, 'status': status}
                    runner = self.runner(current)
                    job = runner.jobs[0]
                    if identity == 'claim':
                        job['snapshot'] = {'error': 'Synthetic timeout'}
                    runner.unreachable = True
                    self.assertEqual(runner.reconcile(job['id'])['outcome'], 'unresolved')
                    runner.unreachable = False
                    before = len(runner.calls)
                    result = runner.reconcile(job['id'], confirm_ended=True)
                    self.assertEqual(result['outcome'], 'live')
                    self.assertTrue(result['job']['can_stop'])
                    self.assertIn('先停止', result['job']['label'])
                    self.assertEqual(len(runner.calls), before + 1)
                    self.assertEqual(self.task_row()[0], 'doing')
                    self.assertFalse(result['job'].get('user_confirmed_ended'))
                    self.assertEqual(self.disk_job()['snapshot']['run'], current['run'])

    def test_confirmation_when_still_unreachable_or_unrecognized_remains_allowed(self):
        for unreachable in (True, False):
            with self.subTest(unreachable=unreachable):
                self.setUp()
                runner = self.runner({'status': 'idle'})
                job = runner.jobs[0]
                original = copy.deepcopy(job['snapshot'])
                runner.unreachable = unreachable
                runner.reconcile(job['id'])
                before = len(runner.calls)
                result = runner.reconcile(job['id'], confirm_ended=True)
                self.assertEqual(len(runner.calls), before + 1)
                self.assertEqual(result['outcome'], 'finished')
                self.assertTrue(result['job']['user_confirmed_ended'])
                self.assertEqual(result['job']['snapshot'], original)
                self.assertEqual(self.task_row()[0], 'blocked')

    def test_confirmation_preserves_newly_claimed_stopped_workspace_and_baseline(self):
        runner, job = self.failed_start(TimeoutError('Synthetic timeout'), self.claimed_snapshot('stopped'))
        job['access'] = 'workspace-write'
        worker = self.root / 'isolated'
        worker.mkdir()
        (worker / 'result.txt').write_text('Synthetic isolated result')
        baseline = {'source': str(self.root / 'project'), 'cwd': str(worker), 'files': []}
        (self.root / 'baseline.json').write_text(json.dumps(baseline))
        runner.unreachable = True
        runner.reconcile(job['id'])
        runner.unreachable = False
        result = runner.reconcile(job['id'], confirm_ended=True)
        self.assertEqual(result['outcome'], 'finished')
        self.assertEqual(self.disk_job()['snapshot'].get('run'), runner.current['run'])
        self.assertEqual(result['job']['state'], 'blocked')
        receipt, archive, loaded = review.load(self.root, self.manifest, job['id'])
        self.assertEqual(loaded, baseline)
        self.assertEqual((archive / 'workspace/result.txt').read_text(), 'Synthetic isolated result')
        self.assertTrue(receipt['user_confirmed_ended'])
        self.assertFalse((self.root / 'project/result.txt').exists(), 'Review must not merge into the source')


if __name__ == '__main__':
    unittest.main()
