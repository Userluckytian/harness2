// DesktopTopOverlay —— 桌面侧薄包装（Z2-01b）：把平台 → (高度, mac 安全区) 后交给壳无关的
// `FrameTopOverlay`（ui-shared）。品牌 + 侧栏折叠按钮 + New Task 的呈现全在共享组件里；
// 桌面窗口控制（自绘三键）**不在此浮层**，而在会话列头（components/ConversationHeader.tsx）。
// 类名沿用 desktop-top-overlay*（共享 CSS 契约），data-testid 不变，既有桌面测试与观感零变化。
import type { DesktopPlatform } from '../../shared/protocol.js';
import { FrameTopOverlay } from '@harness2/ui-shared/renderer/layout/top-overlay.js';
import { topOverlayHeight } from '../platform.js';

export interface DesktopTopOverlayProps {
  readonly platform: DesktopPlatform | null;
  /** 侧栏是否折叠（折叠时 New Task 出现、宽度转 w-fit） */
  readonly sidebarCollapsed: boolean;
  /** 展开态宽度（跟随左栏面板宽度，px） */
  readonly sidebarWidth: number;
  readonly onToggleSidebar: () => void;
  readonly onNewTask: () => void;
  /** 会话历史：能否后退/前进（缺省 false → 按钮 disabled；Z10-3） */
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  /** 后退/前进动作（Z10-3 会话历史导航） */
  readonly onBack?: () => void;
  readonly onForward?: () => void;
}

/**
 * 渲染左上角窗口浮层（不占布局高度）。
 * @param props - 平台、侧栏几何与动作回调。
 * @returns 浮层条元素。
 */
export function DesktopTopOverlay(props: DesktopTopOverlayProps): React.ReactNode {
  return (
    <FrameTopOverlay
      height={topOverlayHeight(props.platform)}
      mac={props.platform === 'darwin'}
      sidebarCollapsed={props.sidebarCollapsed}
      sidebarWidth={props.sidebarWidth}
      onToggleSidebar={props.onToggleSidebar}
      onNewTask={props.onNewTask}
      canGoBack={props.canGoBack === true}
      canGoForward={props.canGoForward === true}
      {...(props.onBack !== undefined ? { onBack: props.onBack } : {})}
      {...(props.onForward !== undefined ? { onForward: props.onForward } : {})}
      classBase="desktop-top-overlay"
      testId="desktop-top-overlay"
    />
  );
}
