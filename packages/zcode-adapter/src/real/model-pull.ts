/**
 * ZS4.5：provider 保存后自动拉取模型列表（用户 2026-10-22 批准）。
 *
 * 背景：ZCode 设置页没有「拉取模型」按钮（UI 零改动红线，不造按钮），但添加供应商后
 * 用户必须逐个手填模型（还要过智能配置校验，体验差）。宿主侧补自动化：合法保存
 * （baseUrl+密钥齐）时顺手请求渠道的模型列表端点，把结果合并进该 provider 的 models。
 *
 * 端点（真机实证过的公开约定，非猜测）：
 * - OpenAI 兼容：GET {base}/models（base 带 /v1 直接拼；不带时按协议惯例补 /v1；
 *   个别网关把 /chat/completions 写进 baseUrl，先剥掉）。响应 `{ data: [{id}, ...] }`。
 * - Anthropic：GET {base}/v1/models，头 x-api-key + anthropic-version（官方 Models API）。
 *   响应 `{ data: [{id}, ...] }`。
 *
 * 纪律：
 * - **best-effort**：任何失败（网络/非 200/形状不对/超时）静默跳过，绝不让保存失败——
 *   拉取是增益，不是保存的前置条件；
 * - 密钥只在请求头，绝不写回任何落盘文件；模型 ID 过 validateModelId 白名单形状，
 *   不合者丢弃（防列表端点回显脏数据进 config）；
 * - 已有模型键原样保留（用户自定义的 contextWindow/推理档位不覆盖）；只增不改不删；
 * - 超时默认 8s（AbortController），失败无重试（下次保存再拉）。
 */
import { ProviderWriteStore, type StoredProviderConfig } from './provider-writes.js';

const TIMEOUT_MS = 8_000;

export interface PullModelsEnv {
  protocol: string | undefined;
  baseUrl: string | undefined;
  apiKey: string | undefined;
}

/** 归一化模型列表 URL；失败返回 null（形状不认识的 baseUrl 不硬猜）。 */
export function modelsListUrl(env: PullModelsEnv): string | null {
  const raw = (env.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  // 网关常见写法：baseUrl 直达 chat 端点 → 退回其目录作 API 根
  const base = raw.replace(/\/(chat\/completions|completions|responses)$/i, '');
  try {
    const u = new URL(base);
    if (env.protocol === 'anthropic') {
      // 官方约定：根 + /v1/models（base 常不带 /v1）；带了就别重复拼
      const path = u.pathname.replace(/\/+$/, '');
      u.pathname = /\/v\d+$/i.test(path) ? `${path}/models` : `${path}/v1/models`;
      return u.toString();
    }
    // OpenAI 兼容：base 已含 /v1（或 /v1beta 等版本段）→ 直接拼 /models；否则补 /v1
    const path = u.pathname.replace(/\/+$/, '');
    if (path === '') u.pathname = '/v1/models';
    else if (/\/v\d+\w*$/i.test(path)) u.pathname = `${path}/models`;
    else if (/\/v\d+\w*\//i.test(path)) {
      // 形如 /v1/chat/... 已被上面剥过；剩余深路径：截到版本段为止
      const m = path.match(/^(\/v\d+\w*)/i);
      u.pathname = m ? `${m[1]}/models` : `${path}/models`;
    } else u.pathname = `${path}/models`;
    return u.toString();
  } catch {
    return null;
  }
}

/** 从两种已知响应形状提取合法模型 ID（保持服务端顺序，去重）。 */
export function extractModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id !== 'string') continue;
    try {
      ProviderWriteStore.validateModelId(id);
    } catch {
      continue; // 脏 ID 丢弃，不入库
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 纯拉取：GET 渠道模型列表端点，返回合法 ID 数组（有序去重）。
 * 失败/无 key/形状不对 → throw（调用方决定反馈形态：保存路径静默兜底、
 * 显式「获取模型」动作把错误展示给用户）。
 */
export async function pullModelIds(
  env: PullModelsEnv,
  fetchImpl: typeof fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<string[]> {
  const url = modelsListUrl(env);
  if (!url) throw new Error('baseUrl 无效，无法拉取模型列表');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.apiKey) {
    if (env.protocol === 'anthropic') {
      headers['x-api-key'] = env.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${env.apiKey}`;
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: ac.signal });
    if (!res.ok) throw new Error(`模型列表端点返回 ${res.status}`);
    const body: unknown = await res.json();
    return extractModelIds(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取并合并模型进 provider 条目（就地改 config.models）。
 * 返回新增的模型 ID 数组；失败/无增返回 []。绝不 throw。
 */
export async function mergePulledModels(
  config: StoredProviderConfig,
  env: PullModelsEnv,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string[]> {
  try {
    const ids = await pullModelIds(env, fetchImpl, timeoutMs);
    if (ids.length === 0) return [];
    const models = { ...(config.models ?? {}) } as Record<string, unknown>;
    const added: string[] = [];
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(models, id)) continue;
      models[id] = {};
      added.push(id);
    }
    if (added.length > 0) config.models = models;
    return added;
  } catch {
    return []; // best-effort：网络/解析/超时一律静默
  }
}
