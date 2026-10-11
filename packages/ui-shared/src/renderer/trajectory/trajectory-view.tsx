// 轨迹内容组件（D-40～D-47）。
//
// Z2-05（Z-14 / Z-16）：trajectory 不再是主区视图环的标签页（主区无视图环），而是**右栏 tab**
// （Z-14 语义 id `model-trajectory:{sessionId}`）。本文件只提供内容组件 `TrajectoryViewContent`，
// 由壳的右栏宿主（desktop `components/SidePanel.tsx`）挂载；不注册进任何装配。
//
// 数据源：注入的 `store`（与 Chat 同一份 store，绝不另开数据通道）。
//   * 事件流 → 投影（projection.ts，纯函数）；
//   * TTFT：core 日志不含首 token 时刻 → 由本组件对 store 的实时输出做**运行时观测**
//     （timing.ts；未观测到就留空，不估算 —— D-47）。
// D-46：composer 浮层预留只服务 chat 主视图；右栏 tab 不浮在 composer 之下，本组件不再接收
// `composerInsetPx`（记录表的缺省兜底解析为 0px，不虚构预留）。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { SessionImageUrlResolver } from '../conversation/views/image-url-cache.js';
import type { AppStore } from '../store.js';
import { findFocusRowKey, type TrajectoryFocusStore } from './inspect-focus.js';
import { projectTrajectory } from './projection.js';
import { currentStreamingStepId, TrajectoryTimingObserver } from './timing.js';
import { TrajectoryPanel } from './trajectory-panel.js';

/** 视图需要的会话对象最小面（右栏宿主传真实数据源；与 Chat 同源） */
export interface TrajectorySession {
  readonly id: string;
  readonly store: AppStore;
  /** 可选会话订阅（缺省退化为 store.subscribe） */
  readonly subscribe?: (listener: () => void) => () => void;
}

export interface TrajectoryViewContentProps {
  readonly session: TrajectorySession;
  readonly sessionId: string;
  readonly imageUrl?: SessionImageUrlResolver;
  /** P2-5：D-86 ② inspect 的定位通道（宿主注入；缺省 = 不定位） */
  readonly focusStore?: TrajectoryFocusStore;
  readonly rowHeightPx?: number;
  readonly viewportHeightPx?: number;
  readonly overscan?: number;
  readonly pageSize?: number;
  readonly overviewWidthPx?: number;
}

/**
 * 轨迹内容：订阅 store → 投影 → 渲染面板。
 * 「换会话不重建」：会话对象由宿主注入且引用稳定；本组件只在 sessionId 变化时清空观测。
 */
export function TrajectoryViewContent(props: TrajectoryViewContentProps): ReactNode {
  const { session, sessionId, imageUrl } = props;
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
      {...(props.rowHeightPx !== undefined ? { rowHeightPx: props.rowHeightPx } : {})}
      {...(props.viewportHeightPx !== undefined ? { viewportHeightPx: props.viewportHeightPx } : {})}
      {...(props.overscan !== undefined ? { overscan: props.overscan } : {})}
      {...(props.pageSize !== undefined ? { pageSize: props.pageSize } : {})}
      {...(props.overviewWidthPx !== undefined ? { overviewWidthPx: props.overviewWidthPx } : {})}
    />
  );
}
