// 右栏标签宿主（Z2-04 / Z-13 / Z-14）—— 桌面侧内容映射。
//
// Z7 起承载实现（零 tab 启动器 / 标签条 / 拖拽排序 / 内容槽 / 底部运维入口）下沉到
// `@harness2/ui-shared/renderer/side-pane/SidePaneHost.js`（壳无关）；Z7-a 起各 tab 的**呈现面板**
// （计划 / 任务 / 审批 / 变更 / 工作区 / 配置 / 模型轨迹）也整体下沉 ui-shared，桌面只留薄适配：
//   1. 路由效应：D-86 ① openFile → 「文件」tab；P2-5 ② inspect → 「模型轨迹」tab；
//      Z2-08 状态面板 Agents「在右栏打开」→ background-tasks tab —— 三者都在右栏收起时
//      一并展开（不静默丢请求）；
//   2. tab 内容映射：把**桌面单例** store/controller（app-shared）注入共享面板；「文件」tab
//      依赖桌面 openFile/预览通道（web 无）故仍留在桌面；模型轨迹 tab 绑定桌面装配单例
//      （图片缓存 / inspect 定位通道）也在此装配；
//   3. 底部「刷新只读视图 / 重新同步」动作与「计划视图依赖任务账本」提示的桌面口径。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { controller, store, useAppState } from '../app-shared.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import type { SessionImageUrlResolver } from '@harness2/ui-shared/renderer/conversation/views/image-url-cache.js';
import {
  ToolFilePreviewPanel,
  useToolFilePreview,
  useToolNavigation,
  type ToolFilePreview,
} from '@harness2/ui-shared/renderer/tool/index.js';
import {
  AutomationsPane,
  BackgroundTasksPane,
  SidePaneHost,
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  SIDE_PANE_NO_SESSION_KEY,
  sidePaneStore,
  trajectoryTabSessionId,
  type CronJobShape,
  type SidePaneTabId,
} from '@harness2/ui-shared/renderer/side-pane/index.js';
import {
  ApprovalCenter,
  ChangeReviewPanel,
  EffectiveConfigPanel,
  PlanPanel,
  TaskPanel,
  WorkspacePanel,
} from '@harness2/ui-shared/renderer/panels/index.js';
import { composerPrefill } from '@harness2/ui-shared/renderer/conversation/composer/prefill.js';
import { backgroundTasksPaneRequests } from '../conversation/background-tasks-requests.js';
import {
  TrajectoryViewContent,
  type TrajectoryFocusRequest,
  type TrajectorySession,
} from '@harness2/ui-shared/renderer/trajectory/index.js';
import { conversationImageUrls, conversationTrajectoryFocus } from '../conversation/assembly.js';

/**
 * 「模型轨迹」tab 内容（Z-14 `model-trajectory:{sessionId}`）：既有轨迹内容组件原样挂载
 * （数据源与 Chat 同一 store；定位通道与图片缓存来自桌面装配单例）。右栏没有 composer 浮层，
 * 不传任何预留参数 —— 记录表缺省兜底解析为 0px，不虚构预留。
 */
function TrajectoryPaneTab({ sessionId }: { sessionId: string }): React.ReactNode {
  const session = useMemo<TrajectorySession>(() => ({ id: sessionId, store, subscribe: store.subscribe }), [sessionId]);
  // 会话作用域图片解析器（与旧视图环同一手法：缓存入口按会话绑定，附件预览共用一次授权读取）
  const imageUrl = useCallback<SessionImageUrlResolver>(
    (attachment) => conversationImageUrls.peekUrl(sessionId, attachment),
    [sessionId],
  );
  return (
    <TrajectoryViewContent
      session={session}
      sessionId={sessionId}
      imageUrl={imageUrl}
      focusStore={conversationTrajectoryFocus}
    />
  );
}

export function SidePanel(): React.ReactNode {
  const state = useAppState();
  const sessionId = state.selectedId;
  const planAvailable = sessionId !== null ? store.peekViews(sessionId)?.planState !== undefined : false;
  // D-86 ①：工具卡经 owner openFile 把文件路径路由到这里
  const navigation = useToolNavigation();
  const filePreview = useToolFilePreview();
  const frame = useFrame();
  const sessionCwd = sessionId !== null ? state.sessions.find((s) => s.id === sessionId)?.cwd : undefined;
  // 桌面专属端口：上下文占用读（preload IPC；core getContextUsage 单一实现）——注入共享配置面板。
  const getContextUsage = useCallback((id: string) => window.harness2.getContextUsage(id), []);

  // P0-3a 自动化（cron）：本地 jobs.json 任务表（主进程 fs 只读）。桌面壳挂载时拉一次注入 pane
  //（D-14 内存态：不写任何存储、不轮询——数据是挂载快照，如实展示不假装实时，改任务走 CLI 后重开
  // 面板可见）。通道缺失（理论不发生：preload 必给；jsdom 夹具可能无）→ 空表，pane 落空态文案
  //（红线⑩：无通道不摆假数据）。
  const [cronJobs, setCronJobs] = useState<readonly CronJobShape[]>([]);
  useEffect(() => {
    const read = window.harness2.cronList;
    if (read === undefined) return;
    let alive = true;
    void read
      .call(window.harness2)
      .then((jobs) => {
        if (alive) setCronJobs(jobs);
      })
      .catch(() => {
        if (alive) setCronJobs([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  const nowMs = useMemo(() => Date.now(), []);

  // 有**新的**打开文件请求 → 开「文件」tab；右栏关着就把它打开（不静默丢请求）。
  // 按请求对象判重（openFile 每次产生新引用）：只在真请求时路由一次，避免右栏被
  // 迟到的预览反复拽开（旧实现依赖 frame 引用变化有此隐患，本版顺手修掉）。
  const routedPreviewRef = useRef<ToolFilePreview | null>(null);
  useEffect(() => {
    if (filePreview === routedPreviewRef.current) return;
    routedPreviewRef.current = filePreview;
    if (filePreview === null) return;
    const bucket = sessionId ?? SIDE_PANE_NO_SESSION_KEY;
    sidePaneStore.open(bucket, 'file');
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [filePreview, sessionId, frame]);

  // P2-5 改道（D-86 ②）：工具卡 inspect → 右栏「模型轨迹」tab。tab 的打开/激活由装配层消费者
  // （assembly.createTrajectoryInspectConsumer → sidePaneStore）完成；这里只负责**右栏可见性**：
  // 有新的定位请求且右栏收起 → 展开（不静默丢请求）。请求对象判重同上（新引用 = 新请求）。
  const focusRequest = useSyncExternalStore(
    conversationTrajectoryFocus.subscribe,
    conversationTrajectoryFocus.getSnapshot,
    () => null,
  );
  const routedFocusRef = useRef<TrajectoryFocusRequest | null>(null);
  useEffect(() => {
    if (focusRequest === routedFocusRef.current) return;
    routedFocusRef.current = focusRequest;
    if (focusRequest === null) return;
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [focusRequest, frame]);

  // Z2-08：状态面板 Agents 子块「在右栏打开」→ 开/激活 background-tasks tab；右栏收着就展开
  //（tab 归属本宿主的会话桶 —— 请求通道不带载荷，桶在这里解析）。请求对象判重同上。
  const bgTasksRequest = useSyncExternalStore(
    backgroundTasksPaneRequests.subscribe,
    backgroundTasksPaneRequests.getSnapshot,
    () => null,
  );
  const routedBgTasksRef = useRef<{ readonly at: number } | null>(null);
  useEffect(() => {
    if (bgTasksRequest === routedBgTasksRef.current) return;
    routedBgTasksRef.current = bgTasksRequest;
    if (bgTasksRequest === null) return;
    const bucket = sessionId ?? SIDE_PANE_NO_SESSION_KEY;
    sidePaneStore.open(bucket, 'background-tasks');
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [bgTasksRequest, sessionId, frame]);

  const renderTab = useCallback(
    (id: SidePaneTabId): React.ReactNode => {
      const trajectorySessionId = trajectoryTabSessionId(id);
      if (trajectorySessionId !== null) return <TrajectoryPaneTab sessionId={trajectorySessionId} />;
      switch (id) {
        case 'plan':
          return <PlanPanel store={store} controller={controller} sessionId={sessionId} />;
        case 'tasks':
          return <TaskPanel store={store} controller={controller} sessionId={sessionId} />;
        case 'background-tasks':
          return (
            <BackgroundTasksPane
              store={store}
              onOpenChildSession={(childSessionId) => void controller.selectSession(childSessionId)}
            />
          );
        case 'automations':
          // P0-3a：cron 只读列表（无启停按钮——通道不存在，红线⑩；数据 = 挂载快照）
          return <AutomationsPane jobs={cronJobs} nowMs={nowMs} />;
        case 'approvals':
          return <ApprovalCenter store={store} controller={controller} />;
        case 'changes':
          return <ChangeReviewPanel store={store} controller={controller} sessionId={sessionId} />;
        case 'workspace':
          return <WorkspacePanel store={store} controller={controller} sessionId={sessionId} />;
        case 'file':
          return (
            <ToolFilePreviewPanel
              preview={filePreview}
              {...(sessionCwd !== undefined ? { cwd: sessionCwd } : {})}
              onClear={() => navigation.clearFilePreview()}
              // Z4-02：行「评论」→ 引用块经预填通道进当前会话 composer（追加不覆盖；不夺焦点）。
              // 未选会话不传回调 = 整个文件不渲染评论入口（红线⑩：无可预填目标不摆空入口）。
              {...(sessionId !== null
                ? {
                    onQuote: (quote: string) => {
                      composerPrefill.request({ sessionId, quote, focus: false });
                    },
                  }
                : {})}
            />
          );
        case 'config':
          // 桌面提供上下文占用读端口（preload IPC）；web 无此通道 → 不注入即不显示占用注记。
          return (
            <EffectiveConfigPanel
              store={store}
              controller={controller}
              sessionId={sessionId}
              getContextUsage={getContextUsage}
            />
          );
        default:
          return null;
      }
    },
    [sessionId, filePreview, sessionCwd, navigation, getContextUsage, cronJobs, nowMs],
  );

  return (
    <SidePaneHost
      store={store}
      sessionId={sessionId}
      renderTab={renderTab}
      items={SIDE_PANE_LAUNCHER_ITEM_IDS}
      onRefresh={(id) => void controller.refreshExecutionViews(id)}
      onResync={(id) => void controller.resumeSession(id)}
      planAvailable={planAvailable}
      onOpenChildSession={(childSessionId) => void controller.selectSession(childSessionId)}
    />
  );
}
