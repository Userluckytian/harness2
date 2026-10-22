/**
 * ZS4.5b：opencode 公开模型目录增强（用户 2026-10-22 点名 https://models.opencode.ai/api.json）。
 *
 * 背景：/models 列表端点只回 ID，不告诉客户端模型的上下文窗口/输出上限/推理档位——
 * 拉回来的模型是「空壳」，ZCode UI 智能匹配无基线、模型编辑器仍被必填卡住。
 * opencode 的公开目录（232 供应商）恰好带全这些元数据，且真机实证：本地网关
 * （owned_by=opencode 的别名代理）的 big-pickle/space-bunny/flint-40b 在目录的
 * opencode 条目下原样存在。
 *
 * 映射（只写目录里真实存在的字段，红线⑩不编造）：
 * - limit.context → contextWindow；limit.output → maxOutputTokens（core 扁平键，
 *   MODEL_KNOWN_KEYS 白名单内，零警告落盘）；
 * - reasoning_options[type=effort].values → reasoning.values（UI 档位候选基线）；
 *   map 仅在 type=effort 时按 OpenAI 兼容约定 `{"reasoning_effort": reasoningLevel}`
 *   （opencode 自家 SDK 同源约定，非凭空发明；type 不是 effort → 不猜，省略 map）。
 *
 * 纪律：进程内单例缓存（6MB JSON 一次解析）；失败静默（离线/形状变=退化为仅 ID，
 * 即 ZS4.5 初版行为）；绝不 throw 到保存路径。
 */

const CATALOG_URL = 'https://models.opencode.ai/api.json';
const CATALOG_TIMEOUT_MS = 15_000;

interface CatalogModelEntry {
  id?: unknown;
  limit?: { context?: unknown; output?: unknown };
  reasoning_options?: unknown;
}

export interface CatalogProvider {
  models?: Record<string, CatalogModelEntry>;
}

/** 目录解析结果：providerKey → 条目（仅取用到的字段面）。 */
export type CatalogMap = Record<string, CatalogProvider>;

let catalogCache: CatalogMap | null | undefined; // undefined/null=未拉或上次失败（保存是低频动作，允许下次再试）；对象=成功缓存

/** 拉目录（成功单例缓存）。失败返回 null（不缓存失败——离线首存后回线仍可富化）。 */
export async function loadOpencodeCatalog(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CATALOG_TIMEOUT_MS,
): Promise<CatalogMap | null> {
  if (catalogCache) return catalogCache;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(CATALOG_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      catalogCache = body as CatalogMap;
      return catalogCache;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 测试缝：重置单例缓存。 */
export function resetCatalogCacheForTests(): void {
  catalogCache = undefined;
}

/**
 * 匹配目录条目：
 * 1) 全 key 或 m.id 精确命中（任意 provider）——唯一即用，多个取 provider 键字典序首个（稳定）；
 * 2) 恰有一段前缀时试 `{catProvider}/{id}`；
 * 3) 无命中 → null（不猜、不后缀乱配，防跨供应商误命中）。
 */
export function lookupCatalogEntry(catalog: CatalogMap, modelId: string): CatalogModelEntry | null {
  const exact: Array<[string, CatalogModelEntry]> = [];
  for (const [pk, p] of Object.entries(catalog)) {
    if (!p || typeof p !== 'object' || !p.models || typeof p.models !== 'object') continue;
    for (const [key, m] of Object.entries(p.models)) {
      if (!m || typeof m !== 'object') continue;
      if (key === modelId || m.id === modelId) exact.push([`${pk}/${key}`, m]);
    }
  }
  if (exact.length > 0) {
    exact.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return exact[0][1];
  }
  const slash = modelId.indexOf('/');
  if (slash > 0 && slash < modelId.length - 1) {
    const pk = modelId.slice(0, slash);
    const rest = modelId.slice(slash + 1);
    const cand = catalog[pk]?.models?.[rest] ?? catalog[pk]?.models?.[modelId];
    if (cand && typeof cand === 'object') return cand;
  }
  return null;
}

/** OpenAI 兼容 reasoning_effort 的 UI 映射表达式（CEL，须可被 compileModelOptionMap 编译）。 */
export const UI_REASONING_MAP = '{"reasoning_effort": reasoningLevel}';

/**
 * core 扁平模型条目 → ZCode UI 嵌套 ModelConfigObject
 * （scratch UI 投影按 properties/optionSpecs 读取：providerSettingsFormProjection.ts:25/33、
 * useProviderModelDraft.ts:24、ProviderModelDraftState.ts:24）。只映射真实存在的键。
 */
export function flatCoreModelToUiConfig(flat: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const optionSpecs: Record<string, unknown> = {};
  if (typeof flat?.contextWindow === 'number' && flat.contextWindow > 0) properties.contextWindow = flat.contextWindow;
  if (typeof flat?.maxOutputTokens === 'number' && flat.maxOutputTokens > 0)
    optionSpecs.maxOutputTokens = { max: flat.maxOutputTokens };
  const reasoning = flat?.reasoning as { values?: unknown } | undefined;
  if (Array.isArray(reasoning?.values) && (reasoning.values as unknown[]).length > 0) {
    const values = (reasoning.values as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '');
    if (values.length > 0) optionSpecs.reasoningLevel = { values, map: UI_REASONING_MAP };
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(properties).length > 0) out.properties = properties;
  if (Object.keys(optionSpecs).length > 0) out.optionSpecs = optionSpecs;
  return out;
}

/**
 * 任意入站模型配置形（UI 嵌套 {properties,optionSpecs} 或 core 扁平 {contextWindow,...}）
 * → core 扁平存储形（磁盘唯一形；UI 定制 reasoningLevel.map 不持久化——core 无表达式
 * 映射键，档位→参数换算在 provider 层，登记偏差）。不认识的键原样保留（用户手撰容忍）。
 */
export function toStoredModelConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const c = config as Record<string, unknown>;
  const props = c.properties as Record<string, unknown> | undefined;
  const specs = c.optionSpecs as Record<string, unknown> | undefined;
  if (props === undefined && specs === undefined) return { ...c }; // 已是扁平形 → 直通
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k !== 'properties' && k !== 'optionSpecs') out[k] = v; // 其余扁平键保留
  }
  if (typeof props?.contextWindow === 'number' && props.contextWindow > 0) out.contextWindow = props.contextWindow;
  const maxTok = (specs?.maxOutputTokens as { max?: unknown } | undefined)?.max;
  if (typeof maxTok === 'number' && maxTok > 0) out.maxOutputTokens = maxTok;
  const level = specs?.reasoningLevel as { values?: unknown } | undefined;
  if (Array.isArray(level?.values)) {
    const values = level.values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (values.length > 0) out.reasoning = { values };
  }
  return out;
}

/** 非阻塞窥视目录缓存（resolveModelConfig 热路径用；未拉/拉失败=null）。 */
export function peekCatalog(): CatalogMap | null {
  return catalogCache ?? null;
}

/**
 * 目录条目 → core 扁平模型配置（只拷真实字段，无有效字段返回 null）。
 * core ModelEntry 合法键 = contextWindow/maxOutputTokens/reasoning{values,default}
 * （schema.ts MODEL_KNOWN_KEYS；reasoning_effort/thinking 换算由 provider 层完成，
 * 无独立 map 键——UI 侧的「推理参数映射」表达式由 flatCoreModelToUiConfig 生成）。
 */
export function catalogEntryToCoreModel(entry: CatalogModelEntry): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const ctx = entry.limit?.context;
  const outp = entry.limit?.output;
  if (typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0) out.contextWindow = ctx;
  if (typeof outp === 'number' && Number.isInteger(outp) && outp > 0) out.maxOutputTokens = outp;
  if (Array.isArray(entry.reasoning_options)) {
    const effort = entry.reasoning_options.find((o) => {
      const r = o as { type?: unknown; values?: unknown };
      return r && typeof r === 'object' && r.type === 'effort' && Array.isArray(r.values) && r.values.length > 0;
    }) as { values: unknown[] } | undefined;
    if (effort) {
      const values = effort.values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      if (values.length > 0) out.reasoning = { values };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * UI 嵌套形两份配置浅合并（properties / optionSpecs 两层；b 覆盖 a）。
 * resolveModelConfig 用：inherited（目录/磁盘基线）⊕ personal（用户覆盖）。
 */
export function mergeUiModelConfigs(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const bp = base.properties as Record<string, unknown> | undefined;
  const op = override.properties as Record<string, unknown> | undefined;
  if (bp || op) out.properties = { ...(bp ?? {}), ...(op ?? {}) };
  const bs = base.optionSpecs as Record<string, unknown> | undefined;
  const os = override.optionSpecs as Record<string, unknown> | undefined;
  if (bs || os) out.optionSpecs = { ...(bs ?? {}), ...(os ?? {}) };
  for (const [k, v] of Object.entries(override)) {
    if (k !== 'properties' && k !== 'optionSpecs') out[k] = v;
  }
  return out;
}

/**
 * 为一批模型 ID 查目录富化（批量一次拉目录）。
 * 返回 Map<id, core 扁平配置>；目录失败/无命中返回空 Map。绝不 throw。
 */
export async function enrichModelsFromCatalog(
  ids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  try {
    if (ids.length === 0) return result;
    const catalog = await loadOpencodeCatalog(fetchImpl);
    if (!catalog) return result;
    for (const id of ids) {
      const entry = lookupCatalogEntry(catalog, id);
      if (!entry) continue;
      const core = catalogEntryToCoreModel(entry);
      if (core) result.set(id, core);
    }
    return result;
  } catch {
    return result;
  }
}
