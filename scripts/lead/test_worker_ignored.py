"""写卡对账：测试、构建生成在 git 忽略目录里的产物单列，不算越界。假 Codex 代替执行者。"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_worker_write as fixtures  # noqa: E402


class IgnoredOutputTest(unittest.TestCase):
    # 只借写卡测试的夹具，不继承它的用例。
    setUp, worker, go = fixtures.WriteRunTest.setUp, fixtures.WriteRunTest.worker, fixtures.WriteRunTest.go

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.work), *args], check=True, capture_output=True)

    def test_git_ignored_build_output_is_listed_apart_not_out_of_bounds(self):
        (self.work / '.gitignore').write_text('dist/\nruns/\n')
        self.git('init', '-q')
        self.git('add', '.')
        self.go('--write')
        (self.work / 'dist' / 'App.app').mkdir(parents=True)
        (self.work / 'dist' / 'App.app' / 'Info.plist').write_text('built by a test\n')
        (self.work / 'shared.js').write_text('touched by someone\n')
        r = self.worker('changes', str(self.run_dir))
        out = json.loads(r.stdout)
        self.assertEqual(out['ignored'], ['dist/App.app/Info.plist'])
        self.assertEqual(out['out_of_bounds'], ['shared.js'])  # 被跟踪的文件照旧算越界
        self.assertEqual(r.returncode, 1, r.stderr)

    def test_without_git_nothing_is_exempt(self):
        self.go('--write')
        (self.work / 'dist').mkdir()
        (self.work / 'dist' / 'out.txt').write_text('x\n')
        r = self.worker('changes', str(self.run_dir))
        out = json.loads(r.stdout)
        self.assertEqual(out['ignored'], [])
        self.assertEqual(out['out_of_bounds'], ['dist/out.txt'])


if __name__ == '__main__':
    unittest.main()
