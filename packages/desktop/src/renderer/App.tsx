// 渲染端根组件（B3-2 拆分后）：App 根组件 + 主题切换纯函数（cycleTheme/moveSession）。
// 分栏/会话列表/消息流已拆到 components/（PaneArea / SessionList / ChatView）；
// 共享状态（store/controller/useAppState/StatusBadge 等）在 app-shared.ts；
// 为兼容 main.tsx 与测试的既有导入，这里保持全部对外再导出。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SettingsNotifyDetails, SettingsPreferencesShape, SettingsTheme } from '../shared/protocol.js';
import { MAX_PANES } from '../shared/layout.js';
import { applyTheme, themeLabel } from './theme.js';
import { composeNotifyContent, shouldNotifyOnTurnEnd } from '../shared/notify.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import {
  CommandPalette,
  JUMP_TO_SESSION_ID,
  type PaletteCommand,
  type PaletteSession,
} from './components/CommandPalette.js';
import { SessionList } from './components/SessionList.js';
import { PaneArea } from './components/PaneArea.js';
import { SidePanel } from './components/SidePanel.js';
import { controller, store, useAppState, THEME_CYCLE, StatusBadge } from './app-shared.js';
import type { AppState } from './store.js';
import { filterSessionList } from '../shared/metadata.js';

// 对外再导出（拆分前 App.tsx 的全部导出面；main.tsx / 测试仍从 './App.js' 引）
export { controller, dragState, store, useAppState, StatusBadge } from './app-shared.js';
export { SessionList } from './components/SessionList.js';
export { ChatItemView, ChatView } from './components/ChatView.js';
export { PaneArea } from './components/PaneArea.js';

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<SettingsTheme>('warmPaper');
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
  // 主题/通知偏好：启动时读取并应用；设置页保存后 onPreferenceChange 即时同步（保存回调里更新各状态）
  useEffect(() => {
    void window.harness2
      .settingsGetPreferences()
      .then((p: SettingsPreferencesShape) => {
        setTheme(p.theme);
        setNotifyDetails(p.notifyDetails);
        applyTheme(p.theme);
      })
      .catch(() => {});
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  // B7 任务完成系统通知：turn-end 且「窗口非聚焦 + 该会话不可见」→ 弹系统通知。
  // 判定必须发生在这两者同时成立时（聚焦抖动/窗口失焦瞬间到位），因此逐帧结算；
  // document.hasFocus() 为浏览器 API（渲染进程零 Node），助手完成后窗口不聚焦即触发。
  // 未读徽标由 store 独立处理（不重复）；点击通知则主进程聚焦 + notify/click 帧 → selectSession。
  // listener 只挂载一次（避免随 sessions/metadata 更新重建导致帧丢失竞态）；内部经
  // store.getState() 读最新会话/覆层数据，notifyDetails 用 ref 取当前偏好。
  const notifyDetailsRef = useRef(notifyDetails);
  notifyDetailsRef.current = notifyDetails;
  useEffect(() => {
    return controller.startObservingFrames((frame) => {
      queueMicrotask(() => {
        if (frame.type !== 'turn-end' || frame.sessionId.length === 0) return;
        const st = store.getState();
        const summary = st.sessions.find((s) => s.id === frame.sessionId);
        if (summary === undefined || store.peekStream(frame.sessionId) === undefined) return; // 会话未知/尚未缓冲：不弹
        const windowFocused = document.hasFocus();
        const sessionVisible = !store.isBackground(frame.sessionId);
        if (!shouldNotifyOnTurnEnd({ windowFocused, visible: sessionVisible })) return; // 前台/该会话可见时不弹
        // 完整级别带回复摘要（前 80 字），精简级别只标题（尊重设置弹窗的 notifyDetails 偏好）
        const body = notifyDetailsRef.current === 'full' ? store.assistantText(frame.sessionId) : '';
        const { title, body: composedBody } = composeNotifyContent({
          title: store.displayTitleFor(frame.sessionId),
          firstUserText: summary.firstUserText,
          replyText: body,
        });
        void window.harness2.notify(title, composedBody, frame.sessionId).catch(() => {});
      });
    });
  }, [controller]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((v) => !v);
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
        setPaletteOpen((v) => !v);
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
      const el = document.getElementById('session-search-input');
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    const cycleThemeAction = (): void => {
      const next = cycleTheme(theme);
      setTheme(next);
      applyTheme(next);
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
      { id: 'openSettings', label: '打开设置', hint: 'Ctrl+,', run: () => setSettingsOpen(true) },
      { id: 'cycleTheme', label: `切换主题（当前：${themeLabel(theme)}）`, run: cycleThemeAction },
      { id: 'helpShortcuts', label: '帮助 / 快捷键说明', run: () => setSettingsOpen(true) },
      { id: 'setPanes1', label: '切换为单栏（1 栏）', run: () => void controller.setPaneCount(1) },
      { id: 'setPanes2', label: '切换为双栏（2 栏）', run: () => void controller.setPaneCount(2) },
      { id: 'setPanes3', label: '切换为三栏（3 栏）', run: () => void controller.setPaneCount(3) },
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
  }, [state, theme]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">harness2</span>
        <span className="topbar-right">
          <span className="hint">最多 {MAX_PANES} 分屏并行</span>
          <button type="button" className="btn-settings" title="设置 (Ctrl+,)" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <StatusBadge status={state.status} error={state.statusDetail?.error} />
        </span>
      </header>
      <div className="body">
        <SessionList />
        <PaneArea />
        <SidePanel />
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onThemeChange={(t) => {
          setTheme(t);
          applyTheme(t);
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        sessions={paletteSessions}
        onSelectSession={(id) => void controller.selectSession(id)}
      />
    </div>
  );
}
