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
//     **不提供 auth 写**（serve 侧凭据写需用户单独拍板，走 405）。
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
import { deepMerge, defaultConfigPaths } from '../config/load.js';
import { readAuthFile } from '../config/auth.js';
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
