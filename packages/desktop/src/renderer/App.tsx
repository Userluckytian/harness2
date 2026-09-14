// 渲染端根组件（P4-A 骨架）：顶栏 + AppFrame 四席位（sidebar / main / rightbar / shell.overlay）。
// 三栅几何、让步链、面板即时状态与主题呈现见 renderer/layout/**；席位注册表见 renderer/slots/**；
// 旧的自制分屏（components/PaneArea.tsx + 分栏命令）已随三栅落地拆除（D-10：会话页占 main 的 conversation key）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsNotifyDetails, SettingsPreferencesShape, SettingsTheme } from '../shared/protocol.js';
import { composeNotifyContent, shouldNotifyOnTurnEnd } from '../shared/notify.js';
import {
  AppFrame,
  ShellPaletteProvider,
  shellThemeLabel,
  setOverlay,
  setShellTheme,
  toggleOverlay,
  useFrameState,
  useShellTheme,
  type ShellPaletteValue,
} from './layout/index.js';
import { shellSlots } from './layout/shell-registry.js';
import { JUMP_TO_SESSION_ID, type PaletteCommand, type PaletteSession } from './components/CommandPalette.js';
import { controller, store, useAppState, THEME_CYCLE, StatusBadge } from './app-shared.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import { filterSessionList } from '@harness2/ui-shared/shared/metadata.js';

// 对外再导出（拆分前 App.tsx 的全部导出面；main.tsx / 测试仍从 './App.js' 引）
export { controller, dragState, store, useAppState, StatusBadge } from './app-shared.js';
export { ChatItemView, ChatTranscript } from '@harness2/ui-shared/renderer/components/ChatView.js';

export function cycleTheme(current: SettingsTheme): SettingsTheme {
  const i = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] ?? 'warmPaper';
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
  const { state: frameState, dispatch: frameDispatch } = frame;
  // 侧栏开合取几何口径（窄屏看「手动展开」override、宽屏看偏好 —— frame-state.isSidebarCollapsed）
  const sidebarCollapsed = frame.geometry.sidebarRail;
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
  // Ctrl+K / Cmd+K 命令面板（与 Ctrl+, Ctrl+N Ctrl+F 共存；屏蔽浏览器默认"定位链接"）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleOverlay('palette');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  // 命令表（纯数据；副作用全在 run 回调里，经 controller/state 注入）
  const commands: PaletteCommand[] = useMemo(() => {
    const focusSearch = (): void => {
      // P4-C：侧栏搜索框随 SidebarRoot 落地（占位「搜索会话…」，无 id）。
      // 收起态先展开再聚焦（否则 rail 态不渲染输入框，命令会「按了没反应」）。
      if (sidebarCollapsed) frameDispatch({ type: 'sidebar/toggle' });
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('.h2-sidebar-search')?.focus();
      });
    };
    const cycleThemeAction = (): void => {
      const next = cycleTheme(theme);
      setShellTheme(next);
      void window.harness2.settingsSetPreferences({ theme: next });
    };
    const nextId = moveSession(state, 1);
    const prevId = moveSession(state, -1);
    const archiveId = state.selectedId;
    return [
      { id: 'newSession', label: '新建会话', hint: 'Ctrl+N', run: () => void controller.newSession() },
      {
        id: 'nextSession',
        label: '切到下一个会话',
        run: () => {
          if (nextId !== null) void controller.selectSession(nextId);
        },
      },
      {
        id: 'prevSession',
        label: '上一个会话',
        run: () => {
          if (prevId !== null) void controller.selectSession(prevId);
        },
      },
      { id: 'openSettings', label: '打开设置', hint: 'Ctrl+,', run: () => setOverlay('settings', true) },
      { id: 'cycleTheme', label: `切换主题（当前：${shellThemeLabel(theme)}）`, run: cycleThemeAction },
      {
        id: 'helpShortcuts',
        label: '帮助 / 快捷键说明',
        run: () => setOverlay('settings', true),
      },
      // 三栅面板（取代旧的分栏数命令；D-11～D-14）
      {
        id: 'toggleSidebar',
        label: sidebarCollapsed ? '展开侧栏' : '收起侧栏',
        run: () => frameDispatch({ type: 'sidebar/toggle' }),
      },
      {
        id: 'toggleRightbar',
        label: frameState.rightbarOpen ? '收起右栏' : '打开右栏',
        run: () => frameDispatch({ type: 'rightbar/toggle' }),
      },
      {
        id: 'resetFrame',
        label: '复位面板宽度与开合',
        run: () => frameDispatch({ type: 'reset' }),
      },
      {
        id: 'archiveCurrent',
        label: '归档当前会话',
        run: () => {
          if (archiveId !== null) void controller.archiveSession(archiveId, true);
        },
      },
      { id: 'search', label: '搜索会话…', hint: '聚焦侧栏搜索', run: focusSearch },
      // 特殊命令：进入「跳转会话」选择态（组件识别 JUMP_TO_SESSION_ID 后切换为会话过滤）
      { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: () => {} },
    ];
  }, [state, theme, sidebarCollapsed, frameState.rightbarOpen, frameDispatch]);

  // 覆层席位的命令面板数据（context 传：组件身份稳定，命令表刷新不会把面板重挂载）
  const paletteValue: ShellPaletteValue = useMemo(
    () => ({
      commands,
      sessions: paletteSessions,
      onSelectSession: (id: string) => void controller.selectSession(id),
    }),
    [commands, paletteSessions],
  );

  return (
    <ShellPaletteProvider value={paletteValue}>
      <div className="app">
        <header className="topbar">
          <span className="brand">harness2</span>
          <span className="topbar-right">
            <button
              type="button"
              className="app-frame-btn"
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-label="侧栏开关"
              aria-pressed={!sidebarCollapsed}
              onClick={() => frameDispatch({ type: 'sidebar/toggle' })}
            >
              ▤
            </button>
            <button
              type="button"
              className="app-frame-btn"
              title={frameState.rightbarOpen ? '收起右栏' : '打开右栏'}
              aria-label="右栏开关"
              aria-pressed={frameState.rightbarOpen}
              onClick={() => frameDispatch({ type: 'rightbar/toggle' })}
            >
              ▥
            </button>
            <button
              type="button"
              className="btn-settings"
              title="设置 (Ctrl+,)"
              onClick={() => setOverlay('settings', true)}
            >
              ⚙
            </button>
            <StatusBadge status={state.status} error={state.statusDetail?.error} />
          </span>
        </header>
        <AppFrame controller={frame} />
      </div>
    </ShellPaletteProvider>
  );
}
