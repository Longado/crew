"""第三轮 A：依赖路径、异常隔离与统计；只用临时文件和假 Codex。"""
import errno
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import stats
import test_worker_mix as fixtures
import worker


class DependencyR3ATest(unittest.TestCase):
    setUp = fixtures.MixedRunTest.setUp
    card = fixtures.MixedRunTest.card
    cli = fixtures.MixedRunTest.cli
    ok = fixtures.MixedRunTest.ok
    go = fixtures.MixedRunTest.go
    read = fixtures.MixedRunTest.read
    rows = fixtures.MixedRunTest.rows

    def accepted(self, name, root=None, legacy=False, tokens=7):
        root = root or self.root
        self.card(name, '上游任务', root)
        output = root / f'{name}.out'
        output.write_text('交付正文', encoding='utf-8')
        frozen = root / f'{name}.accepted'
        frozen.write_bytes(output.read_bytes())
        digest = hashlib.sha256((root / 'cards' / f'{name}.md').read_bytes()).hexdigest()
        review = {'verdict': 'accepted', 'at': '2025-01-01T00:00:30+00:00'}
        receipt = {'card': str(root / 'cards' / f'{name}.md'), 'state': 'finished',
                   'started_at': '2025-01-01T00:00:10+00:00',
                   'ended_at': '2025-01-01T00:00:20+00:00', 'tokens': tokens,
                   'output': str(output), 'review': review}
        if not legacy:
            receipt['card_sha256'] = digest
            review.update(card_sha256=digest, accepted_output=str(frozen),
                          output_sha256=hashlib.sha256(output.read_bytes()).hexdigest())
        (root / f'{name}.json').write_text(json.dumps(receipt), encoding='utf-8')
        return frozen

    def summary(self):
        (self.root / 'run.json').write_text(json.dumps({'created_at': '2025-01-01T00:00:00+00:00'}))
        with patch.dict(os.environ, self.env):
            return stats.summarize_crew(self.root)

    def test_a1_quoted_paths_and_local_separators_dispatch_with_frozen_input(self):
        spaced = self.tmp / "upstream run，资料's"
        (spaced / 'cards').mkdir(parents=True)
        frozen = self.accepted('a', spaced)
        for name in ('t1', 't2', 't3', 't4'):
            self.accepted(name)
        for name, dep in (('relative', f'../{spaced.name}/a'), ('absolute', str(spaced / 'a'))):
            self.card(name, f'依赖：t1, t2，t3、t4 "{dep}"\n下游任务')
        self.card('free', '独立任务')
        result = self.go()
        self.assertEqual(set(result['dispatched']), {'relative', 'absolute', 'free'})
        for name in ('relative', 'absolute'):
            self.assertIn(str(frozen), (self.root / f'{name}.prompt').read_text())
            self.assertEqual(self.rows()[name]['deps'][:4], ['t1', 't2', 't3', 't4'])

    def test_a1_existing_unicode_whitespace_and_literal_names_still_parse(self):
        names = ['t1', 't2', 't3', "quote's", 'hash#name', r'back\name']
        for name in names:
            self.card(name, '任务')
        self.card('next', '依赖：t1\u3000t2\tt3、quote\'s，hash#name,back\\name\n下游任务')
        try:
            cards = worker.Run(self.root).cards()
        except ValueError as error:
            self.fail(f'已有分隔符或字面卡名失效：{error}')
        self.assertEqual(cards['next']['deps'], names)

    def check_external_oserror(self, stage):
        self.card('a', '外部卡', self.other)
        (self.other / 'a.json').write_text('{}')
        self.card('blocked', '依赖：../upstream/a\n等外部')
        self.card('free', '独立任务')
        run = worker.Run(self.root)
        targets = {'resolve': self.other / 'a', 'is_dir': self.other / 'cards',
                   'is_file': self.other / 'cards' / 'a.md', 'read_text': self.other / 'a.json'}
        original = getattr(Path, stage)

        def denied(path, *args, **kwargs):
            if Path(os.path.abspath(path)) == targets[stage]:
                raise PermissionError(errno.EACCES, '测试外部不可读', str(path))
            return original(path, *args, **kwargs)

        # 保留并回收本测试启动的看守句柄，避免后台 Popen 析构告警。
        processes = []
        popen = worker.subprocess.Popen

        def tracked(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process

        with patch.dict(os.environ, self.env), patch.object(Path, stage, denied), \
                patch.object(worker.subprocess, 'Popen', tracked):
            try:
                dispatched = run.run(self.work, 5, 'high', None, [])
                rows = {r['card']: r for r in run.status()['cards']}
            except OSError as error:
                self.fail(f'外部 {stage} 异常逃逸，阻断同批派发或状态：{error}')
            self.assertEqual(dispatched, ['free'])
            self.assertEqual(rows['blocked']['state'], 'waiting')
            self.assertIn('外部依赖暂不可读', rows['blocked']['waiting_reason'])
            self.assertIs(rows['blocked']['external_deps'][0]['accepted_valid'], False)
        self.ok('wait', self.root, '--minutes', '0.1')
        self.assertEqual(self.rows()['free']['state'], 'delivered')
        for process in processes:
            process.wait(timeout=10)

    def test_a2_resolve_oserror_is_isolated(self):
        self.check_external_oserror('resolve')

    def test_a2_directory_probe_oserror_is_isolated(self):
        self.check_external_oserror('is_dir')

    def test_a2_card_probe_oserror_is_isolated(self):
        self.check_external_oserror('is_file')

    def test_a2_receipt_read_oserror_is_isolated(self):
        self.check_external_oserror('read_text')

    def test_a2_overlong_external_path_keeps_cli_and_other_card_working(self):
        self.card('blocked', f'依赖：../{"x" * 300}/a\n等外部')
        self.card('free', '独立任务')
        self.assertEqual(self.go()['dispatched'], ['free'])
        row = self.rows()['blocked']
        self.assertEqual(row['state'], 'waiting')
        self.assertIn('外部依赖暂不可读', row['waiting_reason'])

    def test_a2_local_receipt_oserror_still_propagates(self):
        self.card('a', '本运行卡')
        run = worker.Run(self.root)
        cards = run.cards()
        with patch.object(worker, 'read_json', side_effect=PermissionError(errno.EACCES, '本运行不可读')):
            with self.assertRaises(PermissionError):
                run.dependency('a', cards)

    def assert_graph_error(self, text):
        for command in (('run', self.root, '--cwd', self.work), ('status', self.root)):
            result = self.cli(*command)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn(text, result.stderr)
        self.assertFalse((self.tmp / 'calls.jsonl').exists())

    def test_a3_relative_self_alias_is_rejected(self):
        self.card('a', '依赖：../current/a\n自依赖')
        self.assert_graph_error('依赖的 a 不在 cards/')

    def test_a3_absolute_missing_alias_is_rejected(self):
        self.card('a', f'依赖：{self.root}/missing\n缺本运行卡')
        self.assert_graph_error('依赖的 missing 不在 cards/')

    def test_a3_absolute_and_relative_alias_cycle_is_rejected(self):
        self.card('a', f'依赖：{self.root}/b\n任务 A')
        self.card('b', '依赖：../current/a\n任务 B')
        self.assert_graph_error('任务卡依赖循环')

    def test_a3_symlink_alias_normalizes_and_acceptance_advances_downstream(self):
        alias = self.tmp / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.card('a', '上游任务')
        self.card('b', f'依赖：{alias}/a\n下游任务')
        self.assertEqual(self.go()['dispatched'], ['a'])
        self.assertEqual(self.rows()['b']['deps'], ['a'])
        self.assertNotIn('external_deps', self.rows()['b'])
        self.assertEqual(self.ok('accept', self.root, 'a', '--note', '已读')['dispatched'], ['b'])
        self.ok('wait', self.root, '--minutes', '0.1')
        self.assertEqual(self.rows()['b']['state'], 'delivered')

    def test_a4_external_acceptance_matches_status_without_counting_external_usage(self):
        self.accepted('local', tokens=7)
        self.accepted('upstream', self.other, tokens=900)
        self.card('next', '依赖：local ../upstream/upstream\n下游任务')
        for stale in (False, True):
            with self.subTest(stale=stale):
                if stale:
                    (self.other / 'upstream.accepted').write_text('冻结稿被改动')
                metrics = self.summary()
                row = next(c for c in metrics['cards'] if c['card'] == 'next')
                self.assertEqual(row['state'], self.rows()['next']['state'])
                self.assertEqual(row['state'], 'waiting' if stale else 'ready')
                self.assertEqual([a['card'] for a in metrics['attempts']], ['local'])
                self.assertEqual(metrics['receipt_tokens'], 7)
                self.assertEqual(metrics['combined_usage']['total_tokens'], 0)
                self.assertIn('等依赖' if stale else '待派发', stats.render_crew(metrics))

    def test_a4_legacy_quoted_and_unreadable_external_dependencies_match_status(self):
        spaced = self.tmp / 'legacy run'
        (spaced / 'cards').mkdir(parents=True)
        self.accepted('old', spaced, legacy=True)
        self.card('legacy', '依赖："../legacy run/old"\n旧验收兼容')
        self.card('missing', '依赖：../absent/a\n等缺失目录')
        self.card('unreadable', f'依赖：../{"x" * 300}/a\n等不可读目录')
        metrics = self.summary()
        states = {c['card']: c['state'] for c in metrics['cards']}
        self.assertEqual(states, {'legacy': 'ready', 'missing': 'waiting', 'unreadable': 'waiting'})
        self.assertEqual(states, {n: row['state'] for n, row in self.rows().items()})
        self.assertEqual(metrics['attempts'], [])
        self.assertEqual(metrics['receipt_tokens'], 0)
        self.assertFalse((self.other / 'metrics.json').exists())
        self.assertFalse((spaced / 'metrics.json').exists())
        before = {p: p.read_bytes() for root in (self.root, spaced) for p in root.rglob('*') if p.is_file()}
        reports = self.tmp / 'reports'
        result = self.cli('stats', self.root, '--out-dir', reports)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((reports / 'metrics.json').read_text()), metrics)
        self.assertIn('待派发', (reports / 'summary.md').read_text())
        after = {p: p.read_bytes() for root in (self.root, spaced) for p in root.rglob('*') if p.is_file()}
        self.assertEqual(after, before)


if __name__ == '__main__':
    unittest.main()
