"""Mixed executor model boundaries, captured by fake CLIs in temporary runs."""
import unittest
import test_worker_claude as fixtures


class MixedModelTests(unittest.TestCase):
    setUp = fixtures.ClaudeWorkerTest.setUp
    tearDown = fixtures.ClaudeWorkerTest.tearDown
    card = fixtures.ClaudeWorkerTest.card
    cli = fixtures.ClaudeWorkerTest.cli
    ok = fixtures.ClaudeWorkerTest.ok
    start = fixtures.ClaudeWorkerTest.start
    finish = fixtures.ClaudeWorkerTest.finish
    calls = fixtures.ClaudeWorkerTest.calls

    def options(self, executor):
        self.env['CREW_CODEX_BIN'] = str(self.codex)
        return ('--executor', executor, '--model', 'synthetic-' + executor)

    def check_command(self, name, executor, model):
        receipt = self.finish(name)
        self.assertEqual(receipt['executor'], executor)
        calls = [call for call in self.calls() if 'SYNTHETIC_' + name + '\n' in call['prompt']]
        self.assertTrue(calls, name)
        args = calls[-1]['args']
        self.assertEqual(args[0], '-p' if executor == 'claude' else 'exec')
        actual = args[args.index('--model') + 1] if '--model' in args else None
        self.assertEqual(actual, model, args)
        self.assertEqual(receipt['model'], model)
        return args

    def test_first_dispatch_cli_model_only_belongs_to_default_executor(self):
        for default, other in [('codex', 'claude'), ('claude', 'codex')]:
            with self.subTest(default=default):
                names = [default + suffix for suffix in ('_default', '_switch', '_own')]
                self.card(names[0], f'SYNTHETIC_{names[0]}\nSynthetic task')
                self.card(names[1], f'执行者：{other}\nSYNTHETIC_{names[1]}\nSynthetic task')
                self.card(names[2], f'执行者：{other}\n模型：synthetic-card\nSYNTHETIC_{names[2]}\nSynthetic task')
                self.start(*self.options(default))
                for name in names:
                    self.finish(name)
                self.check_command(names[0], default, 'synthetic-' + default)
                self.check_command(names[1], other, None)
                self.check_command(names[2], other, 'synthetic-card')

    def test_supplement_uses_executor_default_with_stored_or_explicit_cli_model(self):
        for default, other in [('codex', 'claude'), ('claude', 'codex')]:
            with self.subTest(default=default):
                seed = default + '_seed'
                self.card(seed, f'SYNTHETIC_{seed}\nSynthetic task')
                self.start(*self.options(default)); self.finish(seed)
                for explicit in (False, True):
                    name = default + ('_explicit' if explicit else '_stored')
                    self.card(name, f'执行者：{other}\nSYNTHETIC_{name}\nSynthetic task')
                    self.start(*(self.options(default) if explicit else ()))
                    self.check_command(name, other, None)

    def test_retry_same_executor_keeps_resume_without_inheriting_cli_model(self):
        name = 'retry_mixed'
        self.card(name, f'执行者：claude\nSYNTHETIC_{name}\nSynthetic task')
        self.start('--executor', 'codex'); self.finish(name)
        self.ok('reject', self.root, name, '--note', 'Synthetic retry')
        self.start(*self.options('codex'), '--retry', name)
        args = self.check_command(name, 'claude', None)
        self.assertIn('--resume', args)

    def test_fresh_retry_switching_executor_drops_cli_model_and_honors_card_model(self):
        for default, other in [('codex', 'claude'), ('claude', 'codex')]:
            for own in (False, True):
                with self.subTest(default=default, own=own):
                    name = default + ('_retry_own' if own else '_retry_default')
                    self.card(name, f'SYNTHETIC_{name}\nSynthetic task')
                    self.start(*self.options(default)); self.finish(name)
                    self.ok('reject', self.root, name, '--note', 'Synthetic switch')
                    header = f'执行者：{other}\n' + ('模型：synthetic-card\n' if own else '')
                    self.card(name, header + f'SYNTHETIC_{name}\nSynthetic task')
                    self.start(*self.options(default), '--retry', name, '--fresh')
                    self.check_command(name, other, 'synthetic-card' if own else None)


if __name__ == '__main__':
    unittest.main()
