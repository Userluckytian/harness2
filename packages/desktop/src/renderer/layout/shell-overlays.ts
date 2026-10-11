// 覆层开关状态（shell.overlay 席位的数据源）：设置弹窗 / 命令面板的开关。
// 只存内存（D-14 口径：开合状态不持久化）。
import { createShellStore, useShellStore, type ShellStore } from './shell-store.js';

/** 覆层 id（目前两个真实覆层；新增覆层在此登记，避免 identity 乱飘） */
export type ShellOverlayId = 'settings' | 'palette';

export type ShellOverlayState = Record<ShellOverlayId, boolean>;

export const shellOverlayStore: ShellStore<ShellOverlayState> = createShellStore({
  settings: false,
  palette: false,
});

export function setOverlay(id: ShellOverlayId, open: boolean): void {
  shellOverlayStore.patch({ [id]: open } as Partial<ShellOverlayState>);
}

export function toggleOverlay(id: ShellOverlayId): void {
  setOverlay(id, !shellOverlayStore.getSnapshot()[id]);
}

/** 关闭全部覆层（Esc/切会话等场景） */
export function closeAllOverlays(): void {
  shellOverlayStore.patch({ settings: false, palette: false });
}

export function useOverlayOpen(id: ShellOverlayId): boolean {
  return useShellStore(shellOverlayStore)[id];
}

// —— 设置弹窗的「直达分区」请求（Z3-04 composer「管理模型」入口）——
//
// 覆层开关只存布尔（既有面不变）；分区诉求是**一次性**副作用参数，单独走模块变量：
// 打开时取走即清（不残留），只存内存（D-14）。入口 = openSettingsAtSection（同时开覆层）。

let requestedSettingsSection: string | undefined;

/** 打开设置弹窗并指定落到的分区 id（如 MODELS_SECTION_ID） */
export function openSettingsAtSection(sectionId: string): void {
  requestedSettingsSection = sectionId;
  setOverlay('settings', true);
}

/** 取走待落的分区请求（取走即清；undefined = 普通打开，跟随壳的默认分区） */
export function takeRequestedSettingsSection(): string | undefined {
  const id = requestedSettingsSection;
  requestedSettingsSection = undefined;
  return id;
}
