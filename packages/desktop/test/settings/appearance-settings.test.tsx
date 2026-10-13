// 外观设置测试（Z-90 + Z10-7）：主题 Select 契约（受控：只回传选择，不自己落地）、
// 界面字号 FontSizeInput 契约（12–20，回传提交值）、代码设置卡（浅/深主题 Select + 行号/换行开关
// + 代码字号）与代码预览卡（浅/深两卡 + 徽标 + 固定背景）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { AppearanceSettings, THEME_CHOICES } from '@harness2/ui-shared/renderer/settings/appearance/index.js';
import { DEFAULT_CODE_PREFERENCES } from '@harness2/ui-shared/renderer/code/index.js';

// Radix Select 在 jsdom 下的两个已知前提：滚动定位 API 缺失（高亮时调用）、Item 非触摸 click 即提交
(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

afterEach(cleanup);

function renderAppearance(over: Partial<React.ComponentProps<typeof AppearanceSettings>> = {}): {
  onSelectTheme: ReturnType<typeof vi.fn>;
  onUiFontSizeCommit: ReturnType<typeof vi.fn>;
  onCodePreferencesChange: ReturnType<typeof vi.fn>;
} {
  const onSelectTheme = vi.fn();
  const onUiFontSizeCommit = vi.fn();
  const onCodePreferencesChange = vi.fn();
  render(
    <AppearanceSettings
      theme="system"
      onSelectTheme={onSelectTheme}
      uiFontSize={14}
      onUiFontSizeCommit={onUiFontSizeCommit}
      codePreferences={DEFAULT_CODE_PREFERENCES}
      onCodePreferencesChange={onCodePreferencesChange}
      loaded
      {...over}
    />,
  );
  return { onSelectTheme, onUiFontSizeCommit, onCodePreferencesChange };
}

/** Radix Select（jsdom）：触发器 Enter 打开 → 目标 option click 提交（Radix Item：非 touch 的 click 即选中） */
function chooseOption(name: string): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name: '界面主题' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('外观设置（Z-90）：界面主题 Select', () => {
  it('选项 = 系统 → 深色 → 浅色（Z-90 顺序），标签与命令面板同源（themeLabel）', async () => {
    renderAppearance();
    expect(THEME_CHOICES).toEqual(['system', 'zai-dark', 'zai-light']);
    const trigger = screen.getByRole('combobox', { name: '界面主题' });
    expect(trigger.textContent).toContain('跟随系统');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['跟随系统', '深色', '浅色']);
    // 每个选项带 Z-90 图标（Monitor/Moon/Sun），data-theme-choice 可寻址
    expect(document.querySelector('[data-theme-choice="system"] svg')).not.toBeNull();
    expect(document.querySelector('[data-theme-choice="zai-dark"] svg')).not.toBeNull();
    expect(document.querySelector('[data-theme-choice="zai-light"] svg')).not.toBeNull();
  });

  it('点选「深色」只回传选择（不自己落地）：onSelectTheme("zai-dark")；受控：选中态跟随宿主', async () => {
    const { onSelectTheme } = renderAppearance();
    chooseOption('深色');
    expect(onSelectTheme).toHaveBeenCalledWith('zai-dark');
    // 未受控回写：trigger 仍显示宿主注入的当前值（跟随系统）
    expect(screen.getByRole('combobox', { name: '界面主题' }).textContent).toContain('跟随系统');
  });

  it('偏好未载入时不渲染可点控件（不摆「点了没反应」的假开关）', () => {
    renderAppearance({ loaded: false });
    expect(screen.queryByRole('combobox', { name: '界面主题' })).toBeNull();
    expect(screen.getAllByText('加载中…').length).toBeGreaterThan(0);
  });

  it('宿主反馈（主题偏好保存失败等）如实显示在动作发生的外观分区', () => {
    renderAppearance({ note: '偏好保存失败：磁盘只读' });
    expect(screen.getByText('偏好保存失败：磁盘只读')).toBeTruthy();
  });
});

describe('外观设置（Z-90）：界面字号', () => {
  it('FontSizeInput 契约：提交回传 12–20 钳制值（宿主负责生效与持久化）', () => {
    const { onUiFontSizeCommit } = renderAppearance({ uiFontSize: 14 });
    const field = screen.getByRole('spinbutton', { name: '界面字号' }) as HTMLInputElement;
    expect(field.value).toBe('14');
    fireEvent.change(field, { target: { value: '16' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onUiFontSizeCommit).toHaveBeenCalledWith(16);
    // 越界钳制
    fireEvent.change(field, { target: { value: '99' } });
    fireEvent.focusOut(field);
    expect(onUiFontSizeCommit).toHaveBeenCalledWith(20);
  });

  it('范围常量 12–20（与 ui-font-size 运行时同口径）', () => {
    renderAppearance();
    const field = screen.getByRole('spinbutton', { name: '界面字号' }) as HTMLInputElement;
    expect(field.getAttribute('min')).toBe('12');
    expect(field.getAttribute('max')).toBe('20');
  });
});

describe('外观设置（Z10-7）：代码设置卡 + 代码预览卡', () => {
  it('代码设置卡渲染：浅/深代码主题 Select + 行号/换行开关 + 代码字号（12–20）', () => {
    renderAppearance();
    expect(screen.getByRole('combobox', { name: '浅色代码主题' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '深色代码主题' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '显示行号' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: '长行自动换行' })).toBeTruthy();
    const size = screen.getByRole('spinbutton', { name: '代码字号' }) as HTMLInputElement;
    expect(size.value).toBe('13');
    expect(size.getAttribute('min')).toBe('12');
    expect(size.getAttribute('max')).toBe('20');
  });

  it('改浅色代码主题 → onCodePreferencesChange({ themeLight })（只报补丁，不自己落地）', () => {
    const { onCodePreferencesChange } = renderAppearance();
    fireEvent.keyDown(screen.getByRole('combobox', { name: '浅色代码主题' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'Vitesse' }));
    expect(onCodePreferencesChange).toHaveBeenCalledWith({ themeLight: 'vitesse-light' });
  });

  it('切「显示行号」开关 → onCodePreferencesChange({ lineNumbers: false })', () => {
    const { onCodePreferencesChange } = renderAppearance();
    fireEvent.click(screen.getByRole('switch', { name: '显示行号' }));
    expect(onCodePreferencesChange).toHaveBeenCalledWith({ lineNumbers: false });
  });

  it('提交代码字号 → onCodePreferencesChange({ fontSize: 钳制值 })', () => {
    const { onCodePreferencesChange } = renderAppearance();
    const size = screen.getByRole('spinbutton', { name: '代码字号' });
    fireEvent.change(size, { target: { value: '99' } });
    fireEvent.focusOut(size);
    expect(onCodePreferencesChange).toHaveBeenCalledWith({ fontSize: 20 });
  });

  it('预览卡两态：浅色固定 #f8f8f8、深色 #161616；浅色界面下浅色卡标「当前生效」', () => {
    renderAppearance();
    const light = document.querySelector('[data-theme-preview="light"]') as HTMLElement;
    const dark = document.querySelector('[data-theme-preview="dark"]') as HTMLElement;
    expect(light.textContent).toContain('浅色预览');
    expect(dark.textContent).toContain('深色预览');
    const lightBody = light.querySelector('[data-code-viewer-body]') as HTMLElement;
    const darkBody = dark.querySelector('[data-code-viewer-body]') as HTMLElement;
    expect(lightBody.style.background).toBe('rgb(248, 248, 248)');
    expect(darkBody.style.background).toBe('rgb(22, 22, 22)');
    expect(light.querySelector('[data-preview-badge]')?.getAttribute('data-preview-badge')).toBe('当前生效');
    expect(dark.querySelector('[data-preview-badge]')?.getAttribute('data-preview-badge')).toBe('深色');
  });

  it('深色界面下「当前生效」徽标落到深色预览卡', () => {
    renderAppearance({ theme: 'zai-dark' });
    const light = document.querySelector('[data-theme-preview="light"]') as HTMLElement;
    const dark = document.querySelector('[data-theme-preview="dark"]') as HTMLElement;
    expect(light.querySelector('[data-preview-badge]')?.getAttribute('data-preview-badge')).toBe('浅色');
    expect(dark.querySelector('[data-preview-badge]')?.getAttribute('data-preview-badge')).toBe('当前生效');
  });
});
