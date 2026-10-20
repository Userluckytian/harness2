// U2-B1：token 卫生 · @theme 与 .theme-zai-light 逐值 parity 断言（防漂移从「结构」变「断言」）。
//   node 环境读 styles.css 文本（jsdom 不加载真实样式表）。
//
// 为什么是断言而不是结构收拢（二选一里选后者，理由如实登记）：
//   Tailwind v4 CSS-first 下 @theme 必须含**字面值**才能编译期生成 bg-background 等 utility，
//   且 @theme 产物会被 tree-shake（未使用 token 不进产物，实测 desktop/dist CSS 已验证），
//   不能反过来当运行时单一来源；§2 light 块则必须是字面运行时权威（同元素 var 自引用成环）。
//   两块无法互为引用 ⇒ 结构收拢不可行 ⇒ 用本用例逐值锁死，改一处忘另一处即红。
//   （styles.css §1/§2 的 ⚠ 锚注释与本文件互为指认。）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/styles.css', import.meta.url)), 'utf8');
/** 去掉注释：散文里会出现 token 名与色值示例，不能当声明证据 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 取某选择器/块的文本区（首个匹配），并解析为 token → 值（trim 后逐字比较）映射 */
function tokenMap(label: string, body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1] ?? '';
    const value = m[2] ?? '';
    expect(map.has(name), `${name} 在 ${label} 内重复声明`).toBe(false);
    map.set(name, value.trim());
  }
  expect(map.size, `${label} 未解析到 --color-* token`).toBeGreaterThan(0);
  return map;
}

function section(label: string, re: RegExp): Map<string, string> {
  const hit = re.exec(declarations);
  expect(hit, `未找到 ${label} 块`).not.toBeNull();
  return tokenMap(label, hit?.[1] ?? '');
}

const theme = section('@theme', /@theme\s*\{([\s\S]*?)\n\}/);
const light = section('Zai Light', /:root,\s*\.theme-zai-light,\s*\[data-theme='zai-light'\]\s*\{([\s\S]*?)\n\}/);
const dark = section('Zai Dark', /\.theme-zai-dark,\s*\[data-theme='zai-dark'\],\s*\.dark\s*\{([\s\S]*?)\n\}/);

describe('U2-B1 @theme ↔ .theme-zai-light 逐值 parity（漂移即红）', () => {
  it('两块 --color-* 数量一致，且等于清单基线 114（U2-B2 补入 scrim/background-alt 后）', () => {
    expect(theme.size, '@theme 与 light 块 token 数不等').toBe(light.size);
    expect(theme.size).toBe(114);
  });

  it('集合相等：无「只在 @theme」「只在 light」的 token', () => {
    const onlyTheme = [...theme.keys()].filter((k) => !light.has(k));
    const onlyLight = [...light.keys()].filter((k) => !theme.has(k));
    expect(onlyTheme, '新增 token 只改了 @theme').toEqual([]);
    expect(onlyLight, '新增 token 只改了 light 块').toEqual([]);
  });

  it('114 个 --color-* 值逐项相等（逐字比较，含 color-mix / var 引用形态）', () => {
    const diffs = [...theme]
      .filter(([k, v]) => light.get(k) !== v)
      .map(([k, v]) => `${k}: @theme=${v} light=${light.get(k)}`);
    expect(diffs, '@theme 与 light 块逐值漂移').toEqual([]);
  });
});

describe('U2-B2 三块键集与新增 token 同步', () => {
  it('dark 块与 light 块键集一致（三处同步纪律；dark 值本身不同是主题语义）', () => {
    const onlyLight = [...light.keys()].filter((k) => !dark.has(k));
    const onlyDark = [...dark.keys()].filter((k) => !light.has(k));
    expect(onlyLight).toEqual([]);
    expect(onlyDark).toEqual([]);
  });

  it('新增 scrim / background-alt 三处齐备，且值符合登记（light 与 @theme 逐字一致；dark 刻意不同）', () => {
    for (const name of ['--color-scrim', '--color-background-alt'] as const) {
      expect(theme.has(name), `${name} 未进 @theme`).toBe(true);
      expect(light.has(name), `${name} 未进 light 块`).toBe(true);
      expect(dark.has(name), `${name} 未进 dark 块`).toBe(true);
    }
    expect(theme.get('--color-scrim')).toBe('rgb(0 0 0 / 45%)');
    expect(light.get('--color-scrim')).toBe('rgb(0 0 0 / 45%)');
    expect(dark.get('--color-scrim')).toBe('rgb(0 0 0 / 60%)');
    expect(theme.get('--color-background-alt')).toBe(light.get('--color-background-alt'));
    expect(light.get('--color-background-alt')).toBe('color-mix(in oklab, var(--color-background) 70%, transparent)');
    expect(dark.get('--color-background-alt')).toBe(
      'color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)',
    );
  });
});
