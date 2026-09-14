// web 壳页面装配：左侧会话列表 + 右侧对话页（视图环 chat + 常驻 composer）。
//
// 呈现层**全部来自 `@harness2/ui-shared`**（会话列表、转录、composer、视图环、连接角标、
// 样式表），本文件只做两件 web 特有的事：
//   1. 用 `WebApp` 组装根把 serve 客户端注入共享应用壳；
//   2. 决定本壳**有哪些**视图（web 当前只有 `chat`）与**缺哪些**宿主通道（如实提示，不摆假入口）。
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StatusBadge, type AppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import {
  ConversationChatView,
  ConversationSeat,
  type ConversationSession,
} from '@harness2/ui-shared/renderer/conversation/seat.js';
import { CHAT_VIEW_KEY } from '@harness2/ui-shared/renderer/conversation/views/view-selection.js';
import { createConversationViewRegistry } from '@harness2/ui-shared/renderer/conversation/views/view-registry.js';
import { createInMemoryPersistence } from '@harness2/ui-shared/renderer/ports.js';
import { useDraftsUnloadGuard } from '@harness2/ui-shared/renderer/drafts-guard.js';
import { DEFAULT_SIDEBAR_LABELS } from '@harness2/ui-shared/renderer/sidebar/labels.js';
import { buildSessionItems } from '@harness2/ui-shared/renderer/sidebar/session-items.js';
import { SessionBrowser } from '@harness2/ui-shared/renderer/sidebar/SessionBrowser.js';

/**
 * web 壳的会话视图注册表：**只注册真实存在的视图**。
 * 未注册的能力（轨迹页、审批中心、模型配置页、工具卡详情、flows 渲染）在本壳不渲染入口 ——
 * 视图环按 D-31 只会选到已注册的 `chat`，缺什么就是缺什么，不摆假 UI（缺口清单见导出文档）。
 */
export function createWebConversationViewRegistry() {
  const registry = createConversationViewRegistry<ConversationSession>();
  registry.register({
    key: CHAT_VIEW_KEY,
    title: 'Chat',
    owner: 'ui-chat',
    component: ConversationChatView,
  });
  return registry;
}

/** web 壳单例：视图注册表与视图选择持久缝（内存；本壳不落浏览器存储） */
export const webConversationViewRegistry = createWebConversationViewRegistry();
export const webViewPersistence = createInMemoryPersistence();

export interface WebAppProps {
  readonly shell: AppShell;
  /** 新建会话（由组装根提供：需要 cwd，见 serve-client 的 createSession 注释） */
  readonly onNewSession?: () => void;
  /** 新建会话不可用时的**可行动**原因（不摆灰按钮不给解释） */
  readonly newSessionBlockedReason?: string;
}

export function WebApp({ shell, onNewSession, newSessionBlockedReason }: WebAppProps): ReactNode {
  const { store, controller } = shell;
  const state = shell.useAppState();
  const [query, setQuery] = useState('');
  // P2-4：web 无草稿落盘通道（draftsPersistence==='memory-only'）——
  // 有未发送草稿时注册 beforeunload 护栏，刷新/关闭前如实提示，不静默丢草稿。
  useDraftsUnloadGuard(controller, store);

  // 会话行数据（含运行态/未读）：每次渲染重算——行状态来自「流缓冲」，不在 AppState 里，
  // store 任一通知都会让本组件重渲染，因此这里不做 memo（避免漏掉流缓冲变化的陈旧快照）。
  const items = buildSessionItems({
    sessions: state.sessions.map((s) => ({
      id: s.id,
      firstUserText: s.firstUserText,
      mtimeMs: s.mtimeMs,
      messageCount: s.messageCount,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    })),
    metadata: state.metadata,
    query,
    flagsOf: (id) => {
      const stream = store.peekStream(id);
      return { running: stream?.running === true, unread: stream?.unread ?? 0 };
    },
  });

  const selected = state.selectedId;

  // P2-9：新建会话需要 cwd（serve 强制要求；本壳无目录选择通道）。
  // 列表里一个带 cwd 的会话都没有时，按钮点了必失败 —— 据实置灰并给出可行动原因，
  // 不摆「可点但必失败」的入口（此前只在 onNewSession 缺失时提示，而 main.tsx 恒传入 → 分支不可达）。
  const hasUsableCwd = state.sessions.some((s) => typeof s.cwd === 'string' && s.cwd.length > 0);
  const newSessionBlocked =
    onNewSession === undefined
      ? (newSessionBlockedReason ?? '无法新建会话：本壳未提供新建会话动作')
      : !hasUsableCwd
        ? (newSessionBlockedReason ?? '无法新建会话：列表里没有可用 cwd（serve 要求 cwd，本壳无目录选择通道）')
        : undefined;

  return (
    <div className="web-shell">
      <aside className="web-sidebar">
        <div className="web-brand">
          <span className="web-brand-name">harness2</span>
          <span className="web-brand-tag">web</span>
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
        </div>
        <div className="web-sidebar-actions">
          <button
            type="button"
            className="web-new-session"
            disabled={state.status !== 'connected' || newSessionBlocked !== undefined}
            title={newSessionBlocked ?? ''}
            onClick={onNewSession}
          >
            {DEFAULT_SIDEBAR_LABELS.newSession}
          </button>
          {newSessionBlocked !== undefined ? (
            <span className="web-blocked" data-testid="web-new-session-blocked">
              {newSessionBlocked}
            </span>
          ) : null}
          <input
            type="search"
            className="web-search"
            placeholder={DEFAULT_SIDEBAR_LABELS.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="web-session-list">
          <SessionBrowser
            wide
            expandSidebar={() => undefined}
            registerScrollRegion={() => undefined}
            scrollBars="drawn"
            sessions={items.active}
            archived={items.archived}
            selectedId={selected}
            query={query}
            labels={DEFAULT_SIDEBAR_LABELS}
            onOpenSession={(id) => {
              void controller.selectSession(id);
            }}
          />
        </div>
      </aside>
      <main className="web-main">
        {state.status !== 'connected' ? (
          <div className="web-banner" data-testid="web-connection-banner">
            {state.status === 'connecting'
              ? '正在连接 serve…（dev 需先启动 harness2 serve，且 Vite 代理指向它）'
              : state.status === 'reconnecting'
                ? '与 serve 的连接中断，正在重连…'
                : `serve 不可用：${state.statusDetail?.error ?? '连接已放弃'}`}
          </div>
        ) : null}
        <ConversationSeat
          store={store}
          controller={controller}
          registry={webConversationViewRegistry}
          persistence={webViewPersistence}
          header={({ sessionId }) => (
            <div className="web-conversation-header">
              <span className="web-conversation-title">
                {store.displayTitleFor(sessionId) ??
                  state.sessions.find((s) => s.id === sessionId)?.firstUserText ??
                  '(空会话)'}
              </span>
              {state.sessions.find((s) => s.id === sessionId)?.cwd !== undefined ? (
                <span className="web-conversation-cwd">{state.sessions.find((s) => s.id === sessionId)?.cwd}</span>
              ) : null}
            </div>
          )}
        />
      </main>
    </div>
  );
}
