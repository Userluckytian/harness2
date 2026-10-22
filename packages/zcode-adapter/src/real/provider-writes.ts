/**
 * provider-writes —— ZS4-T4：模型供应商写路径的本地存储层。
 *
 * 事实源：`~/.harness2/config.json` 的 `providers` 段（**原始 JSON 读写**，不经 loadConfig
 * 归一化——归一化会丢 UI 需要的未知字段如 enabled 标记）；密钥独立落 `~/.harness2/auth.json`
 * （`channels.<providerId>.apiKey`，写 0600，红线：密钥永不进 config/git/日志/错误消息）。
 *
 * 语义偏差如实登记：ZCode 的 providerOrder/模型 enabled 走其云端索引；我们以 JSON 键序
 * 表达 provider 顺序、以模型条目上的 `enabled` 布尔表达开关（schema 对未知字段只告警）。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPaths, readAuthFile, redactSecrets, writeAuthFile } from './core-bridge.js';

export interface StoredProviderConfig {
  protocol?: unknown;
  baseUrl?: unknown;
  envKey?: unknown;
  models?: unknown;
  providerName?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
}

interface RawConfig {
  providers?: Record<string, StoredProviderConfig>;
  [key: string]: unknown;
}

export class ProviderWriteStore {
  readonly configPath: string;
  readonly authPath: string;

  constructor(home: string) {
    const paths = defaultConfigPaths(process.cwd(), home);
    this.configPath = paths.globalConfig;
    this.authPath = join(home, '.harness2', 'auth.json');
  }

  /** 读原始 config.json；不存在 = 空骨架；损坏 = 抛错（不盲写覆盖用户数据）。 */
  readRaw(): RawConfig {
    if (!existsSync(this.configPath)) return { providers: {} };
    const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config.json 形状异常（非对象），拒绝写入');
    }
    const raw = parsed as RawConfig;
    if (raw.providers === undefined) raw.providers = {};
    if (typeof raw.providers !== 'object' || raw.providers === null || Array.isArray(raw.providers)) {
      throw new Error('config.providers 形状异常，拒绝写入');
    }
    return raw;
  }

  /** 原子写：temp + rename；POSIX 0600（Windows 无权限位，依赖目录 ACL，同 auth 口径）。 */
  writeRaw(raw: RawConfig): void {
    atomicWrite(this.configPath, JSON.stringify(raw, null, 2) + '\n');
  }

  /**
   * 从 UI 传入的 config 中摘出密钥（键名匹配 apikey/api_key，值为非空字符串）：
   * **就地删除** config 上所有密钥键（空值也删）并把非空密钥写入 auth.channels[providerId]。
   * 未携带密钥 = 保持既有密钥不动。
   * 返回该 provider 最终是否存在可用密钥（供 executable 判定）。
   */
  absorbSecrets(providerId: string, config: StoredProviderConfig): boolean {
    let extracted: string | undefined;
    for (const [key, value] of Object.entries(config)) {
      if (!/api[_-]?key/i.test(key)) continue;
      if (typeof value === 'string' && value.trim().length > 0) extracted = value;
      delete config[key]; // 密钥字段永不落 config（空值同样剥除）
    }
    if (extracted !== undefined) {
      const { auth } = readAuthFile(this.authPath);
      auth.channels = { ...auth.channels, [providerId]: { apiKey: extracted } };
      writeAuthFile(this.authPath, auth); // core 写路径已做 0600
      return true;
    }
    return this.hasKey(providerId);
  }

  /** auth 是否已有该渠道密钥（或 envKey 兜底由调用方判断）。 */
  hasKey(providerId: string): boolean {
    try {
      const { auth } = readAuthFile(this.authPath);
      return typeof auth.channels?.[providerId]?.apiKey === 'string' && auth.channels[providerId].apiKey.length > 0;
    } catch {
      return false;
    }
  }

  apiKeyFor(providerId: string): string | undefined {
    try {
      return readAuthFile(this.authPath).auth.channels?.[providerId]?.apiKey;
    } catch {
      return undefined;
    }
  }

  /** 校验最小形状（与 core schema 同口径的必填项），错误消息可回 UI。 */
  static validateProviderConfig(providerId: string, config: StoredProviderConfig): void {
    const protocol = config.protocol;
    if (protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error(`providers.${providerId}.protocol 必须是 openai | anthropic`);
    }
    if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
      throw new Error(`providers.${providerId}.baseUrl 必须是非空字符串`);
    }
    if (config.models !== undefined) {
      if (typeof config.models !== 'object' || config.models === null || Array.isArray(config.models)) {
        throw new Error(`providers.${providerId}.models 必须是对象`);
      }
      for (const modelId of Object.keys(config.models as Record<string, unknown>)) {
        ProviderWriteStore.validateModelId(modelId);
      }
    }
  }

  /** 合法=能进磁盘（protocol+非空 baseUrl）。核心约束：core parseConfig 任一 provider 非法
   *  → 整份 config 归 null（schema.ts:1348）→ 主聊天 provider 一并崩（ZS2 发送门）。
   *  因此**非法 provider 绝不落盘**（草稿走内存 pending，见 provider-views）。 */
  static isCoreProviderConfigValid(config: StoredProviderConfig): boolean {
    try {
      ProviderWriteStore.validateProviderConfig('draft', config);
      return true;
    } catch {
      return false;
    }
  }

  static validateModelId(modelId: string): void {
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new Error('modelId 必须是非空字符串');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId)) {
      throw new Error(`modelId 形状非法: ${redactSecrets(modelId)}`);
    }
  }

  static newProviderId(taken: ReadonlySet<string>): string {
    for (let i = 0; i < 32; i++) {
      const id = `personal-${randomUUID().slice(0, 8)}`;
      if (!taken.has(id)) return id;
    }
    throw new Error('无法分配 providerId');
  }
}

/** 按给定 id 顺序重排一个 Record；未列出的键保持原相对顺序挂在尾部。 */
export function reorderRecord<T>(record: Record<string, T>, orderedIds: readonly string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of orderedIds) {
    if (Object.prototype.hasOwnProperty.call(record, id)) out[id] = record[id];
  }
  for (const [id, value] of Object.entries(record)) {
    if (!Object.prototype.hasOwnProperty.call(out, id)) out[id] = value;
  }
  return out;
}

const API_TYPE_TO_PROTOCOL: Record<string, 'openai' | 'anthropic'> = {
  'openai-chat-completions': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
};
const PROTOCOL_TO_API_TYPE: Record<string, string> = {
  openai: 'openai-chat-completions',
  anthropic: 'anthropic-messages',
};

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * ZS4-T6 契约翻译（e2e 实证缺口）：ZCode 设置页 UI 读写**嵌套形**
 * `ProviderConfigObject = { group, access:{type:'api-key',apiKey?}, api:{type,baseUrl}, … }`
 * （provider-data-schema.ts:86-96；表单绑定 InlineEditableProviderCard.tsx:191-241），
 * 而 harness2 core 磁盘是**扁平形** `{protocol, baseUrl, envKey, models}`（config/schema.ts）。
 * 本函数把 UI 入参归一为 core 扁平形再校验落盘；两种形状都接受（幂等），
 * 密钥只透出到顶层 `apiKey` 键，由 absorbSecrets 统一剥到 auth.json。
 * `group`/`logo`/`visibility`/`modelOrder` 不落盘（harness2 全部渠道恒为 personal，group 由视图恒定注入）。
 */
export function toCoreProviderConfig(uiConfig: Record<string, unknown>): StoredProviderConfig {
  const out: StoredProviderConfig = {};
  const api = isPlainRecord(uiConfig['api']) ? uiConfig['api'] : undefined;
  const access = isPlainRecord(uiConfig['access']) ? uiConfig['access'] : undefined;

  if (api !== undefined) {
    if (typeof api['type'] === 'string' && API_TYPE_TO_PROTOCOL[api['type']]) {
      out.protocol = API_TYPE_TO_PROTOCOL[api['type']];
    }
    if (typeof api['baseUrl'] === 'string') out.baseUrl = api['baseUrl'];
  }
  if (access !== undefined && typeof access['apiKey'] === 'string' && access['apiKey'].length > 0) {
    out.apiKey = access['apiKey']; // 由调用方 absorbSecrets 剥除落 auth
  }
  if (isPlainRecord(uiConfig['models'])) out.models = uiConfig['models'];
  for (const key of ['protocol', 'baseUrl', 'envKey', 'providerName', 'enabled', 'apiKey']) {
    if (out[key] === undefined && uiConfig[key] !== undefined) out[key] = uiConfig[key];
  }
  return out;
}

/** 出站翻译：core 扁平条目 → UI 嵌套形（`config.group==='standard-personal'` 是导航硬判据，
 *  恒定注入=如实映射，见 buildView 注释）。密钥**永不进视图**（红线：key 不过 renderer RPC；
 *  ZCode 自家把 key 存 config 里随视图下发，harness2 安全模型更严——偏差如实登记）。 */
export function toUiProviderConfig(pcfg: StoredProviderConfig): Record<string, unknown> {
  const protocol = typeof pcfg.protocol === 'string' ? pcfg.protocol : 'openai';
  const ui: Record<string, unknown> = {
    group: 'standard-personal',
    access: { type: 'api-key' },
    api: {
      type: PROTOCOL_TO_API_TYPE[protocol] ?? 'openai-chat-completions',
      ...(typeof pcfg.baseUrl === 'string' ? { baseUrl: pcfg.baseUrl } : {}),
    },
  };
  if (typeof pcfg.providerName === 'string' && pcfg.providerName.trim() !== '') {
    ui.providerName = pcfg.providerName;
  }
  return ui;
}

/** 同键替换但保持插入位置（rename 用：先记录位置，重建时按位放新键）。 */
export function replaceKeyPreserveOrder<T>(
  record: Record<string, T>,
  oldKey: string,
  nextKey: string,
  value: T,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === oldKey) out[nextKey] = value;
    else out[key] = entry;
  }
  return out;
}

function atomicWrite(path: string, content: string): void {
  mkdirp(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 无 POSIX 权限位
  }
  renameSync(tmp, path);
}

function mkdirp(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
