"""第七轮：负责人争锁短等，看守与巡检仍非阻塞；只用临时目录和假 Codex。"""
from contextlib import ExitStack, contextmanager, nullcontext, redirect_stderr, redirect_stdout
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX


BUSY = '这个运行目录正在派单，等它结束再来。'


class LockWaitingTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lead-r7-')
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name).resolve()
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        environment = mock.patch.dict(os.environ, {
            'CREW_HOME': str(self.tmp / 'registry'), 'CREW_CODEX_BIN': str(fake),
            'FAKE_LOG': str(self.tmp / 'calls.jsonl'), 'PYTHONDONTWRITEBYTECODE': '1'})
        environment.start()
        self.addCleanup(environment.stop)

    def cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = worker.main(list(map(str, args)))
        return subprocess.CompletedProcess(args, code, out.getvalue(), err.getvalue())

    def prepare(self, kind):
        root = self.tmp / kind
        (root / 'cards').mkdir(parents=True)
        (root / 'cards/a.md').write_text('任务 A', encoding='utf-8')
        run = worker.Run(root)
        if kind == 'run':
            return run, ['run', root, '--cwd', self.tmp, '--seconds', '5'], '.lock'
        (root / 'a.out').write_text('交付', encoding='utf-8')
        receipt = {'state': 'finished', 'output': str(root / 'a.out')}
        if kind == 'confirm':
            receipt = {'state': 'lost'}  # 旧回执缺身份，只记录人工确认，不发信号。
        elif kind == 'orphan':
            # 只引用本测试创建并已回收的进程组，覆盖失联看守的停止收尾。
            proc = subprocess.Popen([sys.executable, '-B', '-c', 'pass'], start_new_session=True)
            proc.wait(timeout=10)
            receipt = {'state': 'running', 'attempt_id': 'old-attempt', 'pid': proc.pid,
                       'executor_pid': proc.pid, 'executor_pgid': proc.pid}
        worker.write_json(root / 'a.json', receipt)
        if kind in ('accept', 'accept-hold', 'reject'):
            args = ['reject' if kind == 'reject' else 'accept', root, 'a', '--note', '已抽查']
            if kind == 'accept-hold':
                args += ['--hold']
            return run, args, '.lock'
        args = ['stop', root, 'a', '--note', '已核实退出']
        if kind == 'confirm':
            args += ['--confirm-exited']
        return run, args, '.stop.lock' if kind == 'stop' else '.lock'

    @contextmanager
    def contention(self, run, name='.lock', long=False):
        """首轮持锁等命令真正尝试后才释放；不赌进程启动速度。"""
        held, attempted, done = threading.Event(), threading.Event(), threading.Event()
        flock = fcntl.flock
        failures = []

        def hold():
            try:
                with (run.root / name).open('a') as stream:
                    for index in range(3 if not long else 1):
                        flock(stream, fcntl.LOCK_EX)
                        try:
                            if index == 0:
                                held.set()
                                if not attempted.wait(15):
                                    raise AssertionError('命令未尝试目标锁')
                            # 长持锁的兜底释放使旧版无限阻塞的 stop 也能结束并报断言失败。
                            if long:
                                done.wait(long)
                            else:
                                time.sleep(.15)
                        finally:
                            flock(stream, fcntl.LOCK_UN)
                        if not long:
                            time.sleep(.08)
            except BaseException as error:
                failures.append(error)

        def observed(stream, operation):
            if Path(stream.name).name == name and operation & fcntl.LOCK_EX:
                attempted.set()
            return flock(stream, operation)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(held.wait(15), '后台未持锁')
        try:
            with mock.patch.object(worker.fcntl, 'flock', side_effect=observed):
                yield
        finally:
            done.set()
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive(), '持锁线程未退出')
            self.assertEqual(failures, [])

    def finish(self, run, name='a'):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            receipt = run.receipt(name) or {}
            if receipt.get('state') not in worker.ACTIVE_STATES and receipt:
                self.assertEqual(receipt['state'], 'finished', receipt)
                return
            time.sleep(.03)
        self.fail('假执行者未交回')

    def test_commands_wait_through_repeated_short_holds(self):
        for kind in ('run', 'accept', 'accept-hold', 'reject', 'stop', 'confirm', 'orphan'):
            with self.subTest(kind=kind):
                run, args, name = self.prepare(kind)
                with self.contention(run, name):
                    result = self.cli(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(BUSY, result.stderr)
                if kind == 'run':
                    self.finish(run)
                    self.assertEqual(json.loads(result.stdout)['dispatched'], ['a'])
                elif kind.startswith('accept') or kind == 'reject':
                    verdict = 'rejected' if kind == 'reject' else 'accepted'
                    self.assertEqual(run.receipt('a')['review']['verdict'], verdict)
                elif kind == 'confirm':
                    self.assertIn('exit_confirmation', run.receipt('a'))
                elif kind == 'orphan':
                    self.assertEqual(run.receipt('a')['state'], 'stopped')

    def test_accept_dispatches_without_nested_lock(self):
        run, args, _ = self.prepare('accept')
        (run.root / 'cards/b.md').write_text('依赖：a\n任务 B', encoding='utf-8')
        worker.write_json(run.root / 'run.json', {'cwd': str(self.tmp), 'minutes': .1,
                                                'effort': 'high', 'model': None, 'write': False})
        with self.contention(run):
            # 第一轮同样争锁，保证新逻辑不会让 _review -> _run 重新抢自己的锁。
            result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['dispatched'], ['b'])
        self.finish(run, 'b')

    def test_review_waits_when_lock_is_taken_during_check(self):
        for kind in ('accept', 'reject'):
            with self.subTest(kind=kind), ExitStack() as stack:
                run, args, _ = self.prepare(kind)
                check = worker.check

                def checked(output):
                    result = check(output)
                    # 只让第二次加锁发生争抢：慢出处检查仍在锁外。
                    stack.enter_context(self.contention(run))
                    return result

                with mock.patch.object(worker, 'check', side_effect=checked):
                    result = self.cli(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(BUSY, result.stderr)

    def test_long_hold_times_out_with_original_error_and_exit_two(self):
        for kind in ('run', 'accept', 'reject', 'confirm', 'stop', 'orphan'):
            with self.subTest(kind=kind):
                run, args, name = self.prepare(kind)
                before = run.receipt('a')
                # run 使用真实默认上限；其余入口缩短同一常量，机器忙时仍留足总时限。
                timeout = 10 if kind == 'run' else .35
                limit = (nullcontext() if kind == 'run' else
                         mock.patch.object(worker, 'CLI_LOCK_TIMEOUT', timeout, create=True))
                with limit:
                    with self.contention(run, name, long=timeout + 8):
                        started = time.monotonic()
                        result = self.cli(*args)
                        elapsed = time.monotonic() - started
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(BUSY, result.stderr)
                self.assertIn('停止操作' if name == '.stop.lock' else '具体操作未知', result.stderr)
                self.assertGreaterEqual(elapsed, timeout * .9)
                self.assertLess(elapsed, timeout + 8)
                self.assertEqual(run.receipt('a'), before)
                self.assertFalse((run.root / '.accepted').exists())

    def test_default_lock_and_poll_stay_nonblocking(self):
        run, _, _ = self.prepare('run')
        with (run.root / '.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            with mock.patch.object(worker.time, 'sleep', side_effect=AssertionError('后台不应等锁')):
                with self.assertRaisesRegex(ValueError, BUSY):
                    with run.lock():
                        self.fail('重复获取了锁')
                self.assertEqual(worker.poll_wait(run), ([], True))


if __name__ == '__main__':
    unittest.main()
