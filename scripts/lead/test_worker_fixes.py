"""派单修复回归：临时目录与假 Codex，不调用真模型。"""
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import worker as runner
import stats
from test_worker import FAKE_CODEX, WORKER


class WorkerFixesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.fake = self.tmp / 'codex'
        self.fake.write_text(FAKE_CODEX, encoding='utf-8')
        self.fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(self.fake),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.run_dir = self.tmp / 'run'
        (self.run_dir / 'cards').mkdir(parents=True)

    def card(self, name, body='任务'):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def worker(self, *args):
        return subprocess.run([sys.executable, str(WORKER), *map(str, args)], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def ok(self, *args):
        result = self.worker(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def read(self, name):
        return json.loads((self.run_dir / f'{name}.json').read_text(encoding='utf-8'))

    def calls(self):
        path = self.tmp / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def finish(self):
        for _ in range(20):
            status = json.loads(self.ok('status', self.run_dir).stdout)
            if not any(card['state'] == 'running' for card in status['cards']):
                return
            self.ok('wait', self.run_dir, '--minutes', '0.1')
        self.fail('假执行者没有结束')

    def go(self, *args):
        self.ok('run', self.run_dir, '--cwd', self.tmp, '--minutes', '0.1', *args)
        self.finish()

    def test_reserved_names_fail_before_metadata_or_dispatch(self):
        for index, name in enumerate(('run', 'baseline', 'metrics', 'summary', 'RUN', 'Baseline', 'MeTrIcS', 'SUMMARY')):
            with self.subTest(name=name):
                self.run_dir = self.tmp / f'case-{index}'
                (self.run_dir / 'cards').mkdir(parents=True)
                self.card(name)
                # 即使旧目录已有同名文件，校验也不能覆盖它。
                original = '原有摘要'
                (self.run_dir / 'summary.md').write_text(original, encoding='utf-8')
                result = self.worker('run', self.run_dir, '--cwd', self.tmp)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(name, result.stderr)
                self.assertIn('保留名', result.stderr)
                self.assertIn('冲突', result.stderr)
                self.assertFalse((self.run_dir / 'run.json').exists())
                self.assertEqual((self.run_dir / 'summary.md').read_text(encoding='utf-8'), original)
                self.assertEqual(self.calls(), [])

    def test_reserved_prefixes_are_valid_card_names(self):
        for name in ('runner', 'baseline-check', 'metrics-review', 'summary_notes'):
            self.card(name)
        self.assertEqual(len(runner.Run(self.run_dir).cards()), 4)

    def test_dependency_cycles_report_the_loop_before_dispatch(self):
        for index, bodies in enumerate(({'a': '依赖：b', 'b': '依赖：a'},
                                        {'a': '依赖：b', 'b': '依赖：c', 'c': '依赖：a'})):
            with self.subTest(bodies=bodies):
                self.run_dir = self.tmp / f'cycle-{index}'
                (self.run_dir / 'cards').mkdir(parents=True)
                for name, body in bodies.items():
                    self.card(name, body)
                result = self.worker('run', self.run_dir, '--cwd', self.tmp)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('依赖循环', result.stderr)
                self.assertIn(' -> '.join([*bodies, 'a']), result.stderr)
                self.assertFalse((self.run_dir / 'run.json').exists())
                self.assertEqual(self.calls(), [])

    def test_shared_dependency_is_not_a_cycle(self):
        for name, body in {'a': '任务', 'b': '依赖：a', 'c': '依赖：a', 'd': '依赖：b, c'}.items():
            self.card(name, body)
        self.assertEqual(len(runner.Run(self.run_dir).cards()), 4)

    def test_busy_lock_leaves_acceptance_unchanged_even_with_hold(self):
        self.card('a')
        self.go()
        before = (self.run_dir / 'a.json').read_bytes()
        with (self.run_dir / '.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for flags in ((), ('--hold',)):
                with self.subTest(flags=flags):
                    result = self.worker('accept', self.run_dir, 'a', '--note', '已抽查', *flags)
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn('正在派单', result.stderr)
                    self.assertEqual((self.run_dir / 'a.json').read_bytes(), before)
        self.ok('accept', self.run_dir, 'a', '--note', '已抽查')

    def test_concurrent_accept_can_retry_without_stranding_downstream(self):
        for name, body in {'a': '任务', 'b': '任务', 'c': '依赖：a', 'd': '依赖：b'}.items():
            self.card(name, body)
        self.go()
        before = (self.run_dir / 'b.json').read_bytes()
        # 假 MCP 预检提供明确的持锁信号，不靠两条命令恰巧同时启动。
        gate = self.tmp / 'gate'
        self.fake.write_text(FAKE_CODEX.replace("if 'mcp' in args:", """\
if 'mcp' in args and os.environ.get('FAKE_MCP_GATE'):
    gate = os.environ['FAKE_MCP_GATE']
    open(gate + '.entered', 'w').close()
    deadline = time.monotonic() + 15
    while not os.path.exists(gate + '.release'):
        if time.monotonic() >= deadline:
            sys.exit('假预检等不到放行')
        time.sleep(0.02)
if 'mcp' in args:"""), encoding='utf-8')
        first = subprocess.Popen([sys.executable, str(WORKER), 'accept', str(self.run_dir),
                                  'a', '--note', '已抽查'],
                                 env={**self.env, 'FAKE_MCP_GATE': str(gate)},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            while not gate.with_suffix('.entered').exists():
                self.assertIsNone(first.poll(), '首张验收未进入派发预检')
                self.assertLess(time.monotonic(), deadline, '首张验收未进入派发预检')
                time.sleep(0.02)
            second = self.worker('accept', self.run_dir, 'b', '--note', '已抽查')
            self.assertEqual(second.returncode, 2, second.stdout + second.stderr)
            self.assertEqual((self.run_dir / 'b.json').read_bytes(), before)
            self.assertFalse((self.run_dir / 'd.json').exists())
        finally:
            gate.with_suffix('.release').touch()
            stdout, stderr = first.communicate(timeout=30)
            self.finish()
        self.assertEqual(first.returncode, 0, stdout + stderr)
        self.assertEqual(json.loads(stdout)['dispatched'], ['c'])
        retried = json.loads(self.ok('accept', self.run_dir, 'b', '--note', '已抽查').stdout)
        self.assertEqual(retried['dispatched'], ['d'])
        self.finish()
        outputs = [Path(call['args'][call['args'].index('-o') + 1]).stem for call in self.calls()]
        self.assertCountEqual(outputs, ['a', 'b', 'c', 'd'])

    def assert_deadline(self, name, seconds):
        receipt = self.read(name)
        prompt = Path(receipt['prompt']).read_text(encoding='utf-8')
        match = re.search(r'本机绝对截止时间：([^\s（]+)', prompt)
        self.assertIsNotNone(match, prompt)
        deadline = dt.datetime.fromisoformat(match.group(1))
        started = dt.datetime.fromisoformat(receipt['started_at'])
        self.assertIsNotNone(deadline.utcoffset())
        self.assertEqual(deadline.utcoffset(), started.utcoffset())
        self.assertEqual((deadline - started).total_seconds(), seconds)
        self.assertIn('接近截止时先交已有结论', prompt)
        self.assertIn('哪部分没做完', prompt)
        self.assertIn('不要等到被强制结束', prompt)
        self.assertIn('以此为准', prompt)
        self.assertEqual(self.calls()[-1]['prompt'], prompt)

    def test_deadline_is_in_read_write_and_resumed_prompts(self):
        for write in (False, True):
            with self.subTest(write=write):
                self.run_dir = self.tmp / f'deadline-{write}'
                (self.run_dir / 'cards').mkdir(parents=True)
                self.card('a', '可写：result.txt\n任务时限由卡片另行描述')
                flags = ('--write',) if write else ()
                self.go(*flags, '--minutes', '2.5')
                self.assert_deadline('a', 150)
                first_prompt = Path(self.read('a')['prompt']).read_text(encoding='utf-8')
                self.ok('reject', self.run_dir, 'a', '--note', '补充依据')
                self.go(*flags, '--retry', 'a', '--minutes', '0.2')
                self.assertIn('resume', self.calls()[-1]['args'])
                self.assert_deadline('a', 12)
                self.assertNotEqual(Path(self.read('a')['prompt']).read_text(encoding='utf-8'), first_prompt)

    def test_auto_dispatched_card_gets_its_own_deadline(self):
        self.card('a')
        self.card('b', '依赖：a')
        self.go('--minutes', '0.2')
        self.ok('accept', self.run_dir, 'a', '--note', '已抽查')
        self.finish()
        self.assert_deadline('b', 12)

    def test_read_only_accept_warns_on_zero_sources_without_blocking(self):
        self.card('a')
        self.card('b', '依赖：a')
        self.go()
        result = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '已看过').stdout)
        self.finish()
        self.assertEqual(result['verdict'], 'accepted')
        self.assertEqual(result['dispatched'], ['b'])
        self.assertIn('没有可核对的出处', ' '.join(result.get('source_warnings', [])))
        self.assertEqual(self.read('a')['review']['source_warnings'], result['source_warnings'])

    def test_read_only_accept_warns_on_explicit_no_source_even_with_a_citation(self):
        source = self.tmp / 'source.txt'
        source.write_text('依据\n', encoding='utf-8')
        self.env['FAKE_REPLY'] = f'依据：{source}:1\n另一结论：无来源'
        self.card('a')
        self.go()
        result = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '已看过', '--hold').stdout)
        self.assertEqual(result['citations'], 1)
        self.assertIn('无来源', ' '.join(result.get('source_warnings', [])))
        self.assertNotIn('没有可核对的出处', ' '.join(result['source_warnings']))

    def test_valid_sources_and_write_runs_do_not_raise_source_warnings(self):
        source = self.tmp / 'source.txt'
        source.write_text('依据\n', encoding='utf-8')
        self.env['FAKE_REPLY'] = f'依据：{source}:1'
        self.card('a')
        self.go()
        result = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '已看过').stdout)
        self.assertEqual(result.get('source_warnings', []), [])
        self.run_dir = self.tmp / 'write-run'
        (self.run_dir / 'cards').mkdir(parents=True)
        self.card('a', '可写：result.txt')
        self.env['FAKE_REPLY'] = '无来源'
        self.go('--write')
        result = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '已看过').stdout)
        self.assertEqual(result.get('source_warnings', []), [])

    def test_forced_bad_citation_still_warns_that_no_source_is_verifiable(self):
        self.env['FAKE_REPLY'] = f'{self.tmp / "missing.txt"}:1'
        self.card('a')
        self.go()
        blocked = self.worker('accept', self.run_dir, 'a', '--note', '已看过')
        self.assertEqual(blocked.returncode, 2)
        self.assertNotIn('review', self.read('a'))
        forced = json.loads(self.ok('accept', self.run_dir, 'a', '--note', '仍接受', '--force').stdout)
        self.assertIn('没有可核对的出处', ' '.join(forced.get('source_warnings', [])))

    def test_receipt_start_and_end_keep_milliseconds(self):
        self.card('a')
        self.go()
        receipt = self.read('a')
        for key in ('started_at', 'ended_at'):
            with self.subTest(key=key):
                self.assertRegex(receipt[key], r'T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$')
        self.assertGreaterEqual(dt.datetime.fromisoformat(receipt['ended_at']),
                                dt.datetime.fromisoformat(receipt['started_at']))

    def test_millisecond_end_includes_usage_in_the_final_second(self):
        instant = dt.datetime(2030, 1, 1, 12, 0, 10, 987654, tzinfo=dt.timezone.utc)

        class FixedDatetime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return instant

        with patch.object(runner.dt, 'datetime', FixedDatetime):
            ended_at = runner.now()
        self.assertEqual(dt.datetime.fromisoformat(ended_at).microsecond, 987000)
        records = [{'type': 'token_usage_record',
                    'timestamp': (instant - dt.timedelta(milliseconds=100)).isoformat(),
                    'payload': {'response_id': 'fixture-response', 'usage': {'total_tokens': 7}}}]
        usage, count = stats.usage(records, None, instant.timestamp() - 1, stats.timestamp(ended_at))
        self.assertEqual(count, 1)
        self.assertEqual(usage['total_tokens'], 7)

    def test_legacy_second_receipts_remain_readable(self):
        self.card('a')
        started = dt.datetime.now().astimezone().replace(microsecond=0)
        receipt = {'card': str(self.run_dir / 'cards' / 'a.md'), 'state': 'running', 'pid': 0,
                   'started_at': started.isoformat(timespec='seconds')}
        runner.write_json(self.run_dir / 'a.json', receipt)
        run = runner.Run(self.run_dir)
        self.assertEqual(run.state('a', run.cards()), 'running')
        receipt.update(state='finished', ended_at=(started + dt.timedelta(seconds=2)).isoformat(timespec='seconds'))
        runner.write_json(self.run_dir / 'a.json', receipt)
        self.assertEqual(run.state('a', run.cards()), 'delivered')
        attempts = stats.attempt_list(self.run_dir, stats.card_list(self.run_dir), started.timestamp())
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]['seconds'], 2)


if __name__ == '__main__':
    unittest.main()
