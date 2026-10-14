// Z-97（T4c）工具行运行态「去旋转 spinner → 文案扫光」的样式权威声明证据。
//   node 环境读 styles.css 文本（jsdom 不加载真实样式表、测不了 keyframes/背景裁切）。
//   规格出处：docs/refs/refs-zcode.md Z-97「工具行刻意不用旋转 spinner」原注 +
//   ZCode ToolLayout.tsx:138-147（运行态 = kindLabel 文案扫光 animated-gradient-text，图标静态）。
//   手法与 chat-view-p01-css.test.ts / conversation-area-css.test.ts 同源（去注释后正则取块）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/styles.css', import.meta.url)), 'utf8');
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（首个匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

/** 取出「块体命中某正则」的某选择器块（避开同名多块：正常块 vs prefers-reduced-motion 降级块） */
function blockWith(selector: string, mustContain: RegExp): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...declarations.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, 'g'))];
  const hit = blocks.find((b) => mustContain.test(b[1] ?? ''));
  expect(hit, `未找到含 ${mustContain} 的 ${selector} 块`).toBeDefined();
  return hit?.[1] ?? '';
}

describe('Z-97（T4c）.tool-running-shimmer：运行态文案扫光（只动 background-position）', () => {
  it('有独立 keyframes，动画属性只出现 background-position（合成器友好，不触发布局/全页重绘）', () => {
    // keyframes 名存在，且帧内只声明 background-position（禁止 top/left/width/transform 之类）
    const kf = declarations.match(/@keyframes\s+harness-tool-running-shimmer\s*\{([\s\S]*?)\n\}/);
    expect(kf, '未找到 @keyframes harness-tool-running-shimmer').not.toBeNull();
    const body = kf?.[1] ?? '';
    expect(body).toMatch(/background-position:/);
    expect(body).not.toMatch(/transform:/);
    expect(body).not.toMatch(/\btop\b|\bleft\b|width:/);
  });

  it('主块：背景裁切文字（background-clip:text + color:transparent）+ 只引语义 token + 无限扫光', () => {
    const rules = blockWith('.tool-running-shimmer', /animation:/);
    // 背景裁切文字（扫光实现基础）
    expect(rules).toMatch(/background-clip:\s*text/);
    expect(rules).toMatch(/color:\s*transparent/);
    // 动画只驱动 background-position
    expect(rules).toMatch(/animation:\s*harness-tool-running-shimmer/);
    // 颜色只用既有语义 token，不出现一次性色值（无 #hex / rgb）
    expect(rules).toMatch(/var\(--color-foreground\)/);
    expect(rules).toMatch(/var\(--color-foreground-subtlest\)/);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\brgba?\(/);
  });

  it('prefers-reduced-motion:reduce 降级为纯静态（animation:none + 还原 background/color）', () => {
    // 降级块：命中 animation: none（区别于主块的 animation: harness-…）
    const reduce = blockWith('.tool-running-shimmer', /animation:\s*none/);
    expect(reduce).toMatch(/animation:\s*none/);
    // 背景裁切撤除 + 颜色还原为继承值（否则减压模式下文字仍是透明的 = 看不见）
    expect(reduce).toMatch(/background-image:\s*none/);
    expect(reduce).toMatch(/color:\s*inherit/);
  });

  it('降级块确实包在 @media (prefers-reduced-motion: reduce) 内', () => {
    // 全表可能有多个 prefers-reduced-motion 块（Z-64 全局降级块在前）——按内容定位含本类的那个
    const medias = [...declarations.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)];
    expect(medias.length).toBeGreaterThan(0);
    const hit = medias.find((m) => (m[1] ?? '').includes('.tool-running-shimmer'));
    expect(hit, '未找到含 .tool-running-shimmer 降级的 prefers-reduced-motion 块').toBeDefined();
  });
});

describe('Z-97（T4c）别改 Z-92 既有 .reasoning-shimmer-text（扫光手法同源但独立成类）', () => {
  it('.reasoning-shimmer-text 仍在、仍用 harness-reasoning-shimmer（未被工具扫光替换/污染）', () => {
    const rules = block('.reasoning-shimmer-text');
    expect(rules).toMatch(/animation:\s*harness-reasoning-shimmer/);
    expect(rules).toMatch(/background-clip:\s*text/);
  });

  it('两个 keyframes 各自独立（工具扫光没复用思考行的动画名，反之亦然）', () => {
    expect(declarations).toMatch(/@keyframes\s+harness-reasoning-shimmer\s*\{/);
    expect(declarations).toMatch(/@keyframes\s+harness-tool-running-shimmer\s*\{/);
    // 工具扫光主块引用的是自己的 keyframes，不是思考行的
    const toolRules = blockWith('.tool-running-shimmer', /animation:/);
    expect(toolRules).not.toMatch(/harness-reasoning-shimmer/);
  });
});
