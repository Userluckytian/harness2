// 模型配置页样式表契约（node 环境读 CSS 文本；jsdom 不加载真实样式表，且 RTL 只能测类名存在、
// 测不到实际颜色 —— 与 ui-shared/test/chat-view-p01-css.test.ts、desktop/test/layout/frame-styles.test.ts
// 同一手法）。
//
// 回归背景：models.css 是暖纸时代（P6-B）写的，用的是 --fg / --border / --bg-elevated / --bg-input /
// --bg-disabled / --bg-subtle 这批**已废弃且从未定义**的变量，且都带硬编浅色回退值。Zai 双主题
// 迁移（styles.css Z-67）后这些变量不存在，var() 静默回退到浅色 → 深色主题下「新增提供方」表单
// 面板（.models-create/.models-card）连同输入框整片泛白。本测试锁死：一律走语义 token，且每个
// 引用的 --color-* 都必须真的在 styles.css 里有定义（防再次拼错 token 名）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modelsCss = readFileSync(
  fileURLToPath(new URL('../src/renderer/settings/models/models.css', import.meta.url)),
  'utf8',
);
const stylesCss = readFileSync(fileURLToPath(new URL('../src/styles/styles.css', import.meta.url)), 'utf8');

/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarations = modelsCss.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（选择器按字面量匹配；取首个匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

/** 取出「含某属性/值」的选择器块 —— 避开 `.a,\n.b { … }` 并列共享块先命中的问题 */
function blockWith(selector: string, mustContain: RegExp): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...declarations.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, 'g'))];
  const hit = blocks.find((b) => mustContain.test(b[1] ?? ''));
  expect(hit, `未找到含 ${mustContain} 的 ${selector} 块`).toBeDefined();
  return hit?.[1] ?? '';
}

describe('models.css 主题 token 契约（Zai 双主题）', () => {
  it('不得再使用暖纸时代的废弃变量（--fg/--border/--bg-*）——它们未定义，会静默回退浅色', () => {
    expect(declarations).not.toMatch(/var\(\s*--fg\b/);
    expect(declarations).not.toMatch(/var\(\s*--border\b/);
    expect(declarations).not.toMatch(/var\(\s*--bg-(elevated|input|disabled|subtle)\b/);
  });

  it('「新增提供方」表单面板：容器与输入框走语义 token（深色下不再泛白）', () => {
    // 表单外框（ModelsSettings 的 .models-create 包裹 + ProviderCard 的 .models-card）
    // .models-create 与 .models-card 共享块（padding/border-top），背景在后续独立块 —— 用属性定位。
    expect(blockWith('.models-create', /background:/)).toContain('var(--color-card)');
    expect(block('.models-create')).toContain('var(--color-border)');
    // 输入框：与 components/ui/input.tsx 同口径（bg-input / border-input-border / text-foreground）
    const input = block('.models-input');
    expect(input).toContain('var(--color-input)');
    expect(input).toContain('var(--color-input-border)');
    expect(input).toContain('color: inherit');
  });

  it('整页文字/行容器/按钮走语义 token，无浅色专用硬编色', () => {
    expect(block('.models-settings')).toContain('var(--color-foreground)');
    expect(block('.models-row')).toContain('var(--color-card)');
    expect(block('.models-row')).toContain('var(--color-border)');
    expect(block('.models-btn')).toContain('var(--color-card)');
    // 主按钮语义色（旧实现硬编暖橙 #a8621b，双主题下都不对）
    expect(block('.models-btn-primary')).toContain('var(--color-primary)');
    expect(block('.models-btn-primary')).toContain('var(--color-primary-foreground)');
  });

  it('状态/错误/成功色走语义 token，不硬编红绿', () => {
    expect(block('.models-dot-ok')).toContain('var(--color-success)');
    expect(block('.models-dot-bad')).toContain('var(--color-destructive)');
    expect(blockWith('.models-error', /--color-destructive/)).toContain('var(--color-destructive)');
    expect(block('.models-live')).toContain('var(--color-success)');
    expect(blockWith('.models-warnings', /--color-warning/)).toContain('var(--color-warning)');
  });

  it('声明里不出现十六进制色值字面量（色值只允许在 styles.css 的 L1/L2 层）', () => {
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('引用的每个 --color-* 都在 styles.css 里有定义（防拼错 token，如 --color-ring 之类）', () => {
    const used = new Set(
      [...declarations.matchAll(/var\(\s*(--color-[a-z0-9-]+)/g)]
        .map((m) => m[1])
        .filter((t): t is string => t !== undefined),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      // 在 styles.css 里以 `<token>:` 形式出现即视为已定义（:root / .theme-zai-* 三份之一即可）
      expect(stylesCss, `models.css 引用了未定义的 token：${token}`).toMatch(
        new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`),
      );
    }
  });
});
