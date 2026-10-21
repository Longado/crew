"""私人改进记录：独占新建，串行、原子重建索引。只用标准库。

  notes.py index --dir 记录目录
  notes.py new --dir 记录目录 --agent 记录者 --topic 英文短名 --title 标题
               [--theme 主题] [--relates 旧记录ID] [--run 运行目录]
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

REQUIRED = ('ID', '日期', '记录者', '主题', '状态', '来源', '关联')
STATES = {'建议', '已采用待验证', '已验证', '未采用', '已撤回'}


@contextmanager
def index_lock(base):
    base.mkdir(parents=True, exist_ok=True)
    with (base / '.index.lock').open('a', encoding='utf-8') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def cell(value):
    return value.replace('|', '\\|').replace('\n', ' ')


def build_locked(base):
    """调用者持有同一把锁；读取记录也必须在锁内，避免旧快照盖掉新索引。"""
    rows, ids = [], set()
    for path in sorted((base / 'notes').glob('*.md'), reverse=True):
        content = path.read_text(encoding='utf-8')
        header = content.split('\n## ', 1)[0]
        fields = dict(re.findall(r'^([^:\n]+):[ \t]*(.*)$', header, re.M))
        missing = [key for key in REQUIRED if not fields.get(key, '').strip()]
        if missing or fields.get('状态') not in STATES:
            raise ValueError(f'{path.name}: 缺少字段{missing}或状态不合法')
        if fields['ID'] in ids:
            raise ValueError(f"重复ID: {fields['ID']}")
        ids.add(fields['ID'])
        title = next((line[2:] for line in content.splitlines() if line.startswith('# ')), path.stem)
        rows.append(f"| {cell(fields['日期'])} | {cell(fields['主题'])} | "
                    f"[{cell(title)}](notes/{path.name}) | {cell(fields['状态'])} | "
                    f"{cell(fields['来源'])} | {cell(fields['关联'])} |")
    # ponytail: 保留原生成器署名和排版，旧 build_log.py 薄壳迁移后仍能逐字节对账。
    text = '\n'.join([
        '# 编排改进日志', '', '由build_log.py生成；原始记录在notes/。使用方法与记录模板见[README](README.md)。',
        '新记录修正旧判断时，通过关联ID追溯；此表保留各记录当时的状态，不替代项目当前交接卡。', '',
        '| 日期 | 主题 | 学到什么／记录 | 记录状态 | 来自哪段对话 | 关联 |',
        '|---|---|---|---|---|---|', *rows, ''])
    fd, temporary = tempfile.mkstemp(prefix='.index-', dir=base)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(text)
        os.replace(temporary, base / 'LOG.md')
    finally:
        Path(temporary).unlink(missing_ok=True)
    return len(rows)


def build(base):
    base = Path(base)
    with index_lock(base):
        return build_locked(base)


def read_object(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError(f'{path}: 应是 JSON 对象')
    return data


def inline(value, fallback='未记录'):
    return ' '.join(str(value).splitlines()).strip() if value is not None and str(value).strip() else fallback


def run_source(run):
    run = Path(run).resolve()
    meta = read_object(run / 'run.json')
    if not (run / 'cards').is_dir():
        raise ValueError(f'运行目录里没有 cards/：{run}')
    parts = [f'运行目录: {run}', f"goal: {inline(meta.get('goal'), '未填写')}",
             f"创建时间: {inline(meta.get('created_at'))}"]
    # ponytail: 只取当前卡回执，不扫描聊天或历史重试；finished 不等于验收通过。
    for card in sorted((run / 'cards').glob('*.md')):
        path = run / f'{card.stem}.json'
        receipt = read_object(path) if path.is_file() else {}
        review = receipt.get('review') or {}
        if not isinstance(review, dict):
            raise ValueError(f'{path}: review 应是 JSON 对象')
        parts.append(f"卡名: {inline(card.stem)}；会话 ID: {inline(receipt.get('session_id'))}；"
                     f"验收: {inline(review.get('verdict'), '未验收')}")
        if review.get('note'):
            parts.append(f"验收说明: {inline(review['note'])}")
    metrics = run / 'metrics.json'
    if metrics.is_file():
        parts.append(f'metrics.json: {metrics}')
    return '；'.join(parts)


def single_line(value, label):
    if not value.strip() or '\n' in value or '\r' in value:
        raise ValueError(f'{label}须为非空单行文本')
    return value.strip()


def new(base, agent, topic, title, theme='其他', relates='无', run=None):
    agent, topic, title, theme, relates = [single_line(value, label) for value, label in
                                          ((agent, '记录者'), (topic, '英文短名'), (title, '标题'),
                                           (theme, '主题'), (relates, '关联'))]
    if not re.fullmatch(r'[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*', topic):
        raise ValueError('英文短名只用英文字母、数字和段间短横线')
    # 记录者可含中文、空格或宿主分隔符；文件名不能带路径分隔符。
    slug = re.sub(r'[^\w-]+', '-', agent).strip('-_')
    if not slug:
        raise ValueError('记录者须包含文字或数字')
    source = run_source(run) if run is not None else '待补充：宿主、会话 ID、轮次或消息时间及定位原话'
    stamp = dt.datetime.now()
    # ponytail: ID 也带时分秒，同一天再次记录同一主题不会撞 ID。
    record_id = f'{stamp:%Y%m%d-%H%M%S}-{slug}-{topic}'
    content = (f'# {title}\nID: {record_id}\n日期: {stamp:%Y-%m-%d}\n记录者: {agent}\n'
               f'主题: {theme}\n状态: 建议\n来源: {source}\n关联: {relates}\n\n'
               '## 观察与依据\n待填写：具体观察、原话定位、运行数据或产物链接；区分事实和判断。\n\n'
               '## 改进\n待填写：拟采用的改法、作用范围及已修改的文件。\n\n'
               '## 效果与下一步\n待填写：尚未验证，或实际结果及限制；下次如何决定保留、调整或撤回。\n')
    base = Path(base)
    path = base / 'notes' / f'{stamp:%Y-%m-%d-%H%M%S}-{slug}-{topic}.md'
    with index_lock(base):
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('x', encoding='utf-8') as output:
                output.write(content)
        except FileExistsError:
            raise ValueError(f'记录已存在，不覆盖：{path}') from None
        try:
            build_locked(base)
        except (OSError, ValueError) as error:
            raise ValueError(f'记录已创建于 {path}，索引未更新：{error}') from error
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    index = sub.add_parser('index', help='校验记录并重建 LOG.md')
    index.add_argument('--dir', type=Path, required=True)
    create = sub.add_parser('new', help='独占创建建议记录并重建索引')
    create.add_argument('--dir', type=Path, required=True)
    create.add_argument('--agent', required=True)
    create.add_argument('--topic', required=True)
    create.add_argument('--title', required=True)
    create.add_argument('--theme', default='其他')
    create.add_argument('--relates', default='无')
    create.add_argument('--run', type=Path)
    args = parser.parse_args(argv)
    try:
        base = args.dir.resolve()
        if args.action == 'index':
            count = build(base)
            print(f"已更新 {base / 'LOG.md'}，{count} 条记录")
        else:
            path = new(base, args.agent, args.topic, args.title, args.theme, args.relates, args.run)
            print(f"已创建 {path}，已更新 {base / 'LOG.md'}")
        return 0
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
