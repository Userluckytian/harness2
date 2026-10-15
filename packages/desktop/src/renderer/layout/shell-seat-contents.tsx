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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CommandPalette } from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { SettingsPage } from '../components/SettingsPage.js';
import { SidePanel } from '../components/SidePanel.js';
import { controller, store, useAppState, newSessionCollapsingRightbar, StatusBadge } from '../app-shared.js';
import {
  SidebarRoot,
  buildSessionItems,
  resolveBuildVersion,
  SettingsIcon,
} from '@harness2/ui-shared/renderer/sidebar/index.js';
import type { ProjectGroupInput } from '@harness2/ui-shared/renderer/sidebar/project-groups.js';
import type { ProjectsDocument } from '@harness2/ui-shared/shared/projects.js';
import type { SlotRegistry } from '@harness2/ui-shared/renderer/slots/index.js';
import {
  CONVERSATION_OWNER,
  FRAME_SEAT,
  MAIN_AUTOMATIONS_KEY,
  MAIN_CONVERSATION_KEY,
  TERMINAL_SEAT,
} from '@harness2/ui-shared/renderer/layout/frame-seats.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { workbenchDrag } from '@harness2/ui-shared/renderer/layout/workbench/drag.js';
import { WorkbenchHost } from '@harness2/ui-shared/renderer/layout/workbench/host.js';
import { workbenchStore } from '@harness2/ui-shared/renderer/layout/workbench/store.js';
import { countPanes, MAX_PANES } from '@harness2/ui-shared/renderer/layout/workbench/model.js';
import { sidePaneStore, trajectoryTabId, type CronJobShape } from '@harness2/ui-shared/renderer/side-pane/index.js';
import { AutomationsMainView, type AutomationTemplate } from '@harness2/ui-shared/renderer/automation/index.js';
import { TerminalPanel } from '@harness2/ui-shared/renderer/terminal/index.js';
import { ConversationSeat, type ConversationSeatProps } from '../conversation/assembly.js';
import { useComposerControls } from '../conversation/composer-controls-bridge.js';
import { useSessionContextChips } from '../conversation/context-chips.js';
import { composerPrefill } from '@harness2/ui-shared/renderer/conversation/composer/prefill.js';
import { desktopTerminalPort } from '../terminal/desktop-port.js';
import { useShellPalette } from './shell-context.js';
import { setOverlay, takeRequestedSettingsSection, useOverlayOpen } from './shell-overlays.js';
import { setShellTheme, useShellTheme } from './shell-theme.js';

/**
 * 渲染进程可读的宿主环境表（D-25 构建徐标数据源）。
 * 打包后的渲染进程没有 Node `process`（渲染进程零 Node）→ 空表，徐标自然不显示；
 * 有值时必须由宿主（vite define / preload）注入 DSH_CLIENT_*，本文件不做任何伪造。
 */
function hostBuildEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/** P0-3b：projects.json 文档 → SessionBrowser 的项目表投影（渲染侧只要 cwd + addedAt） */
function toProjectInputs(doc: ProjectsDocument): ProjectGroupInput[] {
  return doc.projects.map((p) => ({ cwd: p.cwd, addedAt: p.addedAt }));
}

/** 侧栏席位内容（ui-sidebar）：SidebarRoot + 装配层数据接线 */
function SidebarSeatContent(): React.ReactNode {
  const state = useAppState();
  // P0-2：轨迹项要按右栏开合决定是否展开——右栏状态在帧 state（useFrame），非 AppState
  const { geometry, state: frameState, dispatch: frameDispatch } = useFrame();
  const [query, setQuery] = useState('');
  // Z2-06（Z-19）：已在分屏中的会话禁用拖拽（左栏行可拖进主区）
  const workbench = useSyncExternalStore(workbenchStore.subscribe, workbenchStore.getSnapshot);
  const panedSessionIds = useMemo(() => new Set(Object.values(workbench.bindings)), [workbench.bindings]);

  // —— P0-3b 侧栏「项目」实体（桌面独有：~/.harness2/projects.json 经 preload IPC 读写） ——
  // Harness2Api 的 ProjectsApi 面是 Partial（jsdom 夹具 / 旧宿主可能缺通道）→ 逐方法判空，
  // 缺通道时 projects 恒为空表、动作不接线 = 组件渲染 disabled 占位（红线⑩），不摆假功能。
  const [projects, setProjects] = useState<readonly ProjectGroupInput[]>([]);
  // U2 批D（D7）：projects 读写失败不再静默吞（.catch(()=>{}) → 置错误态），
  // 侧栏项目区头下渲染行内轻条 + 重试 + 忽略。失败不清用户数据、不伪造项目（红线如实）。
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const projectsErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const loadProjects = useCallback((): void => {
    const api = window.harness2;
    if (api.projectsList === undefined) return;
    api
      .projectsList()
      .then((doc) => {
        if (mountedRef.current) {
          setProjects(toProjectInputs(doc));
          setProjectsError(null);
        }
      })
      .catch((error: unknown) => {
        // 读失败 = 如实保持空表 + 行内提示（不伪造项目、不清用户数据）
        if (mountedRef.current) setProjectsError(projectsErrorMessage(error));
      });
  }, []);
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);
  /** 添加项目：系统目录选择器 → projects:add → 用写后整表刷新（取消 = null → 不写） */
  const addProject = (): void => {
    const api = window.harness2;
    if (api.projectsPickFolder === undefined || api.projectsAdd === undefined) return;
    void api
      .projectsPickFolder()
      .then((cwd) => {
        if (cwd === null) return;
        return api.projectsAdd?.(cwd).then((doc) => {
          if (mountedRef.current) {
            setProjects(toProjectInputs(doc));
            setProjectsError(null);
          }
        });
      })
      .catch((error: unknown) => {
        // IPC 失败：保持现表（不误清空、不伪造成功）+ 行内提示（D7）
        if (mountedRef.current) setProjectsError(projectsErrorMessage(error));
      });
  };
  /** 移出项目：projects:remove → 写后整表刷新（只删 projects.json 条目；会话与事件日志不动） */
  const removeProject = (cwd: string): void => {
    const api = window.harness2;
    if (api.projectsRemove === undefined) return;
    void api
      .projectsRemove(cwd)
      .then((doc) => {
        if (mountedRef.current) {
          setProjects(toProjectInputs(doc));
          setProjectsError(null);
        }
      })
      .catch((error: unknown) => {
        // 同上：失败保持现表 + 行内提示（D7）
        if (mountedRef.current) setProjectsError(projectsErrorMessage(error));
      });
  };

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

  /** P0：主区可能停在「自动化」主区视图上 —— 选会话/新建会话必须先回对话，否则主区被自动化页占住。
   *  key=null 即回到保留的 conversation key（frame-state 的 main/select-key 语义）。 */
  const backToConversation = (): void => {
    frameDispatch({ type: 'main/select-key', key: null });
  };

  // Z-47（T3 渲染侧接线）：订阅主进程托盘菜单事件（IPC_TRAY_EVENT）。
  // 「新建会话」→ 与侧栏顶部「+」同一路径（backToConversation + 收右栏 + controller.newSession）；
  // 「添加项目」→ 与组头「添加项目」同一真源（本组件 addProject：目录选择器 → projects:add）。
  // 侧栏席位恒在场（Z-06 折叠只隐藏不卸载），故在此订阅覆盖全场景；缺通道（web/旧夹具）跳过。
  useEffect(() => {
    const onTrayEvent = window.harness2.onTrayEvent;
    if (onTrayEvent === undefined) return undefined;
    return onTrayEvent((event) => {
      if (event.type === 'tray:new-session') {
        backToConversation();
        newSessionCollapsingRightbar(frameDispatch);
      } else if (event.type === 'tray:add-project') {
        addProject();
      }
    });
    // backToConversation/addProject 读的都是模块级稳定引用（window.harness2 + setState 函数）；
    // frameDispatch 身份稳定 → 挂载一次订阅即正确，无需随渲染重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameDispatch]);

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
      onOpenSession={(id) => {
        backToConversation();
        void controller.selectSession(id);
      }}
      // Z8-1：Pinned 行的「取消置顶」（置顶动作本体在 Z8-2 右键菜单）——走既有 metadata 通道。
      onTogglePin={(id, pinned) => void controller.pinSession(id, pinned)}
      // P0-2（Z-10）右键菜单：全部动作走已核实通道（controller metadata / workbench drop /
      // trajectory inspect 消费链）。重命名对话框由 SessionBrowser 承载（onSubmitRename 注入）。
      rowMenu={{
        onPin: (id, pinned) => void controller.pinSession(id, pinned),
        onArchive: (id, archived) => void controller.archiveSession(id, archived),
        // 分屏投放：目标=当前焦点格右侧（与 Z2-06 拖拽的半边语义等价的键盘/菜单版）
        onOpenInSplit: (id) => {
          const snap = workbenchStore.getSnapshot();
          workbenchStore.dropSession({ sessionId: id, targetLeafId: snap.focusedId, side: 'right' });
        },
        splitLimitReached: countPanes(workbench.root) >= MAX_PANES,
        // 查看轨迹 = P2-5 inspect 同一通道（无定位参数 = 打开即最新态）+ 右栏收着自动展开
        onInspectTrajectory: (id) => {
          backToConversation();
          void controller.selectSession(id);
          sidePaneStore.open(id, trajectoryTabId(id));
          if (!frameState.rightbarOpen) frameDispatch({ type: 'rightbar/toggle' });
        },
      }}
      onSubmitRename={(id, title) => controller.renameSession(id, title)}
      // —— P0-3b 侧栏「项目」（桌面：projects.json 真通道；组头钮全为真动作） ——
      // projects 恒传（未读到 / 无通道 = 空数组 → 走既有分组，行为不变）
      projects={projects}
      onAddProject={
        window.harness2.projectsAdd !== undefined && window.harness2.projectsPickFolder !== undefined
          ? addProject
          : undefined
      }
      onRemoveProject={window.harness2.projectsRemove !== undefined ? removeProject : undefined}
      // Z-48 #2：项目组头 hover「在此项目新建会话」= 同一新建链路但**带项目 cwd**
      // （controller.newSession(cwd) → api.createSession(cwd)；与顶部「+」的空白新会话区分）。
      // 未连接 / 无创建通道时不接线（钮不渲染，红线⑩）。
      onNewSessionInProject={
        state.status === 'connected' && window.harness2.createSession !== undefined
          ? (cwd: string) => {
              backToConversation();
              newSessionCollapsingRightbar(frameDispatch, cwd);
            }
          : undefined
      }
      // Z-49：删除会话（软删 controller.deleteSession：metadata deleted + 列表移除；
      // 确认对话框在 SessionBrowser 内承载）。controller 内部已按通道能力如实降级
      // （无持久化通道 = 仅从视图移除 + info toast），故此处恒接线，不重复探测。
      onDeleteSession={(id: string) => controller.deleteSession(id)}
      // U1 复审 P2：确认框的 live running 复查判据（controller 未暴露 running 查询，
      // 用本文件已在用的 store.peekStream 直读，不新造 API）。
      isSessionRunning={(id: string) => store.peekStream(id)?.running === true}
      // U2 批D（D7）：项目表读写失败 → 侧栏行内轻条（重试 = 重发 projectsList；忽略 = 清错误态）
      projectsError={projectsError}
      onRetryProjects={loadProjects}
      onDismissProjectsError={() => setProjectsError(null)}
      // 任务区头「新建任务」= 与 SidebarRoot 新会话入口同一真源；未连接时不给动作（占位钮，不可点即坏）
      onNewTask={
        state.status === 'connected'
          ? () => {
              backToConversation();
              newSessionCollapsingRightbar(frameDispatch);
            }
          : undefined
      }
      // D-21 数据缺口（如实登记，不造假输入）：本仓没有 Workspace 概念（最接近的是
      // SessionMeta.cwd），controller.newSession() 也没有作用域入参 → 作用域输入只能是 {}，
      // 于是 resolveNewSessionScope 恒落 { kind: 'blank' }（空白新会话）。
      // 待 P7 引入工作区后，再补齐 explicit / current-session / recent 三档数据源。
      newSessionScope={{}}
      // Z2-04（Z-13）：新建会话强制收起右栏（动作层收口，见 app-shared.newSessionCollapsingRightbar）
      onNewSession={() => {
        backToConversation();
        newSessionCollapsingRightbar(frameDispatch);
      }}
      newSessionEnabled={state.status === 'connected'}
      // Z-07 #1：New Task 的 Ctrl+N 快捷键（App.tsx 已真绑定 Ctrl/Cmd+N，见那里的注释）。
      newSessionShortcut="Ctrl+N"
      // Z2-02（Z-07 分区 2）：左栏命令中心入口 → 复用既有覆层链路打开命令面板
      // （与 Ctrl+K 的 toggleOverlay('palette') 同一真源，不新开一套面板）。
      onOpenCommandPalette={() => setOverlay('palette', true)}
      // P0（ZCode 实测对齐）：「自动化」入口 → 打开**主区视图**（子 tab 自动化|工作流 + 模板卡），
      // 与 ZCode 侧栏「自动化」进主区一致（不再定向右栏 pane；右栏 automations pane 保留为旁路）。
      onOpenAutomations={() => frameDispatch({ type: 'main/select-key', key: MAIN_AUTOMATIONS_KEY })}
      // P0-3a 诚实占位（用户拍板）：插件市场/账号区只占位不开发（disabled+说明）。
      placeholders
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
      // 2026-10-13 校正：连接状态角标从设置区**移入账号块**（用户名下方，SidebarRoot 的
      // renderAccountStatus 席位）——账号/状态同处常驻 Footer，设置区只留齿轮。
      renderAccountStatus={() => <StatusBadge status={state.status} error={state.statusDetail?.error} />}
      renderSettings={() => (
        <div className="flex items-center justify-end gap-2 px-1">
          {/* U2 批D（D8 / Z-11、Z-74）：⚙ 文本字形 → lucide SettingsIcon size-4 图标钮（28×28 命中区）。 */}
          <button
            type="button"
            className="hover:bg-surface-hover text-foreground-subtle hover:text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent"
            data-testid="sidebar-settings"
            aria-label="设置"
            title="设置 (Ctrl+,)"
            onClick={() => setOverlay('settings', true)}
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    />
  );
}

/** 中栏 conversation key 的内容（ui-conversation）：分屏工作台宿主（Z2-06 / Z-19）。
 *  未分屏（单格）时与旧结构等价（一格会话界面）；多格时在 conversation 面板内二叉分割。
 *  Z2-03 的内层 conversation | terminal 分栏在 MainSeatView 层，分屏发生在本内容内部。
 *  Z3-04：composer 左右簇控件（模型选择/模式切换）由壳在此装配一次，经工作台宿主下发到每格。
 *  Z10-1：空态建议 chip 的点击经 `onPickSuggestion` 注入（见 DesktopConversationSeat）。
 *  Z10-2：composer 上方「项目」「Git 分支」chip —— 数据取自**本格会话 cwd**（分屏每格各自正确）；
 *        两者本仓均无切换通道 → 只读（见 `conversation/context-chips.ts`）。
 */
function DesktopConversationSeat(props: ConversationSeatProps): React.ReactNode {
  // WorkbenchHost 下发的 sessionId = 本格绑定的会话（分屏各格各自正确）。
  const sessionId = props.sessionId;
  // Z10-2：项目名（cwd 末段）+ git 分支（gitBranch(cwd)）—— 无 cwd/无分支即整项不渲染。
  const contextChips = useSessionContextChips(store, sessionId);
  return (
    <ConversationSeat
      {...props}
      {...(contextChips !== undefined ? { contextChips } : {})}
      // Z10-1：建议 chip 点击 → 经 composerPrefill 通道把文案**预填**进本格会话的 composer
      // 活草稿（与划词「询问」/ 文件评论同一 insert 原语；非直接发送，用户可改后发）。
      onPickSuggestion={(text) => {
        if (sessionId === undefined || sessionId === null) return;
        composerPrefill.request({ sessionId, quote: text, focus: true });
      }}
    />
  );
}

function ConversationSeatContent(): React.ReactNode {
  // Z10-2b：在会话席位处装配 composer 左右簇控件数据面（config 经 settings:getConfig 读、
  // 切换经 settings:updateConfig 写；模块级缓存多席位共享一次 IPC）→ 经工作台宿主下发到每格。
  const composerControls = useComposerControls();
  return (
    <WorkbenchHost
      store={store}
      controller={controller}
      seat={DesktopConversationSeat}
      composerControls={composerControls}
    />
  );
}

/**
 * P0「自动化」主区视图内容（ui-automation；ZCode 实测面复刻）。
 * 数据面 = 桌面主进程 fs 只读 jobs.json（cron:list）+ 写通道（cron:add）；两者都缺（理论不发生，
 * preload 生产必给）→ 传 undefined 回调，视图落「无通道」降级（模板卡/创建钮 disabled，红线⑩）。
 * 创建成功后重读一次列表刷新（不轮询、不假装实时）；失败保持现表（不误清空、不伪造成功）。
 */
function AutomationSeatContent(): React.ReactNode {
  const [jobs, setJobs] = useState<readonly CronJobShape[]>([]);
  const nowMs = useMemo(() => Date.now(), []);
  const refresh = useCallback(() => {
    const read = window.harness2.cronList;
    if (read === undefined) return;
    void read
      .call(window.harness2)
      .then((next) => setJobs(next))
      .catch(() => {
        // 读失败：保持现表（不误清空、不伪造任务）
      });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const cronAdd = window.harness2.cronAdd;
  const onCreateFromTemplate =
    cronAdd === undefined
      ? undefined
      : (template: AutomationTemplate): void => {
          void cronAdd
            .call(window.harness2, template.instruction, template.schedule)
            .then(() => refresh())
            .catch(() => {
              // 创建失败（调度非法/超上限）：不刷新、不伪造成功
            });
        };
  const onCreate =
    cronAdd === undefined
      ? undefined
      : (instruction: string, schedule: string): void => {
          void cronAdd
            .call(window.harness2, instruction, schedule)
            .then(() => refresh())
            .catch(() => {
              // 同上：失败保持现表
            });
        };
  return (
    <AutomationsMainView
      jobs={jobs}
      nowMs={nowMs}
      {...(onCreateFromTemplate !== undefined ? { onCreateFromTemplate } : {})}
      {...(onCreate !== undefined ? { onCreate } : {})}
    />
  );
}

/**
 * 中栏终端席位内容（ui-terminal；Z9-5）：已就绪的共享 `TerminalPanel` + 桌面传输单例。
 *
 * - 端口用**模块级稳定单例** `desktopTerminalPort`（TerminalPanel 的 effect 依赖 port 身份，
 *   每次渲染新建会触发终端重建）；`available` 在桌面宿主恒为 true，夹具缺 IPC 时为 false
 *   （面板如实显示「终端不可用」，红线⑩）。
 * - `theme` 传壳主题（仅作重新取色的失效信号；实际色值由 TerminalPanel 读 CSS 语义 token）。
 */
function TerminalSeatContent(): React.ReactNode {
  const theme = useShellTheme();
  return <TerminalPanel port={desktopTerminalPort} theme={theme === 'zai-light' ? 'light' : 'dark'} />;
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
      layout="tabbed"
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
    // P0：「自动化」主区视图（ui-automation；非保留 key，与 conversation 并存，按 mainKey 切换）。
    registry.inject({
      seat: FRAME_SEAT.main,
      key: MAIN_AUTOMATIONS_KEY,
      owner: 'ui-automation',
      component: AutomationSeatContent,
    }),
    // Z9-5：中栏终端席位（注册缝；注入后 MainSeatView 才出现终端面板与其开关）。
    registry.inject({ seat: TERMINAL_SEAT, owner: 'ui-terminal', component: TerminalSeatContent }),
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
