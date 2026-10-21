"""负责人模式：Claude Code 拆任务卡，这里把每张卡交给一个精简只读的 Codex 执行者，
负责人逐张验收后，依赖它的卡才会开跑。对齐 Orca 编排：一个运行目录、卡片间可写依赖、
结果须明确验收或退回、进程是否还在要查得出来、指南由程序自己打印。只用标准库；不碰任务库和看板。

  worker.py run <运行目录> [--cwd 目录] [--goal 目标] [--minutes 25] [--model 模型] [--effort high] [--retry 卡名] [--write]
    # 派出就返回；模型默认用 Codex 配置，档位支持 low/medium/high/xhigh/max/ultra；续改未指定模型或档位时沿用原卡
  worker.py changes <运行目录>   # --write 的运行：工作目录相对派单前改了哪些文件，哪些不在任何卡的「可写」里
  worker.py wait <运行目录> [--minutes 10]   # 到点、有卡交回或新卡住时返回，附进度
  worker.py status <运行目录>
  worker.py stop <运行目录> <卡名> [--note 说明]   # 请求当前尝试停止
  worker.py accept <运行目录> <卡名> --note 说明 [--hold]   # 验收后自动派就绪下游；--hold 只验收
  worker.py reject <运行目录> <卡名> --note 说明
  worker.py diff <运行目录> <卡名>   # 最近一次旧交付与当前交付的统一 diff
  worker.py stats <运行目录> [--out-dir 目录]   # 生成 metrics.json 和 summary.md
  worker.py stats --manifest 清单 --root-log 主日志 --turn-id 轮次 --out-dir 目录 [--start ISO时间]
  worker.py note new --dir 记录目录 --agent 记录者 --topic 英文短名 --title 标题 [--theme 主题] [--relates 旧记录ID] [--run 运行目录]
  worker.py note index --dir 记录目录   # 校验记录并重建 LOG.md
  worker.py check <交付.out>
  worker.py guide
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import difflib
import fcntl
import fnmatch
import getpass
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from acceptance import acceptance_info, accepted_valid, card_sha256
import result_contract

HERE = Path(__file__).resolve().parent
HEARTBEAT_SECONDS = 30  # ponytail: 起步先每 30 秒巡检一次，不做自适应频率。
HEARTBEAT_LOST_MULTIPLIER = 3  # ponytail: 连续三个心跳周期停更，活看守只报疑似卡住。
STALL_MINUTES = 15  # ponytail: 无输出 15 分钟是起步值，只提醒，不自动杀。
ACTIVE_STATES = ('running', 'stalled')
DEPS = re.compile(r'^依赖\s*[:：]\s*(.+)$', re.M)
WRITABLE = re.compile(r'^可写\s*[:：]\s*(.+)$', re.M)
SKIP_DIRS = {'node_modules', '__pycache__'}
# worker 的运行信息、写入基线，以及 stats 的统计与摘要文件名。
RESERVED_NAMES = {'run', 'baseline', 'metrics', 'summary'}

RULES = """你是执行者，负责人是 Claude Code。你的最后一条回复就是交付物，负责人会逐条抽查来源。
交付最前面必须是 `## 结论卡`（300—500 中文字），按以下五项写，完整来源和细节放后面：
问题／本次结论：
依据：1—3 个关键来源或可打开产物，标明定位
反证／尚缺什么：
交回决定：负责人现在应继续、停止、改方向，还是补哪项输入
产物：文件路径；仅有变化时说明替代哪段
硬规矩：
- 只读：不写文件、不联网、不改任何东西。
- 每条结论都带来源，格式固定：文本文件写 /绝对路径:行号 或 /绝对路径:起-止；PDF 写 /绝对路径.pdf#p页码（用 pdftotext -layout 读）。路径里有空格时整段用反引号括起来。找不到来源就写“无来源”，不许编。
- 区分证据强度：文档写明 / 口述记录 / 你的推断。
- 不同日期、不同口径的数字不相加，按原日期引用。
- 工作目录里的 AGENTS.md、CLAUDE.md 是写给交互会话的：开场流程（同步、查任务库、读会话记录）和收尾记账都跳过；其中的项目约定（代码规矩、工具用法）照常遵守。
- 输出中文 markdown，以表格为主、少量说明，不要客套。
"""

# --write：要跑 Blender、无头浏览器这类沙箱里起不来的活（10-13 实测 Codex 沙箱挡显卡和联网）。
# 不开沙箱，边界靠卡里的「可写」和负责人的 changes 对账。
WRITE_RULES = """你是执行者，负责人是 Claude Code。你的最后一条回复就是交付物，负责人会对照改动清单逐条验收。
交付最前面必须是 `## 结论卡`（300—500 中文字），按以下五项写，完整来源和细节放后面：
问题／本次结论：
依据：1—3 个关键来源或可打开产物，标明定位
反证／尚缺什么：
交回决定：负责人现在应继续、停止、改方向，还是补哪项输入
产物：文件路径；仅有变化时说明替代哪段
硬规矩：
- 这次可以改文件，但只改任务卡「可写」一行列出的路径（相对工作目录，可带 *）；其余文件只读。非改清单外的文件不可时，停下来在交付里写明原因，不要改。
- 不做：git 提交或推送、发布或上传、安装全局软件、改凭据、启停云机、删除不是你这次新建的文件。
- 交付写清：改了哪些文件、每处为什么改、你怎么验证的（看过的截图、渲染图写绝对路径）、还差什么。
- 引用代码写 /绝对路径:行号 或 /绝对路径:起-止，路径里有空格时整段用反引号括起来。
- 工作目录里的 AGENTS.md、CLAUDE.md 是写给交互会话的：开场流程（同步、查任务库、读会话记录）和收尾记账都跳过；其中的项目约定（代码规矩、工具用法）照常遵守。
- 输出中文 markdown，少客套。
"""


def now():
    return dt.datetime.now().astimezone().isoformat(timespec='milliseconds')


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
    session, tokens = SESSION.search(text), list(TOKENS.finditer(text))
    return (session.group(1) if session else None), (int(tokens[-1].group(1).replace(',', '')) if tokens else None)


def feature_names(names):
    if any(not re.fullmatch(r'[a-z0-9_]+', name) for name in names):
        raise ValueError('特性名只能含小写字母、数字和下划线。')
    return sorted(set(names))


def native_tokens(session):
    """按本次会话定位原生日志，从末尾找累计用量；缺失或正在写入都不报错。"""
    if not session or not re.fullmatch(r'[A-Za-z0-9_-]+', session):
        return None

    def tail_lines(path):
        with path.open('rb') as stream:
            end = stream.seek(0, 2)
            pending = b''
            while end:
                start = max(0, end - 65536)
                stream.seek(start)
                lines = (stream.read(end - start) + pending).split(b'\n')
                pending, end = lines[0], start
                yield from reversed(lines[1:])
            yield pending

    try:
        root = Path(os.environ.get('CODEX_HOME', '~/.codex')).expanduser() / 'sessions'
        for path in sorted(root.glob(f'**/rollout-*-{session}.jsonl'), reverse=True):
            for line in tail_lines(path):
                try:
                    event = json.loads(line)
                    payload = event.get('payload') or {}
                    if event.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                        total = payload['info']['total_token_usage']['total_tokens']
                        if type(total) is int and total >= 0:
                            return total
                except (ValueError, KeyError, TypeError, AttributeError):
                    continue
    except OSError:
        pass
    return None


def kill_tree(proc):
    # 不先回收组长：发完组信号才释放 PID，子进程忽略 TERM 也会被收掉。
    def signal_group(sig):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Darwin 对只剩僵尸的组可能返回 EPERM；只有确证退出才忽略。
            if not executor_group_free({'executor_pid': proc.pid, 'executor_pgid': proc.pid}):
                raise
    try:
        signal_group(signal.SIGTERM)
        time.sleep(.2)
        signal_group(signal.SIGKILL)
    finally:
        proc.wait(timeout=5)


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def executor_group_free(receipt):
    """只读确认自建进程组没有活成员；身份或查询不明时不放行、不发信号。"""
    pid, pgid = receipt.get('executor_pid'), receipt.get('executor_pgid')
    if type(pid) is not int or pid <= 0 or pgid != pid:
        return False
    try:
        result = subprocess.run(['ps', '-axo', 'pid=,pgid=,stat='], capture_output=True, text=True, timeout=3)
        if result.returncode or not result.stdout.strip():
            return False
        groups = []
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
                return False
            if int(parts[1]) == pgid:
                # 只判断本组状态；其他组退出瞬间的 ? / ?E 不应占住本组名额。
                if not re.fullmatch(r'[IDRSTUWZXP][A-Za-z+<>=]*', parts[2]):
                    return False
                groups.append(parts[2])
        return not groups or all(state.startswith('Z') for state in groups)
    except (OSError, subprocess.SubprocessError):
        return False


def executor_identity(receipt):
    """保存本组活成员的 PID 与启动时间；失联后须有同一成员才能发信号。"""
    pid, pgid = receipt.get('executor_pid'), receipt.get('executor_pgid')
    if type(pid) is not int or pid <= 0 or pgid != pid:
        return {}
    try:
        result = subprocess.run(['ps', '-axo', 'pid=,pgid=,lstart=,stat='], capture_output=True,
                                text=True, timeout=.5, env={**os.environ, 'LC_ALL': 'C'})
        if result.returncode:
            return {}
        members = {}
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) != 8 or not parts[0].isdigit() or not parts[1].isdigit():
                continue
            if int(parts[1]) == pgid and not parts[7].startswith('Z'):
                members[parts[0]] = ' '.join(parts[2:7])
        return members
    except (OSError, subprocess.SubprocessError):
        return {}


def stop_confirmed_group(receipt):
    """每次发信号前重核已记录成员，拒绝只凭旧 PID/PGID 杀进程。"""
    known = receipt.get('executor_identity', {})
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if executor_group_free(receipt):
            return
        current = executor_identity(receipt)
        if not any(current.get(pid) == started for pid, started in known.items()):
            raise ValueError('执行者进程组身份未能确认，未发停止信号；请核实原执行者。')
        # 将仍属于已确认组的成员保存为下一次信号的见证。
        known = current
        try:
            os.killpg(receipt['executor_pgid'], sig)
        except ProcessLookupError:
            return
        time.sleep(.2)
    if not executor_group_free(receipt):
        raise ValueError('已发停止信号，执行者进程组仍未确认退出。')


def heartbeat_stalled(receipt):
    heartbeat = receipt.get('heartbeat', {}).get('at')
    if not heartbeat:
        return False
    age = (dt.datetime.now().astimezone() - dt.datetime.fromisoformat(heartbeat)).total_seconds()
    return age > receipt.get('heartbeat_seconds', HEARTBEAT_SECONDS) * HEARTBEAT_LOST_MULTIPLIER


def receipt_state(r):
    if r['state'] in ACTIVE_STATES:
        if not r.get('pid'):
            age = (dt.datetime.now().astimezone() - dt.datetime.fromisoformat(r['started_at'])).total_seconds()
            return r['state'] if age < 60 else 'lost'
        if not alive(r['pid']):
            return 'lost'
        return 'stalled' if heartbeat_stalled(r) else r['state']
    return r.get('review', {}).get('verdict') or ('delivered' if r['state'] == 'finished' else r['state'])


def capacity_held(receipt):
    if not receipt:
        return False
    if (receipt.get('exit_confirmation') and not receipt.get('executor_pid')
            and not receipt.get('executor_pgid')):
        return False
    if receipt_state(receipt) in ACTIVE_STATES:
        return True
    uncertain = (receipt.get('state') in (*ACTIVE_STATES, 'lost') or receipt.get('cleanup_unconfirmed')
                 or '未确认停止' in str(receipt.get('error', '')) or receipt.get('executor_pid'))
    return bool(uncertain and not executor_group_free(receipt))


def log_heartbeat(receipt, log):
    """只读日志尾部；长任务不在每次心跳重读整份日志。"""
    previous = receipt.get('heartbeat', {})
    size, modified, text, head = 0, receipt['started_at'], '', ''
    if log.is_file():
        stat = log.stat()
        size = stat.st_size
        modified = dt.datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec='milliseconds')
        with log.open('rb') as stream:
            head = stream.read(65536).decode('utf-8', errors='replace')
            stream.seek(max(0, size - 65536))  # ponytail: 最多读末尾 64 KiB。
            text = stream.read().decode('utf-8', errors='replace')
    # 去掉终端转义与控制字符，避免日志把 status 的一行进度打乱。
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)', '', text)
    lines = [''.join(c for c in line if c.isprintable()).strip() for line in clean.splitlines()]
    last = next((line[:240] for line in reversed([previous.get('last_output', ''), *lines])
                 if line and not line.startswith('hook:')
                 and not re.fullmatch(r'(?:`{3,}|~{3,})[\w+-]*', line)), '')
    matches = list(TOKENS.finditer(text))
    session = SESSION.search(head)
    tokens = (int(matches[-1].group(1).replace(',', '')) if matches else
              native_tokens(session.group(1) if session else receipt.get('session_id') or receipt.get('resumed_from')))
    if tokens is None:
        tokens = previous.get('tokens_session')
    before = receipt.get('tokens_before')
    return {'at': now(), 'log_bytes': size, 'log_mtime': modified, 'last_output': last,
            'tokens_session': tokens, 'tokens': tokens - before if tokens is not None and before else tokens}


def progress(receipt):
    heartbeat = receipt.get('heartbeat', {})
    current = dt.datetime.now().astimezone()
    seconds = max(0, (current - dt.datetime.fromisoformat(receipt['started_at'])).total_seconds()) if receipt.get('started_at') else 0
    last = heartbeat.get('log_mtime', receipt.get('started_at'))
    idle = max(0, (current - dt.datetime.fromisoformat(last)).total_seconds()) if last else seconds
    tokens = heartbeat.get('tokens')
    line = f'已跑 {seconds / 60:.1f} 分钟；最后动静 {idle / 60:.1f} 分钟前；token {tokens if tokens is not None else "未知"}；{heartbeat.get("last_output") or "尚无输出"}'
    if receipt.get('state') in ACTIVE_STATES and alive(receipt.get('pid')) and heartbeat_stalled(receipt):
        line += '；看守停更'
    return round(seconds, 1), round(idle, 1), line


class Run:
    """一个运行目录：cards/ 放任务卡，<卡名>.out/.log/.json 是交付、过程和回执。"""

    def __init__(self, root):
        self.root = Path(root).resolve()
        if not (self.root / 'cards').is_dir():
            raise ValueError(f'运行目录里没有 cards/：{self.root}')

    def cards(self):
        cards = {}
        for path in sorted((self.root / 'cards').glob('*.md')):
            if path.stem.casefold() in RESERVED_NAMES:
                raise ValueError(f'卡 {path.stem} 是保留名，会与运行目录里的元数据文件冲突，请改卡名。')
            body = path.read_text(encoding='utf-8')
            m = DEPS.search(body)
            deps = [d for d in re.split(r'[,，、\s]+', m.group(1)) if d] if m else []
            w = WRITABLE.search(body)
            writable = [g for g in re.split(r'[,，、\s]+', w.group(1)) if g] if w else []
            headers = result_contract.card_headers(body)
            options = {}
            if '模型' in headers:
                if not headers['模型']:
                    raise ValueError(f'卡 {path.stem} 的模型不能为空。')
                options['model'] = headers['模型']
            if '档位' in headers:
                if headers['档位'] not in ('low', 'medium', 'high', 'xhigh', 'max', 'ultra'):
                    raise ValueError(f'卡 {path.stem} 的档位无效。')
                options['effort'] = headers['档位']
            if '特性' in headers:
                options['features'] = feature_names([n.strip() for n in re.split(r'[,，、]', headers['特性'])]
                                                     if headers['特性'] else [])
            continuation = headers.get('接续')
            if continuation is not None and (not continuation or continuation not in deps):
                raise ValueError(f'卡 {path.stem} 的接续上游必须同时写在依赖里。')
            cards[path.stem] = {'path': path, 'body': body, 'deps': deps, 'writable': writable,
                                'options': options, 'continuation': continuation}
        for name, card in cards.items():
            for dep in card['deps']:
                if dep not in cards or dep == name:
                    raise ValueError(f'卡 {name} 依赖的 {dep} 不在 cards/ 里。')
        visited, stack = set(), []
        def visit(name):
            if name in stack:
                chain = stack[stack.index(name):] + [name]
                raise ValueError('任务卡依赖循环：' + ' -> '.join(chain))
            if name in visited:
                return
            stack.append(name)
            for dep in cards[name]['deps']:
                visit(dep)
            stack.pop()
            visited.add(name)
        for name in cards:
            visit(name)
        return cards

    def receipt(self, name):
        return read_json(self.root / f'{name}.json')

    def state(self, name, cards):
        r = self.receipt(name)
        if r is None:
            ready = all(accepted_valid(self.receipt(d), cards[d]['path']) is not False for d in cards[name]['deps'])
            return 'ready' if ready else 'waiting'
        if r['state'] in ACTIVE_STATES:
            return receipt_state(r)
        verdict = r.get('review', {}).get('verdict')
        if verdict == 'accepted':
            valid = accepted_valid(r, cards[name]['path'])
            return 'stale' if valid is False else 'accepted'
        if verdict:
            return verdict
        if r['state'] == 'finished' and r.get('result', {}).get('status') in ('blocked', 'partial', 'protocol_error'):
            return r['result']['status']
        return receipt_state(r)

    def status(self):
        cards = self.cards()
        rows = []
        for name, card in cards.items():
            r = self.receipt(name) or {}
            state = self.state(name, cards)
            held = capacity_held(r)
            stop_requested = r.get('stop_requested')
            if r.get('attempt_id'):
                stop_requested = read_json(self.root / '.attempts' / r['attempt_id'] / 'stop.json') or stop_requested
            row = {'card': name, 'deps': card['deps'], 'state': state,
                   'seconds': r.get('seconds'), 'tokens': r.get('tokens'), 'resumed': bool(r.get('resumed_from')),
                   'output': r.get('output'), 'review': r.get('review'),
                   'capacity_held': held, 'retry_blocked': held or state == 'accepted',
                   'heartbeat': r.get('heartbeat'), 'stop_requested': stop_requested,
                   **acceptance_info(r, card['path']), **result_contract.summary(r)}
            if state in (*ACTIVE_STATES, 'lost'):
                row['seconds'], row['idle_seconds'], row['progress'] = progress(r)
                row['tokens'] = r.get('heartbeat', {}).get('tokens')
            rows.append(row)
        return {'run': read_json(self.root / 'run.json'), 'dir': str(self.root), 'cards': rows}

    def archive(self, name):
        history = self.root / 'history'
        history.mkdir(exist_ok=True)
        stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S-%f')  # 同秒续改也保留各轮旧稿
        receipt = self.receipt(name) or {}
        private = self.root / '.attempts' / receipt['attempt_id'] if receipt.get('attempt_id') else None
        for ext in ('json', 'out', 'log', 'prompt'):
            src = self.root / f'{name}.{ext}'
            staged = private / f'{name}.{ext}' if private and ext in ('out', 'log') else None
            if staged and staged.is_file():
                staged.replace(history / f'{name}-{stamp}.{ext}')
                if src.exists():
                    src.replace(history / f'{name}-{stamp}.public.{ext}')
            elif src.exists():
                src.replace(history / f'{name}-{stamp}.{ext}')

    def command(self, cwd, lean, effort, output, session, sandbox, model=None, features=None, fork=False):
        base = [codex_bin(), 'exec']
        if session:
            # resume / fork 没有 -s / -C：目录与沙箱都用配置项钉死。
            tail = ['--skip-git-repo-check', '-c', f'sandbox_mode="{sandbox}"', '-c', 'cwd=' + json.dumps(str(cwd))]
            base += ['fork' if fork else 'resume', session]
        else:
            tail = ['--skip-git-repo-check', '-C', str(cwd), '-s', sandbox]
        model_args = ['--model', model] if model is not None else []
        feature_args = [arg for name in features or [] for arg in ('-c', f'features.{name}=true')]
        return base + tail + lean + feature_args + model_args + ['-c', f'model_reasoning_effort={effort}', '-o', str(output), '-']

    def write_warnings(self, cwd):
        """登记不是锁；只提醒另一个运行正写同一目录，不阻止派发。"""
        registry = __import__('runs_registry')
        warnings = []
        try:
            records = list(registry.records(registry.registry_path().read_text(encoding='utf-8')))
        except (OSError, ValueError):
            return warnings
        for record in records:
            try:
                other = Run(record['dir'])
                if other.root == self.root:
                    continue
                for name in other.cards():
                    receipt = other.receipt(name) or {}
                    if (receipt.get('sandbox') == 'danger-full-access'
                            and Path(receipt.get('cwd', '')).resolve() == cwd
                            and capacity_held(receipt)):
                        warnings.append(f'工作目录已有另一运行的写卡仍占位：{other.root} / {name}')
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
        return warnings

    @contextmanager
    def lock(self, blocking=False, name='.lock'):
        with (self.root / name).open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                raise ValueError('这个运行目录正在派单，等它结束再来。')
            yield

    def run(self, cwd, seconds, effort, goal, retry, write=False, model=None, only=None, fresh=False,
            stall_seconds=None, max_parallel=None, heartbeat_seconds=None, features=None):
        """把就绪的卡派出去就返回；每张卡由自己的看守进程盯到结束并写回执。"""
        __import__('runs_registry').register(self.root, goal)
        with self.lock():
            return self._run(cwd, seconds, effort, goal, retry, write, model, only, fresh,
                             stall_seconds, max_parallel, heartbeat_seconds, features)

    def _run(self, cwd, seconds, effort, goal, retry, write=False, model=None, only=None, fresh=False,
             stall_seconds=None, max_parallel=None, heartbeat_seconds=None, features=None):
        """调用者已持调度锁；验收后的派发复用它，不重复抢锁。"""
        if fresh and not retry:
            raise ValueError('--fresh 必须与 --retry 卡名一起使用。')
        cards = self.cards()
        meta = read_json(self.root / 'run.json') or {'created_at': now()}
        if features is not None:
            features = feature_names(features)
        supplied = {'cwd': str(cwd.resolve()) if cwd is not None else None, 'effort': effort, 'model': model,
                    'features': features, 'timeout_seconds': seconds, 'stall_seconds': stall_seconds,
                    'heartbeat_seconds': heartbeat_seconds}
        cwd = Path(supplied['cwd'] or meta.get('cwd') or Path.cwd()).resolve()
        if (supplied['cwd'] is not None or not retry or write) and not cwd.is_dir():
            raise ValueError(f'工作目录不存在：{cwd}')
        effort = effort if effort is not None else meta.get('effort', 'high')
        model = model if model is not None else meta.get('model')
        features = features if features is not None else meta.get('features', [])
        if seconds is None and meta.get('minutes') is not None:
            seconds = meta['minutes'] * 60
        stall_seconds = stall_seconds if stall_seconds is not None else meta.get('stall_seconds', STALL_MINUTES * 60)
        heartbeat_seconds = heartbeat_seconds if heartbeat_seconds is not None else meta.get('heartbeat_seconds', HEARTBEAT_SECONDS)
        max_parallel = max_parallel if max_parallel is not None else meta.get('max_parallel')
        if meta.get('write', write) != write:
            raise ValueError('写运行须显式带 --write；每次派发都需负责人明确选择。' if meta['write'] else
                             '这个运行目录是只读派的，不能中途加 --write，另开一个运行目录。')
        if write and meta.get('cwd', str(cwd)) != str(cwd):
            raise ValueError(f"--write 的运行目录绑定了工作目录 {meta['cwd']}，不能换。")
        sandbox = 'danger-full-access' if write else 'read-only'
        resume = {}  # 卡名 -> (旧会话编号, 退回原因, 旧累计用量)
        defaults = {'cwd': str(cwd), 'model': model, 'effort': effort, 'features': features,
                    'timeout_seconds': seconds, 'stall_seconds': stall_seconds, 'heartbeat_seconds': heartbeat_seconds}
        options = {}
        retry_receipts, retry_outputs = {}, {}
        retry = list(dict.fromkeys(retry))
        self.deferred = []
        self.warnings = []
        for name, card in cards.items():
            old = (self.receipt(name) or {}) if name in retry else {}
            options[name] = {key: supplied[key] if supplied[key] is not None else old.get(key, value)
                             for key, value in defaults.items()}
            options[name].update(card['options'])
        for name in retry:
            if name not in cards:
                raise ValueError(f'没有这张卡：{name}')
            if capacity_held(self.receipt(name)):
                raise ValueError(f'卡 {name} 执行者未确认退出，仍占位，不归档、不重派。')
            if self.state(name, cards) == 'accepted':
                raise ValueError(f'卡 {name} 已验收，不重派。')
        # 所有重试先核退出，避免后面的卡被拒绝时已归档前面的卡。
        for name in retry:
            old = self.receipt(name) or {}
            retry_receipts[name] = old
            selected = options[name]
            if not Path(selected['cwd']).is_dir():
                raise ValueError(f"工作目录不存在：{selected['cwd']}")
            note = old.get('review', {}).get('note')
            resumable = (old.get('review', {}).get('verdict') == 'rejected'
                         or old.get('result', {}).get('status') in ('blocked', 'partial'))
            if not fresh and old.get('session_id') and resumable:
                if ((old.get('model'), old.get('cwd'), old.get('sandbox'), sorted(old.get('features', [])))
                        != (selected['model'], selected['cwd'], sandbox, selected['features'])):
                    raise ValueError(f'卡 {name} 的模型、工作目录、读写模式或特性改变，不能续接旧会话；请加 --fresh 或另开运行目录。')
                # Codex 报的 tokens 是整段会话累计的，记下续改前的数，回执里才能算出这一轮花了多少
                resume[name] = (old['session_id'], note, old.get('tokens_session') or old.get('tokens'))
        # model=None 表示沿用 Codex 配置，不猜配置最终解析出的模型名。
        meta.update(cwd=str(cwd), minutes=seconds / 60 if seconds is not None else None,
                    effort=effort, model=model, write=write, max_parallel=max_parallel,
                    stall_seconds=stall_seconds, heartbeat_seconds=heartbeat_seconds, features=features)
        if goal:
            meta['goal'] = goal
        ready = [n for n, card in cards.items() if (only is None or n in only)
                 and (self.state(n, cards) == 'ready' or n in retry
                      and all(self.state(d, cards) == 'accepted' for d in card['deps']))]
        if max_parallel is not None:
            used = sum(capacity_held(self.receipt(n)) for n in cards)
            available = max(0, max_parallel - used)
            self.deferred = [{'card': n, 'reason': f'并发上限 {max_parallel}，已有 {used} 张占位'} for n in ready[available:]]
            ready = ready[:available]
        continuations = {}
        for name in ready:
            selected = options[name]
            if not Path(selected['cwd']).is_dir():
                raise ValueError(f"工作目录不存在：{selected['cwd']}")
            parent = cards[name]['continuation']
            if not parent or name in resume or fresh and name in retry:
                continue
            prior = self.receipt(parent) or {}
            frozen = prior.get('review', {}).get('accepted_output')
            if not prior.get('session_id') or not frozen or not Path(frozen).is_file():
                raise ValueError(f'卡 {name} 不能接续 {parent}：缺少上游会话或验收冻结稿。')
            if ((prior.get('cwd'), prior.get('sandbox'), prior.get('model'), sorted(prior.get('features', [])))
                    != (selected['cwd'], sandbox, selected['model'], selected['features'])):
                raise ValueError(f'卡 {name} 不能接续 {parent}：工作目录、读写模式、模型或特性不一致。')
            continuations[name] = {'card': parent, 'session_id': prior['session_id']}
        if write and not (self.root / 'baseline.json').is_file():
            # 派单前给工作目录拍一份底（只记大小和修改时间，不复制内容），changes 拿它对账
            write_json(self.root / 'baseline.json', {'at': now(), 'cwd': str(cwd), 'files': self.snapshot(cwd)})
        write_json(self.root / 'run.json', meta)
        if not ready:
            return []
        if write:
            self.warnings = self.write_warnings(cwd)
        lean, mcp = lean_args()
        for enabled in {tuple(options[name]['features']) for name in ready if options[name]['features']}:
            extra = [arg for feature in enabled for arg in ('-c', f'features.{feature}=true')]
            if enabled_mcp(lean + extra):
                raise ValueError('所选特性重新启用了 MCP，不能以未精简的方式启动。')
        for name in ready:
            # 有名额且预检完成才归档；排队的续改保留旧回执和会话信息。
            if name in retry:
                previous_outputs = set((self.root / 'history').glob('*.out'))
                self.archive(name)
                retry_outputs[name] = next((p for p in (self.root / 'history').glob('*.out') if p not in previous_outputs), None)
            card = cards[name]
            # 预检期间卡片或前序可能被改动，拼输入前再核一次。
            if card_sha256(card['path']) != hashlib.sha256(card['body'].encode('utf-8')).hexdigest():
                raise ValueError(f'卡 {name} 的卡片版本已变化，请重新派发。')
            if any(accepted_valid(self.receipt(d), cards[d]['path']) is False for d in card['deps']):
                raise ValueError(f'卡 {name} 的依赖未验收或验收已失效，请重新核对。')
            contract = result_contract.from_card(card['body'])
            old = retry_receipts.get(name, {})
            session, note, tokens_before = resume.get(name, (None, old.get('review', {}).get('note'), None))
            continuation = continuations.get(name)
            prompt = WRITE_RULES if write else RULES
            if session:
                reason = f'负责人退回了你的交付，原因：{note}' if note else '继续上一次尚未完成的交付，请结合负责人补答完成。'
                prompt += f'\n{reason}\n请在原会话基础上改正，重新给出完整交付。\n当前任务卡（本次以此为准）：\n' + card['body']
            else:
                prompt += '\n当前任务卡（本次以此为准）：\n' + card['body']
                if note:
                    prompt += f'\n\n前次退回原因：{note}\n'
            if retry_outputs.get(name):
                prompt += f'\n旧交付（仅供参考，以当前任务卡为准）：{retry_outputs[name]}\n'
            previous_result = old.get('result', {})
            if previous_result.get('status') in ('blocked', 'partial'):
                prompt += '\n上一次交付尚缺的输入或工作（请结合本次卡片补答继续）：\n'
                prompt += ''.join(f'- 待补答：{q}\n' for q in previous_result.get('questions', []))
                prompt += ''.join(f'- {item["id"]}：{item["reason"]}\n' for item in previous_result.get('skipped', []))
            if card['deps']:
                prompt += '\n\n前序交付（负责人已验收，可直接引用；需要时回查其中的原始出处）：\n'
                for d in card['deps']:
                    prior = self.receipt(d)
                    frozen = prior['review'].get('accepted_output')
                    path = frozen or prior.get('output') or self.root / f'{d}.out'
                    label = '冻结输入' if frozen else '历史验收，版本未绑定'
                    prompt += f'- {d}：{path}（{label}；原稿标识：{self.root / f"{d}.out"}）\n'
            if continuation:
                session = continuation['session_id']
                prompt += f'\n本卡接续 {continuation["card"]} 的会话，fork 为独立新会话；以本卡全文和上游冻结稿为准。\n'
            if write:
                # 不给草稿目录，截图、浏览器缓存就会落进工程（10-13 一张卡在工程里留下几百个浏览器缓存文件）
                scratch = self.root / 'scratch' / name
                scratch.mkdir(parents=True, exist_ok=True)
                prompt += f'\n\n你的草稿目录：{scratch}\n截图、试渲图、日志、浏览器缓存都放这里，不算改动，不用写进「可写」。\n'
            prompt += result_contract.rules(contract)
            selected = options[name]
            card_seconds = selected['timeout_seconds']
            started_at = now()
            if card_seconds is not None:
                deadline = (dt.datetime.fromisoformat(started_at) + dt.timedelta(seconds=card_seconds)).isoformat(timespec='milliseconds')
                prompt += (f'\n\n执行时限（以本次派发为准）：\n本机绝对截止时间：{deadline} '
                           f'（本机时区，含 UTC 偏移；本次上限 {card_seconds / 60:g} 分钟）。\n'
                           '接近截止时先交已有结论，写清楚哪部分没做完，不要等到被强制结束；'
                           '任务卡中的时间要求若与此冲突，以此为准。\n')
            output, log, prompt_file = self.root / f'{name}.out', self.root / f'{name}.log', self.root / f'{name}.prompt'
            prompt_file.write_text(prompt, encoding='utf-8')
            cmd = self.command(Path(selected['cwd']), lean, selected['effort'], output, session, sandbox,
                               selected['model'], selected['features'], fork=bool(continuation))
            attempt_id = uuid.uuid4().hex
            # 回执要先于看守进程落盘：它只改这个文件，不能被这里晚到的写入盖掉
            receipt = {'card': str(card['path']), 'card_sha256': hashlib.sha256(card['body'].encode('utf-8')).hexdigest(),
                       'deps': card['deps'], 'sandbox': sandbox, 'disabled_mcp': mcp, **selected,
                       'started_at': started_at, 'state': 'running', 'pid': 0, 'attempt_id': attempt_id,
                       'output': str(output), 'log': str(log), 'prompt': str(prompt_file)}
            if contract:
                receipt['result_contract'] = contract
            if continuation:
                receipt['continued_from'] = continuation
            elif session:
                receipt['resumed_from'] = session
                receipt['tokens_before'] = tokens_before
                if old.get('continued_from'):
                    receipt['continued_from'] = old['continued_from']
            elif fresh and old.get('session_id'):
                receipt['fresh_after'] = old['session_id']
            write_json(self.root / f'{name}.json', receipt)
            # 看守进程独立于本命令：run 返回后它继续盯执行者，超时连同子进程一起收掉
            limits = ['--seconds', str(card_seconds)] if card_seconds is not None else []
            try:
                subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '_guard', str(self.root), name,
                                  *limits, '--attempt-id', attempt_id, '--heartbeat-seconds', str(selected['heartbeat_seconds']),
                                  '--cmd', json.dumps(cmd)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
            except OSError as error:
                receipt.update(state='failed', ended_at=now(), error=f'看守未启动：{error}',
                               executor_started=False)
                write_json(self.root / f'{name}.json', receipt)
                raise
        return ready

    def snapshot(self, cwd):
        """工作目录里每个文件的 [大小, 修改时间]；跳过隐藏目录、依赖目录和运行目录自己。"""
        files = {}
        for top, dirs, names in os.walk(cwd):
            here = Path(top)
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in SKIP_DIRS and (here / d).resolve() != self.root]
            for n in names:
                st = (here / n).lstat()
                files[(here / n).relative_to(cwd).as_posix()] = [st.st_size, st.st_mtime_ns]
        return files

    def changes(self):
        """--write 的运行：相对派单前的底，哪些文件新增、改了、删了，各归哪张卡的「可写」；没卡认领的算越界。"""
        base = read_json(self.root / 'baseline.json')
        if not base:
            raise ValueError('这个运行目录不是 --write 派的，没有派单前的底可对。')
        cwd, old = Path(base['cwd']), base['files']
        new = self.snapshot(cwd)
        cards = self.cards()

        def owners(rel):
            return sorted(n for n, c in cards.items() if any(fnmatch.fnmatch(rel, g) or rel.startswith(g.rstrip('/') + '/') for g in c['writable']))

        def rows(paths):
            return [{'path': p, 'cards': owners(p)} for p in sorted(paths)]

        out = {'cwd': str(cwd), 'baseline_at': base['at'],
               'added': rows(new.keys() - old.keys()), 'deleted': rows(old.keys() - new.keys()),
               'modified': rows(p for p in new.keys() & old.keys() if new[p] != old[p])}
        out['out_of_bounds'] = sorted(r['path'] for k in ('added', 'deleted', 'modified') for r in out[k] if not r['cards'])
        return out

    def wait(self, seconds):
        """一次巡检：新交回、新卡住或到点即返回；通知另存，不改看守的回执。"""
        deadline = time.monotonic() + seconds
        while True:
            fresh, active = poll_wait(self)
            if fresh or not active:
                return fresh
            if time.monotonic() >= deadline:
                return []
            time.sleep(min(.2, max(0, deadline - time.monotonic())))

    def stop(self, name, note='', confirm_exited=False):
        """尝试专属的停止请求不等调度锁；旧格式只允许负责人显式确认退出。"""
        if confirm_exited:
            if not note.strip():
                raise ValueError('--confirm-exited 必须用 --note 说明核实退出的理由。')
            with self.lock():
                if name not in self.cards():
                    raise ValueError(f'没有这张卡：{name}')
                receipt = self.receipt(name)
                if (not receipt or receipt.get('attempt_id') or receipt.get('executor_pid') or receipt.get('executor_pgid')
                        or alive(receipt.get('pid'))):
                    raise ValueError('只可确认看守已退出且缺执行者身份的旧运行；有身份的运行请用普通 stop。')
                receipt['exit_confirmation'] = {'by': getpass.getuser(), 'uid': os.getuid(),
                                                'at': now(), 'note': note.strip()}
                write_json(self.root / f'{name}.json', receipt)
                return {'card': name, 'state': receipt_state(receipt), 'requested': False,
                        'exit_confirmation': receipt['exit_confirmation']}
        with self.lock(blocking=True, name='.stop.lock'):
            if name not in self.cards():
                raise ValueError(f'没有这张卡：{name}')
            receipt = self.receipt(name)
            if not receipt or (receipt.get('state') not in ACTIVE_STATES and not capacity_held(receipt)):
                return {'card': name, 'state': receipt_state(receipt) if receipt else 'not_started', 'requested': False}
            if not receipt.get('attempt_id'):
                raise ValueError('旧运行没有安全停止标识，不能凭 PID 停止。')
            private = self.root / '.attempts' / receipt['attempt_id']
            private.mkdir(parents=True, exist_ok=True)
            request_path = private / 'stop.json'
            request = read_json(request_path) or {'attempt_id': receipt['attempt_id'], 'at': now(), 'note': note.strip()}
            write_json(request_path, request)
            executed = False
            if receipt.get('pid') and not alive(receipt['pid']):
                stop_confirmed_group(receipt)
                # 杀的是刚核实的旧组；发布前仍核对尝试，不能覆盖新一轮。
                with self.lock(blocking=True):
                    current = self.receipt(name) or {}
                    if current.get('attempt_id') == receipt['attempt_id']:
                        for ext in ('log', 'out'):
                            src = private / f'{name}.{ext}'
                            if src.is_file():
                                src.replace(self.root / f'{name}.{ext}')
                        current.update(state='stopped', ended_at=now(), stop_requested=request,
                                       cleanup_unconfirmed=False)
                        write_json(self.root / f'{name}.json', current)
                        executed = True
            return {'card': name, 'state': 'stopped' if executed else receipt_state(receipt),
                    'requested': True, 'executed': executed, 'stop_requested': request}

    def conclusion(self, name):
        output = Path(self.receipt(name)['output'])
        text = output.read_text(encoding='utf-8', errors='replace') if output.is_file() else ''
        # ponytail: 按约定的二级标题取一节，保留三级小标题，不实现完整 Markdown 解析器。
        section = re.search(r'^##[ \t]+结论卡[ \t]*\n.*?(?=^#{1,2}[ \t]+|\Z)', text, re.M | re.S)
        return section.group().strip() if section else '缺少 ## 结论卡'

    def diff(self, name):
        if name not in self.cards():
            raise ValueError(f'没有这张卡：{name}')
        pattern = re.compile(re.escape(name) + r'-\d{8}-\d{6}(?:-\d{6})?(?:-[a-f0-9]{8})?(?:\.public)?\.out$')
        history = sorted((p for p in (self.root / 'history').glob('*.out') if pattern.fullmatch(p.name)),
                         key=lambda p: p.stem)
        if not history:
            return f'卡 {name} 没有旧交付可比较。'
        current = self.root / f'{name}.out'
        if not current.is_file():
            raise ValueError(f'卡 {name} 还没有当前交付。')
        previous = history[-1]
        result = '\n'.join(difflib.unified_diff(
            previous.read_text(encoding='utf-8', errors='replace').splitlines(),
            current.read_text(encoding='utf-8', errors='replace').splitlines(),
            fromfile=str(previous), tofile=str(current), lineterm=''))
        return result or f'卡 {name} 当前交付与最近一次旧交付相同。'

    def review(self, name, verdict, note, force=False, hold=False, accept_gaps=False):
        # 慢出处核查不占调度锁；提交前重核回执、卡片和正文，拒绝过期核查。
        with self.lock():
            cards = self.cards()
            if name not in cards:
                raise ValueError(f'没有这张卡：{name}')
            receipt = self.receipt(name)
            output = Path((receipt or {}).get('output') or self.root / f'{name}.out')
            card_hash = card_sha256(cards[name]['path'])
            data = output.read_bytes() if output.is_file() else None
        checked = check(output) if data is not None else {'citations': [], 'bad': 0, 'no_source': 0}
        with self.lock():
            if (self.receipt(name) != receipt or card_sha256(cards[name]['path']) != card_hash
                    or (output.read_bytes() if output.is_file() else None) != data):
                raise ValueError('核对期间回执、卡片或交付版本已变化，请重新验收。')
            return self._review(name, verdict, note, force, hold, accept_gaps, checked)

    def _review(self, name, verdict, note, force=False, hold=False, accept_gaps=False, checked=None):
        if not note.strip():
            raise ValueError('验收或退回都要写一句说明。')
        cards = self.cards()
        if name not in cards:
            raise ValueError(f'没有这张卡：{name}')
        state = self.state(name, cards)
        allowed = ('delivered', 'stale', 'partial') if verdict == 'accepted' else ('delivered', 'failed', 'timed_out', 'lost', 'stopped', 'stale', 'blocked', 'partial', 'protocol_error')
        if state not in allowed:
            raise ValueError(f'卡 {name} 现在是 {state}，不能{"验收" if verdict == "accepted" else "退回"}。')
        receipt = self.receipt(name)
        output = Path(receipt.get('output') or self.root / f'{name}.out')
        if verdict == 'accepted':
            card_hash = card_sha256(cards[name]['path'])
            # ponytail: 旧交付没有派发 hash 时仍可验收，保留缺值并显示 legacy。
            if receipt.get('card_sha256') and receipt['card_sha256'] != card_hash:
                raise ValueError('派发时的卡片版本已变化，不能验收；请退回后重试。')
            if not output.is_file():
                raise ValueError('交付文件不存在或为空，不能验收；请恢复交付或退回重做。')
            data = output.read_bytes()
            if not data.decode('utf-8', errors='replace').strip():
                raise ValueError('交付文件不存在或为空，不能验收；请恢复交付或退回重做。')
        meta = read_json(self.root / 'run.json') or {}
        review = {'verdict': verdict, 'note': note.strip(), 'at': now()}
        if verdict == 'accepted':
            review.update(result_contract.acceptance(receipt, note, accept_gaps))
        result = {'citations': [], 'bad': 0, 'no_source': 0}
        if output.is_file():
            result = checked if checked is not None else check(output)
            review.update(citations=len(result['citations']), citations_bad=result['bad'])
            if verdict == 'accepted' and result['bad'] and not force:
                raise ValueError(f'有 {result["bad"]} 条引用对不上原文。先 reject 后用 --retry 重派；确认仍接受就在说明里写清原因并加 --force。')
        if verdict == 'accepted' and not meta.get('write', receipt.get('sandbox') == 'danger-full-access'):
            # ponytail: 只提醒出处数量与明写的“无来源”，不推断引用是否支撑结论。
            warnings = []
            if not any(c['status'] == 'ok' for c in result['citations']):
                warnings.append('没有可核对的出处，请负责人判断是否接受。')
            if result['no_source']:
                warnings.append('交付写有“无来源”，请负责人核实依据是否足够。')
            review['source_warnings'] = warnings
        if verdict == 'accepted':
            if card_sha256(cards[name]['path']) != card_hash or output.read_bytes() != data:
                raise ValueError('核对期间卡片或交付版本已变化，请重新验收。')
            # 每次验收独立留稿，已派下游的路径永不被再次验收覆盖。
            accepted = self.root / '.accepted' / f'{name}-{uuid.uuid4().hex}.out'
            accepted.parent.mkdir(exist_ok=True)
            with accepted.open('xb') as frozen:
                frozen.write(data)
            review.update(card_sha256=card_hash, output_sha256=hashlib.sha256(data).hexdigest(),
                          accepted_output=str(accepted))
        if receipt.get('review'):
            receipt.setdefault('review_history', []).append(receipt['review'])
        receipt['review'] = review
        write_json(self.root / f'{name}.json', receipt)
        dispatched, deferred, warnings = [], [], []
        if verdict == 'accepted' and not hold and all(k in meta for k in ('cwd', 'minutes', 'effort', 'model', 'write')):
            # 只推进本次验收解锁的下游，其他分支用 --hold 留下的卡不顺带派出。
            ready = [n for n, c in cards.items() if name in c['deps'] and self.state(n, cards) == 'ready']
            if ready:
                try:
                    dispatched = self._run(Path(meta['cwd']), meta['minutes'] * 60 if meta['minutes'] is not None else None,
                                           meta['effort'], None, [], meta['write'], meta['model'], only=ready,
                                           stall_seconds=meta.get('stall_seconds', STALL_MINUTES * 60),
                                           max_parallel=meta.get('max_parallel'),
                                           heartbeat_seconds=meta.get('heartbeat_seconds', HEARTBEAT_SECONDS),
                                           features=meta.get('features', []))
                    deferred = self.deferred
                    warnings = self.warnings
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    raise ValueError(f'卡 {name} 已验收，但下游未能全部派出：{error}') from error
        return {**review, 'dispatched': dispatched, 'deferred': deferred, 'warnings': warnings}


def guard(root, name, seconds, cmd, attempt_id=None, heartbeat_seconds=HEARTBEAT_SECONDS):
    """每轮私有输出，持锁核对尝试后才能更新心跳或发布终态。"""
    run = Run(root)
    root = run.root
    receipt_path = root / f'{name}.json'
    with run.lock(blocking=True):
        receipt = read_json(receipt_path)
        if not receipt or receipt.get('attempt_id') != attempt_id or receipt.get('state') not in ACTIVE_STATES:
            return
        receipt['pid'] = os.getpid()
        receipt['heartbeat_seconds'] = heartbeat_seconds
        write_json(receipt_path, receipt)
    private = root / '.attempts' / attempt_id if attempt_id else root
    log, output = private / f'{name}.log', private / f'{name}.out'
    cmd = [str(output) if arg == receipt['output'] else arg for arg in cmd]

    def requested(current):
        request = read_json(private / 'stop.json') or current.get('stop_requested', {})
        if request.get('attempt_id') == attempt_id:
            receipt['stop_requested'] = request
        return (current.get('attempt_id') != attempt_id
                or request.get('attempt_id') == attempt_id and bool(request))

    t0 = time.monotonic()
    proc, stopped, timed_out, error = None, False, False, None
    cleanup_unconfirmed = False
    try:
        private.mkdir(parents=True, exist_ok=True)
        prompt = Path(receipt['prompt']).read_bytes()
        with log.open('w') as log_file:
            # 启动和登记身份同锁，stop/retry 不会穿过尚未登记的执行者。
            with run.lock(blocking=True):
                current = read_json(receipt_path) or {}
                stopped = requested(current)
                if not stopped:
                    proc = subprocess.Popen(cmd, cwd=receipt['cwd'], stdin=subprocess.PIPE, stdout=log_file,
                                            stderr=subprocess.STDOUT, start_new_session=True)
                    receipt.update(executor_pid=proc.pid, executor_pgid=proc.pid)
                    current.update(executor_pid=proc.pid, executor_pgid=proc.pid)
                    write_json(receipt_path, current)
            deadline = t0 + seconds if seconds is not None else None
            first, completed, next_heartbeat = True, False, t0
            while proc is not None:
                current = read_json(receipt_path) or {}
                stopped = requested(current)
                timed_out = deadline is not None and time.monotonic() >= deadline
                if stopped or timed_out:
                    if proc.returncode is None:
                        kill_tree(proc)
                    else:
                        stop_confirmed_group(receipt)
                    break
                if completed and executor_group_free(receipt):
                    break
                if time.monotonic() >= next_heartbeat:
                    heartbeat = log_heartbeat(receipt, log)
                    idle = (dt.datetime.now().astimezone() - dt.datetime.fromisoformat(heartbeat['log_mtime'])).total_seconds()
                    receipt['executor_identity'] = executor_identity(receipt) or receipt.get('executor_identity', {})
                    receipt['heartbeat'] = heartbeat
                    try:
                        with run.lock():
                            current = read_json(receipt_path) or {}
                            if current.get('attempt_id') == attempt_id and current.get('state') in ACTIVE_STATES:
                                current.update(heartbeat=heartbeat, executor_identity=receipt['executor_identity'])
                                if idle >= receipt.get('stall_seconds', STALL_MINUTES * 60):
                                    current['state'] = 'stalled'
                                    current.setdefault('stalled_at', now())
                                else:
                                    current['state'] = 'running'
                                    current.pop('stalled_at', None)
                                write_json(receipt_path, current)
                    except ValueError:
                        # 调度占锁时跳过落盘，继续看截止时间和尝试专属的停止请求。
                        pass
                    next_heartbeat = time.monotonic() + heartbeat_seconds
                try:
                    interval = min(.2, heartbeat_seconds)
                    if deadline is not None:
                        interval = min(interval, max(.001, deadline - time.monotonic()))
                    if completed:
                        time.sleep(interval)
                    else:
                        proc.communicate(input=prompt if first else None, timeout=interval)
                        completed = True
                except subprocess.TimeoutExpired:
                    first = False
    except Exception as exc:
        error = str(exc)
        if proc is not None and proc.returncode is None:
            try:
                kill_tree(proc)
            except Exception as cleanup_error:
                cleanup_unconfirmed = True
                error += f'；未确认停止：{cleanup_error}'
        if proc is not None and not executor_group_free(receipt):
            cleanup_unconfirmed = True
        if cleanup_unconfirmed:
            stopped = timed_out = False
    size, session, tokens = 0, None, None
    try:
        size = output.stat().st_size if output.is_file() else 0
        session, tokens = read_log(log)
        receipt['heartbeat'] = log_heartbeat(receipt, log)
    except OSError as exc:
        error = str(exc)
    code = proc.returncode if proc is not None else None
    state = 'stopped' if stopped else 'timed_out' if timed_out else ('finished' if code == 0 and size and not error else 'failed')
    before = receipt.get('tokens_before')
    receipt.update(state=state, exit_code=code, ended_at=now(), seconds=round(time.monotonic() - t0, 1),
                   output_bytes=size, session_id=session or receipt.get('resumed_from'), tokens_session=tokens,
                   tokens=tokens - before if tokens is not None and before else tokens,
                   error=error, cleanup_unconfirmed=cleanup_unconfirmed)
    with run.lock(blocking=True):
        current = read_json(receipt_path) or {}
        if current.get('attempt_id') != attempt_id or current.get('state') not in ACTIVE_STATES:
            return
        for src, dst in ((log, Path(receipt['log'])), (output, Path(receipt['output']))):
            if src.exists():
                src.replace(dst)
        # 合并当前记录，保留 stop 请求及负责人已经写入的字段。
        current.update(receipt)
        current.pop('stalled_at', None)
        try:
            result_contract.collect(current)
        except Exception as exc:
            # 协议解析失败不能抹掉执行终态、用量和已发布的原稿。
            current['result'] = {'status': 'protocol_error', 'questions': [], 'covered': [], 'skipped': [],
                                 'errors': [f'result-v1 交付读取或解析失败：{exc}'], 'raw': ''}
        write_json(receipt_path, current)


def poll_wait(run):
    """非阻塞地巡检一个目录，返回新通知和是否仍需等待。"""
    # 派发预检可能持锁较久，不让一个目录挡住其他运行或巡检期限。
    with (run.root / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return [], True
        cards = run.cards()
        states = {n: run.state(n, cards) for n in cards}
        notifications = read_json(run.root / '.wait.json') or {}
        fresh = []
        for n, state in states.items():
            if state not in ('delivered', 'failed', 'timed_out', 'lost', 'stopped', 'stalled',
                             'blocked', 'partial', 'protocol_error'):
                continue
            receipt = run.receipt(n)
            # 同一段无输出只通知一次，不因看守恢复落盘或再次停更重复提醒。
            stalled_at = (receipt.get('heartbeat', {}).get('log_mtime', receipt.get('started_at'))
                          if state == 'stalled' else receipt.get('stalled_at'))
            key = [receipt.get('attempt_id', receipt.get('started_at')), state, stalled_at]
            if notifications.get(n) != key and not (receipt.get('notified') and n not in notifications):
                fresh.append(n)
                notifications[n] = key
        if fresh:
            write_json(run.root / '.wait.json', notifications)
        return fresh, any(st in ACTIVE_STATES for st in states.values())


def wait_result(run, fresh):
    result = run.status()
    result['fresh'] = fresh
    for card in result['cards']:
        if card['card'] in fresh and card['state'] not in ACTIVE_STATES:
            card['conclusion'] = run.conclusion(card['card'])
    return result


def wait_many(runs, seconds):
    """多个运行共用一个期限；每轮都看一遍，任一新事件即返回。"""
    deadline = time.monotonic() + seconds
    while True:
        polled = [poll_wait(run) for run in runs]
        if any(fresh for fresh, _ in polled) or not any(active for _, active in polled) or time.monotonic() >= deadline:
            return {'runs': [wait_result(run, fresh) for run, (fresh, _) in zip(runs, polled)]}
        time.sleep(min(.2, max(0, deadline - time.monotonic())))


# ponytail: 只认绝对路径；带空格的路径要求执行者用反引号括起来，执行者规矩里已写明
QUOTED = re.compile(r'`(/[^`\n]+?)(?::L?(\d+)(?:[-–~]L?(\d+))?|#p(\d+))`')
BARE = re.compile(r'(?<![\w./~\\-])(/[^\s`|:：，,;；。！？()（）\[\]<>"\'#]+)(?::L?(\d+)(?:[-–~]L?(\d+))?|#p(\d+))')
LINK = re.compile(r'\[[^\]\n]*\]\(([^)\n]*)\)')
URL = re.compile(r'\b[A-Za-z][A-Za-z0-9+.-]*://[^\s`<>\[\]()（）。，；！？]+')


def pdf_page(path, page):
    if not shutil.which('pdftotext'):
        return '未核页码', '本机没有 pdftotext，无法核对 PDF 页码'
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
    # ponytail: 只处理行内链接，优先取目标；不把标签或网址里的斜杠当作本地路径。
    text = LINK.sub(lambda m: ' ' + m.group(1) + ' ', text)
    text = URL.sub(' ', text)
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
    argv = sys.argv[1:] if argv is None else argv
    # 模块自管参数与退出码；先分流，保留原参数顺序，也让 --help 到达模块。
    if argv and argv[0] == 'stats':
        import stats
        return stats.main(argv[1:])
    if argv and argv[0] == 'note':
        import notes
        return notes.main(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    r = sub.add_parser('run', help='派出所有就绪的卡（无依赖或依赖都已验收），同时开跑')
    r.add_argument('run_dir', type=Path)
    r.add_argument('--cwd', type=Path, help='未指定时沿用运行配置，重试沿用原卡；新运行默认当前目录')
    r.add_argument('--goal')
    r.add_argument('--minutes', type=float, help='执行硬上限；省略沿用原设置，新运行不限时')
    r.add_argument('--seconds', type=float, help=argparse.SUPPRESS)  # 测试用
    r.add_argument('--stall-minutes', type=float, help='多久无输出标记疑似卡住；省略沿用原设置，新运行默认 15')
    r.add_argument('--max-parallel', type=int, help='同时占位的卡数上限；默认不限')
    r.add_argument('--heartbeat-seconds', type=float, help=argparse.SUPPRESS)  # 测试缩短时间尺度
    r.add_argument('--model', help='模型名；不指定时用 Codex 配置，续改沿用原卡')
    r.add_argument('--effort', choices=('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), help='默认 high，续改未指定时沿用原卡')
    r.add_argument('--enable', action='append', help='启用 Codex 特性，可重复；卡头特性覆盖本列表，省略沿用原设置')
    r.add_argument('--retry', action='append', default=[], help='把退回、失败、超时的卡存档后重派')
    r.add_argument('--fresh', action='store_true', help='与 --retry 一起使用：开新会话，不续接旧会话')
    r.add_argument('--write', action='store_true', help='不开沙箱、允许改文件（只改卡里「可写」的路径）；派单前拍底，用 changes 对账')
    w = sub.add_parser('wait', help='巡检：到点、有卡交回或新卡住时返回')
    w.add_argument('run_dir', type=Path, nargs='+', help='一个或多个运行目录')
    w.add_argument('--minutes', type=float, default=10)
    g = sub.add_parser('_guard', help=argparse.SUPPRESS)
    g.add_argument('run_dir', type=Path)
    g.add_argument('card')
    g.add_argument('--seconds', type=float)
    g.add_argument('--attempt-id')
    g.add_argument('--heartbeat-seconds', type=float, default=HEARTBEAT_SECONDS)
    g.add_argument('--cmd', required=True)
    ch = sub.add_parser('changes', help='--write 的运行：工作目录改了哪些文件，哪些越界')
    ch.add_argument('run_dir', type=Path)
    s = sub.add_parser('status', help='每张卡的状态')
    s.add_argument('run_dir', type=Path)
    stop = sub.add_parser('stop', help='请求当前尝试停止，保留已有输出')
    stop.add_argument('run_dir', type=Path)
    stop.add_argument('card')
    stop.add_argument('--note', default='')
    stop.add_argument('--confirm-exited', action='store_true', help='确认无执行者身份的旧运行已退出；必须写 --note，不发进程信号')
    d = sub.add_parser('diff', help='比较最近一次旧交付和当前交付')
    d.add_argument('run_dir', type=Path)
    d.add_argument('card')
    for verb in ('accept', 'reject'):
        v = sub.add_parser(verb, help='负责人验收' if verb == 'accept' else '负责人退回')
        v.add_argument('run_dir', type=Path)
        v.add_argument('card')
        v.add_argument('--note', required=True)
        if verb == 'accept':
            v.add_argument('--force', action='store_true', help=argparse.SUPPRESS)
            v.add_argument('--hold', action='store_true', help='只验收，不自动派出就绪下游')
            v.add_argument('--accept-gaps', action='store_true', help='接受 partial 交付；--note 须逐项写明接受的缺口 ID')
    c = sub.add_parser('check', help='把交付里的 路径:行号 引用对回原文')
    c.add_argument('report', type=Path)
    sub.add_parser('stats', help='统计运行目录或原生子线程清单；stats --help 查看参数')
    sub.add_parser('note', help='新建改进记录或重建索引；note --help 查看参数')
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
            guard(args.run_dir, args.card, args.seconds, json.loads(args.cmd), args.attempt_id, args.heartbeat_seconds)
            return 0
        if args.action == 'wait':
            if not math.isfinite(args.minutes) or args.minutes <= 0:
                raise ValueError('巡检分钟数须为正数。')
            runs = [Run(path) for path in dict.fromkeys(path.resolve() for path in args.run_dir)]
            result = (wait_result(runs[0], runs[0].wait(args.minutes * 60)) if len(runs) == 1 else
                      wait_many(runs, args.minutes * 60))
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        run = Run(args.run_dir)
        if args.action == 'run':
            for value in (args.minutes, args.seconds, args.stall_minutes, args.heartbeat_seconds):
                if value is not None and (not math.isfinite(value) or value <= 0):
                    raise ValueError('时长参数须为正数。')
            if args.max_parallel is not None and args.max_parallel < 1:
                raise ValueError('--max-parallel 须为正整数。')
            seconds = args.seconds if args.seconds is not None else args.minutes * 60 if args.minutes is not None else None
            dispatched = run.run(args.cwd.resolve() if args.cwd is not None else None,
                                 seconds, args.effort, args.goal, args.retry, args.write, args.model,
                                 fresh=args.fresh, stall_seconds=args.stall_minutes * 60 if args.stall_minutes is not None else None,
                                 max_parallel=args.max_parallel, heartbeat_seconds=args.heartbeat_seconds, features=args.enable)
            print(json.dumps({**run.status(), 'dispatched': dispatched, 'deferred': run.deferred,
                              'warnings': run.warnings}, ensure_ascii=False, indent=2))
            return 0
        if args.action == 'stop':
            print(json.dumps(run.stop(args.card, args.note, args.confirm_exited), ensure_ascii=False, indent=2))
            return 0
        if args.action == 'changes':
            result = run.changes()
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1 if result['out_of_bounds'] else 0
        if args.action == 'diff':
            print(run.diff(args.card))
            return 0
        if args.action in ('accept', 'reject'):
            verdict = 'accepted' if args.action == 'accept' else 'rejected'
            print(json.dumps(run.review(args.card, verdict, args.note, getattr(args, 'force', False),
                                        getattr(args, 'hold', False), getattr(args, 'accept_gaps', False)), ensure_ascii=False, indent=2))
            return 0
        print(json.dumps(run.status(), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
