"""Checks for the lead-mode worker runner. A fake codex stands in; no model runs."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE / 'worker.py'

FAKE_CODEX = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys, time
    args = sys.argv[1:]
    if 'mcp' in args:
        # 真 Codex 的行为：插件带的 MCP（cua_repl）只能整体关插件；对它单独写 enabled=false 会让配置报错
        if 'mcp_servers.cua_repl.enabled=false' in args:
            sys.exit('Error loading config.toml: invalid transport')
        stuck = os.environ.get('FAKE_STUCK') == '1'
        servers = [
            {'name': 'feishu', 'enabled': stuck or 'mcp_servers.feishu.enabled=false' not in args},
            {'name': 'cua_repl', 'enabled': 'features.plugins=false' not in args},
            {'name': 'off', 'enabled': False},
        ]
        print(json.dumps(servers))
        sys.exit(0)
    prompt = sys.stdin.read()
    if os.environ.get('FAKE_NO_SESSION') != '1':
        print('session id: abc-123')
    print('tokens used')
    print('1,234')
    sys.stdout.flush()
    with open(os.environ['FAKE_LOG'], 'a') as f:
        f.write(json.dumps({'args': args, 'prompt': prompt, 'pid': os.getpid(), 'cwd': os.getcwd()}) + '\\n')
    if 'SLEEP' in prompt:
        time.sleep(60)
    out = args[args.index('-o') + 1]
    open(out, 'w').write(os.environ.get('FAKE_REPLY', '交付'))
''')


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        fake = self.tmp / 'codex'
        fake.write_text(FAKE_CODEX)
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_CODEX_BIN': str(fake), 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.run_dir = self.tmp / 'run'
        (self.run_dir / 'cards').mkdir(parents=True)

    def card(self, name, body):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body)

    def worker(self, *args):
        return subprocess.run([sys.executable, str(WORKER), *args], env=self.env, capture_output=True, text=True, timeout=30)

    def go(self, *extra):
        """run 只负责派出去，wait 等到有卡交回来；老用例要的是“跑完”。"""
        r = self.worker('run', str(self.run_dir), '--cwd', str(self.tmp), *extra)
        if r.returncode != 0:
            return r
        while any(c['state'] == 'running' for c in self.status().values()):
            self.worker('wait', str(self.run_dir), '--minutes', '1')
        return r

    def calls(self):
        log = self.tmp / 'calls.jsonl'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def status(self):
        r = self.worker('status', str(self.run_dir))
        self.assertEqual(r.returncode, 0, r.stderr)
        return {c['card']: c for c in json.loads(r.stdout)['cards']}

    def test_independent_cards_run_lean_and_read_only_in_one_wave(self):
        self.card('t1', '任务 A：数一数')
        self.card('t2', '任务 B：列清单')
        r = self.go('--goal', '一期分析')
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        for call in calls:
            args = call['args']
            self.assertEqual(args[:2], ['exec', '--skip-git-repo-check'])
            self.assertEqual(args[args.index('-s') + 1], 'read-only')
            self.assertEqual(args[args.index('-C') + 1], str(self.tmp))
            self.assertIn('features.plugins=false', args)
            self.assertIn('mcp_servers.feishu.enabled=false', args)
            self.assertNotIn('mcp_servers.cua_repl.enabled=false', args)
            self.assertIn('/绝对路径:行号', call['prompt'])  # 执行者规矩在前
        status = self.status()
        self.assertEqual(status['t1']['state'], 'delivered')
        receipt = json.loads((self.run_dir / 't1.json').read_text())
        self.assertEqual(receipt['disabled_mcp'], ['cua_repl', 'feishu'])
        self.assertEqual((self.run_dir / 't1.out').read_text(), '交付')
        self.assertEqual(json.loads((self.run_dir / 'run.json').read_text())['goal'], '一期分析')

    def test_dependent_card_waits_for_lead_acceptance_then_gets_prior_outputs(self):
        self.card('t1', '任务 A')
        self.card('t2', '任务 B')
        self.card('t3', '依赖：t1, t2\n任务 C：对照')
        self.go()
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.status()['t3']['state'], 'waiting')
        # 只验收一张，下游仍不跑
        self.assertEqual(self.worker('accept', str(self.run_dir), 't1', '--note', '抽查 3 条').returncode, 0)
        self.go()
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.worker('accept', str(self.run_dir), 't2', '--note', '抽查 2 条').returncode, 0)
        r = self.go()
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        prompt = calls[2]['prompt']
        self.assertIn(str(self.run_dir / 't1.out'), prompt)
        self.assertIn(str(self.run_dir / 't2.out'), prompt)
        self.assertEqual(self.status()['t1']['review']['note'], '抽查 3 条')

    def test_accept_refuses_unresolved_citations_and_reject_allows_retry(self):
        self.env['FAKE_REPLY'] = f'| 结论 | {self.tmp}/没有这个.md:3 |'
        self.card('t1', '任务 A')
        self.go()
        r = self.worker('accept', str(self.run_dir), 't1', '--note', '看过')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('对不上', r.stderr)
        self.assertEqual(self.status()['t1']['state'], 'delivered')
        self.assertEqual(self.worker('reject', str(self.run_dir), 't1', '--note', '出处错').returncode, 0)
        self.assertEqual(self.status()['t1']['state'], 'rejected')
        self.go()
        self.assertEqual(len(self.calls()), 1)  # 退回的卡不会自动重跑
        self.env['FAKE_REPLY'] = '交付'
        r = self.go('--retry', 't1')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.status()['t1']['state'], 'delivered')
        self.assertTrue(list((self.run_dir / 'history').glob('t1-*.json')))
        # 接着原会话改：用 resume 带上会话编号和退回原因，不从头重读
        again = self.calls()[1]
        self.assertEqual(again['args'][:3], ['exec', 'resume', 'abc-123'])
        self.assertIn('sandbox_mode="read-only"', again['args'])
        self.assertIn('出处错', again['prompt'])
        self.assertEqual(self.status()['t1']['resumed'], True)
        # resume 不认 -C：执行者必须在派单指定的目录里启动，否则会落到启动命令所在目录
        self.assertEqual(Path(again['cwd']).resolve(), self.tmp)

    def test_retry_without_session_id_starts_fresh(self):
        self.env['FAKE_NO_SESSION'] = '1'
        self.card('t1', '任务 A')
        self.go()
        self.worker('reject', str(self.run_dir), 't1', '--note', '重做')
        self.go('--retry', 't1')
        again = self.calls()[1]
        self.assertEqual(again['args'][:2], ['exec', '--skip-git-repo-check'])
        self.assertNotIn('resume', again['args'])
        self.assertFalse(self.status()['t1']['resumed'])

    def test_run_returns_before_slow_card_ends_and_wait_returns_on_first_delivery(self):
        self.card('fast', '任务 A')
        self.card('slow', 'SLEEP')
        r = self.worker('run', str(self.run_dir), '--cwd', str(self.tmp), '--seconds', '6')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.status()['slow']['state'], 'running')
        w = self.worker('wait', str(self.run_dir), '--minutes', '1')
        self.assertEqual(w.returncode, 0, w.stderr)
        states = {c['card']: c['state'] for c in json.loads(w.stdout)['cards']}
        self.assertEqual(states['fast'], 'delivered')
        self.assertEqual(states['slow'], 'running')  # 先交的先通知，不陪着等
        self.worker('wait', str(self.run_dir), '--minutes', '1')
        self.assertEqual(self.status()['slow']['state'], 'timed_out')
        receipt = json.loads((self.run_dir / 'fast.json').read_text())
        self.assertEqual(receipt['tokens'], 1234)
        self.assertEqual(receipt['session_id'], 'abc-123')

    def test_timeout_kills_worker_and_marks_card(self):
        self.card('slow', 'SLEEP')
        self.go('--seconds', '2')
        self.assertEqual(self.status()['slow']['state'], 'timed_out')
        with self.assertRaises(ProcessLookupError):
            os.kill(self.calls()[0]['pid'], 0)

    def test_status_reports_lost_worker_instead_of_running(self):
        self.card('t1', '任务 A')
        dead = subprocess.Popen(['true'])
        dead.wait()
        (self.run_dir / 't1.json').write_text(json.dumps({'state': 'running', 'pid': dead.pid}))
        self.assertEqual(self.status()['t1']['state'], 'lost')

    def test_run_refuses_when_an_mcp_stays_enabled(self):
        self.card('t1', '任务 A')
        self.env['FAKE_STUCK'] = '1'
        r = self.go()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('feishu', r.stderr)
        self.assertEqual(self.calls(), [])

    def test_run_refuses_more_than_thirty_minutes_and_unknown_dependency(self):
        self.card('t1', '任务 A')
        r = self.worker('run', str(self.run_dir), '--minutes', '31')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('30', r.stderr)
        self.card('t2', '依赖：t9\n任务 B')
        r = self.worker('run', str(self.run_dir))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('t9', r.stderr)
        self.assertEqual(self.calls(), [])

    def test_check_resolves_citations_against_source(self):
        src = self.tmp / '原文.md'
        src.write_text('第一行\n客户说要齐套预警\n第三行\n')
        spaced = self.tmp / 'with space.txt'
        spaced.write_text('only line\n')
        report = self.tmp / 't1.out'
        report.write_text(
            f'| 齐套 | 来源 {src}:2 |\n'
            f'| 范围 | {src}:L1-L3 |\n'
            f'| 越界 | {src}:9 |\n'
            f'| 缺失 | {self.tmp}/没有这个.md:1 |\n'
            f'| 空格 | `{spaced}:1` |\n'
            '| 推断 | 无来源 |\n')
        r = self.worker('check', str(report))
        self.assertEqual(r.returncode, 1, r.stderr)  # 有对不上的引用
        result = json.loads(r.stdout)
        by = {(c['path'], c['start']): c for c in result['citations']}
        self.assertEqual(by[(str(src), 2)]['status'], 'ok')
        self.assertEqual(by[(str(src), 2)]['text'], '客户说要齐套预警')
        self.assertEqual(by[(str(src), 1)]['end'], 3)
        self.assertEqual(by[(str(src), 9)]['status'], '行号越界')
        self.assertEqual(by[(f'{self.tmp}/没有这个.md', 1)]['status'], '文件不存在')
        self.assertEqual(by[(str(spaced), 1)]['status'], 'ok')
        self.assertEqual(result['no_source'], 1)

    def test_guide_is_printed_by_the_tool(self):
        r = self.worker('guide')
        self.assertEqual(r.returncode, 0)
        self.assertIn('crew worker accept', r.stdout)
        self.assertIn('crew worker wait', r.stdout)
        self.assertIn('不值得派', r.stdout)


if __name__ == '__main__':
    unittest.main()
