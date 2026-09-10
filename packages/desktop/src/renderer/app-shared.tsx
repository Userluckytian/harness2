// app-shared（B3-2 拆分产物）：渲染端共享状态与跨组件纯逻辑。
// store/controller 单例在此构造，App 根与 SessionList/ChatView/PaneArea 都从这取；
// App.tsx 保持对外再导出（main.tsx / 测试仍从 './App.js' 引）。
import { useSyncExternalStore } from 'react';
import type { ConnectionStatus, SettingsTheme } from '../shared/protocol.js';
import { AppStore, type AppState } from './store.js';
import { createController } from './app-controller.js';

export const THEME_CYCLE: readonly SettingsTheme[] = ['warmPaper', 'dark', 'system'];

export const store = new AppStore();
export const controller = createController(store, window.harness2);

/** 拖拽载荷：jsdom 无 dataTransfer，模块级回退（优先 dataTransfer） */
export const dragState: { sessionId: string | null } = { sessionId: null };

export function useAppState() {
  return useSyncExternalStore(store.subscribe, store.getState);
}

const STATUS_LABEL: Record<ConnectionStatus, { text: string; className: string }> = {
  connecting: { text: '连接服务…', className: 'badge badge-connecting' },
  connected: { text: '已连接', className: 'badge badge-connected' },
  reconnecting: { text: '重连中…', className: 'badge badge-reconnecting' },
  offline: { text: '服务离线', className: 'badge badge-offline' },
};

export function StatusBadge({ status, error }: { status: ConnectionStatus; error?: string }) {
  const label = STATUS_LABEL[status];
  return (
    <span className={label.className} title={error ?? ''}>
      <span className="dot" aria-hidden />
      {label.text}
    </span>
  );
}

/** 点击会话时目标分栏：优先空栏，其次第一栏 */
export function targetPaneFor(state: AppState): number {
  const empty = state.layout.panes.findIndex((p) => p.sessionId === null);
  return empty >= 0 ? empty : 0;
}

/** 会话展示标题：覆层 title 优先，否则 firstUserText（空会话回落占位） */
export function sessionTitle(state: AppState, s: { id: string; firstUserText: string }): string {
  const t = store.displayTitleFor(s.id) ?? s.firstUserText;
  return t.length > 0 ? t : '(空会话)';
}
