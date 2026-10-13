// @vitest-environment jsdom
// 右栏标签宿主（Z-13 / Z-14 / Z10-6）：零 tab 启动器卡片（标题 + 156×88 卡片，只摆能诚实兑现
// 的目标）、卡片点击开对应 tab、终端卡走跨 surface 动作、白名单过滤；tab 行为（最小宽 60 / gap 4 /
// 关闭其他 / 全部关闭）。宿主是壳无关实现，桌面与 web 共用 —— 这些语义在此直接钉住。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import { SidePaneHost } from '../src/renderer/side-pane/SidePaneHost.js';
import {
  SIDE_PANE_LAUNCHER_CARD_HEIGHT_PX,
  SIDE_PANE_LAUNCHER_CARD_WIDTH_PX,
  SIDE_PANE_TAB_GAP_PX,
  SIDE_PANE_TAB_MIN_WIDTH_PX,
} from '../src/renderer/side-pane/side-pane-model.js';
import { sidePaneStore } from '../src/renderer/side-pane/side-pane-store.js';

const BUCKET = 's-host';

afterEach(cleanup);
beforeEach(() => {
  sidePaneStore.closeAll(BUCKET); // 模块单例跨用例共享 → 每个用例从零 tab 起步
});

function renderHost(props: Partial<Parameters<typeof SidePaneHost>[0]> = {}): void {
  render(
    <SidePaneHost
      store={new AppStore()}
      sessionId={BUCKET}
      renderTab={(id) => <div data-tab-body={id} />}
      {...props}
    />,
  );
}

const card = (id: string): Element | null => document.querySelector(`[data-launcher-card="${id}"]`);

describe('SidePaneHost：零 tab 启动器卡片（Z10-6）', () => {
  it('零 tab → 标题「打开标签页」+ 3 张 156×88 卡片；无标签条', () => {
    renderHost({ onOpenTerminal: () => undefined });
    expect(screen.getByTestId('side-pane-launcher')).toBeTruthy();
    expect(screen.getByText('打开标签页')).toBeTruthy();
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    const cards = screen.getAllByTestId('side-pane-launcher-card');
    expect(cards.map((c) => c.getAttribute('data-launcher-card'))).toEqual(['review', 'terminal', 'plan']);
    for (const c of cards) {
      expect((c as HTMLElement).style.width).toBe(`${SIDE_PANE_LAUNCHER_CARD_WIDTH_PX}px`);
      expect((c as HTMLElement).style.height).toBe(`${SIDE_PANE_LAUNCHER_CARD_HEIGHT_PX}px`);
    }
  });

  it('点「审查」卡 → 开 changes tab 并激活；启动器消失、内容槽渲染', () => {
    renderHost({ onOpenTerminal: () => undefined });
    fireEvent.click(card('review') as Element);
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
    expect(document.querySelector('[data-side-tab="changes"]')?.getAttribute('data-side-tab-active')).toBe('true');
    expect(document.querySelector('[data-tab-body="changes"]')).not.toBeNull();
  });

  it('点「计划」卡 → 开 plan tab（与 + 菜单同一打开入口）', () => {
    renderHost({ onOpenTerminal: () => undefined });
    fireEvent.click(card('plan') as Element);
    expect(document.querySelector('[data-side-tab="plan"]')?.getAttribute('data-side-tab-active')).toBe('true');
    expect(document.querySelector('[data-tab-body="plan"]')).not.toBeNull();
  });

  it('点「终端」卡 → 触发跨 surface 动作（底部 dock），不开右栏 tab', () => {
    const onOpenTerminal = vi.fn();
    renderHost({ onOpenTerminal });
    fireEvent.click(card('terminal') as Element);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(0);
    expect(screen.getByTestId('side-pane-launcher')).toBeTruthy();
  });

  it('白名单过滤：未列出的 tab 项不摆卡；壳未给终端动作则不摆终端卡（红线⑩）', () => {
    renderHost({ items: ['plan'] }); // 无 onOpenTerminal
    const cards = screen.getAllByTestId('side-pane-launcher-card');
    expect(cards.map((c) => c.getAttribute('data-launcher-card'))).toEqual(['plan']);
  });
});

describe('SidePaneHost：tab 行为（Z-14）', () => {
  it('标签条 h-12（48px）、tab 最小宽 60、gap 4；关闭其他 / 全部关闭', () => {
    renderHost({ onOpenTerminal: () => undefined });
    fireEvent.click(card('review') as Element); // changes（先开，非激活）
    // 已有 tab 时启动器不在 → 经标签条右簇 + 菜单再开一个（plan，激活）
    fireEvent.keyDown(screen.getByTestId('side-pane-add'), { key: 'Enter' });
    fireEvent.click(document.querySelector('[data-side-menu-item="plan"]') as Element);
    const strip = screen.getByTestId('side-pane-tabstrip');
    expect(strip.className).toContain('h-12'); // Z-14：tab 条 48px
    const tablist = document.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.style.gap).toBe(`${SIDE_PANE_TAB_GAP_PX}px`);
    for (const tab of document.querySelectorAll('[data-side-tab]')) {
      expect((tab as HTMLElement).style.minWidth).toBe(`${SIDE_PANE_TAB_MIN_WIDTH_PX}px`);
    }

    // 关闭其他：只留激活的 plan
    fireEvent.keyDown(screen.getByTestId('side-pane-actions'), { key: 'Enter' });
    fireEvent.click(document.querySelector('[data-side-action="close-others"]') as Element);
    expect(document.querySelectorAll('[data-side-tab]')).toHaveLength(1);
    expect(document.querySelector('[data-side-tab="plan"]')).not.toBeNull();

    // 全部关闭：回零 tab 启动器
    fireEvent.keyDown(screen.getByTestId('side-pane-actions'), { key: 'Enter' });
    fireEvent.click(document.querySelector('[data-side-action="close-all"]') as Element);
    expect(screen.queryByTestId('side-pane-tabstrip')).toBeNull();
    expect(screen.getByTestId('side-pane-launcher')).toBeTruthy();
  });

  it('有 tab 时不渲染启动器（零 tab 才显示）', () => {
    renderHost({ onOpenTerminal: () => undefined });
    fireEvent.click(card('review') as Element);
    expect(screen.queryByTestId('side-pane-launcher')).toBeNull();
    expect(screen.queryByText('打开标签页')).toBeNull();
  });
});
