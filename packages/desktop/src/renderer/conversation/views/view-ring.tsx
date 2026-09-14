// 视图环（D-32）：`conversation.view` 的多标签（Chat / Trajectory / …）。
//
// 三条硬口径：
//   1. **切换不重建会话**：会话对象由 props 传入（引用稳定），环内只用 [session] 依赖订阅一次；
//      切标签只换「渲染哪个视图」，会话对象、会话订阅、会话级注入缝（图片 URL 解析器）都不重建。
//      证据方式（tests）：session.subscribe 只被调用一次且从不退订、ctx.session 与 ctx.imageUrl
//      在切换前后引用相等、`view-ring-session` 容器 DOM 节点引用不变。
//   2. **选择**走 D-31 纯函数（有效持久选择 > 已注册 chat > 不渲染），绝不取「第一个注册的」。
//   3. **持久选择读写走注入缝**（ViewSelectionPersistence）：本模块不碰浏览器端持久化存储，
//      是否落盘、按会话还是全局，由宿主注入实现决定。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type {
  ConversationImageAttachment,
  ConversationImageUrlResolver,
  SessionImageUrlResolver,
} from './image-url-cache.js';
import { selectConversationView } from './view-selection.js';
import { emptyViewEntries } from './view-registry.js';
import type { ConversationViewEntry, ConversationViewProps, ConversationViewRegistry } from './view-registry.js';

/**
 * 视图选择的持久化缝（D-31「有效持久选择」的数据源）。
 * 宿主注入真实实现（内存 / 配置文件 / 会话 UI 状态）；本模块只调用 read/write。
 */
export interface ViewSelectionPersistence {
  read(sessionId: string): string | null;
  write(sessionId: string, key: string | null): void;
  /**
   * 可选：宿主在**环外**改写选择时的变更通知（如 D-86 ② 工具卡 inspect → 切到轨迹视图）。
   * 提供时环订阅它重读选择（否则只有点击标签才会切视图）。缺省不提供 = 旧行为不变。
   */
  subscribe?(listener: () => void): () => void;
}

/**
 * 会话对象的订阅面（可选）。有 subscribe 时，环按 `[session]` 依赖绑定：
 * 会话对象引用变了才重新订阅；**切换视图不会重新订阅**（D-32 的证据之一）。
 */
export interface ConversationSessionBinding {
  subscribe?(listener: () => void): () => void;
}

export interface ConversationViewRingProps<S extends object = object> {
  readonly registry: ConversationViewRegistry<S>;
  readonly sessionId: string;
  /** 会话对象（同一会话内引用必须稳定；换会话才换引用） */
  readonly session: S & ConversationSessionBinding;
  /** 持久选择读写缝（D-31 / D-14） */
  readonly persistence: ViewSelectionPersistence;
  /** D-39：会话内图片 URL 解析器（默认恒 null；装配棒接真实 ImageUrlCache.peekUrl） */
  readonly imageUrl?: ConversationImageUrlResolver;
  /** 切换通知（切到新视图时回调一次；供宿主埋点 / 同步别处状态） */
  readonly onSelectView?: (key: string) => void;
  /** 无可渲染视图时的兜底内容 */
  readonly emptyFallback?: ReactNode;
}

/** D-39 的默认解析器：没有接图片缓存时视图永远拿 null（不伪造 URL） */
const NO_IMAGE_URL: ConversationImageUrlResolver = () => null;

export function ConversationViewRing<S extends object = object>(props: ConversationViewRingProps<S>): ReactNode {
  const { registry, sessionId, session, persistence, onSelectView, emptyFallback } = props;
  const resolver = props.imageUrl ?? NO_IMAGE_URL;

  // 视图集合：注册表订阅（快照引用稳定 → 集合不变不重渲染）
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const getSnapshot = useCallback(() => registry.views(), [registry]);
  const views = useSyncExternalStore<readonly ConversationViewEntry<S>[]>(subscribe, getSnapshot, () =>
    emptyViewEntries<S>(),
  );

  // 持久选择：按会话读一次；会话换了再读（同一会话内切视图只写不重读）
  const [persisted, setPersisted] = useState<string | null>(() => persistence.read(sessionId));
  const persistedSession = useRef(sessionId);
  if (persistedSession.current !== sessionId) {
    persistedSession.current = sessionId;
    const next = persistence.read(sessionId);
    if (next !== persisted) setPersisted(next);
  }

  // 环外改写（D-86 ② 工具卡 inspect 等）：宿主给了订阅缝就跟随，否则只有点击标签会切视图。
  useEffect(() => {
    const subscribeSelection = persistence.subscribe;
    if (typeof subscribeSelection !== 'function') return undefined;
    return subscribeSelection.call(persistence, () => {
      const next = persistence.read(sessionId);
      setPersisted((prev) => (prev === next ? prev : next));
    });
  }, [persistence, sessionId]);

  // 会话订阅：仅 [session] 依赖 → 切视图不重订阅（D-32）。收到的更新用于强制重渲染视图。
  const [, setSessionRevision] = useState(0);
  useEffect(() => {
    const subscribeSession = session.subscribe;
    if (typeof subscribeSession !== 'function') return undefined;
    return subscribeSession.call(session, () => setSessionRevision((revision) => revision + 1));
  }, [session]);

  // 会话级图片解析器绑定（D-39）：[sessionId, resolver] 依赖 → 切视图引用不变，Chat/Trajectory 共用同一缓存入口
  const boundImageUrl = useMemo<SessionImageUrlResolver>(
    () => (attachment: ConversationImageAttachment) => resolver(sessionId, attachment),
    [resolver, sessionId],
  );

  // 视图上下文：会话对象与解析器都稳定 → 切视图时 ctx 引用不变（会话未被重建）
  const context = useMemo<ConversationViewProps<S>>(
    () => ({ sessionId, session, imageUrl: boundImageUrl }),
    [sessionId, session, boundImageUrl],
  );

  const selectedKey = selectConversationView({
    registeredKeys: views.map((view) => view.key),
    persisted,
    session: { active: sessionId.length > 0 },
  });

  const selectView = useCallback(
    (key: string) => {
      setPersisted(key);
      persistence.write(sessionId, key);
      onSelectView?.(key);
    },
    [persistence, sessionId, onSelectView],
  );

  const activeView = selectedKey === null ? undefined : views.find((view) => view.key === selectedKey);
  const tabs = views;

  return (
    <div className="view-ring" data-session-id={sessionId}>
      <div className="view-ring-tabs" role="tablist" aria-label="会话视图">
        {tabs.map((view) => (
          <button
            key={view.key}
            type="button"
            role="tab"
            className={`view-ring-tab${view.key === selectedKey ? ' is-active' : ''}`}
            data-view-key={view.key}
            data-view-owner={view.owner}
            aria-selected={view.key === selectedKey}
            onClick={() => selectView(view.key)}
          >
            {view.title}
          </button>
        ))}
      </div>
      {/* 会话作用域容器：不随视图切换重建（D-32 的 DOM 层证据） */}
      <div className="view-ring-session" data-testid="view-ring-session">
        {activeView !== undefined ? (
          <div className="view-ring-view" role="tabpanel" data-view-key={activeView.key}>
            {activeView.render(context)}
          </div>
        ) : (
          <div className="view-ring-empty" data-testid="view-ring-empty">
            {emptyFallback ?? null}
          </div>
        )}
      </div>
    </div>
  );
}
