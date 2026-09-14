// 轨迹视图（D-40）：`conversation.view` 视图环里的 Trajectory 标签页（**不是弹窗**）。
//
// 本文件只**提供视图定义**（key='trajectory'）+ 内容组件；**不注册进任何装配** ——
// 视图环是 P5 的产出（`conversation/views/**`），把本定义注册进注册表是接线棒的职责
// （接线方式见 `createTrajectoryViewDefinition()` 的用法注释）。
//
// 数据源：会话对象的 `store`（与 Chat 视图同一个 store，绝不另开数据通道）。
//   * 事件流 → 投影（projection.ts，纯函数）；
//   * TTFT：core 日志不含首 token 时刻 → 由本视图对 store 的实时输出做**运行时观测**
//     （timing.ts；未观测到就留空，不估算 —— D-47）。
// D-46：composer 浮层预留高度经 `ComposerOverlayHost` 注入（或退化为读 CSS 变量）。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { SessionImageUrlResolver } from '../conversation/views/image-url-cache.js';
import type { ConversationViewDefinition, ConversationViewProps } from '../conversation/views/view-registry.js';
import type { AppStore } from '../store.js';
import { findFocusRowKey, type TrajectoryFocusStore } from './inspect-focus.js';
import { projectTrajectory } from './projection.js';
import { overlayInsetFromHost, type ComposerOverlayHost } from './shell-contract.js';
import { currentStreamingStepId, TrajectoryTimingObserver } from './timing.js';
import { TrajectoryPanel } from './trajectory-panel.js';

/** 视图 key（D-40；会话内唯一，与 P5 的 'chat' 并列） */
export const TRAJECTORY_VIEW_KEY = 'trajectory';
/** 标签标题 */
export const TRAJECTORY_VIEW_TITLE = 'Trajectory';
/** 归属包名（D-02 口径：一个 UI 能力一个包名） */
export const TRAJECTORY_OWNER = 'ui-trajectory';

/** 视图需要的会话对象最小面（装配层传真实 ConversationSession，结构兼容） */
export interface TrajectorySession {
  readonly id: string;
  readonly store: AppStore;
  /** 可选会话订阅（视图环已订阅；单独使用时退化为 store.subscribe） */
  readonly subscribe?: (listener: () => void) => () => void;
}

/** D-46：订阅壳的 composer 浮层实测高度；壳未接（undefined）或未测量 → undefined（记录表读 CSS 变量） */
export function useComposerOverlayInset(host: ComposerOverlayHost | undefined): number | undefined {
  const subscribe = useCallback(
    (listener: () => void) => (host === undefined ? () => undefined : host.subscribe(listener)),
    [host],
  );
  const getSnapshot = useCallback(() => (host === undefined ? undefined : host.getState()), [host]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  const inset = overlayInsetFromHost(state);
  return inset.paddingBottomPx > 0 ? inset.paddingBottomPx : undefined;
}

export interface TrajectoryViewContentProps {
  readonly session: TrajectorySession;
  readonly sessionId: string;
  readonly imageUrl?: SessionImageUrlResolver;
  readonly composerInsetPx?: number;
  /** P2-5：D-86 ② inspect 的定位通道（装配层注入；缺省 = 不定位） */
  readonly focusStore?: TrajectoryFocusStore;
  readonly rowHeightPx?: number;
  readonly viewportHeightPx?: number;
  readonly overscan?: number;
  readonly pageSize?: number;
  readonly overviewWidthPx?: number;
}

/**
 * 轨迹视图内容：订阅 store → 投影 → 渲染面板。
 * 「换会话不重建」：会话对象由视图环注入且引用稳定；本组件只在 sessionId 变化时清空观测。
 */
export function TrajectoryViewContent(props: TrajectoryViewContentProps): ReactNode {
  const { session, sessionId, imageUrl, composerInsetPx } = props;
  const focusStore = props.focusStore;
  const store = session.store;
  const subscribe = session.subscribe ?? store.subscribe;
  const getRevision = useCallback(() => store.getState().rev, [store]);
  const revision = useSyncExternalStore(subscribe, getRevision, () => 0);

  // P2-5：inspect 定位请求（D-86 ②）。无注入缝 → 恒 null（不定位，不造假）。
  const subscribeFocus = useCallback(
    (listener: () => void) => (focusStore === undefined ? () => undefined : focusStore.subscribe(listener)),
    [focusStore],
  );
  const getFocus = useCallback(() => (focusStore === undefined ? null : focusStore.getSnapshot()), [focusStore]);
  const focusRequest = useSyncExternalStore(subscribeFocus, getFocus, () => null);

  const observerRef = useRef<TrajectoryTimingObserver | null>(null);
  if (observerRef.current === null) observerRef.current = new TrajectoryTimingObserver();
  const [firstOutputAtMs, setFirstOutputAtMs] = useState<Readonly<Record<string, number>>>({});

  // 换会话：TTFT 观测属于会话进程内状态，必须清空（不把上一会话的观测带过去）
  useEffect(() => {
    const observer = observerRef.current;
    if (observer === null) return;
    observer.clear();
    setFirstOutputAtMs(observer.snapshot());
  }, [sessionId]);

  const stream = store.peekStream(sessionId);
  const liveTextLength = stream?.live.text.length ?? 0;
  const liveReasoningLength = stream?.live.reasoning.length ?? 0;

  // 首 token 观测：当前模型 step 已开始且有实时输出 → 记下真实墙上时间（唯一诚实来源）
  useEffect(() => {
    const observer = observerRef.current;
    if (observer === null || stream === undefined) return;
    const stepId = currentStreamingStepId(stream.events);
    if (stepId === undefined) return;
    const hasOutput = stream.live.text.length > 0 || stream.live.reasoning.length > 0;
    if (observer.observe(stepId, hasOutput)) setFirstOutputAtMs(observer.snapshot());
  }, [stream, liveTextLength, liveReasoningLength]);

  const model = useMemo(
    () =>
      projectTrajectory({
        events: stream?.events ?? [],
        ...(stream !== undefined ? { turnEnds: stream.turnEnds, running: stream.running } : {}),
        firstOutputAtMs,
        sessionId,
      }),
    // revision：store 每次 notify 产生新版本；事件数组引用与观测表变化都会重投影
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, sessionId, firstOutputAtMs, stream?.events],
  );

  // P2-5：请求 → 模型里的目标行键（纯函数；会话不匹配/找不到 → null，不猜、不乱选）
  const focusKey = useMemo(() => findFocusRowKey(model, focusRequest, sessionId), [model, focusRequest, sessionId]);

  return (
    <TrajectoryPanel
      model={model}
      focusKey={focusKey}
      {...(imageUrl !== undefined ? { imageUrl } : {})}
      {...(composerInsetPx !== undefined ? { composerInsetPx } : {})}
      {...(props.rowHeightPx !== undefined ? { rowHeightPx: props.rowHeightPx } : {})}
      {...(props.viewportHeightPx !== undefined ? { viewportHeightPx: props.viewportHeightPx } : {})}
      {...(props.overscan !== undefined ? { overscan: props.overscan } : {})}
      {...(props.pageSize !== undefined ? { pageSize: props.pageSize } : {})}
      {...(props.overviewWidthPx !== undefined ? { overviewWidthPx: props.overviewWidthPx } : {})}
    />
  );
}

export interface TrajectoryViewOptions {
  readonly owner?: string;
  readonly title?: string;
  /** D-46：壳的 composer 浮层测量宿主（注入后按实测高度预留；未注入 → 读 CSS 变量） */
  readonly composerHost?: ComposerOverlayHost;
  /** P2-5：D-86 ② inspect 的定位通道（装配层注入；未注入 → 打开轨迹只切换视图，不定位） */
  readonly focusStore?: TrajectoryFocusStore;
  readonly rowHeightPx?: number;
  readonly viewportHeightPx?: number;
  readonly overscan?: number;
  readonly pageSize?: number;
  readonly overviewWidthPx?: number;
}

/**
 * 生成 Trajectory 视图定义（**只定义、不注册**）。
 * 接线棒用法（伪代码）：
 *   const registry = createDesktopConversationViewRegistry();
 *   registry.register(createTrajectoryViewDefinition<ConversationSession>({ composerHost }));
 */
export function createTrajectoryViewDefinition<S extends TrajectorySession>(
  options: TrajectoryViewOptions = {},
): ConversationViewDefinition<S> {
  const owner = options.owner ?? TRAJECTORY_OWNER;
  const title = options.title ?? TRAJECTORY_VIEW_TITLE;
  const composerHost = options.composerHost;
  const focusStore = options.focusStore;

  function BoundTrajectoryView(props: ConversationViewProps<S>): ReactNode {
    const composerInsetPx = useComposerOverlayInset(composerHost);
    return (
      <TrajectoryViewContent
        session={props.session}
        sessionId={props.sessionId}
        imageUrl={props.imageUrl}
        {...(composerInsetPx !== undefined ? { composerInsetPx } : {})}
        {...(focusStore !== undefined ? { focusStore } : {})}
        {...(options.rowHeightPx !== undefined ? { rowHeightPx: options.rowHeightPx } : {})}
        {...(options.viewportHeightPx !== undefined ? { viewportHeightPx: options.viewportHeightPx } : {})}
        {...(options.overscan !== undefined ? { overscan: options.overscan } : {})}
        {...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {})}
        {...(options.overviewWidthPx !== undefined ? { overviewWidthPx: options.overviewWidthPx } : {})}
      />
    );
  }

  return { key: TRAJECTORY_VIEW_KEY, title, owner, component: BoundTrajectoryView };
}
