// 通用设置测试（P6-C / D-6x ui-settings-general）：受控组件契约 —— 主题/通知选择只回传选择，
// 不自己碰 DOM、不自己碰壳 store（真生效由宿主装配层落 P4 主题呈现器，装配级证据见 settings-dialog.test.tsx）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { GeneralSettings, NOTIFY_DETAILS_CHOICES, THEME_CHOICES } from '../../src/renderer/settings/general/index.js';

afterEach(cleanup);

function renderGeneral(over: Partial<React.ComponentProps<typeof GeneralSettings>> = {}): {
  onSelectTheme: ReturnType<typeof vi.fn>;
  onSelectNotifyDetails: ReturnType<typeof vi.fn>;
} {
  const onSelectTheme = vi.fn();
  const onSelectNotifyDetails = vi.fn();
  render(
    <GeneralSettings
      theme="warmPaper"
      onSelectTheme={onSelectTheme}
      notifyDetails="minimal"
      onSelectNotifyDetails={onSelectNotifyDetails}
      loaded
      {...over}
    />,
  );
  return { onSelectTheme, onSelectNotifyDetails };
}

describe('通用设置：真实可用项', () => {
  it('主题三选一（暖纸/深色/跟随系统）—— 标签与命令面板同源（themeLabel）', () => {
    renderGeneral();
    expect(THEME_CHOICES).toEqual(['warmPaper', 'dark', 'system']);
    expect(screen.getByRole('button', { name: '暖纸浅色' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '深色' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '跟随系统' })).toBeTruthy();
  });

  it('点主题只回传选择（不自己落地）：onSelectTheme("dark")', () => {
    const { onSelectTheme } = renderGeneral();
    fireEvent.click(screen.getByRole('button', { name: '深色' }));
    expect(onSelectTheme).toHaveBeenCalledWith('dark');
    // 未受控：自己不改变选中态（真源在宿主注入的 theme）
    expect(screen.getByRole('button', { name: '深色' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('点通知详情只回传选择：两档（精简/完整）', () => {
    const { onSelectNotifyDetails } = renderGeneral();
    expect(NOTIFY_DETAILS_CHOICES).toEqual(['minimal', 'full']);
    fireEvent.click(screen.getByRole('button', { name: '完整（含回复摘要）' }));
    expect(onSelectNotifyDetails).toHaveBeenCalledWith('full');
  });

  it('偏好未载入时不渲染可点控件（不摆「点了没反应」的假开关）', () => {
    renderGeneral({ loaded: false });
    expect(screen.queryByRole('button', { name: '深色' })).toBeNull();
    expect(screen.getAllByText('加载中…').length).toBeGreaterThan(0);
  });

  it('不摆已失效的项：无「启动默认分栏数」（P4-C 拆掉分栏后无消费方）', () => {
    const { container } = render(
      <GeneralSettings
        theme="warmPaper"
        onSelectTheme={() => {}}
        notifyDetails="minimal"
        onSelectNotifyDetails={() => {}}
        loaded
      />,
    );
    expect(container.textContent ?? '').not.toContain('分栏');
  });

  it('宿主反馈（保存失败等）如实显示在通用分区', () => {
    renderGeneral({ note: '偏好保存失败：磁盘只读' });
    expect(screen.getByText('偏好保存失败：磁盘只读')).toBeTruthy();
  });

  it('通知详情的生效范围如实标注（重启后生效，不假装即时）', () => {
    renderGeneral();
    expect(screen.getByText(/重启应用后生效/)).toBeTruthy();
  });
});
