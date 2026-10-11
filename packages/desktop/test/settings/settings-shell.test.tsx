// 设置壳测试（Z5 / Z-88 全屏设置页）：分组导航、按需挂载、内容槽、分区 id 重复守门、
// 分区排序（order 升序）与分区分组（Z-89 数据驱动）、返回按钮关页、能力模块贡献注入（同 id 接管）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  MODELS_SECTION_ID,
  SETTINGS_SECTION_GROUPS,
  SettingsShell,
  SettingsShellError,
  findSettingsSection,
  groupSections,
  registerSettingsSection,
  resetSettingsSections,
  sectionFromContribution,
  sortSections,
} from '../../src/renderer/settings/shell/index.js';
import type { SettingsSectionDefinition, SettingsSectionGroupId } from '../../src/renderer/settings/shell/index.js';

afterEach(() => {
  cleanup();
  resetSettingsSections();
});

function section(
  id: string,
  label: string,
  order?: number,
  body = id,
  group?: SettingsSectionGroupId,
): SettingsSectionDefinition {
  return {
    id,
    label,
    en: id.toUpperCase(),
    owner: `ui-test-${id}`,
    ...(group !== undefined ? { group } : {}),
    ...(order !== undefined ? { order } : {}),
    render: () => <div data-testid={`body-${id}`}>{body}</div>,
  };
}

describe('设置壳（Z-88）：全屏页骨架', () => {
  it('返回按钮（返回工作区）回调 onClose；页面以 dialog 语义承载在 fixed 全屏层', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsShell open onClose={onClose} sections={[section('a', '甲', 10)]} />);
    const page = container.querySelector('[data-settings-page]');
    expect(page).not.toBeNull();
    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
    // 根类含 fixed inset-0（全屏层，承载在既有 overlay 席位）
    expect(page?.className).toContain('fixed');
    expect(page?.className).toContain('inset-0');
    fireEvent.click(screen.getByRole('button', { name: '返回工作区' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭态不渲染任何内容；defaultSectionId 指定初始分区（Z3-04 直达通道不变）', () => {
    const closed = render(
      <SettingsShell open={false} onClose={() => {}} sections={[section('a', '甲', 10), section('b', '乙', 20)]} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    closed.unmount();
    // 直达分区在挂载时采纳（宿主以 key 重挂载让壳落 defaultSectionId；D-14：激活分区只内存）
    render(
      <SettingsShell
        open
        onClose={() => {}}
        defaultSectionId="b"
        sections={[section('a', '甲', 10), section('b', '乙', 20)]}
      />,
    );
    expect(screen.getByTestId('body-b')).toBeTruthy();
  });

  it('分组导航按组（Z-89 三组）×组内 order 渲染；组标题与 data-settings-group 齐备', () => {
    render(
      <SettingsShell
        open
        onClose={() => {}}
        sections={[
          section('s-stats', '数据', 200, 'x', 'dataAndStats'),
          section('s-agent', '能力', 100, 'x', 'agentCapabilities'),
          section('s-basic', '基础', 0, 'x', 'basics'),
        ]}
      />,
    );
    const navs = [...document.querySelectorAll('[data-section-nav]')].map((n) => n.getAttribute('data-section-nav'));
    expect(navs).toEqual(['s-basic', 's-agent', 's-stats']);
    const groupIds = [...document.querySelectorAll('[data-settings-nav-group]')].map((n) =>
      n.getAttribute('data-settings-nav-group'),
    );
    expect(groupIds).toEqual(['basics', 'agentCapabilities', 'dataAndStats']);
    const labels = [...document.querySelectorAll('[data-settings-group-label]')].map((n) => n.textContent);
    expect(labels).toEqual(SETTINGS_SECTION_GROUPS.map((g) => g.label));
  });

  it('点击导航切换分区：旧分区卸载、新分区挂载；激活项 bg-surface-hover（Z-88）', () => {
    render(
      <SettingsShell
        open
        onClose={() => {}}
        sections={[section('a', '甲', 10, 'x', 'basics'), section('b', '乙', 20, 'x', 'basics')]}
      />,
    );
    expect(screen.getByTestId('body-a')).toBeTruthy();
    const navA = document.querySelector('[data-section-nav="a"]') as HTMLElement;
    expect(navA.className).toContain('bg-surface-hover');
    fireEvent.click(document.querySelector('[data-section-nav="b"]') as HTMLElement);
    expect(screen.getByTestId('body-b')).toBeTruthy();
    expect(screen.queryByTestId('body-a')).toBeNull();
    expect(document.querySelector('[data-section]')?.getAttribute('data-section')).toBe('b');
    expect((document.querySelector('[data-section-nav="b"]') as HTMLElement).className).toContain('bg-surface-hover');
  });

  it('右栏：48px 面包屑行（组标题/分区名）+ 内容列 max-w-4xl + h2 区块标题', () => {
    render(<SettingsShell open onClose={() => {}} sections={[section('a', '甲', 10, 'x', 'agentCapabilities')]} />);
    const crumb = document.querySelector('[data-settings-breadcrumb]');
    expect(crumb?.textContent).toContain('Agent 能力');
    expect(crumb?.textContent).toContain('甲');
    expect(crumb?.className).toContain('h-12');
    const body = document.querySelector('[data-settings-body]');
    expect(body?.className).toContain('overflow-y-auto');
    const column = body?.firstChild as HTMLElement;
    expect(column.className).toContain('max-w-4xl');
    expect(screen.getByRole('heading', { level: 2, name: '甲' })).toBeTruthy();
  });

  it('页脚（宿主注入版本号）渲染在左栏底部', () => {
    render(<SettingsShell open onClose={() => {}} sections={[section('a', '甲')]} footer={<span>v1.0.0</span>} />);
    expect(document.querySelector('[data-settings-footer]')?.textContent).toBe('v1.0.0');
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

  it('groupSections：未声明 group 的分区垫底成未组视图（组内仍按 order）', () => {
    const views = groupSections([
      section('u', '无组'),
      section('b2', '乙', 20, 'x', 'basics'),
      section('b1', '甲', 10, 'x', 'basics'),
    ]);
    expect(views.map((v) => v.group?.id)).toEqual(['basics', undefined]);
    expect(views[0]?.sections.map((s) => s.id)).toEqual(['b1', 'b2']);
    expect(views[1]?.sections.map((s) => s.id)).toEqual(['u']);
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
