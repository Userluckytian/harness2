// Z-47 系统托盘（win32 + linux；macOS 明确不用托盘、走 Dock）。
// 依赖注入式（照 serve-manager.ts spawnImpl 先例）：Tray/Menu/nativeImage 全部经 deps 传入，
// vitest 注入 fake 即可覆盖平台门、创建失败、菜单结构与点击动作，不真起 Electron。
//
// 行为规格（docs/refs/refs-zcode-layout.md Z-47）：
//   - 图标：打包态 process.resourcesPath/tray_icon.ico（electron-builder extraResources 映射），
//     dev 态 packages/desktop/assets/icon.ico（scripts/gen-icon.mjs 生成，产物入库）；
//   - 左键/双击 = show + focus 主窗（**不是 toggle 隐藏**）；tooltip「harness2」；
//   - 右键菜单（顺序）：打开 harness2 ┃ 新建会话 / 添加项目 ┃ 分隔 ┃ 导出日志 ┃ 分隔 ┃ 退出；
//   - 新建会话/添加项目 = 经 IPC_TRAY_EVENT 通道向渲染端发事件（T3 接监听；无监听者不报错）；
//   - 导出日志：TODO(T3+/后续) —— 现仓库无成体系的运行日志落盘通道（serve stdout 不持久化，
//     diagnostics 仅有 doctor/崩溃列表），故菜单项占位 disabled（灰显可解释，不静默没反应）；
//   - 退出 = actions.quit()（main 侧 markExplicitQuit + app.quit，防被「关窗即隐藏」吞掉）。

import { join } from 'node:path';
import { isTrayPlatform } from './window-lifecycle.js';

/** 托盘 tooltip 与「打开」项文案（Z-47：tooltip「harness2」/「打开 harness2」） */
export const TRAY_TOOLTIP = 'harness2';
export const TRAY_LABELS = {
  open: '打开 harness2',
  newSession: '新建会话',
  addProject: '添加项目',
  exportLogs: '导出日志',
  quit: '退出',
} as const;

/** 托盘 → 渲染端事件（shared/protocol TrayUiEvent 的主进程侧镜像，不经 electron 类型） */
export type TrayAction = 'tray:new-session' | 'tray:add-project';

export interface TrayActions {
  /** 左键/双击/「打开 harness2」：show + focus 主窗（含从最小化恢复） */
  showMainWindow(): void;
  /** 「新建会话」：向渲染端发 tray:new-session 事件 */
  newSession(): void;
  /** 「添加项目」：向渲染端发 tray:add-project 事件 */
  addProject(): void;
  /** 「退出」：markExplicitQuit + app.quit（接线在 main.ts） */
  quit(): void;
}

export interface TrayMenuItem {
  label?: string;
  /** 收窄到实际用到的取值，保证可直接喂 Menu.buildFromTemplate（type 为其字面量联合） */
  type?: 'separator';
  enabled?: boolean;
  click?: () => void;
}

/** nativeImage.createFromPath 返回值的最小结构面（fake 可注入） */
export interface NativeImageLike {
  isEmpty(): boolean;
}

/** Tray 实例的最小结构面（fake 可注入） */
export interface TrayInstanceLike {
  setToolTip(toolTip: string): void;
  setContextMenu(contextMenu: unknown): void;
  on(event: 'click' | 'double-click', handler: () => void): void;
  destroy(): void;
}

export interface TrayDeps {
  /** process.platform（注入而非直读，决策/平台门可在 vitest 全覆盖） */
  platform: string;
  /** app.isPackaged */
  isPackaged: boolean;
  /** process.resourcesPath（打包态图标根） */
  resourcesPath: string;
  /** __dirname（dev 态图标根锚点） */
  dirname: string;
  /** 真实 = (p) => nativeImage.createFromPath(p) */
  loadIcon: (path: string) => NativeImageLike;
  /** 真实 = (img) => new Tray(img)；构造抛错（无托盘能力/平台异常）→ createTray 如实返回 null */
  createTrayInstance: (image: NativeImageLike) => TrayInstanceLike;
  /** 真实 = (items) => Menu.buildFromTemplate(items) */
  buildMenu: (items: TrayMenuItem[]) => unknown;
  actions: TrayActions;
}

export interface TrayHandle {
  destroy(): void;
}

/** 图标路径裁决（Z-47：win 用独立 .ico，打包经 extraResources 映射到 resources/tray_icon.ico） */
export function resolveTrayIconPath(env: { isPackaged: boolean; resourcesPath: string; dirname: string }): string {
  return env.isPackaged
    ? join(env.resourcesPath, 'tray_icon.ico')
    : join(env.dirname, '..', '..', 'assets', 'icon.ico');
}

/**
 * 右键菜单模板（纯构造，供结构断言）：
 * 打开 harness2 ┃ 新建会话 / 添加项目 ┃ 分隔 ┃ 导出日志(disabled) ┃ 分隔 ┃ 退出
 */
export function buildTrayMenuTemplate(actions: TrayActions): TrayMenuItem[] {
  return [
    { label: TRAY_LABELS.open, click: () => actions.showMainWindow() },
    { label: TRAY_LABELS.newSession, click: () => actions.newSession() },
    { label: TRAY_LABELS.addProject, click: () => actions.addProject() },
    { type: 'separator' },
    // TODO(Z-47 后续)：接入运行日志导出（需先在主进程落盘 serve/应用日志）；现占位灰显，
    // 保证「要么能点要么灰」，不摆可点即报错的假活钮。
    { label: TRAY_LABELS.exportLogs, enabled: false },
    { type: 'separator' },
    { label: TRAY_LABELS.quit, click: () => actions.quit() },
  ];
}

/**
 * 创建托盘：平台门（win32/linux，mac → null）→ 图标加载（空图 → null）→ 实例构造
 * （抛错 → null）→ tooltip/contextMenu/左键双击接线。
 * 返回值如实：null = 未创建/创建失败（关窗裁决的「托盘创建成功」门据此走确认退出路径）。
 */
export function createTray(deps: TrayDeps): TrayHandle | null {
  if (!isTrayPlatform(deps.platform)) return null;
  const iconPath = resolveTrayIconPath({
    isPackaged: deps.isPackaged,
    resourcesPath: deps.resourcesPath,
    dirname: deps.dirname,
  });
  let image: NativeImageLike;
  try {
    image = deps.loadIcon(iconPath);
    if (image.isEmpty()) return null;
  } catch {
    return null;
  }
  let tray: TrayInstanceLike;
  try {
    tray = deps.createTrayInstance(image);
  } catch {
    // 平台无托盘能力/构造异常：如实 null（不假装驻留）
    return null;
  }
  try {
    tray.setToolTip(TRAY_TOOLTIP);
    tray.setContextMenu(deps.buildMenu(buildTrayMenuTemplate(deps.actions)));
    // 左键/双击 = show + focus 主窗（不是 toggle 隐藏，Z-47）
    tray.on('click', () => deps.actions.showMainWindow());
    tray.on('double-click', () => deps.actions.showMainWindow());
  } catch {
    // 接线失败：销毁半成品实例，按「创建失败」裁决
    try {
      tray.destroy();
    } catch {
      // 已销毁
    }
    return null;
  }
  return {
    destroy: () => {
      try {
        tray.destroy();
      } catch {
        // 已销毁
      }
    },
  };
}
