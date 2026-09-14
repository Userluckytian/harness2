// 帧席位内容的装配（D-02：每个 UI 能力一个包，经 inject 填席）。
// 注入的 owner 用能力包名（ui-sidebar / ui-conversation / ui-workspace / ui-settings / ui-commands），
// 便于审查「哪一份内容属于哪个能力」；内容组件本身是既有组件，替换时只换这里。
//
// P4-C 装配：侧栏席位内容 = renderer/sidebar 的 SidebarRoot（D-20～D-25），
// 装配点只此一处（App/frame 不用动）；旧的 components/SessionList.tsx 已删除，不留第二套侧栏。
// 轨道归属（P4-C 裁决）：帧容器（frame-seat-views.tsx）只提供轨道容器宽度（收起 56px），
// 轨道内容（品牌标记/展开按钮/区域图标）由 SidebarRoot 在 rail 态渲染 —— 两边各司其职，不重复画。
//
// P5-C 装配：会话席位内容 = renderer/conversation/assembly.tsx 的 ConversationSeat
// （会话头 + ConversationViewRing + 常驻 Composer）。本文件只递 store/controller，
// 不在这里写对话语义（视图环与 composer 的接线全在 assembly.tsx）。
import { useEffect, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette.js';
import { SettingsDialog } from '../components/SettingsDialog.js';
import { SidePanel } from '../components/SidePanel.js';
import { ConversationSeat } from '../conversation/assembly.js';
import { controller, store, useAppState } from '../app-shared.js';
import { SidebarRoot, buildSessionItems, resolveBuildVersion } from '../sidebar/index.js';
import type { SlotRegistry } from '../slots/index.js';
import { CONVERSATION_OWNER, FRAME_SEAT, MAIN_CONVERSATION_KEY } from './frame-seats.js';
import { useFrame } from './frame-context.js';
import { useShellPalette } from './shell-context.js';
import { useOverlayOpen, setOverlay } from './shell-overlays.js';
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
  const { state: frameState, geometry, dispatch: frameDispatch } = useFrame();
  const [query, setQuery] = useState('');

  // 行数据：store 摘要 + 展示态覆层（search/归档分区复用 shared/metadata，不复制过滤规则）
  const { active, archived } = buildSessionItems({
    sessions: state.sessions,
    metadata: state.metadata,
    query,
    flagsOf: (id) => {
      const stream = store.peekStream(id);
      return stream === undefined ? undefined : { running: stream.running, unread: stream.unread };
    },
  });

  return (
    <SidebarRoot
      // 开合事实取几何口径（窄屏看 override、宽屏看偏好，见 frame-state.isSidebarCollapsed）
      collapsed={geometry.sidebarRail}
      width={frameState.sidebarWidth}
      onToggleCollapse={() => frameDispatch({ type: 'sidebar/toggle' })}
      sessions={active}
      archivedSessions={archived}
      selectedId={state.selectedId}
      query={query}
      onQueryChange={setQuery}
      onOpenSession={(id) => void controller.selectSession(id)}
      // D-21 数据缺口（如实登记，不造假输入）：本仓没有 Workspace 概念（最接近的是
      // SessionMeta.cwd），controller.newSession() 也没有作用域入参 → 作用域输入只能是 {}，
      // 于是 resolveNewSessionScope 恒落 { kind: 'blank' }（空白新会话）。
      // 待 P7 引入工作区后，再补齐 explicit / current-session / recent 三档数据源。
      newSessionScope={{}}
      onNewSession={() => void controller.newSession()}
      newSessionEnabled={state.status === 'connected'}
      buildVersion={resolveBuildVersion(hostBuildEnv())}
    />
  );
}

/** 中栏 conversation key 的内容（ui-conversation）：会话头 + 视图环 + 常驻 composer（见 conversation/assembly） */
function ConversationSeatContent(): React.ReactNode {
  return <ConversationSeat store={store} controller={controller} />;
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

/** 覆层席位内容（ui-settings）：设置弹窗（主题变化即立即呈现，D-15） */
function SettingsOverlayContent(): React.ReactNode {
  const open = useOverlayOpen('settings');
  return (
    <SettingsDialog open={open} onClose={() => setOverlay('settings', false)} onThemeChange={(t) => setShellTheme(t)} />
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
