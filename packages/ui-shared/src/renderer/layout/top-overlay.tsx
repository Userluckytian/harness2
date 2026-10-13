// FrameTopOverlay —— 壳无关的左上角浮层条（依据 docs/refs/refs-zcode-layout.md Z-01 / Z-03 / §8，
// 以及 ZCode 源码 `packages/ui/src/DesktopTopOverlay.tsx` :134-204）。
//
// ZCode **没有 topbar**：左上角是一条**绝对定位浮层**（不占布局高度），内容是
// 「后退 / 前进（会话历史，Z10-3）+ 侧栏折叠按钮 + New Task（仅侧栏收起时）」；浮层条本体是拖拽区，
// 内部按钮一律 no-drag。桌面壳的窗口控制（自绘三键）不在此浮层，而在会话列头
// （见 desktop `components/ConversationHeader.tsx`），故本组件两壳共用、零平台依赖：
// 高度与 mac 安全区由壳传入（mac 56 / win-linux 48；mac 左侧留 96px 红绿灯安全区）。
//
// 与 ZCode 对齐的两处复刻：
//   1. **侧栏开关按钮**（ZCode :134-161）：Windows/Linux 自绘标题区下，平时显示品牌 mark，
//      **悬浮时 mark 淡出、换成侧栏开关图标**（150ms opacity 过渡）；mac 恒为开关图标。
//      本组件把「品牌 mark + 侧栏开关」两个元素**合并为一个按钮 + hover 图标切换**
//      （mark 用本仓自己的鱼形轮廓，**不用他方 logo**）。
//   2. **New Task 按钮**（ZCode :188-204）：**宽度动画** —— 可见 `w-7 opacity-100`，
//      隐藏 `w-0 opacity-0 pointer-events-none`，`transition-[opacity,width] duration-300`；
//      且**常驻 DOM**（用 `aria-hidden` 标记不可见态），不再条件挂载/卸载。
//
// 桌面 `DesktopTopOverlay` 是薄包装：把平台 → (height, mac) 后再交给本组件，保持既有
// 类名（desktop-top-overlay*）与 data-testid 不变；web 直接使用本组件。
// 纯展示件（几何与动作由壳传入），不 import app-shared / slots / 任何壳单例。
import { useState } from 'react';

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
  /** 会话历史：能否后退（缺省/false → 按钮 disabled；ZCode 常驻显示，不隐藏） */
  readonly canGoBack?: boolean;
  /** 会话历史：能否前进（缺省/false → 按钮 disabled） */
  readonly canGoForward?: boolean;
  /** 后退动作（history.back → 目标会话）；缺省时按钮 disabled */
  readonly onBack?: () => void;
  /** 前进动作（history.forward → 目标会话）；缺省时按钮 disabled */
  readonly onForward?: () => void;
  /**
   * New Task 按钮是否可见（ZCode `showNewTaskButton`，:87 `showNewTaskButton ?? !isSidebarVisible`）。
   * 缺省 = 侧栏收起时可见（即 `sidebarCollapsed`）。
   */
  readonly showNewTaskButton?: boolean;
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

/** New Task 图标（ZCode 用 lucide `MessageCirclePlus`；此处内联同形轮廓，避免引第三方图标依赖） */
function NewTaskIcon(): React.ReactNode {
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
      <path d="M2.99 16.34a2 2 0 0 1 .1 1.17l-1.07 3.29a1 1 0 0 0 1.24 1.17l3.41-1a2 2 0 0 1 1.1.09 10 10 0 1 0-4.78-4.72" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </svg>
  );
}

/** 后退图标（ArrowLeft 轮廓；Z10-3 会话历史导航） */
function BackIcon(): React.ReactNode {
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
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

/** 前进图标（ArrowRight 轮廓；Z10-3 会话历史导航） */
function ForwardIcon(): React.ReactNode {
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
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

/**
 * 渲染左上角浮层（不占布局高度）。
 * @param props - 高度/mac、侧栏几何与动作回调。
 * @returns 浮层条元素。
 */
export function FrameTopOverlay(props: FrameTopOverlayProps): React.ReactNode {
  const [toggleHovered, setToggleHovered] = useState(false);
  const base = props.classBase ?? 'desktop-top-overlay';
  const classes = [base];
  const isMac = props.mac === true;
  if (isMac) classes.push(`${base}-mac`);
  if (props.sidebarCollapsed) classes.push(`${base}-fit`);

  // ZCode :87：`isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible`；
  // 本组件 `sidebarCollapsed` 即 `!isSidebarVisible`，故缺省等价于 `sidebarCollapsed`。
  const isNewTaskButtonVisible = props.showNewTaskButton ?? props.sidebarCollapsed;
  // mac 恒显开关图标；win/linux 平时显品牌 mark，悬浮时切开关图标（ZCode :134-161）。
  const showToggleIcon = isMac || toggleHovered;

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
      {/* Z10-3：会话历史「后退 / 前进」 ZCode 顶左最前两枚（28×28 @ 后退 x=0 / 前进 x=32）。
          无历史时按 disabled 呈现（常驻显示，不隐藏）。 */}
      <button
        type="button"
        className="desktop-top-overlay-btn desktop-top-overlay-nav"
        aria-label="后退"
        title="后退 (Ctrl+[)"
        disabled={props.canGoBack !== true || props.onBack === undefined}
        onClick={props.onBack}
      >
        <BackIcon />
      </button>
      <button
        type="button"
        className="desktop-top-overlay-btn desktop-top-overlay-nav"
        aria-label="前进"
        title="前进 (Ctrl+])"
        disabled={props.canGoForward !== true || props.onForward === undefined}
        onClick={props.onForward}
      >
        <ForwardIcon />
      </button>
      {/* 侧栏开关（ZCode :134-161）：单按钮 + hover 图标切换。
          win/linux 平时显品牌 mark（悬浮淡出），mac 恒显开关图标。 */}
      <button
        type="button"
        className="desktop-top-overlay-btn desktop-top-overlay-toggle"
        aria-label="侧栏开关"
        aria-pressed={!props.sidebarCollapsed}
        title={props.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        data-hover={toggleHovered ? 'true' : 'false'}
        onMouseEnter={() => setToggleHovered(true)}
        onMouseLeave={() => setToggleHovered(false)}
        onClick={props.onToggleSidebar}
      >
        {!isMac && (
          <span
            className={`desktop-top-overlay-toggle-mark${toggleHovered ? ' is-hidden' : ''}`}
            data-testid="frame-top-overlay-toggle-mark"
            aria-hidden="true"
          >
            <BrandMark />
          </span>
        )}
        <span
          className={`desktop-top-overlay-toggle-icon${showToggleIcon ? ' is-visible' : ''}`}
          data-testid="frame-top-overlay-toggle-icon"
          aria-hidden="true"
        >
          <PanelLeftIcon />
        </span>
      </button>
      {/* New Task（ZCode :188-204）：常驻 DOM + 宽度/透明度动画；不可见态 aria-hidden。 */}
      <div
        aria-hidden={!isNewTaskButtonVisible}
        className={`desktop-top-overlay-new-wrap${isNewTaskButtonVisible ? ' is-visible' : ' is-hidden'}`}
      >
        <button
          type="button"
          className="desktop-top-overlay-btn desktop-top-overlay-new"
          aria-label="New Task"
          title="新建任务"
          onClick={props.onNewTask}
        >
          <NewTaskIcon />
        </button>
      </div>
    </div>
  );
}
