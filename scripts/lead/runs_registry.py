"""负责人运行的本机入口；登记追加，读取不改回执、不触发调度。

  python3 scripts/lead/runs_registry.py list
  CREW_HOME 可覆盖默认的 ~/.crew；看板与命令行共用 read_runs。
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path


def registry_path():
    return Path(os.environ.get('CREW_HOME', '~/.crew')).expanduser() / 'lead-runs.jsonl'


def records(text):
    """读取时容忍尚未追加完的行，也兼容旧登记中的重复目录。"""
    seen = set()
    for line in text.splitlines():
        try:
            row = json.loads(line)
            if not isinstance(row, dict) or not isinstance(row.get('dir'), str):
                continue
            directory = str(Path(row['dir']).expanduser().resolve())
            if directory in seen:
                continue
            seen.add(directory)
            yield {**row, 'dir': directory}
        except (ValueError, OSError):
            continue


def register(directory, goal=None):
    """同一本机目录只登记一次；并发派单共用追加文件锁。"""
    root = Path(directory).resolve()
    path = registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.seek(0)
        text = stream.read()
        if any(row['dir'] == str(root) for row in records(text)):
            return
        try:
            meta = json.loads((root / 'run.json').read_text(encoding='utf-8'))
            if not isinstance(meta, dict):
                meta = {}
        except (OSError, ValueError):
            meta = {}
        row = {'dir': str(root), 'goal': goal or meta.get('goal', ''),
               'created_at': meta.get('created_at') or dt.datetime.now().astimezone().isoformat(timespec='milliseconds')}
        if text and not text.endswith('\n'):
            stream.write('\n')
        stream.write(json.dumps(row, ensure_ascii=False) + '\n')


def elapsed(receipt):
    if receipt.get('seconds') is not None:
        return receipt['seconds']
    if not receipt.get('started_at'):
        return None
    # 失联不等于执行者仍在跑；无结束时间时，不把失联后的等待算成执行耗时。
    if receipt.get('state') != 'running' and not receipt.get('ended_at'):
        return None
    start = dt.datetime.fromisoformat(receipt['started_at'])
    end = dt.datetime.fromisoformat(receipt['ended_at']) if receipt.get('ended_at') else dt.datetime.now().astimezone()
    return round(max(0, (end - start).total_seconds()), 1)


def read_run(record):
    # 只复用纯读取方法；不要调用 lab 的 status（会重写 ledger）或 wait（会写 notified）。
    from worker import Run, read_json
    root = Path(record['dir'])
    row = {**record, 'status': 'available', 'cards': []}
    if not root.is_dir():
        return {**row, 'status': 'moved'}
    try:
        run = Run(root)
        meta = read_json(root / 'run.json') or {}
        row.update(goal=meta.get('goal') or record.get('goal', ''),
                   created_at=meta.get('created_at') or record.get('created_at'))
        cards = run.cards()
        for name, card in cards.items():
            receipt = run.receipt(name) or {}
            state = run.state(name, cards)
            seconds = elapsed(receipt) if state != 'lost' or receipt.get('ended_at') else receipt.get('seconds')
            summary = ''
            if receipt.get('output') and state not in ('ready', 'waiting', 'running'):
                summary = run.conclusion(name)
                # ponytail: 展示结论卡摘录；完整交付仍由负责人在运行目录打开。
                if len(summary) > 2400:
                    summary = summary[:2400] + '\n…（摘录，完整结论见交付文件）'
            row['cards'].append({'card': name, 'deps': card['deps'], 'state': state,
                                 'seconds': seconds, 'tokens': receipt.get('tokens'),
                                 'review': receipt.get('review'), 'output': receipt.get('output'),
                                 'ended_at': receipt.get('ended_at'), 'conclusion': summary})
    except (OSError, ValueError, KeyError, TypeError) as error:
        row.update(status='error', error='运行记录暂不可读：' + str(error))
    return row


def read_runs():
    """看板和 CLI 的共同快照；未登记时返回空列表，不创建任何文件。"""
    try:
        text = registry_path().read_text(encoding='utf-8')
    except FileNotFoundError:
        return []
    return [read_run(record) for record in reversed(list(records(text)))]


LABELS = {'ready': '可派', 'waiting': '等待依赖', 'running': '执行中', 'delivered': '待验收',
          'accepted': '已验收', 'rejected': '已退回', 'stale': '验收失效', 'lost': '看守失联',
          'failed': '失败', 'timed_out': '超时', 'stopped': '已停止', 'blocked': '缺输入', 'partial': '部分交付'}


def print_runs(rows):
    if not rows:
        print('暂无负责人运行；首次 worker run 后自动登记。')
    for row in rows:
        print(f"\n目标：{row.get('goal') or '未填写目标'}\n目录：{row['dir']}\n创建：{row.get('created_at') or '未知'}")
        if row['status'] != 'available':
            print('已移走' if row['status'] == 'moved' else row['error'])
            continue
        print('卡片\t状态\t已跑秒数\t本次 tokens\t验收结论')
        for card in row['cards']:
            review = card['review'] or {}
            verdict = LABELS.get(review.get('verdict'), review.get('verdict', '未验收'))
            note = str(review.get('note') or '').replace('\n', ' ')
            seconds = '未知' if card['seconds'] is None else str(card['seconds'])
            tokens = '未知' if card['tokens'] is None else str(card['tokens'])
            print(f"{card['card']}\t{LABELS.get(card['state'], card['state'])}\t{seconds}\t{tokens}\t{verdict} {note}".rstrip())
            if card['conclusion']:
                print(card['conclusion'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list'])
    parser.parse_args()
    print_runs(read_runs())


if __name__ == '__main__':
    main()
