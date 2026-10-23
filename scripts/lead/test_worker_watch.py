"""M6b：前台自动补位与持久暂停；只用临时目录、合成卡和假执行者。"""
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import worker


FAKE = r'''#!/usr/bin/env python3
import json, os, re, sys, time
from pathlib import Path
args = sys.argv[1:]
if 'mcp' in args:
    if os.environ.get('FAKE_MCP_DELAY'):
        Path(os.environ['FAKE_MCP_MARKER']).touch()
        time.sleep(float(os.environ['FAKE_MCP_DELAY']))
    print('[]')
    sys.exit(0)
prompt = sys.stdin.read()
name = re.search(r'TASK=(\w+)', prompt)[1]
with open(os.environ['FAKE_LOG'], 'a') as stream:
    stream.write(json.dumps({'name': name, 'args': args, 'prompt': prompt,
                             'cwd': os.getcwd(), 'pid': os.getpid()}) + '\n')
if 'GATED' in prompt:
    while not (Path(os.environ['FAKE_GATES']) / name).exists():
        time.sleep(.02)
if 'FAIL_TASK' in prompt:
    sys.exit(1)
reply = os.environ.get('FAKE_REPLY', '## 结论卡\n合成任务交付')
if '-p' in args:
    print(json.dumps({'type': 'result', 'result': reply, 'session_id': 'fixture-watch-session',
                     'usage': {'input_tokens': 2, 'output_tokens': 3}}))
else:
    Path(args[args.index('-o') + 1]).write_text(reply)
    print('session id: fixture-watch-session\ntokens used\n5')
'''


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lead-watch-')
        self.tmp = Path(self.temp.name).resolve()
        self.root = self.tmp / 'run'
        (self.root / 'cards').mkdir(parents=True)
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.gates = self.tmp / 'gates'
        self.gates.mkdir()
        fake = self.tmp / 'fake-executor'
        fake.write_text(FAKE, encoding='utf-8')
        fake.chmod(0o755)
        self.env = {**os.environ, 'CREW_HOME': str(self.tmp / 'registry'),
                    'CODEX_HOME': str(self.tmp / 'codex'), 'PYTHONDONTWRITEBYTECODE': '1',
                    'CREW_CODEX_BIN': str(fake), 'CREW_CLAUDE_BIN': str(fake),
                    'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'FAKE_GATES': str(self.gates),
                    'FAKE_MCP_MARKER': str(self.tmp / 'mcp-started')}
        self.run = worker.Run(self.root)
        self.roots = [self.root]
        self.processes = []

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
            proc.communicate(timeout=15)
        for root in self.roots:
            run = worker.Run(root)
            for name in run.cards():
                receipt = run.receipt(name) or {}
                if receipt.get('state') in worker.ACTIVE_STATES:
                    self.cli('stop', root, name, '--note', '合成测试收尾')
                    self.eventually(lambda: (run.receipt(name) or {}).get('state') not in worker.ACTIVE_STATES)
        self.temp.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', worker.__file__, *map(str, args)],
                              cwd=self.work, env=self.env, capture_output=True, text=True, timeout=20)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def configure(self, *args):
        return self.ok('run', self.root, '--cwd', self.work, '--max-parallel', '1',
                       '--seconds', '15', '--heartbeat-seconds', '.1', *args)

    def card(self, name, headers='', body=''):
        (self.root / 'cards' / f'{name}.md').write_text(f'{headers}\nTASK={name}\n{body}', encoding='utf-8')

    def start_watch(self, *args):
        previous = (worker.read_json(self.root / 'run.json') or {}).get('automation', {}).get('session_id')
        proc = subprocess.Popen([sys.executable, '-B', worker.__file__, 'watch', str(self.root), *map(str, args)],
                                cwd=self.work, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
        self.processes.append(proc)
        self.eventually(lambda: proc.poll() is not None or
                        (worker.read_json(self.root / 'run.json') or {}).get('automation', {}).get('session_id') not in (None, previous))
        self.assertIsNone(proc.poll(), proc.communicate() if proc.poll() is not None else '')
        return proc

    def finish_watch(self, proc):
        out, err = proc.communicate(timeout=15)
        self.assertEqual(proc.returncode, 0, out + err)
        return json.loads(out)

    def eventually(self, condition, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = condition()
            if value:
                return value
            time.sleep(.025)
        self.fail('合成场景未达到预期状态')

    def state(self, name):
        return self.run.state(name, self.run.cards())

    def delivered(self, name):
        self.eventually(lambda: self.state(name) == 'delivered')

    def release(self, name):
        (self.gates / name).touch()

    def calls(self):
        path = self.tmp / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_unlaunched(self, name):
        time.sleep(.3)
        self.assertIsNone(self.run.receipt(name))

    def test_watch_exclusive_and_manual_run_share_capacity_without_duplicates(self):
        self.configure()
        for name in ('a', 'b', 'c'):
            self.card(name, body='GATED')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        duplicate = self.cli('watch', self.root, '--minutes', '.001')
        self.assertEqual(duplicate.returncode, 2)
        self.assertIn('已有 watch', duplicate.stderr)
        self.assertEqual(self.ok('run', self.root)['dispatched'], [])
        self.assert_unlaunched('b')
        self.release('a')
        self.delivered('a')
        # 两个手工派发与 watch 同时争同一个空位。
        manual = [subprocess.Popen([sys.executable, '-B', worker.__file__, 'run', str(self.root)],
                                  env=self.env, cwd=self.work, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True) for _ in range(2)]
        self.processes.extend(manual)
        for item in manual:
            out, err = item.communicate(timeout=15)
            self.assertEqual(item.returncode, 0, out + err)
        self.eventually(lambda: len(self.calls()) == 2)
        self.assert_unlaunched('c')
        self.release('b')
        self.delivered('b')
        self.eventually(lambda: len(self.calls()) == 3)
        self.release('c')
        result = self.finish_watch(proc)
        self.assertEqual([c['name'] for c in self.calls()], ['a', 'b', 'c'])
        self.assertEqual(result['automation']['state'], 'ended')
        self.assertEqual(result['automation']['reason'], 'complete')

    def test_watch_waits_for_acceptance_then_dispatches_held_downstream(self):
        self.configure()
        self.card('a')
        self.card('b', '依赖：a')
        proc = self.start_watch()
        self.delivered('a')
        self.assertEqual(self.state('b'), 'waiting')
        self.assertIsNone(proc.poll())
        self.assertNotIn('review', self.run.receipt('a'))
        accepted = self.ok('accept', self.root, 'a', '--note', '合成验收', '--hold')
        self.assertEqual(accepted['dispatched'], [])
        self.finish_watch(proc)
        self.assertEqual(self.state('b'), 'delivered')
        frozen = self.run.receipt('a')['review']['accepted_output']
        self.assertIn(frozen, (self.root / 'b.prompt').read_text())

    def test_pause_without_watch_blocks_accept_but_manual_run_and_retry_work(self):
        self.configure()
        self.card('a')
        self.card('b', '依赖：a')
        self.ok('run', self.root)
        self.delivered('a')
        self.ok('pause', self.root)
        accepted = self.ok('accept', self.root, 'a', '--note', '合成验收')
        self.assertEqual(accepted['verdict'], 'accepted')
        self.assertEqual(accepted['dispatched'], [])
        self.assertIn('已暂停，下游未派', json.dumps(accepted, ensure_ascii=False))
        self.assert_unlaunched('b')
        self.assertEqual(self.ok('run', self.root)['dispatched'], ['b'])
        self.delivered('b')
        self.ok('reject', self.root, 'b', '--note', '合成退回')
        self.assertEqual(self.ok('run', self.root, '--retry', 'b')['dispatched'], ['b'])
        self.delivered('b')
        self.assertEqual(self.ok('status', self.root)['automation']['state'], 'paused')

    def test_pause_accept_and_resume_watch_refills_without_reacceptance(self):
        self.configure()
        self.card('a', body='GATED')
        self.card('b', '依赖：a')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.ok('pause', self.root)
        self.assertEqual(self.ok('status', self.root)['automation']['state'], 'paused')
        self.assertEqual(self.state('a'), 'running')
        self.release('a')
        self.delivered('a')
        accepted = self.ok('accept', self.root, 'a', '--note', '暂停中验收')
        self.assertEqual(accepted['dispatched'], [])
        self.assert_unlaunched('b')
        self.assertEqual(self.state('b'), 'ready')
        self.ok('resume', self.root)
        self.finish_watch(proc)
        self.assertEqual(self.state('b'), 'delivered')

    def test_pause_before_watch_and_resume_without_watch_only_clear_pause(self):
        self.configure()
        self.card('a')
        self.ok('pause', self.root)
        result = self.ok('resume', self.root)
        self.assertIn('重新', json.dumps(result, ensure_ascii=False))
        self.assertIn('watch', json.dumps(result))
        self.assert_unlaunched('a')
        self.ok('pause', self.root)
        proc = self.start_watch()
        self.assert_unlaunched('a')
        self.ok('resume', self.root)
        self.finish_watch(proc)
        self.assertEqual(self.state('a'), 'delivered')

    def test_paused_live_watch_allows_manual_dispatch_and_retry(self):
        self.configure()
        self.card('a', body='GATED')
        self.card('b')
        self.card('c', '依赖：b')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.ok('pause', self.root)
        self.release('a')
        self.delivered('a')
        self.assert_unlaunched('b')
        self.assertEqual(self.ok('run', self.root)['dispatched'], ['b'])
        self.delivered('b')
        self.ok('reject', self.root, 'b', '--note', '合成退回')
        self.assertEqual(self.ok('run', self.root, '--retry', 'b')['dispatched'], ['b'])
        self.delivered('b')
        self.assertEqual(self.ok('accept', self.root, 'b', '--note', '合成验收')['dispatched'], [])
        self.assert_unlaunched('c')
        self.ok('resume', self.root)
        self.finish_watch(proc)
        self.assertEqual([c['name'] for c in self.calls()], ['a', 'b', 'b', 'c'])

    def test_live_watch_and_accept_use_saved_claude_settings(self):
        self.configure('--executor', 'claude', '--model', 'fixture-model', '--allow-web')
        self.card('a', body='GATED')
        self.card('b', '依赖：a')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.release('a')
        self.delivered('a')
        accepted = self.ok('accept', self.root, 'a', '--note', '合成验收')
        self.assertEqual(accepted['dispatched'], ['b'])
        self.finish_watch(proc)
        self.assertEqual(len(self.calls()), 2)
        receipt = self.run.receipt('b')
        self.assertEqual((receipt['executor'], receipt['model'], receipt['allow_web']),
                         ('claude', 'fixture-model', True))

    def test_fresh_watch_uses_run_defaults_without_card_or_watch_deadline(self):
        self.card('a', body='GATED')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        receipt = self.run.receipt('a')
        self.assertIsNone(receipt['timeout_seconds'])
        self.assertIsNone(receipt['model'])
        self.assertEqual(receipt['cwd'], str(self.work))
        self.assertIsNone(worker.read_json(self.root / 'run.json')['automation']['deadline'])
        self.release('a')
        self.finish_watch(proc)

    def test_deadline_and_ctrl_c_leave_dispatched_cards_running(self):
        for limit in (True, False):
            with self.subTest(deadline=limit):
                # 每个子场景用新运行，保留同一替身环境。
                self.root = self.tmp / ('limited' if limit else 'interrupted')
                (self.root / 'cards').mkdir(parents=True)
                self.roots.append(self.root)
                self.run = worker.Run(self.root)
                self.configure()
                name = 'limited' if limit else 'interrupted'
                self.card(name, body='GATED')
                self.card('z')
                # 先观察首卡确已启动，再开短 watch，避免把解释器启动时间当成调度保证。
                self.ok('run', self.root)
                self.eventually(lambda: any(c['name'] == name for c in self.calls()))
                proc = self.start_watch(*(['--minutes', '.02'] if limit else []))
                if not limit:
                    self.assertIsNone(worker.read_json(self.root / 'run.json')['automation']['deadline'])
                    proc.send_signal(signal.SIGINT)
                result = self.finish_watch(proc)
                self.assertEqual(result['automation']['reason'], 'deadline' if limit else 'interrupted')
                self.assertEqual(self.state(name), 'running')
                self.assert_unlaunched('z')
                self.release(name)
                self.delivered(name)
                self.assert_unlaunched('z')

    def test_deadline_during_slow_preflight_does_not_dispatch(self):
        self.configure()
        self.card('a')
        self.env['FAKE_MCP_DELAY'] = '.2'
        result = self.ok('watch', self.root, '--minutes', '.002')
        self.assertEqual(result['automation']['reason'], 'deadline')
        self.assertTrue((self.tmp / 'mcp-started').exists())
        self.assertIsNone(self.run.receipt('a'))

    def test_deadline_includes_initial_lock_wait(self):
        self.configure()
        self.card('a')
        with self.run.lock():
            proc = subprocess.Popen([sys.executable, '-B', worker.__file__, 'watch', str(self.root),
                                     '--minutes', '.005'], cwd=self.work, env=self.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.processes.append(proc)
            time.sleep(.6)
        automation = self.finish_watch(proc)['automation']
        self.assertEqual(automation['reason'], 'deadline')
        self.assertLessEqual(dt.datetime.fromisoformat(automation['deadline']),
                             dt.datetime.fromisoformat(automation['ended_at']))
        self.assertIsNone(self.run.receipt('a'))

    def test_ctrl_c_during_slow_preflight_does_not_dispatch(self):
        self.configure()
        self.card('a')
        self.env['FAKE_MCP_DELAY'] = '.15'
        proc = self.start_watch()
        self.eventually(lambda: (self.tmp / 'mcp-started').exists())
        proc.send_signal(signal.SIGINT)
        self.assertEqual(self.finish_watch(proc)['automation']['reason'], 'interrupted')
        self.assertIsNone(self.run.receipt('a'))

    def test_empty_run_finishes_and_minutes_has_no_thirty_minute_cap(self):
        result = self.ok('watch', self.root, '--minutes', '60')
        self.assertEqual(result['automation']['reason'], 'complete')
        self.assertEqual(self.calls(), [])
        for value in ('0', '-1', 'nan', 'inf'):
            self.assertEqual(self.cli('watch', self.root, '--minutes', value).returncode, 2)

    def test_failed_rejected_stopped_and_lost_cards_are_not_retried(self):
        self.configure()
        self.card('failed', body='FAIL_TASK')
        self.ok('watch', self.root)
        self.assertEqual(self.state('failed'), 'failed')
        self.card('rejected')
        self.ok('run', self.root)
        self.delivered('rejected')
        self.ok('reject', self.root, 'rejected', '--note', '合成退回')
        for name in ('stopped', 'lost'):
            self.card(name)
            worker.write_json(self.root / f'{name}.json', {'state': name, 'executor_exit_confirmed_at': worker.now()})
        before = self.calls()
        self.assertEqual(self.ok('watch', self.root)['automation']['reason'], 'complete')
        self.assertEqual(self.calls(), before)
        self.assertEqual([self.state(n) for n in ('failed', 'rejected', 'stopped', 'lost')],
                         ['failed', 'rejected', 'stopped', 'lost'])

    def test_live_watch_rejects_execution_changes_but_same_settings_are_allowed(self):
        self.configure()
        self.card('a', body='GATED')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.ok('pause', self.root)
        before = (self.root / 'run.json').read_bytes()
        other = self.tmp / 'other'
        other.mkdir()
        for args in (('--executor', 'claude'), ('--model', 'different'), ('--effort', 'low'),
                     ('--cwd', str(other)), ('--write',), ('--allow-web',),
                     ('--enable', 'fixture_feature'), ('--max-parallel', '2'), ('--minutes', '2')):
            with self.subTest(args=args):
                denied = self.cli('run', self.root, *args)
                self.assertEqual(denied.returncode, 2, denied.stdout + denied.stderr)
                self.assertIn('watch', denied.stderr)
                self.assertEqual((self.root / 'run.json').read_bytes(), before)
        self.assertEqual(self.configure()['dispatched'], [])
        self.release('a')
        self.finish_watch(proc)

    def test_status_reports_interrupted_and_resume_never_starts_background_watch(self):
        self.configure()
        self.card('a', body='GATED')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.ok('pause', self.root)
        proc.kill()
        proc.communicate(timeout=10)
        self.assertEqual(self.ok('status', self.root)['automation']['state'], 'interrupted')
        self.release('a')
        self.delivered('a')
        self.card('b')
        resumed = self.ok('resume', self.root)
        self.assertIn('watch', json.dumps(resumed))
        self.assert_unlaunched('b')
        self.assertFalse(worker.read_json(self.root / 'run.json')['automation']['paused'])
        self.ok('watch', self.root)
        self.assertEqual(self.state('b'), 'delivered')

    def test_watch_uses_claude_card_options_and_saved_network_settings(self):
        self.configure('--executor', 'claude', '--model', 'fixture-default', '--allow-web')
        self.card('a', '执行者：claude\n模型：fixture-card\n档位：xhigh')
        self.card('b')
        self.ok('watch', self.root)
        for name, model, effort in (('a', 'fixture-card', 'xhigh'), ('b', 'fixture-default', 'high')):
            receipt = self.run.receipt(name)
            self.assertEqual((receipt['executor'], receipt['model'], receipt['effort']), ('claude', model, effort))
            self.assertTrue(receipt['allow_web'])
            self.assertEqual(receipt['timeout_seconds'], 15)
            call = next(c for c in self.calls() if c['name'] == name)
            self.assertEqual(call['cwd'], str(self.work))
            self.assertIn('Read,Grep,Glob,WebSearch,WebFetch', call['args'])

    def test_watch_preserves_result_contract_and_never_accepts_blocked_delivery(self):
        self.configure()
        self.card('a', '结果：result-v1\n覆盖：C1')
        self.card('b', '依赖：a')
        result = {'status': 'blocked', 'questions': ['请补合成输入'], 'covered': [],
                  'skipped': [{'id': 'C1', 'reason': '缺少输入'}]}
        self.env['FAKE_REPLY'] = '## 结论卡\n合成结果\n```json\n' + json.dumps(result) + '\n```\n'
        proc = self.start_watch('--minutes', '.03')
        self.eventually(lambda: self.state('a') == 'blocked')
        waited = self.ok('wait', self.root, '--minutes', '.01')
        self.assertEqual(waited['fresh'], ['a'])
        self.assertEqual(set(waited), {'run', 'dir', 'cards', 'fresh'})
        denied = self.cli('accept', self.root, 'a', '--note', '不可验收')
        self.assertEqual(denied.returncode, 2)
        self.finish_watch(proc)
        self.assertEqual(len(self.calls()), 1)
        self.assertIsNone(self.run.receipt('b'))
        self.assertEqual(self.run.receipt('a')['result']['questions'], result['questions'])

    def test_watch_write_requires_saved_authorization_and_manual_run_keeps_it(self):
        self.configure()
        self.card('a', '可写：allowed.txt')
        denied = self.cli('watch', self.root)
        self.assertEqual(denied.returncode, 2)
        self.assertIn('--write', denied.stderr)
        self.assertIsNone(self.run.receipt('a'))
        self.assertFalse((self.root / 'baseline.json').exists())
        self.card('a', '可写：allowed.txt', 'GATED')
        self.configure('--write')
        self.card('b', '可写：allowed.txt')
        proc = self.start_watch()
        self.eventually(lambda: len(self.calls()) == 1)
        self.ok('pause', self.root)
        # 手工 run 没给 --write 仍拒绝写卡，但不能撤销 watch 已保存的写授权。
        self.assertEqual(self.cli('run', self.root).returncode, 2)
        self.assertTrue(worker.read_json(self.root / 'run.json')['allow_write'])
        self.release('a')
        self.delivered('a')
        self.assert_unlaunched('b')
        self.ok('resume', self.root)
        self.finish_watch(proc)
        self.assertEqual(self.run.receipt('b')['sandbox'], 'danger-full-access')
        self.assertTrue((self.root / 'baseline.json').exists())
        self.assertEqual(self.ok('changes', self.root)['out_of_bounds'], [])


if __name__ == '__main__':
    unittest.main()
