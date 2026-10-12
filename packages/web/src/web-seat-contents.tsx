// web 席位内容装配（对标桌面 `layout/shell-seat-contents.tsx`，但**只接 web 真实具备的 store/controller**）。
//
// 注入 owner 用能力包名（ui-sidebar / ui-conversation / ui-workspace），内容组件复用 ui-shared：
//   * 侧栏 = SidebarRoot（品牌 / New Task / 命令中心入口 / 会话列表（可拖进分屏）/ 折叠 264→4px）；
//   * 中栏 conversation = **分屏工作台** WorkbenchHost（共享，二叉分割树 ≤4 格）+ web 连接/新建阻断提示条，
//     每格渲染 web 会话席位（共享 ConversationSeat + web 会话头）；布局只存内存（D-14 不落盘）；
//   * 右栏 = SidePaneHost（零 tab 启器 + 标签条）；Z7-a 起与桌面列**同一套**启动器清单：
//       计划 / 任务 / 后台任务 / 审批 / 变更 / 工作区 / 配置 / 模型轨迹 —— 全部复用 ui-shared 面板，
//       数据经共享 controller 走 serve 的 S7 只读端点（run-config / plan-state / execution-view /
//       change-review）与 WS 事件流，web 真能取数；
//       「文件」不在启动器清单（桌面亦同：D-86 openFile 路由按需打开）——web 无 openFile 预览通道，
//       故不列、也不补假入口（红线⑩）。
//   * 覆层席位：web 设置覆层（复用共享设置页）+ 命令面板覆层（共享 CommandPalette，
//     命令表/会话候选由 web 壳组装，见 web-command-palette.tsx）。
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StatusBadge } from '@harness2/ui-shared/renderer/app-shell.js';
import { ConversationSeat, type ConversationSeatProps } from '@harness2/ui-shared/renderer/conversation/seat.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { WorkbenchHost } from '@harness2/ui-shared/renderer/layout/workbench/host.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import { countPanes, MAX_PANES } from '@harness2/ui-shared/renderer/layout/workbench/model.js';
import {
  CONVERSATION_OWNER,
  FRAME_SEAT,
  MAIN_CONVERSATION_KEY,
} from '@harness2/ui-shared/renderer/layout/frame-seats.js';
import {
  BackgroundTasksPane,
  SidePaneHost,
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  sidePaneStore,
  trajectoryTabId,
  trajectoryTabSessionId,
  type SidePaneLauncherItemId,
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
import { TrajectoryViewContent } from '@harness2/ui-shared/renderer/trajectory/index.js';
import { buildSessionItems, resolveBuildVersion, SidebarRoot } from '@harness2/ui-shared/renderer/sidebar/index.js';
import type { SlotRegistry } from '@harness2/ui-shared/renderer/slots/index.js';
import { useWebShell } from './web-shell-context.js';
import { WebPaletteOverlay } from './web-command-palette.js';
import { WebSettingsOverlay } from './web-settings.js';

/** 渲染进程可读的宿主环境表（web 浏览器无 Node `process` → 空表，版本徐标自然不显示） */
function hostBuildEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/**
 * web 右栏可打开的启动器项白名单。
 * Z7-a：桌面启动器清单里的 8 项 web **全部真能取数渲染**（共享面板 + serve S7 端点 + WS 事件流），
 * 故与桌面同清单；「文件」本就不在启动器清单（桌面靠 openFile 路由按需打开，web 无此通道）。
 * P0-3a：「自动化」web 同样排除——cron 任务表是本地文件（jobs.json），读通道只在桌面主进程
 * （skills/cron-scan 同族）；web 无此数据面，列出来点开就是空 tab（红线⑩不摆假入口）。
 */
const WEB_SIDE_PANE_ITEMS: readonly SidePaneLauncherItemId[] = SIDE_PANE_LAUNCHER_ITEM_IDS.filter(
  (id) => id !== 'automations',
);

/** 侧栏席位内容（ui-sidebar）：SidebarRoot + 会话列表接线 + 命令中心入口 + 会话行拖拽源（Z-19） */
function SidebarSeatContent(): ReactNode {
  const { shell, onNewSession, newSessionEnabled, onOpenSettings, onOpenPalette } = useWebShell();
  const state = shell.useAppState();
  const { store, controller } = shell;
  const { geometry, state: frameState, dispatch: frameDispatch } = useFrame();
  const [query, setQuery] = useState('');
  // Z2-06（Z-19）：已在分屏中的会话禁用拖拽（左栏行可拖进主区分屏）
  const workbench = useSyncExternalStore(workbenchStore.subscribe, workbenchStore.getSnapshot);
  const panedSessionIds = useMemo(() => new Set(Object.values(workbench.bindings)), [workbench.bindings]);

  // 行数据：store 摘要 + 展示态覆层（复用 shared/metadata；不复制过滤规则）
  const { active, archived } = buildSessionItems({
    sessions: state.sessions,
    metadata: state.metadata,
    query,
    flagsOf: (id) => {
      const stream = store.peekStream(id);
      return stream === undefined
        ? undefined
        : { running: stream.running, unread: stream.unread, pendingApprovals: stream.approvals.length };
    },
  });

  return (
    <SidebarRoot
      collapsed={geometry.sidebarCollapsed}
      width={geometry.sidebarExpandedWidth}
      onToggleCollapse={() => frameDispatch({ type: 'sidebar/toggle' })}
      sessions={active}
      archivedSessions={archived}
      selectedId={state.selectedId}
      query={query}
      onQueryChange={setQuery}
      onOpenSession={(id) => void controller.selectSession(id)}
      // Z8-1：Pinned 行的「取消置顶」（置顶动作本体在 Z8-2 右键菜单）。
      // web 无 metadata 覆层通道（serve-client 注释如实登记）→ 置顶在内存生效、不落盘；
      // 也因此 web 的 Pinned 区恒不出现（metadata 为空 → 无置顶项），不摆假条目。
      onTogglePin={(id, pinned) => void controller.pinSession(id, pinned)}
      // P0-2（Z-10）右键菜单：与桌面同构（metadata 动作内存生效并由 controller 如实提示；
      // 分屏/轨迹走共享 workbenchStore / sidePaneStore 单例）。
      rowMenu={{
        onPin: (id, pinned) => void controller.pinSession(id, pinned),
        onArchive: (id, archived) => void controller.archiveSession(id, archived),
        onOpenInSplit: (id) => {
          const snap = workbenchStore.getSnapshot();
          workbenchStore.dropSession({ sessionId: id, targetLeafId: snap.focusedId, side: 'right' });
        },
        splitLimitReached: countPanes(workbench.root) >= MAX_PANES,
        onInspectTrajectory: (id) => {
          void controller.selectSession(id);
          sidePaneStore.open(id, trajectoryTabId(id));
          if (!frameState.rightbarOpen) frameDispatch({ type: 'rightbar/toggle' });
        },
      }}
      onSubmitRename={(id, title) => controller.renameSession(id, title)}
      // web 无目录选择通道：作用域输入只能是 {}（resolveNewSessionScope 恒落 blank），
      // 真正的 cwd 由 serve 客户端用「最近会话 cwd」兜底（见 main.tsx / serve-client 注释）。
      newSessionScope={{}}
      onNewSession={() => onNewSession?.()}
      newSessionEnabled={newSessionEnabled}
      // Z-07 #1：New Task 的 Ctrl+N 快捷键（web app.tsx 已真绑定 Ctrl/Cmd+N，同一可用性门控）。
      newSessionShortcut="Ctrl+N"
      // Z2-02（Z-07 分区 2）：左栏命令中心入口 → 打开命令面板覆层（与 Ctrl/Cmd+K 同一真源）。
      onOpenCommandPalette={() => onOpenPalette()}
      // P0-3a：web 无 cron 本地读通道 → 不传 onOpenAutomations（「自动化」入口不渲染，
      // 与右栏白名单排除同口径）。诚实占位旗标与桌面一致（用户拍板：插件市场/账号只占位）。
      placeholders
      // Z2-06（Z-19）：会话行可拖进主区分屏。生产写 dataTransfer（真实 DnD 语义），
      // 模块级 workbenchDrag 作等价回退（jsdom 单测无标准 dataTransfer）。
      sessionRowDrag={{
        onDragStart: (id, event) => {
          workbenchDrag.begin(id);
          const transfer = event.dataTransfer;
          if (transfer !== undefined && transfer !== null) {
            transfer.setData('text/plain', id);
            transfer.effectAllowed = 'copy';
          }
        },
        onDragEnd: () => workbenchDrag.end(),
        disabledIds: panedSessionIds,
      }}
      buildVersion={resolveBuildVersion(hostBuildEnv())}
      // 底部状态角标（与桌面同一 StatusBadge）+ 设置入口（Z7：打开设置覆层，复用共享设置页）
      renderSettings={() => (
        <div className="flex items-center justify-between gap-2 px-1">
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
          <button
            type="button"
            className="text-ui-base text-foreground-subtle hover:text-foreground cursor-pointer"
            data-testid="sidebar-settings"
            aria-label="设置"
            title="设置"
            onClick={() => onOpenSettings()}
          >
            ⚙
          </button>
        </div>
      )}
    />
  );
}

/**
 * 会话席位内容（web）：共享 ConversationSeat + web 会话头（标题/cwd/右栏开关）。
 * Z-19（Z2-06）：作为 `WorkbenchHost` 的每格 seat 注入 —— 主格用本头；非主格由 WorkbenchHost
 * 经 `header` 缝传入轻量 `PaneHeader`（`props.header` 优先，避免多格重复窗控）。
 */
function WebConversationSeat(props: ConversationSeatProps): ReactNode {
  const { shell } = useWebShell();
  const { store } = shell;
  const state = shell.useAppState();
  const frame = useFrame();
  const rightbarOpen = frame.state.rightbarOpen;

  const header = useMemo(
    () =>
      (info: { sessionId: string; cwd?: string }): ReactNode => {
        const summary = state.sessions.find((s) => s.id === info.sessionId);
        return (
          <div className="web-conversation-header">
            <span className="web-conversation-title">
              {store.displayTitleFor(info.sessionId) ?? summary?.firstUserText ?? '(空会话)'}
            </span>
            {info.cwd !== undefined ? <span className="web-conversation-cwd">{info.cwd}</span> : null}
            {/* 右栏开关（对标桌面会话列头）：web 无窗口控制扩展，只留面板开关 */}
            <button
              type="button"
              data-testid="web-rightbar-toggle"
              aria-label="右栏开关"
              aria-pressed={rightbarOpen}
              title={rightbarOpen ? '收起右栏' : '打开右栏'}
              className="web-rightbar-toggle"
              onClick={() => frame.dispatch({ type: 'rightbar/toggle' })}
            >
              右栏
            </button>
          </div>
        );
      },
    [state.sessions, store, frame, rightbarOpen],
  );

  // Z-19：非主格由 WorkbenchHost 注入 PaneHeader（props.header 存在）→ 优先用它。
  return <ConversationSeat {...props} header={props.header ?? header} />;
}

/**
 * 中栏 conversation 席位内容（ui-conversation）：web 连接/新建阻断提示条 + **分屏工作台**（Z-19）。
 * Z2-06（Z2-03）：分屏发生在 conversation 面板**内部**（二叉分割树 ≤4 格）；单格时与旧结构等价。
 * 布局只存内存（`workbenchStore` 单例，不落盘，D-14）。
 */
function ConversationSeatContent(): ReactNode {
  const { shell, newSessionBlockedReason } = useWebShell();
  const state = shell.useAppState();
  const connected = state.status === 'connected';

  return (
    <div className="web-main">
      {!connected ? (
        <div className="web-banner" data-testid="web-connection-banner">
          {state.status === 'connecting'
            ? '正在连接 serve…（dev 需先启动 harness2 serve，且 Vite 代理指向它）'
            : state.status === 'reconnecting'
              ? '与 serve 的连接中断，正在重连…'
              : `serve 不可用：${state.statusDetail?.error ?? '连接已放弃'}`}
        </div>
      ) : null}
      {newSessionBlockedReason !== undefined ? (
        <div className="web-banner web-banner-warn" data-testid="web-new-session-blocked">
          {newSessionBlockedReason}
        </div>
      ) : null}
      <WorkbenchHost store={shell.store} controller={shell.controller} seat={WebConversationSeat} />
    </div>
  );
}

/**
 * 右栏席位内容（ui-workspace）：SidePaneHost + 与桌面**同一套**面板。
 * 数据源 = 共享 controller 经 serve（S7 只读端点 + WS 事件流）；面板本体全部来自 ui-shared，
 * web 不做第二份实现。模型轨迹按 `model-trajectory:{sessionId}` 解析（Z-14）。
 */
function RightbarSeatContent(): ReactNode {
  const { shell } = useWebShell();
  const { store, controller } = shell;
  const state = shell.useAppState();
  const sessionId = state.selectedId;

  const renderTab = (id: SidePaneTabId): ReactNode => {
    const trajectorySessionId = trajectoryTabSessionId(id);
    if (trajectorySessionId !== null) {
      // web 无 inspect 定位通道 / 会话图片缓存 → 不注入 focusStore / imageUrl（如实不定位）；
      // 事件流本身来自共享 store，投影与表格正常渲染。
      return <TrajectoryViewContent session={{ id: trajectorySessionId, store }} sessionId={trajectorySessionId} />;
    }
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
      case 'approvals':
        return <ApprovalCenter store={store} controller={controller} />;
      case 'changes':
        return <ChangeReviewPanel store={store} controller={controller} sessionId={sessionId} />;
      case 'workspace':
        return <WorkspacePanel store={store} controller={controller} sessionId={sessionId} />;
      case 'config':
        // web 无上下文占用读通道 → 不注入 getContextUsage（不显示占用注记，不摆假数据）。
        return <EffectiveConfigPanel store={store} controller={controller} sessionId={sessionId} />;
      default:
        return null;
    }
  };

  return (
    <SidePaneHost
      store={store}
      sessionId={sessionId}
      renderTab={renderTab}
      items={WEB_SIDE_PANE_ITEMS}
      onRefresh={(id) => void controller.refreshExecutionViews(id)}
      onResync={(id) => void controller.resumeSession(id)}
      onOpenChildSession={(childSessionId) => void controller.selectSession(childSessionId)}
    />
  );
}

/**
 * 把 web 四席位内容注入注册表；返回 disposer（逐个卸载）。
 * 语义同桌面：注册表对同一 keyed key 拒绝重复注入、对 list 席位追加。
 */
export function injectWebSeatContents(registry: SlotRegistry): () => void {
  const disposers = [
    registry.inject({ seat: FRAME_SEAT.sidebar, owner: 'ui-sidebar', component: SidebarSeatContent }),
    registry.inject({
      seat: FRAME_SEAT.main,
      key: MAIN_CONVERSATION_KEY,
      owner: CONVERSATION_OWNER,
      component: ConversationSeatContent,
    }),
    registry.inject({ seat: FRAME_SEAT.rightbar, owner: 'ui-workspace', component: RightbarSeatContent }),
    // 覆层席位（Z7）：设置页复用共享实现（端口只接 web 真能做到的 appearance/gateway）；
    // 命令面板复用共享 CommandPalette（命令表/会话候选由 web 壳组装，见 web-command-palette.tsx）。
    // 顺序对齐桌面：设置在下（order 0）、命令面板在上（order 1）。
    registry.inject({ seat: FRAME_SEAT.overlay, owner: 'ui-settings', order: 0, component: WebSettingsOverlay }),
    registry.inject({ seat: FRAME_SEAT.overlay, owner: 'ui-commands', order: 1, component: WebPaletteOverlay }),
  ];
  return () => {
    for (const d of disposers) d();
  };
}

/** 启动器全量清单（供测试/诊断核对 web 白名单是它的子集；不用于渲染） */
export const WEB_SIDE_PANE_ALL_ITEMS = SIDE_PANE_LAUNCHER_ITEM_IDS;
