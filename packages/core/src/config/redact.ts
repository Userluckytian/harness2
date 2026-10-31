// 脱敏工具：任何可能携带密钥的文本（错误消息、HTTP body 摘要、校验告警）出口前必须过滤。
// 红线：密钥不进 config.json/git/事件日志/错误消息——本模块是错误路径的最后闸门。

/** 常见密钥字段名（JSON key / 查询参数名），匹配后替换其值。
 *  安全修复 #302：扩展覆盖 appSecret/clientSecret/accessKey/bearerToken/authToken/
 *  tokenValue/awsAccessKeyId/SecretAccessKey/api_key_zh/中文键/access_key/
 *  x-goog-api-key/x-amz-security-token 等。 */
const SECRET_FIELD_PATTERN =
  /((("?)(?<![A-Za-z0-9_-])(api[-_]?key|apikey|key|token|secret|authorization|access[-_]?token|refresh[-_]?token|app[-_]?secret|client[-_]?secret|access[-_]?key|access[-_]?key[-_]?id|access[-_]?key[-_]?secret|bearer[-_]?token|auth[-_]?token|token[-_]?value|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key|secret[-_]?access[-_]?key|private[-_]?key|api[-_]?key[-_]?zh|x[-_]?goog[-_]?api[-_]?key|x[-_]?amz[-_]?security[-_]?token|credential|credentials|session[-_]?token|访问密钥|私有密钥|密钥值|密钥[-_]?id|密钥|访问令牌|令牌|密码|凭证))"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

/** OpenAI 形态密钥：sk- 前缀的长 token。
 *  安全修复 #302：扩展字符集覆盖 . / + = 等 base64/urlsafe 字符，
 *  防止 sk-abc.def.ghi / sk-abc/def 等形态漏网；
 *  移除 \b 词边界，覆盖 sk- 前置为词字符（如 foo_sk-... / 123sk-...）时漏网的场景。 */
const SK_KEY_PATTERN = /sk-[A-Za-z0-9._+/=-]{6,}/g;

/** URL userinfo 凭据：scheme://user:pass@host（如 MCP server url 携带 token 的形态） */
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Bearer / Basic 认证头的值 */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** Anthropic 形态的请求头。安全修复 #302：扩展覆盖 x-goog-api-key/x-amz-security-token */
const X_API_KEY_PATTERN = /\b(x-api-key|x-goog-api-key|x-amz-security-token)\s*:\s*\S+/gi;

/** 通用替换占位（不回显任何原文片段） */
export const REDACTED = '[REDACTED]';

/**
 * 将文本中疑似密钥的片段替换为 [REDACTED]。
 * 防御性设计：宁可误杀（把长随机串当密钥），不可漏放——错误消息宁缺毋密。
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(URL_USERINFO_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}@`);
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

/** ASCII 敏感字段名（JSON key / 查询参数名 / HTTP 头名），命中即替换其值。
 *  基线 8 项 + #303 扩展的复合名/自定义头名，显式登记便于审阅与精确兜底。 */
const SENSITIVE_KEY_NAMES = new Set([
  // 基线（原 8 项）
  'apikey',
  'api_key',
  'api-key',
  'key',
  'token',
  'secret',
  'password',
  'authorization',
  // 复合名（#303）
  'appsecret',
  'app_secret',
  'clientsecret',
  'client_secret',
  'accesskey',
  'access_key',
  'access-key',
  'accesskeyid',
  'access_key_id',
  'accesskeysecret',
  'access_key_secret',
  'bearertoken',
  'bearer_token',
  'authtoken',
  'auth_token',
  'tokenvalue',
  'token_value',
  'awsaccesskeyid',
  'aws_access_key_id',
  'awssecretaccesskey',
  'aws_secret_access_key',
  'secretaccesskey',
  'secret_access_key',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
  'sessiontoken',
  'session_token',
  // 自定义头名（#303：连字符原样此前未登记，精确匹配仍漏网）
  'x-api-key',
  'x-goog-api-key',
  'x-amz-security-token',
  'x_api_key',
  'x_goog_api_key',
  'xgoogapikey',
  'x_amz_security_token',
  'xamzsecuritytoken',
  // 非英文键（#303）
  '密钥',
  '配置',
  '密码',
  '口令',
  '凭证',
  '令牌',
  '私钥',
]);

/** 组件级敏感 token：键名按非字母数字 + camelCase 边界拆成组件后，任一组件命中即敏感。
 *  既能命中复合名/自定义头名（accessKey、x-goog-api-key、bearerToken…），
 *  又不误伤 monkey/model/tokenize/secretary 这类含敏感子串但非独立组件的普通词
 *  （与 redactSecrets 的词界口径一致）。 */
const SENSITIVE_KEY_COMPONENTS = new Set([
  'apikey',
  'accesskey',
  'secretkey',
  'bearertoken',
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
]);

/** 非英文（中文等）敏感键名：对原始键名做子串匹配，覆盖「API密钥」「配置密钥」等复合形态。 */
const SENSITIVE_KEY_NON_ENGLISH = ['密钥', '配置', '密码', '口令', '凭证', '令牌', '私钥'];

/** 把键名拆成小写组件：先按非字母数字切分，再按 camelCase 边界切分（accessKey -> access, key）。 */
function splitKeyComponents(key: string): string[] {
  const segments = key
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const comps: string[] = [];
  for (const seg of segments) {
    const parts = seg
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean);
    for (const p of parts) comps.push(p.toLowerCase());
  }
  return comps;
}

/**
 * 判断键名是否敏感：命中即替换其值（宁可误杀，不可漏放）。
 * 安全修复 #303：由「精确匹配集合」升级为「精确集合 + 非英文子串 + 组件级匹配」三层：
 *   1) 精确集合：显式登记的复合名/头名/非英文键（向后兼容）；
 *   2) 非英文子串：覆盖 密钥/配置/密码 等中文键及其复合（API密钥、配置密钥）；
 *   3) 组件级匹配：兜底覆盖未登记的复合名与自定义头名（任意 *Key/*Token/*Secret/*Credential
 *      形态，含连字符头名 x-goog-api-key / x-amz-security-token）。
 * 组件级匹配用词界避免误伤 monkey/model/tokenize/secretary 等含敏感子串的普通词。
 */
function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_NAMES.has(key.toLowerCase())) return true;
  if (SENSITIVE_KEY_NON_ENGLISH.some((w) => key.includes(w))) return true;
  const comps = splitKeyComponents(key);
  return comps.some((c) => SENSITIVE_KEY_COMPONENTS.has(c));
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
      out[k] = isSensitiveKey(k) && (typeof v === 'string' || typeof v === 'number') ? REDACTED : redactObject(v);
    }
    return out as unknown as T;
  }
  return value;
}
