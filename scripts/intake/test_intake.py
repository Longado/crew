import importlib.util
import json
import re
from urllib.parse import unquote
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock


class IntakeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crew-intake-test-')
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.project = self.workspace / 'project'
        self.project.mkdir()
        (self.project / 'HANDOFF.md').write_text('# 当前交接\n当前只做可回查的取数工具。\n')
        self.database = self.workspace / 'tasks.db'
        with sqlite3.connect(self.database) as db:
            db.executescript('CREATE TABLE projects (id INTEGER,name TEXT,status TEXT,description TEXT,local_path TEXT); CREATE TABLE tasks (id INTEGER,project_id INTEGER,title TEXT,status TEXT);')
            db.execute('INSERT INTO projects VALUES(1,?,?,?,?)', ('合成项目', 'active', '提供可回查的取数工具', 'project'))
            db.execute('INSERT INTO tasks VALUES(7,1,?,?)', ('已有的取数验收', 'todo'))
        self.source = self.workspace / '分享.txt'
        self.source.write_text('合成分享\n发言人 1 00:01:00\n讲者称：生成报告很快，但核实报告更费时间。\n发言人 1 00:02:00\n未来可以考虑自动执行，这只是一个设想。\n')
        self.output = self.root / 'private'
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def module(self):
        path = Path(__file__).with_name('intake.py')
        self.assertTrue(path.exists(), '材料自动处理入口尚未实现')
        spec = importlib.util.spec_from_file_location('crew_intake', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def analysis(self):
        return {'summary': ['讲者讨论报告核实。', '后面提出自动执行设想。', '材料没有提供实际结果。'],
                'identity_note': '仅按正文称为合成分享',
                'items': [{'id': 'E1', 'kind': 'speaker_claim', 'point': '讲者认为核实成本值得关注。',
                           'evidence': {'start': 3, 'end': 3, 'quote': '生成报告很快，但核实报告更费时间'}}],
                'candidates': [{'project_id': 1, 'reason': '涉及可回查的取数结果', 'evidence_ids': ['E1']}]}

    def model(self, stage, payload):
        self.calls.append((stage, payload))
        if stage == 'analyze':
            return self.analysis(), {'input_tokens': 10, 'output_tokens': 10}
        doc = next(x for x in payload['contexts'][0]['documents'] if x['path'].endswith('HANDOFF.md'))
        return {'matches': [{'project_id': 1, 'reason': '与当前取数工具的核实需要相接',
                             'use': '对照已有验收中的结果回查', 'evidence_ids': ['E1'],
                             'context_refs': [{'doc_id': doc['id'], 'start': 2, 'end': 2,
                                               'quote': '当前只做可回查的取数工具'}]}],
                'actions': [{'kind': 'reference', 'project_ids': [1], 'description': '留作已有验收参考',
                             'why_now': '已有对应任务，无需重复创建', 'evidence_ids': ['E1'], 'existing_task_ids': [7]}],
                'open_questions': ['讲者没有提供核实耗时的测量方法。']}, {'input_tokens': 10, 'output_tokens': 10}

    def run_process(self, model=None):
        return self.module().process([self.source], workspace=self.workspace, database=self.database,
                                     output=self.output, focus='先改材料处理，不开展客户跟进', model=model or self.model)

    def json_catalog(self, data=None):
        path = self.workspace / 'projects.json'
        path.write_text(json.dumps(data if data is not None else {'version': 1, 'projects': [
            {'id': 1, 'name': '合成项目', 'path': 'project'}]}, ensure_ascii=False))
        return path

    def test_catalog_plan_and_flow_preserve_sources_and_citations(self):
        mod = self.module()
        path = self.json_catalog()
        before = self.source.read_bytes(), path.read_bytes()
        plan = mod.plan([self.source], workspace=self.workspace, catalog=path, output=self.output)
        self.assertEqual(plan['project_count'], 1)
        self.assertFalse(self.output.exists())
        def model(stage, payload):
            data, usage = self.model(stage, payload)
            if stage == 'relate': data['actions'][0]['existing_task_ids'] = []
            return data, usage
        result = mod.process([self.source], workspace=self.workspace, catalog=path, output=self.output, model=model)
        self.assertEqual(result['failed'], 0)
        card = json.loads(Path(result['cards'][0]['json']).read_text())
        self.assertEqual(card['items'][0]['evidence']['quote'], self.analysis()['items'][0]['evidence']['quote'])
        self.assertIn('HANDOFF.md', Path(result['cards'][0]['markdown']).read_text())
        self.assertEqual(before, (self.source.read_bytes(), path.read_bytes()))
        self.assertEqual(Path(card['source']['snapshot']).read_bytes(), before[0])

    def test_markdown_links_resolve_with_chinese_spaces_and_parentheses(self):
        moved = self.workspace / '中文 项目(一)'
        self.project.rename(moved)
        self.project = moved
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE projects SET local_path=?', (moved.name,))
        renamed = self.workspace / '中文 材料(一).txt'
        self.source.rename(renamed)
        self.source = renamed
        self.output = self.root / '私有 输出(一)'
        result = self.run_process()
        self.assertEqual(result['failed'], 0)
        for markdown in [Path(result['report']), Path(result['cards'][0]['markdown'])]:
            links = re.findall(r'\]\((?:<([^>]+)>|([^ )]+))\)', markdown.read_text())
            self.assertTrue(links)
            for angled, plain in links:
                target = unquote(angled or plain)
                self.assertTrue((markdown.parent / target).resolve().is_file(), target)
                if markdown.name == 'card.md':
                    self.assertFalse(Path(target).is_absolute(), target)
        card = Path(result['cards'][0]['markdown']).read_text()
        self.assertIn('L3–3', card)
        self.assertIn('当前只做可回查的取数工具', card)

    def test_corrupt_caches_recover_only_affected_stage_and_keep_raw_diagnostics(self):
        for stage, corruption in [('analyze', b'{broken'), ('relate', b'null'),
                                  ('analyze', b'{"answer": {}, "usage": {}}'),
                                  ('relate', b'{"answer": {}, "usage": []}')]:
            with self.subTest(stage=stage, corruption=corruption):
                self.output = self.root / ('run-' + str(len(self.calls)))
                first = self.run_process()
                card = Path(first['cards'][0]['markdown'])
                before = card.read_bytes(), card.stat().st_mtime_ns
                cache = next((self.output / 'cache').glob(stage + '-*.json'))
                cache.write_bytes(corruption)
                start = len(self.calls)
                result = self.run_process()
                self.assertEqual(result['failed'], 0)
                self.assertEqual([call[0] for call in self.calls[start:]], [stage])
                self.assertEqual((card.read_bytes(), card.stat().st_mtime_ns), before)
                recovery = result['cache_recoveries'][0]
                self.assertEqual(recovery['stage'], stage)
                self.assertTrue(recovery['error'])
                self.assertEqual(Path(recovery['raw']).read_bytes(), corruption)
                diagnostic = json.loads(Path(recovery['diagnostic']).read_text())
                self.assertEqual(diagnostic['error'], recovery['error'])
                self.assertEqual(self.run_process()['model_calls'], 0)
                self.assertEqual(Path(recovery['raw']).read_bytes(), corruption)

    def test_cache_io_failure_does_not_call_model_or_claim_recovery(self):
        self.run_process()
        read_bytes = Path.read_bytes
        def denied(path):
            if path.parent.name == 'cache':
                raise PermissionError('cache permission denied')
            return read_bytes(path)
        with mock.patch.object(Path, 'read_bytes', denied):
            result = self.run_process()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['model_calls'], 0)
        self.assertEqual(result['cache_recoveries'], [])
        self.assertFalse((self.output / 'rejected').exists())
        self.assertIn('permission denied', result['errors'][0]['error'])

    def test_cache_usage_schema_and_repeated_rejections_keep_each_copy(self):
        self.run_process()
        cache = next((self.output / 'cache').glob('analyze-*.json'))
        data = json.loads(cache.read_text())
        data['usage'] = []
        raw = json.dumps(data).encode()
        records = []
        for _ in range(2):
            cache.write_bytes(raw)
            result = self.run_process()
            self.assertEqual(result['failed'], 0)
            self.assertEqual(result['model_calls'], 1)
            records.append(result['cache_recoveries'][0])
        self.assertNotEqual(records[0]['raw'], records[1]['raw'])
        for record in records:
            self.assertEqual(Path(record['raw']).read_bytes(), raw)
            self.assertIn('usage', record['error'])

    def test_rejected_symlink_blocks_recovery_without_model_call(self):
        self.run_process()
        cache = next((self.output / 'cache').glob('analyze-*.json'))
        cache.write_bytes(b'broken')
        outside = self.root / 'outside-rejections'
        outside.mkdir()
        (self.output / 'rejected').symlink_to(outside, target_is_directory=True)
        result = self.run_process()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['model_calls'], 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_cached_citation_recovers_and_failed_replacement_does_not_retry(self):
        self.run_process()
        cache = next((self.output / 'cache').glob('analyze-*.json'))
        data = json.loads(cache.read_text())
        data['answer']['items'][0]['evidence']['quote'] = '根本不存在于材料中的句子'
        cache.write_text(json.dumps(data))
        raw = cache.read_bytes()
        def bad(stage, payload):
            self.calls.append((stage, payload))
            return data['answer'], {}
        result = self.run_process(bad)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['model_calls'], 1)
        self.assertEqual(Path(result['cache_recoveries'][0]['raw']).read_bytes(), raw)
        self.assertEqual(len(list((self.output / 'cards').glob('*/card.json'))), 1)
        self.assertEqual(len(list((self.output / 'rejected').glob('*.json'))), 2)

    def test_catalog_validation_and_defaults(self):
        mod = self.module()
        project = {'id': 1, 'name': '合成项目', 'path': 'project'}
        valid = {'version': 1, 'projects': [project]}
        got = mod.read_json_catalog(self.json_catalog(valid))[0]
        self.assertEqual((got['status'], got['description'], got['local_path'], got['tasks']), ('active', '', 'project', []))
        invalid = [[], {}, {'version': True, 'projects': [project]},
            {'version': 2, 'projects': [project]}, {**valid, 'extra': 1},
            {'version': 1, 'projects': []}, {'version': 1, 'projects': [project] * 201},
            {'version': 1, 'projects': [project, project]}]
        for field, value in [('id', True), ('id', 0), ('id', 1.5), ('name', ''), ('name', 8), ('path', ' '), ('path', None),
                             ('description', 3), ('status', 'done'), ('status', ['active']), ('unknown', 'x')]:
            invalid.append({'version': 1, 'projects': [{**project, field: value}]})
        for data in invalid:
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, '项目目录'):
                mod.read_json_catalog(self.json_catalog(data))
        path = self.json_catalog()
        for raw in ['null', '{broken', ' ' * 600001, json.dumps({'version': 1, 'projects': [{**project, 'description': '文' * 150001}]}, ensure_ascii=False)]:
            path.write_text(raw)
            with self.assertRaisesRegex(ValueError, '项目目录'): mod.read_json_catalog(path)
        path.write_bytes(b'\xff')
        with self.assertRaisesRegex(ValueError, '项目目录'): mod.read_json_catalog(path)
        outside = self.root / 'outside'; outside.mkdir()
        (outside / 'HANDOFF.md').write_text('不应读取的外部文档内容')
        projects = mod.read_json_catalog(self.json_catalog({'version': 1, 'projects': [{**project, 'path': str(outside)}]}))
        context = mod.project_context(projects[0], self.workspace)
        self.assertEqual(len(context['documents']), 1)
        self.assertTrue(context['warnings'])
        with self.assertRaisesRegex(ValueError, '互斥'):
            mod.plan([self.source], workspace=self.workspace, database=self.database, catalog=path, output=self.output)

    def test_full_flow_is_readonly_and_cites_source_and_project(self):
        before_db = self.database.read_bytes()
        before_source = self.source.read_bytes()
        result = self.run_process()
        self.assertEqual(result['failed'], 0)
        self.assertEqual(len(self.calls), 2)
        self.assertIn('report', result, '一次处理需要一个可以直接打开的结果入口')
        self.assertIn('待确认', Path(result['report']).read_text())
        card = json.loads(Path(result['cards'][0]['json']).read_text())
        self.assertEqual(card['state'], 'pending_review')
        self.assertEqual(card['actions'][0]['kind'], 'reference')
        report = Path(result['cards'][0]['markdown']).read_text()
        self.assertIn('原文', report)
        self.assertIn('HANDOFF.md', report)
        self.assertEqual(self.database.read_bytes(), before_db)
        self.assertEqual(self.source.read_bytes(), before_source)
        self.assertEqual(Path(result['cards'][0]['json']).stat().st_mode & 0o777, 0o600)

    def test_repeat_reuses_model_results_and_dedupes_content(self):
        first = self.run_process()
        duplicate = self.workspace / '复制.txt'
        duplicate.write_bytes(self.source.read_bytes())
        result = self.module().process([self.source, duplicate], workspace=self.workspace, database=self.database,
                                       output=self.output, focus='先改材料处理，不开展客户跟进', model=self.model)
        self.assertEqual(len(result['cards']), 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(result['cards'][0]['json'], first['cards'][0]['json'])
        self.assertEqual(result['model_calls'], 0)

    def test_handoff_change_invalidates_only_second_stage(self):
        self.run_process()
        with (self.project / 'HANDOFF.md').open('a') as f:
            f.write('本轮保留说明，新一轮另行判断。\n')
        self.run_process()
        self.assertEqual([x[0] for x in self.calls], ['analyze', 'relate', 'relate'])
        self.assertEqual(len(list((self.output / 'cards').glob('*/card.json'))), 2)

    def test_focus_change_requires_new_analysis(self):
        self.run_process()
        self.module().process([self.source], workspace=self.workspace, database=self.database,
                              output=self.output, focus='仅保留学习参考', model=self.model)
        self.assertEqual(len(self.calls), 4)

    def test_invalid_quote_is_failed_not_a_success_card(self):
        def bad(stage, payload):
            answer = self.analysis()
            answer['items'][0]['evidence']['quote'] = '不存在于原文里的一个说法'
            return answer, {}
        result = self.run_process(bad)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['cards'], [])
        self.assertFalse(list((self.output / 'cards').glob('*/card.json')))
        rejected = list((self.output / 'rejected').glob('*.json'))
        self.assertEqual(len(rejected), 1, '不合格模型结果需要保留以便诊断，不能当成功卡')
        self.assertIn('无法对回', json.loads(rejected[0].read_text())['error'])

    def test_unknown_project_is_rejected(self):
        def bad(stage, payload):
            answer = self.analysis()
            answer['candidates'][0]['project_id'] = 999
            return answer, {}
        self.assertEqual(self.run_process(bad)['failed'], 1)

    def test_unknown_context_and_task_are_rejected(self):
        for field in ['context', 'task', 'extra']:
            with self.subTest(field=field):
                output = self.root / field
                def bad(stage, payload):
                    data, usage = self.model(stage, payload)
                    if stage == 'relate':
                        if field == 'context': data['matches'][0]['context_refs'][0]['quote'] = '模型自己编的当前决定'
                        elif field == 'task': data['actions'][0]['existing_task_ids'] = [999]
                        else: data['actions'][0]['status'] = 'done'
                    return data, usage
                result = self.module().process([self.source], workspace=self.workspace, database=self.database,
                                               output=output, model=bad)
                self.assertEqual(result['failed'], 1)
                self.assertEqual(result['cards'], [])

    def test_no_project_match_still_produces_reference_card(self):
        def no_match(stage, payload):
            if stage == 'analyze':
                data = self.analysis(); data['candidates'] = []
            else:
                data = {'matches': [], 'actions': [{'kind': 'defer', 'project_ids': [],
                        'description': '暂不处理', 'why_now': '未找到当前项目用途',
                        'evidence_ids': ['E1'], 'existing_task_ids': []}], 'open_questions': []}
            return data, {}
        result = self.run_process(no_match)
        self.assertEqual(result['failed'], 0)
        self.assertEqual(json.loads(Path(result['cards'][0]['json']).read_text())['matches'], [])

    def test_useful_material_can_have_no_suggested_action(self):
        def no_action(stage, payload):
            data, usage = self.model(stage, payload)
            if stage == 'relate': data['actions'] = []
            return data, usage
        result = self.run_process(no_action)
        self.assertEqual(result['failed'], 0)
        self.assertIn('本轮不建议新增动作', Path(result['cards'][0]['markdown']).read_text())

    def test_project_paths_cannot_read_outside_workspace(self):
        outside = self.root / 'outside'
        outside.mkdir(); (outside / 'HANDOFF.md').write_text('外部敏感文件')
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE projects SET local_path=?', (str(outside),))
        mod = self.module()
        catalog = mod.read_catalog(self.database)
        contexts = mod.project_context(catalog[0], self.workspace)
        self.assertFalse(any(x['path'].endswith('HANDOFF.md') for x in contexts['documents']))
        self.assertTrue(contexts['warnings'])

    def test_directory_nonrecursive_and_invalid_inputs_fail(self):
        mod = self.module()
        directory = self.workspace / 'inbox'; directory.mkdir()
        (directory / 'one.txt').write_bytes(self.source.read_bytes())
        (directory / 'skip.pdf').write_bytes(b'%PDF')
        nested = directory / 'nested'; nested.mkdir(); (nested / 'two.txt').write_text('not requested')
        self.assertEqual(len(mod.read_sources([directory])), 1)
        for path in [directory / 'skip.pdf', self.workspace / 'absent.txt']:
            with self.assertRaises(ValueError): mod.read_sources([path])
        (directory / 'link.txt').symlink_to(self.source)
        with self.assertRaises(ValueError): mod.read_sources([directory])

    def test_dry_run_has_no_model_or_filesystem_writes(self):
        mod = self.module()
        plan = mod.plan([self.source], workspace=self.workspace, database=self.database, output=self.output)
        self.assertEqual(plan['max_model_calls'], 2)
        self.assertEqual(plan['action'], 'plan-only')
        self.assertFalse(self.output.exists())

    def test_subscription_model_disables_tools_and_does_not_forward_api_credentials(self):
        mod = self.module()
        log = self.root / 'invocations.jsonl'
        binary = self.root / 'claude-fixture'
        binary.write_text('#!/usr/bin/env python3\nimport json,sys,os\n'
            f'log={str(log)!r}\n'
            'with open(log,"a") as f: f.write(json.dumps({"args":sys.argv[1:],"api_key_forwarded":"ANTHROPIC_API_KEY" in os.environ})+"\\n")\n'
            'if sys.argv[1:]==["auth","status"]: print(json.dumps({"loggedIn":True,"authMethod":"claude.ai","apiProvider":"firstParty"}))\n'
            'else:\n sys.stdin.read()\n print(json.dumps({"subtype":"success","is_error":False,"result":"{}","usage":{"input_tokens":4}}))\n')
        binary.chmod(0o755)
        with mock.patch.dict('os.environ', {'CREW_CLAUDE_BIN': str(binary), 'ANTHROPIC_API_KEY': 'fixture-not-a-key'}):
            model = mod.ClaudeModel()
            answer, usage = model('analyze', {'source': 'fixture'})
            model('relate', {'source': 'fixture'})
        self.assertEqual(answer, {})
        self.assertEqual(usage, {'input_tokens': 4})
        invocations = [json.loads(x) for x in log.read_text().splitlines()]
        self.assertEqual(len(invocations), 3)
        self.assertFalse(any(x['api_key_forwarded'] for x in invocations))
        for call in invocations[1:]:
            args = call['args']
            self.assertEqual(args[args.index('--tools') + 1], '')
            self.assertIn('--safe-mode', args)
            self.assertIn('--no-session-persistence', args)

    def test_failed_model_keeps_other_completed_cards_and_no_automatic_retry(self):
        second = self.workspace / '第二份.txt'
        second.write_text('另一份材料\n关于完全不同的问题\n')
        def model(stage, payload):
            if stage == 'analyze' and payload['source']['title'] == '另一份材料':
                self.calls.append((stage, payload))
                raise ValueError('模型不可用')
            return self.model(stage, payload)
        mod = self.module()
        result = mod.process([self.source, second], workspace=self.workspace, database=self.database,
                             output=self.output, model=model)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(len(result['cards']), 1)
        self.assertEqual(len(self.calls), 3)

    def test_output_symlink_cannot_send_source_copy_outside_output(self):
        outside = self.root / 'elsewhere'; outside.mkdir()
        self.output.mkdir()
        (self.output / 'sources').symlink_to(outside, target_is_directory=True)
        result = self.run_process()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_summary_is_text_not_an_injected_markdown_link(self):
        def model(stage, payload):
            data, usage = self.model(stage, payload)
            if stage == 'analyze': data['summary'][0] = '[外部链接](https://example.invalid)'
            return data, usage
        result = self.run_process(model)
        self.assertIn('\\[外部链接\\]', Path(result['report']).read_text())


if __name__ == '__main__':
    unittest.main()
