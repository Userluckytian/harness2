// @vitest-environment jsdom
// AppFrame 四席位装配与三栅交互测试（D-10～D-13 / D-16，DOM 层）。
// 使用隔离注册表 + 测试用席位内容（不依赖 app-shared/renderer-sidebar），只验帧本身的装配与几何行为。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { createSlotRegistry, SlotHost, type SlotRegistry } from '../../src/renderer/slots/index.js';
import {
  declareFrameSeats,
  FRAME_ROOT_SEAT,
  FRAME_SEAT,
  FRAME_SEAT_ORDER,
  MAIN_CONVERSATION_KEY,
  registerFrameSeats,
} from '../../src/renderer/layout/frame-seats.js';
import { FRAME_SEAT_VIEWS } from '../../src/renderer/layout/frame-seat-views.js';
import { AppFrame } from '../../src/renderer/layout/AppFrame.js';
import { useFrameState } from '../../src/renderer/layout/use-frame.js';
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

/** 右栏拖宽手柄当前读数（aria-valuenow；P1-2 的「基点 = 渲染宽度」断言用） */
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

describe('侧栏拖宽与轨道（D-11 / D-13）', () => {
  it('拖宽手柄：指针拖动改宽并按 264～420 钳制；宽高状态只在本帧内生效', () => {
    mount(1400);
    const handle = screen.getByRole('separator', { name: '拖宽侧栏' });
    expect(handle.getAttribute('aria-valuenow')).toBe('280');
    expect(handle.getAttribute('aria-valuemin')).toBe('264');
    expect(handle.getAttribute('aria-valuemax')).toBe('420');

    // 指针拖动 +100px
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 400 });
      fireEvent.pointerUp(window, {});
    });
    expect(screen.getByRole('separator', { name: '拖宽侧栏' }).getAttribute('aria-valuenow')).toBe('380');
    expect(latest!.state.sidebarWidth).toBe(380);

    // 拖到越界：上界 420
    act(() => {
      fireEvent.pointerDown(handle, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 900 });
      fireEvent.pointerUp(window, {});
    });
    expect(latest!.state.sidebarWidth).toBe(420);

    // 键盘：← 每次 16px，同样钳制
    act(() => {
      fireEvent.keyDown(screen.getByRole('separator', { name: '拖宽侧栏' }), { key: 'ArrowLeft' });
    });
    expect(latest!.state.sidebarWidth).toBe(404);
  });

  it('收起后保留 56px 容器轨道（不是消失），且拖宽手柄不再显示（P4-C：轨道内容归侧栏）', () => {
    mount(1400);
    act(() => latest!.dispatch({ type: 'sidebar/toggle' }));
    const sidebar = document.querySelector('[data-seat="sidebar"]');
    expect(sidebar?.getAttribute('data-collapsed')).toBe('true');
    expect(sidebar?.getAttribute('data-width')).toBe('56');
    expect(sidebar?.getAttribute('class')).toContain('app-frame-sidebar-railed');
    // P4-C 轨道归属裁决：帧只提供轨道容器（宽度 56px），轨道内容由 SidebarRoot 渲染 ——
    // 帧不再自带「侧栏控制轨道」/展开按钮，避免两边各画一条 56px 轨道。
    expect(document.querySelectorAll('.app-frame-rail').length).toBe(0);
    expect(screen.queryByRole('group', { name: '侧栏控制轨道' })).toBeNull();
    expect(screen.queryByRole('separator', { name: '拖宽侧栏' })).toBeNull();
    // 帧的 toggle 动作仍可往返（实际轨道控件在 SidebarRoot，另有单测/装配测试覆盖）
    act(() => latest!.dispatch({ type: 'sidebar/toggle' }));
    expect(latest!.state.sidebarCollapsed).toBe(false);
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('280');
  });

  it('视口 < 1024px 自动收起；变宽跨阈值回到宽态偏好（D-13，双向重置）', () => {
    const { rerender } = mount(900);
    expect(latest!.geometry.sidebarRail).toBe(true);
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('56');
    rerender(1400);
    // 跨阈值重置窄屏 override → 回到宽态偏好（侧栏展开 280），不是把窄屏的临时收起写死
    expect(latest!.state.narrowExpanded).toBe(false);
    expect(latest!.geometry.sidebarRail).toBe(false);
    expect(document.querySelector('[data-seat="sidebar"]')?.getAttribute('data-width')).toBe('280');
  });
});

describe('右栏与让步链（D-11 / D-12）', () => {
  it('打开右栏：首开取视口 45%，手柄存在；宽度上限 70%', () => {
    mount(1400);
    act(() => latest!.dispatch({ type: 'rightbar/toggle' }));
    const rightbar = document.querySelector('[data-seat="rightbar"]');
    expect(rightbar?.getAttribute('data-width')).toBe('630');
    expect(screen.getByText('右栏内容')).toBeTruthy();
    const handle = screen.getByRole('separator', { name: '拖宽右栏' });
    expect(handle.getAttribute('aria-valuemax')).toBe('980'); // 1400 × 0.7
    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // 右栏手柄向左 = 变宽
    });
    expect(latest!.state.rightbarWidth).toBe(646);
  });

  it('让步链（上游 columns.ts:50-57）：先把右栏缩到 available → 轨道摘除（canShow=false）→ 才压中栏', () => {
    // 视口 1200（宽屏，不触发自动收起）+ 侧栏拖到上限 420 + 右栏首开 540（1200 × 45%）
    const { rerender } = mount(1200);
    act(() => latest!.dispatch({ type: 'sidebar/width', width: 420 }));
    act(() => latest!.dispatch({ type: 'rightbar/toggle' }));

    // ① 有轨道时先缩右栏：available = 1200−420−400 = 380 → 右栏 380（不是 540），中栏恰好 400
    const rightbar = document.querySelector('[data-seat="rightbar"]');
    expect(rightbar?.getAttribute('data-width')).toBe('380');
    expect(rightbar?.getAttribute('data-shrunk')).toBe('true');
    expect(rightbar?.getAttribute('data-can-show')).toBe('true');
    expect(latest!.geometry.main).toBe(400);
    expect(latest!.geometry.shortage).toBe(0);
    expect(latest!.state.rightbarWidth).toBe(540); // 偏好宽度未被改写

    // ② available 恰好 300 的边界：右栏 300，中栏仍 400；手柄读数 = **渲染宽度** 300（P1-2，
    //    不是存储偏好 540）—— 抓住被让步链压窄的面板不得跳回偏好
    rerender(1120);
    expect(rightbar?.getAttribute('data-width')).toBe('300');
    expect(rightbarHandleValue()).toBe('300');
    expect(latest!.state.rightbarWidth).toBe(540);
    expect(latest!.geometry.main).toBe(400);
    expect(latest!.geometry.rightbarCanShow).toBe(true);

    // ③ available 299 → 右栏轨道摘除（宽度归零、canShow=false、手柄消失），中栏拿全部剩余
    rerender(1119);
    expect(rightbar?.getAttribute('data-width')).toBe('0');
    expect(rightbar?.getAttribute('data-can-show')).toBe('false');
    expect(latest!.geometry.rightbarCanShow).toBe(false);
    expect(latest!.geometry.main).toBe(699);
    expect(latest!.geometry.mainCompressed).toBe(false);
    expect(screen.queryByRole('separator', { name: '拖宽右栏' })).toBeNull();
    expect(latest!.state.rightbarWidth).toBe(540); // 轨道摘除也不改偏好

    // ④ 中栏没有任何「空间不足」提示条（D-12 报告落占用方，不落中栏）
    expect(document.querySelector('[data-shortage]')).toBeNull();
    expect(document.querySelector('.app-frame-shortage')).toBeNull();
    expect(document.querySelector('[data-seat="main"]')?.textContent).toBe('会话页');
  });

  it('右栏占用方收到几何 props（上游 AppFrame.tsx:227 的 width / viewportWidth / canShow）', () => {
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
    expect(seen.at(-1)).toEqual({ width: 380, viewportWidth: 1200, canShow: true });
    // 空间不足：占用方拿到 width 0 + canShow false（据此自关，壳不代关）
    rerender(1119);
    expect(seen.at(-1)).toEqual({ width: 0, viewportWidth: 1119, canShow: false });
  });

  it('右栏关闭：节点隐藏（hidden，不占布局）且拖宽手柄不渲染（D-11「关闭时不显示手柄」）', () => {
    mount(1400);
    const aside = document.querySelector('[data-seat="rightbar"]');
    expect(aside?.hasAttribute('hidden')).toBe(true);
    expect(aside?.getAttribute('data-open')).toBe('false');
    expect(screen.queryByRole('separator', { name: '拖宽右栏' })).toBeNull();
  });

  it('拖宽期间席位容器带 data-dragging（P2-2：拖动无宽度过渡延迟）', () => {
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
