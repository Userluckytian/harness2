// D-20 品牌席位：`sidebar.brand.mark` 与 `sidebar.brand.name` 两个 single 席位。
// Z-06 折叠态没有图标轨道：内容只隐藏不卸载，故折叠时品牌行仍渲染（不可见）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderSidebar } from './harness.js';

afterEach(() => {
  cleanup();
});

describe('D-20 品牌席位', () => {
  it('展开态同时渲染 mark 与 name 两席（缺省用内置标记 + 本地构建回落名）', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-brand-mark').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('sidebar-brand-name').textContent).toBe('本地构建');
  });

  it('品牌包接管 mark 席位时收到 size，且内置标记让位', () => {
    const sizes: number[] = [];
    renderSidebar({
      renderBrandMark: ({ size }) => {
        sizes.push(size);
        return <span data-testid="custom-mark">M</span>;
      },
    });
    expect(sizes).toEqual([24]);
    expect(screen.getByTestId('custom-mark')).not.toBeNull();
    expect(screen.getByTestId('sidebar-brand-mark').querySelector('svg')).toBeNull();
  });

  it('品牌包接管 name 席位时收到版本徐标文案（无版本元数据则为 undefined）', () => {
    const seen: Array<string | undefined> = [];
    renderSidebar({
      buildVersion: '9.9.9-abcdef0',
      renderBrandName: ({ version }) => {
        seen.push(version);
        return <span data-testid="custom-name">自定义品牌</span>;
      },
    });
    expect(seen).toEqual(['9.9.9-abcdef0']);
    expect(screen.getByTestId('custom-name')?.textContent).toBe('自定义品牌');
  });

  it('折叠态（Z-06）：无图标轨道，品牌行只隐藏不卸载（内容仍在 DOM）', () => {
    renderSidebar({ collapsed: true });
    // 折叠 = opacity-0 + pointer-events-none，不卸载
    expect(screen.getByTestId('sidebar-root').classList.contains('opacity-0')).toBe(true);
    expect(screen.getByTestId('sidebar-root').classList.contains('pointer-events-none')).toBe(true);
    expect(screen.getByTestId('sidebar-brand-mark').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('sidebar-brand-name')).toBeTruthy();
    // 没有任何轨道标记
    expect(screen.queryByTestId('sidebar-brand-mark-rail')).toBeNull();
    expect(screen.queryByTestId('sidebar-region-rail')).toBeNull();
  });

  it('品牌行是新会话快捷入口（点击等同新会话按钮）', () => {
    const calls: Array<{ kind: string }> = [];
    renderSidebar({ onNewSession: (scope) => calls.push({ kind: scope.kind }) });
    screen.getByTestId('sidebar-brand').click();
    expect(calls).toEqual([{ kind: 'blank' }]);
  });
});
