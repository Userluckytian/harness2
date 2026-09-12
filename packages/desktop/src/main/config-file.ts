// 主进程设置读写（B2）：复用 @harness2/core 的 config/auth 模块（同一份 config.json/auth.json，
// 不建平行配置），只通过 IPC 暴露最小改动面。渲染进程零 Node——一切经 bridge 的 settings:* 命令。
// core 是 ESM-only，主进程产物是 CJS：经由 main/core.ts 的 createRequire 桥加载（运行时 require(esm)）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PLUGINS_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
  deepMerge,
  loadConfig,
  parseConfig,
  readAuthFile,
  redactSecrets,
  writeAuthFile,
  defaultConfigPaths,
  type AuthFile,
  type HarnessConfig,
  type ProviderConfig,
} from './core.js';
import type {
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsProviderShape,
  SettingsRoleShape,
} from '../shared/protocol.js';

/** 白名单：settings:updateConfig 只允许合并这些顶层 key（与 known 配置语义对齐） */
const CONFIG_TOP_KEYS = new Set([
  'providers',
  'roles',
  'approval',
  'memory',
  'browser',
  'plugins',
  'mcpServers',
  'subagent',
  'gateways',
]);

/** 疑似密钥字段名：updateConfig 里出现即拒绝（密钥只进 auth.json） */
const SECRET_KEYS = new Set(['apiKey', 'appSecret', 'key', 'token', 'secret']);

function hasSecretKey(node: unknown, path = ''): boolean {
  if (typeof node !== 'object' || node === null) return false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) return true;
    if (typeof v === 'object' && v !== null && hasSecretKey(v, `${path}.${k}`)) return true;
  }
  return false;
}

/** 读取全局 config.json 原始对象（JSONC 兼容）。三种状态区分对待：
 *  missing = 文件不存在（合法，空基线）；corrupt = 存在但解析失败（PD5：拒绝写入，不静默覆盖
 *  用户含注释/半截的原文）；ok = 解析成功。jsonc-parser 不抛错、只报 errors 数组，必须检查。 */
type RawGlobalConfig = { state: 'missing' } | { state: 'ok'; raw: unknown } | { state: 'corrupt' };

function readRawGlobalConfig(home: string): RawGlobalConfig {
  const path = defaultConfigPaths(undefined, home).globalConfig;
  if (!existsSync(path)) return { state: 'missing' };
  const errors: ParseError[] = [];
  try {
    const raw = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length > 0) return { state: 'corrupt' };
    return { state: 'ok', raw };
  } catch {
    return { state: 'corrupt' };
  }
}

/** 原子写（PD5，与 json-file.ts P2-3 同口径）：先写同目录临时文件再 rename 覆盖；
 *  rename 失败（如杀软占用）回落直写并清理临时文件。 */
function writeRawGlobalConfig(home: string, raw: unknown): void {
  const path = defaultConfigPaths(undefined, home).globalConfig;
  mkdirSync(join(path, '..'), { recursive: true });
  const data = `${JSON.stringify(raw, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, data, 'utf8');
    try {
      if (existsSync(tmp)) rmSync(tmp);
    } catch {
      // 临时文件清理失败不影响数据（下次写会覆盖同名 tmp）
    }
  }
}

function mapProvider(p: ProviderConfig | undefined): SettingsProviderShape | undefined {
  if (p === undefined) return undefined;
  return {
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    ...(p.envKey !== undefined ? { envKey: p.envKey } : {}),
    ...(p.models !== undefined ? { models: p.models } : {}),
  };
}

function mapRole(r: { channel: string; model: string } | undefined): SettingsRoleShape | undefined {
  if (r === undefined) return undefined;
  return { channel: r.channel, model: r.model };
}

/** settings:getConfig：读合并视图（复用 core loadConfig 的全局/项目合并 + 校验） */
export function readSettingsConfig(home: string, root: string): SettingsConfigShape {
  const loaded = loadConfig({ root, home });
  const cfg = loaded.config;
  const sources = loaded.sources;
  const warnings = [...loaded.warnings];
  const errors = [...loaded.errors];
  if (cfg === null) {
    return {
      providers: {},
      roles: {},
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
      sources,
      warnings,
      errors,
    };
  }
  const providers: Record<string, SettingsProviderShape> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    const mapped = mapProvider(p);
    if (mapped !== undefined) providers[name] = mapped;
  }
  const roles: Record<string, SettingsRoleShape> = {};
  for (const [name, r] of Object.entries(cfg.roles)) {
    const mapped = mapRole(r);
    if (mapped !== undefined) roles[name] = mapped;
  }
  const shape: SettingsConfigShape = {
    providers,
    roles,
    approval: {
      mode: cfg.approval.mode ?? 'default',
      ...(cfg.approval.tools !== undefined ? { tools: cfg.approval.tools } : {}),
    },
    memory: { mode: cfg.memory.mode, nudgeInterval: cfg.memory.nudgeInterval },
    browser: {
      enabled: cfg.browser.enabled,
      idleDestroyMs: cfg.browser.idleDestroyMs,
      maxConcurrent: cfg.browser.maxConcurrent,
    },
    plugins: { enabled: cfg.plugins.enabled, allow: cfg.plugins.allow },
    mcpServers: {},
    subagent: { maxDepth: cfg.subagent.maxDepth, maxTurns: cfg.subagent.maxTurns },
    ...(cfg.gateways !== undefined ? { gateways: cfg.gateways as unknown as Record<string, unknown> } : {}),
    sources,
    warnings,
    errors,
  };
  for (const [name, m] of Object.entries(cfg.mcpServers)) {
    if ('command' in m) {
      shape.mcpServers[name] = {
        command: m.command,
        ...(m.args !== undefined ? { args: m.args } : {}),
        ...(m.env !== undefined ? { env: m.env } : {}),
        ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
      };
    } else {
      shape.mcpServers[name] = { url: m.url, ...(m.headers !== undefined ? { headers: m.headers } : {}) };
    }
  }
  return shape;
}

/**
 * settings:updateConfig：白名单 patch 深合并进全局 config.json，先 parseConfig 校验后写回。
 * - 顶层 key 必须在白名单内；含密钥字段名（apiKey/appSecret/...）直接拒绝。
 * - 写全局（项目配置存在时合并后以项目为准，UI 已标注写全局）。
 */
export function updateSettingsConfig(
  home: string,
  patch: Record<string, unknown>,
): { ok: boolean; config?: SettingsConfigShape; warnings?: string[]; error?: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' };
  }
  for (const key of Object.keys(patch)) {
    if (!CONFIG_TOP_KEYS.has(key)) {
      return { ok: false, error: `不允许的配置字段 ${key}（密钥类信息请走 auth.json）` };
    }
  }
  if (hasSecretKey(patch)) {
    return { ok: false, error: '配置里不允许写入密钥类字段（apiKey/appSecret 请配置在 auth.json）' };
  }
  const baseState = readRawGlobalConfig(home);
  if (baseState.state === 'corrupt') {
    // PD5：损坏文件绝不静默覆盖（会把用户手工维护的注释/配置整份丢掉）——如实拒绝并给出可行动提示
    return {
      ok: false,
      error: '全局 config.json 无法解析（JSONC 损坏）——请先修复该文件（或备份后删除）再修改配置；本次未写入任何内容',
    };
  }
  const base = baseState.state === 'ok' ? baseState.raw : {};
  const merged = deepMerge(
    {
      providers: {},
      roles: {},
      approval: {},
      memory: DEFAULT_MEMORY_CONFIG,
      browser: DEFAULT_BROWSER_CONFIG,
      plugins: DEFAULT_PLUGINS_CONFIG,
      mcpServers: {},
      subagent: DEFAULT_SUBAGENT_CONFIG,
    },
    deepMerge(base, patch),
  );
  if (merged === null || typeof merged !== 'object') {
    return { ok: false, error: '合并结果非法' };
  }
  const mergedObj = merged as Record<string, unknown>;
  // 用 project/global 双文件解析无法直接校验写入后形状：先单独 parseConfig 单份（读全量写入对象）
  const result = parseConfig(mergedObj);
  if (result.config === null) {
    return { ok: false, error: result.errors[0] ?? '配置校验失败' };
  }
  try {
    writeRawGlobalConfig(home, mergedObj);
  } catch (e) {
    return { ok: false, error: `config.json 写入失败: ${redactSecrets((e as Error).message)}` };
  }
  return { ok: true, config: readSettingsConfig(home, process.cwd()), warnings: result.warnings };
}

/** settings:getAuthMasked：auth.json 渠道/网关掩码视图（永不回显明文） */
export function readAuthMasked(home: string): SettingsAuthMaskedShape {
  const { auth, error } = readAuthFile(defaultConfigPaths(undefined, home).globalAuth);
  const channels = Object.keys(auth.channels).map((channel) => ({ channel, masked: true }));
  const gateways = Object.entries(auth.gateways ?? {}).map(([channel, g]) => ({
    channel,
    maskedAppId: g.appId.length > 0,
    maskedAppSecret: g.appSecret.length > 0,
  }));
  return { channels, gateways, ...(error !== undefined ? { error } : {}) };
}

/**
 * settings:updateAuth：写 auth.json（仅 gateway 凭据；渲染端只传目标值，不回显明文）。
 * patch 形态：{ gateways: { qq: { appId, appSecret } | null } }。null/空字符串 = 移除该渠道。
 */
export function updateAuth(home: string, patch: Record<string, unknown>): { ok: boolean; error?: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' };
  }
  const gatewaysPatch = (patch as Record<string, unknown>)['gateways'];
  if (typeof gatewaysPatch !== 'object' || gatewaysPatch === null || Array.isArray(gatewaysPatch)) {
    return { ok: false, error: 'gateways 必须是对象' };
  }
  const path = defaultConfigPaths(undefined, home).globalAuth;
  const current = readAuthFile(path).auth;
  const baseGateways = current.gateways ?? {};
  const gateways: Record<string, { appId: string; appSecret: string }> = { ...baseGateways };
  for (const [name, v] of Object.entries(gatewaysPatch as Record<string, unknown>)) {
    if (v === null) {
      delete gateways[name];
      continue;
    }
    const g = v as Record<string, unknown>;
    const appId = typeof g['appId'] === 'string' ? g['appId'] : '';
    const appSecret = typeof g['appSecret'] === 'string' ? g['appSecret'] : '';
    if (appId.length === 0 && appSecret.length === 0) {
      delete gateways[name];
      continue;
    }
    const prev = gateways[name];
    gateways[name] = {
      // 空白 = 保留原值（渲染端输入框发新值时是完整值；保留原值用于"只改策略不动密钥"场景）
      appId: appId.length > 0 ? appId : (prev?.appId ?? ''),
      appSecret: appSecret.length > 0 ? appSecret : (prev?.appSecret ?? ''),
    };
  }
  const next: AuthFile = { ...current };
  if (Object.keys(gateways).length > 0) next.gateways = gateways;
  else delete next.gateways;
  try {
    writeAuthFile(path, next);
  } catch (e) {
    return { ok: false, error: `auth.json 写入失败: ${redactSecrets((e as Error).message)}` };
  }
  return { ok: true };
}

/** 全局配置文件路径（About / 数据类展示） */
export function globalConfigPath(home: string): string {
  return defaultConfigPaths(undefined, home).globalConfig;
}

export type { HarnessConfig };
