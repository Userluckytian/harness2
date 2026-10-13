// 渲染端根组件（P4-A 骨架）：AppFrame 四席位（sidebar / main / rightbar / shell.overlay）。
// Z7：三栅几何、让步链、面板即时状态、帧容器与席位注册表已下沉 ui-shared（renderer/layout/** 与
// renderer/slots/**）；本目录 renderer/layout/** 只留桌面专属（浮层包装 / 覆层开关 / 壳主题 / D-15 主题呈现 / 装配）。
// 旧的自制分屏（components/PaneArea.tsx + 分栏命令）已随三栅落地拆除（D-10：会话页占 main 的 conversation key）。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SettingsNotifyDetails, SettingsPreferencesShape, SettingsTheme } from '../shared/protocol.js';
import { composeNotifyContent, shouldNotifyOnTurnEnd } from '../shared/notify.js';
import {
  AppFrame,
  DesktopTopOverlay,
  ShellPaletteProvider,
  getShellTheme,
  openSettingsAtSection,
  setOverlay,
  setShellTheme,
  toggleOverlay,
  useFrameState,
  useShellTheme,
  type ShellPaletteValue,
} from './layout/index.js';
import { isImeComposing } from '@harness2/ui-shared/renderer/features/composer/composer-model.js';
import { canGoBack, canGoForward, sessionNavHistory } from '@harness2/ui-shared/renderer/layout/session-nav-history.js';
import { shellSlots } from './layout/shell-registry.js';
import { desktopPlatform, windowFrameClass } from './platform.js';
import { useWindowMaximized } from './window-state.js';
import { toggleTerminalDock } from './terminal/toggle-dock.js';
import { type PaletteCommand, type PaletteSession } from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { controller, store, useAppState, newSessionCollapsingRightbar, THEME_CYCLE } from './app-shared.js';
import { cycleComposerMode, cycleComposerThoughtLevel } from './conversation/composer-controls-bridge.js';
import { codePreferencesFromSettings, hydrateCodePreferences } from '@harness2/ui-shared/renderer/code/index.js';
import { requestOpenComposerModelMenu } from '@harness2/ui-shared/renderer/conversation/composer/composer-menu-signal.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import { filterSessionList } from '@harness2/ui-shared/shared/metadata.js';
import { SIDE_PANE_NO_SESSION_KEY, sidePaneStore } from '@harness2/ui-shared/renderer/side-pane/index.js';
import { ToastHost, toast } from '@harness2/ui-shared/renderer/toast/index.js';

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

/** 「打开工作区」真动作（命令面板与 Ctrl+O 共用同一入口）：Electron 目录选择 → 以所选目录 cwd 建会话。
 *  取消选择（null）即无操作；通道失败静默（不伪造成功）。 */
function openWorkspaceFromPicker(): void {
  void (async () => {
    try {
      const dir = await window.harness2.projectsPickFolder?.();
      if (dir === null || dir === undefined) return;
      const created = await window.harness2.createSession(dir);
      await controller.refreshSessions();
      await controller.selectSession(created.id);
    } catch (e) {
      // Z10-8b：原来静默吞掉 → 现在如实弹一条失败通知（不伪造成功）。
      toast({ kind: 'error', message: '打开工作区失败', detail: e instanceof Error ? e.message : String(e) });
    }
  })();
}

/** 相对当前选中切换 ±1 会话（Ctrl+Shift+[ / ] 与命令面板同一动作） */
function stepSelectedSession(delta: -1 | 1): void {
  const id = moveSession(store.getState(), delta);
  if (id !== null) void controller.selectSession(id);
}

/** 会话历史「后退 / 前进」（Z10-3：顶部两钮与 Ctrl+[ / ] 同一动作）。
 *  无路可走（history 返回 null）→ 不动作、不报错（反向钉）。 */
function navigateHistory(direction: 'back' | 'forward'): void {
  const id = direction === 'back' ? sessionNavHistory.back() : sessionNavHistory.forward();
  if (id !== null) void controller.selectSession(id);
}

/** 切换主题并持久化（桌面：settingsSetPreferences；Ctrl+Shift+L 与命令面板同一动作） */
function cycleThemeAndPersist(): void {
  const next = cycleTheme(getShellTheme());
  setShellTheme(next);
  void window.harness2.settingsSetPreferences({ theme: next });
}

export function App(): React.ReactNode {
  const state = useAppState();
  const frame = useFrameState({ registry: shellSlots });
  const { dispatch: frameDispatch } = frame;
  // Z10-3：会话导航历史（模块级内存单例）—— 订阅以驱动顶部 后退/前进 的 disabled 态。
  const navHistory = useSyncExternalStore(sessionNavHistory.subscribe, sessionNavHistory.getSnapshot);
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
  // Z10-3：选中会话变化即写入导航历史（相邻重复去重、从非栈顶记录时截断 forward 分支）。
  // back()/forward() 自身也会改 selectedId，但那时游标已对准目标条目 → record 为 no-op（不污染历史）。
  const selectedId = state.selectedId;
  useEffect(() => {
    if (selectedId !== null) sessionNavHistory.record(selectedId);
  }, [selectedId]);
  // 主题/通知偏好：启动时读取并应用（主题呈现由 setShellTheme 立即写入，D-15 四要素随之落地）
  useEffect(() => {
    void window.harness2
      .settingsGetPreferences()
      .then((p: SettingsPreferencesShape) => {
        setNotifyDetails(p.notifyDetails);
        setShellTheme(p.theme);
        // Z10-7：代码偏好（代码主题/行号/换行/字号）灌入共享运行时 store —— 代码查看器与预览卡
        // 在设置页打开前也能拿到持久化偏好（否则重启后查看器要等打开设置才生效）。
        // 桌面真源 = desktop-preferences.json → 用 hydrate（不镜像浏览器本地存储，几何/偏好断言不受扰）。
        hydrateCodePreferences(codePreferencesFromSettings(p));
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
  // 全局快捷键（Z10-4：按 ZCode 源码权威键表 `@zcode/shared/shortcutCommands.ts` 补齐）。
  // 全部收敛在**唯一一条** keydown 监听里（不写第二套监听器）；一律 e.preventDefault 防浏览器默认，
  // 忽略长按 repeat 与 IME 组合（isComposing / keyCode 229，与 composer 同一 isImeComposing 口径）。
  // 已兑现：Ctrl+K / Ctrl+Shift+P（命令面板别名）、Ctrl+,（设置）、Ctrl+N（新任务）、Ctrl+J（终端）、
  //        Ctrl+B（侧栏）、Ctrl+Alt+B（右栏）、Ctrl+Shift+L（切换主题+持久化）、
  //        Ctrl+Shift+[ / ]（上/下一个会话）、Ctrl+O（打开工作区）、
  //        Ctrl+[ / ]（会话历史 后退/前进，Z10-3）、
  //        Ctrl+M（打开模型菜单，经共享信号总线）、Ctrl+Shift+M（权限模式循环）、Ctrl+T（思考档位循环）。
  // 不可兑现（如实不绑，见 Z10-4/Z10-2b 报告）：Ctrl+W（无「关闭当前上下文」动作）、
  //        Ctrl+F / 缩放 / 双模式 / 引导。Ctrl+Shift+M / Ctrl+T 读 config 缓存未就绪时不动作（不臆造起点）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.repeat || isImeComposing(e)) return;
      const key = e.key.toLowerCase();
      const code = e.code;
      const { shiftKey, altKey } = e;
      // 左右方括号按物理 code 兜底（Shift 下 e.key 会变成 { / }，非 US 布局也不可靠）
      const bracketLeft = code === 'BracketLeft' || key === '[' || key === '{';
      const bracketRight = code === 'BracketRight' || key === ']' || key === '}';

      if (shiftKey && !altKey) {
        if (key === 'p') {
          e.preventDefault();
          toggleOverlay('palette'); // openCommandCenter 别名（同 Ctrl+K）
        } else if (key === 'l') {
          e.preventDefault();
          cycleThemeAndPersist(); // switchTheme
        } else if (key === 'm') {
          e.preventDefault();
          cycleComposerMode(); // cycleSessionMode（写 config approval.mode，与控件同一写路径）
        } else if (bracketLeft) {
          e.preventDefault();
          stepSelectedSession(-1); // previousConversation
        } else if (bracketRight) {
          e.preventDefault();
          stepSelectedSession(1); // nextConversation
        }
        // 其余 Shift 组合（Ctrl+Shift+U/O…）未兑现：不动作、不 preventDefault
        return;
      }
      if (altKey) {
        if (key === 'b') {
          e.preventDefault();
          frameDispatch({ type: 'rightbar/toggle' }); // toggleSidePane
        }
        // 其余 Ctrl+Alt 组合无绑定
        return;
      }

      if (key === ',') {
        e.preventDefault();
        toggleOverlay('settings'); // openSettings
      } else if (key === 'k') {
        e.preventDefault();
        toggleOverlay('palette'); // openCommandCenter
      } else if (key === 'n') {
        // 屏蔽浏览器「新开窗口」默认行为；新建会话同时按 Z2-04 收起右栏。
        // P0：主区若停在「自动化」视图，先回对话（key=null = 保留的 conversation）。
        e.preventDefault();
        frameDispatch({ type: 'main/select-key', key: null });
        newSessionCollapsingRightbar(frameDispatch);
      } else if (key === 'j') {
        // 屏蔽浏览器「下载」等默认行为；终端席位未注册时 toggleTerminalDock 如实 no-op。
        e.preventDefault();
        toggleTerminalDock();
      } else if (key === 'b') {
        e.preventDefault();
        frameDispatch({ type: 'sidebar/toggle' }); // toggleSidebar
      } else if (key === 'o') {
        e.preventDefault();
        openWorkspaceFromPicker(); // openWorkspace（桌面有目录通道；web 无 → 不绑）
      } else if (key === 'm') {
        e.preventDefault();
        requestOpenComposerModelMenu(); // openModelMenu（无已挂载模型菜单时 no-op）
      } else if (key === 't') {
        e.preventDefault();
        cycleComposerThoughtLevel(); // cycleThoughtLevel（模型未声明档位时 no-op）
      } else if (bracketLeft) {
        e.preventDefault();
        navigateHistory('back'); // navigateBack（会话历史后退）
      } else if (bracketRight) {
        e.preventDefault();
        navigateHistory('forward'); // navigateForward（会话历史前进）
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
        run: () => {
          frameDispatch({ type: 'main/select-key', key: null });
          newSessionCollapsingRightbar(frameDispatch);
        },
      },
      { id: 'openWorkspace', label: '打开工作区', hint: 'Ctrl+O', group: '建议', run: openWorkspaceFromPicker },
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
      // Z9-5：终端 dock 已引入 —— 切换终端为真动作（与 Ctrl+J 同一真源 toggleTerminalDock）；
      // 「添加终端标签」仍占位：TerminalPanel 未暴露 imperative 新建口（面板内 ＋ 按钮才是真入口），
      // 命令面板无从触达，故保留 disabled 占位而不硬造（红线⑩）。
      {
        id: 'toggleTerminal',
        label: '切换终端',
        hint: 'Ctrl+J',
        group: '面板',
        run: () => toggleTerminalDock(),
      },
      {
        id: 'addTerminalTab',
        label: '添加终端标签',
        group: '面板',
        disabled: true,
        disabledHint: '请在终端面板内用「＋」新建标签',
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
        run: cycleThemeAndPersist,
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
      onSelectSession: (id: string) => {
        frameDispatch({ type: 'main/select-key', key: null });
        void controller.selectSession(id);
      },
    }),
    [commands, paletteSessions, frameDispatch],
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
          onNewTask={() => {
            frameDispatch({ type: 'main/select-key', key: null });
            newSessionCollapsingRightbar(frameDispatch);
          }}
          canGoBack={canGoBack(navHistory)}
          canGoForward={canGoForward(navHistory)}
          onBack={() => navigateHistory('back')}
          onForward={() => navigateHistory('forward')}
        />
        {/* Z10-8b：全局 Toast 宿主（覆层区；订阅壳无关 toastStore，两壳同一实现） */}
        <ToastHost />
      </div>
    </ShellPaletteProvider>
  );
}
