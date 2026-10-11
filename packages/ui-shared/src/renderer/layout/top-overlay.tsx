// FrameTopOverlay —— 壳无关的左上角浮层条（依据 docs/refs/refs-zcode-layout.md Z-01 / Z-03 / §8）。
//
// ZCode **没有 topbar**：左上角是一条**绝对定位浮层**（不占布局高度），内容是
// 「品牌标记 + 侧栏折叠按钮 + New Task（仅侧栏收起时）」；浮层条本体是拖拽区，
// 内部按钮一律 no-drag。桌面壳的窗口控制（自绘三键）不在此浮层，而在会话列头
// （见 desktop `components/ConversationHeader.tsx`），故本组件两壳共用、零平台依赖：
// 高度与 mac 安全区由壳传入（mac 56 / win-linux 48；mac 左侧留 96px 红绿灯安全区）。
//
// 桌面 `DesktopTopOverlay` 是薄包装：把平台 → (height, mac) 后再交给本组件，保持既有
// 类名（desktop-top-overlay*）与 data-testid 不变；web 直接使用本组件。
// 纯展示件（几何与动作由壳传入），不 import app-shared / slots / 任何壳单例。
export interface FrameTopOverlayProps {
  /** 浮层高度（px）：mac 56 / 其余 48（§8） */
  readonly height: number;
  /** mac 形态（红绿灯安全区 + mac 高度）；缺省 false = win/linux */
  readonly mac?: boolean;
  /** 侧栏是否折叠（折叠时 New Task 出现、宽度转 w-fit） */
  readonly sidebarCollapsed: boolean;
  /** 展开态宽度（跟随左栏面板宽度，px） */
  readonly sidebarWidth: number;
  readonly onToggleSidebar: () => void;
  readonly onNewTask: () => void;
  /** 根元素类名前缀（缺省桌面历史类名，两壳共用同一份 CSS 契约） */
  readonly classBase?: string;
  /** 根元素 data-testid（缺省 'frame-top-overlay'） */
  readonly testId?: string;
  /** 根元素 aria-label（缺省 '窗口浮层'） */
  readonly label?: string;
}

/** 品牌标记（与侧栏品牌同一鱼形轮廓；此处内联，避免跨层 import 侧栏外壳） */
function BrandMark(): React.ReactNode {
  return (
    <svg
      className="desktop-top-overlay-mark"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 12c3.2-4.2 7.2-6.3 12-6.3 2.6 0 4.9.7 6 1.9-1.5.9-2.4 2.2-2.7 4.4-.3 2.2.4 3.9 2.7 4.6-1.1 1.2-3.4 1.9-6 1.9-4.8 0-8.8-2.1-12-6.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 侧栏折叠图标（PanelLeft 轮廓） */
function PanelLeftIcon(): React.ReactNode {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

/**
 * 渲染左上角浮层（不占布局高度）。
 * @param props - 高度/mac、侧栏几何与动作回调。
 * @returns 浮层条元素。
 */
export function FrameTopOverlay(props: FrameTopOverlayProps): React.ReactNode {
  const base = props.classBase ?? 'desktop-top-overlay';
  const classes = [base];
  if (props.mac === true) classes.push(`${base}-mac`);
  if (props.sidebarCollapsed) classes.push(`${base}-fit`);

  return (
    <div
      className={classes.join(' ')}
      data-testid={props.testId ?? 'frame-top-overlay'}
      data-height={props.height}
      data-collapsed={props.sidebarCollapsed ? 'true' : 'false'}
      style={props.sidebarCollapsed ? { height: props.height } : { height: props.height, width: props.sidebarWidth }}
      role="toolbar"
      aria-label={props.label ?? '窗口浮层'}
    >
      <span className="desktop-top-overlay-brand" aria-hidden="true">
        <BrandMark />
      </span>
      <button
        type="button"
        className="desktop-top-overlay-btn"
        aria-label="侧栏开关"
        aria-pressed={!props.sidebarCollapsed}
        title={props.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        onClick={props.onToggleSidebar}
      >
        <PanelLeftIcon />
      </button>
      {props.sidebarCollapsed && (
        <button type="button" className="desktop-top-overlay-new" onClick={props.onNewTask}>
          New Task
        </button>
      )}
    </div>
  );
}
