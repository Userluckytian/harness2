// @vitest-environment jsdom
// Z2-01b 窗口外壳与浮层（依据 docs/refs/refs-zcode-layout.md Z-01 / Z-02 / Z-04 / §8）：
//   * DesktopTopOverlay：绝对定位浮层（不占布局高度）、高度 mac 56 / 其余 48、宽度跟随侧栏、
//     New Task 仅侧栏收起时出现、按钮 no-drag（CSS 契约见 frame-styles.test.ts）；
//   * 平台派生：windowFrameClass 圆角类 / topOverlayHeight / desktopPlatform 读取 preload 通道。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { DesktopTopOverlay } from '../../src/renderer/layout/DesktopTopOverlay.js';
import {
  desktopPlatform,
  isMacDesktop,
  topOverlayHeight,
  usesCustomWindowControls,
  windowFrameClass,
} from '../../src/renderer/platform.js';
import type { Harness2Api } from '../../src/shared/protocol.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { harness2?: unknown }).harness2;
});

describe('DesktopTopOverlay（Z-01：无 topbar，绝对定位浮层）', () => {
  it('展开态：宽度跟随侧栏、win 高度 48、有折叠按钮、无 New Task', () => {
    const onToggle = vi.fn();
    const onNew = vi.fn();
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={onToggle}
        onNewTask={onNew}
      />,
    );
    const bar = screen.getByTestId('desktop-top-overlay');
    expect(bar.getAttribute('data-height')).toBe('48');
    expect(bar.getAttribute('data-collapsed')).toBe('false');
    expect(bar.style.width).toBe('264px');
    expect(bar.className).toContain('desktop-top-overlay');
    expect(bar.className).not.toContain('desktop-top-overlay-fit');
    expect(screen.getByRole('button', { name: '侧栏开关' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull();
  });

  it('折叠态：宽度 w-fit（不写内联宽）、New Task 出现且可点', () => {
    const onNew = vi.fn();
    render(
      <DesktopTopOverlay
        platform="linux"
        sidebarCollapsed
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={onNew}
      />,
    );
    const bar = screen.getByTestId('desktop-top-overlay');
    expect(bar.getAttribute('data-collapsed')).toBe('true');
    expect(bar.className).toContain('desktop-top-overlay-fit');
    expect(bar.style.width).toBe('');
    const newTask = screen.getByRole('button', { name: 'New Task' });
    fireEvent.click(newTask);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('mac 高度 56（§8）且带红绿灯安全区类；折叠按钮回传动作', () => {
    const onToggle = vi.fn();
    render(
      <DesktopTopOverlay
        platform="darwin"
        sidebarCollapsed={false}
        sidebarWidth={300}
        onToggleSidebar={onToggle}
        onNewTask={vi.fn()}
      />,
    );
    const bar = screen.getByTestId('desktop-top-overlay');
    expect(bar.getAttribute('data-height')).toBe('56');
    expect(bar.className).toContain('desktop-top-overlay-mac');
    fireEvent.click(screen.getByRole('button', { name: '侧栏开关' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopTopOverlay 侧栏开关图标切换 / New Task 宽度动画（ZCode 复刻）', () => {
  it('win/linux：平时显品牌 mark，悬浮切开关图标（150ms class 切换）', () => {
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('button', { name: '侧栏开关' });
    expect(toggle.className).toContain('desktop-top-overlay-toggle');
    // 平时：品牌 mark 在场且未隐藏；开关图标未激活
    const mark = within(toggle).getByTestId('frame-top-overlay-toggle-mark');
    const icon = within(toggle).getByTestId('frame-top-overlay-toggle-icon');
    expect(mark.className).not.toContain('is-hidden');
    expect(icon.className).not.toContain('is-visible');
    expect(toggle.getAttribute('data-hover')).toBe('false');
    // 悬浮（jsdom 无真实 :hover，用 mouseOver 触发 React onMouseEnter）
    fireEvent.mouseOver(toggle);
    expect(toggle.getAttribute('data-hover')).toBe('true');
    expect(within(toggle).getByTestId('frame-top-overlay-toggle-mark').className).toContain('is-hidden');
    expect(within(toggle).getByTestId('frame-top-overlay-toggle-icon').className).toContain('is-visible');
    // 移出还原
    fireEvent.mouseOut(toggle);
    expect(toggle.getAttribute('data-hover')).toBe('false');
    expect(within(toggle).getByTestId('frame-top-overlay-toggle-icon').className).not.toContain('is-visible');
  });

  it('mac：无品牌 mark、恒显开关图标（ZCode mac 分支）', () => {
    render(
      <DesktopTopOverlay
        platform="darwin"
        sidebarCollapsed={false}
        sidebarWidth={300}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('button', { name: '侧栏开关' });
    expect(within(toggle).queryByTestId('frame-top-overlay-toggle-mark')).toBeNull();
    expect(within(toggle).getByTestId('frame-top-overlay-toggle-icon').className).toContain('is-visible');
  });

  it('New Task 常驻 DOM：展开态 aria-hidden + is-hidden（w-0），折叠态 is-visible（w-7）', () => {
    const { rerender } = render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const hidden = document.querySelector('.desktop-top-overlay-new-wrap') as HTMLElement;
    expect(hidden).not.toBeNull(); // 常驻（不再条件卸载）
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
    expect(hidden.className).toContain('is-hidden');
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull();

    rerender(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const shown = document.querySelector('.desktop-top-overlay-new-wrap') as HTMLElement;
    expect(shown.getAttribute('aria-hidden')).toBe('false');
    expect(shown.className).toContain('is-visible');
    expect(screen.getByRole('button', { name: 'New Task' })).toBeTruthy();
  });

  it('showNewTaskButton 显式覆盖（ZCode showNewTaskButton ?? !isSidebarVisible）', () => {
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed
        showNewTaskButton={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const wrap = document.querySelector('.desktop-top-overlay-new-wrap') as HTMLElement;
    expect(wrap.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: 'New Task' })).toBeNull();
  });
});

describe('DesktopTopOverlay 会话历史「后退 / 前进」（Z10-3）', () => {
  it('常驻渲染两枚 28×28 方钮（aria-label 逐字 后退/前进）；缺省历史 props → 均 disabled', () => {
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );
    const back = screen.getByRole('button', { name: '后退' }) as HTMLButtonElement;
    const forward = screen.getByRole('button', { name: '前进' }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
    expect(back.className).toContain('desktop-top-overlay-nav');
    expect(forward.className).toContain('desktop-top-overlay-nav');
    // 最左两枚：先于品牌标记之后的侧栏开关出现
    const bar = screen.getByTestId('desktop-top-overlay');
    expect(bar.firstElementChild).toBe(back);
    expect(back.nextElementSibling).toBe(forward);
  });

  it('canGoBack/canGoForward + 回调 → 可点并各触发一次', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
        canGoBack
        canGoForward
        onBack={onBack}
        onForward={onForward}
      />,
    );
    const back = screen.getByRole('button', { name: '后退' }) as HTMLButtonElement;
    const forward = screen.getByRole('button', { name: '前进' }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(false);
    fireEvent.click(back);
    fireEvent.click(forward);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it('边界 disabled：canGoBack=false（有回调）→ 后退不可点、点击不触发', () => {
    const onBack = vi.fn();
    render(
      <DesktopTopOverlay
        platform="win32"
        sidebarCollapsed={false}
        sidebarWidth={264}
        onToggleSidebar={vi.fn()}
        onNewTask={vi.fn()}
        canGoBack={false}
        canGoForward
        onBack={onBack}
        onForward={vi.fn()}
      />,
    );
    const back = screen.getByRole('button', { name: '后退' }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '前进' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(back);
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('平台派生（Z-02 / Z-04）', () => {
  it('windowFrameClass：win 5 / linux 16（最大化去圆角）/ mac 6 / 未知空', () => {
    expect(windowFrameClass('win32', false)).toBe('desktop-window-frame-win');
    expect(windowFrameClass('linux', false)).toBe('desktop-window-frame-linux');
    expect(windowFrameClass('linux', true)).toBe('desktop-window-frame-linux desktop-window-frame-maximized');
    expect(windowFrameClass('darwin', false)).toBe('desktop-window-frame-mac');
    expect(windowFrameClass(null, false)).toBe('');
  });

  it('topOverlayHeight：mac 56 / win-linux 48（§8）', () => {
    expect(topOverlayHeight('darwin')).toBe(56);
    expect(topOverlayHeight('win32')).toBe(48);
    expect(topOverlayHeight('linux')).toBe(48);
    expect(topOverlayHeight(null)).toBe(48);
  });

  it('desktopPlatform 读 preload 同步通道；缺失/非法值 → null（不臆造）', () => {
    expect(desktopPlatform()).toBeNull();
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = { platform: 'darwin' };
    expect(desktopPlatform()).toBe('darwin');
    expect(isMacDesktop()).toBe(true);
    expect(usesCustomWindowControls()).toBe(false);
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = { platform: 'linux' };
    expect(usesCustomWindowControls()).toBe(true);
    (window as unknown as { harness2: Partial<Harness2Api> }).harness2 = { platform: 'plan9' as never };
    expect(desktopPlatform()).toBeNull();
  });
});
