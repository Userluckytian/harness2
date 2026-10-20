// D-22 / D-24 的样式证据（node 环境读 CSS 文本）：
//   D-24 静默只改滑块颜色（transparent 一对），预留宽度由滚动区自身的
//        scrollbar-gutter: stable 承担 —— 显隐滑块不重排；
//   D-22 收起/淘入动画存在，且降动效（媒体查询 + 状态类）两条路径都禁用。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P8：样式表本身也是「三壳共享的呈现层」，已下沉 @harness2/ui-shared（web 壳同一份）；
// 这里读**源文件**（不依赖 dist 产物），断言逐条不变。
const css = readFileSync(fileURLToPath(new URL('../../../ui-shared/src/styles/sidebar.css', import.meta.url)), 'utf8');
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

describe('D-22 / D-16 折叠样式（U2 批D / D9 后：Z-06 无轨道，轨道时代死 CSS 已删）', () => {
  it('轨道几何 / 品牌行 / 淘入动画 CSS 不存在（折叠 = 4px 容器 + opacity-0，无 DOM 可套）', () => {
    expect(declarations).not.toContain('.h2-sidebar-fading');
    expect(declarations).not.toContain('.h2-sidebar-rail-in');
    expect(declarations).not.toContain('.h2-sidebar-rail .h2-sidebar-toggle');
    expect(declarations).not.toContain('.h2-sidebar-brand-row');
    expect(declarations).not.toContain('@keyframes h2-sidebar-rail-in');
    // 唯一保留的轨道系规则 = SessionBrowser 轨道态回落钮（wide=false）
    expect(block('.h2-sidebar-rail-icon')).toContain('width: 36px');
    expect(block('.h2-sidebar-rail-icon')).toContain('height: 36px');
  });

  it('降动效媒体查询把 caret 过渡与 spinner 动画关掉', () => {
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(declarations);
    expect(reduce).not.toBeNull();
    const body = reduce?.[1] ?? '';
    expect(body).toContain('transition: none');
    expect(body).toContain('animation: none');
    expect(body).toContain('.h2-sidebar-caret');
    expect(body).toContain('.h2-sidebar-spinner');
  });

  it('降动效状态类同样禁用（hook 侧分支与媒体查询互为兜底）', () => {
    const cls = /\.h2-sidebar-reduced-motion[^{]*\{([^{}]*)\}/.exec(declarations);
    expect(cls).not.toBeNull();
    expect(cls?.[1]).toContain('transition: none');
    expect(cls?.[1]).toContain('animation: none');
  });

  it('U2 批D（D2）：侧栏底色走 --color-sidebar；行 hover 全链走 --color-surface-hover', () => {
    expect(block('.h2-sidebar')).toContain('background: var(--color-sidebar)');
    expect(declarations).not.toMatch(/\.h2-sidebar-session:hover\s*\{[^}]*--color-muted/);
    // 选中态（Z-09）：selected 填充、无左缘 inset 强调条
    const selected = block(".h2-sidebar-session[data-selected='true']");
    expect(selected).toContain('background: var(--color-selected)');
    expect(selected).not.toContain('box-shadow');
  });

  it('U2 批D（D1 / Z-61）：字号刻度执法——sidebar.css 零裸 px font-size', () => {
    const bare = [...declarations.matchAll(/font-size:\s*\d+(\.\d+)?px/g)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });
});
