// 四个帧席位容器（D-10 的四子席位视图）：
//   sidebar —— 可拖宽 264～420（D-11）；收起后保留 56px 控制轨道（D-13）
//   main    —— keyed 席位宿主（conversation = 会话界面）
//   rightbar—— 可拖宽（首开 45%、上限 70%）；仅普通展开态显示手柄（D-11）；
//              空间不足时收到 canShow=false props 并自行关闭（D-12，见 shell-seat-contents）
//   overlay —— 窗口级覆层席位宿主
import { useEffect, useRef, useState } from 'react';
import { SlotHost } from '../slots/index.js';
import { FRAME_SEAT } from './frame-seats.js';
import { useFrame } from './frame-context.js';
import { RIGHTBAR_GIVE_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './geometry.js';
import { rightbarMaxWidth } from './frame-state.js';

/** 拖宽手柄（指针 + 键盘；role=separator 带 aria 值域，D-11 的「可拖拽缩放」） */
function ResizeHandle({
  edge,
  label,
  value,
  min,
  max,
  onResize,
  onDraggingChange,
}: {
  edge: 'left' | 'right';
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

  // 卸载时收掉在途拖拽的全局监听（不留在 window 上）
  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  // 指针手势：pointerdown 同步挂 window 监听（不等 effect 落地，拖拽起手永不丢帧）
  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    stopRef.current?.();
    const originX = e.clientX;
    const startValue = value;
    const onMove = (ev: PointerEvent): void => {
      const delta = edge === 'right' ? ev.clientX - originX : originX - ev.clientX;
      onResizeRef.current(startValue + delta);
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
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`app-frame-resizer app-frame-resizer-${edge}${dragging ? ' app-frame-resizer-dragging' : ''}`}
      data-resizer={edge}
      onPointerDown={startDrag}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 16 : -16;
        onResize(value + (edge === 'right' ? step : -step));
      }}
    />
  );
}

/** 侧栏（D-11 拖宽 + D-13 56px 轨道；轨道内容归 SidebarRoot，帧只给容器宽度） */
function SidebarSeatView(): React.ReactNode {
  const { state, geometry, registry, dispatch } = useFrame();
  const rail = geometry.sidebarRail;
  const [dragging, setDragging] = useState(false);
  return (
    <aside
      className={`app-frame-sidebar${rail ? ' app-frame-sidebar-railed' : ''}`}
      style={{ width: `${geometry.sidebar}px` }}
      data-seat={FRAME_SEAT.sidebar}
      data-collapsed={rail ? 'true' : 'false'}
      data-width={geometry.sidebar}
      data-dragging={dragging ? 'true' : undefined}
      aria-label="侧栏"
    >
      {/* 轨道内容（品牌标记/展开按钮/区域图标）由 SidebarRoot 在 rail 态渲染；
          帧只保证容器宽度是 56px（D-13），避免两侧各画一条轨道。 */}
      <div className="app-frame-seat-body">
        <SlotHost
          registry={registry}
          seat={FRAME_SEAT.sidebar}
          fallback={<p className="app-frame-seat-empty">侧栏席位未装配</p>}
        />
      </div>
      {!rail && (
        <ResizeHandle
          edge="right"
          label="拖宽侧栏"
          value={state.sidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          onResize={(px) => dispatch({ type: 'sidebar/width', width: px })}
          onDraggingChange={setDragging}
        />
      )}
    </aside>
  );
}

/** 中栏（keyed 席位宿主；conversation 为会话界面保留 key）—— 帧不在中栏摆任何空间不足提示条（D-12） */
function MainSeatView(): React.ReactNode {
  const { state, registry } = useFrame();
  return (
    <div className="main app-frame-main" data-seat={FRAME_SEAT.main} data-main-key={state.mainKey}>
      <SlotHost registry={registry} seat={FRAME_SEAT.main} activeKey={state.mainKey} />
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
          min={RIGHTBAR_GIVE_MIN_WIDTH}
          max={rightbarMaxWidth(viewportWidth)}
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
