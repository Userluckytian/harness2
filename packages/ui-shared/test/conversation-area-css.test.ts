// 对话区（会话态）样式证据（node 环境读 CSS 文本；jsdom 测不了像素断点）。
// 规格来源：docs/ai-framework/plans/2026-10-13-conversation-area-spec.md
//   * G14 内容列宽 —— ZCode conversationLayout.ts:3-9 / ConversationTimeline.tsx:1803-1930；
//   * G15/G16 轮次分隔与间距 —— ZCode ConversationTurnGroup.tsx:1302-1310；
//   * G5 空态水印定位 —— ZCode ConversationDraftEmptyState.tsx:171-185（位置为**推断值**）。
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

/** 取出所有 `@container conversation (min-width: Npx) { … }` 的块体（可能同名多块） */
function containerBlocks(px: number): string[] {
  const re = new RegExp(`@container conversation \\(min-width: ${px}px\\)\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
  return [...declarations.matchAll(re)].map((m) => m[1] ?? '');
}

describe('G14 内容列宽：消息行与输入区共用同一列宽约束', () => {
  it('.conversation-seat 是命名断点容器（conversation），消息与 composer 的共同祖先', () => {
    const seat = block('.conversation-seat');
    expect(seat).toContain('container-type: inline-size');
    expect(seat).toContain('container-name: conversation');
  });

  it('≥768px：@md:px-6 = 24px，消息区与 composer 同步', () => {
    const bodies = containerBlocks(768);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.join('\n');
    expect(body).toContain('.messages');
    expect(body).toContain('.composer');
    expect(body).toMatch(/padding-inline:\s*24px/);
  });

  it('≥864px：列宽 min(calc(100% - 6rem), 56rem) → 留白 max(3rem, (100% - 56rem)/2) + 24px', () => {
    const bodies = containerBlocks(864).filter((b) => b.includes('.messages'));
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.join('\n');
    expect(body).toContain('.composer');
    expect(body).toContain('calc(max(3rem, (100% - 56rem) / 2) + 24px)');
  });

  it('≥1280px：列宽 min(calc(100% - 24rem), 72rem) → 留白 max(12rem, (100% - 72rem)/2) + 24px', () => {
    const bodies = containerBlocks(1280);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.join('\n');
    expect(body).toContain('.messages');
    expect(body).toContain('.composer');
    expect(body).toContain('calc(max(12rem, (100% - 72rem) / 2) + 24px)');
  });
});

describe('G15/G16 轮次分隔与间距', () => {
  it('.messages：轮内 gap-5 = 20px；行内 padding 16px 起（@md 24px 由断点覆盖）', () => {
    const rules = block('.messages');
    expect(rules).toMatch(/gap:\s*20px/);
    expect(rules).toMatch(/padding-inline:\s*16px/);
    expect(rules).toMatch(/padding-top:\s*0/);
    // D-46 预留声明仍在（唯一来源）
    expect(rules).toContain('padding-bottom: calc(var(--composer-inset, 0px) + 16px)');
  });

  it('.turn-header：纯留白 padding-top 36px，**无分隔线**（轮间 = 36 + 20×2 = 76px）', () => {
    const rules = block('.turn-header');
    expect(rules).toMatch(/padding-top:\s*36px/);
    expect(rules).not.toMatch(/border-top:/);
    expect(rules).not.toMatch(/margin-top:/);
  });
});

describe('G5 空态水印定位（ZCode 绝对定位背景水印；位置为推断值，待真机复核）', () => {
  it('.h2-empty：relative + isolation + 内容列 max-w-2xl（672px）', () => {
    const rules = block('.h2-empty');
    expect(rules).toMatch(/position:\s*relative/);
    expect(rules).toMatch(/isolation:\s*isolate/);
    expect(rules).toMatch(/max-width:\s*672px/);
  });

  it('.h2-empty-mark：绝对定位居中 + 上移 40px + 400×320（aspect 5/4）+ pointer-events:none', () => {
    const rules = block('.h2-empty-mark');
    expect(rules).toMatch(/position:\s*absolute/);
    expect(rules).toMatch(/left:\s*50%/);
    expect(rules).toMatch(/top:\s*50%/);
    expect(rules).toMatch(/width:\s*min\(72vw, 25rem\)/);
    expect(rules).toMatch(/aspect-ratio:\s*5\s*\/\s*4/);
    expect(rules).toMatch(/margin-top:\s*-40px/);
    expect(rules).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/);
    expect(rules).toMatch(/pointer-events:\s*none/);
    expect(rules).toContain('var(--color-foreground-subtlest)');
  });
});
