// 渲染端根组件（P4-A 骨架）：AppFrame 四席位（sidebar / main / rightbar / shell.overlay）。
// Z7：三栅几何、让步链、面板即时状态、帧容器与席位注册表已下沉 ui-shared（renderer/layout/** 与
// renderer/slots/**）；本目录 renderer/layout/** 只留桌面专属（浮层包装 / 覆层开关 / 壳主题 / D-15 主题呈现 / 装配）。
// 旧的自制分屏（components/PaneArea.tsx + 分栏命令）已随三栅落地拆除（D-10：会话页占 main 的 conversation key）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsNotifyDetails, SettingsPreferencesShape, SettingsTheme } from '../shared/protocol.js';
import { composeNotifyContent, shouldNotifyOnTurnEnd } from '../shared/notify.js';
import {
  AppFrame,
  DesktopTopOverlay,
  ShellPaletteProvider,
  openSettingsAtSection,
  setOverlay,
  setShellTheme,
  toggleOverlay,
  useFrameState,
  useShellTheme,
  type ShellPaletteValue,
} from './layout/index.js';
import { shellSlots } from './layout/shell-registry.js';
import { desktopPlatform, windowFrameClass } from './platform.js';
import { useWindowMaximized } from './window-state.js';
import { type PaletteCommand, type PaletteSession } from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { controller, store, useAppState, newSessionCollapsingRightbar, THEME_CYCLE } from './app-shared.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import { filterSessionList } from '@harness2/ui-shared/shared/metadata.js';
import { SIDE_PANE_NO_SESSION_KEY, sidePaneStore } from '@harness2/ui-shared/renderer/side-pane/index.js';

// 对外再导出（拆分前 App.tsx 的全部导出面；main.tsx / 测试仍从 './App.js' 引）
export { controller, dragState, store, useAppState, StatusBadge } from './app-shared.js';
export { ChatItemView, ChatTranscript } from '@harness2/ui-shared/renderer/components/ChatView.js';

export function cycleTheme(current: SettingsTheme): SettingsTheme {
  const i = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] ?? 'system';
}

/** 有序「可跳转」会话（未归档且未删除；按 mtime 降序）的 id 列表 */
function selectableSessionIds(state: AppState): string[] {
  const { active } = filterSessionList(state.sessions, state.metadata, '');
  return active.map((s) => s.id);
}

/** 在会话列表中相对当前选中移动 ±1（回绕）；返回新 id 或 null（无会话） */
export function moveSession(state: AppState, delta: -1 | 1): string | null {
  const ids = selectableSessionIds(state);
  if (ids.length === 0) return null;
  const cur = state.selectedId;
  const curIdx = cur !== null ? ids.indexOf(cur) : -1;
  const next = curIdx >= 0 ? (curIdx + delta + ids.length) % ids.length : 0;
  return ids[next] ?? null;
}

export function App(): React.ReactNode {
  const state = useAppState();
  const frame = useFrameState({ registry: shellSlots });
  const { dispatch: frameDispatch } = frame;
  // 侧栏折叠取几何口径（Z-06：折叠后 4px、内容只隐藏不卸载；状态不持久化）
  const sidebarCollapsed = frame.geometry.sidebarCollapsed;
  const theme = useShellTheme();
  const [notifyDetails, setNotifyDetails] = useState<SettingsNotifyDetails>('minimal');
  // controller 生命周期挂组件：启动事件订阅 + 布局/覆层/草稿加载（卸载时退订）
  useEffect(() => {
    void controller.initLayout();
    void controller.initMetadata();
    void controller.initDrafts();
    // D4：关窗口「请求停止并退出」→ 主进程要求取消全部运行中工作
    const stopAllUnsub = window.harness2.onStopAll(() => {
      void controller.stopAll();
    });
    const started = controller.start();
    return () => {
      stopAllUnsub();
      started();
    };
  }, []);
  // 主题/通知偏好：启动时读取并应用（主题呈现由 setShellTheme 立即写入，D-15 四要素随之落地）
  useEffect(() => {
    void window.harness2
      .settingsGetPreferences()
      .then((p: SettingsPreferencesShape) => {
        setNotifyDetails(p.notifyDetails);
        setShellTheme(p.theme);
      })
      .catch(() => {});
  }, []);
  // B7 任务完成系统通知：turn-end 且「窗口非聚焦 + 该会话不可见」→ 弹系统通知。
  // 判定必须发生在这两者同时成立时（聚焦抖动/窗口失焦瞬间到位），因此逐帧结算；
  // document.hasFocus() 为浏览器 API（渲染进程零 Node），助手完成后窗口不聚焦即触发。
  // 未读徽标由 store 独立处理（不重复）；点击通知则主进程聚焦 + notify/click 帧 → selectSession。
  // listener 只挂载一次（避免随 sessions/metadata 更新重建导致帧丢失竞态）；内部经
  // store.getState() 读最新会话/覆层数据，notifyDetails 用 ref 取当前偏好。
  const notifyDetailsRef = useRef(notifyDetails);
  notifyDetailsRef.current = notifyDetails;
  useEffect(() => {
    return controller.startObservingFrames((frameMsg) => {
      queueMicrotask(() => {
        if (frameMsg.type !== 'turn-end' || frameMsg.sessionId.length === 0) return;
        const st = store.getState();
        const summary = st.sessions.find((s) => s.id === frameMsg.sessionId);
        if (summary === undefined || store.peekStream(frameMsg.sessionId) === undefined) return; // 会话未知/尚未缓冲：不弹
        const windowFocused = document.hasFocus();
        const sessionVisible = !store.isBackground(frameMsg.sessionId);
        if (!shouldNotifyOnTurnEnd({ windowFocused, visible: sessionVisible })) return; // 前台/该会话可见时不弹
        // 完整级别带回复摘要（前 80 字），精简级别只标题（尊重设置弹窗的 notifyDetails 偏好）
        const body = notifyDetailsRef.current === 'full' ? store.assistantText(frameMsg.sessionId) : '';
        const { title, body: composedBody } = composeNotifyContent({
          title: store.displayTitleFor(frameMsg.sessionId),
          firstUserText: summary.firstUserText,
          replyText: body,
        });
        void window.harness2.notify(title, composedBody, frameMsg.sessionId).catch(() => {});
      });
    });
  }, [controller]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        toggleOverlay('settings');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // Ctrl+K / Cmd+K 命令面板 + Ctrl+N / Cmd+N 新建会话（Z-07 #1：New Task 的 Ctrl+N 快捷键；
  // 命令面板此前已标注该 hint 但未绑定，这里补上真绑定，避免「显示了却不生效」的假入口）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        toggleOverlay('palette');
      } else if (key === 'n') {
        // 屏蔽浏览器「新开窗口」默认行为；新建会话同时按 Z2-04 收起右栏。
        e.preventDefault();
        newSessionCollapsingRightbar(frameDispatch);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frameDispatch]);

  // 命令面板的「跳转会话」候选（展示标题优先，占位空会话）
  const activeSessions = selectableSessionIds(state);
  const paletteSessions: PaletteSession[] = useMemo(
    () =>
      activeSessions.map((id) => {
        const s = state.sessions.find((it) => it.id === id);
        const label = store.displayTitleFor(id) ?? s?.firstUserText ?? '';
        return { id, label: label.length > 0 ? label : '(空会话)' };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.sessions, state.metadata, activeSessions.join('|')],
  );

  // 命令表（纯数据；副作用全在 run 回调里，经 controller/state 注入）。
  // Z-17/Z-20：六组统一口径（建议/会话/面板/视图/配置/应用），两壳逐字一致；有真实通道面的项
  // 接真动作，无通道面的项如实 disabled + disabledHint（红线⑩，零假 URL/零假数据）。
  const commands: PaletteCommand[] = useMemo(() => {
    const cycleThemeAction = (): void => {
      const next = cycleTheme(theme);
      setShellTheme(next);
      void window.harness2.settingsSetPreferences({ theme: next });
    };
    // Z-17「打开工作区」：桌面真——Electron 目录选择 → 以所选目录 cwd 建会话（createSession 支持 cwd）。
    // 取消选择（null）即无操作。
    const openWorkspace = (): void => {
      void (async () => {
        try {
          const dir = await window.harness2.projectsPickFolder?.();
          if (dir === null || dir === undefined) return;
          const created = await window.harness2.createSession(dir);
          await controller.refreshSessions();
          await controller.selectSession(created.id);
        } catch {
          /* 通道失败：静默（无假反馈） */
        }
      })();
    };
    // 「添加审查标签」真动作：打开右栏 changes pane（我们壳里「审查/变更」的对应物）。
    // 桶与 SidePaneHost / automations 同源：未选会话落无会话桶（先例见 shell-seat-contents.tsx）。
    const openReview = (): void => {
      const bucket = state.selectedId ?? SIDE_PANE_NO_SESSION_KEY;
      sidePaneStore.open(bucket, 'changes');
      frameDispatch({ type: 'rightbar/open' });
    };
    const rightbarOpen = frame.state.rightbarOpen;
    const nextId = moveSession(state, 1);
    const prevId = moveSession(state, -1);
    const archiveId = state.selectedId;
    return [
      // —— 建议 ——
      {
        id: 'newSession',
        label: '新任务',
        hint: 'Ctrl+N',
        group: '建议',
        run: () => newSessionCollapsingRightbar(frameDispatch),
      },
      { id: 'openWorkspace', label: '打开工作区', hint: 'Ctrl+O', group: '建议', run: openWorkspace },
      { id: 'openSettings', label: '设置', group: '建议', run: () => setOverlay('settings', true) },
      // —— 会话（保留的原有真命令）——
      {
        id: 'nextSession',
        label: '切到下一个会话',
        group: '会话',
        run: () => {
          if (nextId !== null) void controller.selectSession(nextId);
        },
      },
      {
        id: 'prevSession',
        label: '上一个会话',
        group: '会话',
        run: () => {
          if (prevId !== null) void controller.selectSession(prevId);
        },
      },
      {
        id: 'archiveCurrent',
        label: '归档当前会话',
        group: '会话',
        run: () => {
          if (archiveId !== null) void controller.archiveSession(archiveId, true);
        },
      },
      // —— 面板 ——
      {
        id: 'toggleSidebar',
        label: '切换侧边栏',
        hint: 'Ctrl+B',
        group: '面板',
        run: () => frameDispatch({ type: 'sidebar/toggle' }),
      },
      // 终端 dock 未引入：如实占位（红线⑩）
      {
        id: 'toggleTerminal',
        label: '切换终端',
        hint: 'Ctrl+J',
        group: '面板',
        disabled: true,
        disabledHint: '终端功能未引入',
        run: () => {},
      },
      {
        id: 'addTerminalTab',
        label: '添加终端标签',
        group: '面板',
        disabled: true,
        disabledHint: '终端功能未引入',
        run: () => {},
      },
      { id: 'addReviewTab', label: '添加审查标签', group: '面板', run: openReview },
      // —— 视图 ——
      {
        id: 'toggleRightbar',
        label: rightbarOpen ? '收起右栏' : '打开右栏',
        group: '视图',
        run: () => frameDispatch({ type: 'rightbar/toggle' }),
      },
      {
        id: 'resetFrame',
        label: '复位面板宽度与开合',
        group: '视图',
        run: () => frameDispatch({ type: 'reset' }),
      },
      // —— 配置 ——
      {
        id: 'openSettingsConfig',
        label: '设置',
        group: '配置',
        run: () => setOverlay('settings', true),
      },
      {
        id: 'cycleTheme',
        label: theme === 'zai-dark' ? '切换主题到浅色' : '切换主题到深色',
        group: '配置',
        run: cycleThemeAction,
      },
      // 桌面设置支持直达分区（openSettingsAtSection）：真打开设置并落到对应分区
      {
        id: 'skills',
        label: '技能',
        group: '配置',
        run: () => openSettingsAtSection('skill'),
      },
      {
        id: 'mcpServers',
        label: 'MCP 服务器',
        group: '配置',
        run: () => openSettingsAtSection('mcp'),
      },
      // —— 应用 ——
      // 仓库无既有外链常量/通道 → 如实占位，不编造 URL（红线⑩）
      {
        id: 'reportIssue',
        label: '问题上报',
        group: '应用',
        disabled: true,
        disabledHint: '外链未配置',
        run: () => {},
      },
      {
        id: 'userCommunity',
        label: '用户社群',
        group: '应用',
        disabled: true,
        disabledHint: '外链未配置',
        run: () => {},
      },
      {
        id: 'productDocs',
        label: '产品文档',
        group: '应用',
        disabled: true,
        disabledHint: '外链未配置',
        run: () => {},
      },
      // 无现成断开/重连渲染端通道 → 如实占位
      { id: 'disconnect', label: '断开连接', group: '应用', disabled: true, disabledHint: '无断开通道', run: () => {} },
      {
        id: 'helpShortcuts',
        label: '帮助 / 快捷键说明',
        group: '应用',
        run: () => setOverlay('settings', true),
      },
    ];
  }, [state, theme, frameDispatch, frame.state.rightbarOpen]);

  // 覆层席位的命令面板数据（context 传：组件身份稳定，命令表刷新不会把面板重挂载）
  const paletteValue: ShellPaletteValue = useMemo(
    () => ({
      commands,
      sessions: paletteSessions,
      onSelectSession: (id: string) => void controller.selectSession(id),
    }),
    [commands, paletteSessions],
  );

  // 平台特化（Z-02 / Z-04）：无独立顶栏；窗口根按平台加圆角类，浮层条绝对定位不占布局高度。
  const platform = desktopPlatform();
  const windowMaximized = useWindowMaximized();
  const frameClass = ['app', 'desktop-window-frame', windowFrameClass(platform, windowMaximized)]
    .filter((c) => c.length > 0)
    .join(' ');

  return (
    <ShellPaletteProvider value={paletteValue}>
      <div className={frameClass}>
        <AppFrame controller={frame} />
        {/* Z-01：左上角浮层（侧栏折叠入口 + New Task）；**没有 topbar** */}
        <DesktopTopOverlay
          platform={platform}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={frame.geometry.sidebarExpandedWidth}
          onToggleSidebar={() => frameDispatch({ type: 'sidebar/toggle' })}
          onNewTask={() => newSessionCollapsingRightbar(frameDispatch)}
        />
      </div>
    </ShellPaletteProvider>
  );
}
