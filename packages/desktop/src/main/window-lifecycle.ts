// Z-47 关窗裁决核（纯函数，零 Electron 依赖）：关闭窗口时 hide（驻留托盘）还是 proceed（真关闭）。
//
// 规格（docs/refs/refs-zcode-layout.md Z-47）：
//   (win32|linux) ∧ closeToTray 设置开 ∧ 托盘创建成功 ∧ ¬explicitQuit → hide + preventDefault；
//   否则维持现状：放行 close →（D4 busy 对话框）→ 最后一个窗口销毁 → window-all-closed → app.quit()。
// 说明：
//   - 「能力双条件门」之二（linux DBus StatusNotifierWatcher 探测）由
//     tray-support.probeTraySupport 提供（gdbus → busctl → qdbus 三级回退），
//     main.ts 装配进 isTrayCreated / hide 门（本模块 trayCreated 入参即该双条件门结果；
//     探测不过 → 门为假 → 裁决自然回落确认退出路径，绝不隐藏后失联）；
//   - explicitQuit = 托盘「退出」/markExplicitQuit 之后的关窗：不得再被 hide 吞掉（Z-47 退出写法）；
//   - mac 一律 proceed（本模块不改 mac 关窗语义；hide 门平台列表不含 darwin）。
// 纯函数 + 注入式平台字符串：决策表可在 vitest 全覆盖，不起 Electron。

/** 关窗裁决动作 */
export type WindowCloseAction = 'hide-to-tray' | 'proceed-close';

/** 托盘能力平台门（Z-47：win32 + linux；macOS 明确不用托盘、走 Dock） */
export function isTrayPlatform(platform: string): boolean {
  return platform === 'win32' || platform === 'linux';
}

/** Z-47 平台默认：win 默认开；linux 默认关（首次强制归位口径，用户可在偏好里显式打开） */
export function defaultCloseToTray(platform: string): boolean {
  return platform === 'win32';
}

/** 有效偏好 = 显式存储值 ?? 平台默认（desktop-preferences.json 的 closeToTray 缺省保持缺省） */
export function resolveCloseToTray(stored: boolean | undefined, platform: string): boolean {
  return stored ?? defaultCloseToTray(platform);
}

export interface WindowCloseInput {
  /** process.platform（注入而非直读，便于决策表单测） */
  platform: string;
  /** 有效 closeToTray 偏好（经 resolveCloseToTray 折入平台默认后的布尔） */
  closeToTrayEnabled: boolean;
  /** 托盘实例创建成功（能力双条件门之一；linux DBus 探测折叠于此） */
  trayCreated: boolean;
  /** 显式退出中（托盘「退出」markExplicitQuit 之后，关窗不得再 hide） */
  explicitQuit: boolean;
}

/** 三重门裁决：全过 → hide 驻留托盘；任一不过 → 维持既有放行关闭链路 */
export function decideWindowClose(input: WindowCloseInput): WindowCloseAction {
  if (!isTrayPlatform(input.platform)) return 'proceed-close';
  if (input.explicitQuit) return 'proceed-close';
  if (!input.closeToTrayEnabled) return 'proceed-close';
  if (!input.trayCreated) return 'proceed-close';
  return 'hide-to-tray';
}

/**
 * 显式退出意图（Z-47 退出写法的最小状态件）：
 *   markExplicitQuit('tray-quit') → app.quit()；
 *   退出链路若被用户取消（D4 对话框选「取消」→ stay-open）→ rollback() 回滚标志，
 *   下一次关窗恢复按 hide 裁决，而不是被陈旧标志放行真关闭。
 */
export interface QuitIntent {
  /** 置位原因（诊断用；如 'tray-quit'） */
  reason(): string | null;
  isExplicit(): boolean;
  mark(reason: string): void;
  rollback(): void;
}

export function createQuitIntent(): QuitIntent {
  let marked: string | null = null;
  return {
    reason: () => marked,
    isExplicit: () => marked !== null,
    mark: (reason) => {
      marked = reason;
    },
    rollback: () => {
      marked = null;
    },
  };
}
