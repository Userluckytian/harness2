// 通用设置测试（D-6x ui-settings-general）：受控组件契约 —— 通知选择只回传选择，
// 不自己碰 DOM、不自己碰壳 store（持久化由宿主装配层落 settings:* IPC）。
// 主题已迁「外观」分区（Z-90），本分区只留常规项；外观断言见 appearance-settings.test.tsx。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { GeneralSettings, NOTIFY_DETAILS_CHOICES } from '@harness2/ui-shared/renderer/settings/general/index.js';

afterEach(cleanup);

function renderGeneral(over: Partial<React.ComponentProps<typeof GeneralSettings>> = {}): {
  onSelectNotifyDetails: ReturnType<typeof vi.fn>;
} {
  const onSelectNotifyDetails = vi.fn();
  render(<GeneralSettings notifyDetails="minimal" onSelectNotifyDetails={onSelectNotifyDetails} loaded {...over} />);
  return { onSelectNotifyDetails };
}

describe('通用设置：真实可用项', () => {
  it('点通知详情只回传选择：两档（精简/完整）', () => {
    const { onSelectNotifyDetails } = renderGeneral();
    expect(NOTIFY_DETAILS_CHOICES).toEqual(['minimal', 'full']);
    fireEvent.click(screen.getByRole('button', { name: '完整（含回复摘要）' }));
    expect(onSelectNotifyDetails).toHaveBeenCalledWith('full');
  });

  it('受控：未回写前选中态跟随宿主注入值', () => {
    renderGeneral();
    expect(screen.getByRole('button', { name: '精简（仅标题）' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '完整（含回复摘要）' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('偏好未载入时不渲染可点控件（不摆「点了没反应」的假开关）', () => {
    renderGeneral({ loaded: false });
    expect(screen.queryByRole('button', { name: '完整（含回复摘要）' })).toBeNull();
    expect(screen.getAllByText('加载中…').length).toBeGreaterThan(0);
  });

  it('主题已迁「外观」分区（Z-90）：本分区不再渲染主题控件', () => {
    const { container } = render(<GeneralSettings notifyDetails="minimal" onSelectNotifyDetails={() => {}} loaded />);
    expect(container.querySelector('[data-settings-group="theme"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '深色' })).toBeNull();
  });

  it('不摆已失效的项：无「启动默认分栏数」（P4-C 拆掉分栏后无消费方）', () => {
    const { container } = render(<GeneralSettings notifyDetails="minimal" onSelectNotifyDetails={() => {}} loaded />);
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

  it('缺省中性措辞：不含 desktop-preferences.json 与 Ctrl+,（缺省不许再写桌面事实）', () => {
    renderGeneral();
    const text = document.body.textContent ?? '';
    expect(text).toContain('本机偏好文件');
    expect(text).not.toContain('desktop-preferences.json');
    expect(text).not.toContain('Ctrl+,');
  });

  it('按壳注入桌面措辞：偏好文件名与「打开本设置」键位如实显示', () => {
    renderGeneral({ preferencesFileLabel: 'desktop-preferences.json', openSettingsKeys: 'Ctrl+,' });
    expect(screen.getByText(/desktop-preferences.json/)).toBeTruthy();
    expect(screen.getByText(/Ctrl\+, 打开本设置/)).toBeTruthy();
  });
});

describe('通用设置：关窗驻留托盘（Z-47，端口注入才渲染）', () => {
  const trayStatus = { created: true, platform: 'win32', closeToTray: true };

  it('无 trayStatus（web/旧夹具）→ 整块不渲染（不摆假开关）', () => {
    renderGeneral();
    expect(screen.queryByRole('switch', { name: '关闭窗口时隐藏到托盘' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('窗口驻留');
  });

  it('trayStatus 在场 → 开关受控回显 + 切换回传', () => {
    const onToggleCloseToTray = vi.fn();
    renderGeneral({ trayStatus, onToggleCloseToTray });
    const sw = screen.getByRole('switch', { name: '关闭窗口时隐藏到托盘' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.hasAttribute('disabled')).toBe(false);
    fireEvent.click(sw);
    expect(onToggleCloseToTray).toHaveBeenCalledWith(false);
  });

  it('托盘创建失败（created=false）→ 开关禁用 + 说明文案在场，点击不回传', () => {
    const onToggleCloseToTray = vi.fn();
    renderGeneral({ trayStatus: { ...trayStatus, created: false, closeToTray: false }, onToggleCloseToTray });
    const sw = screen.getByRole('switch', { name: '关闭窗口时隐藏到托盘' }) as HTMLButtonElement;
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('tray-unavailable-note')).toBeTruthy();
    fireEvent.click(sw);
    expect(onToggleCloseToTray).not.toHaveBeenCalled();
  });
});
