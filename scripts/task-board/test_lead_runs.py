"""负责人运行接口走真实随机端口，数据全在临时目录。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'lead'))
spec = importlib.util.spec_from_file_location('board_server', HERE / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class LeadRunsHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        deny = self.root / 'deny-codex'
        deny.write_text('#!/bin/sh\nexit 99\n')
        deny.chmod(0o755)
        env = patch.dict(os.environ, CREW_HOME=str(self.root / 'crew-home'), CREW_CODEX_BIN=str(deny))
        env.start()
        self.addCleanup(env.stop)
        # 不建任务库；负责人接口不应调用原任务列表或派发路径。
        self.runner = SimpleNamespace(jobs=[])
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.handler(self.runner, HERE.parents[1] / 'web'))
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.url = 'http://127.0.0.1:' + str(self.http.server_port)

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)

    def get(self, path):
        try:
            with urllib.request.urlopen(self.url + path, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_empty_endpoint_and_unknown_post_are_read_only(self):
        code, body = self.get('/api/lead-runs')
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body), {'runs': []})
        self.assertFalse((self.root / 'crew-home').exists())
        for path in ('/api/lead-runs', '/api/lead-runs/dispatch', '/api/lead-runs/accept', '/api/lead-runs/stop'):
            request = urllib.request.Request(self.url + path, data=b'{}', headers={'x-corpus': '1'})
            with self.assertRaises(urllib.error.HTTPError) as result:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(result.exception.code, 404)

    def test_endpoint_matches_shared_reader_and_preserves_receipts(self):
        path = HERE.parent / 'lead/runs_registry.py'
        self.assertTrue(path.is_file(), '缺少共享读取模块')
        import runs_registry
        run = self.root / 'run'
        (run / 'cards').mkdir(parents=True)
        (run / 'cards/a.md').write_text('任务')
        (run / 'a.out').write_text('## 结论卡\n本地交付已返回。')
        (run / 'a.json').write_text(json.dumps({'state': 'finished', 'seconds': 12, 'tokens': 35,
                                               'output': str(run / 'a.out')}))
        runs_registry.register(run, '只读看板')
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        code, body = self.get('/api/lead-runs')
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)['runs'], runs_registry.read_runs())
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_board_mounts_read_only_section_and_assets(self):
        code, body = self.get('/')
        self.assertEqual(code, 200, body)
        self.assertIn('负责人运行', body.decode())
        self.assertIn(b'/lead-runs.js', body)
        for path in ('/lead-runs.js', '/lead-runs.css'):
            self.assertEqual(self.get(path)[0], 200)
        self.assertEqual(self.get('/lead-runs/../server.py')[0], 404)

    def test_nonlocal_host_cannot_read_registry(self):
        request = urllib.request.Request(self.url + '/api/lead-runs', headers={'Host': 'example.com'})
        with self.assertRaises(urllib.error.HTTPError) as result:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(result.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
