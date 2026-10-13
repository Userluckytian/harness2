// Z-46 自绘窗口控件三键（win/linux；mac 走系统红绿灯，不渲染）。
//
// **单实例挂载（壳层一次）**：本组件由 AppFrame 顶层 `WindowControlsOverlay` 常驻挂载，
// 空态（无会话）、会话态、覆层态（设置页/命令面板）全场景同一处 —— 取代原先挂在
// ConversationHeader 内嵌动作区的旧实现（ZCode 是「每页自挂」，我们是「壳层挂一次」，
// 行为等价且屏上恒只有一套窗控，见 refs-zcode-layout.md Z-46「harness2 落点」）。
//
// 通道门（红线⑩）：win/linux 且主进程真的提供 windowMinimize 通道才渲染 —— 缺通道
// 不摆假按钮（web 宿主 / 旧夹具零变化）。
import type { Harness2Api } from '../../shared/protocol.js';
import { desktopPlatform, usesCustomWindowControls } from '../platform.js';
import { useWindowMaximized } from '../window-state.js';

/** 最小化 */
function MinimizeIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 6h8" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}

/** 最大化 */
function MaximizeIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1" stroke="currentColor" strokeWidth={1.2} />
    </svg>
  );
}

/** 还原（最大化态） */
function RestoreIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.2" y="3.6" width="6.2" height="6.2" rx="1" stroke="currentColor" strokeWidth={1.2} />
      <path
        d="M4.2 3.6V2.6a1 1 0 0 1 1-1h4.2a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1H9.4"
        stroke="currentColor"
        strokeWidth={1.2}
      />
    </svg>
  );
}

/** 关闭 */
function CloseIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </svg>
  );
}

/**
 * 三键本体（不含定位容器）：容器与 drag/no-drag 分区由调用方负责
 * （AppFrame 顶层 overlay 与未来可能的内嵌场景共用同一份按钮语义）。
 */
export function WindowControls(): React.ReactNode {
  const maximized = useWindowMaximized();
  const api = (typeof window === 'undefined' ? undefined : (window as { harness2?: Harness2Api }).harness2) ?? {};
  return (
    <span className="window-controls" data-testid="window-controls">
      <button
        type="button"
        className="window-controls-btn"
        aria-label="最小化"
        title="最小化"
        onClick={() => void api.windowMinimize?.()}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="window-controls-btn"
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void api.windowToggleMaximize?.()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="window-controls-btn window-controls-close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void api.windowClose?.()}
      >
        <CloseIcon />
      </button>
    </span>
  );
}

/**
 * 顶层常驻 overlay（Z-46）：48px 标题带（透明 drag 条 + 右对齐三键），
 * `pointer-events-none` 整带不挡任何点击（除右端 138px 安全区）；
 * 键体 `pointer-events-auto` + no-drag（CSS `.window-controls-overlay`）。
 * 仅 win/linux 且有通道时渲染；mac / web / 缺通道 → null。
 */
export function WindowControlsOverlay(): React.ReactNode {
  const platform = desktopPlatform();
  const api = (typeof window === 'undefined' ? undefined : (window as { harness2?: Harness2Api }).harness2) ?? {};
  if (!usesCustomWindowControls(platform) || typeof api.windowMinimize !== 'function') return null;
  return (
    <div className="window-controls-overlay" data-testid="window-controls-overlay">
      <span className="window-controls-overlay-drag" aria-hidden="true" />
      <WindowControls />
    </div>
  );
}
