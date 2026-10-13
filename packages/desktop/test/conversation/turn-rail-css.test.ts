// Z2-09b 轮次导航的样式证据（node 环境读 CSS 文本；jsdom 测不了像素断点）：
//   显隐双保险的 CSS 侧 —— .turn-rail 默认隐藏，@container conversation (min-width: 864px) 展开；
//   .conversation-seat 是断点容器（G14：container-name: conversation，供消息区与 composer 共用）。
// 阈值常量（2 轮 / 864px）的 JS 侧钉在 ui-shared turn-navigator.test.tsx（turnNavigatorVisible）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../../ui-shared/src/styles/shell.css', import.meta.url)), 'utf8');
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（选择器按字面量匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('轮次导航 rail（Z-17：≥2 轮且容器 ≥864px，左侧细条）', () => {
  it('.turn-rail 默认隐藏（<864px 的按需默认态）', () => {
    const rules = block('.turn-rail');
    expect(rules).toContain('display: none');
    expect(rules).toContain('position: absolute');
  });

  it('.conversation-seat 是 @container 断点容器（inline-size + name: conversation）', () => {
    expect(declarations).toMatch(/@container conversation \(min-width: 864px\)/);
    const seat = block('.conversation-seat');
    expect(seat).toContain('container-type: inline-size');
    expect(seat).toContain('container-name: conversation');
    expect(seat).toContain('position: relative');
  });

  it('.chat 只作 rail 定位上下文（断点容器已上移到 .conversation-seat）', () => {
    const chatBlocks = declarations.match(/\.chat\s*\{[^{}]*\}/g) ?? [];
    const railCtx = chatBlocks.find((b) => b.includes('position: relative'));
    expect(railCtx, '.chat 缺 rail 定位上下文').toBeDefined();
    expect(railCtx).not.toContain('container-type');
  });

  it('≥864px 断点内：rail 展开为 flex', () => {
    const query = /@container conversation \(min-width: 864px\)\s*\{([\s\S]*?)\n\}/.exec(declarations);
    expect(query).not.toBeNull();
    const body = query?.[1] ?? '';
    expect(body).toContain('.turn-rail');
    expect(body).toMatch(/display:\s*flex/);
  });
});
