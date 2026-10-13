// 代码查看器主题目录（Z10-7；对齐 refs-zcode.md:357 的 10 个代码主题选项）。
//
// 本模块**纯数据 + 纯函数**，不 import shiki（体积/异步都不该泄漏到设置页与纯逻辑测试）。
// id 与 shiki 内置主题名一一对应（`shiki/themes/<id>.mjs`），高亮器（./shiki-loader.ts）
// 按 id 动态 import 主题对象；主题**中文/英文标签**只在这里维护一处。
import type { CodeThemeId } from '../../shared/settings.js';

export type { CodeThemeId };

/** 主题明暗归属（决定它出现在「浅色代码主题」还是「深色代码主题」下拉） */
export type CodeThemeKind = 'light' | 'dark';

export interface CodeThemeOption {
  readonly id: CodeThemeId;
  /** 展示名（refs 的选项名；保留主题专有名词，不硬翻） */
  readonly label: string;
  readonly kind: CodeThemeKind;
}

/**
 * 10 个代码主题选项（顺序 = 设置卡下拉序）。
 * 名称取自 refs-zcode.md:357 列举（GitHub Light/Dark、Vitesse、Vitesse Dark、Minimal、
 * Minimal Dark、GitHub HC、Catppuccin Latte/Mocha 等），id = 对应 shiki 主题名。
 */
export const CODE_THEME_OPTIONS: readonly CodeThemeOption[] = Object.freeze([
  { id: 'github-light', label: 'GitHub Light', kind: 'light' },
  { id: 'github-dark', label: 'GitHub Dark', kind: 'dark' },
  { id: 'vitesse-light', label: 'Vitesse', kind: 'light' },
  { id: 'vitesse-dark', label: 'Vitesse Dark', kind: 'dark' },
  { id: 'min-light', label: 'Minimal', kind: 'light' },
  { id: 'min-dark', label: 'Minimal Dark', kind: 'dark' },
  { id: 'github-dark-high-contrast', label: 'GitHub 高对比', kind: 'dark' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', kind: 'light' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', kind: 'dark' },
  { id: 'one-dark-pro', label: 'One Dark Pro', kind: 'dark' },
]) as readonly CodeThemeOption[];

/** 默认浅色 / 深色代码主题（与桌面 normalizePreferences 缺省一致） */
export const DEFAULT_CODE_THEME_LIGHT: CodeThemeId = 'github-light';
export const DEFAULT_CODE_THEME_DARK: CodeThemeId = 'github-dark';

const CODE_THEME_IDS: ReadonlySet<string> = new Set(CODE_THEME_OPTIONS.map((o) => o.id));

/** 类型守卫：未知字符串是否合法代码主题 id（读偏好时校验，非法即回落默认） */
export function isCodeThemeId(value: unknown): value is CodeThemeId {
  return typeof value === 'string' && CODE_THEME_IDS.has(value);
}

/** 主题展示名（未知 id 原样返回，不摆假文案） */
export function codeThemeLabel(id: CodeThemeId): string {
  return CODE_THEME_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** 主题明暗归属（未知 id 归 light，不抛错） */
export function codeThemeKind(id: CodeThemeId): CodeThemeKind {
  return CODE_THEME_OPTIONS.find((o) => o.id === id)?.kind ?? 'light';
}

/** 浅色下拉可选（kind === 'light'） */
export function codeThemeOptionsOf(kind: CodeThemeKind): readonly CodeThemeOption[] {
  return CODE_THEME_OPTIONS.filter((o) => o.kind === kind);
}

/** 代码字号范围（Z-90：12–20，默认 13） */
export const CODE_FONT_SIZE_MIN = 12;
export const CODE_FONT_SIZE_MAX = 20;
export const CODE_FONT_SIZE_DEFAULT = 13;

/** 钳制进 [12, 20]（非整数就近取整） */
export function clampCodeFontSize(px: number): number {
  return Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, Math.round(px)));
}

/**
 * 高亮器支持的语言 id（与 shiki-loader 的动态 import 清单**必须**同集合；不同集合见下）。
 * 未命中 → 查看器按**纯文本**渲染（不假装高亮，也不因未知语言抛错）。
 */
export const CODE_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'jsonc',
  'markdown',
  'python',
  'bash',
  'css',
  'html',
  'yaml',
  'toml',
  'sql',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const CODE_LANGUAGE_SET: ReadonlySet<string> = new Set(CODE_LANGUAGES);

/** 文件扩展名 → 语言 id（无扩展名/未知 → null = 纯文本渲染） */
const EXT_LANGUAGE: Readonly<Record<string, CodeLanguage>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
};

/** 由路径折出高亮语言（只取 basename 的扩展名；未知 → null） */
export function detectCodeLanguage(path: string): CodeLanguage | null {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXT_LANGUAGE[ext];
  return lang !== undefined && CODE_LANGUAGE_SET.has(lang) ? lang : null;
}
