// 配置报告（阶段 5）：config check（CLI 文本输出）与 GET /api/config（服务脱敏报告）
// 的同源构造处——providers/roles/approval/key 来源只在这里计算一次，两个消费方各自渲染。
// 红线：报告里只有 key 的"来源"标签（auth.json / env:XXX / **missing**），绝无明文 key；
// baseUrl/envKey 等字段照 CLI 口径先过 redactObject（防 ${VAR} 展开值或误写内容携带密钥）。
import { resolveApiKey } from '../provider/factory.js';
import { redactObject } from './redact.js';
import type { AuthFile } from './auth.js';
import type { HarnessConfig } from './schema.js';

/** 单渠道脱敏摘要（provider 标识/地址/模型清单/key 来源标签） */
export interface ConfigReportProvider {
  channel: string;
  protocol: string;
  baseUrl: string;
  envKey?: string;
  models: string[];
  /** auth.json | env:XXX | **missing**（永不携带明文 key） */
  keySource: string;
}

export interface ConfigReportRole {
  role: string;
  channel: string;
  model: string;
}

export interface ConfigReport {
  providers: ConfigReportProvider[];
  roles: ConfigReportRole[];
  approval: {
    mode: string;
    tools: Record<string, string>;
  };
}

/**
 * 从已加载配置 + auth 数据构造结构化脱敏报告（纯函数，无 I/O）。
 * env 缺省取 process.env（key 来源判定需要；只读变量名，不回传值）。
 */
export function buildConfigReport(
  config: HarnessConfig,
  auth: AuthFile,
  env: Record<string, string | undefined> = process.env,
): ConfigReport {
  const providers: ConfigReportProvider[] = [];
  for (const [channel, p] of Object.entries(config.providers)) {
    const safe = redactObject(p);
    const source = resolveApiKey(channel, p, auth, env);
    const keySource =
      source.kind === 'auth.json' ? 'auth.json' : source.kind === 'env' ? `env:${source.envKey}` : '**missing**';
    providers.push({
      channel,
      protocol: safe.protocol,
      baseUrl: safe.baseUrl,
      ...(safe.envKey !== undefined ? { envKey: safe.envKey } : {}),
      models: Object.keys(p.models ?? {}),
      keySource,
    });
  }
  return {
    providers,
    roles: Object.entries(config.roles).map(([role, r]) => ({ role, channel: r.channel, model: r.model })),
    approval: {
      mode: config.approval.mode ?? 'default',
      tools: { ...(config.approval.tools ?? {}) },
    },
  };
}
