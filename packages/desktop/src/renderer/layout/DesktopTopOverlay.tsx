// Z2-01b DesktopTopOverlay（依据 docs/refs/refs-zcode-layout.md Z-01 / Z-03 / Z-04 / §8）：
// ZCode **没有 topbar** —— 左上角是一条**绝对定位浮层**（不占布局高度）：
//   * absolute left-0 top-0 z-20；高度 mac 56 / win-linux 48；
//   * 展开态宽度跟随左栏面板宽度；折叠态 w-fit 自适应（同 ZCode）；
//   * 内容是「品牌标记 + 侧栏折叠按钮」；New Task 仅在侧栏收起时出现（同 ZCode）；
//   * 浮层条本身是拖拽区（-webkit-app-region: drag），内部按钮一律 no-drag。
// 说明（如实登记的简化）：ZCode mac 用 PanelLeft 图标、win/linux 用「品牌标记 hover 变折叠图标」；
// 本实现统一为「品牌标记 + 折叠按钮」两个元素（交互等价，免 hover 态复杂度）。
// 本组件是纯展示件（几何与动作由 App 传入），不 import app-shared / slots。
import type { DesktopPlatform } from '../../shared/protocol.js';
import { topOverlayHeight } from '../platform.js';

export interface DesktopTopOverlayProps {
  readonly platform: DesktopPlatform | null;
  /** 侧栏是否折叠（折叠时 New Task 出现、宽度转 w-fit） */
  readonly sidebarCollapsed: boolean;
  /** 展开态宽度（跟随左栏面板宽度，px） */
  readonly sidebarWidth: number;
  readonly onToggleSidebar: () => void;
  readonly onNewTask: () => void;
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
 * 渲染左上角窗口浮层（不占布局高度）。
 * @param props - 平台、侧栏几何与动作回调。
 * @returns 浮层条元素。
 */
export function DesktopTopOverlay(props: DesktopTopOverlayProps): React.ReactNode {
  const isMac = props.platform === 'darwin';
  const height = topOverlayHeight(props.platform);
  const classes = ['desktop-top-overlay'];
  if (isMac) classes.push('desktop-top-overlay-mac');
  if (props.sidebarCollapsed) classes.push('desktop-top-overlay-fit');

  return (
    <div
      className={classes.join(' ')}
      data-testid="desktop-top-overlay"
      data-height={height}
      data-collapsed={props.sidebarCollapsed ? 'true' : 'false'}
      style={props.sidebarCollapsed ? { height } : { height, width: props.sidebarWidth }}
      role="toolbar"
      aria-label="窗口浮层"
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
