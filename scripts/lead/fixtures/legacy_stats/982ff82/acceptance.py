"""纯读取的验收有效性；不补回执、不建索引、不获取写锁。"""
import hashlib
from pathlib import Path

VALIDITY_LABELS = {True: '有效', False: '无效', None: '有效性未知'}


def card_sha256(path):
    # ponytail: 与派发回执一致，卡片按 read_text 后的 UTF-8 正文计算。
    return hashlib.sha256(Path(path).read_text(encoding='utf-8').encode('utf-8')).hexdigest()


def accepted_valid(receipt, card):
    """True 当前有效，False 未验收或已失效，None 旧验收未绑定版本，兼容放行。"""
    receipt = receipt or {}
    review = receipt.get('review') or {}
    if review.get('verdict') != 'accepted':
        return False
    if (not receipt.get('card_sha256') or not receipt.get('output')
            or not all(review.get(k) for k in ('card_sha256', 'output_sha256', 'accepted_output'))):
        return None
    try:
        current_card = card_sha256(card)
        if receipt['card_sha256'] != current_card or review['card_sha256'] != current_card:
            return False
        output = Path(receipt['output']).read_bytes()
        frozen = Path(review['accepted_output']).read_bytes()
        return (bool(output.decode('utf-8', errors='replace').strip())
                and hashlib.sha256(output).hexdigest() == review['output_sha256']
                and hashlib.sha256(frozen).hexdigest() == review['output_sha256'])
    except (OSError, TypeError, ValueError):
        return False


def acceptance_info(receipt, card):
    """版本标记与流转状态分开；legacy 不改写历史验收，也不伪造派发版本。"""
    valid = accepted_valid(receipt, card)
    reviewed = ((receipt or {}).get('review') or {}).get('verdict') == 'accepted'
    return {'accepted_valid': valid,
            'acceptance': ('legacy' if valid is None else 'bound') if reviewed else 'none'}
