// 四个帧席位容器（D-10 的四子席位视图）：
//   sidebar —— 可拖宽 264～容器 50%（Z-05）；折叠后 4px、**无图标轨道**（Z-06）
//   main    —— keyed 席位宿主（conversation = 会话界面）；Z2-03 起内层纵向分栏 conversation | terminal
//   rightbar—— 可拖宽（首开 内容区 45%、上限 内容区 65%）；仅普通展开态显示手柄（Z-12）；
//              空间不足时收到 canShow=false props 并自行关闭（D-12，见 shell-seat-contents）
//   overlay —— 窗口级覆层席位宿主
import { useEffect, useRef, useState } from 'react';
import { SlotHost, useSeatEntries } from '../slots/index.js';
import { FRAME_SEAT, TERMINAL_SEAT } from './frame-seats.js';
import { useFrame } from './frame-context.js';
import {
  clampTerminalHeight,
  resolveTerminalHeight,
  RIGHTBAR_MIN_PX,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_STEP_PX,
  sidebarMaxWidth,
  TERMINAL_MAX_RATIO,
  TERMINAL_MIN_PX,
} from './geometry.js';
import { rightbarMaxWidth } from './frame-state.js';

/** 拖宽手柄（指针 + 键盘；role=separator 带 aria 值域，D-11 的「可拖拽缩放」）。
 *  edge 决定轴向与方向：left/right = 竖向（列宽），top/bottom = 横向（行高，Z2-03 终端分隔条）。 */
function ResizeHandle({
  edge,
  label,
  value,
  min,
  max,
  onResize,
  onDraggingChange,
}: {
  edge: 'left' | 'right' | 'top' | 'bottom';
  label: string;
  value: number;
  min: number;
  max: number;
  onResize: (px: number) => void;
  /** 拖动起止通知（席位容器据此挂 data-dragging，拖动期间暂停宽度过渡） */
  onDraggingChange?: (dragging: boolean) => void;
}): React.ReactNode {
  const [dragging, setDragging] = useState(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onDraggingChangeRef = useRef(onDraggingChange);
  onDraggingChangeRef.current = onDraggingChange;
  const stopRef = useRef<(() => void) | null>(null);

  // 横向手柄（top/bottom）沿 Y 轴拖动，竖向手柄沿 X 轴
  const horizontal = edge === 'top' || edge === 'bottom';
  // 手柄在远侧（right/bottom）时，向 +x/+y 拖动即增大尺寸；在近侧（left/top）时相反
  const sign = edge === 'right' || edge === 'bottom' ? 1 : -1;

  // 卸载时收掉在途拖拽的全局监听（不留在 window 上）
  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  // 指针手势：pointerdown 同步挂 window 监听（不等 effect 落地，拖拽起手永不丢帧）
  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    stopRef.current?.();
    const originX = e.clientX;
    const originY = e.clientY;
    const startValue = value;
    const onMove = (ev: PointerEvent): void => {
      const delta = horizontal ? ev.clientY - originY : ev.clientX - originX;
      onResizeRef.current(startValue + sign * delta);
    };
    const stop = (): void => {
      setDragging(false);
      onDraggingChangeRef.current?.(false);
      stopRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    stopRef.current = stop;
    setDragging(true);
    onDraggingChangeRef.current?.(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`app-frame-resizer app-frame-resizer-${horizontal ? 'horizontal' : 'vertical'} app-frame-resizer-${edge}${
        dragging ? ' app-frame-resizer-dragging' : ''
      }`}
      data-resizer={edge}
      onPointerDown={startDrag}
      onKeyDown={(e) => {
        const forward = horizontal ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
        const backward = horizontal ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
        if (!forward && !backward) return;
        e.preventDefault();
        onResize(value + (forward ? 1 : -1) * sign * SIDEBAR_RESIZE_STEP_PX);
      }}
    />
  );
}

/** 侧栏（Z-05 拖宽 + Z-06 折叠 4px、无图标轨道；内容归 SidebarRoot，帧只给容器宽度） */
function SidebarSeatView(): React.ReactNode {
  const { state, geometry, registry, viewportWidth, dispatch } = useFrame();
  const collapsed = geometry.sidebarCollapsed;
  const [dragging, setDragging] = useState(false);
  return (
    <aside
      className="app-frame-sidebar"
      style={{ width: `${geometry.sidebar}px` }}
      data-seat={FRAME_SEAT.sidebar}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-width={geometry.sidebar}
      data-dragging={dragging ? 'true' : undefined}
      aria-label="侧栏"
    >
      {/* Z-07 分区 0：左栏顶部 48px 拖拽条（无独立顶栏；浮层条与内容列留白条见 Z-01/Z-03） */}
      <div className="app-frame-sidebar-drag" aria-hidden="true" />
      {/* Z-06：折叠后只剩 4px，**没有任何图标轨道**；展开内容仍在 DOM（只隐藏不卸载），
          由 SidebarRoot 用 opacity-0 + pointer-events-none 隐藏。 */}
      <div className="app-frame-seat-body">
        <SlotHost
          registry={registry}
          seat={FRAME_SEAT.sidebar}
          fallback={<p className="app-frame-seat-empty">侧栏席位未装配</p>}
        />
      </div>
      {!collapsed && (
        <ResizeHandle
          edge="right"
          label="拖宽侧栏"
          value={state.sidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={sidebarMaxWidth(viewportWidth)}
          onResize={(px) => dispatch({ type: 'sidebar/width', width: px })}
          onDraggingChange={setDragging}
        />
      )}
    </aside>
  );
}

/** 中栏（keyed 席位宿主；conversation 为会话界面保留 key）—— 帧不在中栏摆任何空间不足提示条（D-12）。
 *  Z2-03 / Z-12：内层纵向分栏 conversation（min 35%）| terminal。
 *  terminal 是**注册缝**（main.terminal 席位）：只有被注入内容时才渲染面板与开关；
 *  未注入时与 Z2-01 旧结构完全一致（不出现任何 terminal 痕迹，禁止假入口）。 */
function MainSeatView(): React.ReactNode {
  const { state, registry } = useFrame();
  const terminalEntries = useSeatEntries(registry, TERMINAL_SEAT);
  const terminalRegistered = terminalEntries.length > 0;
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [columnHeight, setColumnHeight] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number | null>(null);

  // 终端展开高度按**主列实测高**算（30%，钳制 140～50%）；未注册时不测量、不监听
  useEffect(() => {
    if (!terminalRegistered) return;
    const el = columnRef.current;
    if (el === null) return;
    const measure = (): void => setColumnHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [terminalRegistered]);

  if (!terminalRegistered) {
    // 未注册终端：旧结构（内容列顶部 4px 留白条 + main 席位宿主），不出现任何 terminal 痕迹
    return (
      <div className="main app-frame-main" data-seat={FRAME_SEAT.main} data-main-key={state.mainKey}>
        <div className="app-frame-drag-strip" aria-hidden="true" />
        <SlotHost registry={registry} seat={FRAME_SEAT.main} activeKey={state.mainKey} />
      </div>
    );
  }

  // 终端展开高度：用户拖过的像素优先，否则取主列高 30%，一律钳制在 [140, 主列高 50%]
  const terminalHeightPx = terminalOpen
    ? clampTerminalHeight(columnHeight, terminalHeight ?? resolveTerminalHeight(columnHeight))
    : 0;
  const conversationHeight = Math.max(0, columnHeight - terminalHeightPx);
  const terminalMaxHeightPx = Math.round(Math.max(0, columnHeight) * TERMINAL_MAX_RATIO);

  return (
    <div className="main app-frame-main" data-seat={FRAME_SEAT.main} data-main-key={state.mainKey}>
      <div className="app-frame-drag-strip" aria-hidden="true" />
      {/* 内层纵向分栏（Z-12）：上 conversation（flex 填满剩余，≥50% → 满足 min 35%），下 terminal */}
      <div className="app-frame-main-column" ref={columnRef} data-column-height={columnHeight}>
        <div
          className="app-frame-conversation-panel"
          data-panel="conversation"
          data-open="true"
          data-height={conversationHeight}
        >
          <SlotHost registry={registry} seat={FRAME_SEAT.main} activeKey={state.mainKey} />
        </div>
        {terminalOpen && (
          <ResizeHandle
            edge="top"
            label="调整终端高度"
            value={terminalHeightPx}
            min={TERMINAL_MIN_PX}
            max={Math.max(TERMINAL_MIN_PX, terminalMaxHeightPx)}
            onResize={(px) => setTerminalHeight(clampTerminalHeight(columnHeight, px))}
          />
        )}
        {/* terminal 面板：默认高度 0（只隐藏不卸载，内容仍挂载）；展开高度见上 */}
        <div
          className="app-frame-terminal-panel"
          data-panel="terminal"
          data-open={terminalOpen ? 'true' : 'false'}
          data-height={terminalHeightPx}
          style={{ height: `${terminalHeightPx}px` }}
        >
          <SlotHost
            registry={registry}
            seat={TERMINAL_SEAT}
            ownerProps={{ open: terminalOpen, height: terminalHeightPx, columnHeight }}
          />
        </div>
        {/* 终端开关（注册缝存在时才出现）：默认收起，点按展开/收起 */}
        <div className="flex flex-none items-center justify-end h-7 px-1.5" data-testid="terminal-bar">
          <button
            type="button"
            data-testid="terminal-toggle"
            aria-pressed={terminalOpen}
            className="text-ui-sm text-foreground-subtle hover:text-foreground hover:bg-surface-hover cursor-pointer rounded px-2 py-0.5"
            onClick={() => setTerminalOpen((open) => !open)}
          >
            终端
          </button>
        </div>
      </div>
    </div>
  );
}

/** 右栏（D-11 拖宽 + 手柄仅在普通展开态显示；D-12 让步对象） */
function RightbarSeatView(): React.ReactNode {
  const { state, geometry, registry, viewportWidth, dispatch } = useFrame();
  const [dragging, setDragging] = useState(false);
  // 关闭时保留挂载（hidden），面板内部的标签页选择等瞬时视图状态不丢；
  // hidden → display:none，不占布局、不可聚焦；手柄只在「展开且非全屏且有轨道」时渲染（D-11）。
  return (
    <aside
      className="app-frame-rightbar"
      hidden={!state.rightbarOpen}
      style={{ width: `${geometry.rightbar}px` }}
      data-seat={FRAME_SEAT.rightbar}
      data-open={state.rightbarOpen ? 'true' : 'false'}
      data-width={geometry.rightbar}
      data-shrunk={geometry.rightbarShrunk ? 'true' : 'false'}
      data-can-show={geometry.rightbarCanShow ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : undefined}
      aria-label="右栏"
    >
      <div className="app-frame-seat-body">
        <SlotHost
          registry={registry}
          seat={FRAME_SEAT.rightbar}
          /* 占用方 props（上游 AppFrame.tsx:227）：渲染宽度（不是偏好）、视口宽、能否以普通形态在场。
             空间不足（canShow=false）由占用方收到后自行关闭（D-12，见 shell-seat-contents）。 */
          ownerProps={{ width: geometry.rightbar, viewportWidth, canShow: geometry.rightbarCanShow }}
          fallback={<p className="app-frame-seat-empty">右栏席位未装配</p>}
        />
      </div>
      {state.rightbarOpen && !state.rightbarFullscreen && geometry.rightbar > 0 && (
        <ResizeHandle
          edge="left"
          label="拖宽右栏"
          /* 基点 = 渲染宽度（上游 AppFrame.tsx:172-191）：抓住被让步链压窄的面板时
             不得跳回存储偏好，整段手势内冻结（dx 不叠加）。 */
          value={geometry.rightbar}
          min={RIGHTBAR_MIN_PX}
          max={rightbarMaxWidth(geometry.contentWidth)}
          onResize={(px) => dispatch({ type: 'rightbar/width', width: px })}
          onDraggingChange={setDragging}
        />
      )}
    </aside>
  );
}

/** 覆层席位宿主（设置弹窗 / 命令面板…，list 席位按 order 叠放） */
function OverlaySeatView(): React.ReactNode {
  const { registry } = useFrame();
  return (
    <div className="app-frame-overlay" data-seat={FRAME_SEAT.overlay}>
      <SlotHost registry={registry} seat={FRAME_SEAT.overlay} />
    </div>
  );
}

/** 四席位容器组件表（注册进 root 槽用） */
export const FRAME_SEAT_VIEWS: Record<(typeof FRAME_SEAT)[keyof typeof FRAME_SEAT], React.ComponentType> = {
  [FRAME_SEAT.sidebar]: SidebarSeatView,
  [FRAME_SEAT.main]: MainSeatView,
  [FRAME_SEAT.rightbar]: RightbarSeatView,
  [FRAME_SEAT.overlay]: OverlaySeatView,
};
