"""result-v1：假执行者交回缺输入、覆盖缺口和协议错误，不调用模型。"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_worker import FAKE_CODEX, WORKER


def reply(status='complete', covered=None, skipped=None, questions=None):
    result = {'status': status, 'covered': ['a', 'b', 'c'] if covered is None else covered,
              'skipped': [] if skipped is None else skipped,
              'questions': [] if questions is None else questions}
    return '## 结论卡\n问题／本次结论：本地替身交付\n\n```json\n' + json.dumps(result, ensure_ascii=False) + '\n```\n'


class ResultContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name).resolve()
        refuse = self.tmp / 'refuse-codex'
        refuse.write_text('#!/bin/sh\necho "测试未显式启用假执行者" >&2\nexit 97\n', encoding='utf-8')
        refuse.chmod(0o755)
        self.environment = patch.dict(os.environ, {'CREW_CODEX_BIN': str(refuse), 'PYTHONDONTWRITEBYTECODE': '1'})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.env = {**os.environ, 'FAKE_LOG': str(self.tmp / 'calls.jsonl')}
        self.run_dir = self.tmp / 'run'
        (self.run_dir / 'cards').mkdir(parents=True)

    def use_fake(self, text):
        fake = self.tmp / 'fake-codex'
        fake.write_text(FAKE_CODEX, encoding='utf-8')
        fake.chmod(0o755)
        self.env.update(CREW_CODEX_BIN=str(fake), FAKE_REPLY=text)

    def card(self, name='t1', body='结果：result-v1\n覆盖：a, b, c\n任务'):
        (self.run_dir / 'cards' / f'{name}.md').write_text(body, encoding='utf-8')

    def worker(self, *args):
        return subprocess.run([sys.executable, '-B', str(WORKER), *map(str, args)],
                              env=self.env, capture_output=True, text=True, timeout=15)

    def ok(self, *args):
        result = self.worker(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def delivered(self, text, *args):
        self.use_fake(text)
        self.ok('run', self.run_dir, '--cwd', self.tmp, '--seconds', '5', *args)
        return self.ok('wait', self.run_dir, '--minutes', '0.1')

    def read(self, name='t1'):
        return json.loads((self.run_dir / f'{name}.json').read_text(encoding='utf-8'))

    def row(self, result, name='t1'):
        return next(row for row in result['cards'] if row['card'] == name)

    def test_missing_coverage_is_protocol_error_and_cannot_be_accepted(self):
        self.card()
        text = reply(covered=['a', 'b'])
        result = self.delivered(text)
        self.assertEqual(self.row(result)['state'], 'protocol_error')
        self.assertIn('c', ' '.join(self.read()['result']['errors']))
        denied = self.worker('accept', self.run_dir, 't1', '--note', '看过', '--force')
        self.assertEqual(denied.returncode, 2)
        self.assertNotIn('review', self.read())
        self.assertEqual((self.run_dir / 't1.out').read_text(encoding='utf-8'), text)

    def test_blocked_questions_are_visible_once_and_downstream_never_starts(self):
        self.card()
        self.card('next', '依赖：t1\n下游')
        questions = ['请负责人补充 c 的验收样本路径。']
        result = self.delivered(reply('blocked', ['a', 'b'], [{'id': 'c', 'reason': '缺样本'}], questions))
        self.assertEqual(result['fresh'], ['t1'])
        row = self.row(result)
        self.assertEqual((row['state'], row.get('status'), row.get('questions')), ('blocked', 'blocked', questions))
        self.assertEqual(self.row(result, 'next')['state'], 'waiting')
        self.assertEqual(self.row(self.ok('status', self.run_dir))['questions'], questions)
        self.assertEqual(self.ok('wait', self.run_dir, '--minutes', '0.01')['fresh'], [])
        denied = self.worker('accept', self.run_dir, 't1', '--note', '强行继续', '--force')
        self.assertEqual(denied.returncode, 2)
        self.ok('run', self.run_dir, '--cwd', self.tmp)
        self.assertFalse((self.run_dir / 'next.json').exists())

    def test_bad_json_is_visible_and_original_is_preserved(self):
        self.card()
        text = '## 结论卡\n原稿仍要保留。\n```json\n{"status": complete}\n```\n'
        result = self.delivered(text)
        self.assertEqual(self.row(result)['state'], 'protocol_error')
        self.assertIn('JSON', ' '.join(self.row(result)['errors']))
        self.assertEqual((self.run_dir / 't1.out').read_text(encoding='utf-8'), text)
        self.assertIn('{"status": complete}', self.read()['result']['raw'])

    def test_partial_accept_requires_flag_and_all_gap_ids_in_note(self):
        self.card()
        self.card('next', '依赖：t1\n下游')
        gaps = [{'id': 'b', 'reason': '缺样本'}, {'id': 'c', 'reason': '缺权限'}]
        result = self.delivered(reply('partial', ['a'], gaps))
        self.assertEqual(self.row(result)['state'], 'partial')
        denied = self.worker('accept', self.run_dir, 't1', '--note', '接受 b、c 缺口')
        self.assertEqual(denied.returncode, 2)
        self.assertIn('--accept-gaps', denied.stderr)
        denied = self.worker('accept', self.run_dir, 't1', '--accept-gaps', '--note', '接受 b 缺口')
        self.assertEqual(denied.returncode, 2)
        self.assertIn('c', denied.stderr)
        self.assertNotIn('review', self.read())
        accepted = self.ok('accept', self.run_dir, 't1', '--accept-gaps', '--note', '接受 b、c 缺口', '--hold')
        self.assertEqual(accepted['accepted_gaps'], gaps)
        self.assertEqual(self.read()['review']['accepted_gaps'], gaps)
        self.assertEqual(self.row(self.ok('status', self.run_dir))['state'], 'accepted')
        self.assertEqual(self.row(self.ok('status', self.run_dir), 'next')['state'], 'ready')

    def test_legacy_cards_do_not_gain_protocol_rules_or_result_fields(self):
        self.card(body='覆盖：a, b, c\n普通旧任务')
        result = self.delivered('旧卡仍可交普通正文。')
        self.assertEqual(self.row(result)['state'], 'delivered')
        self.assertNotIn('status', self.row(result))
        self.assertNotIn('result', self.read())
        prompt = (self.run_dir / 't1.prompt').read_text(encoding='utf-8')
        self.assertNotIn('result-v1', prompt)
        self.ok('accept', self.run_dir, 't1', '--note', '已抽查', '--hold')

    def test_complete_and_optional_coverage_work_in_read_and_write_modes(self):
        for write in (False, True):
            with self.subTest(write=write):
                self.run_dir = self.tmp / ('write' if write else 'read')
                (self.run_dir / 'cards').mkdir(parents=True)
                self.card(body='结果: result-v1\n可写：demo.txt\n任务')
                result = self.delivered(reply(covered=['free-id']), *(['--write'] if write else []))
                self.assertEqual(self.row(result).get('status'), 'complete')
                self.assertEqual(self.row(result)['state'], 'delivered')
                prompt = (self.run_dir / 't1.prompt').read_text(encoding='utf-8')
                for field in ('```json', 'questions', 'covered', 'skipped', 'complete/blocked/partial'):
                    self.assertIn(field, prompt)
                self.ok('accept', self.run_dir, 't1', '--note', '已抽查', '--hold')

    def test_retry_after_answers_uses_current_card_and_keeps_old_blocked_output(self):
        self.card()
        old = reply('blocked', ['a', 'b'], [{'id': 'c', 'reason': '缺样本'}], ['请补样本路径'])
        self.delivered(old)
        self.card(body='结果：result-v1\n覆盖：a, b, c\n负责人补答：样本在 fixtures/sample.txt')
        result = self.delivered(reply(), '--retry', 't1')
        self.assertEqual(self.row(result).get('status'), 'complete')
        prompt = (self.run_dir / 't1.prompt').read_text(encoding='utf-8')
        self.assertIn('负责人补答：样本在 fixtures/sample.txt', prompt)
        archives = list((self.run_dir / 'history').glob('t1-*.out'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_text(encoding='utf-8'), old)

    def test_accept_rechecks_current_output_instead_of_trusting_cached_complete(self):
        self.card()
        self.delivered(reply())
        (self.run_dir / 't1.out').write_text(reply(covered=['a']), encoding='utf-8')
        denied = self.worker('accept', self.run_dir, 't1', '--note', '看过', '--force')
        self.assertEqual(denied.returncode, 2)
        self.assertIn('协议错误', denied.stderr)
        self.assertNotIn('review', self.read())

    def test_parser_rejects_invalid_shapes_and_coverage(self):
        self.assertIsNotNone(importlib.util.find_spec('result_contract'), '缺少 result-v1 解析模块')
        import result_contract
        good = {'status': 'complete', 'covered': ['a', 'b', 'c'], 'skipped': [], 'questions': []}
        bad = [
            ({k: v for k, v in good.items() if k != 'status'}, 'status'),
            ({k: v for k, v in good.items() if k != 'covered'}, 'covered'),
            ({k: v for k, v in good.items() if k != 'skipped'}, 'skipped'),
            ({**good, 'status': 'unknown'}, 'status'),
            ({**good, 'status': 'blocked'}, 'questions'),
            ({**good, 'questions': '请补输入'}, 'questions'),
            ({**good, 'covered': ['a', 'a', 'b', 'c']}, '重复'),
            ({**good, 'covered': ['a', 'b', 'extra']}, 'extra'),
            ({**good, 'skipped': [{'id': 'a', 'reason': '重复'}]}, '重复'),
            ({**good, 'status': 'partial', 'covered': ['a', 'b'], 'skipped': [{'id': 'c', 'reason': ''}]}, 'reason'),
            ({**good, 'covered': ['a', 'b'], 'skipped': [{'id': 'c', 'reason': '尚缺'}]}, 'complete'),
            ({**good, 'status': 'partial'}, 'skipped'),
            ([], '对象'),
        ]
        for data, hint in bad:
            with self.subTest(data=data):
                parsed = result_contract.parse('```json\n' + json.dumps(data) + '\n```', ['a', 'b', 'c'])
                self.assertEqual(parsed['status'], 'protocol_error')
                self.assertIn(hint, ' '.join(parsed['errors']))
        for text in ('没有代码块', '```json\n{}\n```\n块后还有正文'):
            self.assertEqual(result_contract.parse(text)['status'], 'protocol_error')

    def test_contract_only_reads_header_and_ignores_trailing_separators(self):
        import result_contract
        contract = result_contract.from_card('# 任务\n\n结果：result-v1\n依赖：base\n覆盖：a，b、c,\n\n正文')
        self.assertEqual(contract, {'version': 'result-v1', 'expected': ['a', 'b', 'c']})
        self.assertIsNone(result_contract.from_card('普通旧任务\n```text\n结果：result-v1\n```'))
        self.assertIsNone(result_contract.from_card('覆盖：a, b, c\n正文'))

    def test_gap_note_accepts_chinese_adjacent_ids_but_not_longer_ids(self):
        import result_contract
        output = self.tmp / 'partial.out'
        output.write_text(reply('partial', [], [{'id': 'id1', 'reason': '缺样本'}]), encoding='utf-8')
        receipt = {'output': str(output), 'result_contract': {'version': 'result-v1', 'expected': ['id1']}}
        with self.assertRaisesRegex(ValueError, 'id1'):
            result_contract.acceptance(receipt, '接受 id10 缺口', True)
        self.assertEqual(result_contract.acceptance(receipt, '接受id1缺口，样本后补', True)['accepted_gaps'],
                         [{'id': 'id1', 'reason': '缺样本'}])

    def test_last_json_block_and_dispatched_coverage_are_used(self):
        import result_contract
        text = '示例：\n```json\n{"example": true}\n```\n\n' + reply()
        self.assertEqual(result_contract.parse(text, ['a', 'b', 'c'])['status'], 'complete')
        self.card()
        result = self.delivered(reply())
        self.assertEqual(self.row(result)['status'], 'complete')
        self.card(body='结果：result-v1\n覆盖：later\n执行中的卡被修改')
        receipt = self.read()
        result_contract.collect(receipt)
        self.assertEqual(receipt['result_contract']['expected'], ['a', 'b', 'c'])
        self.assertEqual(receipt['result']['status'], 'complete')


if __name__ == '__main__':
    unittest.main()
