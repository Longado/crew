"""第八轮凭据回归：两端共用样例，失败路径只运行假 Codex。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import worker
from test_worker import FAKE_CODEX


# TypeScript 直接读取这组 JSON，正反例和长输入不维护第二份。
R8_CASES = json.loads(r'''[
  ["headers={\"Cookie\": \"sessionid=fixture-cookie-123; theme=light\", \"Accept\": \"text/plain\"}", "headers={\"Cookie\": \"[已隐藏的凭证]\", \"Accept\": \"text/plain\"}"],
  ["headers={'Set-Cookie': 'sessionid=fixture-cookie-123; HttpOnly', 'ok': True}", "headers={'Set-Cookie': '[已隐藏的凭证]', 'ok': True}"],
  ["{\"Set-Cookie\":\"sid=fixture; Path=/; Secure\", \"ok\":true}", "{\"Set-Cookie\":\"[已隐藏的凭证]\", \"ok\":true}"],
  ["{'Cookie': 'sid=fixture; theme=light'}", "{'Cookie': '[已隐藏的凭证]'}"],
  ["{'cOoKiE' : \"sid=fixture\", 'Set-Cookie': 'sid=other-fixture'}", "{'cOoKiE' : \"[已隐藏的凭证]\", 'Set-Cookie': '[已隐藏的凭证]'}"],
  ["{\"Cookie\": \"sid=fixture\\\"quoted; tail=hidden\"}", "{\"Cookie\": \"[已隐藏的凭证]\"}"],
  ["{'Cookie': 'sid=fixture\\'quoted; tail=hidden'}", "{'Cookie': '[已隐藏的凭证]'}"],
  ["{\"Cookie\": \"sid=fixture's-value\"}", "{\"Cookie\": \"[已隐藏的凭证]\"}"],
  ["{\"Cookie\":\"\"}", "{\"Cookie\":\"[已隐藏的凭证]\"}"],
  ["{'Cookie':'x'}", "{'Cookie':'[已隐藏的凭证]'}"],
  ["{\"Cookie\": \"sid=fixture", "{\"Cookie\": \"[已隐藏的凭证]"],
  ["{\"Cookie\": \"first\nfixture-tail\"}", "{\"Cookie\": \"[已隐藏的凭证]\"}"],
  ["Cookie: sid=fixture; theme=light\nAccept: text/plain", "Cookie: [已隐藏的凭证]\nAccept: text/plain"],
  ["Set-Cookie: sid=fixture; HttpOnly", "Set-Cookie: [已隐藏的凭证]"],
  ["{\"CookieJar\": \"fixture-public\", \"X-Cookie\": \"fixture-public\", \"Set-Cookie-Policy\": \"strict\"}", "{\"CookieJar\": \"fixture-public\", \"X-Cookie\": \"fixture-public\", \"Set-Cookie-Policy\": \"strict\"}"],
  ["Cookie policy is documented", "Cookie policy is documented"],
  ["Command '['client', '--token', 'fixture-argv-123']' returned non-zero exit status 1.", "Command '['client', '--token', '[已隐藏的凭证]']' returned non-zero exit status 1."],
  ["[\"client\", \"--token\", \"fixture-argv-123\", \"--verbose\"]", "[\"client\", \"--token\", \"[已隐藏的凭证]\", \"--verbose\"]"],
  ["['--api-key','fixture value', '--password', 'another fixture']", "['--api-key','[已隐藏的凭证]', '--password', '[已隐藏的凭证]']"],
  ["[\"--api_key\", \"x\"]", "[\"--api_key\", \"[已隐藏的凭证]\"]"],
  ["['--apikey', 'fixture-value']", "['--apikey', '[已隐藏的凭证]']"],
  ["['--TOKEN', \"fixture-value\"]", "['--TOKEN', \"[已隐藏的凭证]\"]"],
  ["[\"--password\", 'fixture-value']", "[\"--password\", '[已隐藏的凭证]']"],
  ["['--token',\n 'fixture-value']", "['--token',\n '[已隐藏的凭证]']"],
  ["[\"--password\", \"fixture\\\" value\"]", "[\"--password\", \"[已隐藏的凭证]\"]"],
  ["['--password', 'fixture\\' value']", "['--password', '[已隐藏的凭证]']"],
  ["['--token', '']", "['--token', '[已隐藏的凭证]']"],
  ["['--token', 'fixture-unclosed", "['--token', '[已隐藏的凭证]"],
  ["client --password fixture\\ secret\\ 123 --verbose", "client --password [已隐藏的凭证] --verbose"],
  ["client --api-key fixture\\\tsecret --verbose", "client --api-key [已隐藏的凭证] --verbose"],
  ["client --token fixture\\\"secret\\ value --verbose", "client --token [已隐藏的凭证] --verbose"],
  ["client --password fixture\\'secret\\ value --verbose", "client --password [已隐藏的凭证] --verbose"],
  ["client --token fixture\\\\ next", "client --token [已隐藏的凭证] next"],
  ["client --token fixture\\\\\\ value --verbose", "client --token [已隐藏的凭证] --verbose"],
  ["client --token fixture\\", "client --token [已隐藏的凭证]"],
  ["client --token \\", "client --token [已隐藏的凭证]"],
  ["client --token fixture\\\nnext line", "client --token [已隐藏的凭证]\nnext line"],
  ["--token --help", "--token --help"],
  ["['--token', '--help']", "['--token', '--help']"],
  ["[\"--password\", \"-h\"]", "[\"--password\", \"-h\"]"],
  ["['--tokens', 'public', '--password-policy', 'strict', '--api-key-file', 'public']", "['--tokens', 'public', '--password-policy', 'strict', '--api-key-file', 'public']"],
  ["['--token']", "['--token']"],
  ["['--token', 123]", "['--token', 123]"],
  ["client --tokens fixture\\ public --verbose", "client --tokens fixture\\ public --verbose"],
  ["--token\nnormal output", "--token\nnormal output"]
]''')

R8_LONG_CASES = json.loads(r'''[
  ["{\"Cookie\":\"", "x\\ y", "\",\"ok\":true}", "{\"Cookie\":\"[已隐藏的凭证]\",\"ok\":true}"],
  ["['--token', '", "x\\ y", "', '--help']", "['--token', '[已隐藏的凭证]', '--help']"],
  ["--password ", "x\\ y", " --help", "--password [已隐藏的凭证] --help"],
  ["{\"Cookie\":\"", "x\\\"", "tail", "{\"Cookie\":\"[已隐藏的凭证]"],
  ["['--token'", " ", "]", null],
  ["", "'CookieJar': 'public', '--tokens', 'public'; ", "", null]
]''')


class R8FixTest(unittest.TestCase):
    def test_c1_c2_shared_positive_and_negative_cases(self):
        for text, expected in R8_CASES:
            with self.subTest(text=text):
                self.assertEqual(worker.redact(text), expected)
                self.assertEqual(worker.redact(expected), expected)

    def test_c1_c2_long_inputs_finish_within_one_second_each(self):
        for prefix, unit, suffix, expected in R8_LONG_CASES:
            for size in (4096, 16384, 65536):
                text = prefix + unit * size + suffix
                with self.subTest(prefix=prefix, size=size):
                    started = time.perf_counter()
                    hidden = worker.redact(text)
                    elapsed = time.perf_counter() - started
                    self.assertEqual(hidden, text if expected is None else expected)
                    self.assertLess(elapsed, 1)

    def test_c1_c2_fake_failure_hides_status_wait_and_summary_keeps_raw_log(self):
        with tempfile.TemporaryDirectory(prefix='lead-r8fix-') as temporary:
            tmp = Path(temporary).resolve()
            fake = tmp / 'fake-codex'
            fake.write_text(FAKE_CODEX.replace("out = args[args.index('-o') + 1]", """
print('Error: ' + os.environ['FAKE_R8_ERROR'])
sys.exit(7)
out = args[args.index('-o') + 1]
"""), encoding='utf-8')
            fake.chmod(0o755)
            samples = [
                ('headers={"Cookie": "sid=fixture-cookie-123"}', 'fixture-cookie-123'),
                (str(subprocess.CalledProcessError(1, ['client', '--token', 'fixture-argv-123'])),
                 'fixture-argv-123'),
                (r'client --password fixture\ secret\ 123', 'secret'),
            ]
            environment = {'CREW_HOME': str(tmp / 'registry'), 'CREW_CODEX_BIN': str(fake),
                           'FAKE_LOG': str(tmp / 'calls.jsonl'), 'FAKE_NO_SESSION': '1',
                           'PYTHONDONTWRITEBYTECODE': '1'}
            with mock.patch.dict(os.environ, environment), mock.patch.object(worker, 'native_tokens', return_value=None):
                for index, (sample, secret) in enumerate(samples):
                    with self.subTest(sample=sample):
                        root = tmp / str(index)
                        (root / 'cards').mkdir(parents=True)
                        (root / 'cards/a.md').write_text('合成任务', encoding='utf-8')
                        prompt = root / 'a.prompt'
                        prompt.write_text('合成任务', encoding='utf-8')
                        receipt = {'state': 'running', 'attempt_id': 'fixture-attempt', 'pid': 0,
                                   'started_at': worker.now(), 'cwd': str(tmp), 'prompt': str(prompt),
                                   'output': str(root / 'a.out'), 'log': str(root / 'a.log')}
                        worker.write_json(root / 'a.json', receipt)
                        run = worker.Run(root)
                        with mock.patch.dict(os.environ, FAKE_R8_ERROR=sample):
                            worker.guard(root, 'a', 10, [str(fake), 'exec', '-o', receipt['output']],
                                         receipt['attempt_id'], .05)
                        row = run.receipt('a')
                        self.assertEqual(row['state'], 'failed')
                        expected = 'Error: ' + worker.redact(sample)
                        self.assertEqual(row['heartbeat']['last_output'], expected)
                        for value in (row['failure_reason'], run.status(), worker.wait_result(run, run.wait(0))):
                            visible = str(value)
                            self.assertNotIn(secret, visible)
                            self.assertIn(worker.REDACTED, visible)
                        self.assertIn(sample, Path(receipt['log']).read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
