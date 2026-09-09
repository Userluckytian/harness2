// 插件装载器（阶段 8）：目录扫描 + manifest 校验 + 模块导入。
// 布局：<pluginsRoot>/<name>/manifest.json + index.js（默认导出 definePlugin({...})），
// pluginsRoot 缺省 ~/.harness2/plugins。装载审批（config.plugins.allow 名单）在 bus 层执行。
// 纯扫描/校验不执行任何插件代码；代码仅在 importPluginModule 被显式调用时进入进程。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWN_EVENT_TYPES } from '../session/types.js';
import { TOOL_NAME_PATTERN } from '../tools/types.js';
import { PLUGIN_NAME_PATTERN, PluginError, type PluginManifest, type PluginModule } from './types.js';

/** ~/.harness2 下的插件目录名 */
export const PLUGINS_DIR_NAME = 'plugins';

export function defaultPluginsRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', PLUGINS_DIR_NAME);
}

export type ManifestValidation = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PERMISSION_KEYS = new Set(['tools', 'events', 'cron']);

/**
 * manifest 校验：name（合法且 = 目录名）、version（非空字符串）、permissions（可选，
 * 逐键校验；未知键拒绝——权限声明不允许拼错键静默放行）。事件名必须是已知会话事件
 * 类型或 '*'；tools 名单内的工具名必须满足 TOOL_NAME_PATTERN（否则永远注册不上）。
 */
export function validatePluginManifest(raw: unknown, dirName: string): ManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, error: 'manifest 必须是 JSON 对象' };
  const name = raw['name'];
  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    return { ok: false, error: `manifest.name 非法（须匹配 ${PLUGIN_NAME_PATTERN.source}）` };
  }
  if (name !== dirName) {
    return { ok: false, error: `manifest.name "${name}" 与目录名 "${dirName}" 不一致` };
  }
  const version = raw['version'];
  if (typeof version !== 'string' || version.trim() === '') {
    return { ok: false, error: 'manifest.version 必须是非空字符串' };
  }
  const rawPerms = raw['permissions'];
  let permissions: PluginManifest['permissions'];
  if (rawPerms !== undefined) {
    if (!isPlainObject(rawPerms)) return { ok: false, error: 'manifest.permissions 必须是对象' };
    for (const k of Object.keys(rawPerms)) {
      if (!PERMISSION_KEYS.has(k)) return { ok: false, error: `manifest.permissions 未知字段 "${k}"` };
    }
    const perms: NonNullable<PluginManifest['permissions']> = {};
    const tools = rawPerms['tools'];
    if (tools !== undefined) {
      if (tools === true) {
        perms.tools = true;
      } else if (Array.isArray(tools) && tools.every((t) => typeof t === 'string' && TOOL_NAME_PATTERN.test(t))) {
        perms.tools = [...tools];
      } else {
        return {
          ok: false,
          error: 'manifest.permissions.tools 必须是 true 或工具名数组（每个名字匹配 ^[a-z0-9_]+$）',
        };
      }
    }
    const events = rawPerms['events'];
    if (events !== undefined) {
      const valid =
        Array.isArray(events) &&
        events.every(
          (e) => typeof e === 'string' && (e === '*' || (KNOWN_EVENT_TYPES as readonly string[]).includes(e)),
        );
      if (!valid) {
        return {
          ok: false,
          error: `manifest.permissions.events 必须是事件类型数组（${KNOWN_EVENT_TYPES.join('/')} 或 '*'）`,
        };
      }
      perms.events = [...(events as string[])];
    }
    const cron = rawPerms['cron'];
    if (cron !== undefined) {
      if (cron !== true) return { ok: false, error: 'manifest.permissions.cron 必须是 true' };
      perms.cron = true;
    }
    permissions = perms;
  }
  return { ok: true, manifest: { name, version, ...(permissions !== undefined ? { permissions } : {}) } };
}

/** 扫描出的插件来源（只读目录，未执行任何插件代码） */
export interface PluginSource {
  /** 目录名（装载身份） */
  name: string;
  dir: string;
  /** 校验通过才有；null = 缺失/非法（error 给原因） */
  manifest: PluginManifest | null;
  error?: string;
}

/** 目录扫描：每个子目录一个插件；散落文件不是插件；目录不可读抛错（调用方收口为告警） */
export function scanPluginSources(root: string): PluginSource[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const sources: PluginSource[] = [];
  for (const entry of entries) {
    const dir = join(root, entry.name);
    if (!entry.isDirectory()) continue; // 散落文件不是插件
    if (!existsSync(join(dir, 'manifest.json'))) {
      sources.push({ name: entry.name, dir, manifest: null, error: '缺少 manifest.json' });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch (e) {
      sources.push({ name: entry.name, dir, manifest: null, error: `manifest.json 解析失败: ${(e as Error).message}` });
      continue;
    }
    const v = validatePluginManifest(raw, entry.name);
    sources.push(
      v.ok
        ? { name: entry.name, dir, manifest: v.manifest }
        : { name: entry.name, dir, manifest: null, error: v.error },
    );
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 动态导入插件模块（ESM）：index.js 默认导出 = definePlugin({...})。
 * 缺文件/默认导出不合法/name 与 manifest 不一致 → PluginError；语法错误原样抛出
 * （调用方收口为「跳过 + 告警」，单插件失败不拖垮装载批次）。
 */
export async function importPluginModule(dir: string, manifestName: string): Promise<PluginModule> {
  const entry = join(dir, 'index.js');
  if (!existsSync(entry)) {
    throw new PluginError('缺少 index.js 入口');
  }
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    throw new PluginError(`index.js 导入失败: ${(e as Error).message}`);
  }
  const def = (mod as { default?: unknown } | null | undefined)?.default;
  if (!isPlainObject(def) || typeof (def as { setup?: unknown }).setup !== 'function') {
    throw new PluginError('index.js 默认导出必须是 { name, setup } （definePlugin 形态）');
  }
  const name = (def as { name?: unknown }).name;
  if (typeof name !== 'string' || name !== manifestName) {
    throw new PluginError(`插件模块 name "${String(name)}" 与 manifest.name "${manifestName}" 不一致`);
  }
  return def as unknown as PluginModule;
}
