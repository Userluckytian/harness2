// 代码高亮器（Z10-7）：shiki（JS 正则引擎，纯本地离线，无 WASM/CDN）的**懒加载单例**。
//
// 选型（报告详述）：shiki@4.5.0 —— 内置主题名与本任务 refs 规格的 10 选项一一对应
// （github-light/dark、vitesse-light/dark、min-light/dark、github-dark-high-contrast、
// catppuccin-latte/mocha、one-dark），且 `engine/javascript` 是纯 JS 正则引擎：**离线可用、
// 浏览器/Node 同源、无需 WASM 文件**。
//
// 为什么全部走 **动态 import**：
//   1. ui-shared 是**双构建**（ESM 给 vite 壳 / CJS 给 Electron main·preload）。shiki 是
//      ESM-only，静态 `import` 会让 CJS 产物触发 TS1479；`await import(...)` 在 CJS 产物里
//      原样保留（Node 动态 import 可加载 ESM），两构建都通过；
//   2. 顺带把高亮器拆成**懒加载 chunk**：不打开代码查看器/预览卡就不下载 shiki。
//
// 语言集与 ./code-theme.ts 的 CODE_LANGUAGES **必须同集合**（测试钉住）；未命中的语言由
// 查看器按纯文本渲染，不经过这里。
import type { CodeThemeId } from '../../shared/settings.js';

/** 单条高亮 token（shiki ThemedToken 的结构子集） */
export interface CodeToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

/** codeToTokens 的结果（行 × token；bg/fg 为主题底色/前景） */
export interface CodeTokensResult {
  readonly tokens: readonly (readonly CodeToken[])[];
  readonly bg?: string;
  readonly fg?: string;
}

/** 高亮器能力面（shiki HighlighterCore 的结构子集；不引 shiki 类型以保 CJS 构建干净） */
export interface CodeHighlighter {
  codeToTokens(code: string, options: { lang: string; theme: string }): CodeTokensResult;
}

/** 已装载语言 id（与 code-theme 的 CODE_LANGUAGES 同集合；导出供测试钉住） */
export const LOADED_LANGUAGES = [
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

/** 已装载主题 id（与 code-theme 的 CODE_THEME_OPTIONS 同集合；导出供测试钉住） */
export const LOADED_THEMES = [
  'github-light',
  'github-dark',
  'vitesse-light',
  'vitesse-dark',
  'min-light',
  'min-dark',
  'github-dark-high-contrast',
  'catppuccin-latte',
  'catppuccin-mocha',
  'one-dark-pro',
] as const satisfies readonly CodeThemeId[];

let highlighterPromise: Promise<CodeHighlighter> | null = null;

/** 建高亮器（首次调用做全部动态 import；后续复用同一 Promise） */
function createHighlighter(): Promise<CodeHighlighter> {
  return (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    const [
      githubLight,
      githubDark,
      vitesseLight,
      vitesseDark,
      minLight,
      minDark,
      githubHc,
      catppuccinLatte,
      catppuccinMocha,
      oneDarkPro,
    ] = await Promise.all([
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
      import('shiki/themes/vitesse-light.mjs'),
      import('shiki/themes/vitesse-dark.mjs'),
      import('shiki/themes/min-light.mjs'),
      import('shiki/themes/min-dark.mjs'),
      import('shiki/themes/github-dark-high-contrast.mjs'),
      import('shiki/themes/catppuccin-latte.mjs'),
      import('shiki/themes/catppuccin-mocha.mjs'),
      import('shiki/themes/one-dark-pro.mjs'),
    ]);
    const [
      typescript,
      javascript,
      tsx,
      jsx,
      json,
      jsonc,
      markdown,
      python,
      bash,
      css,
      html,
      yaml,
      toml,
      sql,
      go,
      rust,
      java,
      c,
      cpp,
      csharp,
      ruby,
      php,
    ] = await Promise.all([
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/jsonc.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/toml.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/rust.mjs'),
      import('shiki/langs/java.mjs'),
      import('shiki/langs/c.mjs'),
      import('shiki/langs/cpp.mjs'),
      import('shiki/langs/csharp.mjs'),
      import('shiki/langs/ruby.mjs'),
      import('shiki/langs/php.mjs'),
    ]);
    return createHighlighterCore({
      themes: [
        githubLight.default,
        githubDark.default,
        vitesseLight.default,
        vitesseDark.default,
        minLight.default,
        minDark.default,
        githubHc.default,
        catppuccinLatte.default,
        catppuccinMocha.default,
        oneDarkPro.default,
      ],
      langs: [
        typescript.default,
        javascript.default,
        tsx.default,
        jsx.default,
        json.default,
        jsonc.default,
        markdown.default,
        python.default,
        bash.default,
        css.default,
        html.default,
        yaml.default,
        toml.default,
        sql.default,
        go.default,
        rust.default,
        java.default,
        c.default,
        cpp.default,
        csharp.default,
        ruby.default,
        php.default,
      ],
      engine: createJavaScriptRegexEngine(),
    }) as unknown as CodeHighlighter;
  })();
}

/** 取高亮器（懒加载单例）。任何调用方都复用同一份，避免重复编译语法。 */
export function loadCodeHighlighter(): Promise<CodeHighlighter> {
  if (highlighterPromise === null) highlighterPromise = createHighlighter();
  return highlighterPromise;
}

/** 测试用：丢弃单例（不用于生产） */
export function resetCodeHighlighterForTests(): void {
  highlighterPromise = null;
}
