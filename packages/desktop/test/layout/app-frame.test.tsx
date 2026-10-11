// @vitest-environment jsdom
// AppFrame 四席位装配与三栅交互测试（Z-05 / Z-06 / Z-12 / Z-15 / D-10 / D-16，DOM 层）。
// 使用隔离注册表 + 测试用席位内容（不依赖 app-shared/renderer-sidebar），只验帧本身的装配与几何行为。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { createSlotRegistry, SlotHost, type SlotRegistry } from '../../src/renderer/slots/index.js';
import {
  declareFrameSeats,
  FRAME_ROOT_SEAT,
  FRAME_SEAT,
  FRAME_SEAT_ORDER,
  MAIN_CONVERSATION_KEY,
  registerFrameSeats,
  TERMINAL_SEAT,
} from '../../src/renderer/layout/frame-seats.js';
import { FRAME_SEAT_VIEWS } from '../../src/renderer/layout/frame-seat-views.js';
import { AppFrame } from '../../src/renderer/layout/AppFrame.js';
import { useFrameState } from '../../src/renderer/layout/use-frame.js';
import {
  AUTO_COLLAPSE_RESIZE_IDLE_MS,
  TERMINAL_MIN_PX,
  resolveTerminalHeight,
} from '../../src/renderer/layout/geometry.js';
import { REDUCED_MOTION_QUERY } from '../../src/renderer/layout/theme-presenter.js';
import type { FrameController } from '../../src/renderer/layout/frame-context.js';

let latest: FrameController | null = null;

function SeatContent({ label }: { label: string }): React.ReactNode {
  return <p>{label}</p>;
}

/** 隔离注册表：四席位 + root 装配 + 测试内容（会话页占 conversation key） */
function testRegistry(): SlotRegistry {
  const registry = createSlotRegistry();
  declareFrameSeats(registry);
  registerFrameSeats(registry, FRAME_SEAT_VIEWS);
  registry.inject({
    seat: FRAME_SEAT.sidebar,
    owner: 'ui-sidebar',
    component: SeatContent,
    props: { label: '侧栏内容' },
  });
  registry.inject({
    seat: FRAME_SEAT.main,
    key: MAIN_CONVERSATION_KEY,
    owner: 'ui-conversation',
    component: SeatContent,
    props: { label: '会话页' },
  });
  registry.inject({
    seat: FRAME_SEAT.main,
    key: 'plan',
    owner: 'ui-plan',
    component: SeatContent,
    props: { label: '计划面板' },
  });
  registry.inject({
    seat: FRAME_SEAT.rightbar,
    owner: 'ui-workspace',
    component: SeatContent,
    props: { label: '右栏内容' },
  });
  registry.inject({
    seat: FRAME_SEAT.overlay,
    owner: 'ui-settings',
    order: 0,
    component: SeatContent,
    props: { label: '设置覆层' },
  });
  registry.inject({
    seat: FRAME_SEAT.overlay,
    owner: 'ui-commands',
    order: 1,
    component: SeatContent,
    props: { label: '命令面板覆层' },
  });
  return registry;
}

function Harness({ viewportWidth, registry }: { viewportWidth: number; registry: SlotRegistry }): React.ReactNode {
  const frame = useFrameState({ registry, viewportWidth });
  latest = frame;
  return <AppFrame controller={frame} />;
}

function mount(
  viewportWidth: number,
  registry = testRegistry(),
): { registry: SlotRegistry; rerender: (w: number) => void } {
  const view = render(<Harness viewportWidth={viewportWidth} registry={registry} />);
  return {
    registry,
    rerender: (w: number) => view.rerender(<Harness viewportWidth={w} registry={registry} />),
  };
}

/** 右栏拖宽手柄当前读数（aria-valuenow；「基点 = 渲染宽度」断言用） */
function rightbarHandleValue(): string | null {
  return screen.getByRole('separator', { name: '拖宽右栏' }).getAttribute('aria-valuenow');
}

/** matchMedia 替身（jsdom 无原生实现） */ function stubMatchMedia(predicate: (query: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: predicate(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  latest = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('四席位装配（D-10）', () => {
  it('内建 root 槽按顺序装配 sidebar → main → rightbar → shell.overlay', () => {
    const registry = testRegistry();
    expect(registry.keys(FRAME_ROOT_SEAT)).toEqual([...FRAME_SEAT_ORDER]);
    const { container } = render(<Harness viewportWidth={1400} registry={registry} />);
    const seats = [...container.querySelectorAll('[data-seat]')].map((n) => n.getAttribute('data-seat'));
    expect(seats).toEqual([FRAME_SEAT.sidebar, FRAME_SEAT.main, FRAME_SEAT.rightbar, FRAME_SEAT.overlay]);
    expect(document.querySelector('[data-seat="rightbar"]')?.hasAttribute('hidden')).toBe(true); // 关闭态：hidden
    expect(screen.getByText('侧栏内容')).toBeTruthy();
    expect(screen.getByText('会话页')).toBeTruthy();
    expect(screen.getByText('设置覆层')).toBeTruthy();
    expect(screen.getByText('命令面板覆层')).toBeTruthy();
  });

  it('main 是 keyed：默认渲染 conversation（会话页占保留 key），非 conversation key 时渲染全局面板', () => {
    const { rerender } = mount(1400);
    expect(screen.getByText('会话页')).toBeTruthy();
    expect(screen.queryByText('计划面板')).toBeNull();
    expect(screen.getByText('会话页').closest('[data-slot-key]')?.getAttribute('data-slot-key')).toBe(
      MAIN_CONVERSATION_KEY,
    );

    act(() => latest!.dispatch({ type: 'main/select-key', key: 'plan' }));
    expect(screen.queryByText('会话页')).toBeNull();
    expect(screen.getByText('计划面板')).toBeTruthy();
    rerender(1400);
    expect(screen.getByText('计划面板')).toBeTruthy();
  });

  it('root 槽里只有四个席位：未装配的 root 槽渲染兜底（不并存第二套布局）', () => {
    const registry = testRegistry();
    expect(registry.entries(FRAME_ROOT_SEAT).map((e) => e.key)).toEqual([...FRAME_SEAT_ORDER]);
    // 只声明、未注册视图的注册表：root 为空 → 走兜底，不会有任何残留布局
    const empty = createSlotRegistry();
    declareFrameSeats(empty);
    render(<SlotHost registry={empty} seat={FRAME_ROOT_SEAT} fallback={<i>空 root</i>} />);
    expect(screen.getByText('空 root')).toBeTruthy();
  });
});

describe('侧栏拖宽与折叠（Z-05 / Z-06）', () => {
  it('拖宽手柄：指针拖动改宽并按 264～容器 50% 钳制', () => {
    mount(1400);
    const handle = screen.getByRole('separator', { name: '拖宽侧栏' });
    expect(handle.getAttribute('aria-valuenow')).toBe('264');
    expect(handle.getAttribute('aria-valuemin')).toBe('264');
    expect(handle.getAttribute('aria-valuemax')).toBe('700'); // 1400 × 0.5

    // 指针拖动 +100px
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 400 });
      fireEvent.pointerUp(window, {});
    });
    expect(screen.getByRole('separator', { name: '拖宽侧栏' }).getAttribute('aria-valuenow')).toBe('364');
    expect(latest!.state.sidebarWidth).toBe(364);

    // 拖到越界：上界 700
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 1200 });
      fireEvent.pointerUp(window, {});
    });
    expect(latest!.state.sidebarWidth).toBe(700);

    // 键盘：← 每次 16px，同样钳制
    act(() => {
      fireEvent.keyDown(screen.getByRole('separator', { name: '拖宽侧栏' }), { key: 'ArrowLeft' });
    });
    expect(latest!.state.sidebarWidth).toBe(684);
  });

  it('折叠后只剩 4px（Z-06：无图标轨道），内容只隐藏不卸载，拖宽手柄消失', () => {
    mount(1400);
    act(() => latest!.dispatch({ type: 'sidebar/toggle' }));
    const sidebar = document.querySelector('[data-seat="sidebar"]');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('true');
    expect(sidebar?.getAttribute('data-width')).toBe('4');
    // 不再有 railed 标记，也没有任何图标轨道
    expect(sidebar?.getAttribute('class')).not.toContain('app-frame-sidebar-railed');
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="sidebar-region-rail"]').length).toBe(0);
    expect(screen.queryByRole('separator', { name: '拖宽侧栏' })).toBeNull();
    // 只隐藏不卸载：内容仍在 DOM
    expect(screen.getByText('侧栏内容')).toBeTruthy();
    // 再 toggle 展开回 264
    act(() => latest!.dispatch({ type: 'sidebar/toggle' }));
    expect(latest!.state.sidebarCollapsed).toBe(false);
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('264');
  });

  it('自动收起（Z-15）：窗口 resize 后 idle 300ms 才按会话列宽判定', async () => {
    const { rerender } = mount(1400);
    expect(latest!.geometry.sidebarCollapsed).toBe(false);
    expect(latest!.state.sidebarCollapsed).toBe(false);
    // 缩窗到 600：会话列 = 600 − 264 = 336 < 360 → idle 后收左栏
    rerender(600);
    expect(latest!.state.sidebarCollapsed).toBe(false); // 未到 idle 前不判定
    await waitFor(() => expect(latest!.state.sidebarCollapsed).toBe(true), {
      timeout: AUTO_COLLAPSE_RESIZE_IDLE_MS + 800,
    });
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('4');
    // 挂载不算 resize：即便初始视口就很窄也不自动收起
    cleanup();
    mount(600);
    expect(latest!.state.sidebarCollapsed).toBe(false);
  });
});

describe('右栏与让步链（Z-12 / D-12）', () => {
  it('打开右栏：首开取**内容区宽** 45%（1400−264=1136 → 511），手柄存在；上限 内容区 65%', () => {
    mount(1400);
    act(() => latest!.dispatch({ type: 'rightbar/toggle' }));
    const rightbar = document.querySelector('[data-seat="rightbar"]');
    expect(rightbar?.getAttribute('data-width')).toBe('511');
    expect(screen.getByText('右栏内容')).toBeTruthy();
    const handle = screen.getByRole('separator', { name: '拖宽右栏' });
    expect(handle.getAttribute('aria-valuemax')).toBe('738'); // 1136 × 0.65
    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // 右栏手柄向左 = 变宽
    });
    expect(latest!.state.rightbarWidth).toBe(527);
  });

  it('让步链（上游 columns.ts:50-57）：先把右栏缩到 available → 轨道摘除（canShow=false）→ 才压中栏', () => {
    // 视口 1200（宽屏）+ 侧栏拖到 420 + 右栏首开 351（内容区 780 × 45%）
    const { rerender } = mount(1200);
    act(() => latest!.dispatch({ type: 'sidebar/width', width: 420 }));
    act(() => latest!.dispatch({ type: 'rightbar/toggle' }));

    // ① 内容区 780：右栏 351（45%）在 available 460 内放得下 → 无让步；会话列 429
    const rightbar = document.querySelector('[data-seat="rightbar"]');
    expect(rightbar?.getAttribute('data-width')).toBe('351');
    expect(rightbar?.getAttribute('data-shrunk')).toBe('false');
    expect(rightbar?.getAttribute('data-can-show')).toBe('true');
    expect(latest!.geometry.main).toBe(429);
    expect(latest!.geometry.shortage).toBe(0);
    expect(latest!.state.rightbarWidth).toBe(351);

    // ② available 恰好 240 的边界：视口 980（内容区 560 − 320 = 240）→ 右栏被压到 240（偏好 351）；
    //    手柄读数 = **渲染宽度** 240（不是存储偏好 351）
    rerender(980);
    expect(rightbar?.getAttribute('data-width')).toBe('240');
    expect(rightbar?.getAttribute('data-shrunk')).toBe('true');
    expect(rightbarHandleValue()).toBe('240');
    expect(latest!.state.rightbarWidth).toBe(351);
    expect(latest!.geometry.main).toBe(320);
    expect(latest!.geometry.rightbarCanShow).toBe(true);

    // ③ available 239（视口 979）→ 右栏轨道摘除（宽度归零、canShow=false、手柄消失），会话列拿全部剩余
    rerender(979);
    expect(rightbar?.getAttribute('data-width')).toBe('0');
    expect(rightbar?.getAttribute('data-can-show')).toBe('false');
    expect(latest!.geometry.rightbarCanShow).toBe(false);
    expect(latest!.geometry.main).toBe(559);
    expect(latest!.geometry.mainCompressed).toBe(false);
    expect(screen.queryByRole('separator', { name: '拖宽右栏' })).toBeNull();
    expect(latest!.state.rightbarWidth).toBe(351); // 轨道摘除也不改偏好

    // ④ 中栏没有任何「空间不足」提示条（D-12 报告落占用方，不落中栏）
    expect(document.querySelector('[data-shortage]')).toBeNull();
    expect(document.querySelector('.app-frame-shortage')).toBeNull();
    expect(document.querySelector('[data-seat="main"]')?.textContent).toBe('会话页');
  });

  it('右栏占用方收到几何 props（width / viewportWidth / canShow）', () => {
    const seen: Array<{ width: number; viewportWidth: number; canShow: boolean }> = [];
    function RightbarProbe(props: { width: number; viewportWidth: number; canShow: boolean }): React.ReactNode {
      seen.push({ width: props.width, viewportWidth: props.viewportWidth, canShow: props.canShow });
      return <p>右栏内容</p>;
    }
    const registry = testRegistry();
    registry.inject({ seat: FRAME_SEAT.rightbar, owner: 'ui-workspace-probe', component: RightbarProbe, priority: 9 });
    const { rerender } = mount(1200, registry);
    act(() => latest!.dispatch({ type: 'sidebar/width', width: 420 }));
    act(() => latest!.dispatch({ type: 'rightbar/toggle' }));
    expect(seen.at(-1)).toEqual({ width: 351, viewportWidth: 1200, canShow: true });
    // 空间不足：占用方拿到 width 0 + canShow false（据此自关，壳不代关）
    rerender(979);
    expect(seen.at(-1)).toEqual({ width: 0, viewportWidth: 979, canShow: false });
  });

  it('右栏关闭：节点隐藏（hidden，不占布局）且拖宽手柄不渲染', () => {
    mount(1400);
    const aside = document.querySelector('[data-seat="rightbar"]');
    expect(aside?.hasAttribute('hidden')).toBe(true);
    expect(aside?.getAttribute('data-open')).toBe('false');
    expect(screen.queryByRole('separator', { name: '拖宽右栏' })).toBeNull();
  });

  it('拖宽期间席位容器带 data-dragging（拖动无宽度过渡延迟）', () => {
    mount(1400);
    const handle = screen.getByRole('separator', { name: '拖宽侧栏' });
    expect(document.querySelector('[data-seat="sidebar"]')?.hasAttribute('data-dragging')).toBe(false);
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 340 });
    });
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-dragging')).toBe('true');
    act(() => {
      fireEvent.pointerUp(window, {});
    });
    expect(document.querySelector('[data-seat="sidebar"]')?.hasAttribute('data-dragging')).toBe(false);
  });
});

describe('中栏内层纵向分栏 conversation | terminal（Z2-03 / Z-12）', () => {
  /** 在测试注册表上注入终端内容（注册缝；当前无真实终端内容提供方） */
  function withTerminal(registry: SlotRegistry): SlotRegistry {
    registry.inject({
      seat: TERMINAL_SEAT,
      owner: 'ui-terminal',
      component: SeatContent,
      props: { label: '终端内容' },
    });
    return registry;
  }

  it('未注册终端：不出现任何 terminal 痕迹（无面板 / 无开关 / 无分隔条），旧结构原样', () => {
    mount(1400);
    expect(document.querySelector('[data-panel="terminal"]')).toBeNull();
    expect(document.querySelector('[data-panel="conversation"]')).toBeNull();
    expect(screen.queryByTestId('terminal-toggle')).toBeNull();
    expect(screen.queryByRole('separator', { name: '调整终端高度' })).toBeNull();
    // 旧结构（内容列顶部留白条 + 会话内容）仍在
    expect(document.querySelector('[data-seat="main"] .app-frame-drag-strip')).not.toBeNull();
    expect(document.querySelector('[data-seat="main"]')?.textContent).toBe('会话页');
  });

  it('注册后：terminal 面板出现且默认折叠（data-open=false、高度 0、无分隔条）', () => {
    mount(1400, withTerminal(testRegistry()));
    const terminal = document.querySelector('[data-panel="terminal"]');
    expect(terminal).not.toBeNull();
    expect(document.querySelector('[data-panel="conversation"]')).not.toBeNull();
    expect(terminal?.getAttribute('data-open')).toBe('false');
    expect(terminal?.getAttribute('data-height')).toBe('0');
    expect(screen.getByTestId('terminal-toggle').getAttribute('aria-pressed')).toBe('false');
    // 分隔条只在 terminal 展开时渲染
    expect(screen.queryByRole('separator', { name: '调整终端高度' })).toBeNull();
  });

  it('展开/收起：分隔条为 horizontal、高度落最小高 140（主列未测量）；收起回 0 并撤掉分隔条', () => {
    mount(1400, withTerminal(testRegistry()));
    const terminal = document.querySelector('[data-panel="terminal"]') as HTMLElement;
    act(() => fireEvent.click(screen.getByTestId('terminal-toggle')));
    expect(terminal.getAttribute('data-open')).toBe('true');
    expect(terminal.getAttribute('data-height')).toBe(String(TERMINAL_MIN_PX));
    const separator = screen.getByRole('separator', { name: '调整终端高度' });
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separator.getAttribute('aria-valuemin')).toBe(String(TERMINAL_MIN_PX));
    act(() => fireEvent.click(screen.getByTestId('terminal-toggle')));
    expect(terminal.getAttribute('data-open')).toBe('false');
    expect(terminal.getAttribute('data-height')).toBe('0');
    expect(screen.queryByRole('separator', { name: '调整终端高度' })).toBeNull();
  });

  it('主列高已知（600）：展开高 = 180（30%）、上限 300（50%）；↑ 增高且不越上限', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList?.contains('app-frame-main-column') ? 600 : 0;
      },
    });
    try {
      mount(1400, withTerminal(testRegistry()));
      const terminal = document.querySelector('[data-panel="terminal"]') as HTMLElement;
      act(() => fireEvent.click(screen.getByTestId('terminal-toggle')));
      expect(resolveTerminalHeight(600)).toBe(180); // 纯函数口径（30%）
      expect(terminal.getAttribute('data-height')).toBe('180');
      const separator = screen.getByRole('separator', { name: '调整终端高度' });
      expect(separator.getAttribute('aria-valuemax')).toBe('300'); // 600 × 0.5
      expect(separator.getAttribute('aria-valuenow')).toBe('180');
      // 手柄在终端上沿：↑ = 增高
      act(() => fireEvent.keyDown(separator, { key: 'ArrowUp' }));
      expect(terminal.getAttribute('data-height')).toBe('196');
      // 连按到顶：钳制在 50%（300）
      for (let i = 0; i < 40; i += 1) fireEvent.keyDown(separator, { key: 'ArrowUp' });
      expect(terminal.getAttribute('data-height')).toBe('300');
    } finally {
      if (original !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
    }
  });

  it('注册缝响应式：挂载后注入即出现开关与面板，dispose 后痕迹消失', () => {
    const registry = testRegistry();
    render(<Harness viewportWidth={1400} registry={registry} />);
    expect(screen.queryByTestId('terminal-toggle')).toBeNull();
    let dispose: () => void = () => {};
    act(() => {
      dispose = registry.inject({
        seat: TERMINAL_SEAT,
        owner: 'ui-terminal',
        component: SeatContent,
        props: { label: '终端内容' },
      });
    });
    expect(screen.getByTestId('terminal-toggle')).toBeTruthy();
    expect(document.querySelector('[data-panel="terminal"]')).not.toBeNull();
    act(() => dispose());
    expect(screen.queryByTestId('terminal-toggle')).toBeNull();
    expect(document.querySelector('[data-panel="terminal"]')).toBeNull();
  });
});

describe('降动效（D-16）', () => {
  it('系统 prefers-reduced-motion 命中 → 帧根带 data-reduced-motion 标记与类', () => {
    stubMatchMedia((q) => q === REDUCED_MOTION_QUERY);
    mount(1400);
    const root = document.querySelector('.app-frame');
    expect(root?.getAttribute('data-reduced-motion')).toBe('true');
    expect(root?.className).toContain('app-frame-reduced-motion');
  });

  it('未命中 → 不写该属性（不制造假的降动效状态）', () => {
    stubMatchMedia(() => false);
    mount(1400);
    const root = document.querySelector('.app-frame');
    expect(root?.hasAttribute('data-reduced-motion')).toBe(false);
    expect(root?.className).not.toContain('app-frame-reduced-motion');
  });
});
