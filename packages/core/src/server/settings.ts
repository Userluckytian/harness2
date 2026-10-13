// Z9-6a：serve「设置数据端点」核心实现（web 设置页面对齐桌面）。
//
// 设计口径（与桌面主进程 `packages/desktop/src/main/config-file.ts` / `diagnostics.ts` /
// `skills-scan.ts` **逐字同源**，不新造第二套读取/合并语义）：
//   - config 读：由 http.ts 复用既有 `buildConfigPayload`（loadConfig + readAuthFile + buildConfigReport），
//     本模块不重复实现；本模块只负责**写**（白名单深合并）与 auth 掩码 / doctor / skills / crash 读。
//   - config 写：复用 core 原语 `deepMerge`（config/load.ts）+ `parseConfig`（config/schema.ts）
//     + `DEFAULT_*_CONFIG`，与桌面 `updateSettingsConfig` 同一合并/校验链路；原子写口径同桌面
//     `writeRawGlobalConfig`（同目录临时文件 + rename，失败回落直写并清理临时文件）。
//   - 白名单顶层 key 与「疑似密钥字段名」集合与桌面完全一致；密钥类字段一律拒绝并回可读错误。
//   - auth 只回**掩码**（channel 有无 / gateway appId、appSecret 是否非空），绝不回明文；
//     A2 起 auth 写放开（`updateAuth`，口径逐字照抄桌面 `settings:updateAuth`）：只写 auth.json 的
//     gateways 段，响应只回掩码级信息，绝不回显明文。
//   - doctor 复用 core `runDoctor`（六项检查）；skills 复用 core `SkillStore` 两级扫描；
//     crash-reports 复用 core `crashReportDir`（~/.harness2/crash，core 自有目录，非 Electron 专有）。
// 隐私边界：本模块任何错误出口经 `redactSecrets`，绝不打印密钥。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PLUGINS_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
  parseConfig,
} from '../config/schema.js';
import type { HarnessConfig, ModelEntry } from '../config/schema.js';
import { deepMerge, defaultConfigPaths, loadConfig } from '../config/load.js';
import { readAuthFile, writeAuthFile, type AuthFile } from '../config/auth.js';
import { redactSecrets } from '../config/redact.js';
import { SkillStore, defaultSkillsRoot, projectSkillsRoot } from '../skills/store.js';
import { crashReportDir } from '../doctor/crash.js';

/** 白名单：updateConfig 只允许合并这些顶层 key（与桌面 config-file.ts CONFIG_TOP_KEYS 逐字一致） */
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

/** 递归查找疑似密钥字段名（与桌面 hasSecretKey 同口径） */
export function hasSecretKey(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) return true;
    if (typeof v === 'object' && v !== null && hasSecretKey(v)) return true;
  }
  return false;
}

/** 读取全局 config.json 原始对象（JSONC 兼容）。missing = 不存在（合法空基线）；
 *  corrupt = 存在但解析失败（拒绝写入，不静默覆盖用户含注释/半截的原文）；ok = 解析成功。 */
type RawGlobalConfig = { state: 'missing' } | { state: 'ok'; raw: unknown } | { state: 'corrupt' };

function readRawGlobalConfig(home?: string): RawGlobalConfig {
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

/** 原子写全局 config.json（同桌面 writeRawGlobalConfig 口径）：临时文件 + rename；
 *  rename 失败（如杀软占用）回落直写并清理临时文件。 */
function writeRawGlobalConfig(home: string | undefined, raw: unknown): void {
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

/** config 写结果（成功 = 校验告警；失败 = 一行可读错误，已脱敏） */
export type SettingsConfigUpdateResult = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * PUT/POST /api/settings/config：白名单 patch 深合并进全局 config.json，先 parseConfig 校验后写回。
 * 与桌面 `updateSettingsConfig` 同一口径：顶层 key 必须在白名单内；含密钥字段名直接拒绝；
 * 全局文件损坏（JSONC 半截/注释丢失风险）拒绝写入；写全局（项目配置存在时以项目为准，UI 已标注）。
 */
export function updateGlobalConfig(
  home: string | undefined,
  patch: Record<string, unknown>,
): SettingsConfigUpdateResult {
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
  const result = parseConfig(mergedObj);
  if (result.config === null) {
    return { ok: false, error: result.errors[0] ?? '配置校验失败' };
  }
  try {
    writeRawGlobalConfig(home, mergedObj);
  } catch (e) {
    return { ok: false, error: `config.json 写入失败: ${redactSecrets((e as Error).message)}` };
  }
  return { ok: true, warnings: result.warnings };
}

/** 模型声明的推理档位（与桌面 `SettingsModelReasoningShape` 逐字同形；values 按强度从低到高，每模型自声明） */
export interface SettingsModelReasoningView {
  values: string[];
  default?: string;
}

/** 单渠道脱敏视图（与桌面 `SettingsProviderShape` 同形；envKey 是具名变量引用，非密钥值） */
export interface SettingsProviderView {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  envKey?: string;
  models?: Record<string, { contextWindow?: number; maxOutputTokens?: number; reasoning?: SettingsModelReasoningView }>;
}

/** 单条 hook 的只读视图（与桌面 `SettingsHookEntryShape` 同形） */
export interface SettingsHookEntryView {
  event: string;
  matcher?: string;
  command: string;
  timeoutMs?: number;
  enabled?: boolean;
  async?: boolean;
}

/** hooks 段视图（与桌面 `SettingsHooksShape` 同形；未配置 = 不出现） */
export interface SettingsHooksView {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  entries: SettingsHookEntryView[];
}

/**
 * GET /api/settings/config 的完整脱敏视图（**与桌面主进程 `readSettingsConfig` 逐字同形**）。
 * 覆盖 providers/roles/approval/memory/browser/plugins/mcpServers/subagent/gateways/hooks
 * 全部真实配置段 + sources/warnings/errors —— web 设置各分区据此可**如实读取**再渲染/保存，
 * 不再退化为 schema 缺省值（因此带「保存」按钮的分区不再有覆盖用户真实配置的风险）。
 * 红线：密钥只落 auth.json；本视图只读 config.json（其契约上无 key 字段），绝不回显任何密钥。
 */
export interface SettingsConfigView {
  providers: Record<string, SettingsProviderView>;
  roles: Record<string, { channel: string; model: string; effort?: string }>;
  approval: { mode: string; tools?: Record<string, string> };
  memory: { mode: string; nudgeInterval: number };
  browser: { enabled: boolean; idleDestroyMs: number; maxConcurrent: number };
  plugins: { enabled: boolean; allow: string[] };
  mcpServers: Record<string, unknown>;
  subagent: { maxDepth: number; maxTurns: number };
  gateways?: Record<string, unknown>;
  hooks?: SettingsHooksView;
  sources: { global: boolean; project: boolean };
  warnings: string[];
  errors: string[];
}

/** 单台 MCP 服务器视图：stdio（command/args/env/cwd）或 http（url/headers），与桌面同口径 */
function mapMcpServer(entry: HarnessConfig['mcpServers'][string]): Record<string, unknown> {
  if ('command' in entry) {
    return {
      command: entry.command,
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      ...(entry.env !== undefined ? { env: entry.env } : {}),
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    };
  }
  return { url: entry.url, ...(entry.headers !== undefined ? { headers: entry.headers } : {}) };
}

/**
 * 单模型视图（与桌面 `SettingsProviderShape.models` 条目逐字同形）：容量字段 + 可选 `reasoning`
 * 档位声明（web composer 思考档位的合法档位集合来源，见 ui-shared `buildThoughtLevel`）。
 * 模型未声明 reasoning → 不出现该字段（如实：该模型无可选档位）。
 */
function mapModelEntry(entry: ModelEntry): {
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: SettingsModelReasoningView;
} {
  return {
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    ...(entry.reasoning !== undefined
      ? {
          reasoning: {
            values: entry.reasoning.values,
            ...(entry.reasoning.default !== undefined ? { default: entry.reasoning.default } : {}),
          },
        }
      : {}),
  };
}

/**
 * 读合并视图（复用 core `loadConfig` 的全局/项目合并 + schema 校验，**不另造读取语义**）：
 * 与桌面 `readSettingsConfig` 的实现一一对应；config 为 null（两文件均不存在/解析失败）时回
 * schema 缺省段 + sources/warnings/errors（如实，不伪造用户配置）。纯读，无写副作用。
 */
export function readSettingsConfigView(env: { root: string; home?: string }): SettingsConfigView {
  const paths = defaultConfigPaths(env.root, env.home);
  const loaded = loadConfig({
    root: env.root,
    ...(env.home !== undefined ? { home: env.home } : {}),
    globalPath: paths.globalConfig,
    projectPath: paths.projectConfig,
  });
  const sources = loaded.sources;
  const warnings = [...loaded.warnings];
  const errors = [...loaded.errors];
  const cfg = loaded.config;
  if (cfg === null) {
    return {
      providers: {},
      roles: {},
      approval: { mode: 'default' },
      memory: { ...DEFAULT_MEMORY_CONFIG },
      browser: { ...DEFAULT_BROWSER_CONFIG },
      plugins: { ...DEFAULT_PLUGINS_CONFIG },
      mcpServers: {},
      subagent: { ...DEFAULT_SUBAGENT_CONFIG },
      sources,
      warnings,
      errors,
    };
  }
  const providers: Record<string, SettingsProviderView> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    const models =
      p.models !== undefined
        ? Object.fromEntries(Object.entries(p.models).map(([id, m]) => [id, mapModelEntry(m)]))
        : undefined;
    providers[name] = {
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      ...(p.envKey !== undefined ? { envKey: p.envKey } : {}),
      ...(models !== undefined ? { models } : {}),
    };
  }
  const roles: Record<string, { channel: string; model: string; effort?: string }> = {};
  for (const [name, r] of Object.entries(cfg.roles)) {
    roles[name] = { channel: r.channel, model: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}) };
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(cfg.mcpServers)) mcpServers[name] = mapMcpServer(entry);
  return {
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
    mcpServers,
    subagent: { maxDepth: cfg.subagent.maxDepth, maxTurns: cfg.subagent.maxTurns },
    ...(cfg.gateways !== undefined ? { gateways: cfg.gateways as unknown as Record<string, unknown> } : {}),
    ...(cfg.hooks !== undefined
      ? {
          hooks: {
            enabled: cfg.hooks.enabled,
            timeoutMs: cfg.hooks.timeoutMs,
            maxOutputBytes: cfg.hooks.maxOutputBytes,
            entries: cfg.hooks.entries.map((e) => ({
              event: e.event,
              command: e.command,
              ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
              ...(e.timeoutMs !== undefined ? { timeoutMs: e.timeoutMs } : {}),
              ...(e.enabled !== undefined ? { enabled: e.enabled } : {}),
              ...(e.async !== undefined ? { async: e.async } : {}),
            })),
          },
        }
      : {}),
    sources,
    warnings,
    errors,
  };
}

/** auth.json 掩码视图（与桌面 `readAuthMasked` 同口径，永不回显明文密钥） */
export interface SettingsAuthMaskedView {
  channels: Array<{ channel: string; masked: boolean }>;
  gateways: Array<{ channel: string; maskedAppId: boolean; maskedAppSecret: boolean }>;
  error?: string;
}

/** GET /api/settings/auth：只回 channel/gateway 的掩码状态（绝不回明文） */
export function readAuthMaskedView(home?: string): SettingsAuthMaskedView {
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
 * PUT/POST /api/settings/auth：写 auth.json 的**网关凭据**（口径**逐字照抄**桌面主进程
 * `packages/desktop/src/main/config-file.ts` 的 `updateAuth`；A2 起由用户授权放开，A1 曾走 405）。
 *
 * patch 形态：`{ gateways: { qq: { appId, appSecret } | null } }`。
 *   - 值非对象/数组 → 400 {ok:false, error}；
 *   - 某渠道 = null / appId+appSecret 均空 → 移除该渠道；
 *   - 单字段空白 = **保留原值**（用于「只改策略不动密钥」场景）；
 *   - 仅合并 gateways 段，**不动 channels 段**（渠道密钥只经 /api/settings/models/credential 写）。
 * 安全边界：写前先读回既有 auth（损坏时 readAuthFile 回空表，与桌面同口径），写后响应只回
 * 掩码级信息，绝不回显明文、绝不写日志；写入失败错误经 redactSecrets。
 */
export function updateAuth(home: string | undefined, patch: Record<string, unknown>): { ok: boolean; error?: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是对象' };
  }
  const gatewaysPatch = patch['gateways'];
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
    const g = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
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

/** 技能分区视图（与桌面 `readSkillsSummary` 同口径；复用 core SkillStore 两级扫描） */
export interface SettingsSkillsView {
  skills: Array<{ name: string; description: string; file: string; source: 'project' | 'global' }>;
  warnings: string[];
  roots: { project: string; global: string };
}

/** GET /api/settings/skills：复用 core SkillStore 两级扫描（注入的 store 优先，保证与 serve 装配同源） */
export function readSkillsView(root: string, home?: string, store?: SkillStore): SettingsSkillsView {
  const resolved = store ?? new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(home));
  const result = resolved.scan();
  return {
    skills: result.skills.map((s) => ({ name: s.name, description: s.description, file: s.file, source: s.source })),
    warnings: result.warnings,
    roots: { project: projectSkillsRoot(root), global: defaultSkillsRoot(home) },
  };
}

/** 崩溃报告条目（与桌面 `getCrashReports` 同口径） */
export interface SettingsCrashReport {
  fileName: string;
  /** 文件修改时间戳（ISO） */
  mtime: string;
  size: number;
}

/**
 * GET /api/settings/crash-reports：读 ~/.harness2/crash/*.log（按 mtime 倒序）。
 * 该目录由 core 拥有（`crashReportDir`，非 Electron 专有）——目录缺失/不可读一律转空表（如实，不伪造）。
 */
export function readCrashReports(home?: string): SettingsCrashReport[] {
  const dir = crashReportDir(home);
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.log'))
      .map((fileName) => {
        const st = statSync(join(dir, fileName));
        return { fileName, mtime: st.mtime.toISOString(), size: st.size };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}
