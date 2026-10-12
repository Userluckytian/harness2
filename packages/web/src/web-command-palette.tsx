// web 命令面板覆层（Z7 接入 / Z8 §7 Z-17 tabbed 命令表 / Z-20 六组统一）：把**共享** CommandPalette
//（`@harness2/ui-shared/renderer/components`）接到 web 壳，layout="tabbed" 走四 tab
//（全部 | 操作 | 任务 | 文件），命令表按六组（建议/会话/面板/视图/配置/应用）补齐，与桌面逐字一致 ——
// 每条**真实/占位如实**（红线⑩：无通道=disabled+disabledHint）。
//
// 命令来源（分组与桌面收敛后口径对齐）：
//   * 建议：新任务（仅 `newSessionEnabled` 时列出，否则**不出现**，不摆必失败入口）、
//     打开工作区（web 无目录选择通道 → disabled+disabledHint）、设置（真，打开 web 设置覆层）；
//   * 会话：上一/下一个会话、归档当前会话（均走共享 controller，真）；
//   * 面板：切换侧边栏（真，共享帧动作）、切换终端/添加终端标签（终端 dock 未引入 → 占位）、
//     添加审查标签（真：打开右栏 changes pane，经共享 sidePaneStore + rightbar/open）；
//   * 视图：打开右栏/收起右栏（真，label 随帧状态动态）、复位面板宽度与开合（真）；
//   * 配置：设置（真，同 onOpenSettings）、切换主题到深色（真，共享主题运行时；当前深色时文案翻转为「浅色」）、
//     技能 / MCP 服务器（web 无对应分区 → 占位）；
//   * 应用：问题上报 / 用户社群 / 产品文档（仓库无既有外链 URL，零编造 → 占位）、
//     断开连接（web 无断开/重连通道 → 占位）。
//
// **如实省略（登记差距）**：桌面的「帮助 / 快捷键说明」在 web 不列（web 设置页只启用外观/网关两个
// 分区，列出后点开是空目标 = 假入口）。tabbed 下任务 tab 已承载会话跳转 → 不再单列
//「搜索会话…」「跳转到会话…」两条 classic 命令。
import { useMemo, type ReactNode } from 'react';
import { THEME_CYCLE } from '@harness2/ui-shared/renderer/app-shell.js';
import {
  CommandPalette,
  type PaletteCommand,
  type PaletteSession,
} from '@harness2/ui-shared/renderer/components/CommandPalette.js';
import { useFrame } from '@harness2/ui-shared/renderer/layout/frame-context.js';
import { setShellTheme, useShellTheme } from '@harness2/ui-shared/renderer/theme/index.js';
import { filterSessionList } from '@harness2/ui-shared/shared/metadata.js';
import type { AppState } from '@harness2/ui-shared/renderer/store.js';
import { SIDE_PANE_NO_SESSION_KEY, sidePaneStore } from '@harness2/ui-shared/renderer/side-pane/index.js';
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

/** 命令面板覆层席位内容（web）：共享面板（tabbed）+ web 命令表/会话候选（任务 tab） */
export function WebPaletteOverlay(): ReactNode {
  const { shell, newSessionEnabled, onNewSession, onOpenSettings, paletteOpen, onClosePalette } = useWebShell();
  const { store, controller } = shell;
  const state = shell.useAppState();
  const { state: frameState, dispatch: frameDispatch } = useFrame();
  const theme = useShellTheme();

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
    const cycleThemeAction = (): void => {
      const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? 'system';
      setShellTheme(next);
    };
    // 「添加审查标签」真动作：打开右栏 changes pane（我们壳里「审查/变更」的对应物）。
    // 桶与 SidePaneHost 同源：未选会话落无会话桶（同 web-seat-contents 的轨迹打开先例）。
    const openReview = (): void => {
      const bucket = state.selectedId ?? SIDE_PANE_NO_SESSION_KEY;
      sidePaneStore.open(bucket, 'changes');
      frameDispatch({ type: 'rightbar/open' });
    };
    const nextId = webAdjacentSessionId(state, 1);
    const prevId = webAdjacentSessionId(state, -1);
    const archiveId = state.selectedId;
    // 占位命令（红线⑩）：无真实通道面 → disabled + disabledHint，不摆假动作。
    const noop = (): void => undefined;
    const rightbarOpen = frameState.rightbarOpen;
    const list: PaletteCommand[] = [];

    // —— 建议 ——
    if (newSessionEnabled && onNewSession !== undefined) {
      list.push({ id: 'newTask', label: '新任务', hint: 'Ctrl+N', group: '建议', run: () => onNewSession() });
    }
    list.push({
      id: 'openWorkspace',
      label: '打开工作区',
      hint: 'Ctrl+O',
      group: '建议',
      disabled: true,
      disabledHint: 'web 无目录选择通道',
      run: noop,
    });
    list.push({ id: 'settingsSuggested', label: '设置', group: '建议', run: () => onOpenSettings() });

    // —— 会话 ——
    list.push({
      id: 'nextSession',
      label: '切到下一个会话',
      group: '会话',
      run: () => {
        if (nextId !== null) void controller.selectSession(nextId);
      },
    });
    list.push({
      id: 'prevSession',
      label: '上一个会话',
      group: '会话',
      run: () => {
        if (prevId !== null) void controller.selectSession(prevId);
      },
    });
    list.push({
      id: 'archiveCurrent',
      label: '归档当前会话',
      group: '会话',
      run: () => {
        if (archiveId !== null) void controller.archiveSession(archiveId, true);
      },
    });

    // —— 面板 ——
    list.push({
      id: 'toggleSidebar',
      label: '切换侧边栏',
      hint: 'Ctrl+B',
      group: '面板',
      run: () => frameDispatch({ type: 'sidebar/toggle' }),
    });
    list.push({
      id: 'toggleTerminal',
      label: '切换终端',
      hint: 'Ctrl+J',
      group: '面板',
      disabled: true,
      disabledHint: '终端功能未引入',
      run: noop,
    });
    list.push({
      id: 'addTerminalTab',
      label: '添加终端标签',
      group: '面板',
      disabled: true,
      disabledHint: '终端功能未引入',
      run: noop,
    });
    list.push({ id: 'addReviewTab', label: '添加审查标签', group: '面板', run: openReview });

    // —— 视图 ——
    list.push({
      id: 'toggleRightbar',
      label: rightbarOpen ? '收起右栏' : '打开右栏',
      group: '视图',
      run: () => frameDispatch({ type: 'rightbar/toggle' }),
    });
    list.push({
      id: 'resetFrame',
      label: '复位面板宽度与开合',
      group: '视图',
      run: () => frameDispatch({ type: 'reset' }),
    });

    // —— 配置 ——
    list.push({ id: 'settingsConfig', label: '设置', group: '配置', run: () => onOpenSettings() });
    list.push({
      id: 'cycleTheme',
      label: theme === 'zai-dark' ? '切换主题到浅色' : '切换主题到深色',
      group: '配置',
      run: cycleThemeAction,
    });
    list.push({
      id: 'skills',
      label: '技能',
      group: '配置',
      disabled: true,
      disabledHint: 'web 无技能分区',
      run: noop,
    });
    list.push({
      id: 'mcpServers',
      label: 'MCP 服务器',
      group: '配置',
      disabled: true,
      disabledHint: 'web 无 MCP 分区',
      run: noop,
    });

    // —— 应用 ——（外链 URL 仓库无既有来源，零编造 → 全部占位）
    list.push({
      id: 'reportIssue',
      label: '问题上报',
      group: '应用',
      disabled: true,
      disabledHint: '外链未配置',
      run: noop,
    });
    list.push({
      id: 'community',
      label: '用户社群',
      group: '应用',
      disabled: true,
      disabledHint: '外链未配置',
      run: noop,
    });
    list.push({
      id: 'productDocs',
      label: '产品文档',
      group: '应用',
      disabled: true,
      disabledHint: '外链未配置',
      run: noop,
    });
    list.push({
      id: 'disconnect',
      label: '断开连接',
      group: '应用',
      disabled: true,
      disabledHint: '无断开通道',
      run: noop,
    });

    return list;
  }, [
    state,
    theme,
    frameDispatch,
    frameState.rightbarOpen,
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
      layout="tabbed"
    />
  );
}
