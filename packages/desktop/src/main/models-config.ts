// P6-B 模型配置页主进程侧（D-50～D-59）：提供方/模型的用户层读写、凭据通道、发现模型、revision 并发控制。
//
// 红线（HANDOFF §7，本模块是这些红线的执行点）：
//   1) 密钥只落 ~/.harness2/auth.json 的 channels.<route>.apiKey（或环境变量）；
//   2) config.json 只持有**具名引用**（providers.<id>.envKey = <ROUTE>_API_KEY），永不持有密钥值；
//   3) 渲染端只写不回读明文——回读只有「已确认 / 已确认缺失 / 未确认」与引用名；
//   4) 所有出口（错误消息、校验告警）过 redactSecrets。
//
// 与 core 的分工：core 的 config/auth 模块是同一份 config.json/auth.json 的读写底座，
// 本模块只在用户层（全局 config.json）做加性 upsert/删除，并用 core 的 parseConfig 校验候选结果
// （含与项目层组合后的可见性）。显示名称与首运行声明确认版本不在 core 配置契约里（core 冻结区），
// 故落在桌面覆层 ~/.harness2/desktop-models.json（与 desktop-metadata/preferences/drafts 同模式）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  DEFAULT_BROWSER_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PLUGINS_CONFIG,
  DEFAULT_SUBAGENT_CONFIG,
  deepMerge,
  defaultConfigPaths,
  parseConfig,
  readAuthFile,
  redactSecrets,
  writeAuthFile,
  type AuthFile,
} from './core.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';
import type {
  CredentialStatusShape,
  ModelsCredentialWriteResultShape,
  ModelsDeclarationAckShape,
  ModelsDiscoveryModelShape,
  ModelsDiscoveryResultShape,
  ModelsDocumentShape,
  ModelsModelRowShape,
  ModelsProviderInputShape,
  ModelsProviderLayerShape,
  ModelsProviderRowShape,
  ModelsWriteCodeShape,
  ModelsWriteResultShape,
  SettingsEventFrame,
} from '../shared/protocol.js';

/** 桌面覆层文件（显示名称 + 首运行声明确认版本；config.json 无这两个字段，core 为冻结区） */
export const MODELS_OVERLAY_FILE = 'desktop-models.json';

/** 设置域事件发射器（主进程 → 渲染端；D-58 订阅而非轮询）。缺省不发射（单测直接调纯函数） */
export type SettingsEmitter = (frame: SettingsEventFrame) => void;

/** Provider ID 允许的字符（= config 键 + 凭据引用词干；不含空白/引号，避免派生引用歧义） */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验用默认壳（parseConfig 要求 providers/roles 存在；与 config-file 的写入基线同口径） */
function configShell(): Record<string, unknown> {
  return {
    providers: {},
    roles: {},
    approval: {},
    memory: DEFAULT_MEMORY_CONFIG,
    browser: DEFAULT_BROWSER_CONFIG,
    plugins: DEFAULT_PLUGINS_CONFIG,
    mcpServers: {},
    subagent: DEFAULT_SUBAGENT_CONFIG,
  };
}

// —— 凭据引用派生（D-51） ——

/**
 * 缺引用时派生 `<ROUTE>_API_KEY`：route 大写、非字母数字折成下划线、去首尾下划线，
 * 以数字开头时前置下划线（环境变量名不允许数字开头）。
 */
export function deriveApiKeyRef(route: string): string {
  const stem = route
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (stem.length === 0) return 'ROUTE_API_KEY';
  return `${/^[0-9]/.test(stem) ? `_${stem}` : stem}_API_KEY`;
}

// —— 校验（D-57 / D-85） ——

/** 可打印 ASCII（空格排除）——与上游 `dsh-llm` 的 normalizeApiKey 同字符集 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

/**
 * 粘贴的 `NAME=value` 环境变量行（与上游 `apiKey.ts` 的 `ENV_LINE` 逐字同口径）：
 * 名字以大写字母开头（`sk-` 形态在连字符处断开），且 `=` 后**不能**紧跟另一个 `=`
 * —— 全大写 base64 padding（如 `ABCD==`）因此不被误判为赋值。
 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

/** 与上游 `isQuoted` 同口径：被一对**匹配**引号包裹（`"`、`'`、`` ` ``），长度 > 1 */
function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== '`') return false;
  return value.length > 1 && value.endsWith(first);
}

export interface ValidationResult {
  ok: boolean;
  /** 去空白后的规范化值（ok=true 时才有） */
  value?: string;
  error?: string;
}

/**
 * API 密钥校验（D-57，P2-8 与上游 `ui-settings-models/src/client/apiKey.ts` 同口径）：
 * 去空白后非空、拒 `NAME=value` 粘贴、拒**一对匹配引号**包裹（`"` / `'` / `` ` ``）、
 * 其余必须是可打印 ASCII（\x21-\x7E）。
 *
 * 与上游对齐的两处：
 *   1. `ENV_LINE` 要求 `=` 后**不是** `=` —— 全大写 base64 padding（如 `ABCD==`）是真实密钥形态，
 *      不得被当成赋值拒掉；名字以大写开头使 `sk-` 形态在连字符处断开。
 *   2. 引号只拒「成对包裹」（含反引号）；残留单边引号属上游 `LEGAL_API_KEY` 内的可打印 ASCII，
 *      按上游口径放行（不再额外拒绝「任何引号」）。
 */
export function validateApiKeyInput(raw: unknown): ValidationResult {
  if (typeof raw !== 'string') return { ok: false, error: 'API 密钥必须是字符串' };
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'API 密钥不能为空（去空白后为空）' };
  const envMatch = ENV_LINE.exec(value);
  if (envMatch !== null) {
    const name = value.slice(0, value.indexOf('='));
    return { ok: false, error: `粘贴的是 NAME=value 形态：请只粘贴密钥值本身（不要带 ${name}=）` };
  }
  if (isQuoted(value)) {
    return { ok: false, error: '密钥被引号包裹：请粘贴引号内的值本身（不要带引号）' };
  }
  if (!LEGAL_API_KEY.test(value)) {
    return {
      ok: false,
      error: '密钥只能包含可打印 ASCII 字符（0x21-0x7E）：当前含空白、控制字符或非 ASCII 字符',
    };
  }
  return { ok: true, value };
}

export interface ProviderFieldIssue {
  field: string;
  message: string;
}

export interface ProviderValidationContext {
  /** 既有 Provider ID 全集（用户层 ∪ 项目层；用于重复 id 拒绝） */
  existingIds: readonly string[];
  /** 编辑既有行时传原 id（允许 id 未变；无此参数 = 新建，必须不存在） */
  originalId?: string;
}

/** D-85：端点须为可解析的 http/https URL（localhost / IPv4 / IPv6 字面量 / 自定义端口都合法） */
function endpointIssue(baseUrl: string, field: string): ProviderFieldIssue | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { field, message: '端点必须是可解析的 http/https URL（如 https://api.example.com/v1）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field, message: `端点协议必须是 http 或 https（当前 ${parsed.protocol.replace(':', '')}）` };
  }
  if (parsed.hostname.length === 0) return { field, message: '端点缺少主机名' };
  return null;
}

/**
 * 提供方输入校验（D-57）：拒空 id / 重复 id / 空显示名 / 非正整容量；端点语法错误就地阻断（D-85）。
 * 返回空数组 = 通过（调用方按 field 就地展示）。
 */
export function validateProviderInput(
  input: ModelsProviderInputShape,
  ctx: ProviderValidationContext,
): ProviderFieldIssue[] {
  const issues: ProviderFieldIssue[] = [];
  const id = input.id.trim();
  if (id.length === 0) {
    issues.push({ field: 'id', message: 'Provider ID 不能为空' });
  } else if (!PROVIDER_ID_PATTERN.test(id)) {
    issues.push({
      field: 'id',
      message: 'Provider ID 只能以字母或数字开头，且只含字母、数字、点、下划线、连字符（它是配置键与凭据引用词干）',
    });
  } else {
    if (ctx.originalId !== undefined && ctx.originalId !== id) {
      issues.push({ field: 'id', message: 'Provider ID 不可修改（它是配置键与凭据引用词干）' });
    }
    const taken = new Set(ctx.existingIds.filter((x) => x !== ctx.originalId));
    if (taken.has(id)) issues.push({ field: 'id', message: `Provider ID 已存在：${id}` });
  }
  if (input.displayName.trim().length === 0) {
    issues.push({ field: 'displayName', message: '显示名称不能为空' });
  }
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    issues.push({ field: 'protocol', message: 'API 协议必须是 openai 或 anthropic' });
  }
  const baseUrl = input.baseUrl.trim();
  if (baseUrl.length === 0) {
    issues.push({ field: 'baseUrl', message: '端点（baseURL）不能为空' });
  } else {
    const issue = endpointIssue(baseUrl, 'baseUrl');
    if (issue !== null) issues.push(issue);
  }
  const seen = new Set<string>();
  for (const [index, m] of input.models.entries()) {
    const mid = m.id.trim();
    if (mid.length === 0) {
      issues.push({ field: `models.${index}.id`, message: '模型 id 不能为空' });
      continue;
    }
    if (seen.has(mid)) issues.push({ field: `models.${index}.id`, message: `模型 id 重复：${mid}` });
    seen.add(mid);
    for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
      const num = m[key];
      if (num === undefined) continue;
      if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
        issues.push({
          field: `models.${index}.${key}`,
          message: `${key === 'contextWindow' ? '上下文窗口' : '最大输出'}必须是正整数`,
        });
      }
    }
  }
  return issues;
}

/** 把 IPC 来的任意形状规范化为 ModelsProviderInputShape（同时收集形状类问题） */
export function normalizeProviderInput(raw: unknown): {
  input: ModelsProviderInputShape;
  issues: ProviderFieldIssue[];
} {
  const issues: ProviderFieldIssue[] = [];
  const empty: ModelsProviderInputShape = {
    id: '',
    displayName: '',
    protocol: 'openai',
    baseUrl: '',
    models: [],
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { input: empty, issues: [{ field: 'provider', message: '提供方必须是对象' }] };
  }
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown, field: string): string => {
    if (v === undefined) return '';
    if (typeof v !== 'string') {
      issues.push({ field, message: `${field} 必须是字符串` });
      return '';
    }
    return v;
  };
  const id = str(obj['id'], 'id');
  const displayName = str(obj['displayName'], 'displayName');
  const baseUrl = str(obj['baseUrl'], 'baseUrl');
  let protocol: ModelsProviderInputShape['protocol'] = 'openai';
  const rawProtocol = obj['protocol'];
  if (rawProtocol === 'anthropic') protocol = 'anthropic';
  else if (rawProtocol !== 'openai' && rawProtocol !== undefined) {
    issues.push({ field: 'protocol', message: 'API 协议必须是 openai 或 anthropic' });
  }
  const rawRef = obj['apiKeyRef'];
  let apiKeyRef: string | undefined;
  if (rawRef !== undefined) {
    if (typeof rawRef !== 'string') issues.push({ field: 'apiKeyRef', message: 'apiKeyRef 必须是字符串' });
    else if (rawRef.trim().length > 0) apiKeyRef = rawRef.trim();
  }
  const models: ModelsModelRowShape[] = [];
  const rawModels = obj['models'];
  if (rawModels !== undefined) {
    if (!Array.isArray(rawModels)) {
      issues.push({ field: 'models', message: '模型目录必须是数组' });
    } else {
      for (const [index, rawModel] of rawModels.entries()) {
        if (typeof rawModel !== 'object' || rawModel === null || Array.isArray(rawModel)) {
          issues.push({ field: `models.${index}`, message: '模型条目必须是对象' });
          continue;
        }
        const mo = rawModel as Record<string, unknown>;
        if (mo['id'] !== undefined && typeof mo['id'] !== 'string') {
          issues.push({ field: `models.${index}.id`, message: '模型 id 必须是字符串' });
        }
        const row: ModelsModelRowShape = { id: typeof mo['id'] === 'string' ? mo['id'] : '' };
        for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
          const v = mo[key];
          if (v === undefined || v === null || v === '') continue;
          if (typeof v !== 'number') {
            issues.push({ field: `models.${index}.${key}`, message: `${key} 必须是数字` });
            continue;
          }
          row[key] = v;
        }
        models.push(row);
      }
    }
  }
  return {
    input: {
      id,
      displayName,
      protocol,
      baseUrl,
      ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
      models,
    },
    issues,
  };
}

// —— 文件层读写（JSONC 容错；损坏如实标注，不静默覆盖） ——

interface LayerRead {
  path: string;
  existed: boolean;
  corrupt: boolean;
  raw: Record<string, unknown> | null;
  text: string;
}

function readLayer(path: string): LayerRead {
  if (!existsSync(path)) return { path, existed: false, corrupt: false, raw: null, text: '' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, existed: true, corrupt: true, raw: null, text: '' };
  }
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true });
  if (
    parseErrors.length > 0 ||
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return { path, existed: true, corrupt: true, raw: null, text };
  }
  return { path, existed: true, corrupt: false, raw: parsed as Record<string, unknown>, text };
}

function plainObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function providersOf(raw: Record<string, unknown> | null): Record<string, unknown> {
  return plainObject(raw?.['providers']) ?? {};
}

function rolesOf(raw: Record<string, unknown> | null): Record<string, unknown> {
  return plainObject(raw?.['roles']) ?? {};
}

function configRevisions(userLayer: LayerRead, projectLayer: LayerRead): string {
  return createHash('sha256').update(`${userLayer.text}\u0000${projectLayer.text}`).digest('hex').slice(0, 16);
}

/** 覆层（显示名称 + 声明确认版本） */
interface ModelsOverlay {
  displayNames: Record<string, string>;
  declarationAckVersion: number;
}

function overlayPath(home: string): string {
  return join(home, '.harness2', MODELS_OVERLAY_FILE);
}

function normalizeOverlay(value: unknown): ModelsOverlay {
  const obj = plainObject(value);
  const displayNames: Record<string, string> = {};
  const rawNames = plainObject(obj?.['displayNames']);
  if (rawNames !== null) {
    for (const [k, v] of Object.entries(rawNames)) {
      if (typeof v === 'string' && v.trim().length > 0) displayNames[k] = v;
    }
  }
  const rawAck = obj?.['declarationAckVersion'];
  const declarationAckVersion = typeof rawAck === 'number' && Number.isInteger(rawAck) && rawAck >= 0 ? rawAck : 0;
  return { displayNames, declarationAckVersion };
}

function readOverlay(home: string): ModelsOverlay {
  return readJsonWithDefault<ModelsOverlay>(overlayPath(home), normalizeOverlay, () => ({
    displayNames: {},
    declarationAckVersion: 0,
  }));
}

function writeOverlay(home: string, overlay: ModelsOverlay): void {
  writeJsonNormalized(overlayPath(home), overlay, normalizeOverlay);
}

/** 原子写用户层 config.json（与 config-file.ts 同口径：临时文件 + rename） */
function writeUserConfig(home: string, raw: Record<string, unknown>): void {
  writeJsonNormalized(defaultConfigPaths(undefined, home).globalConfig, raw, (v) => plainObject(v) ?? {});
}

// —— 凭据确认（D-52：只在已确认时上色） ——

function credentialStatusFor(
  route: string,
  envKey: string | undefined,
  authRead: { auth: AuthFile; error?: string },
  env: Record<string, string | undefined>,
): CredentialStatusShape {
  const reference = envKey !== undefined && envKey.length > 0 ? envKey : undefined;
  if (authRead.error !== undefined) {
    // auth.json 损坏：无法确认（不猜），如实回「未确认」
    return { state: 'unknown', ...(reference !== undefined ? { reference } : {}) };
  }
  const authKey = authRead.auth.channels[route]?.apiKey;
  if (typeof authKey === 'string' && authKey.length > 0) {
    return { state: 'confirmed', source: 'auth.json', ...(reference !== undefined ? { reference } : {}) };
  }
  if (reference !== undefined) {
    const fromEnv = env[reference];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) {
      return { state: 'confirmed', source: 'env', reference };
    }
    // 有具名引用、auth.json 无条目、环境变量未设 → 已确认该具名引用缺失（红点唯一合法条件）
    return { state: 'missing', reference };
  }
  return { state: 'unknown' };
}

// —— 文档读视图 ——

function modelsOf(provider: Record<string, unknown>): ModelsModelRowShape[] {
  const raw = plainObject(provider['models']);
  if (raw === null) return [];
  const rows: ModelsModelRowShape[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const e = plainObject(entry) ?? {};
    const row: ModelsModelRowShape = { id };
    const cw = e['contextWindow'];
    const mo = e['maxOutputTokens'];
    if (typeof cw === 'number' && Number.isFinite(cw) && Number.isInteger(cw) && cw > 0) row.contextWindow = cw;
    if (typeof mo === 'number' && Number.isFinite(mo) && Number.isInteger(mo) && mo > 0) row.maxOutputTokens = mo;
    rows.push(row);
  }
  return rows;
}

export interface ModelsDocumentContext {
  document: ModelsDocumentShape;
  userLayer: LayerRead;
  projectLayer: LayerRead;
}

/** 组装文档（含层归属、凭据确认、revision）；env 可注入以便测试环境变量引用 */
export function readModelsDocumentWithLayers(
  home: string,
  root: string,
  env: Record<string, string | undefined> = process.env,
): ModelsDocumentContext {
  const paths = defaultConfigPaths(root, home);
  const userLayer = readLayer(paths.globalConfig);
  const projectLayer = readLayer(paths.projectConfig);
  const authRead = readAuthFile(paths.globalAuth);
  const overlay = readOverlay(home);
  const userProviders = providersOf(userLayer.raw);
  const projectProviders = providersOf(projectLayer.raw);
  const warnings: string[] = [];
  const errors: string[] = [];
  if (userLayer.corrupt) errors.push(`${paths.globalConfig} 不是合法的 JSON/JSONC（已按空层处理，未做任何写入）`);
  if (projectLayer.corrupt) errors.push(`${paths.projectConfig} 不是合法的 JSON/JSONC（已按空层处理）`);
  if (authRead.error !== undefined) errors.push(authRead.error);

  const ids = [...new Set([...Object.keys(userProviders), ...Object.keys(projectProviders)])];
  const providers: ModelsProviderRowShape[] = [];
  for (const id of ids) {
    const inUser = Object.prototype.hasOwnProperty.call(userProviders, id);
    const inProject = Object.prototype.hasOwnProperty.call(projectProviders, id);
    const merged = (deepMerge(userProviders[id] ?? {}, projectProviders[id] ?? {}) ?? {}) as Record<string, unknown>;
    const layers: ModelsProviderLayerShape[] = [
      ...(inUser ? (['user'] as const) : []),
      ...(inProject ? (['project'] as const) : []),
    ];
    const deletable = inUser && !inProject;
    const envKeyRaw = merged['envKey'];
    const envKey = typeof envKeyRaw === 'string' && envKeyRaw.trim().length > 0 ? envKeyRaw.trim() : undefined;
    const baseUrlRaw = merged['baseUrl'];
    providers.push({
      id,
      displayName: overlay.displayNames[id] ?? id,
      protocol: merged['protocol'] === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: typeof baseUrlRaw === 'string' ? baseUrlRaw : '',
      ...(envKey !== undefined ? { apiKeyRef: envKey } : {}),
      models: modelsOf(merged),
      layers,
      deletable,
      ...(deletable
        ? {}
        : {
            lockedReason: inProject
              ? `该提供方由项目配置携带（${paths.projectConfig}）：请在项目配置中删除，或改用用户层覆写`
              : '该提供方不在用户层配置中，无法从用户层删除',
          }),
      credential: credentialStatusFor(id, envKey, authRead, env),
    });
  }

  // 组合视图校验（warnings/errors 如实展示；不影响读写本身）
  const composed = (deepMerge(userLayer.raw ?? {}, projectLayer.raw ?? {}) ?? {}) as Record<string, unknown>;
  const parsed = parseConfig(deepMerge(configShell(), composed));
  warnings.push(...parsed.warnings);
  if (parsed.config === null && !userLayer.corrupt && !projectLayer.corrupt) errors.push(...parsed.errors);

  return {
    document: {
      revision: configRevisions(userLayer, projectLayer),
      providers,
      declarationAckVersion: overlay.declarationAckVersion,
      sources: { global: userLayer.existed, project: projectLayer.existed },
      warnings,
      errors: errors.map(redactSecrets),
    },
    userLayer,
    projectLayer,
  };
}

/** 文档读视图（IPC settings:getModels）；env 可注入（测试显式注入受控环境，不读开发机 process.env） */
export function readModelsDocument(
  home: string,
  root: string,
  env: Record<string, string | undefined> = process.env,
): ModelsDocumentShape {
  return readModelsDocumentWithLayers(home, root, env).document;
}

// —— 写入 ——

function fail(
  code: ModelsWriteCodeShape,
  error: string,
  extra: { field?: string; document?: ModelsDocumentShape } = {},
): ModelsWriteResultShape {
  return { ok: false, code, error: redactSecrets(error), ...extra };
}

function issuesToFailure(issues: ProviderFieldIssue[], document: ModelsDocumentShape): ModelsWriteResultShape {
  const first = issues[0];
  return fail('validation', first?.message ?? '校验未通过', {
    ...(first !== undefined ? { field: first.field } : {}),
    document,
  });
}

/** 候选（用户层写后）与项目层组合是否仍能被 core 解析；通过返回 null，否则返回首条错误 */
function validateComposed(userRaw: Record<string, unknown>, projectRaw: Record<string, unknown> | null): string | null {
  const composed = (deepMerge(userRaw, projectRaw ?? {}) ?? {}) as Record<string, unknown>;
  const result = parseConfig(deepMerge(configShell(), composed));
  if (result.config === null) return result.errors[0] ?? '配置校验失败';
  return null;
}

/** 复制用户层 raw 并取一份可安全改写的 providers/roles 映射（不共享引用） */
function mutableUserCopy(raw: Record<string, unknown> | null): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(raw ?? {}) };
  copy['providers'] = { ...providersOf(copy) };
  copy['roles'] = { ...rolesOf(copy) };
  return copy;
}

export interface UpdateModelsRequest {
  revision: string;
  /** IPC 来的任意形状（内部 normalize + 校验；类型放宽是有意的：渲染端可能传任意 JSON） */
  provider: unknown;
  originalId?: string;
  mainModel?: string;
}

/**
 * 保存单张提供方卡（用户层 upsert）：
 *   revision 校验（并发写 → settings/conflict）→ 输入校验（D-57/D-85）→ 候选 config 与
 *   项目层组合后过 parseConfig → 原子写用户层 → 显示名称写覆层 → 发事件。
 * 具名引用：保留既有 envKey，缺引用时派生 `<ROUTE>_API_KEY`（只写名字，值永远只进 auth.json）。
 */
export function updateModelsProvider(
  home: string,
  root: string,
  req: UpdateModelsRequest,
  emit?: SettingsEmitter,
): ModelsWriteResultShape {
  const ctx = readModelsDocumentWithLayers(home, root);
  const document = ctx.document;
  // 并发边界（如实登记）：revision 由「读 → 校验 → 写」三步组成，**进程内**靠主进程单线程 + 本函数
  // 串行执行（含多窗口 IPC 队列）保证原子；**跨进程无锁** —— 同机并跑的 CLI / 第二个桌面实例
  // 可能在本函数读到 document 之后、写入之前改动 config.json，此时本函数仍会以旧 revision 通过校验。
  // 影响面：只会覆盖对方刚落盘的配置（不会丢 auth.json 密钥）；修法只能是文件锁（core 冻结区），
  // 本阶段不做。冲突提示在常见路径（同窗口内前后保存）已由 revision 不一致覆盖。
  if (typeof req.revision !== 'string' || req.revision !== document.revision) {
    return fail('settings/conflict', '配置已被其他修改改动（revision 不一致）：已拒绝本次写入，请刷新后重试', {
      document,
    });
  }
  if (ctx.userLayer.corrupt || ctx.projectLayer.corrupt) {
    const bad = ctx.userLayer.corrupt ? ctx.userLayer.path : ctx.projectLayer.path;
    return fail('io', `${bad} 无法解析（JSONC 损坏）：本次未写入任何内容，请先修复或备份该文件`, { document });
  }
  const normalized = normalizeProviderInput(req.provider);
  const issues = [
    ...normalized.issues,
    ...validateProviderInput(normalized.input, {
      existingIds: document.providers.map((p) => p.id),
      ...(req.originalId !== undefined ? { originalId: req.originalId } : {}),
    }),
  ];
  if (issues.length > 0) return issuesToFailure(issues, document);

  const input = normalized.input;
  const id = input.id.trim();
  const candidate = mutableUserCopy(ctx.userLayer.raw);
  const providers = providersOf(candidate);
  const existing = plainObject(providers[id]) ?? {};
  const existingEnvKey = typeof existing['envKey'] === 'string' ? (existing['envKey'] as string) : undefined;
  // 具名引用：保留既有；缺引用派生 <ROUTE>_API_KEY（D-51；UI 从不询问环境变量名）
  const envKey = existingEnvKey ?? deriveApiKeyRef(id);
  const providerConfig: Record<string, unknown> = {
    ...existing,
    protocol: input.protocol,
    baseUrl: input.baseUrl.trim(),
    envKey,
  };
  if (input.models.length > 0) {
    const models: Record<string, Record<string, number>> = {};
    for (const m of input.models) {
      const entry: Record<string, number> = {};
      if (m.contextWindow !== undefined) entry['contextWindow'] = m.contextWindow;
      if (m.maxOutputTokens !== undefined) entry['maxOutputTokens'] = m.maxOutputTokens;
      models[m.id.trim()] = entry;
    }
    providerConfig['models'] = models;
  } else {
    delete providerConfig['models'];
  }
  providers[id] = providerConfig;
  candidate['providers'] = providers;

  if (req.mainModel !== undefined && req.mainModel.trim().length > 0) {
    const mainModel = req.mainModel.trim();
    if (!input.models.some((m) => m.id.trim() === mainModel)) {
      return fail('validation', `主模型 "${mainModel}" 不在该提供方的模型目录中`, { field: 'mainModel', document });
    }
    const roles = rolesOf(candidate);
    roles['main'] = { channel: id, model: mainModel };
    candidate['roles'] = roles;
  }

  const validationError = validateComposed(candidate, ctx.projectLayer.raw);
  if (validationError !== null) return fail('validation', validationError, { document });

  try {
    writeUserConfig(home, candidate);
  } catch (e) {
    return fail('io', `config.json 写入失败: ${(e as Error).message}`, { document });
  }
  const overlay = readOverlay(home);
  const displayNames = { ...overlay.displayNames };
  const displayName = input.displayName.trim();
  if (displayName === id) delete displayNames[id];
  else displayNames[id] = displayName;
  writeOverlay(home, { displayNames, declarationAckVersion: overlay.declarationAckVersion });

  const next = readModelsDocument(home, root);
  emit?.({ type: 'settings/document-updated', revision: next.revision });
  emit?.({ type: 'llm/adapters-updated' });
  return { ok: true, document: next };
}

export interface DeleteModelsRequest {
  route: string;
  /** 确认框指名的提供方（必须与 route 一致；不一致即拒——防误删） */
  confirmRoute: string;
}

/**
 * 删除提供方（D-59）：仅当用户层独自携带该行；删后恢复组合基线。
 * 组合基线若仍引用该提供方（角色来自项目层等），如实拒绝并给可行动原因。
 */
export function deleteModelsProvider(
  home: string,
  root: string,
  req: DeleteModelsRequest,
  emit?: SettingsEmitter,
): ModelsWriteResultShape {
  const ctx = readModelsDocumentWithLayers(home, root);
  const document = ctx.document;
  const route = typeof req.route === 'string' ? req.route.trim() : '';
  if (route.length === 0) return fail('validation', '缺少 Provider ID', { field: 'id', document });
  if (req.confirmRoute !== route) {
    return fail('validation', `删除确认必须指名提供方（确认名 ${String(req.confirmRoute)} ≠ ${route}）`, {
      field: 'confirm',
      document,
    });
  }
  const row = document.providers.find((p) => p.id === route);
  if (row === undefined) return fail('validation', `提供方不存在：${route}`, { field: 'id', document });
  if (!row.deletable) {
    return fail('locked', row.lockedReason ?? '该提供方不可删除（不是用户层独有）', { document });
  }
  const candidate = mutableUserCopy(ctx.userLayer.raw);
  const providers = providersOf(candidate);
  delete providers[route];
  candidate['providers'] = providers;
  // 角色引用该提供方且角色在用户层 → 一并移除（删后恢复组合基线；项目层仍引用则下面校验会拒）
  const roles = rolesOf(candidate);
  for (const [role, value] of Object.entries(roles)) {
    const rc = plainObject(value);
    if (rc !== null && rc['channel'] === route) delete roles[role];
  }
  candidate['roles'] = roles;

  const validationError = validateComposed(candidate, ctx.projectLayer.raw);
  if (validationError !== null) {
    return fail('locked', `组合基线仍引用该提供方，删除会留下无效配置：${validationError}（请先解除该引用再删除）`, {
      document,
    });
  }
  try {
    writeUserConfig(home, candidate);
  } catch (e) {
    return fail('io', `config.json 写入失败: ${(e as Error).message}`, { document });
  }
  const overlay = readOverlay(home);
  const displayNames = { ...overlay.displayNames };
  delete displayNames[route];
  writeOverlay(home, { displayNames, declarationAckVersion: overlay.declarationAckVersion });

  const next = readModelsDocument(home, root);
  emit?.({ type: 'settings/document-updated', revision: next.revision });
  emit?.({ type: 'llm/adapters-updated' });
  return { ok: true, document: next };
}

// —— 凭据通道（D-51：只写） ——

/**
 * 写渠道 API 密钥：唯一入口，只写 auth.json（channels.<route>.apiKey）。
 * 返回值只含「具名引用名」，绝不含明文；auth.json 损坏时拒绝写入（不覆盖既有凭据）。
 */
export function writeChannelKey(
  home: string,
  root: string,
  route: string,
  key: unknown,
  emit?: SettingsEmitter,
): ModelsCredentialWriteResultShape {
  const trimmedRoute = typeof route === 'string' ? route.trim() : '';
  if (trimmedRoute.length === 0) {
    return { ok: false, code: 'validation', field: 'route', error: '缺少 Provider ID（凭据归属渠道）' };
  }
  if (/[\x00-\x1f\x7f]/.test(trimmedRoute)) {
    return { ok: false, code: 'validation', field: 'route', error: 'Provider ID 含控制字符，拒绝写入凭据' };
  }
  const valid = validateApiKeyInput(key);
  if (!valid.ok) {
    return { ok: false, code: 'validation', field: 'key', error: valid.error ?? '密钥校验未通过' };
  }
  const path = defaultConfigPaths(undefined, home).globalAuth;
  const current = readAuthFile(path);
  if (current.error !== undefined) {
    return {
      ok: false,
      code: 'io',
      error: `auth.json 当前无法解析，已拒绝写入以免覆盖既有凭据：${current.error}`,
    };
  }
  const next: AuthFile = {
    ...current.auth,
    channels: { ...current.auth.channels, [trimmedRoute]: { apiKey: valid.value as string } },
  };
  try {
    writeAuthFile(path, next);
  } catch (e) {
    return { ok: false, code: 'io', error: `auth.json 写入失败: ${redactSecrets((e as Error).message)}` };
  }
  const reference = deriveApiKeyRef(trimmedRoute);
  emit?.({ type: 'credentials/reference-updated', route: trimmedRoute });
  emit?.({ type: 'settings/document-updated', revision: readModelsDocument(home, root).revision });
  return { ok: true, reference };
}

/** 凭据确认查询（只回状态 + 具名引用，无明文） */
export function readCredentialStatuses(
  home: string,
  root: string,
  routes: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Record<string, CredentialStatusShape> {
  const paths = defaultConfigPaths(root, home);
  const authRead = readAuthFile(paths.globalAuth);
  const userProviders = providersOf(readLayer(paths.globalConfig).raw);
  const projectProviders = providersOf(readLayer(paths.projectConfig).raw);
  const out: Record<string, CredentialStatusShape> = {};
  for (const route of routes) {
    if (typeof route !== 'string' || route.trim().length === 0) continue;
    const id = route.trim();
    const merged = (deepMerge(userProviders[id] ?? {}, projectProviders[id] ?? {}) ?? {}) as Record<string, unknown>;
    const envKeyRaw = merged['envKey'];
    // 引用名以「配置里是否具名」为准：没写 envKey 时无引用 → unknown（不猜、不上色）
    const configuredRef = typeof envKeyRaw === 'string' && envKeyRaw.trim().length > 0 ? envKeyRaw.trim() : undefined;
    out[id] = credentialStatusFor(id, configuredRef, authRead, env);
  }
  return out;
}

// —— 首运行声明确认（D-59，版本化落盘） ——

export function ackModelsDeclaration(home: string, version: unknown): ModelsDeclarationAckShape {
  const overlay = readOverlay(home);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, declarationAckVersion: overlay.declarationAckVersion, error: '声明版本非法' };
  }
  const next = Math.max(overlay.declarationAckVersion, version);
  try {
    writeOverlay(home, { displayNames: overlay.displayNames, declarationAckVersion: next });
  } catch (e) {
    return {
      ok: false,
      declarationAckVersion: overlay.declarationAckVersion,
      error: `声明确认落盘失败: ${redactSecrets((e as Error).message)}`,
    };
  }
  return { ok: true, declarationAckVersion: next };
}

// —— 发现模型（D-55：拿表单当前端点去查；密钥取自已存凭据，不经渲染端回传） ——

export type DiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscoverModelsRequest {
  route: string;
  baseUrl: string;
  protocol: ModelsProviderInputShape['protocol'];
}

function discoveryUrl(baseUrl: string, protocol: ModelsProviderInputShape['protocol']): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return protocol === 'anthropic' ? `${trimmed}/v1/models` : `${trimmed}/models`;
}

/**
 * 出口脱敏兜底：`redactSecrets` 只认 sk- 前缀 / Bearer / 具名字段等形态，
 * 服务端错误体若**原样回显一个无前缀、无字段名包裹**的密钥（本地网关常见），上面那层会漏。
 * 这里用本次请求实际使用的密钥值再擦一遍 —— 只擦、不回显，不改变正常输出。
 */
function stripApiKeyValue(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text;
  return text.split(apiKey).join('[REDACTED]');
}

/** 从响应条目里取 id 与显示名（不臆造：缺显示名回退 id） */
function toDiscoveryModels(payload: unknown): ModelsDiscoveryModelShape[] {
  const obj = plainObject(payload);
  const data = obj?.['data'] ?? obj?.['models'];
  if (!Array.isArray(data)) return [];
  const out: ModelsDiscoveryModelShape[] = [];
  for (const item of data) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push({ id: item.trim(), displayName: item.trim() });
      continue;
    }
    const io = plainObject(item);
    if (io === null) continue;
    const id = typeof io['id'] === 'string' ? io['id'].trim() : '';
    if (id.length === 0) continue;
    const displayRaw = io['display_name'] ?? io['displayName'] ?? io['name'];
    const displayName = typeof displayRaw === 'string' && displayRaw.trim().length > 0 ? displayRaw.trim() : id;
    out.push({ id, displayName });
  }
  return out;
}

/**
 * 「获取可用模型」：用表单当前端点 + 该渠道已存凭据查询模型列表。
 * 凭据解析顺序与 core resolveApiKey 一致（auth.json > envKey 环境变量）；
 * 无凭据时如实拒绝并给可行动提示（不让渲染端把明文再传一遍）。
 *
 * 与上游的行为差（如实登记，非缺陷）：上游 `ui-settings-models` 用**表单草稿里的 key** 直接探测，
 * 未保存也能「获取可用模型」；本实现要求先「保存密钥」（凭据只在主进程从 auth.json/env 解析，
 * 渲染端不回传明文）。这样密钥路径保持单一（只写不回显），代价是多一步保存。
 */
export async function discoverModelsFor(
  home: string,
  root: string,
  req: DiscoverModelsRequest,
  fetchImpl: DiscoveryFetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<ModelsDiscoveryResultShape> {
  const route = typeof req.route === 'string' ? req.route.trim() : '';
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl.trim() : '';
  if (baseUrl.length === 0) return { ok: false, error: '端点（baseURL）不能为空' };
  const issue = endpointIssue(baseUrl, 'baseUrl');
  if (issue !== null) return { ok: false, error: issue.message };
  if (route.length === 0) return { ok: false, error: '缺少 Provider ID（凭据归属渠道）' };
  const protocol: ModelsProviderInputShape['protocol'] = req.protocol === 'anthropic' ? 'anthropic' : 'openai';

  const paths = defaultConfigPaths(root, home);
  const authRead = readAuthFile(paths.globalAuth);
  const userProviders = providersOf(readLayer(paths.globalConfig).raw);
  const projectProviders = providersOf(readLayer(paths.projectConfig).raw);
  const merged = (deepMerge(userProviders[route] ?? {}, projectProviders[route] ?? {}) ?? {}) as Record<
    string,
    unknown
  >;
  const envKeyRaw = merged['envKey'];
  const envKey = typeof envKeyRaw === 'string' && envKeyRaw.trim().length > 0 ? envKeyRaw.trim() : undefined;

  const authKey = authRead.error === undefined ? authRead.auth.channels[route]?.apiKey : undefined;
  let apiKey = typeof authKey === 'string' && authKey.length > 0 ? authKey : undefined;
  if (apiKey === undefined && envKey !== undefined) {
    const fromEnv = env[envKey];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) apiKey = fromEnv;
  }
  if (apiKey === undefined) {
    return {
      ok: false,
      error: '该提供方尚无可用凭据：请先保存 API 密钥，再获取可用模型（密钥不经渲染端回传）',
    };
  }

  const url = discoveryUrl(baseUrl, protocol);
  const headers: Record<string, string> =
    protocol === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    // 网络异常消息可能带出凭据（裸值/头）→ 双层脱敏（redactSecrets + 实际密钥值兜底）
    return {
      ok: false,
      error: stripApiKeyValue(redactSecrets(`获取模型列表失败（网络错误）: ${(e as Error).message}`), apiKey),
    };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const summary = stripApiKeyValue(redactSecrets(text.slice(0, 200)), apiKey);
    return { ok: false, error: `获取模型列表失败（HTTP ${res.status}）${summary.length > 0 ? `: ${summary}` : ''}` };
  }
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: '模型列表响应不是 JSON（端点是否正确？）' };
    }
  }
  const models = toDiscoveryModels(payload);
  if (models.length === 0) return { ok: false, error: '端点未返回任何模型（检查端点与协议是否匹配）' };
  return { ok: true, models };
}
