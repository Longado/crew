import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import intake

ROOT = Path(__file__).resolve().parents[2]

class DemoTest(unittest.TestCase):
    def test_offline_symlink_demo_review_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve() / "空 格'副本"
            root.mkdir()
            for name in ('bin', 'scripts/intake', 'examples/intake'):
                shutil.copytree(ROOT / name, root / name)
            path = root / 'path'; path.mkdir()
            for name in ('bash', 'dirname', 'readlink'):
                (path / name).symlink_to(shutil.which(name))
            (path / 'python3').symlink_to(sys.executable)
            alias = root / '别 名'; alias.mkdir()
            (alias / 'relative').symlink_to('../bin/crew')
            (alias / 'entry').symlink_to(alias / 'relative')
            (alias / 'corpus').symlink_to('../bin/corpus')
            env = {**os.environ, 'PATH': str(path), 'CREW_CLAUDE_BIN': 'forbidden'}
            corpus = subprocess.run([str(alias / 'corpus'), 'intake', 'demo', '--output', str(root / 'corpus-output'), '--json'], env=env, capture_output=True, text=True)
            self.assertEqual(corpus.returncode, 0, corpus.stderr)
            self.assertEqual(json.loads(corpus.stdout)['mode'], 'demo')
            source = root / 'examples/intake/meeting.md'
            before = source.read_bytes()
            output = root / '输出'
            def run(*args):
                p = subprocess.run([str(alias / 'entry'), 'intake', *map(str, args)], env=env, capture_output=True, text=True)
                self.assertEqual(p.returncode, 0, p.stderr)
                return p.stdout
            result = json.loads(run('demo', '--output', output, '--json'))
            self.assertEqual(result['mode'], 'demo')
            self.assertEqual(result['model_calls'], 0)
            self.assertEqual(result['preset_calls'], 2)
            card = Path(result['cards'][0]['json'])
            md = Path(result['cards'][0]['markdown']).read_text()
            self.assertTrue(md.startswith('# 合成访谈'))
            self.assertLess(md.index('A1'), md.index('## 材料里的事项'))
            self.assertLess(md.index('## 与当前项目的关系'), md.index('A1'))
            self.assertIn('合成演示，使用预设分析，不调用模型', md)
            current = json.loads(run('review', card, '--json'))
            self.assertEqual([a['decision'] for a in current['actions']], ['pending', 'pending'])
            run('review', card, '--action', 'A1', '--decision', 'accept')
            again = json.loads(run('demo', '--output', output, '--json'))
            self.assertEqual(again['cards'][0]['json'], str(card))
            self.assertEqual(again['model_calls'], 0)
            self.assertEqual(again['preset_calls'], 0)
            self.assertEqual(json.loads(run('review', card, '--json'))['actions'][0]['decision'], 'accept')
            exported = json.loads(run('export', card, '--format', 'json'))
            self.assertEqual(exported['mode'], 'demo')
            self.assertEqual(len(exported['actions']), 1)
            self.assertIn('合成演示', run('export', card))
            human = run('demo', '--output', output)
            self.assertIn('合成演示，使用预设分析，不调用模型', human)
            self.assertIn('accept', human)
            self.assertIn('A1 [已采纳]', human)
            self.assertIn('A2 [待决定]', human)
            self.assertNotIn('预设建议经过', human)
            for decision, label in [('defer', '暂缓'), ('dismiss', '不相关'), ('accept', '已采纳')]:
                shown = run('review', card, '--action', 'A1', '--decision', decision)
                self.assertIn('A1 [' + label + ']', shown)
            self.assertIn('review', human)
            for line in human.splitlines():
                if line.startswith(('查看当前决定：', '采纳 A1：', '导出已采纳建议：')):
                    copied = subprocess.run([str(path / 'bash'), '-c', line.split('：', 1)[1]], env=env, capture_output=True, text=True)
                    self.assertEqual(copied.returncode, 0, copied.stderr)
            self.assertEqual(source.read_bytes(), before)
            self.assertFalse((root / 'node_modules').exists())
            (path / 'python3').unlink()
            missing = subprocess.run([str(alias / 'entry'), 'intake', '--help'], env=env, capture_output=True, text=True)
            self.assertEqual(missing.returncode, 127)
            self.assertIn('需要 python3', missing.stderr)

    def test_default_demo_output_uses_home_without_changing_environment(self):
        import demo
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            captured = io.StringIO()
            with mock.patch.object(Path, 'home', return_value=home), redirect_stdout(captured):
                self.assertEqual(demo.main(['--json']), 0)
            result = json.loads(captured.getvalue())
            self.assertTrue(result['report'].startswith(str(home / '.local-sensitive/crew-intake-demo')))
            self.assertEqual(result['model_calls'], 0)

    def test_demo_namespace_does_not_reuse_real_cache(self):
        import demo
        with tempfile.TemporaryDirectory() as temp:
            options = dict(workspace=ROOT / 'examples/intake', catalog=ROOT / 'examples/intake/projects.json', output=Path(temp).resolve() / 'out')
            source = ROOT / 'examples/intake/meeting.md'
            first = intake.process([source], **options, model=demo.preset, demo=True)
            self.assertEqual(first['failed'], 0)
            calls = []
            payloads = {}
            def spy(stage, payload):
                calls.append(stage)
                payloads[stage] = payload
                return demo.preset(stage, payload)
            real = intake.process([source], **options, model=spy)
            self.assertEqual(real['failed'], 0)
            self.assertEqual(calls, ['analyze', 'relate'])
            caches = list((Path(temp).resolve() / 'out/cache').glob('*.json'))
            self.assertEqual(len(caches), 2)
            for stage, payload in payloads.items():
                key = intake.digest({'version': intake.VERSION, 'prompt': intake.ANALYZE if stage == 'analyze' else intake.RELATE, 'stage': stage, 'payload': payload})
                self.assertTrue((Path(temp).resolve() / 'out/cache' / f'{stage}-{key}.json').exists())
            with self.assertRaisesRegex(ValueError, 'model|替身'):
                intake.process([source], **options, demo=True)

if __name__ == '__main__': unittest.main()
