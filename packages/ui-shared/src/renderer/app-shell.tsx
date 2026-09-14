// app-shell.tsx — 共享「应用壳」装配：store + controller + 订阅 Hook + 通用小件。
//
// 每个壳在自己的组装根调用一次 `createAppShell(client)`，把端口实现（desktop = preload 桥，
// web = serve HTTP/WS 客户端）注入进去；此后壳内的组件只从返回值取 store/controller。
// 这样共享包不需要知道任何壳的全局对象（不读 window.harness2 之类），也便于测试注入假实现。
import { useSyncExternalStore } from 'react';
import type { ConnectionStatus } from '../shared/protocol.js';
import { createController, type Controller } from './app-controller.js';
import type { HarnessClient } from './ports.js';
import { AppStore, type AppState } from './store.js';

/** 主题循环（壳的设置页与主题呈现器共用；持久化由各壳自己决定） */
export type ShellTheme = 'warmPaper' | 'dark' | 'system';
export const THEME_CYCLE: readonly ShellTheme[] = ['warmPaper', 'dark', 'system'];

export interface AppShell {
  readonly store: AppStore;
  readonly controller: Controller;
  /** 订阅应用状态（useSyncExternalStore 包装；同一壳内引用稳定） */
  useAppState(): AppState;
}

/** 组装一个应用壳：store（事件流投影）+ controller（动作面），端口由各壳注入 */
export function createAppShell(client: HarnessClient): AppShell {
  const store = new AppStore();
  const controller = createController(store, client);
  const useAppState = (): AppState => useSyncExternalStore(store.subscribe, store.getState);
  return { store, controller, useAppState };
}

const STATUS_LABEL: Record<ConnectionStatus, { text: string; className: string }> = {
  connecting: { text: '连接服务…', className: 'badge badge-connecting' },
  connected: { text: '已连接', className: 'badge badge-connected' },
  reconnecting: { text: '重连中…', className: 'badge badge-reconnecting' },
  offline: { text: '服务离线', className: 'badge badge-offline' },
};

/** 连接状态角标（各壳状态行共用） */
export function StatusBadge({ status, error }: { status: ConnectionStatus; error?: string }) {
  const label = STATUS_LABEL[status];
  return (
    <span className={label.className} title={error ?? ''}>
      <span className="dot" aria-hidden />
      {label.text}
    </span>
  );
}

/** 会话展示标题：覆层 title 优先，否则 firstUserText（空会话回落占位） */
export function sessionTitle(store: AppStore, s: { id: string; firstUserText: string }): string {
  const t = store.displayTitleFor(s.id) ?? s.firstUserText;
  return t.length > 0 ? t : '(空会话)';
}
