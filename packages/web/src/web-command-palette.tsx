// web 命令面板覆层（Z7）：把**共享** CommandPalette（`@harness2/ui-shared/renderer/components`）
// 接到 web 壳，命令表与会话候选由 **web 真实具备**的 store/controller/帧动作组装 —— 不摆假入口（红线⑩）。
//
// 命令来源（每条都对应 web 真能执行的动作）：
//   * 新建会话 —— 仅当 `newSessionEnabled`（有可用 cwd + 已连接）时列出，否则**不出现**（不摆必失败入口）；
//   * 上一/下一个会话、归档当前会话、跳转到会话… —— 走共享 controller（selectSession / archiveSession），
//     会话排序/过滤复用共享 `filterSessionList`（与侧栏同一口径）；
//   * 打开设置 —— 打开 web 设置覆层（复用共享设置页）；
//   * 切换主题 —— 共享主题运行时（D-14 例外 #1：浏览器存储镜像偏好，与 theme-boot.js 同源）；
//   * 收起/展开侧栏、打开/收起右栏、复位面板 —— 共享帧动作（与桌面同一 reducer）。
//
// **如实省略（登记差距）**：桌面的「帮助 / 快捷键说明」在 web 不列 —— web 设置页只启用
// 外观/网关两个分区，没有快捷键说明分区，列出后点开是空目标 = 假入口，故不摆。
import { useMemo, type ReactNode } from 'react';
import { THEME_CYCLE } from '@harness2/ui-shared/renderer/app-shell.js';
import {
  CommandPalette,
  JUMP_TO_SESSION_ID,
  type PaletteCommand,
  type PaletteSession,
} from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { setShellTheme, shellThemeLabel, useShellTheme } from '@harness2/ui-shared/renderer/theme/index.js';
import { filterSessionList } from '@harness2/ui-shared/shared/metadata.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import { useWebShell } from './web-shell-context.js';

/** 可跳转会话的有序 id（未归档、未删除；按 mtime 降序）——与侧栏同一共享过滤口径 */
function selectableSessionIds(state: AppState): string[] {
  return filterSessionList(state.sessions, state.metadata, '').active.map((s) => s.id);
}

/** 相对当前选中移动 ±1（回绕）；返回新 id 或 null（无会话） */
export function webAdjacentSessionId(state: AppState, delta: -1 | 1): string | null {
  const ids = selectableSessionIds(state);
  if (ids.length === 0) return null;
  const cur = state.selectedId;
  const curIdx = cur !== null ? ids.indexOf(cur) : -1;
  const next = curIdx >= 0 ? (curIdx + delta + ids.length) % ids.length : 0;
  return ids[next] ?? null;
}

/** 命令面板覆层席位内容（web）：共享面板 + web 命令表/会话候选 */
export function WebPaletteOverlay(): ReactNode {
  const { shell, newSessionEnabled, onNewSession, onOpenSettings, paletteOpen, onClosePalette } = useWebShell();
  const { store, controller } = shell;
  const state = shell.useAppState();
  const { state: frameState, geometry, dispatch: frameDispatch } = useFrame();
  const theme = useShellTheme();
  const sidebarCollapsed = geometry.sidebarCollapsed;

  const sessions: PaletteSession[] = useMemo(
    () =>
      selectableSessionIds(state).map((id) => {
        const s = state.sessions.find((it) => it.id === id);
        const label = store.displayTitleFor(id) ?? s?.firstUserText ?? '';
        return { id, label: label.length > 0 ? label : '(空会话)' };
      }),
    [state, store],
  );

  const commands: PaletteCommand[] = useMemo(() => {
    const focusSearch = (): void => {
      // 收起态先展开再聚焦（否则 rail 态不渲染输入框，命令会「按了没反应」）。
      if (sidebarCollapsed) frameDispatch({ type: 'sidebar/toggle' });
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('.h2-sidebar-search')?.focus();
      });
    };
    const cycleThemeAction = (): void => {
      const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? 'system';
      setShellTheme(next);
    };
    const nextId = webAdjacentSessionId(state, 1);
    const prevId = webAdjacentSessionId(state, -1);
    const archiveId = state.selectedId;
    const list: PaletteCommand[] = [];
    if (newSessionEnabled && onNewSession !== undefined) {
      list.push({ id: 'newSession', label: '新建会话', hint: 'Ctrl+N', run: () => onNewSession() });
    }
    list.push(
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
      { id: 'openSettings', label: '打开设置', run: () => onOpenSettings() },
      { id: 'cycleTheme', label: `切换主题（当前：${shellThemeLabel(theme)}）`, run: cycleThemeAction },
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
      { id: 'resetFrame', label: '复位面板宽度与开合', run: () => frameDispatch({ type: 'reset' }) },
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
    );
    return list;
  }, [
    state,
    theme,
    sidebarCollapsed,
    frameState.rightbarOpen,
    frameDispatch,
    controller,
    newSessionEnabled,
    onNewSession,
    onOpenSettings,
  ]);

  return (
    <CommandPalette
      open={paletteOpen}
      onClose={onClosePalette}
      commands={commands}
      sessions={sessions}
      onSelectSession={(id) => void controller.selectSession(id)}
    />
  );
}
