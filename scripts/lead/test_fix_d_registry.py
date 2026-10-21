"""登记坏字节不遮住完整运行，也不阻断后续登记。"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runs_registry

spec = importlib.util.spec_from_file_location('fix_d_board_server', HERE.parent / 'task-board/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RegistryByteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        env = patch.dict(os.environ, CREW_HOME=str(self.root), CREW_CODEX_BIN='/usr/bin/false')
        env.start()
        self.addCleanup(env.stop)
        self.valid = self.root / '完整运行'
        self.row = {'dir': str(self.valid), 'goal': '中文目标'}
        self.data = (json.dumps(self.row, ensure_ascii=False) + '\n').encode() + b'{"goal":"' + '中'.encode()[:2]
        runs_registry.registry_path().write_bytes(self.data)

    def test_read_runs_keeps_complete_record_before_truncated_utf8(self):
        rows = runs_registry.read_runs()
        self.assertEqual([row['dir'] for row in rows], [str(self.valid)])
        self.assertEqual(rows[0]['goal'], '中文目标')
        self.assertEqual(runs_registry.registry_path().read_bytes(), self.data)

    def test_http_keeps_complete_record_before_truncated_utf8(self):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.handler(None, HERE.parents[1] / 'web'))
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{http.server_port}/api/lead-runs', timeout=5) as response:
                self.assertEqual(response.status, 200)
                rows = json.loads(response.read())['runs']
            self.assertEqual([row['dir'] for row in rows], [str(self.valid)])
            self.assertEqual(runs_registry.registry_path().read_bytes(), self.data)
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=3)

    def test_register_appends_after_truncated_utf8_and_deduplicates(self):
        added = self.root / '后续运行'
        runs_registry.register(added, '继续登记')
        runs_registry.register(added, '重复')
        data = runs_registry.registry_path().read_bytes()
        self.assertTrue(data.startswith(self.data + b'\n'))
        self.assertEqual([row['dir'] for row in runs_registry.read_runs()], [str(added), str(self.valid)])
        self.assertEqual(len(data.splitlines()), 3)


if __name__ == '__main__':
    unittest.main()
