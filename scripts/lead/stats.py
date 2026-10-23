"""运行统计：crew 回执目录，或明确指定的 Codex 原生子线程清单。

  python3 scripts/lead/stats.py <运行目录> [--out-dir 目录]
  python3 scripts/lead/stats.py --manifest 清单 --root-log 主日志 --turn-id 轮次 --out-dir 目录
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path

from acceptance import acceptance_info, VALIDITY_LABELS
from worker import Run, claude_tokens, CLAUDE_USAGE_KEYS

FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def read_log(path):
    lines = Path(path).read_bytes().splitlines(keepends=True)
    records = []
    for index, line in enumerate(lines):
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            if index == len(lines) - 1 and not line.endswith(b"\n"):
                break  # 日志可能还在写，容忍末尾尚未写完的一行。
            raise
    return records


def root_scope(record, turn_id, child=False):
    payload = record.get("payload", {})
    if child:
        root_turn = payload.get("root_turn_id") or payload.get("turn_attribution", {}).get("root_turn_id")
        return root_turn == turn_id
    return payload.get("turn_id") == turn_id


def usage(records, turn_id, start, end, child=False, seen=None):
    result = Counter()
    seen = set() if seen is None else seen
    before = len(seen)
    for record in records:
        if record.get("type") != "token_usage_record":
            continue
        if turn_id is not None and not root_scope(record, turn_id, child):
            continue
        if not start <= timestamp(record["timestamp"]) <= end:
            continue
        payload = record["payload"]
        response = payload["response_id"]
        if response in seen:
            continue
        seen.add(response)
        for key in FIELDS:
            result[key] += payload["usage"].get(key, 0)
    result["uncached_input_tokens"] = result["input_tokens"] - result["cached_input_tokens"]
    return dict(result), len(seen) - before


def summarize(manifest, root_log, turn_id, start_override=None, snapshot=None):
    root_records = read_log(root_log)
    events = [r for r in root_records if r.get("type") == "event_msg" and root_scope(r, turn_id)]
    starts = [timestamp(r["timestamp"]) for r in events if r["payload"].get("type") == "task_started"]
    ends = [timestamp(r["timestamp"]) for r in events if r["payload"].get("type") == "task_complete"]
    if not starts and not start_override:
        raise ValueError("未找到主轮次开始事件；请提供原请求时间 --start，不能用首次usage代替完整耗时")
    start = timestamp(start_override) if start_override else min(starts)
    now = snapshot if snapshot is not None else datetime.now(timezone.utc).timestamp()
    end = min(max(ends), now) if ends else now
    if end < start:
        raise ValueError("统计终点早于开始时间")
    children, intervals, edge_events = [], [], []
    identities = set()
    for agent in manifest:
        if agent["id"] in identities:
            raise ValueError(f"重复子线程ID: {agent['id']}")
        identities.add(agent["id"])
        records = read_log(agent["rollout_path"])
        pending, task_count, aborted = {}, 0, 0
        for record in records:
            if record.get("type") != "event_msg" or not root_scope(record, turn_id, child=True):
                continue
            t = timestamp(record["timestamp"])
            if t > end:
                continue
            payload = record["payload"]
            key = payload.get("turn_id") or payload.get("turn_attribution", {}).get("turn_id")
            kind = payload.get("type")
            if kind == "task_started":
                pending[key] = max(t, start)
                task_count += 1
            elif kind in ("task_complete", "turn_aborted") and key in pending:
                a = pending.pop(key)
                if t > a:
                    intervals.append((a, t))
                aborted += kind == "turn_aborted"
        intervals.extend((a, end) for a in pending.values() if end > a)
        u, count = usage(records, turn_id, start, end, child=True)
        if not task_count and not count:
            raise ValueError(f"{agent['agent_path']}没有匹配本轮的事件/usage，请核对清单和turn-id")
        children.append(dict({key: agent[key] for key in ('id', 'agent_path', 'rollout_path')},
                             usage=u, responses=count, tasks=task_count,
                             unfinished_tasks=len(pending), aborted_tasks=aborted))
    for a, b in intervals:
        edge_events.extend(((a, 1), (b, -1)))
    active = peak = 0
    for _, change in sorted(edge_events):
        active += change
        peak = max(peak, active)
    merged = []
    for a, b in sorted(intervals):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    parent_only, cursor = [], start
    for a, b in merged:
        if a > cursor:
            parent_only.append([iso(cursor), iso(a), a - cursor])
        cursor = max(cursor, b)
    if cursor < end:
        parent_only.append([iso(cursor), iso(end), end - cursor])
    root_usage, root_responses = usage(root_records, turn_id, start, end)
    combined = {k: root_usage.get(k, 0) + sum(c["usage"].get(k, 0) for c in children)
                for k in (*FIELDS, "uncached_input_tokens")}
    return dict(root_turn_id=turn_id, start=iso(start), end=iso(end),
                status="已结束轮次" if ends and max(ends) <= now else "运行中截点",
                wall_seconds=end - start, peak_active_child_tasks=peak,
                child_active_sum_seconds=sum(b - a for a, b in intervals),
                child_any_active_seconds=sum(b - a for a, b in merged),
                parent_only_seconds=sum(r[2] for r in parent_only),
                parent_only_intervals=parent_only, children=children,
                root_usage=root_usage, root_responses=root_responses, combined_usage=combined)


def render(metrics):
    m, u = metrics, metrics["combined_usage"]
    rows = [f"| {c['agent_path']} | {c['tasks']} | {c['usage'].get('total_tokens',0):,} | "
            f"{c['usage'].get('uncached_input_tokens',0):,} | {c['unfinished_tasks']} |"
            for c in m["children"]]
    return "\n".join([
        "# 编排运行摘要", "", f"状态：{m['status']}；范围：{m['start']} — {m['end']}。",
        f"主轮次：`{m['root_turn_id']}`。", "",
        f"- 全程：{m['wall_seconds']/60:.2f}分钟；子线程{len(m['children'])}个，峰值活动子任务{m['peak_active_child_tasks']}个。",
        f"- 子任务累计活动：{m['child_active_sum_seconds']/60:.2f}线程分钟；至少一个子任务活动：{m['child_any_active_seconds']/60:.2f}分钟。",
        f"- 只有主线程活动的区间合计：{m['parent_only_seconds']/60:.2f}分钟。包含必要综合，不全部等同闲置或浪费。",
        f"- 累计处理token：{u['total_tokens']:,}；输入{u['input_tokens']:,}，其中缓存{u['cached_input_tokens']:,}、非缓存{u['uncached_input_tokens']:,}；输出{u['output_tokens']:,}。", "",
        "| 子线程 | 任务轮次 | 累计处理token | 非缓存输入 | 截点未结束任务 |",
        "|---|---:|---:|---:|---:|", *rows, "",
        "按单次usage的response_id去重，缓存是输入子集，推理是输出子集。活动区间包含工具等待；没有单线程对照，不能据此称加速多少倍。",
        "只读取指定清单与主轮次。不估价、不扫描其他会话；不计数据库/缓存存储。质量、返工与业务结果需另读原产物。", ""])


# ponytail: 回执没有派发编号，以首张卡开始后 5 秒内近似同一批；不按相邻卡连锁扩批。
BATCH_SECONDS = 5
LABELS = {'finished': '已交付', 'running': '未结束', 'failed': '失败',
          'timed_out': '超时', 'lost': '失联', 'accepted': '通过',
          'rejected': '退回', 'ready': '待派发', 'waiting': '等依赖'}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def card_list(root):
    run = Run(root)
    cards = {}
    for path in sorted((root / 'cards').glob('*.md')):
        deps = run.dependencies(path.read_text(encoding='utf-8'))
        cards[path.stem] = {'card': path.stem, 'deps': deps}
    return cards


def attempt_list(root, cards, start):
    attempts = []
    paths = list((root / 'history').glob('*.json'))
    paths += [root / f'{name}.json' for name in cards if (root / f'{name}.json').is_file()]
    for path in paths:
        r = read_json(path)
        name = Path(r.get('card', '')).stem or re.sub(r'-\d{8}-\d{6}(?:-\d{6})?$', '', path.stem)
        a = timestamp(r['started_at'])
        b = timestamp(r['ended_at']) if r.get('ended_at') else None
        review = r.get('review') or {}
        reviewed = timestamp(review['at']) if review.get('at') else None
        if a < start or (b is not None and b < a) or (reviewed is not None and reviewed < (b if b is not None else a)):
            raise ValueError(f'{path.name}：事件时间早于开始或交付时间')
        attempts.append(dict(card=name, receipt=str(path.relative_to(root)),
                             deps=r.get('deps', cards.get(name, {}).get('deps', [])),
                             started_at=r['started_at'], ended_at=r.get('ended_at'),
                             end_unknown=b is None and (path.parent == root / 'history'
                                                        or r['state'] in ('lost', 'stopped')),
                             seconds=b - a if b is not None else None, state=r['state'],
                             verdict=review.get('verdict'), review_at=review.get('at'),
                             review_wait_seconds=reviewed - b if reviewed is not None and b is not None else None,
                             tokens=r.get('tokens'), session_id=r.get('session_id') or r.get('resumed_from'),
                             executor=r.get('executor', 'codex'),
                             usage_basis=r.get('usage_basis', 'codex_cli_reported'),
                             reported_usage={k: r['usage'][k] for k in CLAUDE_USAGE_KEYS}
                             if r.get('executor') == 'claude' and claude_tokens(r.get('usage')) is not None else None))
    # 兼容旧整秒回执；同一时刻重派时先排归档，再排当前回执。
    attempts.sort(key=lambda r: (timestamp(r['started_at']), r['card'],
                                 not r['receipt'].startswith('history/'), Path(r['receipt']).stem))
    counts = Counter()
    for r in attempts:
        counts[r['card']] += 1
        r['attempt'] = counts[r['card']]
    return attempts


def receipt_usage(attempts, end, sessions):
    """只打开文件名匹配回执 session_id 的日志；重派按各自时间窗口算。"""
    wanted = {a['session_id'] for a in attempts if a.get('executor', 'codex') == 'codex'
              and a['session_id'] and not a['end_unknown']}
    paths = {sid: [] for sid in wanted}
    # 只列目录，不读其他会话的内容；同一会话多次尝试只读一次。
    for path in sessions.rglob('*.jsonl') if wanted else ():
        for sid in wanted:
            if path.name.endswith(f'-{sid}.jsonl'):
                paths[sid].append(path)
    logs = {}
    for sid, matches in paths.items():
        if len(matches) != 1:
            logs[sid] = ('无日志' if not matches else '日志不唯一', None)
            continue
        try:
            logs[sid] = ('已读取', read_log(matches[0]))
        except (OSError, ValueError):
            logs[sid] = ('日志不可读', None)
    seen = {sid: set() for sid in wanted}
    for a in attempts:
        if a.get('executor') == 'claude':
            # Claude 的缓存字段是独立用量，不能套用 Codex 的输入子集或会话日志口径。
            a.update(log_status='Claude JSON' if claude_tokens(a.get('reported_usage')) is not None else 'Claude 用量未知',
                     usage=None, responses=None)
            continue
        status, records = logs.get(a['session_id'], ('无日志', None))
        a.update(log_status=status, usage=None, responses=None)
        if a['end_unknown']:
            a['log_status'] = '结束时间未知'
            continue
        if records is None:
            continue
        lower = timestamp(a['started_at'])
        upper = timestamp(a['ended_at']) if a['ended_at'] else end
        try:
            selected = [r for r in records if r.get('type') == 'token_usage_record'
                        and lower <= timestamp(r['timestamp']) <= upper]
            if not selected:
                a['log_status'] = '无匹配用量记录'
                continue
            if any(not {'input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'}
                   <= r.get('payload', {}).get('usage', {}).keys() for r in selected):
                a['log_status'] = '用量字段不全'
                continue
            # ponytail: 回执未记录日志轮次，重叠或相接窗口按尝试顺序归属；同会话响应只计一次。
            claimed = seen[a['session_id']].copy()
            u, count = usage(selected, None, lower, upper, seen=claimed)
            seen[a['session_id']] = claimed  # 整个窗口读取成功后才认领，坏记录不吞掉后续有效响应。
            a.update(usage=u, responses=count)
            if not count:
                a.update(log_status='用量已归入其他尝试',
                         usage={key: 0 for key in (*FIELDS, 'uncached_input_tokens')})
        except (KeyError, TypeError, ValueError):
            a['log_status'] = '用量记录不可读'


def crew_intervals(attempts, start, end):
    """扫描半开区间；同一时刻先合并变化，结束与启动相接不虚增并发。"""
    edges = {start: [0, 0], end: [0, 0]}
    active_sum = 0

    def add(a, b, kind):
        if b > a:
            edges.setdefault(a, [0, 0])[kind] += 1
            edges.setdefault(b, [0, 0])[kind] -= 1

    for r in attempts:
        r['pending_review_seconds'] = None
        if r['end_unknown']:
            continue
        a = timestamp(r['started_at'])
        b = timestamp(r['ended_at']) if r['ended_at'] else end
        add(a, b, 0)
        active_sum += b - a
        if r['state'] == 'finished' and r['ended_at']:
            reviewed = timestamp(r['review_at']) if r['review_at'] else end
            add(b, reviewed, 1)
            if not r['review_at']:
                r['pending_review_seconds'] = end - b
    active = pending = peak = 0
    busy = waiting = idle = 0
    cursor = start
    intervals = []
    for t, (delta_active, delta_pending) in sorted(edges.items()):
        seconds = t - cursor
        if active:
            busy += seconds
        elif seconds:
            kind = 'awaiting_review' if pending else 'other_idle'
            waiting += seconds if pending else 0
            idle += seconds if not pending else 0
            intervals.append(dict(start=iso(cursor), end=iso(t), seconds=seconds, kind=kind))
        active += delta_active
        pending += delta_pending
        peak = max(peak, active)
        cursor = t
    return dict(worker_active_sum_seconds=active_sum, worker_any_active_seconds=busy,
                peak_active_workers=peak, no_worker_seconds=waiting + idle,
                awaiting_review_seconds=waiting, other_idle_seconds=idle,
                no_worker_intervals=intervals)


def dispatch_batches(attempts):
    batches = []
    for r in attempts:
        t = timestamp(r['started_at'])
        if not batches or t - timestamp(batches[-1]['started_at']) > BATCH_SECONDS:
            batches.append(dict(started_at=r['started_at'], last_started_at=r['started_at'],
                                start_span_seconds=0, attempts=[]))
        batch = batches[-1]
        batch['last_started_at'] = r['started_at']
        batch['start_span_seconds'] = t - timestamp(batch['started_at'])
        batch['attempts'].append(dict(card=r['card'], attempt=r['attempt']))
    return batches


def summarize_crew(root):
    root = Path(root)
    start = timestamp(read_json(root / 'run.json')['created_at'])
    run = Run(root)
    cards = card_list(root)
    dependency_cards = {name: {'path': root / 'cards' / f'{name}.md'} for name in cards}
    attempts = attempt_list(root, cards, start)
    events = [timestamp(a[k]) for a in attempts for k in ('started_at', 'ended_at', 'review_at') if a[k]]
    end = max([start, *events])
    deliveries = [timestamp(a['ended_at']) for a in attempts if a['state'] == 'finished' and a['ended_at']]
    reviews = [timestamp(a['review_at']) for a in attempts if a['review_at']]
    intervals = crew_intervals(attempts, start, end)
    sessions = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex') / 'sessions'
    receipt_usage(attempts, end, sessions)
    latest = {a['card']: a for a in attempts}
    validity = dict.fromkeys(cards, False)
    binding = dict.fromkeys(cards, 'none')
    for a in attempts:
        receipt = read_json(root / a['receipt'])
        info = acceptance_info(receipt, root / 'cards' / f"{a['card']}.md")
        valid = info['accepted_valid']
        current = a['receipt'] == f"{a['card']}.json"
        a['ever_accepted'] = a['verdict'] == 'accepted' or any(
            isinstance(item, dict) and item.get('verdict') == 'accepted'
            for item in receipt.get('review_history') or [])
        a['accepted_valid'] = valid if current or valid is None else False
        a['acceptance'] = info['acceptance']
        if current:
            validity[a['card']] = valid
            binding[a['card']] = info['acceptance']
    for name, card in cards.items():
        a = latest.get(name)
        # ponytail: 历史统计仍容忍本运行缺卡；外部只参与就绪，不加入尝试和用量。
        ready = all((d in cards or run.external_dependency(d))
                    and run.dependency(d, dependency_cards)['accepted_valid'] is not False for d in card['deps'])
        card.update(state=(a['verdict'] or a['state']) if a else ('ready' if ready else 'waiting'),
                    attempts=a['attempt'] if a else 0,
                    ever_accepted=any(r['card'] == name and r['ever_accepted'] for r in attempts),
                    accepted_valid=validity[name], acceptance=binding[name])
        if a and a['verdict'] == 'accepted' and validity[name] is False:
            card['state'] = 'stale'
    covered = [a for a in attempts if a['usage'] is not None]
    combined = {key: sum(a['usage'].get(key, 0) for a in covered)
                for key in (*FIELDS, 'uncached_input_tokens')}
    by_executor = {}
    for executor in sorted({a['executor'] for a in attempts}):
        group = [a for a in attempts if a['executor'] == executor]
        known = [a['tokens'] for a in group if a['tokens'] is not None]
        by_executor[executor] = {
            'usage_basis': 'claude_json_input_output_cache' if executor == 'claude' else 'codex_cli_reported',
            'tokens': sum(known) if known else None, 'missing_attempts': len(group) - len(known)}
    return dict(mode='crew', start=iso(start), end=iso(end), status='截至最后回执事件',
                wall_seconds=end - start,
                first_delivery_seconds=min(deliveries) - start if deliveries else None,
                last_delivery_at=iso(max(deliveries)) if deliveries else None,
                last_review_at=iso(max(reviews)) if reviews else None,
                tail_review_seconds=max(reviews) - max(deliveries)
                if reviews and deliveries and max(reviews) >= max(deliveries) else None,
                cards=list(cards.values()), attempts=attempts, **intervals,
                dispatch_batch_threshold_seconds=BATCH_SECONDS, dispatch_batches=dispatch_batches(attempts),
                receipt_tokens=(None if len(by_executor) > 1 else by_executor['claude']['tokens']
                                if 'claude' in by_executor else sum(a['tokens'] for a in attempts if a['tokens'] is not None)),
                receipt_usage_by_executor=by_executor,
                tokens_missing_attempts=sum(a['tokens'] is None for a in attempts),
                combined_usage=combined, usage_covered_attempts=len(covered))


def render_crew(m, version=3):
    # ponytail: 保留两轮旧排版，只供成对产物逐字核对；不凭标题猜测生成文件。
    labels = {**LABELS, 'stalled': '停滞', 'stopped': '已停止'} if version >= 3 else LABELS
    def cell(value):
        return str(value).replace('|', '\\|').replace('\n', ' ') if value is not None else '—'

    def seconds(value):
        return f'{value:g}秒' if value is not None else '—'

    batches = '；'.join(f"第{i}批 {len(b['attempts'])}次尝试／启动跨度{seconds(b['start_span_seconds'])}"
                       for i, b in enumerate(m['dispatch_batches'], 1)) or '无派发'
    has_claude = any(a.get('executor') == 'claude' for a in m['attempts'])
    native_attempts = sum(a.get('executor', 'codex') == 'codex' for a in m['attempts'])
    receipt_summary = f"回执 tokens 增量合计 {m['receipt_tokens']:,}（缺值 {m['tokens_missing_attempts']} 次）；" if not has_claude else (
        '回执用量按执行者分别统计：' + '；'.join(
            f"{executor} [{group['usage_basis']}] 已知 {group['tokens'] if group['tokens'] is not None else '未知'} token"
            f"（缺值 {group['missing_attempts']} 次）"
            for executor, group in m['receipt_usage_by_executor'].items()) + '；不同口径不合计。Codex ')
    u = m['combined_usage']
    unknown = '、'.join(f"{a['card']}#{a['attempt']}" for a in m['attempts'] if a['end_unknown'])
    legacy = sum(any(value and not re.search(r'[T ]\d{2}:\d{2}:\d{2}[.,]\d+', value)
                     for value in (a['started_at'], a['ended_at'], a['review_at']))
                 for a in m['attempts'])
    text = [
        '# Crew 运行摘要', '',
        f"范围：{m['start']} — {m['end']}（{m['status']}）。全程 {seconds(m['wall_seconds'])}，"
        f"首个交付距开始 {seconds(m['first_delivery_seconds'])}；至少一张卡在跑 {seconds(m['worker_any_active_seconds'])}，"
        f"累计活动 {seconds(m['worker_active_sum_seconds'])}，峰值并发 {m['peak_active_workers']}；"
        f"没有卡在跑 {seconds(m['no_worker_seconds'])}，其中有交付等验收 {seconds(m['awaiting_review_seconds'])}，"
        f"其余空档 {seconds(m['other_idle_seconds'])}；收尾（最后交付到最后验收）{seconds(m['tail_review_seconds'])}。"
        f"派发批次：{batches}。{receipt_summary}"
        f"原生日志用量覆盖 {m['usage_covered_attempts']}/{native_attempts} 次尝试："
        f"累计处理 {u['total_tokens']:,}，输入 {u['input_tokens']:,}（缓存 {u['cached_input_tokens']:,}、"
        f"非缓存 {u['uncached_input_tokens']:,}），输出 {u['output_tokens']:,}。", '',
        '| 卡 | 尝试 | 依赖 | 开始 | 结束 | 用时 | 状态 | 验收结论 | 验收时刻 | 等验收 | tokens增量 | 日志 | 缓存输入 | 非缓存输入 | 输出 | 曾验收 | 当前仍有效 | 版本绑定 |',
        '|---|---:|---|---|---|---:|---|---|---|---:|---:|---|---:|---:|---:|---|---|---|']
    if version == 1:
        text[-2:] = ['|'.join(line.split('|')[:-4]) + '|' for line in text[-2:]]
    if has_claude:
        text[-2] += ' 执行者 | 用量口径 |'
        text[-1] += '---|---|'
    for a in m['attempts']:
        u = a['usage'] or {}
        wait = seconds(a['review_wait_seconds'])
        if a['pending_review_seconds'] is not None:
            wait = '待验收，已等' + seconds(a['pending_review_seconds'])
        values = [a['card'], a['attempt'], '、'.join(a['deps']) or '—', a['started_at'],
                  '结束时间未知' if a['end_unknown'] else a['ended_at'],
                  seconds(a['seconds']), '结束时间未知' if a['end_unknown'] else labels.get(a['state'], a['state']),
                  LABELS.get(a['verdict'], a['verdict']),
                  a['review_at'], wait, a['tokens'], a['log_status'], u.get('cached_input_tokens'),
                  u.get('uncached_input_tokens'), u.get('output_tokens'),
                  '是' if a.get('ever_accepted', a['verdict'] == 'accepted') else '否',
                  VALIDITY_LABELS[a.get('accepted_valid')], a.get('acceptance', '未记录')]
        values = values[:-3] if version == 1 else values
        if has_claude:
            values += [a['executor'], a['usage_basis']]
        text.append('| ' + ' | '.join(cell(v) for v in values) + ' |')
    for c in m['cards']:
        if not c['attempts']:
            values = [c['card'], '—', '、'.join(c['deps']) or '—', '—', '—', '—', LABELS[c['state']], *(['—'] * 8), '否', '无效', 'none']
            values = values[:-3] if version == 1 else values
            if has_claude:
                values += [None, None]
            text.append('| ' + ' | '.join(cell(v) for v in values) + ' |')
    if unknown:
        reason = '已归档或已失联／停止，但没有 ended_at' if version >= 3 else '已归档但没有 ended_at'
        text += ['', f'结束时间未知：{unknown}。{reason}，不计入活动区间和并发，也不推算用量窗口；'
                 '这些时段的活动情况无法确定，“没有卡在跑”仅表示没有已知活动区间。']
    if legacy:
        text += ['', f'精度限制：{legacy} 次尝试含旧整秒时间，耗时及用量归属无法还原秒内边界，可能漏计边界附近的用量；'
                 '不扩大窗口补猜。']
    if has_claude:
        text += ['', 'Claude JSON 用量按本次调用的 input_tokens、output_tokens、cache_read_input_tokens、'
                 'cache_creation_input_tokens 相加；四项必须都是非负整数，否则未知。接续不扣除上次调用，'
                 '不查 Codex 会话日志。下述缓存子集与原生日志规则只适用于 Codex。']
    text += ['']
    if version >= 2:
        text += ['“曾验收”保留回执中的通过事件；“当前仍有效”要求当前回执、任务卡、原稿和冻结稿版本一致。'
        '旧回执缺少版本字段时标为 legacy（版本未绑定），有效性未知，仍按历史验收放行依赖；'
        'bound 表示已绑定版本，none 表示未验收；归档尝试不作为当前验收。']
    text += [
        '口径：活动区间含工具等待，不是推理时间；没有卡在跑的区间可能包含负责人必要综合，不全部等同闲置或浪费。'
        '无单线程对照，不据此宣称加速；token 不折算金额。缓存是输入子集，推理是输出子集，均不重复相加。'
        '回执 tokens 是每次尝试增量，与原生日志累计处理 token 分列，不互相替代。',
        f'回执没有派发编号，以首张卡开始后 {BATCH_SECONDS}秒内的启动近似同批，可能合并相近的两次 run 或拆开慢派发。'
        '用时按 started_at 到 ended_at 计算；只把 finished 算作交付，验收包括通过和退回。'
        '没有结束或验收时间时保留空值，未结束活动和待验收时间只统计到最后已知事件，不外推到当前时间。'
        '原生日志按回执 session_id 定位，兼容毫秒与旧整秒时间；同一会话的 response_id 跨尝试只归入一次，'
        '相接或重叠窗口优先归入较早尝试。'
        '日志缺失或缺字段不猜用量；日志合计仅覆盖有记录的尝试，不代表完整运行总量。', '']
    return '\n'.join(text)


def check_outputs(out, inputs):
    """先检查两个输出；只允许更新成对的统计产物，不能覆盖输入或链接。"""
    targets = [out / 'metrics.json', out / 'summary.md']
    previous = False
    try:
        m = read_json(targets[0])
        summary = targets[1].read_text(encoding='utf-8')
        previous = (any(summary == render_crew(m, version) for version in (3, 2, 1))
                    if m.get('mode') == 'crew' else summary == render(m))
    except (OSError, ValueError, AttributeError, KeyError, TypeError):
        pass
    sources = {path.resolve() for path in inputs}
    for path in targets:
        if (path.resolve() in sources or path.is_symlink()
                or path.exists() and (not previous or not path.is_file() or path.stat().st_nlink > 1)):
            raise ValueError(f'统计输出与已有文件或输入冲突：{path}；请用 --out-dir 指定独立统计目录')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_dir', type=Path, nargs='?')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--root-log', type=Path)
    parser.add_argument('--turn-id')
    parser.add_argument('--out-dir', type=Path)
    parser.add_argument('--start', help='原生模式缺少开始事件时显式提供原请求 ISO 时间')
    args = parser.parse_args(argv)
    if args.run_dir:
        if any((args.manifest, args.root_log, args.turn_id, args.start)):
            parser.error('运行目录模式不能与原生子线程参数混用')
        out = args.out_dir or args.run_dir
    else:
        if not all((args.manifest, args.root_log, args.turn_id, args.out_dir)):
            parser.error('请提供运行目录，或同时提供 --manifest --root-log --turn-id --out-dir')
        out = args.out_dir
    try:
        if args.run_dir:
            cards = list((args.run_dir / 'cards').glob('*.md'))
            inputs = [args.run_dir / 'run.json', *cards,
                      *(args.run_dir / 'history').glob('*'),
                      *(args.run_dir / f'{p.stem}.json' for p in cards)]
            check_outputs(out, inputs)
            metrics = summarize_crew(args.run_dir)
            summary = render_crew(metrics)
        else:
            manifest = read_json(args.manifest)
            check_outputs(out, [args.manifest, args.root_log, *(Path(a['rollout_path']) for a in manifest)])
            metrics = summarize(manifest, args.root_log, args.turn_id, args.start)
            summary = render(metrics)
        out.mkdir(parents=True, exist_ok=True)
        (out / 'metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (out / 'summary.md').write_text(summary, encoding='utf-8')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    print(out / 'summary.md')


if __name__ == '__main__':
    main()

