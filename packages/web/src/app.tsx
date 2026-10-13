// web 壳页面装配（Z7：与桌面**同构**的四席位骨架）。
//
// 骨架（侧栏 / 中栏 / 右栏 / 覆层）来自 `@harness2/ui-shared/renderer/layout`（桌面同一套 AppFrame +
// frame-seat-views + useFrameState），本文件只做两件 web 特有的事：
//   1. 用 `assembleWebFrame` 建一份注册表并注入 **web 版 seat-contents**（只接 web 真实具备的
//      store/controller；无数据通道的席位/覆层如实为空，不摆假入口）；
//   2. 把应用壳（store/controller）与新建会话接线经 `WebShellProvider` 交给席位内容。
// 左上浮层条（品牌 + 侧栏折叠 + New Task）用壳无关的 `FrameTopOverlay`；web 无窗口控制
// （桌面 `frame:false` 自绘三键在会话列头，见 desktop components/ConversationHeader.tsx）。
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { THEME_CYCLE, type AppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { useDraftsUnloadGuard } from '@harness2/ui-shared/renderer/drafts-guard.js';
import { isImeComposing } from '@harness2/ui-shared/renderer/features/composer/composer-model.js';
import { AppFrame, FrameTopOverlay, useFrameState } from '@harness2/ui-shared/renderer/layout/index.js';
import { canGoBack, canGoForward, sessionNavHistory } from '@harness2/ui-shared/renderer/layout/session-nav-history.js';
import { getShellTheme, setShellTheme } from '@harness2/ui-shared/renderer/theme/index.js';
import { requestOpenComposerModelMenu } from '@harness2/ui-shared/renderer/conversation/composer/composer-menu-signal.js';
import type { TerminalPort } from '@harness2/ui-shared/renderer/terminal/port.js';
import { toggleTerminalDock } from './terminal/toggle-dock.js';
import { UNAVAILABLE_WEB_TERMINAL_PORT } from './terminal/web-port.js';
import { assembleWebFrame } from './shell-registry.js';
import { webAdjacentSessionId } from './web-command-palette.js';
import { webCycleComposerMode } from './web-composer-controls.js';
import { WebShellProvider, type WebShellValue } from './web-shell-context.js';
import type { WebSettingsDataPorts } from './web-settings.js';

export interface WebAppProps {
  readonly shell: AppShell;
  /** 新建会话（由组装根提供：需要 cwd，见 serve-client 的 createSession 注释） */
  readonly onNewSession?: () => void;
  /** 新建会话不可用时的**可行动**原因（不摆灰按钮不给解释） */
  readonly newSessionBlockedReason?: string;
  /** 终端传输端口（Z9-5；缺省 = 无通道 → available=false 的如实空实现） */
  readonly terminalPort?: TerminalPort;
  /** 设置数据面端口（Z9-6b；缺省 = 无 serve 设置通道 → 对应分区如实降级） */
  readonly settingsDataPorts?: WebSettingsDataPorts;
}

export function WebApp({
  shell,
  onNewSession,
  newSessionBlockedReason,
  terminalPort,
  settingsDataPorts,
}: WebAppProps): ReactNode {
  const { store } = shell;
  const state = shell.useAppState();
  // 四席位注册表：本次挂载建一份（声明 + 注册容器 + 注入 web 内容）。
  const registry = useMemo(() => assembleWebFrame().registry, []);
  const frame = useFrameState({ registry });
  const frameDispatch = frame.dispatch;
  // Z10-3：会话导航历史（模块级内存单例）—— 订阅以驱动顶部 后退/前进 的 disabled 态。
  const navHistory = useSyncExternalStore(sessionNavHistory.subscribe, sessionNavHistory.getSnapshot);
  /** P0：主区可能停在「自动化」主区视图 —— 新建会话前先回对话（key=null = 保留的 conversation）。 */
  const backToConversation = (): void => frameDispatch({ type: 'main/select-key', key: null });
  // Z10-3：选中会话变化即写入导航历史（去重/截断 forward 由 history 内部完成）。
  const selectedId = state.selectedId;
  useEffect(() => {
    if (selectedId !== null) sessionNavHistory.record(selectedId);
  }, [selectedId]);
  /** 会话历史「后退 / 前进」（Z10-3：顶部两钮与 Ctrl+[ / ] 同一动作）；
   *  无路可走（返回 null）→ 不动作、不报错（反向钉）。 */
  const navigateHistory = useCallback(
    (direction: 'back' | 'forward'): void => {
      const id = direction === 'back' ? sessionNavHistory.back() : sessionNavHistory.forward();
      if (id !== null) void shell.controller.selectSession(id);
    },
    [shell.controller],
  );
  // Z7：设置覆层开合（只内存，D-14）；覆层席位内容经 WebShellProvider 读它。
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Z7：命令面板覆层开合（只内存，D-14）；Ctrl/Cmd+K 与侧栏命令中心入口同一真源。
  const [paletteOpen, setPaletteOpen] = useState(false);
  // P2-4：web 无草稿落盘通道（draftsPersistence==='memory-only'）——
  // 有未发送草稿时注册 beforeunload 护栏，刷新/关闭前如实提示，不静默丢草稿。
  useDraftsUnloadGuard(shell.controller, store);

  // P2-9：新建会话需要 cwd（serve 强制要求；本壳无目录选择通道）。
  // 列表里一个带 cwd 的会话都没有时，按钮点了必失败 —— 据实置灰并给出可行动原因，
  // 不摆「可点但必失败」的入口。
  const hasUsableCwd = state.sessions.some((s) => typeof s.cwd === 'string' && s.cwd.length > 0);
  const newSessionBlocked =
    onNewSession === undefined
      ? (newSessionBlockedReason ?? '无法新建会话：本壳未提供新建会话动作')
      : !hasUsableCwd
        ? (newSessionBlockedReason ?? '无法新建会话：列表里没有可用 cwd（serve 要求 cwd，本壳无目录选择通道）')
        : undefined;
  const newSessionEnabled = state.status === 'connected' && newSessionBlocked === undefined;

  // 全局快捷键（Z10-4：按 ZCode 源码权威键表 `@zcode/shared/shortcutCommands.ts` 补齐）。
  // 全部收敛在**唯一一条** keydown 监听里（不写第二套监听器）；一律 e.preventDefault 防浏览器默认，
  // 忽略长按 repeat 与 IME 组合（isComposing / keyCode 229，与 composer 同一 isImeComposing 口径）。
  // 已兑现：Ctrl+K / Ctrl+Shift+P（命令面板别名）、Ctrl+,（设置覆层）、Ctrl+N（新任务，受可用性门控）、
  //        Ctrl+J（终端）、Ctrl+B（侧栏）、Ctrl+Alt+B（右栏）、Ctrl+Shift+L（切换主题，浏览器存储持久化）、
  //        Ctrl+Shift+[ / ]（上/下一个会话）、Ctrl+[ / ]（会话历史 后退/前进，Z10-3）、
  //        Ctrl+M（打开模型菜单）、Ctrl+Shift+M（权限模式循环）。
  // 不绑（如实登记，见 Z10-4/Z10-2b 报告）：Ctrl+O（web 无目录选择通道）、
  //        Ctrl+W（无「关闭当前上下文」动作）、**Ctrl+T（思考档位：serve config 视图不回 roles.effort
  //        与 reasoning.values，web 无该数据面 → 控件不渲染、键不绑）**、Ctrl+F / 缩放 / 双模式 / 引导。
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
          setPaletteOpen((open) => !open); // openCommandCenter 别名（同 Ctrl+K）
        } else if (key === 'l') {
          e.preventDefault();
          const next = THEME_CYCLE[(THEME_CYCLE.indexOf(getShellTheme()) + 1) % THEME_CYCLE.length] ?? 'system';
          setShellTheme(next); // switchTheme；落盘经共享主题运行时镜像到 localStorage（D-14 例外 #1）
        } else if (key === 'm') {
          e.preventDefault();
          webCycleComposerMode(settingsDataPorts); // cycleSessionMode（PUT 白名单 approval.mode）
        } else if (bracketLeft) {
          e.preventDefault();
          const id = webAdjacentSessionId(store.getState(), -1);
          if (id !== null) void shell.controller.selectSession(id); // previousConversation
        } else if (bracketRight) {
          e.preventDefault();
          const id = webAdjacentSessionId(store.getState(), 1);
          if (id !== null) void shell.controller.selectSession(id); // nextConversation
        }
        // 其余 Shift 组合（Ctrl+Shift+U/O…）未兑现：不动作、不 preventDefault
        return;
      }
      if (altKey) {
        if (key === 'b') {
          e.preventDefault();
          frameDispatch({ type: 'rightbar/toggle' }); // toggleSidePane
        }
        return;
      }

      if (key === 'k') {
        // 与浏览器默认「地址栏搜索」共存：阻止默认后由壳接管。
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === ',') {
        e.preventDefault();
        setSettingsOpen(true); // openSettings（打开共享设置覆层）
      } else if (key === 'n') {
        // 与侧栏 New Task 同一动作 + 同一可用性门控（被阻断时按了不强行调用必失败动作）。
        e.preventDefault();
        if (newSessionEnabled) {
          // P0：主区若停在「自动化」视图，先回对话再新建。
          frameDispatch({ type: 'main/select-key', key: null });
          onNewSession?.();
        }
      } else if (key === 'j') {
        // 阻止浏览器默认（Ctrl+J 在部分浏览器 = 下载）；终端席位未注册时如实 no-op。
        e.preventDefault();
        toggleTerminalDock();
      } else if (key === 'b') {
        e.preventDefault();
        frameDispatch({ type: 'sidebar/toggle' }); // toggleSidebar
      } else if (key === 'm') {
        e.preventDefault();
        requestOpenComposerModelMenu(); // openModelMenu（无已挂载模型菜单时 no-op）
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
  }, [newSessionEnabled, onNewSession, frameDispatch, store, shell.controller, settingsDataPorts, navigateHistory]);

  const shellValue: WebShellValue = {
    shell,
    terminalPort: terminalPort ?? UNAVAILABLE_WEB_TERMINAL_PORT,
    ...(settingsDataPorts !== undefined ? { settingsDataPorts } : {}),
    ...(onNewSession !== undefined ? { onNewSession } : {}),
    newSessionEnabled,
    ...(newSessionBlocked !== undefined ? { newSessionBlockedReason: newSessionBlocked } : {}),
    settingsOpen,
    onOpenSettings: () => setSettingsOpen(true),
    onCloseSettings: () => setSettingsOpen(false),
    paletteOpen,
    onOpenPalette: () => setPaletteOpen(true),
    onClosePalette: () => setPaletteOpen(false),
  };

  return (
    <WebShellProvider value={shellValue}>
      <div className="web-frame">
        <AppFrame controller={frame} />
        {/* Z-01：左上角浮层（侧栏折叠入口 + New Task）；web 无窗口控制扩展 */}
        <FrameTopOverlay
          height={48}
          sidebarCollapsed={frame.geometry.sidebarCollapsed}
          sidebarWidth={frame.geometry.sidebarExpandedWidth}
          onToggleSidebar={() => frame.dispatch({ type: 'sidebar/toggle' })}
          onNewTask={() => {
            backToConversation();
            onNewSession?.();
          }}
          canGoBack={canGoBack(navHistory)}
          canGoForward={canGoForward(navHistory)}
          onBack={() => navigateHistory('back')}
          onForward={() => navigateHistory('forward')}
          testId="web-top-overlay"
        />
      </div>
    </WebShellProvider>
  );
}
