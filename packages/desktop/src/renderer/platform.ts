// Z2-01b 平台派生（依据 docs/refs/refs-zcode-layout.md Z-02 / Z-04 / §8）：
// 渲染端拿不到 Node，只能读 preload 同步暴露的 `window.harness2.platform`（DesktopPlatform）。
// 非桌面宿主（web）或旧测试夹具缺失 platform 时返回 null —— 渲染端**不启用任何平台特化**
// （不圆角、不摆自绘窗控、不留红绿灯安全区），绝不臆造平台。
import type { DesktopPlatform, Harness2Api } from '../shared/protocol.js';

export type { DesktopPlatform };

/** 当前桌面平台（缺 platform 通道 → null） */
export function desktopPlatform(): DesktopPlatform | null {
  if (typeof window === 'undefined') return null;
  const api = (window as { harness2?: Pick<Harness2Api, 'platform'> }).harness2;
  const p = api?.platform;
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : null;
}

/** macOS 桌面（系统红绿灯 + 左侧安全区；无独立顶栏） */
export function isMacDesktop(platform: DesktopPlatform | null = desktopPlatform()): boolean {
  return platform === 'darwin';
}

/** Windows / Linux 桌面（无边框 + 自绘窗控三键） */
export function usesCustomWindowControls(platform: DesktopPlatform | null = desktopPlatform()): boolean {
  return platform === 'win32' || platform === 'linux';
}

/**
 * 窗口根容器的平台圆角类（Z-02）：
 *   Windows 5px / Linux 16px（附同半径 clip-path，防合成器丢圆角）/ macOS 6px。
 * mac Tahoe(≥26) 的 12px 需要 Darwin 版本号，渲染端拿不到 → **先按非 Tahoe 的 6px 处理**
 * （如实登记，不做版本探测臆造）。
 */
export function windowFrameClass(platform: DesktopPlatform | null, maximized: boolean): string {
  switch (platform) {
    case 'win32':
      // U2-A4：win 最大化同样去圆角（贴边露角，与 linux 同理；主进程 maximize/unmaximize
      // 事件已在推 window-state 通道，状态源无缺口）。
      return `desktop-window-frame-win${maximized ? ' desktop-window-frame-maximized' : ''}`;
    case 'linux':
      // Z-02：最大化 → 去圆角（否则窗口贴边会露出四角裁切）
      return `desktop-window-frame-linux${maximized ? ' desktop-window-frame-maximized' : ''}`;
    case 'darwin':
      return 'desktop-window-frame-mac';
    default:
      return '';
  }
}

/** 浮层条高度（§8：TopOverlay mac 56 / win-linux 48） */
export function topOverlayHeight(platform: DesktopPlatform | null): number {
  return platform === 'darwin' ? 56 : 48;
}
