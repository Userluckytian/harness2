// provider 工厂：roles 查找 → channel 校验 → key 解析（auth.json > env）→ 协议分派。
// key 缺失抛 ConfigError（消息只含渠道名/变量名，绝不含 key 本身）。
import {
  ConfigError,
  defaultConfigPaths,
  type AuthFile,
  type HarnessConfig,
  type ProviderConfig,
} from '../config/index.js';
import { readAuthFile } from '../config/auth.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai.js';
import type { ChatProvider } from './types.js';

export interface CreateProviderOptions {
  /** 已加载的 auth 数据（提供时不再读 auth.json；测试/调用方注入用） */
  auth?: AuthFile;
  /** auth 未提供时读取的 auth.json 路径（缺省 ~/.harness2/auth.json） */
  authPath?: string;
  /** key 解析用的环境变量表（缺省 process.env） */
  env?: Record<string, string | undefined>;
}

/** key 解析结果：来源供 config check 展示（auth.json / env:XXX / missing），key 绝不进消息 */
export type KeySource =
  { kind: 'auth.json'; key: string } | { kind: 'env'; envKey: string; key: string } | { kind: 'missing' };

/** key 解析顺序：auth.json 优先，其次 provider.envKey 指定的环境变量 */
export function resolveApiKey(
  channel: string,
  provider: ProviderConfig,
  auth: AuthFile,
  env: Record<string, string | undefined>,
): KeySource {
  const fromAuth = auth.channels[channel]?.apiKey;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return { kind: 'auth.json', key: fromAuth };
  if (provider.envKey) {
    const fromEnv = env[provider.envKey];
    if (typeof fromEnv === 'string' && fromEnv.length > 0)
      return { kind: 'env', envKey: provider.envKey, key: fromEnv };
  }
  return { kind: 'missing' };
}

/**
 * 按角色构造 ChatProvider：
 *   config.roles[role] → config.providers[channel] → 解析 key → 按 protocol 分派。
 * provider 标识（写入 assistant/message.model）为 "channel/model"。
 */
export function createProvider(config: HarnessConfig, role: string, options: CreateProviderOptions = {}): ChatProvider {
  const roleCfg = config.roles[role];
  if (!roleCfg) {
    const available = Object.keys(config.roles).join(', ') || '无';
    throw new ConfigError(`角色 "${role}" 未在 config.roles 中配置（可用角色: ${available}）`);
  }
  const providerCfg = config.providers[roleCfg.channel];
  if (!providerCfg) {
    throw new ConfigError(`roles.${role} 引用的渠道 "${roleCfg.channel}" 不存在于 config.providers`);
  }
  if (providerCfg.models && !(roleCfg.model in providerCfg.models)) {
    throw new ConfigError(`roles.${role}.model "${roleCfg.model}" 未在 providers.${roleCfg.channel}.models 中声明`);
  }

  const env = options.env ?? process.env;
  let auth = options.auth;
  if (auth === undefined) {
    const authPath = options.authPath ?? defaultConfigPaths().globalAuth;
    auth = readAuthFile(authPath).auth;
  }

  const source = resolveApiKey(roleCfg.channel, providerCfg, auth, env);
  if (source.kind === 'missing') {
    const via = providerCfg.envKey ? `（envKey: ${providerCfg.envKey}）` : '（未配置 envKey）';
    throw new ConfigError(`渠道 "${roleCfg.channel}" 缺少 API key ${via}: 请写入 auth.json 或设置对应环境变量`);
  }

  const name = `${roleCfg.channel}/${roleCfg.model}`;
  const maxOutputTokens = providerCfg.models?.[roleCfg.model]?.maxOutputTokens;
  if (providerCfg.protocol === 'openai') {
    return new OpenAICompatProvider({
      name,
      baseUrl: providerCfg.baseUrl,
      apiKey: source.key,
      model: roleCfg.model,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }
  return new AnthropicProvider({
    name,
    baseUrl: providerCfg.baseUrl,
    apiKey: source.key,
    model: roleCfg.model,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}
