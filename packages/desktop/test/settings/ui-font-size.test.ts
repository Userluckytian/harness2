// 界面字号运行时测试（Z-90 / D-14 例外 #2）：钳制 12–20、读存储、应用 = 根变量 + localStorage 镜像、
// 无效/越界存储不造值、init 无存储值时不写任何东西。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_STORAGE_KEY,
  applyUiFontSize,
  clampUiFontSize,
  currentUiFontSize,
  initUiFontSize,
  readStoredUiFontSize,
} from '../../src/renderer/ui-font-size.js';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty('--ui-font-size');
});

describe('界面字号运行时（Z-90）', () => {
  it('范围常量 = 12–20，默认 14（Z-90）', () => {
    expect(UI_FONT_SIZE_MIN).toBe(12);
    expect(UI_FONT_SIZE_MAX).toBe(20);
    expect(UI_FONT_SIZE_DEFAULT).toBe(14);
  });

  it('clampUiFontSize 钳制进 [12, 20] 并取整', () => {
    expect(clampUiFontSize(11)).toBe(12);
    expect(clampUiFontSize(25)).toBe(20);
    expect(clampUiFontSize(14.6)).toBe(15);
    expect(clampUiFontSize(16)).toBe(16);
  });

  it('applyUiFontSize 写根 --ui-font-size 并镜像 localStorage（例外 #2 持久化）', () => {
    const applied = applyUiFontSize(16);
    expect(applied).toBe(16);
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px');
    expect(window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY)).toBe('16');
  });

  it('readStoredUiFontSize：合法值读回；越界 / 非法 / 缺失 → null（不造值）', () => {
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, '18');
    expect(readStoredUiFontSize()).toBe(18);
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, '99');
    expect(readStoredUiFontSize()).toBeNull();
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, 'abc');
    expect(readStoredUiFontSize()).toBeNull();
    window.localStorage.removeItem(UI_FONT_SIZE_STORAGE_KEY);
    expect(readStoredUiFontSize()).toBeNull();
  });

  it('currentUiFontSize：有存储读存储，无存储回落默认 14', () => {
    expect(currentUiFontSize()).toBe(14);
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, '20');
    expect(currentUiFontSize()).toBe(20);
  });

  it('initUiFontSize：无存储值时不写根变量也不写存储（boot 脚本之后的惰性双保险）', () => {
    initUiFontSize();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('');
    expect(window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY)).toBeNull();
    // 有存储值时恢复
    window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, '15');
    initUiFontSize();
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('15px');
  });
});
