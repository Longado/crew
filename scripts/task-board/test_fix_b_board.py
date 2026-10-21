"""修复 B 的负责人接口与展示契约；仅使用本地临时数据。"""
import datetime as dt
import json
import os
import re
import unittest

import test_lead_runs as fixtures
import runs_registry


class FixBBoardTests(unittest.TestCase):
    setUp = fixtures.LeadRunsHTTPTests.setUp
    close = fixtures.LeadRunsHTTPTests.close
    get = fixtures.LeadRunsHTTPTests.get

    def test_b3_bad_run_does_not_break_http_list(self):
        for name, meta in (('good', {}), ('bad', [{}])):
            run = self.root / name
            (run / 'cards').mkdir(parents=True)
            (run / 'cards/a.md').write_text('任务')
            (run / 'run.json').write_text(json.dumps(meta))
            runs_registry.register(run, name)
        try:
            code, body = self.get('/api/lead-runs')
        except Exception as error:
            self.fail('坏运行中断了 HTTP 列表：' + str(error))
        self.assertEqual(code, 200)
        rows = {r['goal']: r for r in json.loads(body)['runs']}
        self.assertEqual(rows['good']['status'], 'available')
        self.assertEqual(rows['bad']['status'], 'error')

    def test_b4_http_exposes_heartbeat_and_frontend_renders_it(self):
        run = self.root / 'run'
        (run / 'cards').mkdir(parents=True)
        started = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=90)).isoformat()
        (run / 'cards/a.md').write_text('任务')
        (run / 'a.json').write_text(json.dumps({'state': 'stalled', 'pid': os.getpid(), 'started_at': started,
            'heartbeat': {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'log_mtime': started,
                          'tokens': 12, 'last_output': '<script>进度</script>'}}))
        runs_registry.register(run)
        code, body = self.get('/api/lead-runs')
        self.assertEqual(code, 200)
        card = json.loads(body)['runs'][0]['cards'][0]
        self.assertEqual(card['tokens'], 12)
        self.assertGreaterEqual(card['idle_seconds'], 90)
        self.assertEqual(card['last_output'], '<script>进度</script>')
        script = self.get('/lead-runs.js')[1].decode()
        self.assertIn("stalled:'停滞'", script)
        self.assertIn('最后动静距今', script)
        self.assertIn('esc(row.last_output)', script)

    def test_b5_section_heading_is_sticky_in_its_scroll_container(self):
        css = self.get('/lead-runs.css')[1].decode()
        rule = re.search(r'\.lead-runs\s*>\s*summary\s*\{([^}]+)\}', css).group(1)
        for declaration in ('position: sticky', 'top: 0', 'z-index: 1', 'background: var(--surface)'):
            self.assertIn(declaration, rule)
        html = self.get('/')[1].decode()
        self.assertIn('<strong>负责人运行</strong>', html)


if __name__ == '__main__':
    unittest.main()
