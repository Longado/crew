// 发给模型之前、写进数据库之前，把像凭证的内容替换掉。需求 F08：凭证不进记忆。
// ponytail: 只覆盖常见格式，漏网的靠用户删除原始记录；需要时换成专门的密钥扫描库。
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI、DeepSeek、Anthropic 风格
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(\bauthorization["']?\s*:\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi,
];
const KEY_VALUE = /((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s"']{8,})/gi;

export const REDACTED = '[已隐藏的凭证]';

export function redact(text: string): string {
  // 从固定的 :// 起点扫描相邻账户密码，用户名排除冒号；不反复尝试 scheme 或冒号分界。
  text = text.replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://' + REDACTED + '@');
  text = PATTERNS.reduce(
    (acc, re) => acc.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? prefix + REDACTED : REDACTED)),
    text,
  );
  // 导入记忆宁可多藏：与 Python 展示侧刻意不同，裸 token: function 仍隐藏。
  return text.replace(KEY_VALUE, (_, prefix: string, value: string) => {
    const quoted = value[0] === '"' || value[0] === "'";
    const closing = quoted && value.length > 1 && value.at(-1) === value[0] ? value[0] : '';
    return prefix + (quoted ? value[0] + REDACTED + closing : REDACTED);
  });
}
