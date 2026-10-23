"""按卡启用的 result-v1；只校验交回格式与覆盖清单，不替负责人验收语义。"""
import json
import re
from pathlib import Path


def card_headers(body):
    # ponytail: 只读开头的标题、空行和元数据行，正文或示例里的协议声明不生效。
    fields = {}
    for line in body.splitlines():
        if not line.strip() or line.startswith('# '):
            continue
        field = re.fullmatch(r'(结果|覆盖|依赖|可写|执行者|模型|档位|特性|接续)[ \t]*[:：][ \t]*(.*)', line)
        if not field:
            break
        fields[field[1]] = field[2].strip()
    return fields


def from_card(body):
    fields = card_headers(body)
    if fields.get('结果') != 'result-v1':
        return None
    expected = [item for item in re.split(r'[,，、\s]+', fields.get('覆盖', '')) if item]
    return {'version': 'result-v1', 'expected': expected if '覆盖' in fields else None}


def rules(contract):
    if not contract:
        return ''
    expected = contract['expected']
    coverage = ('负责人未指定覆盖 ID；仍须如实列出 covered 与 skipped。' if expected is None else
                '负责人要求覆盖的 ID：' + json.dumps(expected, ensure_ascii=False) + '；每项必须且只能出现在 covered 或 skipped 中一次，不得增加或遗漏。')
    return ('\n\n结果协议 result-v1（保留结论卡和正文）：\n'
            '交付末尾附一个 ```json 代码块，块后不要再写正文。字段为 status（complete/blocked/partial）、'
            'questions（字符串数组）、covered（ID 字符串数组）、skipped（含 id、reason 的对象数组）。\n'
            'complete 表示全部完成，skipped 必须为空；partial 表示部分完成，逐项写出 skipped 及非空 reason；'
            'blocked 表示缺输入，questions 必须列出具体要负责人补什么，未做项写进 skipped。\n'
            '工具失败或未核实的项目不能算 covered；格式正确仍须负责人验收。\n' + coverage + '\n'
            '缺输入时结束本次执行，负责人把补答写进当前卡，再用 --retry 续跑。\n')


def parse(text, expected=None):
    """返回有效结果或 protocol_error；raw 和原 .out 均保留，不自动修复或重试。"""
    errors = []
    result = {'status': 'protocol_error', 'questions': [], 'covered': [], 'skipped': [], 'errors': errors, 'raw': ''}
    # ponytail: 协议只认独立行上的三反引号 json 块，不引入完整 Markdown 解析器。
    blocks = list(re.finditer(r'^```json[ \t]*\r?\n(.*?)^```[ \t]*\r?$', text, re.M | re.S))
    if not blocks or text[blocks[-1].end():].strip():
        errors.append('result-v1 协议错误：交付末尾缺少独立的 ```json 代码块。')
        return result
    result['raw'] = raw = blocks[-1][1]
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError) as error:
        errors.append(f'result-v1 协议错误：JSON 无法解析：{error}')
        return result
    if not isinstance(data, dict):
        errors.append('result-v1 协议错误：JSON 顶层必须是对象。')
        return result
    for key in ('status', 'covered', 'skipped'):
        if key not in data:
            errors.append(f'缺少字段 {key}。')
    status = data.get('status')
    if status not in ('complete', 'blocked', 'partial'):
        errors.append('status 必须是 complete/blocked/partial。')

    def strings(value):
        return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)

    questions, covered, skipped = data.get('questions', []), data.get('covered'), data.get('skipped')
    if not strings(questions):
        errors.append('questions 必须是非空字符串组成的数组。')
    else:
        result['questions'] = questions
        if status == 'blocked' and not questions:
            errors.append('blocked 必须在 questions 中写明需要负责人补充的具体问题。')
    if not strings(covered):
        errors.append('covered 必须是非空 ID 字符串组成的数组。')
    else:
        result['covered'] = covered
    valid_skipped = isinstance(skipped, list) and all(
        isinstance(item, dict) and isinstance(item.get('id'), str) and item['id'].strip()
        and isinstance(item.get('reason'), str) and item['reason'].strip() for item in skipped)
    if not valid_skipped:
        errors.append('skipped 必须是对象数组，每项都要有非空字符串 id 和 reason。')
    else:
        result['skipped'] = skipped
        if status == 'complete' and skipped:
            errors.append('complete 不能有 skipped 缺口，请改为 partial 或 blocked。')
        if status == 'partial' and not skipped:
            errors.append('partial 必须在 skipped 中说明尚未完成的项目。')
    if strings(covered) and valid_skipped:
        ids = covered + [item['id'] for item in skipped]
        if len(ids) != len(set(ids)):
            errors.append('covered 与 skipped 中存在重复 ID，每项只能出现一次。')
        if expected is not None:
            missing, extra = sorted(set(expected) - set(ids)), sorted(set(ids) - set(expected))
            if missing:
                errors.append('覆盖清单缺项：' + '、'.join(missing) + '。')
            if extra:
                errors.append('覆盖清单外的 ID：' + '、'.join(extra) + '。')
    if errors:
        result['errors'] = ['result-v1 协议错误：' + error for error in errors]
    else:
        result['status'] = status
    return result


def collect(receipt):
    """按派发时的清单解析当前交付；绝不改写执行者原稿。"""
    contract = receipt.get('result_contract')
    if not contract:
        return
    output = Path(receipt['output'])
    text = output.read_text(encoding='utf-8', errors='replace') if output.is_file() else ''
    receipt['result'] = parse(text, contract['expected'])


def summary(receipt):
    result = receipt.get('result')
    return {key: result[key] for key in ('status', 'questions', 'covered', 'skipped', 'errors')} if result else {}


def acceptance(receipt, note, accept_gaps):
    """缺口显式接受，协议错误和缺输入不能用 --force 绕过。"""
    collect(receipt)
    result = receipt.get('result', {})
    if result.get('status') == 'protocol_error':
        raise ValueError('；'.join(result['errors']))
    if result.get('status') == 'blocked':
        raise ValueError('blocked 不能验收；请把补答写进卡，再用 --retry 续跑：' + '；'.join(result['questions']))
    if result.get('status') != 'partial':
        return {}
    if not accept_gaps:
        raise ValueError('partial 验收必须加 --accept-gaps，并在 --note 中逐项写明接受的缺口 ID。')
    def mentioned(identifier):
        # ponytail: 中文 ID 用分隔符或引号列全；保留“接受id1缺口”的旧英文 ID 写法。
        boundary = r'A-Za-z0-9_.-' if identifier.isascii() else r'\w.-'
        return re.search(r'(?<![' + boundary + '])' + re.escape(identifier) + r'(?![' + boundary + '])', note)
    missing = [item['id'] for item in result['skipped'] if not mentioned(item['id'])]
    if missing:
        raise ValueError('--note 尚未写明接受这些缺口 ID：' + '、'.join(missing))
    return {'accepted_gaps': result['skipped']}
