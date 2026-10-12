// web 壳页面装配（Z7：与桌面**同构**的四席位骨架）。
//
// 骨架（侧栏 / 中栏 / 右栏 / 覆层）来自 `@harness2/ui-shared/renderer/layout`（桌面同一套 AppFrame +
// frame-seat-views + useFrameState），本文件只做两件 web 特有的事：
//   1. 用 `assembleWebFrame` 建一份注册表并注入 **web 版 seat-contents**（只接 web 真实具备的
//      store/controller；无数据通道的席位/覆层如实为空，不摆假入口）；
//   2. 把应用壳（store/controller）与新建会话接线经 `WebShellProvider` 交给席位内容。
// 左上浮层条（品牌 + 侧栏折叠 + New Task）用壳无关的 `FrameTopOverlay`；web 无窗口控制
// （桌面 `frame:false` 自绘三键在会话列头，见 desktop components/ConversationHeader.tsx）。
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppShell } from '@harness2/ui-shared/renderer/app-shell.js';
import { useDraftsUnloadGuard } from '@harness2/ui-shared/renderer/drafts-guard.js';
import { AppFrame, FrameTopOverlay, useFrameState } from '@harness2/ui-shared/renderer/layout/index.js';
import { assembleWebFrame } from './shell-registry.js';
import { WebShellProvider, type WebShellValue } from './web-shell-context.js';

export interface WebAppProps {
  readonly shell: AppShell;
  /** 新建会话（由组装根提供：需要 cwd，见 serve-client 的 createSession 注释） */
  readonly onNewSession?: () => void;
  /** 新建会话不可用时的**可行动**原因（不摆灰按钮不给解释） */
  readonly newSessionBlockedReason?: string;
}

export function WebApp({ shell, onNewSession, newSessionBlockedReason }: WebAppProps): ReactNode {
  const { store } = shell;
  const state = shell.useAppState();
  // 四席位注册表：本次挂载建一份（声明 + 注册容器 + 注入 web 内容）。
  const registry = useMemo(() => assembleWebFrame().registry, []);
  const frame = useFrameState({ registry });
  const frameDispatch = frame.dispatch;
  /** P0：主区可能停在「自动化」主区视图 —— 新建会话前先回对话（key=null = 保留的 conversation）。 */
  const backToConversation = (): void => frameDispatch({ type: 'main/select-key', key: null });
  // Z7：设置覆层开合（只内存，D-14）；覆层席位内容经 WebShellProvider 读它。
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Z7：命令面板覆层开合（只内存，D-14）；Ctrl/Cmd+K 与侧栏命令中心入口同一真源。
  const [paletteOpen, setPaletteOpen] = useState(false);
  // P2-4：web 无草稿落盘通道（draftsPersistence==='memory-only'）——
  // 有未发送草稿时注册 beforeunload 护栏，刷新/关闭前如实提示，不静默丢草稿。
  useDraftsUnloadGuard(shell.controller, store);

  // Ctrl+K / Cmd+K 唤出命令面板（与浏览器默认「地址栏搜索」共存：阻止默认后由壳接管）。
  // 打开设置覆层的 Ctrl+, 桌面有、web 不设（共享设置页在 web 经侧栏齿轮进入，不新造键位）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  // Ctrl+N / Cmd+N：新建会话（Z-07 #1；与侧栏 New Task 按钮同一动作 + 同一可用性门控，
  // 不在被阻断时「按了没反应」或强行调用必失败的动作）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      if (newSessionEnabled) {
        // P0：主区若停在「自动化」视图，先回对话再新建。
        frameDispatch({ type: 'main/select-key', key: null });
        onNewSession?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newSessionEnabled, onNewSession, frameDispatch]);

  const shellValue: WebShellValue = {
    shell,
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
          testId="web-top-overlay"
        />
      </div>
    </WebShellProvider>
  );
}
