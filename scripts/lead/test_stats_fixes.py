"""统计复审回归：只造文件和日志，不调用模型。"""
import json
import os
import unittest

import test_stats as fixtures


class StatsFixesTest(unittest.TestCase):
    # 复用假回执与命令入口，不重复执行原测试类。
    setUp = fixtures.StatsTest.setUp
    write = fixtures.StatsTest.write
    log = fixtures.StatsTest.log
    card = fixtures.StatsTest.card
    receipt = fixtures.StatsTest.receipt
    cli = fixtures.StatsTest.cli
    metrics = fixtures.StatsTest.metrics
    native_fixture = fixtures.StatsTest.native_fixture

    def assert_conflict(self, args, inputs):
        before = {p: p.read_bytes() for p in inputs}
        result = self.cli(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('--out-dir', result.stderr)
        self.assertEqual(before, {p: p.read_bytes() for p in inputs})

    def test_metrics_receipt_is_not_overwritten(self):
        self.card('metrics')
        receipt = self.receipt('metrics', 10, 20, 30)
        self.assert_conflict([self.run], [receipt])
        self.assertFalse((self.run / 'summary.md').exists())
        out = self.tmp / 'reports'
        m = self.metrics(self.run, '--out-dir', out, out=out)
        self.assertEqual(m['attempts'][0]['card'], 'metrics')

    def test_existing_summary_input_blocks_both_outputs(self):
        source = self.run / 'summary.md'
        source.write_text('运行输入，请保留。\n', encoding='utf-8')
        self.assert_conflict([self.run], [source])
        self.assertFalse((self.run / 'metrics.json').exists())

    def test_edited_summary_is_not_mistaken_for_generated_output(self):
        self.metrics(self.run)
        summary = self.run / 'summary.md'
        summary.write_text('# Crew 运行摘要\n\n负责人补充的运行输入。\n', encoding='utf-8')
        self.assert_conflict([self.run], [self.run / 'metrics.json', summary])

    def test_out_dir_cannot_overwrite_a_card(self):
        self.card('summary')
        source = self.run / 'cards' / 'summary.md'
        self.assert_conflict([self.run, '--out-dir', source.parent], [source])
        self.assertFalse((source.parent / 'metrics.json').exists())

    def test_linked_output_cannot_overwrite_receipt(self):
        self.card('a')
        for kind in ('symlink', 'hardlink'):
            with self.subTest(kind=kind):
                receipt = self.receipt('a', 10, 20, 30)
                out = self.tmp / kind
                out.mkdir()
                target = out / 'metrics.json'
                if kind == 'symlink':
                    target.symlink_to(receipt)
                else:
                    os.link(receipt, target)
                self.assert_conflict([self.run, '--out-dir', out], [receipt])
                self.assertFalse((out / 'summary.md').exists())

    def test_native_output_cannot_overwrite_manifest(self):
        args = self.native_fixture()
        out = args[-1]
        out.mkdir()
        manifest = out / 'metrics.json'
        manifest.write_bytes(args[1].read_bytes())
        args[1] = manifest
        self.assert_conflict(args, [manifest])
        self.assertFalse((out / 'summary.md').exists())

    def test_same_response_in_two_attempt_windows_is_counted_once(self):
        self.card('a')
        self.receipt('a', 10, 30, 40, 'rejected', history=True, session='sample-a')
        self.receipt('a', 60, 90, 100, session='sample-a')
        self.log(self.sessions / 'rollout-sample-a.jsonl', [
            fixtures.token(20, 'same-response'), fixtures.token(70, 'same-response'),
            fixtures.token(80, 'new-response')])
        m = self.metrics(self.run)
        self.assertEqual(m['combined_usage']['total_tokens'], 240)
        self.assertEqual([a['responses'] for a in m['attempts']], [1, 1])

    def test_touching_attempt_windows_count_boundary_response_once(self):
        self.card('a')
        self.receipt('a', 0, 10, 10, 'rejected', history=True, session='sample-a')
        self.receipt('a', 10, 20, 20, session='sample-a')
        self.log(self.sessions / 'rollout-sample-a.jsonl', [fixtures.token(10, 'boundary')])
        m = self.metrics(self.run)
        self.assertEqual(m['combined_usage']['total_tokens'], 120)
        self.assertEqual([a['responses'] for a in m['attempts']], [1, 0])

    def test_same_response_id_in_different_sessions_is_not_deduplicated(self):
        for name in ('a', 'b'):
            self.card(name)
            self.receipt(name, 0, 20, 30, session=f'sample-{name}')
            self.log(self.sessions / f'rollout-sample-{name}.jsonl', [fixtures.token(10, 'same-response')])
        self.assertEqual(self.metrics(self.run)['combined_usage']['total_tokens'], 240)

    def test_unreadable_window_does_not_claim_a_later_valid_response(self):
        self.card('a')
        self.receipt('a', 10, 30, 40, 'rejected', history=True, session='sample-a')
        self.receipt('a', 60, 90, 100, session='sample-a')
        broken = fixtures.token(25, 'broken-response')
        del broken['payload']['response_id']
        self.log(self.sessions / 'rollout-sample-a.jsonl', [
            fixtures.token(20, 'same-response'), broken, fixtures.token(70, 'same-response')])
        m = self.metrics(self.run)
        self.assertEqual(m['attempts'][0]['log_status'], '用量记录不可读')
        self.assertIsNone(m['attempts'][0]['usage'])
        self.assertEqual(m['attempts'][1]['usage']['total_tokens'], 120)

    def test_millisecond_receipts_include_last_fractional_response(self):
        self.card('a')
        path = self.receipt('a', 10, 10, session='sample-a')
        receipt = json.loads(path.read_text())
        receipt.update(started_at='2025-01-01T00:00:10.100+00:00',
                       ended_at='2025-01-01T00:00:10.900+00:00')
        self.write(path, receipt)
        record = fixtures.token(10, 'last-fraction')
        record['timestamp'] = '2025-01-01T00:00:10.500Z'
        self.log(self.sessions / 'rollout-sample-a.jsonl', [record])
        m = self.metrics(self.run)
        self.assertEqual(m['combined_usage']['total_tokens'], 120)
        self.assertAlmostEqual(m['attempts'][0]['seconds'], .8, places=5)
        self.assertNotIn('回执时间精确到秒', (self.run / 'summary.md').read_text())

    def test_legacy_seconds_warn_without_widening_usage_window(self):
        self.card('a')
        self.receipt('a', 0, 10, 20, session='sample-a')
        after = fixtures.token(10, 'after-end')
        after['timestamp'] = '2025-01-01T00:00:10.500Z'
        self.log(self.sessions / 'rollout-sample-a.jsonl', [fixtures.token(5, 'inside'), after])
        m = self.metrics(self.run)
        self.assertEqual(m['combined_usage']['total_tokens'], 120)
        summary = (self.run / 'summary.md').read_text()
        self.assertIn('整秒', summary)
        self.assertIn('精度限制', summary)

    def test_archived_running_attempt_has_unknown_end_and_no_activity(self):
        self.card('a')
        self.receipt('a', 0, None, 10, 'rejected', state='running',
                     history=True, session='sample-a')
        self.receipt('a', 20, 30, 40, session='sample-a')
        self.log(self.sessions / 'rollout-sample-a.jsonl', [fixtures.token(25, 'retry-response')])
        m = self.metrics(self.run)
        self.assertEqual(m['worker_active_sum_seconds'], 10)
        self.assertEqual(m['worker_any_active_seconds'], 10)
        self.assertEqual(m['peak_active_workers'], 1)
        self.assertEqual(m['awaiting_review_seconds'], 10)
        old, current = m['attempts']
        self.assertIsNone(old['seconds'])
        self.assertIsNone(old['usage'])
        self.assertEqual(old['log_status'], '结束时间未知')
        self.assertEqual(current['usage']['total_tokens'], 120)
        summary = (self.run / 'summary.md').read_text()
        self.assertIn('结束时间未知：a#1', summary)
        self.assertIn('不计入活动区间和并发', summary)

    def test_current_running_attempt_still_uses_last_event(self):
        self.card('a')
        self.receipt('a', 0, None, state='running')
        self.card('b')
        self.receipt('b', 20, 30, 40)
        m = self.metrics(self.run)
        self.assertEqual(m['worker_active_sum_seconds'], 50)
        self.assertEqual(m['peak_active_workers'], 2)


if __name__ == '__main__':
    unittest.main()
