"""运行统计：只造回执和原生日志；联调用假 Codex，不调用模型。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATS = HERE / 'stats.py'
sys.path.insert(0, str(HERE))
from test_worker import FAKE_CODEX, WORKER


def at(seconds):
    return f'2025-01-01T00:{seconds // 60:02d}:{seconds % 60:02d}+00:00'


def event(seconds, kind, turn='root', root=None):
    payload = {'type': kind, 'turn_id': turn}
    if root:
        payload['turn_attribution'] = {'root_turn_id': root, 'turn_id': turn}
    return {'type': 'event_msg', 'timestamp': at(seconds), 'payload': payload}


def token(seconds, response, values=(100, 60, 20, 5), turn='root', root=None):
    inp, cache, out, reasoning = values
    payload = {'response_id': response, 'turn_id': turn,
               'usage': {'input_tokens': inp, 'cached_input_tokens': cache,
                         'output_tokens': out, 'reasoning_output_tokens': reasoning,
                         'total_tokens': inp + out}}
    if root:
        payload['root_turn_id'] = root
    return {'type': 'token_usage_record', 'timestamp': at(seconds), 'payload': payload}


class StatsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name)
        self.run = self.tmp / 'run'
        (self.run / 'cards').mkdir(parents=True)
        self.home = self.tmp / 'codex-home'
        self.sessions = self.home / 'sessions' / '2025' / '01' / '01'
        self.sessions.mkdir(parents=True)
        self.env = {**os.environ, 'CODEX_HOME': str(self.home), 'PYTHONDONTWRITEBYTECODE': '1'}
        self.write(self.run / 'run.json', {'created_at': at(0)})

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def log(self, path, records):
        path.write_text(''.join(json.dumps(r) + '\n' for r in records), encoding='utf-8')

    def card(self, name, deps=()):
        body = f'依赖：{", ".join(deps)}\n' if deps else '任务\n'
        (self.run / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def receipt(self, name, start, end, review=None, verdict='accepted',
                state='finished', session=None, tokens=10, history=False, deps=()):
        r = {'card': str(self.run / 'cards' / f'{name}.md'), 'deps': list(deps),
             'started_at': at(start), 'state': state, 'tokens': tokens,
             'tokens_session': 9999, 'session_id': session}
        if end is not None:
            r.update(ended_at=at(end), seconds=end - start + .1)
        if review is not None:
            r['review'] = {'at': at(review), 'verdict': verdict, 'note': '检查结果'}
        path = self.run / ('history' if history else '') / (f'{name}-20250101-000030.json' if history else f'{name}.json')
        self.write(path, r)
        return path

    def cli(self, *args):
        return subprocess.run([sys.executable, str(STATS), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def metrics(self, *args, out=None):
        out = out or self.run
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((out / 'metrics.json').read_text())

    def fixture(self):
        self.card('draft')
        self.card('no-log')
        self.card('merge', ('draft', 'no-log'))
        self.receipt('draft', 10, 30, 40, 'rejected', session='sample-draft', tokens=60, history=True)
        self.receipt('no-log', 12, 50, 80, session='sample-missing', tokens=70)
        self.receipt('draft', 60, 90, 100, session='sample-draft', tokens=30)
        self.receipt('merge', 110, 140, 160, session='sample-merge', tokens=20, deps=('draft', 'no-log'))
        first = token(20, 'response-a')
        self.log(self.sessions / 'rollout-sample-draft.jsonl', [token(1, 'outside-before'), first, first,
                 token(70, 'response-b', (50, 30, 10, 2)), token(170, 'outside-after')])
        self.log(self.sessions / 'rollout-sample-merge.jsonl', [token(120, 'response-c', (40, 20, 8, 1))])
        # 无关会话内容损坏，也不该被读取。
        (self.sessions / 'rollout-unrelated.jsonl').write_text('not json\n')

    def test_crew_attempts_intervals_batches_and_usage(self):
        self.fixture()
        m = self.metrics(self.run)
        expected = {'wall_seconds': 160, 'first_delivery_seconds': 30,
                    'worker_active_sum_seconds': 118, 'worker_any_active_seconds': 100,
                    'peak_active_workers': 2, 'no_worker_seconds': 60,
                    'awaiting_review_seconds': 40, 'other_idle_seconds': 20,
                    'tail_review_seconds': 20, 'receipt_tokens': 180,
                    'usage_covered_attempts': 3, 'tokens_missing_attempts': 0}
        for key, value in expected.items():
            self.assertEqual(m[key], value, key)
        attempts = {(a['card'], a['attempt']): a for a in m['attempts']}
        old = attempts['draft', 1]
        self.assertEqual((old['started_at'], old['ended_at'], old['seconds']), (at(10), at(30), 20))
        self.assertEqual((old['state'], old['verdict'], old['review_wait_seconds']), ('finished', 'rejected', 10))
        self.assertEqual(attempts['draft', 2]['tokens'], 30)
        self.assertEqual(attempts['draft', 2]['usage']['total_tokens'], 60)
        self.assertEqual(attempts['merge', 1]['deps'], ['draft', 'no-log'])
        self.assertEqual(attempts['no-log', 1]['log_status'], '无日志')
        self.assertIsNone(attempts['no-log', 1]['usage'])
        self.assertEqual(m['combined_usage'], {'input_tokens': 190, 'cached_input_tokens': 110,
                         'uncached_input_tokens': 80, 'output_tokens': 38,
                         'reasoning_output_tokens': 8, 'total_tokens': 228})
        self.assertEqual([b['start_span_seconds'] for b in m['dispatch_batches']], [2, 0, 0])
        self.assertEqual([len(b['attempts']) for b in m['dispatch_batches']], [2, 1, 1])
        summary = (self.run / 'summary.md').read_text()
        for word in ('工具等待', '不全部等同闲置或浪费', '不折算金额', '5秒', '无日志', '退回', '等验收', '非缓存', '首个交付', '收尾'):
            self.assertIn(word, summary)

    def test_out_dir_does_not_write_into_input_and_is_repeatable(self):
        self.fixture()
        before = {str(p): p.read_bytes() for p in self.run.rglob('*') if p.is_file()}
        out = self.tmp / 'output'
        first = self.metrics(self.run, '--out-dir', out, out=out)
        self.assertEqual(first, self.metrics(self.run, '--out-dir', out, out=out))
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.run.rglob('*') if p.is_file()})

    def test_pending_review_failed_and_unstarted_cards(self):
        self.card('delivered')
        self.card('failure')
        self.card('blocked', ('delivered',))
        self.card('ready')
        self.receipt('delivered', 10, 20, tokens=None)
        self.receipt('failure', 40, 50, state='failed')
        m = self.metrics(self.run)
        self.assertEqual((m['wall_seconds'], m['first_delivery_seconds']), (50, 20))
        self.assertEqual((m['awaiting_review_seconds'], m['other_idle_seconds']), (20, 10))
        self.assertIsNone(m['tail_review_seconds'])
        a = m['attempts'][0]
        self.assertIsNone(a['review_wait_seconds'])
        self.assertEqual(a['pending_review_seconds'], 30)
        self.assertEqual(m['tokens_missing_attempts'], 1)
        states = {c['card']: c['state'] for c in m['cards']}
        self.assertEqual(states['blocked'], 'waiting')
        self.assertEqual(states['ready'], 'ready')
        self.assertIn('blocked', (self.run / 'summary.md').read_text())

    def test_empty_and_unfinished_run_stop_at_last_event(self):
        self.card('t1')
        m = self.metrics(self.run)
        self.assertEqual(m['wall_seconds'], 0)
        self.assertIsNone(m['first_delivery_seconds'])
        self.receipt('t1', 10, None, state='running', tokens=None)
        m = self.metrics(self.run)
        self.assertEqual(m['wall_seconds'], 10)
        self.assertIsNone(m['attempts'][0]['seconds'])
        self.assertIn('未结束', (self.run / 'summary.md').read_text())

    def test_touching_intervals_do_not_inflate_concurrency(self):
        for name, start, end in [('a', 10, 20), ('b', 20, 30), ('c', 30, 30)]:
            self.card(name)
            self.receipt(name, start, end, end)
        m = self.metrics(self.run)
        self.assertEqual((m['worker_any_active_seconds'], m['peak_active_workers']), (20, 1))

    def test_log_without_usage_is_unknown_not_zero(self):
        self.card('a')
        self.receipt('a', 10, 30, 40, session='sample-old')
        self.log(self.sessions / 'rollout-sample-old.jsonl', [event(10, 'task_started')])
        m = self.metrics(self.run)
        self.assertIsNone(m['attempts'][0]['usage'])
        self.assertEqual(m['attempts'][0]['log_status'], '无匹配用量记录')

    def test_same_second_retry_keeps_archive_before_current_receipt(self):
        self.card('a')
        self.receipt('a', 10, 10, 10, 'rejected', history=True, tokens=7)
        self.receipt('a', 10, 20, 30, tokens=9)
        m = self.metrics(self.run)
        self.assertEqual([a['tokens'] for a in m['attempts']], [7, 9])
        self.assertEqual([a['attempt'] for a in m['attempts']], [1, 2])
        self.assertEqual(m['cards'][0]['state'], 'accepted')

    def test_log_missing_fields_and_ambiguous_logs_are_reported(self):
        self.card('a')
        self.receipt('a', 10, 30, 40, session='sample-a')
        record = token(20, 'sample-response')
        del record['payload']['usage']['cached_input_tokens']
        log = self.sessions / 'rollout-sample-a.jsonl'
        self.log(log, [record])
        m = self.metrics(self.run)
        self.assertEqual(m['attempts'][0]['log_status'], '用量字段不全')
        self.assertIsNone(m['attempts'][0]['usage'])
        self.log(self.sessions / 'copy-sample-a.jsonl', [token(20, 'sample-response')])
        m = self.metrics(self.run)
        self.assertEqual(m['attempts'][0]['log_status'], '日志不唯一')
        self.assertIsNone(m['attempts'][0]['usage'])

    def test_invalid_receipt_times_fail_before_output(self):
        self.card('a')
        self.receipt('a', 20, 10, 30)
        result = self.cli(self.run)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('早于', result.stderr)
        self.assertFalse((self.run / 'metrics.json').exists())

    def native_fixture(self):
        root, child = self.tmp / 'root.jsonl', self.tmp / 'child.jsonl'
        self.log(root, [event(0, 'task_started'), token(5, 'parent-response'), token(5, 'parent-response'),
                        token(6, 'other-turn', turn='other'), event(100, 'task_complete')])
        self.log(child, [event(10, 'task_started', 'child-a', 'root'), token(15, 'child-response', root='root'),
                         event(30, 'task_complete', 'child-a', 'root'),
                         event(40, 'task_started', 'child-b', 'root'),
                         event(60, 'turn_aborted', 'child-b', 'root'),
                         event(70, 'task_started', 'child-c', 'root')])
        manifest = self.tmp / 'manifest.json'
        self.write(manifest, [{'id': 'sample-child', 'agent_path': '/root/child', 'rollout_path': str(child)}])
        return ['--manifest', manifest, '--root-log', root, '--turn-id', 'root', '--out-dir', self.tmp / 'native']

    def test_native_mode_keeps_original_metrics_and_scope(self):
        args = self.native_fixture()
        m = self.metrics(*args, out=self.tmp / 'native')
        self.assertEqual((m['wall_seconds'], m['peak_active_child_tasks'], m['parent_only_seconds']), (100, 1, 30))
        self.assertEqual(m['combined_usage']['total_tokens'], 240)
        self.assertEqual(m['combined_usage']['uncached_input_tokens'], 80)
        self.assertEqual((m['children'][0]['unfinished_tasks'], m['children'][0]['aborted_tasks']), (1, 1))

    def test_native_requires_start_and_supports_override(self):
        args = self.native_fixture()
        self.log(self.tmp / 'root.jsonl', [event(100, 'task_complete')])
        result = self.cli(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--start', result.stderr)
        m = self.metrics(*args, '--start', at(0), out=self.tmp / 'native')
        self.assertEqual(m['wall_seconds'], 100)

    def test_partial_last_log_line_is_ignored_but_corruption_is_reported(self):
        args = self.native_fixture()
        child = self.tmp / 'child.jsonl'
        with child.open('a') as f:
            f.write('{"incomplete":')
        self.metrics(*args, out=self.tmp / 'native')
        with child.open('a') as f:
            f.write('\n')
        self.assertNotEqual(self.cli(*args).returncode, 0)

    def test_cli_rejects_mixed_or_incomplete_modes(self):
        for args in [[], [self.run, '--manifest', 'missing'], ['--manifest', 'missing'], [self.run, '--start', at(0)]]:
            self.assertNotEqual(self.cli(*args).returncode, 0, args)

    def test_fake_worker_receipt_can_be_summarized(self):
        fake = self.tmp / 'codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env.update(CREW_CODEX_BIN=str(fake), FAKE_LOG=str(self.tmp / 'calls.jsonl'))
        self.card('t1')
        for args in [('run', str(self.run), '--cwd', str(self.tmp)), ('wait', str(self.run), '--minutes', '1')]:
            result = subprocess.run([sys.executable, str(WORKER), *args], env=self.env,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
        m = self.metrics(self.run)
        self.assertEqual(m['attempts'][0]['tokens'], 1234)
        self.assertEqual(m['attempts'][0]['state'], 'finished')
        self.assertEqual(m['attempts'][0]['log_status'], '无日志')


if __name__ == '__main__':
    unittest.main()
