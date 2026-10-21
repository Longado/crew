"""通过真实 worker CLI 检查 stats/note 接线；只用临时数据，不调用模型。"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().with_name('worker.py')


class WorkerCliTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        from unittest.mock import patch
        registry_environment = patch.dict(os.environ, CREW_HOME=str(self.tmp / 'crew-home'))
        registry_environment.start()
        self.addCleanup(registry_environment.stop)
        self.env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                    'CREW_CODEX_BIN': str(self.tmp / 'no-model-execution')}
        self.run_dir = self.tmp / 'sample run'
        (self.run_dir / 'cards').mkdir(parents=True)
        (self.run_dir / 'cards' / 'draft.md').write_text('核对样本材料\n', encoding='utf-8')
        self.write_json(self.run_dir / 'run.json', {
            'created_at': '2025-01-01T00:00:00Z', 'goal': '样本运行目标'})
        self.write_json(self.run_dir / 'draft.json', {
            'state': 'finished', 'started_at': '2025-01-01T00:00:01Z',
            'ended_at': '2025-01-01T00:00:05Z', 'tokens': 12,
            'review': {'verdict': 'accepted', 'at': '2025-01-01T00:00:07Z',
                       'note': '已核对样本来源'}})

    def write_json(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')

    def worker(self, *args):
        return subprocess.run([sys.executable, str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def ok(self, *args):
        result = self.worker(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def fingerprints(self, directory):
        return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in directory.rglob('*') if p.is_file()}

    def test_stats_crew_output_directory_leaves_input_unchanged(self):
        before = self.fingerprints(self.run_dir)
        out = self.tmp / 'stats output'
        result = self.ok('stats', self.run_dir, '--out-dir', out)
        self.assertIn(str(out / 'summary.md'), result.stdout)
        metrics = json.loads((out / 'metrics.json').read_text())
        self.assertEqual(metrics['receipt_tokens'], 12)
        self.assertEqual(metrics['wall_seconds'], 7)
        self.assertIn('等验收', (out / 'summary.md').read_text())
        self.assertEqual(before, self.fingerprints(self.run_dir))

    def test_stats_defaults_to_run_directory(self):
        self.ok('stats', self.run_dir)
        self.assertTrue((self.run_dir / 'metrics.json').is_file())
        self.assertTrue((self.run_dir / 'summary.md').is_file())

    def test_stats_native_mode_forwards_all_options(self):
        manifest = self.tmp / 'threads.json'
        self.write_json(manifest, [])
        log = self.tmp / 'root log.jsonl'
        self.write_json(log, {'type': 'event_msg', 'timestamp': '2025-01-01T00:00:10Z',
                             'payload': {'type': 'task_complete', 'turn_id': 'sample-turn'}})
        out = self.tmp / 'native output'
        self.ok('stats', '--manifest', manifest, '--root-log', log,
                '--turn-id', 'sample-turn', '--start', '2025-01-01T00:00:00Z', '--out-dir', out)
        metrics = json.loads((out / 'metrics.json').read_text())
        self.assertEqual(metrics['wall_seconds'], 10)
        self.assertEqual(metrics['peak_active_child_tasks'], 0)
        self.assertTrue((out / 'summary.md').is_file())

    def test_note_new_and_index_preserve_arguments(self):
        base = self.tmp / 'private notes'
        before = self.fingerprints(self.run_dir)
        self.ok('note', 'new', '--dir', base, '--agent', 'Sample / Codex',
                '--topic', 'review-wait', '--title', '验收等待 观察', '--theme', '审阅、收尾',
                '--relates', 'prior-sample-note', '--run', self.run_dir)
        records = list((base / 'notes').glob('*.md'))
        self.assertEqual(len(records), 1)
        record = records[0]
        content = record.read_text()
        for value in ('# 验收等待 观察', '记录者: Sample / Codex', '主题: 审阅、收尾',
                      '状态: 建议', '关联: prior-sample-note', '样本运行目标',
                      '卡名: draft', '验收: accepted', '已核对样本来源'):
            self.assertIn(value, content)
        self.assertIn(record.name, (base / 'LOG.md').read_text())
        record.write_text(content.replace('状态: 建议', '状态: 已采用待验证'), encoding='utf-8')
        self.ok('note', 'index', '--dir', base)
        self.assertIn('已采用待验证', (base / 'LOG.md').read_text())
        self.assertEqual(before, self.fingerprints(self.run_dir))

    def test_note_index_invalid_record_preserves_previous_index(self):
        base = self.tmp / 'notes'
        self.ok('note', 'new', '--dir', base, '--agent', 'Sample',
                '--topic', 'sample', '--title', '样本')
        index = (base / 'LOG.md').read_bytes()
        record = next((base / 'notes').glob('*.md'))
        record.write_text(record.read_text().replace('状态: 建议', '状态: 未知'), encoding='utf-8')
        result = self.worker('note', 'index', '--dir', base)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('状态不合法', result.stderr)
        self.assertEqual(index, (base / 'LOG.md').read_bytes())

    def test_module_help_is_available_through_worker(self):
        for args, option in ((('stats', '--help'), '--start'),
                             (('note', 'new', '--help'), '--relates'),
                             (('note', 'index', '--help'), '--dir')):
            with self.subTest(args=args):
                self.assertIn(option, self.ok(*args).stdout)
        help_text = self.ok('--help').stdout
        self.assertIn('stats', help_text)
        self.assertIn('note', help_text)

    def test_module_errors_return_two(self):
        for args, error in (
            (('stats',), '请提供运行目录'),
            (('stats', self.tmp / 'missing'), 'run.json'),
            (('stats', self.run_dir, '--unknown-option'), 'unrecognized arguments'),
            (('note', 'new'), '--dir'),
            (('note', 'new', '--dir', self.tmp / 'notes', '--agent', 'Sample',
              '--topic', '../invalid', '--title', '样本'), '英文短名'),
        ):
            with self.subTest(args=args):
                result = self.worker(*args)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(error, result.stderr)


if __name__ == '__main__':
    unittest.main()
