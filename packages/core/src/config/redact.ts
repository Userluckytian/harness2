// 脱敏工具：任何可能携带密钥的文本（错误消息、HTTP body 摘要、校验告警）出口前必须过滤。
// 红线：密钥不进 config.json/git/事件日志/错误消息——本模块是错误路径的最后闸门。

/** 常见密钥字段名（JSON key / 查询参数名），匹配后替换其值 */
const SECRET_FIELD_PATTERN =
  /((("?)(?<![A-Za-z0-9_-])(api[-_]?key|apikey|key|token|secret|authorization|access[-_]?token|refresh[-_]?token))"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/** OpenAI 形态密钥：sk- 前缀的长 token */
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}/g;

/** Bearer / Basic 认证头的值 */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** Anthropic 形态的请求头 */
const X_API_KEY_PATTERN = /\b(x-api-key)\s*:\s*\S+/gi;

/** 通用替换占位（不回显任何原文片段） */
export const REDACTED = '[REDACTED]';

/**
 * 将文本中疑似密钥的片段替换为 [REDACTED]。
 * 防御性设计：宁可误杀（把长随机串当密钥），不可漏放——错误消息宁缺毋密。
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(SK_KEY_PATTERN, REDACTED);
  out = out.replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(X_API_KEY_PATTERN, (_m, header: string) => `${header}: ${REDACTED}`);
  out = out.replace(SECRET_FIELD_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

/** 摘要：先脱敏再截断（截断在脱敏之后，避免被截断边界拼回完整密钥）；总长不超过 maxLen */
export function redactedSummary(text: string, maxLen = 200): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxLen) return redacted;
  const suffix = '…(truncated)';
  return `${redacted.slice(0, Math.max(0, maxLen - suffix.length))}${suffix}`;
}

const SENSITIVE_KEY_NAMES = new Set([
  'apikey',
  'api_key',
  'api-key',
  'key',
  'token',
  'secret',
  'password',
  'authorization',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.toLowerCase());
}

/**
 * 深拷贝并脱敏对象：敏感字段名的字符串值替换为 [REDACTED]。
 * 用于把任意来源的对象（如 HTTP 响应 JSON）安全地放进错误消息/日志。
 */
export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number')
          ? REDACTED
          : redactObject(v);
    }
    return out as unknown as T;
  }
  return value;
}
