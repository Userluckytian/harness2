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
