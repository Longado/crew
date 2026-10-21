"""派发测试不得写入默认登记。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class FixtureIsolationTest(unittest.TestCase):
    def test_dispatch_fixture_preserves_default_registry(self):
        with tempfile.TemporaryDirectory(prefix='lead-isolation-') as directory:
            home = Path(directory)
            registry = home / '.crew' / 'lead-runs.jsonl'
            registry.parent.mkdir()
            original = b'{"sentinel": true}\n'
            registry.write_bytes(original)
            env = dict(os.environ, HOME=str(home))
            env.pop('CREW_HOME', None)
            script = '''
import json, os, unittest
from test_worker import WorkerTest
class Probe(WorkerTest):
    def test_probe(self):
        self.test_independent_cards_run_lean_and_read_only_in_one_wave()
        self.assertTrue(self.calls(), '必须实际调用假执行者')
        self.assertEqual(os.environ.get('CREW_HOME'), self.env.get('CREW_HOME'))
        self.assertTrue(os.environ.get('CREW_HOME'), '夹具必须隔离同进程环境')
        print(json.dumps({'calls': len(self.calls())}))
result = unittest.TextTestRunner().run(unittest.TestSuite([Probe('test_probe')]))
raise SystemExit(not result.wasSuccessful())
'''
            result = subprocess.run([sys.executable, '-B', '-c', script],
                                    cwd=Path(__file__).parent, env=env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(registry.read_bytes(), original, result.stdout + result.stderr)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertGreater(json.loads(result.stdout.splitlines()[-1])['calls'], 0)


if __name__ == '__main__':
    unittest.main()
