// D-22 / D-24 的样式证据（node 环境读 CSS 文本）：
//   D-24 静默只改滑块颜色（transparent 一对），预留宽度由滚动区自身的
//        scrollbar-gutter: stable 承担 —— 显隐滑块不重排；
//   D-22 收起/淘入动画存在，且降动效（媒体查询 + 状态类）两条路径都禁用。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../src/renderer/sidebar/sidebar.css', import.meta.url)), 'utf8');
/** 去掉注释：样式表里的散文会提到属性名，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（选择器按字面量匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('D-24 静默只改颜色，不改布局', () => {
  it('.h2-sidebar-quiet 把滑块-悬停一对都重绑为 transparent', () => {
    const rules = block('.h2-sidebar-quiet')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .sort();
    expect(rules).toEqual(['--h2-sidebar-thumb: transparent', '--h2-sidebar-thumb-hover: transparent'].sort());
  });

  it('预留宽度在滚动区（.h2-sidebar-list）上，静默类里不出现 scrollbar-gutter', () => {
    expect(block('.h2-sidebar-list')).toContain('scrollbar-gutter: stable');
    expect(block('.h2-sidebar-quiet')).not.toContain('scrollbar-gutter');
  });

  it('滚动容器是 overflow-y: auto（未溢出就没有滚动条）', () => {
    expect(block('.h2-sidebar-list')).toContain('overflow-y: auto');
  });
});

describe('D-22 / D-16 收起动画样式', () => {
  it('淡出与淘入动画都在（150ms 量级）', () => {
    expect(block('.h2-sidebar-fading > *')).toContain('transition: opacity 150ms');
    expect(declarations).toContain('.h2-sidebar-rail-in .h2-sidebar-toggle');
    expect(declarations).toContain('@keyframes h2-sidebar-rail-in');
    expect(declarations).toMatch(/@keyframes h2-sidebar-rail-in\s*\{[^}]*translateX\(49px\)/);
  });

  it('降动效媒体查询把过渡与动画都关掉', () => {
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(declarations);
    expect(reduce).not.toBeNull();
    const body = reduce?.[1] ?? '';
    expect(body).toContain('transition: none');
    expect(body).toContain('animation: none');
    expect(body).toContain('.h2-sidebar-fading > *');
    expect(body).toContain('.h2-sidebar-rail-in');
  });

  it('降动效状态类同样禁用（hook 侧分支与媒体查询互为兜底）', () => {
    const cls = /\.h2-sidebar-reduced-motion[^{]*\{([^{}]*)\}/.exec(declarations);
    expect(cls).not.toBeNull();
    expect(cls?.[1]).toContain('transition: none');
    expect(cls?.[1]).toContain('animation: none');
  });

  it('轨道几何：36px 控件盒 + 56px 轨道内边距', () => {
    expect(block('.h2-sidebar-rail')).toContain('padding: 18px 10px 6px');
    expect(block('.h2-sidebar-rail .h2-sidebar-toggle')).toContain('width: 36px');
  });
});
