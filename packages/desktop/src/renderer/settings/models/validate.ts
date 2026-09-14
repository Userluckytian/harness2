// 渲染端校验（就地阻断用户输入，D-57 四类拒绝 + D-85 端点语法）。
// 权威校验在主进程 src/main/models-config.ts——本地只做即时反馈，不落盘。
// 两边一致性由 test/settings/models/models-validation-parity.test.ts 交叉断言防漂移。
import type { ModelsProviderInputShape } from '../../../shared/protocol.js';

export interface FieldIssue {
  field: string;
  message: string;
}

/** 可打印 ASCII（空格排除）——与主进程/上游同字符集 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

/**
 * `NAME=value` 环境变量行（与主进程/上游 `apiKey.ts` 的 `ENV_LINE` 同口径）：
 * 名字大写开头且 `=` 后不紧跟 `=` —— 放行全大写 base64 padding（`ABCD==`）。
 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

/** 被一对匹配引号包裹（`"` / `'` / `` ` ``）——与上游 `isQuoted` 同口径 */
function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== '`') return false;
  return value.length > 1 && value.endsWith(first);
}

/**
 * 与主进程 `validateApiKeyInput` 同形（P2-8 与上游 `apiKey.ts` 同口径）：
 * 去空白后非空、拒 `NAME=value` 粘贴、拒一对匹配引号包裹、其余须为可打印 ASCII。
 */
export function validateApiKey(raw: string): { ok: boolean; value?: string; error?: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'API 密钥不能为空（去空白后为空）' };
  if (ENV_LINE.test(value)) {
    const name = value.slice(0, value.indexOf('='));
    return { ok: false, error: `粘贴的是 NAME=value 形态：请只粘贴密钥值本身（不要带 ${name}=）` };
  }
  if (isQuoted(value)) {
    return { ok: false, error: '密钥被引号包裹：请粘贴引号内的值本身（不要带引号）' };
  }
  if (!LEGAL_API_KEY.test(value)) {
    return {
      ok: false,
      error: '密钥只能包含可打印 ASCII 字符（0x21-0x7E）：当前含空白、控制字符或非 ASCII 字符',
    };
  }
  return { ok: true, value };
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function endpointIssue(baseUrl: string, field: string): FieldIssue | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { field, message: '端点必须是可解析的 http/https URL（如 https://api.example.com/v1）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field, message: `端点协议必须是 http 或 https（当前 ${parsed.protocol.replace(':', '')}）` };
  }
  if (parsed.hostname.length === 0) return { field, message: '端点缺少主机名' };
  return null;
}

/** 与主进程同规则：空 id / 重复 id / id 被改 / 空显示名 / 端点语法 / 空或重复模型 id / 非正整容量 */
export function validateProviderDraft(
  input: ModelsProviderInputShape,
  ctx: { existingIds: readonly string[]; originalId?: string },
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const id = input.id.trim();
  if (id.length === 0) {
    issues.push({ field: 'id', message: 'Provider ID 不能为空' });
  } else if (!PROVIDER_ID_PATTERN.test(id)) {
    issues.push({
      field: 'id',
      message: 'Provider ID 只能以字母或数字开头，且只含字母、数字、点、下划线、连字符（它是配置键与凭据引用词干）',
    });
  } else {
    if (ctx.originalId !== undefined && ctx.originalId !== id) {
      issues.push({ field: 'id', message: 'Provider ID 不可修改（它是配置键与凭据引用词干）' });
    }
    const taken = new Set(ctx.existingIds.filter((x) => x !== ctx.originalId));
    if (taken.has(id)) issues.push({ field: 'id', message: `Provider ID 已存在：${id}` });
  }
  if (input.displayName.trim().length === 0) {
    issues.push({ field: 'displayName', message: '显示名称不能为空' });
  }
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    issues.push({ field: 'protocol', message: 'API 协议必须是 openai 或 anthropic' });
  }
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) {
    issues.push({ field: 'baseUrl', message: '端点（baseURL）不能为空' });
  } else {
    const issue = endpointIssue(baseUrl, 'baseUrl');
    if (issue !== null) issues.push(issue);
  }
  const seen = new Set<string>();
  for (const [index, m] of input.models.entries()) {
    const mid = m.id.trim();
    if (mid.length === 0) {
      issues.push({ field: `models.${index}.id`, message: '模型 id 不能为空' });
      continue;
    }
    if (seen.has(mid)) issues.push({ field: `models.${index}.id`, message: `模型 id 重复：${mid}` });
    seen.add(mid);
    for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
      const num = m[key];
      if (num === undefined) continue;
      if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
        issues.push({
          field: `models.${index}.${key}`,
          message: `${key === 'contextWindow' ? '上下文窗口' : '最大输出'}必须是正整数`,
        });
      }
    }
  }
  return issues;
}

/** 取某字段的首条问题消息（就地展示） */
export function issueFor(issues: readonly FieldIssue[], field: string): string | undefined {
  return issues.find((i) => i.field === field)?.message;
}
