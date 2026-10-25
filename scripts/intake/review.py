"""Local decisions over immutable intake cards; never execute suggested actions."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import sys
import intake

DECISIONS = {'accept', 'defer', 'dismiss'}
DECISION_LABELS = {'pending': '待决定', 'accept': '已采纳', 'defer': '暂缓', 'dismiss': '不相关'}


def load_card(path):
    intake.check_output_path(path)
    if path.name != 'card.json' or not path.is_file():
        raise ValueError('需要现有普通 card.json 文件')
    raw = path.read_bytes()
    try:
        card = json.loads(raw)
        for field in ('source',):
            if not isinstance(card[field], dict): raise ValueError('卡片 source 无效')
        for field in ('title', 'path', 'snapshot', 'sha256'): intake.text(card['source'][field], 20000)
        for field in ('projects', 'contexts', 'items', 'matches', 'actions', 'open_questions'):
            if not isinstance(card[field], list): raise ValueError('卡片列表无效：' + field)
        project_ids, context_ids, document_ids = set(), set(), set()
        for p in card['projects']:
            if type(p['id']) is not int or p['id'] <= 0 or p['id'] in project_ids: raise ValueError('项目编号无效或重复')
            project_ids.add(p['id'])
            intake.text(p['name'])
            if not isinstance(p['tasks'], list): raise ValueError('项目 tasks 无效')
        for c in card['contexts']:
            if type(c['project_id']) is not int or c['project_id'] not in project_ids or c['project_id'] in context_ids or not isinstance(c['documents'], list): raise ValueError('项目 context 无效或重复')
            context_ids.add(c['project_id'])
            for d in c['documents']:
                intake.text(d['id']); intake.text(d['path'], 20000)
                if d['id'] in document_ids: raise ValueError('项目文档编号重复')
                document_ids.add(d['id'])
                if not isinstance(d['lines'], list): raise ValueError('项目原文行无效')
        evidence_ids = set()
        for item in card['items']:
            intake.text(item['id'])
            if item['id'] in evidence_ids: raise ValueError('材料事项编号重复')
            evidence_ids.add(item['id'])
            e = item['evidence']
            if type(e['start']) is not int or type(e['end']) is not int or not 1 <= e['start'] <= e['end']: raise ValueError('材料行号无效')
            intake.text(e['quote'], 20000)
        intake.validate_card({k: card[k] for k in ('matches', 'actions', 'open_questions')}, card, card['contexts'], card['projects'])
    except (KeyError, TypeError, AttributeError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError('坏卡片：' + str(error)) from error
    return card, intake.digest(raw)


def load_review(path):
    intake.check_output_path(path)
    if not path.exists(): return {'version': 1, 'events': []}
    try:
        data = json.loads(path.read_bytes())
        if not isinstance(data, dict) or set(data) != {'version', 'events'} or type(data['version']) is not int or data['version'] != 1 or not isinstance(data['events'], list):
            raise ValueError('需要 version=1 与 events 数组')
        for e in data['events']:
            if not isinstance(e, dict) or set(e) != {'card_sha256', 'action', 'decision', 'note', 'at'}: raise ValueError('事件字段无效')
            if not isinstance(e['card_sha256'], str) or not re.fullmatch('[0-9a-f]{64}', e['card_sha256']): raise ValueError('事件哈希无效')
            if not isinstance(e['action'], str) or not re.fullmatch('A[1-9][0-9]*', e['action']) or e['decision'] not in DECISIONS: raise ValueError('事件决定无效')
            if not isinstance(e['note'], str) or len(e['note']) > 4000: raise ValueError('事件说明无效')
            if not isinstance(e['at'], str) or dt.datetime.fromisoformat(e['at']).tzinfo is None: raise ValueError('事件时间无效')
        return data
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('坏 review.json，不会覆盖：' + str(error)) from error


def state(card, sha, review):
    actions = []
    for index, action in enumerate(card['actions'], 1):
        aid = f'A{index}'
        events = [e for e in review['events'] if e['card_sha256'] == sha and e['action'] == aid]
        current = events[-1] if events else {'decision': 'pending', 'note': ''}
        actions.append({'id': aid, **action, 'decision': current['decision'], 'note': current['note']})
    return {**({'mode': 'demo'} if card.get('mode') == 'demo' else {}), 'card_sha256': sha, 'actions': actions, 'history': review['events']}


def literal(value):
    # Render untrusted material as literal data, including newlines, markup and terminal controls.
    return json.dumps(str(value), ensure_ascii=False).replace('<', '&lt;').replace('>', '&gt;').replace('`', '\\`').replace('[', '\\[').replace(']', '\\]')


def exported(card, current):
    names = {p['id']: p['name'] for p in card['projects']}
    docs = {d['id']: d for c in card['contexts'] for d in c['documents']}
    result = []
    for a in current['actions']:
        if a['decision'] != 'accept': continue
        refs = [dict(r, path=docs[r['doc_id']]['path'], project_id=m['project_id']) for m in card['matches'] if m['project_id'] in a['project_ids'] for r in m['context_refs']]
        result.append({**a, 'projects': [names[p] for p in a['project_ids']], 'source': card['source'],
                       'evidence': [item['evidence'] for item in card['items'] if item['id'] in a['evidence_ids']], 'context_refs': refs})
    return {**({'mode': 'demo'} if card.get('mode') == 'demo' else {}), 'status': '已采纳建议，尚未执行', 'card_sha256': current['card_sha256'], 'actions': result}


def main(argv=None):
    parser = argparse.ArgumentParser(description='逐条决定建议或导出已采纳建议；不执行、不建任务。')
    parser.add_argument('command', choices=['review', 'export'])
    parser.add_argument('card', type=Path)
    parser.add_argument('--action')
    parser.add_argument('--decision', choices=sorted(DECISIONS))
    parser.add_argument('--note', default=None)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--format', choices=['markdown', 'json'], default='markdown')
    args = parser.parse_args(argv)
    if bool(args.action) != bool(args.decision): parser.error('--action 与 --decision 必须成对')
    if args.note is not None and not args.action: parser.error('--note 需要 --action 与 --decision')
    if args.note is not None and len(args.note) > 4000: parser.error('--note 最多 4000 字')
    if args.command == 'export' and (args.action or args.json or args.note is not None): parser.error('export 只接受 --format')
    try:
        path = args.card.expanduser().absolute()
        card, sha = load_card(path)
        review_path = path.parent / 'review.json'
        review = load_review(review_path)
        if args.action:
            if args.action not in {f'A{i}' for i in range(1, len(card['actions']) + 1)}: raise ValueError('未知动作编号：' + args.action)
            with intake.output_lock(path.parent):
                card, sha = load_card(path)
                review = load_review(review_path)
                if args.action not in {f'A{i}' for i in range(1, len(card['actions']) + 1)}: raise ValueError('未知动作编号：' + args.action)
                review['events'].append({'card_sha256': sha, 'action': args.action, 'decision': args.decision, 'note': args.note or '', 'at': dt.datetime.now(dt.timezone.utc).isoformat()})
                intake.json_write(review_path, review)
        current = state(card, sha, review)
        if card.get('mode') == 'demo' and not (args.json or (args.command == 'export' and args.format == 'json')):
            print('合成演示，使用预设分析，不调用模型。')
        if args.command == 'review':
            if args.json: print(json.dumps(current, ensure_ascii=False, indent=2))
            else:
                names = {p['id']: p['name'] for p in card['projects']}
                print('建议决定（仅记录选择，尚未执行；引号内容为材料数据）')
                for a in current['actions']:
                    print(f"{a['id']} [{DECISION_LABELS[a['decision']]}] 项目：{literal('、'.join(names[p] for p in a['project_ids']) or '无')} 建议：{literal(a['description'])} 说明：{literal(a['note'])}")
                if not current['actions']: print('本卡没有建议动作。')
        else:
            data = exported(card, current)
            if args.format == 'json': print(json.dumps(data, ensure_ascii=False, indent=2))
            else:
                print('# 已采纳建议，尚未执行\n\n以下引号内容均为材料数据。')
                if not data['actions']: print('\n当前版本没有已采纳建议。')
                for a in data['actions']:
                    print(f"\n## {a['id']}\n\n项目：{literal('、'.join(a['projects']) or '无')}\n\n建议：{literal(a['description'])}\n\n理由：{literal(a['why_now'])}\n\n用户说明：{literal(a['note'])}\n\n材料：{literal(a['source']['path'])}；快照：{literal(a['source']['snapshot'])}")
                    for e in a['evidence']: print(f"\n材料原文 L{e['start']}–{e['end']}：{literal(e['quote'])}")
                    for r in a['context_refs']: print(f"\n项目依据 {literal(r['path'])} L{r['start']}–{r['end']}：{literal(r['quote'])}")
        return 0
    except (ValueError, OSError) as error:
        print('建议处理未完成：' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__': sys.exit(main())
