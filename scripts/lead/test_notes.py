"""改进记录与索引：只用临时目录和构造数据，不调用模型。"""
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
import select
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

NOTES = Path(__file__).resolve().with_name('notes.py')


class NotesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.base = self.root / 'private'
        self.env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}

    def cli(self, action, *args):
        return subprocess.run([sys.executable, str(NOTES), action, '--dir', str(self.base), *args],
                              capture_output=True, text=True, env=self.env, timeout=60)

    def module(self):
        self.assertTrue(NOTES.is_file(), '缺少 notes.py 实现')
        spec = importlib.util.spec_from_file_location('lead_notes', NOTES)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def local_cli(self, notes, args):
        output, error = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            code = notes.main(args)
        return code, output.getvalue(), error.getvalue()

    def record(self, name='a', **changes):
        fields = {'ID': name, '日期': '2026-01-02', '记录者': '测试执行者', '主题': '审阅',
                  '状态': '建议', '来源': '构造记录', '关联': '无'}
        fields.update(changes)
        text = f'# {name}\n' + ''.join(f'{k}: {v}\n' for k, v in fields.items() if v is not None)
        text += '\n## 观察与依据\n构造观察\n## 改进\n构造改法\n## 效果与下一步\n待验证\n'
        path = self.base / 'notes' / f'{name}.md'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def test_new_has_all_fields_and_rebuilds_index(self):
        result = self.cli('new', '--agent', '测试 / 执行者', '--topic', 'review', '--title', '审阅 | 变化',
                          '--theme', '审阅', '--relates', 'previous-note')
        self.assertEqual(result.returncode, 0, result.stderr)
        paths = list((self.base / 'notes').glob('*.md'))
        self.assertEqual(len(paths), 1)
        self.assertRegex(paths[0].name, r'^\d{4}-\d{2}-\d{2}-\d{6}-测试-执行者-review\.md$')
        content = paths[0].read_text(encoding='utf-8')
        for field in ('ID', '日期', '记录者', '主题', '状态', '来源', '关联'):
            self.assertRegex(content, rf'(?m)^{field}: \S.+$')
        for line in ('# 审阅 | 变化', '记录者: 测试 / 执行者', '状态: 建议', '主题: 审阅', '关联: previous-note',
                     '## 观察与依据', '## 改进', '## 效果与下一步'):
            self.assertIn(line, content)
        index = (self.base / 'LOG.md').read_bytes()
        self.assertIn(f'[审阅 \\| 变化](notes/{paths[0].name})'.encode(), index)
        self.assertEqual(self.cli('index').returncode, 0)
        self.assertEqual((self.base / 'LOG.md').read_bytes(), index)

    def test_same_filename_is_exclusive_but_later_note_has_unique_id(self):
        notes = self.module()
        args = ['new', '--dir', str(self.base), '--agent', 'tester', '--topic', 'review', '--title', '复核']
        first_time, later_time = dt.datetime(2026, 1, 2, 3, 4, 5), dt.datetime(2026, 1, 2, 3, 4, 6)
        with patch.object(notes.dt, 'datetime') as clock:
            clock.now.return_value = first_time
            self.assertEqual(self.local_cli(notes, args)[0], 0)
            path = self.base / 'notes' / '2026-01-02-030405-tester-review.md'
            original, index = path.read_bytes(), (self.base / 'LOG.md').read_bytes()
            code, _, error = self.local_cli(notes, args)
            self.assertEqual(code, 2)
            self.assertIn('记录已存在，不覆盖', error)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual((self.base / 'LOG.md').read_bytes(), index)
            clock.now.return_value = later_time
            self.assertEqual(self.local_cli(notes, args)[0], 0)
        self.assertEqual(len(list((self.base / 'notes').glob('*.md'))), 2)
        self.assertEqual(self.cli('index').returncode, 0)
        self.assertIn('主题: 其他', original.decode())
        self.assertIn('关联: 无', original.decode())

    def test_index_rejects_missing_blank_and_invalid_fields_without_replacing_log(self):
        cases = [({key: None}, '缺少字段') for key in ('ID', '日期', '记录者', '主题', '状态', '来源', '关联')]
        for changes, message in cases + [({'主题': '  '}, '缺少字段'), ({'状态': '完成'}, '状态不合法')]:
            with self.subTest(changes=changes):
                self.record(**changes)
                target = self.base / 'LOG.md'
                target.write_text('原索引\n', encoding='utf-8')
                result = self.cli('index')
                self.assertEqual(result.returncode, 2)
                self.assertIn(message, result.stderr)
                self.assertEqual(target.read_text(encoding='utf-8'), '原索引\n')
                self.assertEqual(list(self.base.glob('.index-*')), [])

    def test_index_rejects_duplicate_ids(self):
        self.record('a', ID='same')
        self.record('b', ID='same')
        result = self.cli('index')
        self.assertEqual(result.returncode, 2)
        self.assertIn('重复ID', result.stderr)
        self.assertFalse((self.base / 'LOG.md').exists())

    def test_index_accepts_all_five_states(self):
        for number, state in enumerate(('建议', '已采用待验证', '已验证', '未采用', '已撤回')):
            self.record(str(number), 状态=state)
        result = self.cli('index')
        self.assertEqual(result.returncode, 0, result.stderr)
        index = (self.base / 'LOG.md').read_text(encoding='utf-8')
        self.assertEqual(index.count('](notes/'), 5)
        self.assertLess(index.index('notes/4.md'), index.index('notes/0.md'))

    def test_new_prefills_run_source_without_parsing_metrics(self):
        run = self.root / 'fixture run'
        (run / 'cards').mkdir(parents=True)
        (run / 'run.json').write_text(json.dumps({'goal': '比较流程\n记录结果',
                                                 'created_at': '2026-01-02T03:04:05+08:00'}), encoding='utf-8')
        for name, verdict in (('t1', 'accepted'), ('t2', 'rejected'), ('t3', None), ('t4', None)):
            (run / 'cards' / f'{name}.md').write_text('# 构造卡\n', encoding='utf-8')
            if name == 't4':
                continue
            receipt = {'state': 'finished', 'session_id': f'fake-session-{name}'}
            if verdict:
                receipt['review'] = {'verdict': verdict, 'note': f'{name} 构造说明\n下一行'}
            (run / f'{name}.json').write_text(json.dumps(receipt), encoding='utf-8')
        (run / 'metrics.json').write_text('故意不是 JSON，不能解析指标字段', encoding='utf-8')
        result = self.cli('new', '--agent', 'tester', '--topic', 'run-review', '--title', '运行观察', '--run', str(run))
        self.assertEqual(result.returncode, 0, result.stderr)
        content = next((self.base / 'notes').glob('*.md')).read_text(encoding='utf-8')
        source = next(line for line in content.splitlines() if line.startswith('来源: '))
        for value in (str(run), '比较流程 记录结果', '2026-01-02T03:04:05+08:00', 'accepted', 'rejected',
                      't1 构造说明 下一行', 'fake-session-t1', 'fake-session-t2', 'fake-session-t3',
                      '卡名: t3；会话 ID: fake-session-t3；验收: 未验收',
                      '卡名: t4；会话 ID: 未记录；验收: 未验收', str(run / 'metrics.json')):
            self.assertIn(value, source)
        self.assertNotIn('故意不是 JSON', content)

    def test_bad_run_or_path_arguments_do_not_create_a_record(self):
        for extra in (['--run', str(self.root / 'missing')], ['--topic', '../escape'], ['--title', '标题\n状态: 已验证']):
            with self.subTest(extra=extra):
                result = self.cli('new', '--agent', 'tester', '--topic', 'review', '--title', '复核', *extra)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(list((self.base / 'notes').glob('*.md')), [])

    def test_failed_atomic_replace_preserves_old_index_and_cleans_temp(self):
        notes = self.module()
        self.record()
        target = self.base / 'LOG.md'
        target.write_text('原索引\n', encoding='utf-8')
        with patch.object(notes.os, 'replace', side_effect=OSError('构造替换失败')):
            code, _, error = self.local_cli(notes, ['index', '--dir', str(self.base)])
            self.assertEqual(code, 2)
            self.assertIn('构造替换失败', error)
        self.assertEqual(target.read_text(encoding='utf-8'), '原索引\n')
        self.assertEqual(list(self.base.glob('.index-*')), [])

    def test_new_reports_retained_note_when_existing_record_blocks_index(self):
        self.record('broken', 来源=None)
        target = self.base / 'LOG.md'
        target.write_text('原索引\n', encoding='utf-8')
        result = self.cli('new', '--agent', 'tester', '--topic', 'review', '--title', '复核')
        self.assertEqual(result.returncode, 2)
        self.assertIn('索引未更新', result.stderr)
        created = [p for p in (self.base / 'notes').glob('*.md') if p.stem != 'broken']
        self.assertEqual(len(created), 1)
        self.assertIn(str(created[0]), result.stderr)
        self.assertIn('状态: 建议', created[0].read_text(encoding='utf-8'))
        self.assertEqual(target.read_text(encoding='utf-8'), '原索引\n')

    def test_two_index_processes_serialize_and_keep_latest_records(self):
        self.assertTrue(NOTES.is_file(), '缺少 notes.py 实现')
        self.record('a')
        target = self.base / 'LOG.md'
        target.write_text('原索引\n', encoding='utf-8')
        # 第一进程停在原子替换前，第二进程必须等锁，之后读到新增记录。
        script = '''import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import notes
replace = notes.os.replace
def pause(source, target):
    print('staged', flush=True)
    sys.stdin.readline()
    replace(source, target)
notes.os.replace = pause
notes.build(Path(sys.argv[2]))
'''
        first = subprocess.Popen([sys.executable, '-c', script, str(NOTES.parent), str(self.base)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=self.env)
        second = None
        try:
            self.assertTrue(select.select([first.stdout], [], [], 5)[0], '第一进程未生成临时索引')
            self.assertEqual(first.stdout.readline().strip(), 'staged')
            self.assertEqual(target.read_text(encoding='utf-8'), '原索引\n')
            with (self.base / '.index.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.record('b')
            second = subprocess.Popen([sys.executable, str(NOTES), 'index', '--dir', str(self.base)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
            with self.assertRaises(subprocess.TimeoutExpired):
                second.communicate(timeout=0.2)
            _, error = first.communicate('\n', timeout=30)
            self.assertEqual(first.returncode, 0, error)
            _, error = second.communicate(timeout=30)
            self.assertEqual(second.returncode, 0, error)
            index = target.read_text(encoding='utf-8')
            self.assertIn('](notes/a.md)', index)
            self.assertIn('](notes/b.md)', index)
            self.assertEqual(index.count('](notes/'), 2)
            self.assertEqual(list(self.base.glob('.index-*')), [])
        finally:
            for process in (first, second):
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=30)


if __name__ == '__main__':
    unittest.main()
