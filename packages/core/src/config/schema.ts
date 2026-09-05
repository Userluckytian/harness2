// 配置契约（v1，本阶段冻结）——纯数据层：schema 校验，不感知文件来源与密钥。
// 红线：密钥只存 auth.json 与环境变量，绝不入 config（这里没有 key 字段，类型层面钉死）。
// 未知字段忽略（记告警）；校验错误消息出口前经 redactSecrets 过滤（纵深防御）。
import { redactSecrets } from './redact.js';

/** 模型条目（仅容量元数据；协议行为由 provider 实现决定） */
export interface ModelEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** provider 渠道配置（channel） */
export interface ProviderConfig {
  /** openai = OpenAI-compatible（DeepSeek/智谱等）；anthropic = Messages API 原生 */
  protocol: 'openai' | 'anthropic';
  /** openai: {baseUrl}/chat/completions；anthropic: {baseUrl}/v1/messages（不含 /v1） */
  baseUrl: string;
  /** 可选：key 的环境变量名（解析顺序 auth.json > env；缺省时只查 auth.json） */
  envKey?: string;
  /** 可选：渠道可用模型及容量元数据；roles 引用的 model 必须在此声明（若声明了 models） */
  models?: Record<string, ModelEntry>;
}

/** 角色 → 渠道/模型（Tokeny 式 {channelId, model}） */
export interface RoleConfig {
  channel: string;
  model: string;
}

export type ApprovalMode = 'default' | 'acceptEdits' | 'bypass';
export type ApprovalToolRule = 'allow' | 'ask' | 'deny';

/** 审批配置：三 mode + per-tool 规则（per-tool 优先于 mode 推导） */
export interface ApprovalConfig {
  mode?: ApprovalMode;
  /** 未列出的工具按 safe=allow / unsafe=ask 处理（安全集见 approval/policy.ts） */
  tools?: Record<string, ApprovalToolRule>;
}

/** 合并+校验后的配置（唯一合法形态） */
export interface HarnessConfig {
  providers: Record<string, ProviderConfig>;
  roles: Record<string, RoleConfig>;
  approval: ApprovalConfig;
}

/** 配置错误（工厂/CLI 对其做一行友好输出；消息不携带密钥） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const APPROVAL_MODES: readonly ApprovalMode[] = ['default', 'acceptEdits', 'bypass'];
export const APPROVAL_TOOL_RULES: readonly ApprovalToolRule[] = ['allow', 'ask', 'deny'];
export const PROTOCOLS: readonly ProviderConfig['protocol'][] = ['openai', 'anthropic'];

export interface ConfigParseResult {
  /** 校验通过时为合并后的配置；有任何 error 时为 null */
  config: HarnessConfig | null;
  /** 致命错误（存在即视为配置不可用） */
  errors: string[];
  /** 非致命告警（未知字段、缺省补全、未解析的 ${VAR} 等） */
  warnings: string[];
}

type Dict = Record<string, unknown>;

function isPlainObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** schema 内已知的顶层字段（其余忽略并告警） */
const KNOWN_TOP_KEYS = new Set(['providers', 'roles', 'approval']);

function collectUnknownKeys(obj: Dict, known: ReadonlySet<string>, where: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) warnings.push(`${where}: 未知字段 "${k}" 已忽略`);
  }
}

const PROVIDER_KNOWN_KEYS = new Set(['protocol', 'baseUrl', 'envKey', 'models']);
const MODEL_KNOWN_KEYS = new Set(['contextWindow', 'maxOutputTokens']);
const ROLE_KNOWN_KEYS = new Set(['channel', 'model']);
const APPROVAL_KNOWN_KEYS = new Set(['mode', 'tools']);

/**
 * 校验合并后的原始 JSON（展开 ${VAR} 之后的形态），产出 HarnessConfig。
 * 不抛错：错误收集进 errors（调用方决定一行输出 / exit 1）。
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return { config: null, errors: ['config 根节点必须是对象'], warnings };
  }
  collectUnknownKeys(raw, KNOWN_TOP_KEYS, 'config', warnings);

  // —— providers ——
  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = raw['providers'];
  if (rawProviders === undefined) {
    errors.push('config.providers 缺失');
  } else if (!isPlainObject(rawProviders)) {
    errors.push('config.providers 必须是对象');
  } else {
    for (const [channel, v] of Object.entries(rawProviders)) {
      if (!isPlainObject(v)) {
        errors.push(`providers.${channel} 必须是对象`);
        continue;
      }
      collectUnknownKeys(v, PROVIDER_KNOWN_KEYS, `providers.${channel}`, warnings);
      const protocol = v['protocol'];
      if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol as ProviderConfig['protocol'])) {
        errors.push(`providers.${channel}.protocol 必须是 ${PROTOCOLS.join(' | ')}，实际为 ${JSON.stringify(protocol)}`);
        continue;
      }
      const baseUrl = v['baseUrl'];
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        errors.push(`providers.${channel}.baseUrl 必须是非空字符串`);
        continue;
      }
      const envKey = v['envKey'];
      if (envKey !== undefined && (typeof envKey !== 'string' || envKey.trim() === '')) {
        errors.push(`providers.${channel}.envKey 必须是非空字符串`);
        continue;
      }
      const models: Record<string, ModelEntry> = {};
      const rawModels = v['models'];
      if (rawModels !== undefined) {
        if (!isPlainObject(rawModels)) {
          errors.push(`providers.${channel}.models 必须是对象`);
          continue;
        }
        let modelsOk = true;
        for (const [model, mv] of Object.entries(rawModels)) {
          if (mv === undefined || mv === null) {
            models[model] = {};
            continue;
          }
          if (!isPlainObject(mv)) {
            errors.push(`providers.${channel}.models.${model} 必须是对象`);
            modelsOk = false;
            continue;
          }
          collectUnknownKeys(mv, MODEL_KNOWN_KEYS, `providers.${channel}.models.${model}`, warnings);
          const entry: ModelEntry = {};
          for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
            const num = mv[field];
            if (num === undefined) continue;
            if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
              errors.push(`providers.${channel}.models.${model}.${field} 必须是正整数`);
              modelsOk = false;
            } else {
              entry[field] = num;
            }
          }
          if (modelsOk) models[model] = entry;
        }
        if (modelsOk) providers[channel] = { protocol: protocol as ProviderConfig['protocol'], baseUrl, ...(envKey !== undefined ? { envKey } : {}), models };
      } else {
        providers[channel] = { protocol: protocol as ProviderConfig['protocol'], baseUrl, ...(envKey !== undefined ? { envKey } : {}) };
      }
    }
  }

  // —— roles ——
  const roles: Record<string, RoleConfig> = {};
  const rawRoles = raw['roles'];
  if (rawRoles === undefined) {
    errors.push('config.roles 缺失');
  } else if (!isPlainObject(rawRoles)) {
    errors.push('config.roles 必须是对象');
  } else {
    for (const [role, v] of Object.entries(rawRoles)) {
      if (!isPlainObject(v)) {
        errors.push(`roles.${role} 必须是对象`);
        continue;
      }
      collectUnknownKeys(v, ROLE_KNOWN_KEYS, `roles.${role}`, warnings);
      const channel = v['channel'];
      const model = v['model'];
      if (typeof channel !== 'string' || channel.trim() === '') {
        errors.push(`roles.${role}.channel 必须是非空字符串`);
        continue;
      }
      if (typeof model !== 'string' || model.trim() === '') {
        errors.push(`roles.${role}.model 必须是非空字符串`);
        continue;
      }
      roles[role] = { channel, model };
    }
  }

  // —— approval（缺省 = {}，策略层有全缺省语义）——
  const approval: ApprovalConfig = {};
  const rawApproval = raw['approval'];
  if (rawApproval !== undefined) {
    if (!isPlainObject(rawApproval)) {
      errors.push('config.approval 必须是对象');
    } else {
      collectUnknownKeys(rawApproval, APPROVAL_KNOWN_KEYS, 'approval', warnings);
      const mode = rawApproval['mode'];
      if (mode !== undefined) {
        if (typeof mode !== 'string' || !APPROVAL_MODES.includes(mode as ApprovalMode)) {
          errors.push(`approval.mode 必须是 ${APPROVAL_MODES.join(' | ')}，实际为 ${JSON.stringify(mode)}`);
        } else {
          approval.mode = mode as ApprovalMode;
        }
      }
      const tools = rawApproval['tools'];
      if (tools !== undefined) {
        if (!isPlainObject(tools)) {
          errors.push('approval.tools 必须是对象');
        } else {
          approval.tools = {};
          for (const [tool, rule] of Object.entries(tools)) {
            if (typeof rule !== 'string' || !APPROVAL_TOOL_RULES.includes(rule as ApprovalToolRule)) {
              errors.push(`approval.tools.${tool} 必须是 ${APPROVAL_TOOL_RULES.join(' | ')}，实际为 ${JSON.stringify(rule)}`);
              continue;
            }
            approval.tools[tool] = rule as ApprovalToolRule;
          }
        }
      }
    }
  }

  // —— 交叉引用校验（roles 引用存在的 channel/model）——
  for (const [role, rc] of Object.entries(roles)) {
    const provider = providers[rc.channel];
    if (provider === undefined) {
      if (providers && rawProviders && isPlainObject(rawProviders) && rawProviders[rc.channel] !== undefined) {
        // channel 存在但自身校验失败：错误已在上面报过，不重复
        continue;
      }
      errors.push(`roles.${role}.channel "${rc.channel}" 不存在于 providers`);
      continue;
    }
    if (provider.models !== undefined && provider.models[rc.model] === undefined) {
      errors.push(`roles.${role}.model "${rc.model}" 未在 providers.${rc.channel}.models 中声明`);
    }
  }

  // 出口统一脱敏：错误消息可能回显配置值（如非法枚举的实际值），绝不携带疑似密钥内容
  const safeErrors = errors.map(redactSecrets);
  const safeWarnings = warnings.map(redactSecrets);
  if (safeErrors.length > 0) return { config: null, errors: safeErrors, warnings: safeWarnings };
  return { config: { providers, roles, approval }, errors: safeErrors, warnings: safeWarnings };
}
