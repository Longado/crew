"""Offline synthetic walkthrough using explicitly handwritten, validated answers."""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys

import intake
import review

NOTICE = '合成演示，使用预设分析，不调用模型'
EXAMPLES = Path(__file__).resolve().parents[2] / 'examples' / 'intake'


def preset(stage, payload):
    """Handwritten fixture, not a model result; process still validates every citation."""
    fixture = json.loads((EXAMPLES / 'demo-answers.json').read_text(encoding='utf-8'))
    return fixture[stage], {}


def main(argv=None):
    parser = argparse.ArgumentParser(description=NOTICE)
    parser.add_argument('--output', default=str(Path.home() / '.local-sensitive' / 'crew-intake-demo'))
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = intake.process([EXAMPLES / 'meeting.md'], workspace=EXAMPLES,
                                catalog=EXAMPLES / 'projects.json', output=args.output,
                                model=preset, demo=True)
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(NOTICE + '。')
            print('材料：合成访谈；项目：合成的发布说明助手。')
            print(f"已生成 {len(result['cards'])} 张卡；{result['failed']} 份未完成。")
            for entry in result['cards']:
                card_path = Path(entry['json'])
                card, sha = review.load_card(card_path)
                current = review.state(card, sha, review.load_review(card_path.parent / 'review.json'))
                for action in current['actions']:
                    print(f"{action['id']} [{review.DECISION_LABELS[action['decision']]}] {action['description']}")
                print('先看卡片：' + entry['markdown'])
                print('卡片数据：' + str(card_path))
                entrypoint = os.environ.get('CREW_INTAKE_ENTRY') or str(Path(__file__).resolve().parents[2] / 'bin/crew')
                command = shlex.quote(entrypoint) + ' intake '
                target = shlex.quote(str(card_path))
                print('查看当前决定：' + command + 'review ' + target)
                print('采纳 A1：' + command + 'review ' + target + ' --action A1 --decision accept')
                print('导出已采纳建议：' + command + 'export ' + target)
            print('本轮报告：' + result['report'])
            print('采纳不会执行建议；重复运行保留已记录的决定。')
            for error in result['errors']: print('未完成：' + error['error'], file=sys.stderr)
        return 1 if result['failed'] else 0
    except (ValueError, OSError) as error:
        print('演示未完成：' + str(error), file=sys.stderr)
        return 2
