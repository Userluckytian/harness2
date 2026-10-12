// 帧席位内容的装配（D-02：每个 UI 能力一个包，经 inject 填席）。
// 注入的 owner 用能力包名（ui-sidebar / ui-conversation / ui-workspace / ui-settings / ui-commands），
// 便于审查「哪一份内容属于哪个能力」；内容组件本身是既有组件，替换时只换这里。
//
// P4-C 装配：侧栏席位内容 = renderer/sidebar 的 SidebarRoot（D-20～D-25），
// 装配点只此一处（App/frame 不用动）；旧的 components/SessionList.tsx 已删除，不留第二套侧栏。
// Z-06 折叠归属：帧容器（frame-seat-views.tsx）只提供容器宽度（折叠 4px、无图标轨道），
// 折叠可见性由 SidebarRoot 用 opacity-0 + pointer-events-none 承担（只隐藏不卸载）。
//
// P5-C 装配：会话席位内容 = renderer/conversation/assembly.tsx 的 ConversationSeat
// （会话头 + 转录 + 常驻 Composer；Z2-05 起主区事实单一 chat，无视图环）。本文件只递
// store/controller，不在这里写对话语义（composer 的接线全在 assembly.tsx）。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CommandPalette } from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { SettingsPage } from '../components/SettingsPage.js';
import { SidePanel } from '../components/SidePanel.js';
import { controller, store, useAppState, newSessionCollapsingRightbar, StatusBadge } from '../app-shared.js';
import { SidebarRoot, buildSessionItems, resolveBuildVersion } from '@harness2/ui-shared/renderer/sidebar/index.js';
import type { SlotRegistry } from '@harness2/ui-shared/renderer/slots/index.js';
import {
  CONVERSATION_OWNER,
  FRAME_SEAT,
  MAIN_CONVERSATION_KEY,
} from '@harness2/ui-shared/renderer/layout/frame-seats.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { WorkbenchHost } from '@harness2/ui-shared/renderer/layout/workbench/host.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import { ConversationSeat } from '../conversation/assembly.js';
import { useShellPalette } from './shell-context.js';
import { setOverlay, takeRequestedSettingsSection, useOverlayOpen } from './shell-overlays.js';
import { setShellTheme } from './shell-theme.js';

/**
 * 渲染进程可读的宿主环境表（D-25 构建徐标数据源）。
 * 打包后的渲染进程没有 Node `process`（渲染进程零 Node）→ 空表，徐标自然不显示；
 * 有值时必须由宿主（vite define / preload）注入 DSH_CLIENT_*，本文件不做任何伪造。
 */
function hostBuildEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/** 侧栏席位内容（ui-sidebar）：SidebarRoot + 装配层数据接线 */
function SidebarSeatContent(): React.ReactNode {
  const state = useAppState();
  const { geometry, dispatch: frameDispatch } = useFrame();
  const [query, setQuery] = useState('');
  // Z2-06（Z-19）：已在分屏中的会话禁用拖拽（左栏行可拖进主区）
  const workbench = useSyncExternalStore(workbenchStore.subscribe, workbenchStore.getSnapshot);
  const panedSessionIds = useMemo(() => new Set(Object.values(workbench.bindings)), [workbench.bindings]);

  // 行数据：store 摘要 + 展示态覆层（search/归档分区复用 shared/metadata，不复制过滤规则）
  const { active, archived } = buildSessionItems({
    sessions: state.sessions,
    metadata: state.metadata,
    query,
    flagsOf: (id) => {
      const stream = store.peekStream(id);
      // Z2-09b（场景④）：待审批数上左栏行（attention 徽标数据源；无流 = 0，不渲染徽标）
      return stream === undefined
        ? undefined
        : { running: stream.running, unread: stream.unread, pendingApprovals: stream.approvals.length };
    },
  });

  return (
    <SidebarRoot
      // 折叠事实取几何口径（Z-06：折叠后容器 4px、内容只隐藏不卸载）
      collapsed={geometry.sidebarCollapsed}
      // 内容始终按展开宽度排版（折叠时被 4px 容器裁切 + opacity-0，避免收起途中重排）
      width={geometry.sidebarExpandedWidth}
      onToggleCollapse={() => frameDispatch({ type: 'sidebar/toggle' })}
      sessions={active}
      archivedSessions={archived}
      selectedId={state.selectedId}
      query={query}
      onQueryChange={setQuery}
      onOpenSession={(id) => void controller.selectSession(id)}
      // Z8-1：Pinned 行的「取消置顶」（置顶动作本体在 Z8-2 右键菜单）——走既有 metadata 通道。
      onTogglePin={(id, pinned) => void controller.pinSession(id, pinned)}
      // D-21 数据缺口（如实登记，不造假输入）：本仓没有 Workspace 概念（最接近的是
      // SessionMeta.cwd），controller.newSession() 也没有作用域入参 → 作用域输入只能是 {}，
      // 于是 resolveNewSessionScope 恒落 { kind: 'blank' }（空白新会话）。
      // 待 P7 引入工作区后，再补齐 explicit / current-session / recent 三档数据源。
      newSessionScope={{}}
      // Z2-04（Z-13）：新建会话强制收起右栏（动作层收口，见 app-shared.newSessionCollapsingRightbar）
      onNewSession={() => newSessionCollapsingRightbar(frameDispatch)}
      newSessionEnabled={state.status === 'connected'}
      // Z-07 #1：New Task 的 Ctrl+N 快捷键（App.tsx 已真绑定 Ctrl/Cmd+N，见那里的注释）。
      newSessionShortcut="Ctrl+N"
      // Z2-02（Z-07 分区 2）：左栏命令中心入口 → 复用既有覆层链路打开命令面板
      // （与 Ctrl+K 的 toggleOverlay('palette') 同一真源，不新开一套面板）。
      onOpenCommandPalette={() => setOverlay('palette', true)}
      buildVersion={resolveBuildVersion(hostBuildEnv())}
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
      // Z2-01b（Z-07 §9 / Z-11）：设置入口迁到左栏 Footer（原顶栏设置按钮拆除）。
      // StatusBadge 也放这里（二选一取 Footer）——理由：Footer 是常驻的账号/设置区，
      // 浮层条是窄拖拽条（mac 左 96px 留给红绿灯、右侧要避让窗口控件），不适合塞状态角标。
      renderSettings={() => (
        <div className="flex items-center justify-between gap-2 px-1">
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
          <button
            type="button"
            className="text-ui-base text-foreground-subtle hover:text-foreground cursor-pointer"
            data-testid="sidebar-settings"
            aria-label="设置"
            title="设置 (Ctrl+,)"
            onClick={() => setOverlay('settings', true)}
          >
            ⚙
          </button>
        </div>
      )}
    />
  );
}

/** 中栏 conversation key 的内容（ui-conversation）：分屏工作台宿主（Z2-06 / Z-19）。
 *  未分屏（单格）时与旧结构等价（一格会话界面）；多格时在 conversation 面板内二叉分割。
 *  Z2-03 的内层 conversation | terminal 分栏在 MainSeatView 层，分屏发生在本内容内部。
 *  Z3-04：composer 左右簇控件（模型选择/模式切换）由壳在此装配一次，经工作台宿主下发到每格。 */
function ConversationSeatContent(): React.ReactNode {
  return <WorkbenchHost store={store} controller={controller} seat={ConversationSeat} />;
}

/**
 * 右栏席位属主 props（上游 ui-layout RightbarOwnerProps / AppFrame.tsx:227）：
 * 渲染宽度（不是偏好）、当帧视口宽、以及能否以普通形态在场。
 */
export interface RightbarOwnerProps {
  /** 渲染宽度（让步链钳制后；0 = 无轨道） */
  readonly width: number;
  /** 当帧视口宽 */
  readonly viewportWidth: number;
  /** 能否在保住中栏 400px 的前提下占用 300px；false 时占用方需自行关闭 */
  readonly canShow: boolean;
}

/**
 * 右栏席位内容（ui-workspace）：每会话只读停靠面（计划/任务/审批/变更/工作区/配置）。
 * D-12：空间不足（canShow=false）时**占用方自行关闭**（上游 SidebarRight.tsx:377-379 的
 * `if (shown && !fullscreen && !canShow) setExpanded(false)`）—— 壳不代关、也不在中栏摆提示条。
 * 只有帧说「已展开」时才关（否则关→canShow 仍 false→再关会自激）。
 */
function RightbarSeatContent({ canShow }: RightbarOwnerProps): React.ReactNode {
  const { state, dispatch } = useFrame();
  const shown = state.rightbarOpen;
  const fullscreen = state.rightbarFullscreen;
  useEffect(() => {
    if (shown && !fullscreen && !canShow) dispatch({ type: 'rightbar/toggle' });
  }, [shown, fullscreen, canShow, dispatch]);
  return <SidePanel />;
}

/** 覆层席位内容（ui-settings）：全屏设置页（Z-88；主题变化即立即呈现，D-15）。
 *  Z3-04：composer「管理模型」经 openSettingsAtSection 请求直达分区 —— 打开时取走请求，
 *  以 key 重挂载让 SettingsShell 采纳 defaultSectionId（壳的激活分区只内存，重挂载即回落）。 */
function SettingsOverlayContent(): React.ReactNode {
  const open = useOverlayOpen('settings');
  const [defaultSection, setDefaultSection] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      setDefaultSection(undefined);
      return;
    }
    const requested = takeRequestedSettingsSection();
    if (requested !== undefined) setDefaultSection(requested);
  }, [open]);
  return (
    <SettingsPage
      key={defaultSection ?? 'auto'}
      open={open}
      {...(defaultSection !== undefined ? { defaultSectionId: defaultSection } : {})}
      onClose={() => setOverlay('settings', false)}
      onThemeChange={(t) => setShellTheme(t)}
    />
  );
}

/** 覆层席位内容（ui-commands）：命令面板 */
function PaletteOverlayContent(): React.ReactNode {
  const open = useOverlayOpen('palette');
  const { commands, sessions, onSelectSession } = useShellPalette();
  return (
    <CommandPalette
      open={open}
      onClose={() => setOverlay('palette', false)}
      commands={commands}
      sessions={sessions}
      onSelectSession={onSelectSession}
    />
  );
}

/** 覆层顺序（list 席位：设置在下，命令面板在上） */
export const SHELL_SEAT_CONTENTS = {
  sidebar: { owner: 'ui-sidebar', component: SidebarSeatContent },
  conversation: { owner: CONVERSATION_OWNER, component: ConversationSeatContent },
  rightbar: { owner: 'ui-workspace', component: RightbarSeatContent },
  overlays: [
    { owner: 'ui-settings', order: 0, component: SettingsOverlayContent },
    { owner: 'ui-commands', order: 1, component: PaletteOverlayContent },
  ],
} as const;

/**
 * 把四个席位的内容注入注册表；返回 disposer（逐个卸载）。
 * 注意：注册表对同一 keyed key 会拒绝重复注入、对 list 席位会追加 ——
 * 应用启动只调用一次（唯一调用点：shell-registry.ts 的模块级装配）。
 */
export function injectShellSeatContents(registry: SlotRegistry): () => void {
  const disposers = [
    registry.inject({
      seat: FRAME_SEAT.sidebar,
      owner: SHELL_SEAT_CONTENTS.sidebar.owner,
      component: SHELL_SEAT_CONTENTS.sidebar.component,
    }),
    registry.inject({
      seat: FRAME_SEAT.main,
      key: MAIN_CONVERSATION_KEY,
      owner: SHELL_SEAT_CONTENTS.conversation.owner,
      component: SHELL_SEAT_CONTENTS.conversation.component,
    }),
    registry.inject({
      seat: FRAME_SEAT.rightbar,
      owner: SHELL_SEAT_CONTENTS.rightbar.owner,
      component: SHELL_SEAT_CONTENTS.rightbar.component,
    }),
    ...SHELL_SEAT_CONTENTS.overlays.map((o) =>
      registry.inject({ seat: FRAME_SEAT.overlay, owner: o.owner, order: o.order, component: o.component }),
    ),
  ];
  return () => {
    for (const d of disposers) d();
  };
}
