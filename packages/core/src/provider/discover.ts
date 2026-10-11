// Z6-A01 模型发现：按 protocol 请求 /models 端点，解析为模型行并与静态 models 表合并。
// 调研结论（上游 ZCode 29628c9）：上游**不做** /models 动态拉取——目录来自内置静态
// catalog + 远程配置发布同步 + personal 规则；但其「fetch 注入 / fail-closed 快照 /
// 静态优先」纪律照搬。我们按批次要求实现动态发现：
//   - 超时 ≤10s；失败一律抛错（fail-closed）——**绝不把部分结果当全量**（响应形状
//     不合法、任一条目缺 id → 整次发现失败，不做「能解析多少算多少」）；
//   - 成功结果与静态 providers.<channel>.models 合并：静态优先（手工容量声明不被
//     覆盖），发现的模型补入缺失项，按 id 去重；
//   - 纯函数解析器 fixture 驱动可测；网络经 fetchImpl 注入（缺省全局 fetch），
//     不做真实网络调用测试；
//   - 暴露面本轮只有 core 导出函数；serve 端点 / UI 接线后续批次接（登记留缝）。
import {
  ConfigError,
  defaultConfigPaths,
  type HarnessConfig,
  type ModelEntry,
  type ProviderConfig,
} from '../config/index.js';
import { readAuthFile } from '../config/auth.js';
import { redactedSummary } from '../config/redact.js';
import { resolveApiKey, type KeySource } from './factory.js';
import { ANTHROPIC_VERSION } from './anthropic.js';
import { ProviderError } from './types.js';

/** 发现请求超时（批次红线：≤10s） */
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/** 解析出的单个模型行（容量元数据有则带；advisory，缺失合法） */
export interface ParsedModelRow {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** baseUrl 规范化：补尾斜杠后拼相对路径（与 openai.ts/anthropic.ts 同规则） */
function joinUrl(baseUrl: string, relative: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relative, base).toString();
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/** 提取 openai 兼容行的容量元数据：常见字段白名单（各服务别名不一），非法值忽略 */
function openAiRowCapacity(row: Record<string, unknown>): Pick<ParsedModelRow, 'contextWindow' | 'maxOutputTokens'> {
  const contextLength = row['context_length'] ?? row['max_context_length'] ?? row['max_model_len'];
  const maxOutput = row['max_output_tokens'] ?? row['max_completion_tokens'];
  return {
    ...(isPositiveInt(contextLength) ? { contextWindow: contextLength } : {}),
    ...(isPositiveInt(maxOutput) ? { maxOutputTokens: maxOutput } : {}),
  };
}

/** 发现失败的统一出口：脱敏（响应体可能回显请求头里的 key） */
function discoveryError(message: string, code: string): ProviderError {
  return new ProviderError(redactedSummary(`模型发现失败: ${message}`), code);
}

/**
 * openai 兼容 GET /models 响应解析（纯函数，fixture 驱动）。
 * 标准形态 `{ data: [{ id, ... }] }`；fail-closed：
 *   - 顶层不是对象 / data 不是数组 → ProviderError('invalid_response')；
 *   - 任一条目不是对象或缺非空字符串 id → 整次失败（绝不返回部分列表）。
 * 容量元数据（context_length / max_output_tokens 及常见别名）有则带、非法值忽略。
 */
export function parseOpenAIModelsResponse(json: unknown): ParsedModelRow[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw discoveryError('响应不是 JSON 对象（openai 兼容 /models 应返回 {data:[...]})', 'invalid_response');
  }
  const data = (json as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) {
    throw discoveryError('响应缺少 data 数组（openai 兼容 /models）', 'invalid_response');
  }
  return data.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw discoveryError(`data[${i}] 不是对象`, 'invalid_response');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || row['id'].trim() === '') {
      throw discoveryError(`data[${i}] 缺少非空字符串 id`, 'invalid_response');
    }
    return { id: row['id'], ...openAiRowCapacity(row) };
  });
}

/**
 * anthropic GET /v1/models 响应解析（纯函数，fixture 驱动）。
 * 标准形态 `{ data: [{ type: 'model', id, display_name, created_at }] }`——无容量元数据
 * （id 只带）；fail-closed 规则同 openai 解析器。
 */
export function parseAnthropicModelsResponse(json: unknown): ParsedModelRow[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw discoveryError('响应不是 JSON 对象（anthropic /v1/models 应返回 {data:[...]})', 'invalid_response');
  }
  const data = (json as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) {
    throw discoveryError('响应缺少 data 数组（anthropic /v1/models）', 'invalid_response');
  }
  return data.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw discoveryError(`data[${i}] 不是对象`, 'invalid_response');
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || row['id'].trim() === '') {
      throw discoveryError(`data[${i}] 缺少非空字符串 id`, 'invalid_response');
    }
    return { id: row['id'] };
  });
}

/**
 * 合并策略（纯函数）：静态 models 表优先——手工容量声明（contextWindow/maxOutputTokens/
 * reasoning）**不被发现结果覆盖**；发现的模型补入静态表缺失的项；按 id 去重（发现列表
 * 内重复 id 保留首个）。返回新记录（不修改入参）。
 */
export function mergeDiscoveredModels(
  staticModels: Record<string, ModelEntry> | undefined,
  discovered: readonly ParsedModelRow[],
): Record<string, ModelEntry> {
  const merged: Record<string, ModelEntry> = {};
  if (staticModels !== undefined) {
    for (const [id, entry] of Object.entries(staticModels)) merged[id] = { ...entry };
  }
  const seen = new Set<string>();
  for (const row of discovered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (merged[row.id] !== undefined) continue; // 静态声明优先，发现结果只补缺
    merged[row.id] = {
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
      ...(row.maxOutputTokens !== undefined ? { maxOutputTokens: row.maxOutputTokens } : {}),
    };
  }
  return merged;
}

export interface DiscoverOptions {
  /** 已加载的 auth 数据（提供时不再读 auth.json；测试注入用） */
  auth?: Parameters<typeof resolveApiKey>[2];
  /** key 解析用的环境变量表（缺省 process.env） */
  env?: Record<string, string | undefined>;
  /** 测试注入用 fetch（缺省全局 fetch；不做真实网络调用测试） */
  fetchImpl?: typeof fetch;
}

/** 渠道缺 key 的错误文案与 createProvider 同口径（绝不携带 key 本身） */
function missingKeyError(channel: string, provider: ProviderConfig, source: KeySource): ConfigError {
  const via = provider.envKey && source.kind === 'missing' ? `（envKey: ${provider.envKey}）` : '';
  return new ConfigError(`渠道 "${channel}" 缺少 API key ${via}: 请写入 auth.json 或设置对应环境变量`);
}

/**
 * 动态拉取渠道模型列表并与静态 models 表合并（Z6-A01）。
 *   openai 兼容：GET {baseUrl}/models（Bearer 鉴权）；
 *   anthropic：  GET {baseUrl}/v1/models（x-api-key + anthropic-version）。
 * 渠道不存在 / 缺 key → ConfigError；网络失败 / 超时 / 非 2xx / 响应形状不合法 →
 * ProviderError（fail-closed，绝不返回部分结果）。成功返回合并后的模型表
 * （静态优先，容量元数据有则带）。
 */
export async function discoverProviderModels(
  channel: string,
  config: HarnessConfig,
  options: DiscoverOptions = {},
): Promise<Record<string, ModelEntry>> {
  const provider = config.providers[channel];
  if (!provider) {
    throw new ConfigError(`渠道 "${channel}" 不存在于 config.providers`);
  }
  const env = options.env ?? process.env;
  const auth = options.auth ?? readAuthFile(defaultConfigPaths().globalAuth).auth;
  const key = resolveApiKey(channel, provider, auth, env);
  if (key.kind === 'missing') throw missingKeyError(channel, provider, key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  timer.unref?.();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    provider.protocol === 'anthropic' ? joinUrl(provider.baseUrl, 'v1/models') : joinUrl(provider.baseUrl, 'models');
  const headers: Record<string, string> =
    provider.protocol === 'anthropic'
      ? {
          accept: 'application/json',
          'x-api-key': key.key,
          'anthropic-version': ANTHROPIC_VERSION,
        }
      : {
          accept: 'application/json',
          authorization: `Bearer ${key.key}`,
        };

  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
  } catch (e) {
    const aborted = controller.signal.aborted || (e as Error)?.name === 'AbortError';
    throw aborted
      ? discoveryError(`请求超时（>${MODEL_DISCOVERY_TIMEOUT_MS}ms）`, 'timeout')
      : discoveryError(redactedSummary(`连接失败: ${(e as Error)?.message ?? String(e)}`), 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = res.status >= 500 ? 'server_5xx' : String(res.status);
    throw discoveryError(`HTTP ${res.status} ${res.statusText || ''}: ${text}`, code);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw discoveryError('响应不是合法 JSON', 'invalid_response');
  }
  const rows = provider.protocol === 'anthropic' ? parseAnthropicModelsResponse(json) : parseOpenAIModelsResponse(json);
  return mergeDiscoveredModels(provider.models, rows);
}
