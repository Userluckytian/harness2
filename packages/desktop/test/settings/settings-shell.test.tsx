// 设置壳测试（P6-C / D-6x）：分区导航、按需挂载、内容槽、分区 id 重复守门、
// 分区排序（order 升序）与能力模块贡献注入（同 id 接管）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  MODELS_SECTION_ID,
  SettingsShell,
  SettingsShellError,
  findSettingsSection,
  registerSettingsSection,
  resetSettingsSections,
  sectionFromContribution,
  sortSections,
} from '../../src/renderer/settings/shell/index.js';
import type { SettingsSectionDefinition } from '../../src/renderer/settings/shell/index.js';

afterEach(() => {
  cleanup();
  resetSettingsSections();
});

function section(id: string, label: string, order?: number, body = id): SettingsSectionDefinition {
  return {
    id,
    label,
    en: id.toUpperCase(),
    owner: `ui-test-${id}`,
    ...(order !== undefined ? { order } : {}),
    render: () => <div data-testid={`body-${id}`}>{body}</div>,
  };
}

describe('设置壳：分区导航与内容槽', () => {
  it('导航按 order 升序渲染；只有激活分区被挂载（按需挂载）', () => {
    render(<SettingsShell open onClose={() => {}} sections={[section('b', '乙', 20), section('a', '甲', 10)]} />);
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toEqual(['a', 'b']);
    // 默认激活第一个分区（order 最小）
    expect(screen.getByTestId('body-a')).toBeTruthy();
    expect(screen.queryByTestId('body-b')).toBeNull();
    // data-section 如实标注当前分区与归属
    const slot = document.querySelector('[data-section]');
    expect(slot?.getAttribute('data-section')).toBe('a');
    expect(slot?.getAttribute('data-section-owner')).toBe('ui-test-a');
  });

  it('点击导航切换分区：旧分区卸载、新分区挂载', () => {
    render(<SettingsShell open onClose={() => {}} sections={[section('a', '甲', 10), section('b', '乙', 20)]} />);
    fireEvent.click(screen.getByText('乙'));
    expect(screen.getByTestId('body-b')).toBeTruthy();
    expect(screen.queryByTestId('body-a')).toBeNull();
    expect(document.querySelector('[data-section]')?.getAttribute('data-section')).toBe('b');
  });

  it('defaultSectionId 指定初始分区；关闭态不渲染任何内容', () => {
    const view = render(
      <SettingsShell
        open
        onClose={() => {}}
        defaultSectionId="b"
        sections={[section('a', '甲', 10), section('b', '乙', 20)]}
      />,
    );
    expect(screen.getByTestId('body-b')).toBeTruthy();
    view.rerender(
      <SettingsShell open={false} onClose={() => {}} sections={[section('a', '甲', 10), section('b', '乙', 20)]} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('关闭按钮回调；弹窗内点击不冒泡关闭', () => {
    const onClose = vi.fn();
    render(<SettingsShell open onClose={onClose} sections={[section('a', '甲')]} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const onClose2 = vi.fn();
    render(<SettingsShell open onClose={onClose2} sections={[section('a', '甲')]} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose2).not.toHaveBeenCalled(); // 弹窗内点击不冒泡关闭
  });

  it('分区 id 重复 → 抛 SettingsShellError（两套并存守门）', () => {
    expect(() =>
      render(<SettingsShell open onClose={() => {}} sections={[section('a', '甲'), section('a', '又一甲')]} />),
    ).toThrow(SettingsShellError);
  });

  it('sortSections 不改入参（order 缺省 100，同 order 保持注册顺序）', () => {
    const input = [section('c', '丙'), section('a', '甲', 10), section('b', '乙')];
    const sorted = sortSections(input);
    expect(sorted.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(input.map((s) => s.id)).toEqual(['c', 'a', 'b']); // 入参原样
  });
});

describe('设置壳：能力模块注入（D-6x「通过席位或 ctx 注入」）', () => {
  it('注册的分区贡献可折成分区声明，组件收到 active=true（B 棒模型页接入面）', () => {
    const seen: boolean[] = [];
    registerSettingsSection({
      id: MODELS_SECTION_ID,
      label: '模型配置',
      en: 'Models',
      owner: 'ui-settings-models',
      order: 10,
      component: ({ active }) => {
        seen.push(active);
        return <div data-testid="models-from-b">B 的模型页</div>;
      },
    });
    const found = findSettingsSection(MODELS_SECTION_ID);
    expect(found?.owner).toBe('ui-settings-models');
    render(<SettingsShell open onClose={() => {}} sections={[sectionFromContribution(found!)]} />);
    expect(screen.getByTestId('models-from-b')).toBeTruthy();
    expect(seen).toEqual([true]);
  });

  it('同 id 再注册 = 接管（只留一份正文）；disposer 幂等且复位后回到未注册态', () => {
    const disposeFirst = registerSettingsSection({
      id: MODELS_SECTION_ID,
      label: '模型配置',
      en: 'Models',
      owner: 'ui-settings-models@1',
      component: () => <div data-testid="v1">v1</div>,
    });
    const disposeSecond = registerSettingsSection({
      id: MODELS_SECTION_ID,
      label: '模型配置',
      en: 'Models',
      owner: 'ui-settings-models@2',
      component: () => <div data-testid="v2">v2</div>,
    });
    render(
      <SettingsShell
        open
        onClose={() => {}}
        sections={[sectionFromContribution(findSettingsSection(MODELS_SECTION_ID)!)]}
      />,
    );
    expect(screen.getByTestId('v2')).toBeTruthy();
    expect(screen.queryByTestId('v1')).toBeNull();
    // 卸载第二个（接管者）→ 不回滚到第一个，直接回到未注册（避免「旧正文复活」）
    disposeSecond();
    expect(findSettingsSection(MODELS_SECTION_ID)).toBeUndefined();
    disposeFirst(); // 幂等：重复调用安全
    disposeFirst();
    expect(findSettingsSection(MODELS_SECTION_ID)).toBeUndefined();
  });
});
