// 代码查看器 tab 的**当前目标**（Z10-7；Z-14 的 `code-viewer` = 单 tab、内容随「打开的文件」变化）。
//
// 与 ZCode 一致：`code-viewer` 是**同一 id** 的单 tab（不是每文件一 tab），打开新文件即替换内容并
// 激活该 tab。目标（路径 + 可选行号）存内存单例（不落盘，D-14）；壳无关，两壳共用。
import { createShellStore, useShellStore, type ShellStore } from '../shell-store.js';

/** 代码查看器当前打开的文件目标 */
export interface CodeViewerTarget {
  /** 文件路径（相对会话 cwd 或绝对；读取边界由壳的读取通道校验） */
  readonly path: string;
  /** 可选定位行号（变更面板不带；预留工具卡 openFile 的 line） */
  readonly line?: number;
}

interface CodeViewerState {
  readonly target: CodeViewerTarget | null;
}

const codeViewerStore: ShellStore<CodeViewerState> = createShellStore<CodeViewerState>({ target: null });

/** 打开某文件（设置目标；调用方随后负责打开/激活 `code-viewer` tab）。 */
export function openCodeViewer(path: string, line?: number): void {
  codeViewerStore.patch({ target: line !== undefined ? { path, line } : { path } });
}

/** 清空目标（查看器显示空态；不改 tab 开合）。 */
export function clearCodeViewer(): void {
  codeViewerStore.patch({ target: null });
}

/** 订阅当前目标（右栏 `code-viewer` tab 内容与入口共用）。 */
export function useCodeViewerTarget(): CodeViewerTarget | null {
  return useShellStore(codeViewerStore).target;
}

/** 读当前目标（非 React 场景，如路由效应里判重）。 */
export function peekCodeViewerTarget(): CodeViewerTarget | null {
  return codeViewerStore.getSnapshot().target;
}

/** 测试用：复位目标 */
export function resetCodeViewerForTests(): void {
  codeViewerStore.reset();
}
