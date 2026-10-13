// P0-1 shell.css 权威声明证据（node 环境读 CSS 文本；jsdom 不加载真实样式表，
// 且样式类断言在 RTL 里只能测类名存在，测不到实际样式效果 —— 与 desktop
// conversation/turn-rail-css.test.ts 同一手法）：
//   1. 用户消息右对齐 + bg-secondary + px-4 py-3 + 圆角（ZCode MessageContent message.tsx:114,127）；
//   2. 助手消息无气泡（无背景/无内边距，正常流）；
//   3. 轮次头无文案（G15 起轮次分隔 = 纯留白 padding-top，不再有 border 分隔线）；
//   4. 动作行 hover 显现（opacity 0 → hover/focus-within 1）；
//   5. composer 占位层：subtlest 语义色 + pointer-events:none（点击穿透）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)), 'utf8');
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（选择器按字面量匹配；取首个匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

/** 取出「独立成行且含某属性」的选择器块（避开 `.a,\n.b { … }` 这种并列共享块先命中的问题） */
function blockWith(selector: string, mustContain: RegExp): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...declarations.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, 'g'))];
  const hit = blocks.find((b) => mustContain.test(b[1] ?? ''));
  expect(hit, `未找到含 ${mustContain} 的 ${selector} 块`).toBeDefined();
  return hit?.[1] ?? '';
}

describe('P0-1 消息气泡的样式声明（对齐 ZCode message.tsx）', () => {
  it('.bubble-user：右对齐 + bg-secondary + px-4 py-3 + 圆角', () => {
    const rules = block('.bubble-user');
    expect(rules).toMatch(/align-self:\s*flex-end/);
    expect(rules).toContain('var(--color-secondary)');
    expect(rules).toMatch(/border-radius:/);
    expect(rules).toMatch(/padding:\s*12px 16px/);
  });

  it('.bubble-assistant：无气泡（transparent + padding 0，正常流占满宽）', () => {
    // 注意：`.bubble-user, .bubble-assistant { … }` 是共享块（max-width/white-space），
    // 助手专属「无气泡」声明在后面的独立块里 —— 用属性内容定位正确的块。
    const rules = blockWith('.bubble-assistant', /background:/);
    expect(rules).toMatch(/background:\s*transparent/);
    expect(rules).toMatch(/padding:\s*0/);
    expect(rules).toMatch(/align-self:\s*stretch/);
  });

  it('角色标签样式已删除（.role 规则不存在；曾有 .bubble-* .role 字号/颜色块）', () => {
    expect(declarations).not.toMatch(/\.role\s*\{/);
    expect(declarations).not.toMatch(/\.bubble-\w+\s+\.role/);
  });

  it('.turn-header：无文案（无 color/font-size 文字样式；轮次分隔 = 纯留白，无分隔线）', () => {
    // G15（ZCode ConversationTurnGroup.tsx:1302-1310）：轮次之间只有 pt-14 留白，**无 border**。
    // 本仓 turn-header 是零内容标记行：padding-top 36px（+ 前后 gap-5 20px = 轮间 76px）。
    const rules = block('.turn-header');
    expect(rules).not.toMatch(/font-size:/);
    expect(rules).not.toMatch(/color:/);
    expect(rules).not.toMatch(/border-top:/); // 去掉旧分隔线
    expect(rules).toMatch(/padding-top:\s*36px/);
  });

  it('.message-actions：默认隐藏，hover / 键盘聚焦显现（ZCode 完成态动作行口径）', () => {
    expect(block('.message-actions')).toMatch(/opacity:\s*0/);
    // 显现规则：一个以 opacity: 1 收尾的块，其选择器同时含 :hover 与 :focus-within（逗号并列）
    const reveal = declarations.match(/([^{}]*\.message-actions[^{}]*)\{([^{}]*)\}/g) ?? [];
    const shown = reveal.find((r) => /opacity:\s*1/.test(r));
    expect(shown, '未找到 opacity:1 的动作行显现规则').toBeDefined();
    expect(shown).toContain('.bubble-assistant:hover');
    expect(shown).toContain('.bubble-assistant:focus-within');
  });
});

describe('P0-1 composer 占位层样式声明', () => {
  it('.composer-placeholder：subtlest 语义色 + 点击穿透 + 绝对定位叠在编辑器上', () => {
    const rules = block('.composer-placeholder');
    expect(rules).toContain('var(--color-foreground-subtlest)'); // ZCode placeholder 色，语义 token
    expect(rules).toMatch(/pointer-events:\s*none/);
    expect(rules).toMatch(/position:\s*absolute/);
    expect(block('.composer-editor-wrap')).toMatch(/position:\s*relative/); // 定位锚
  });
});
