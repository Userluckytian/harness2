// web 席位内容装配（对标桌面 `layout/shell-seat-contents.tsx`，但**只接 web 真实具备的 store/controller**）。
//
// 注入 owner 用能力包名（ui-sidebar / ui-conversation / ui-workspace），内容组件复用 ui-shared：
//   * 侧栏 = SidebarRoot（品牌 / New Task / 命令中心（web 无 → 不注入即不渲染）/ 会话列表 / 折叠 264→4px）；
//   * 中栏 conversation = 共享 ConversationSeat（转录 + 常驻 composer）+ web 连接/新建阻断提示条；
//   * 右栏 = SidePaneHost（零 tab 启器 + 标签条），tab 只列**web 真能取数**的两项：
//       审批（store.allApprovals + controller.respondApproval）、后台任务（store.allTasks）；
//       其余 tab（计划 / 任务 / 变更 / 工作区 / 配置 / 文件 / 模型轨迹）在 web 缺对应呈现组件或数据通道，
//       如实不列（红线⑩：不摆假入口）。
//   * 覆层席位：web 无设置页 / 命令面板数据通道 → 不注入（零覆层，如实空）。
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StatusBadge } from '@harness2/ui-shared/renderer/app-shell.js';
import { toApprovalCardModel, ApprovalCard } from '@harness2/ui-shared/renderer/approval/index.js';
import { ConversationSeat } from '@harness2/ui-shared/renderer/conversation/seat.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import {
  CONVERSATION_OWNER,
  FRAME_SEAT,
  MAIN_CONVERSATION_KEY,
} from '@harness2/ui-shared/renderer/layout/frame-seats.js';
import {
  BackgroundTasksPane,
  SidePaneHost,
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  type SidePaneLauncherItemId,
  type SidePaneTabId,
} from '@harness2/ui-shared/renderer/side-pane/index.js';
import { buildSessionItems, resolveBuildVersion, SidebarRoot } from '@harness2/ui-shared/renderer/sidebar/index.js';
import type { SlotRegistry } from '@harness2/ui-shared/renderer/slots/index.js';
import { useWebShell } from './web-shell-context.js';

/** 渲染进程可读的宿主环境表（web 浏览器无 Node `process` → 空表，版本徐标自然不显示） */
function hostBuildEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/** web 右栏可打开的启动器项白名单（只列 web 真能取数渲染的 tab；未列项 = 无数据通道，不摆假入口） */
const WEB_SIDE_PANE_ITEMS: readonly SidePaneLauncherItemId[] = ['approvals', 'background-tasks'];

/** 侧栏席位内容（ui-sidebar）：SidebarRoot + 会话列表接线（web 无命令面板通道 → 不注入该入口） */
function SidebarSeatContent(): ReactNode {
  const { shell, onNewSession, newSessionEnabled } = useWebShell();
  const state = shell.useAppState();
  const { store, controller } = shell;
  const { geometry, dispatch: frameDispatch } = useFrame();
  const [query, setQuery] = useState('');

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
      // web 无目录选择通道：作用域输入只能是 {}（resolveNewSessionScope 恒落 blank），
      // 真正的 cwd 由 serve 客户端用「最近会话 cwd」兜底（见 main.tsx / serve-client 注释）。
      newSessionScope={{}}
      onNewSession={() => onNewSession?.()}
      newSessionEnabled={newSessionEnabled}
      buildVersion={resolveBuildVersion(hostBuildEnv())}
      // 底部状态角标（与桌面同一 StatusBadge；web 无设置页 → 不摆设置入口）
      renderSettings={() => (
        <div className="flex items-center justify-between gap-2 px-1">
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
        </div>
      )}
    />
  );
}

/** 中栏 conversation 席位内容（ui-conversation）：web 连接/新建阻断提示条 + 共享会话席位 */
function ConversationSeatContent(): ReactNode {
  const { shell, newSessionBlockedReason } = useWebShell();
  const { store, controller } = shell;
  const state = shell.useAppState();
  const frame = useFrame();
  const connected = state.status === 'connected';
  const rightbarOpen = frame.state.rightbarOpen;

  const header = useMemo(
    () =>
      ({ sessionId }: { sessionId: string }): ReactNode => {
        const summary = state.sessions.find((s) => s.id === sessionId);
        return (
          <div className="web-conversation-header">
            <span className="web-conversation-title">
              {store.displayTitleFor(sessionId) ?? summary?.firstUserText ?? '(空会话)'}
            </span>
            {summary?.cwd !== undefined ? <span className="web-conversation-cwd">{summary.cwd}</span> : null}
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
      <ConversationSeat store={store} controller={controller} header={header} />
    </div>
  );
}

/** web 审批 tab（真实数据面）：store.allApprovals + controller.respondApproval，卡片用共享 ApprovalCard */
function WebApprovalsPane(): ReactNode {
  const { shell } = useWebShell();
  const { store, controller } = shell;
  useSyncExternalStore(store.subscribe, store.getState);
  const approvals = store.allApprovals();
  if (approvals.length === 0) {
    return (
      <div className="web-pane-empty" data-testid="web-approvals-empty">
        无待批事项（ask 模式下有写/命令时会在此出现）
      </div>
    );
  }
  return (
    <div className="web-approvals" data-testid="web-approvals-list">
      {approvals.map((a) => (
        <ApprovalCard
          key={a.requestId}
          card={toApprovalCardModel(a)}
          responding={store.isApprovalResponding(a.requestId)}
          onDecision={(decision) => void controller.respondApproval(a.requestId, decision)}
        />
      ))}
    </div>
  );
}

/** 右栏席位内容（ui-workspace）：SidePaneHost + web 真能取数的 tab 内容 */
function RightbarSeatContent(): ReactNode {
  const { shell } = useWebShell();
  const state = shell.useAppState();
  const sessionId = state.selectedId;

  const renderTab = (id: SidePaneTabId): ReactNode => {
    switch (id) {
      case 'approvals':
        return <WebApprovalsPane />;
      case 'background-tasks':
        return (
          <BackgroundTasksPane
            store={shell.store}
            onOpenChildSession={(childSessionId) => void shell.controller.selectSession(childSessionId)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <SidePaneHost
      store={shell.store}
      sessionId={sessionId}
      renderTab={renderTab}
      items={WEB_SIDE_PANE_ITEMS}
      onRefresh={(id) => void shell.controller.refreshExecutionViews(id)}
      onResync={(id) => void shell.controller.resumeSession(id)}
      onOpenChildSession={(childSessionId) => void shell.controller.selectSession(childSessionId)}
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
    // 覆层席位：web 无设置页 / 命令面板数据通道 → 不注入（零覆层，如实空；不摆假入口）。
  ];
  return () => {
    for (const d of disposers) d();
  };
}

/** 启动器全量清单（供测试/诊断核对 web 白名单是它的子集；不用于渲染） */
export const WEB_SIDE_PANE_ALL_ITEMS = SIDE_PANE_LAUNCHER_ITEM_IDS;
