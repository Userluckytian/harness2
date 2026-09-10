// 配置加载：全局 ~/.harness2/config.json + 项目 <root>/.harness2/config.json。
// 深合并（对象递归、数组/标量项目覆盖全局）→ ${VAR} 展开（缺失 env 保留原样并告警，
// envKey 字段是变量名引用、不做展开）→ schema 校验。
// 红线：解析/校验错误消息出口前经 redactSecrets（config 本不该有密钥，但错误消息可能回显文件内容）。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parseConfig, type ConfigParseResult } from './schema.js';
import { redactSecrets } from './redact.js';

/** 全局配置目录名 */
export const HARNESS_DIR = '.harness2';
export const CONFIG_FILE_NAME = 'config.json';
export const AUTH_FILE_NAME = 'auth.json';

/** 一组具体配置路径（默认路径可按 root/home 重定向，测试注入用） */
export interface ConfigPaths {
  globalConfig: string;
  projectConfig: string;
  globalAuth: string;
}

/** 默认路径：全局挂 home，项目挂 root（缺省 = process.cwd()） */
export function defaultConfigPaths(root?: string, home?: string): ConfigPaths {
  const homeDir = home ?? homedir();
  const projectRoot = root ?? process.cwd();
  return {
    globalConfig: join(homeDir, HARNESS_DIR, CONFIG_FILE_NAME),
    projectConfig: join(projectRoot, HARNESS_DIR, CONFIG_FILE_NAME),
    globalAuth: join(homeDir, HARNESS_DIR, AUTH_FILE_NAME),
  };
}

export interface LoadConfigOptions {
  /** 项目根目录（决定 projectConfig 路径），缺省 process.cwd() */
  root?: string;
  /** 覆盖全局配置文件路径（测试注入） */
  globalPath?: string;
  /** 覆盖项目配置文件路径（测试注入） */
  projectPath?: string;
  /** ${VAR} 展开用的环境变量表（缺省 process.env；测试注入避免环境污染） */
  env?: Record<string, string | undefined>;
  /** home 目录（仅影响默认路径推导，显式传 globalPath 时无意义） */
  home?: string;
}

export interface LoadedConfig extends ConfigParseResult {
  /** 两个文件是否实际存在（存在但为空对象也算） */
  sources: { global: boolean; project: boolean };
  /** 展开前的合并形态（诊断用；已脱敏不了——不含密钥，config 契约上没有 key 字段） */
  mergedRaw: unknown;
}

/** 单文件解析：区分「文件不存在」与「存在但解析失败」；JSONC 宽松解析（允许注释/尾逗号） */
function readFileJson(path: string, errors: string[]): { existed: boolean; data?: unknown } {
  if (!existsSync(path)) return { existed: false };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    errors.push(`${path} 读取失败: ${redactSecrets((e as Error).message)}`);
    return { existed: true };
  }
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0 || parsed === undefined) {
    // 只报位置与偏移，不回显文件内容（防密钥泄漏）
    const first = parseErrors[0];
    const where = first ? `（偏移 ${first.offset} 处解析失败）` : '';
    errors.push(`${path} 不是合法的 JSON/JSONC${where}`);
    return { existed: true };
  }
  return { existed: true, data: parsed };
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 递归展开字符串叶子中的 ${VAR}：
 *   - env 中存在 → 替换为值（可一次替换多个/多处）；
 *   - env 中缺失 → 保留 `${VAR}` 原样并记告警（不静默改写成空串）。
 * envKey 字段是"环境变量名引用"而非值，跳过展开。
 */
export function expandEnvVars(
  node: unknown,
  env: Record<string, string | undefined>,
  warnings: string[],
  path = 'config',
): unknown {
  if (typeof node === 'string') {
    if (path.endsWith('.envKey')) return node; // envKey 是"变量名引用"而非值，不做展开
    return node.replace(VAR_PATTERN, (whole, name: string) => {
      const value = env[name];
      if (value === undefined) {
        warnings.push(`${path}: 环境变量 ${name} 未设置，已保留 ${whole} 原样`);
        return whole;
      }
      return value;
    });
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => expandEnvVars(v, env, warnings, `${path}[${i}]`));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = expandEnvVars(v, env, warnings, path === 'config' ? k : `${path}.${k}`);
    }
    return out;
  }
  return node;
}

/** 深合并：对象递归合并；数组/标量/null 以 project（后者）为准 */
export function deepMerge(global: unknown, project: unknown): unknown {
  if (global === undefined) return project;
  if (project === undefined) return global;
  if (
    typeof global === 'object' &&
    global !== null &&
    !Array.isArray(global) &&
    typeof project === 'object' &&
    project !== null &&
    !Array.isArray(project)
  ) {
    const out: Record<string, unknown> = { ...(global as Record<string, unknown>) };
    for (const [k, v] of Object.entries(project as Record<string, unknown>)) {
      const base = (global as Record<string, unknown>)[k];
      out[k] = deepMerge(base, v);
    }
    return out;
  }
  return project;
}

/**
 * 两级加载：读全局与项目 config.json（均可缺）→ 深合并 → ${VAR} 展开 → 校验。
 * 两文件都不存在：config 为 null + 一条错误（「未找到任何配置文件」——调用方可按需降级）。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const paths = defaultConfigPaths(options.root, options.home);
  const globalPath = options.globalPath ?? paths.globalConfig;
  const projectPath = options.projectPath ?? paths.projectConfig;
  const env = options.env ?? process.env;

  const errors: string[] = [];
  const globalRead = readFileJson(globalPath, errors);
  const projectRead = readFileJson(projectPath, errors);
  const globalRaw = globalRead.data;
  const projectRaw = projectRead.data;
  const sources = { global: globalRead.existed, project: projectRead.existed };

  if (!globalRead.existed && !projectRead.existed) {
    return {
      config: null,
      errors: [...errors, `未找到任何配置文件（全局 ${globalPath} 与项目 ${projectPath} 均不存在）`],
      warnings: [],
      sources,
      mergedRaw: undefined,
    };
  }
  if (errors.length > 0) {
    // 存在的文件解析失败即致命：不带着半份数据继续校验
    return { config: null, errors, warnings: [], sources, mergedRaw: undefined };
  }

  const merged = deepMerge(globalRaw, projectRaw);
  const warnings: string[] = [];
  const expanded = expandEnvVars(merged, env, warnings);
  const result = parseConfig(expanded); // schema 层出口已统一脱敏
  return {
    config: result.config,
    errors: [...errors, ...result.errors],
    warnings: [...warnings, ...result.warnings],
    sources,
    mergedRaw: merged,
  };
}
