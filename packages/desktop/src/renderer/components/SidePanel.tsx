// 右栏标签宿主（Z2-04 / Z-13 / Z-14）：承载方式从「7 个常驻标签条」改为「tab 按需出现」。
//   - 右栏打开但零 tab → 「打开标签页」加号启动器（Z-13）；
//   - tab 从启动器或路由打开（D-86 ① openFile → 「文件」tab；D-86 ②/P2-5 inspect →
//     「模型轨迹」tab，Z-14 语义 id `model-trajectory:{sessionId}`；同一 id 复用），
//     可关闭/拖拽排序/横向滚动（Z-14：tab 最小宽 60、gap 4、标签条 h-12 border-b）；
//   - 状态 = ui-shared side-pane 纯逻辑模块的内存 Map（按会话分桶、LRU 50、不落盘 D-14，
//     右栏关闭仍挂载所以状态不丢）；面板组件本体不动，只换承载；底部「刷新只读视图 / 重新同步」是我们真实的运维入口
//     （ZCode 无此物，刻意保留）；审批徽章保留在审批 tab 上。
//   - Z2-08：新增「后台任务」tab（`background-tasks`，跨会话聚合；启动器项无任务时禁用 + title）；
//     状态面板 Agents 子块的「在右栏打开」经请求通道接到这里（开 tab + 右栏收着就展开）。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react';
import { controller, store, useAppState } from '../app-shared.js';
import { useFrame } from '../layout/frame-context.js';
import type { SessionImageUrlResolver } from '@harness2/ui-shared/renderer/conversation/views/image-url-cache.js';
import {
  ToolFilePreviewPanel,
  useToolFilePreview,
  useToolNavigation,
  type ToolFilePreview,
} from '@harness2/ui-shared/renderer/tool/index.js';
import {
  BackgroundTasksPane,
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  SIDE_PANE_NO_SESSION_KEY,
  SIDE_PANE_TAB_GAP_PX,
  SIDE_PANE_TAB_MIN_WIDTH_PX,
  sidePaneDropIndex,
  sidePaneMoveTarget,
  sidePaneOpenTarget,
  sidePaneTabLabel,
  sidePaneStore,
  trajectoryTabSessionId,
  useSidePaneTabs,
  type SidePaneLauncherItemId,
  type SidePaneTabId,
} from '@harness2/ui-shared/renderer/side-pane/index.js';
import { backgroundTasksPaneRequests } from '../conversation/background-tasks-requests.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@harness2/ui-shared/components/ui/dropdown-menu.js';
import { ScrollArea } from '@harness2/ui-shared/components/ui/scroll-area.js';
import { cn } from '@harness2/ui-shared/lib/utils.js';
import { PlanPanel } from '../features/plan/PlanPanel.js';
import { TaskPanel } from '../features/plan/TaskPanel.js';
import { ApprovalCenter } from '../features/plan/ApprovalCenter.js';
import { ChangeReviewPanel } from '../features/workspace/ChangeReviewPanel.js';
import { WorkspacePanel } from '../features/workspace/WorkspacePanel.js';
import { EffectiveConfigPanel } from '../features/config/EffectiveConfigPanel.js';
import { TrajectoryViewContent, type TrajectorySession } from '../trajectory/index.js';
import { conversationImageUrls, conversationTrajectoryFocus } from '../conversation/assembly.js';
import type { TrajectoryFocusRequest } from '../trajectory/inspect-focus.js';

/** 未选择会话时的分桶（同 ui-shared 侧常量；避免宿主各自写一份字面量） */
const NO_SESSION_BUCKET = SIDE_PANE_NO_SESSION_KEY;
/** 指针拖拽起手阈值（px）：小幅位移仍算点击，不误触重排 */
const DRAG_THRESHOLD_PX = 4;

/* 三个内联小图标（lucide 24×24 同形路径）：桌面不引 lucide-react（依赖归 ui-shared，
   桌面零新增依赖）；统一 stroke=currentColor，尺寸由 className 给。 */
function IconPlus({ className }: { className?: string }): React.ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function IconX({ className }: { className?: string }): React.ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function IconEllipsis({ className }: { className?: string }): React.ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

/** 加号菜单条目（启动器与标签条 + 共用同一份清单；已打开的给「已打开」提示，点击=激活）
 *  Z2-08：「后台任务」项常列但对齐 ZCode bash-output 的按需语义 —— 无后台任务时禁用并给
 *  title 说明（保留可发现性，不摆死入口）；有任务时可点，已打开给「已打开」提示。 */
function TabMenuItems({
  openTabs,
  sessionId,
  backgroundTasksAvailable,
  onOpen,
}: {
  openTabs: readonly SidePaneTabId[];
  /** 当前会话 id（null = 未选会话：「模型轨迹」项禁用 —— 轨迹按会话投影，无会话不摆空入口） */
  sessionId: string | null;
  /** 是否存在后台任务（store.allTasks() 非空；「后台任务」项的可用开关） */
  backgroundTasksAvailable: boolean;
  onOpen: (id: SidePaneLauncherItemId) => void;
}): React.ReactNode {
  return (
    <>
      {SIDE_PANE_LAUNCHER_ITEM_IDS.map((id) => {
        // 「模型轨迹」项：按当前会话解析成 model-trajectory:{sessionId}（Z-14）；无会话 → 禁用
        if (id === 'model-trajectory') {
          const target = sessionId !== null ? sidePaneOpenTarget(id, sessionId) : null;
          return (
            <DropdownMenuItem
              key={id}
              data-side-menu-item={id}
              disabled={target === null}
              title={target === null ? '选择会话后可查看模型轨迹' : undefined}
              onSelect={() => {
                if (target !== null) onOpen(id);
              }}
            >
              <span>{sidePaneTabLabel(sidePaneOpenTarget(id, sessionId ?? ''))}</span>
              {target !== null && openTabs.includes(target) && (
                <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>
              )}
            </DropdownMenuItem>
          );
        }
        // 「后台任务」项：按需可用（Z2-08）——无任务禁用 + title 说明；有任务同普通静态项
        if (id === 'background-tasks') {
          return (
            <DropdownMenuItem
              key={id}
              data-side-menu-item={id}
              disabled={!backgroundTasksAvailable}
              title={backgroundTasksAvailable ? undefined : '暂无后台任务（后台子代理启动后可在此查看）'}
              onSelect={() => {
                if (backgroundTasksAvailable) onOpen(id);
              }}
            >
              <span>{sidePaneTabLabel(id)}</span>
              {backgroundTasksAvailable && openTabs.includes(id) && (
                <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>
              )}
            </DropdownMenuItem>
          );
        }
        const opened = openTabs.includes(id);
        return (
          <DropdownMenuItem key={id} data-side-menu-item={id} onSelect={() => onOpen(id)}>
            <span>{sidePaneTabLabel(id)}</span>
            {opened && <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** 零 tab 启动器（Z-13：右栏打开但没有任何 tab 时的唯一内容） */
function SidePaneLauncher({
  openTabs,
  sessionId,
  backgroundTasksAvailable,
  onOpen,
}: {
  openTabs: readonly SidePaneTabId[];
  sessionId: string | null;
  backgroundTasksAvailable: boolean;
  onOpen: (id: SidePaneLauncherItemId) => void;
}): React.ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4"
      data-testid="side-pane-launcher"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="side-pane-launcher-trigger"
          aria-label="打开标签页"
          title="打开标签页"
          className="flex size-10 cursor-pointer items-center justify-center rounded-lg border border-border text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
        >
          <IconPlus className="size-5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" data-testid="side-pane-launcher-menu">
          <TabMenuItems
            openTabs={openTabs}
            sessionId={sessionId}
            backgroundTasksAvailable={backgroundTasksAvailable}
            onOpen={onOpen}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="text-ui-sm text-foreground-subtle">打开标签页</p>
      <p className="text-ui-xs text-foreground-subtlest">面板按需出现，可随时关闭</p>
    </div>
  );
}

/** 标签条（Z-14）：h-12 border-b、横向滚动（溢出 tab 最小宽 60 / gap 4）、可关闭、指针拖拽排序 */
function SidePaneTabBar({
  bucket,
  sessionId,
  openTabs,
  activeTab,
  approvalCount,
  backgroundTasksAvailable,
  onActivate,
  onClose,
  onMove,
}: {
  /** 关闭其他 / 全部关闭直接走 store（本菜单不经过宿主回调） */
  bucket: string;
  /** 启动器项解析用（= bucket；未选会话时「模型轨迹」项禁用） */
  sessionId: string;
  openTabs: readonly SidePaneTabId[];
  activeTab: SidePaneTabId | null;
  approvalCount: number;
  /** 「后台任务」启动器项的可用开关（Z2-08） */
  backgroundTasksAvailable: boolean;
  onActivate: (id: SidePaneTabId) => void;
  onClose: (id: SidePaneTabId) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
}): React.ReactNode {
  const [draggingId, setDraggingId] = useState<SidePaneTabId | null>(null);
  const itemRefs = useRef(new Map<SidePaneTabId, HTMLElement | null>());
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const stopRef = useRef<(() => void) | null>(null);
  // 拖拽结束后的那次 click 不改激活（拖到别处松手 ≠ 点选）
  const suppressClickRef = useRef(false);

  // 卸载时收掉在途拖拽的全局监听（不留在 window 上）
  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLElement>, id: SidePaneTabId): void => {
    if (e.button !== 0) return;
    stopRef.current?.();
    const startX = e.clientX;
    let moved = false;
    const onPointerMove = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      moved = true;
      setDraggingId(id);
      // 按当前 DOM 顺序取矩形 → 指针越过哪个 tab 中点就落到它前面（纯函数换算，见 side-pane-model）
      const rects = openTabsRef.current.map(
        (t) => itemRefs.current.get(t)?.getBoundingClientRect() ?? { left: 0, right: 0 },
      );
      const drop = sidePaneDropIndex(rects, ev.clientX);
      if (drop === null) return;
      const from = openTabsRef.current.indexOf(id);
      const target = sidePaneMoveTarget(from, drop);
      if (target !== from) onMoveRef.current(from, target);
    };
    const stop = (): void => {
      suppressClickRef.current = moved;
      setDraggingId(null);
      stopRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    stopRef.current = stop;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <div className="flex h-12 flex-none items-stretch border-b" data-testid="side-pane-tabstrip">
      <ScrollArea scrollbarOrientation="horizontal" className="min-w-0 flex-1">
        <div
          role="tablist"
          aria-label="工作面板标签"
          className="flex h-12 w-max min-w-full items-center px-1"
          style={{ gap: SIDE_PANE_TAB_GAP_PX }}
        >
          {openTabs.map((tab) => {
            const active = tab === activeTab;
            return (
              <div
                key={tab}
                ref={(el) => {
                  itemRefs.current.set(tab, el);
                }}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                data-side-tab={tab}
                data-side-tab-active={active ? 'true' : undefined}
                className={cn(
                  'group flex min-w-[60px] max-w-40 shrink-0 cursor-pointer select-none items-center gap-1 rounded-md px-2 py-1 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-border-hover',
                  active
                    ? 'bg-selected text-foreground'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
                  draggingId === tab && 'opacity-60',
                )}
                style={{ minWidth: SIDE_PANE_TAB_MIN_WIDTH_PX }}
                onPointerDown={(e) => startDrag(e, tab)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onActivate(tab);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(tab);
                  }
                }}
              >
                <span className="truncate">{sidePaneTabLabel(tab)}</span>
                {tab === 'approvals' && approvalCount > 0 && (
                  <span
                    className="flex-none rounded-full bg-warning px-1.5 text-ui-xs leading-4 text-warning-foreground"
                    data-side-badge="approvals"
                  >
                    {approvalCount}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`关闭 ${sidePaneTabLabel(tab)} 标签页`}
                  data-side-tab-close={tab}
                  className={cn(
                    'flex size-4 flex-none cursor-pointer items-center justify-center rounded text-foreground-subtlest hover:text-foreground',
                    active ? '' : 'invisible group-hover:visible',
                  )}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab);
                  }}
                >
                  <IconX className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {/* 常驻右簇：+（追加 tab）与 ⋯（关闭其他 / 全部关闭，Z-14 的一处实现） */}
      <div className="flex flex-none items-center gap-0.5 pr-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="打开标签页"
            title="打开标签页"
            data-testid="side-pane-add"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <IconPlus className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="side-pane-add-menu">
            <TabMenuItems
              openTabs={openTabs}
              sessionId={sessionId}
              backgroundTasksAvailable={backgroundTasksAvailable}
              onOpen={(id) => sidePaneStore.open(bucket, sidePaneOpenTarget(id, bucket))}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="标签页操作"
            title="标签页操作"
            data-testid="side-pane-actions"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <IconEllipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="side-pane-actions-menu">
            <DropdownMenuItem
              data-side-action="close-others"
              disabled={openTabs.length < 2}
              onSelect={() => {
                if (activeTab !== null) sidePaneStore.closeOthers(bucket, activeTab);
              }}
            >
              关闭其他标签页
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-side-action="close-all"
              variant="destructive"
              onSelect={() => sidePaneStore.closeAll(bucket)}
            >
              关闭全部标签页
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * 「模型轨迹」tab 内容（Z-14 `model-trajectory:{sessionId}`）：既有轨迹内容组件原样挂载
 * （数据源与 Chat 同一份 store；定位通道与图片缓存来自桌面装配单例）。右栏没有 composer 浮层，
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
  // tab 状态按会话分桶（Z-13 内存 Map）；未选择会话时共用固定桶
  const bucket = sessionId ?? NO_SESSION_BUCKET;
  const tabs = useSidePaneTabs(bucket);
  const approvalCount = store.allApprovals().length;
  // Z2-08：「后台任务」启动器项的可用开关（跨会话聚合口径——后台任务不随选中会话消失）
  const backgroundTasksAvailable = store.allTasks().length > 0;
  const planAvailable = sessionId !== null ? store.peekViews(sessionId)?.planState !== undefined : false;
  // D-86 ①：工具卡经 owner openFile 把文件路径路由到这里
  const navigation = useToolNavigation();
  const filePreview = useToolFilePreview();
  const frame = useFrame();

  // 有**新的**打开文件请求 → 开「文件」tab；右栏关着就把它打开（不静默丢请求）。
  // 按请求对象判重（openFile 每次产生新引用）：只在真请求时路由一次，避免右栏被
  // 迟到的预览反复拽开（旧实现依赖 frame 引用变化有此隐患，本版顺手修掉）。
  const routedPreviewRef = useRef<ToolFilePreview | null>(null);
  useEffect(() => {
    if (filePreview === routedPreviewRef.current) return;
    routedPreviewRef.current = filePreview;
    if (filePreview === null) return;
    sidePaneStore.open(bucket, 'file');
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [filePreview, bucket, frame]);

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
    sidePaneStore.open(bucket, 'background-tasks');
    if (!frame.state.rightbarOpen) frame.dispatch({ type: 'rightbar/toggle' });
  }, [bgTasksRequest, bucket, frame]);

  const sessionCwd = sessionId !== null ? state.sessions.find((s) => s.id === sessionId)?.cwd : undefined;
  const activeTab = tabs.activeTab;
  // 「模型轨迹」tab：id 里的会话 id 决定投影的数据源（tab 属于哪个桶就看哪个会话）
  const trajectorySessionId = activeTab === null ? null : trajectoryTabSessionId(activeTab);

  const closeTab = (id: SidePaneTabId): void => sidePaneStore.close(bucket, id);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background" aria-label="工作面板" data-testid="side-pane">
      {tabs.openTabs.length === 0 ? (
        <SidePaneLauncher
          openTabs={tabs.openTabs}
          sessionId={sessionId}
          backgroundTasksAvailable={backgroundTasksAvailable}
          onOpen={(id) => sidePaneStore.open(bucket, sidePaneOpenTarget(id, bucket))}
        />
      ) : (
        <SidePaneTabBar
          bucket={bucket}
          sessionId={bucket}
          openTabs={tabs.openTabs}
          activeTab={activeTab}
          approvalCount={approvalCount}
          backgroundTasksAvailable={backgroundTasksAvailable}
          onActivate={(id) => sidePaneStore.activate(bucket, id)}
          onClose={closeTab}
          onMove={(from, to) => sidePaneStore.move(bucket, from, to)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="side-pane-body">
        {activeTab === 'plan' && <PlanPanel sessionId={sessionId} />}
        {activeTab === 'tasks' && <TaskPanel sessionId={sessionId} />}
        {activeTab === 'background-tasks' && (
          <BackgroundTasksPane
            store={store}
            onOpenChildSession={(childSessionId) => void controller.selectSession(childSessionId)}
          />
        )}
        {activeTab === 'approvals' && <ApprovalCenter />}
        {activeTab === 'changes' && <ChangeReviewPanel sessionId={sessionId} />}
        {activeTab === 'workspace' && <WorkspacePanel sessionId={sessionId} />}
        {activeTab === 'file' && (
          <ToolFilePreviewPanel
            preview={filePreview}
            {...(sessionCwd !== undefined ? { cwd: sessionCwd } : {})}
            onClear={() => navigation.clearFilePreview()}
          />
        )}
        {activeTab === 'config' && <EffectiveConfigPanel sessionId={sessionId} />}
        {trajectorySessionId !== null && <TrajectoryPaneTab sessionId={trajectorySessionId} />}
      </div>
      {sessionId !== null && (
        <div className="flex flex-none items-center gap-2 border-t px-2 py-1.5 text-ui-sm" data-testid="side-pane-foot">
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={() => void controller.refreshExecutionViews(sessionId)}
          >
            刷新只读视图
          </button>
          <button
            type="button"
            title="重连/恢复后重拉服务端权威任务、队列与待批（resume-subscription）"
            className="cursor-pointer rounded px-1.5 py-0.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={() => void controller.resumeSession(sessionId)}
          >
            重新同步
          </button>
          {!planAvailable && (
            <span className="text-ui-xs text-foreground-subtlest" title="会话无计划账本时该视图为空">
              计划视图依赖任务账本
            </span>
          )}
        </div>
      )}
    </div>
  );
}
