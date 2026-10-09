"""负责人模式：Claude Code 拆任务卡，这里把每张卡交给一个精简只读的 Codex 执行者，
负责人逐张验收后，依赖它的卡才会开跑。对齐 Orca 编排：一个运行目录、卡片间可写依赖、
结果须明确验收或退回、进程是否还在要查得出来、指南由程序自己打印。只用标准库；不碰任务库和看板。

  worker.py run <运行目录> [--cwd 目录] [--goal 目标] [--minutes 25] [--retry 卡名]   # 派出就返回
  worker.py wait <运行目录> [--minutes 25]   # 等到有卡交回来或全部结束
  worker.py status <运行目录>
  worker.py accept|reject <运行目录> <卡名> --note 说明
  worker.py check <交付.out>
  worker.py guide
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_MINUTES = 30  # 与看板单次运行上限一致
DEPS = re.compile(r'^依赖\s*[:：]\s*(.+)$', re.M)

RULES = """你是执行者，负责人是 Claude Code。你的最后一条回复就是交付物，负责人会逐条抽查来源。
硬规矩：
- 只读：不写文件、不联网、不改任何东西。
- 每条结论都带来源，格式固定：文本文件写 /绝对路径:行号 或 /绝对路径:起-止；PDF 写 /绝对路径.pdf#p页码（用 pdftotext -layout 读）。路径里有空格时整段用反引号括起来。找不到来源就写“无来源”，不许编。
- 区分证据强度：文档写明 / 口述记录 / 你的推断。
- 不同日期、不同口径的数字不相加，按原日期引用。
- 输出中文 markdown，以表格为主、少量说明，不要客套。
"""


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def write_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None


def codex_bin():
    return os.environ.get('CREW_CODEX_BIN') or shutil.which('codex') or 'codex'


def enabled_mcp(extra):
    r = subprocess.run([codex_bin(), *extra, 'mcp', 'list', '--json'], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError('读不到 Codex 的 MCP 列表，不以未精简的方式启动：' + (r.stderr.strip() or r.stdout.strip()))
    return [s['name'] for s in json.loads(r.stdout) if s.get('enabled')]


def lean_args():
    """现查现关，写死名单会漏（10-08 的名单到 10-09 已漏掉三个插件带的 MCP）。
    插件带的 MCP 只能整体关插件，单独写 enabled=false 会让 Codex 读配置报错；
    剩下的是配置文件里声明的，逐个关。关完再查一遍，还有开着的就不启动。"""
    lean = ['-c', 'features.plugins=false']
    declared = enabled_mcp(lean)
    plugin_mcp = set(enabled_mcp([])) - set(declared)
    for name in declared:
        lean += ['-c', f'mcp_servers.{name}.enabled=false']
    left = enabled_mcp(lean)
    if left:
        raise RuntimeError('这些 MCP 关不掉，不启动执行者：' + '、'.join(left))
    return lean, sorted(plugin_mcp) + declared


SESSION = re.compile(r'^session id:\s*(\S+)', re.M)
TOKENS = re.compile(r'tokens used\s*\n\s*([\d,]+)')


def read_log(path):
    text = path.read_text(encoding='utf-8', errors='replace') if path.is_file() else ''
    session, tokens = SESSION.search(text), TOKENS.search(text)
    return (session.group(1) if session else None), (int(tokens.group(1).replace(',', '')) if tokens else None)


def kill_tree(proc):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Run:
    """一个运行目录：cards/ 放任务卡，<卡名>.out/.log/.json 是交付、过程和回执。"""

    def __init__(self, root):
        self.root = Path(root).resolve()
        if not (self.root / 'cards').is_dir():
            raise ValueError(f'运行目录里没有 cards/：{self.root}')

    def cards(self):
        cards = {}
        for path in sorted((self.root / 'cards').glob('*.md')):
            body = path.read_text(encoding='utf-8')
            m = DEPS.search(body)
            deps = [d for d in re.split(r'[,，、\s]+', m.group(1)) if d] if m else []
            cards[path.stem] = {'path': path, 'body': body, 'deps': deps}
        for name, card in cards.items():
            for dep in card['deps']:
                if dep not in cards or dep == name:
                    raise ValueError(f'卡 {name} 依赖的 {dep} 不在 cards/ 里。')
        return cards

    def receipt(self, name):
        return read_json(self.root / f'{name}.json')

    def state(self, name, cards):
        r = self.receipt(name)
        if r is None:
            ready = all((self.receipt(d) or {}).get('review', {}).get('verdict') == 'accepted' for d in cards[name]['deps'])
            return 'ready' if ready else 'waiting'
        if r['state'] == 'running':
            if not r['pid']:  # 看守进程还没报到；一分钟还没报到就是没起来
                age = (dt.datetime.now().astimezone() - dt.datetime.fromisoformat(r['started_at'])).total_seconds()
                return 'running' if age < 60 else 'lost'
            return 'running' if alive(r['pid']) else 'lost'  # 进程不在了但没写完回执：结果未知，不当成完成
        verdict = r.get('review', {}).get('verdict')
        if verdict:
            return verdict
        return 'delivered' if r['state'] == 'finished' else r['state']

    def status(self):
        cards = self.cards()
        rows = []
        for name, card in cards.items():
            r = self.receipt(name) or {}
            rows.append({'card': name, 'deps': card['deps'], 'state': self.state(name, cards),
                         'seconds': r.get('seconds'), 'tokens': r.get('tokens'), 'resumed': bool(r.get('resumed_from')),
                         'output': r.get('output'), 'review': r.get('review')})
        return {'run': read_json(self.root / 'run.json'), 'dir': str(self.root), 'cards': rows}

    def archive(self, name):
        history = self.root / 'history'
        history.mkdir(exist_ok=True)
        stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
        for ext in ('json', 'out', 'log', 'prompt'):
            src = self.root / f'{name}.{ext}'
            if src.exists():
                src.replace(history / f'{name}-{stamp}.{ext}')

    def command(self, cwd, lean, effort, output, session):
        base = [codex_bin(), 'exec']
        if session:
            # resume 没有 -s / -C：沙箱用配置项钉死，目录沿用原会话
            tail = ['--skip-git-repo-check', '-c', 'sandbox_mode="read-only"']
            base += ['resume', session]
        else:
            tail = ['--skip-git-repo-check', '-C', str(cwd), '-s', 'read-only']
        return base + tail + lean + ['-c', f'model_reasoning_effort={effort}', '-o', str(output), '-']

    def run(self, cwd, seconds, effort, goal, retry):
        """把就绪的卡派出去就返回；每张卡由自己的看守进程盯到结束并写回执。"""
        lock = (self.root / '.lock').open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('这个运行目录正在派单，等它结束再来。')
        if not cwd.is_dir():
            raise ValueError(f'工作目录不存在：{cwd}')
        cards = self.cards()
        resume = {}  # 卡名 -> (旧会话编号, 退回原因)
        for name in retry:
            if name not in cards:
                raise ValueError(f'没有这张卡：{name}')
            if self.state(name, cards) in ('running', 'accepted'):
                raise ValueError(f'卡 {name} 正在跑或已验收，不重派。')
            old = self.receipt(name) or {}
            note = old.get('review', {}).get('note')
            if old.get('session_id') and old.get('review', {}).get('verdict') == 'rejected':
                resume[name] = (old['session_id'], note)
            self.archive(name)
        meta = read_json(self.root / 'run.json') or {'created_at': now()}
        if goal:
            meta['goal'] = goal
        write_json(self.root / 'run.json', meta)
        ready = [n for n in cards if self.state(n, cards) == 'ready']
        if not ready:
            return True
        lean, mcp = lean_args()
        for name in ready:
            card = cards[name]
            session, note = resume.get(name, (None, None))
            if session:
                prompt = f'负责人退回了你的交付，原因：{note}\n请在原会话基础上改正，重新给出完整交付，格式规矩不变。\n'
            else:
                prompt = RULES + '\n' + card['body']
                if card['deps']:
                    prompt += '\n\n前序交付（负责人已验收，可直接引用；需要时回查其中的原始出处）：\n'
                    prompt += ''.join(f'- {d}：{self.root / f"{d}.out"}\n' for d in card['deps'])
            output, log, prompt_file = self.root / f'{name}.out', self.root / f'{name}.log', self.root / f'{name}.prompt'
            prompt_file.write_text(prompt, encoding='utf-8')
            cmd = self.command(cwd, lean, effort, output, session)
            # 回执要先于看守进程落盘：它只改这个文件，不能被这里晚到的写入盖掉
            receipt = {'card': str(card['path']), 'card_sha256': hashlib.sha256(card['body'].encode('utf-8')).hexdigest(),
                       'deps': card['deps'], 'cwd': str(cwd), 'sandbox': 'read-only', 'disabled_mcp': mcp,
                       'started_at': now(), 'state': 'running', 'pid': 0,
                       'output': str(output), 'log': str(log), 'prompt': str(prompt_file)}
            if session:
                receipt['resumed_from'] = session
            write_json(self.root / f'{name}.json', receipt)
            # 看守进程独立于本命令：run 返回后它继续盯执行者，超时连同子进程一起收掉
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '_guard', str(self.root), name,
                              '--seconds', str(seconds), '--cmd', json.dumps(cmd)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        return True

    def wait(self, seconds):
        """有卡交回来（交付、失败、超时、丢失）就返回，每张只通知一次；没有卡在跑了也返回。"""
        deadline = time.monotonic() + seconds
        while True:
            cards = self.cards()
            states = {n: self.state(n, cards) for n in cards}
            fresh = [n for n, st in states.items() if st in ('delivered', 'failed', 'timed_out', 'lost')
                     and self.receipt(n) and not self.receipt(n).get('notified')]
            for n in fresh:
                receipt = self.receipt(n)
                receipt['notified'] = True  # 这张卡已经通知过了，下次 wait 等下一张
                write_json(self.root / f'{n}.json', receipt)
            if fresh or 'running' not in states.values() or time.monotonic() >= deadline:
                return
            time.sleep(0.5)

    def review(self, name, verdict, note, force=False):
        if not note.strip():
            raise ValueError('验收或退回都要写一句说明。')
        cards = self.cards()
        if name not in cards:
            raise ValueError(f'没有这张卡：{name}')
        state = self.state(name, cards)
        allowed = ('delivered',) if verdict == 'accepted' else ('delivered', 'failed', 'timed_out', 'lost')
        if state not in allowed:
            raise ValueError(f'卡 {name} 现在是 {state}，不能{"验收" if verdict == "accepted" else "退回"}。')
        receipt = self.receipt(name)
        review = {'verdict': verdict, 'note': note.strip(), 'at': now()}
        if Path(receipt['output']).is_file():
            result = check(Path(receipt['output']))
            review.update(citations=len(result['citations']), citations_bad=result['bad'])
            if verdict == 'accepted' and result['bad'] and not force:
                raise ValueError(f'有 {result["bad"]} 条引用对不上原文。先 reject 后用 --retry 重派；确认仍接受就在说明里写清原因并加 --force。')
        receipt['review'] = review
        write_json(self.root / f'{name}.json', receipt)
        return review


def guard(root, name, seconds, cmd):
    """每张卡一个：启动执行者，盯到结束或超时，把结果写进回执。"""
    root = Path(root)
    receipt = read_json(root / f'{name}.json')
    receipt['pid'] = os.getpid()  # 之后 status 靠它判断看守进程还在不在
    write_json(root / f'{name}.json', receipt)
    log, output = Path(receipt['log']), Path(receipt['output'])
    prompt = Path(receipt['prompt']).read_bytes()
    t0 = time.monotonic()
    with log.open('w') as log_file:
        # 独立进程组：超时时连同 Codex 拉起的子进程一起收掉，不留残留
        # cwd 必须钉死：resume 不认 -C，不钉会落到启动命令所在的目录
        proc = subprocess.Popen(cmd, cwd=receipt['cwd'], stdin=subprocess.PIPE, stdout=log_file, stderr=subprocess.STDOUT, start_new_session=True)
        proc.stdin.write(prompt)
        proc.stdin.close()
        try:
            proc.wait(timeout=seconds)
            timed_out = False
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            timed_out = True
    size = output.stat().st_size if output.is_file() else 0
    session, tokens = read_log(log)
    state = 'timed_out' if timed_out else ('finished' if proc.returncode == 0 and size else 'failed')
    receipt.update(state=state, exit_code=proc.returncode, ended_at=now(), seconds=round(time.monotonic() - t0, 1),
                   output_bytes=size, session_id=session or receipt.get('resumed_from'), tokens=tokens)
    write_json(root / f'{name}.json', receipt)


# ponytail: 只认绝对路径；带空格的路径要求执行者用反引号括起来，执行者规矩里已写明
QUOTED = re.compile(r'`(/[^`\n]+?)(?::L?(\d+)(?:[-–~]L?(\d+))?|#p(\d+))`')
BARE = re.compile(r'(/[^\s`|:：，,;；()（）\[\]<>"\'#]+)(?::L?(\d+)(?:[-–~]L?(\d+))?|#p(\d+))')


def pdf_page(path, page):
    if not shutil.which('pdftotext'):
        return 'ok', '（本机没有 pdftotext，未核页码）'
    r = subprocess.run(['pdftotext', '-layout', '-f', str(page), '-l', str(page), str(path), '-'], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return '页码越界', r.stderr.strip()[:200]
    return 'ok', ' '.join(r.stdout.split())[:300]


def resolve(path, start, end, page):
    p = Path(path)
    if not p.is_file():
        return {'status': '文件不存在', 'text': ''}
    if page:
        status, text = pdf_page(p, page)
        return {'status': status, 'text': text}
    lines = p.read_text(encoding='utf-8', errors='replace').splitlines()
    last = end or start
    if start < 1 or last < start or last > len(lines):
        return {'status': '行号越界', 'text': f'文件共 {len(lines)} 行'}
    return {'status': 'ok', 'text': '\n'.join(lines[start - 1:min(last, start + 2)])[:300]}


def check(report):
    text = report.read_text(encoding='utf-8')
    found, seen = [], set()
    for pattern in (QUOTED, BARE):
        for m in pattern.finditer(text):
            path, start, end, page = m.group(1), m.group(2), m.group(3), m.group(4)
            key = (path, int(start or 0), int(end) if end else None, int(page or 0))
            if key not in seen:
                seen.add(key)
                found.append({'path': path, 'start': key[1] or None, 'end': key[2], 'page': key[3] or None,
                              **resolve(path, key[1], key[2], key[3])})
        text = pattern.sub(' ', text)  # 反引号里的引用已处理，别让裸路径规则再截一遍
    bad = [c for c in found if c['status'] != 'ok']
    return {'report': str(report), 'citations': found, 'bad': len(bad), 'no_source': report.read_text(encoding='utf-8').count('无来源')}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    r = sub.add_parser('run', help='派出所有就绪的卡（无依赖或依赖都已验收），同时开跑')
    r.add_argument('run_dir', type=Path)
    r.add_argument('--cwd', type=Path, default=Path.cwd())
    r.add_argument('--goal')
    r.add_argument('--minutes', type=float, default=25)
    r.add_argument('--seconds', type=float, help=argparse.SUPPRESS)  # 测试用
    r.add_argument('--effort', default='high', choices=('low', 'medium', 'high', 'xhigh'))
    r.add_argument('--retry', action='append', default=[], help='把退回、失败、超时的卡存档后重派')
    w = sub.add_parser('wait', help='等到有卡交回来（先交的先通知）或全部结束')
    w.add_argument('run_dir', type=Path)
    w.add_argument('--minutes', type=float, default=25)
    g = sub.add_parser('_guard', help=argparse.SUPPRESS)
    g.add_argument('run_dir', type=Path)
    g.add_argument('card')
    g.add_argument('--seconds', type=float, required=True)
    g.add_argument('--cmd', required=True)
    s = sub.add_parser('status', help='每张卡的状态')
    s.add_argument('run_dir', type=Path)
    for verb in ('accept', 'reject'):
        v = sub.add_parser(verb, help='负责人验收' if verb == 'accept' else '负责人退回')
        v.add_argument('run_dir', type=Path)
        v.add_argument('card')
        v.add_argument('--note', required=True)
        if verb == 'accept':
            v.add_argument('--force', action='store_true', help=argparse.SUPPRESS)
    c = sub.add_parser('check', help='把交付里的 路径:行号 引用对回原文')
    c.add_argument('report', type=Path)
    sub.add_parser('guide', help='打印负责人指南')
    args = parser.parse_args(argv)
    try:
        if args.action == 'guide':
            print((HERE / '指南.md').read_text(encoding='utf-8'))
            return 0
        if args.action == 'check':
            result = check(args.report.resolve())
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1 if result['bad'] else 0
        if args.action == '_guard':
            guard(args.run_dir, args.card, args.seconds, json.loads(args.cmd))
            return 0
        run = Run(args.run_dir)
        if args.action == 'wait':
            if not 0 < args.minutes <= MAX_MINUTES:
                raise ValueError(f'单次等待上限 {MAX_MINUTES} 分钟。')
            run.wait(args.minutes * 60)
            print(json.dumps(run.status(), ensure_ascii=False, indent=2))
            return 0
        if args.action == 'run':
            if not 0 < args.minutes <= MAX_MINUTES:
                raise ValueError(f'单次运行上限 {MAX_MINUTES} 分钟。')
            run.run(args.cwd.resolve(), args.seconds or args.minutes * 60, args.effort, args.goal, args.retry)
            print(json.dumps(run.status(), ensure_ascii=False, indent=2))
            return 0
        if args.action in ('accept', 'reject'):
            verdict = 'accepted' if args.action == 'accept' else 'rejected'
            print(json.dumps(run.review(args.card, verdict, args.note, getattr(args, 'force', False)), ensure_ascii=False, indent=2))
            return 0
        print(json.dumps(run.status(), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
