// theme-boot.js（首屏防闪）测试：主题写入契约照旧（class/dark/data-theme/color-scheme）+
// Z-90 扩展：localStorage['harness2-font-size'] 读取 → 首渲染前写根 --ui-font-size（例外 #2）；
// 非法 / 越界 / 缺失字号不写（走 CSS 默认）。desktop 与 web 两份同源，这里测 desktop 源并校验两份一致。
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const desktopBootPath = join(here, '..', '..', 'src', 'renderer', 'public', 'theme-boot.js');
const webBootPath = join(here, '..', '..', '..', 'web', 'public', 'theme-boot.js');
const bootSource = (): string => readFileSync(desktopBootPath, 'utf8');

/** 在当前 jsdom 环境同步执行 boot 脚本（等价 index.html 里模块脚本之前的 <script src>） */
function runBoot(): void {
  // new Function：脚本是 IIFE，直接以全局 window/document 执行
  new Function(bootSource())();
}

beforeEach(() => {
  window.localStorage.clear();
  const root = document.documentElement;
  root.style.cssText = '';
  root.removeAttribute('data-theme');
  root.classList.remove('theme-zai-light', 'theme-zai-dark', 'dark');
});

describe('theme-boot.js：字号 key 读取（Z-90 / 例外 #2）', () => {
  it('desktop 与 web 两份 boot 脚本同源（保持一份逻辑）', () => {
    expect(readFileSync(webBootPath, 'utf8')).toBe(bootSource());
  });

  it('合法字号（12–20）→ 首渲染前写根 --ui-font-size；主题契约照旧', () => {
    window.localStorage.setItem('harness2-font-size', '16');
    window.localStorage.setItem('harness2-theme', 'zai-dark');
    runBoot();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zai-dark');
    expect(document.documentElement.classList.contains('theme-zai-dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('越界（99）/ 非法（abc）/ 缺失 → 不写 --ui-font-size（走 CSS 默认 14px，不造值）', () => {
    for (const bad of ['99', 'abc']) {
      window.localStorage.setItem('harness2-font-size', bad);
      runBoot();
      expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('');
      window.localStorage.removeItem('harness2-font-size');
    }
    runBoot();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('');
  });

  it('边界值 12 / 20 生效；非整数（14.5）不生效（boot 与运行时同口径：整数才收）', () => {
    window.localStorage.setItem('harness2-font-size', '12');
    runBoot();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('12px');

    window.localStorage.setItem('harness2-font-size', '20');
    runBoot();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('20px');

    // 非整数：boot 不写（清掉上一次的写入后再验，排除上一子例残留）
    window.localStorage.setItem('harness2-font-size', '14.5');
    document.documentElement.style.removeProperty('--ui-font-size');
    runBoot();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('');
  });

  it('无 matchMedia 的 system 缺省回浅色（既有行为回归）', () => {
    runBoot();
    expect(document.documentElement.getAttribute('data-theme')).toBe('zai-light');
  });
});
