import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redact, REDACTED } from '../src/redact.ts';

// 同一组正反例只维护在 Python 回归文件中；两端必须得到完全相同的输出。
const shared = readFileSync(new URL('../scripts/lead/test_worker_r7fix.py', import.meta.url), 'utf8');
const r7Cases: [string, string][] = JSON.parse(shared.match(/R7_CASES = json.loads\(r'''([\s\S]*?)'''\)/)![1]);
for (const [text, expected] of r7Cases) {
  test(`R7 shared credential syntax: ${text}`, () => {
    assert.equal(redact(text), expected);
    assert.equal(redact(expected), expected);
  });
}

// 与 Python 展示侧共用格式样例；导入记忆的裸 token: 规则刻意更保守。
const samples = [
  ['{"api_key": "fixture-json-secret"}', 'fixture-json-secret'],
  ['{"Authorization": "Bearer fixture-bearer-secret"}', 'fixture-bearer-secret'],
  ["{'token': 'fixture-dict-secret'}", 'fixture-dict-secret'],
  ["{'Authorization': 'Basic Zml4dHVyZTpwYXNz'}", 'Zml4dHVyZTpwYXNz'],
  ['{"PASSWORD":"fixture-password","ok":true}', 'fixture-password'],
  ['{"secret": "fixture secret with spaces"}', 'fixture secret with spaces'],
  [String.raw`{"api-key": "fixture\"escaped-secret"}`, String.raw`fixture\"escaped-secret`],
  ['api_key="fixture-assignment-secret"', 'fixture-assignment-secret'],
  ['Authorization: Bearer fixture-header-secret', 'fixture-header-secret'],
  ['https://fixture-user:fixture-pass@example.invalid/path', 'fixture-user:fixture-pass'],
];

for (const [text, secret] of samples) {
  test(`R2 hides quoted and legacy credentials: ${text}`, () => {
    assert.ok(!redact(text).includes(secret));
    assert.ok(redact(text).includes(REDACTED));
  });
}

test('R2 replacement keeps JSON punctuation and is idempotent', () => {
  const hidden = redact('{"api_key":"fixture-secret", "ok":true}');
  assert.deepEqual(JSON.parse(hidden), { api_key: REDACTED, ok: true });
  assert.equal(redact(hidden), hidden);
});

test('R2 legacy unclosed quotes and punctuation in values still hide', () => {
  for (const text of ['api_key="fixture-secret', "password='fixture-secret", 'secret=abc,123456']) {
    assert.ok(!redact(text).includes('fixture-secret'));
    assert.ok(!redact(text).includes('123456'));
    assert.ok(redact(text).includes(REDACTED));
  }
});

test('R1 long plain and colon lines finish within one second each', () => {
  for (const text of ['a-'.repeat(32768), 'https://' + ':'.repeat(65536 - 8)]) {
    const started = performance.now();
    assert.equal(redact(text), text);
    assert.ok(performance.now() - started < 1000);
  }
});

test('R1 keeps URL credential coverage with colons inside passwords', () => {
  assert.equal(redact('凭据git+ssh://fixture-user:fixture:pass@example.invalid/path'),
    `凭据git+ssh://${REDACTED}@example.invalid/path`);
});

test('R1 URL after punctuation still hides credentials', () => {
  assert.equal(redact('-https://fixture-user:fixture-pass@example.invalid'),
    `-https://${REDACTED}@example.invalid`);
});

test('R4 memory import retains strict bare token redaction', () => {
  assert.equal(redact('SyntaxError: Unexpected token: function'), `SyntaxError: Unexpected token: ${REDACTED}`);
  for (const value of ['fixture12345', 'aBcDefGhIjKlMnOp', 'fixture-token-value', 'configuration']) {
    assert.equal(redact(`token: ${value}`), `token: ${REDACTED}`);
  }
});

test('legacy provider credentials still hide next to Chinese text', () => {
  for (const secret of ['sk-' + 'S'.repeat(24), 'sk-ant-' + 'A'.repeat(24), 'ghp_' + 'G'.repeat(24),
    'AKIA' + 'W'.repeat(16), 'xoxb-' + 'L'.repeat(16)]) {
    assert.ok(!redact('凭据' + secret + '结束').includes(secret));
  }
});
