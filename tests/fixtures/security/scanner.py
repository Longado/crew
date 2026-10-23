"""Synthetic NDJSON scanner for adapter tests; never inspects a real vault."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
candidate = root / 'config.env'
assert candidate.read_text() == 'SYNTHETIC_API_KEY=SYNTHETIC_CANDIDATE\n'
report = {
    'schema_version': 1,
    'coverage': {'files_scanned': 1, 'status': 'completed'},
    'findings': [{
        'path': 'config.env', 'line': 1, 'column': 1,
        'rule': 'synthetic-assignment', 'rules': ['synthetic-assignment'],
        'priority': 'high', 'value': 'SYNTHETIC_CANDIDATE',
        'snippet': 'SYNTHETIC_CANDIDATE',
    }],
}
for event in [
    {'event': 'started'},
    {'event': 'progress', 'files_scanned': 1, 'findings_retained': 1},
    {'event': 'results', 'report': report},
    {'event': 'completed', 'report': report},
]:
    print(json.dumps({'protocol_version': 1, **event}), flush=True)
