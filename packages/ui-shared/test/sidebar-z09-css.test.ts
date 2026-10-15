// U2 批D（Z-09 执法 · 样式表文本断言，node 环境读源文件不依赖 dist）：
//   1) 选中行 = **纯填充 var(--color-selected)**，无左缘 inset 强调条（box-shadow）、无加粗
//      （font-weight:600）——两者是 D2 明确删除的自造视觉；
//   2) attention 徽标 = 绿底浅染 color-mix(success 14%) + 前景 token，**无 #fff 固定白**
//      （jsdom 不做 color-mix 的 computed 解析，等价断言走声明文本）；
//   3) unread = 8px 蓝点（ask 族前景 token），黑底计数胶囊已删；
//   4) 行 hover 全链 = --color-surface-hover（--color-muted 不再出现在任何 :hover 规则）；
//   5) 字号刻度执法：sidebar.css 零裸 px font-size（Z-61 / Z-71）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/sidebar.css', import.meta.url)), 'utf8');
/** 去注释：散文里会提「13px」「box-shadow」等字样，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取出某选择器块内的声明（选择器按字面量匹配） */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`).exec(declarations);
  expect(match, `未找到选择器块：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Z-09 选中行（D2 删除自造强调条与加粗）', () => {
  it('[data-selected=true] = 纯填充 var(--color-selected)，无 box-shadow、无 font-weight:600', () => {
    const selected = block(".h2-sidebar-session[data-selected='true']");
    expect(selected).toContain('background: var(--color-selected)');
    expect(selected).not.toContain('box-shadow');
    expect(selected).not.toMatch(/font-weight:\s*600/);
    // 反向钉：全文件不再有旧的 accent 填充选中态
    expect(selected).not.toContain('--color-accent');
  });
});

describe('attention / unread 徽标色（D3）', () => {
  it('attention = success 14% 浅染 + 前景 token；无 #fff 固定白', () => {
    const attention = block('.h2-sidebar-attention');
    expect(attention).toContain('color-mix(in srgb, var(--color-success) 14%, transparent)');
    expect(attention).toContain('color: var(--color-foreground)');
    expect(attention.toLowerCase()).not.toContain('#fff');
    // 旧口径反向钉：不再拿 warning 实色当底
    expect(attention).not.toMatch(/background:\s*var\(--color-warning\)/);
  });

  it('unread = 8px 蓝点（ask 族前景 token），黑底计数胶囊类已删', () => {
    const dot = block('.h2-sidebar-unread-dot');
    expect(dot).toContain('width: 8px');
    expect(dot).toContain('height: 8px');
    expect(dot).toContain('background: var(--color-interaction-ask-foreground)');
    expect(declarations).not.toContain('.h2-sidebar-unread {');
  });
});

describe('hover 全链与字号刻度（D1 / D2）', () => {
  it('任何 :hover 规则都不用 --color-muted（行钮 / 头钮 / 会话行统一 surface-hover）', () => {
    const hoverMuted = declarations
      .split('}')
      .filter((chunk) => chunk.includes(':hover') && chunk.includes('var(--color-muted)'));
    expect(hoverMuted).toEqual([]);
    expect(block('.h2-sidebar-session:hover')).toContain('background: var(--color-surface-hover)');
  });

  it('sidebar.css 零裸 px font-size（全走 --text-ui-* 刻度）', () => {
    expect([...declarations.matchAll(/font-size:\s*\d+(\.\d+)?px/g)].map((m) => m[0])).toEqual([]);
  });

  it('侧栏底色 = --color-sidebar（不再借 --color-panel）', () => {
    expect(block('.h2-sidebar')).toContain('background: var(--color-sidebar)');
  });
});
