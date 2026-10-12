// P0-2（Z-10）会话行「更多」菜单：**右键与行右侧 ⋯ 按钮共用同一份动作定义**
// （rowMenuEntries 一次计算，两种弹出容器各自渲染——杜绝两入口逻辑漂移）。
// 只列**可兑现**的项——每个动作对应一条已核实的通道，壳不传该回调 = 该项不渲染
// （红线⑩：不摆点了没反应的假菜单项）。
// 顺序按 ZCode `TaskActionMenuContent.tsx:82-206`：置顶 → 重命名 → 归档 →（在分屏打开）
// →（分隔）→ 查看 Model Trajectory。
// **跳过的 Z-10 项（无通道，登记于 issue-log）**：标记未读（store 无 unread 覆写 API）、
// 在文件管理器显示 / 复制工作区路径 / 复制任务路径 / 复制日志路径 / 复制 Session ID / 反馈
// （桌面 shell 无对应 IPC 或本轮未接）。
import { Fragment, type ReactNode } from 'react';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../../components/ui/context-menu.js';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../../components/ui/dropdown-menu.js';
import type { SidebarSessionItem } from './session-items.js';
import type { SidebarLabels } from './labels.js';

/** 菜单动作 id（纯函数返回顺序即渲染顺序） */
export type RowMenuAction = 'pin' | 'unpin' | 'rename' | 'archive' | 'unarchive' | 'split' | 'trajectory';

export interface RowMenuFlags {
  pinned: boolean;
  archived: boolean;
  canPin: boolean;
  canRename: boolean;
  canArchive: boolean;
  canSplit: boolean;
  canTrajectory: boolean;
}

/** 可兑现动作集合（纯逻辑，测试钉顺序与「无通道不出现」） */
export function rowMenuActions(flags: RowMenuFlags): RowMenuAction[] {
  const actions: RowMenuAction[] = [];
  if (flags.canPin) actions.push(flags.pinned ? 'unpin' : 'pin');
  if (flags.canRename) actions.push('rename');
  if (flags.canArchive) actions.push(flags.archived ? 'unarchive' : 'archive');
  if (flags.canSplit) actions.push('split');
  if (flags.canTrajectory) actions.push('trajectory');
  return actions;
}

/** 会话行菜单的动作回调集合（壳侧注入；缺项=该项不渲染） */
export interface RowMenuCallbacks {
  onPin?: ((id: string, pinned: boolean) => void) | undefined;
  onRename?: ((item: SidebarSessionItem) => void) | undefined;
  onArchive?: ((id: string, archived: boolean) => void) | undefined;
  onOpenInSplit?: ((id: string) => void) | undefined;
  /** 分屏已满（4 格）：项禁用 + title 说明（不摆点了不动的假项） */
  splitLimitReached?: boolean | undefined;
  onInspectTrajectory?: ((id: string) => void) | undefined;
}

/** 单个可渲染动作项（label/禁用态/触发已算好；两种容器只负责摆壳） */
export interface RowMenuEntry {
  action: RowMenuAction;
  label: string;
  disabled: boolean;
  /** 禁用原因（title；无则 undefined） */
  title?: string | undefined;
  /** 轨迹项前分隔线（Z-10：其前有分隔） */
  separatorBefore: boolean;
  run: () => void;
}

/** 一次计算：动作 →（标签/禁用/触发）。右键与 ⋯ 共用，防漂移。 */
export function rowMenuEntries(
  item: SidebarSessionItem,
  labels: SidebarLabels,
  callbacks: RowMenuCallbacks,
): RowMenuEntry[] {
  const actions = rowMenuActions({
    pinned: item.pinned,
    archived: item.archived,
    canPin: callbacks.onPin !== undefined,
    canRename: callbacks.onRename !== undefined,
    canArchive: callbacks.onArchive !== undefined,
    canSplit: callbacks.onOpenInSplit !== undefined,
    canTrajectory: callbacks.onInspectTrajectory !== undefined,
  });
  const splitDisabled = callbacks.splitLimitReached === true;
  return actions.map((action) => {
    const label =
      action === 'pin'
        ? labels.menuPin
        : action === 'unpin'
          ? labels.menuUnpin
          : action === 'rename'
            ? labels.menuRename
            : action === 'archive'
              ? labels.menuArchive
              : action === 'unarchive'
                ? labels.menuUnarchive
                : action === 'split'
                  ? labels.menuOpenInSplit
                  : labels.menuTrajectory;
    return {
      action,
      label,
      disabled: action === 'split' && splitDisabled,
      ...(action === 'split' && splitDisabled ? { title: labels.menuSplitLimit } : {}),
      // 「查看轨迹」前分隔（Z-10：其前必有其它项，条件恒真，防御性检查保留）
      separatorBefore: action === 'trajectory' && actions.some((a) => a !== 'trajectory'),
      run: () => {
        switch (action) {
          case 'pin':
            callbacks.onPin?.(item.id, true);
            break;
          case 'unpin':
            callbacks.onPin?.(item.id, false);
            break;
          case 'rename':
            callbacks.onRename?.(item);
            break;
          case 'archive':
            callbacks.onArchive?.(item.id, true);
            break;
          case 'unarchive':
            callbacks.onArchive?.(item.id, false);
            break;
          case 'split':
            if (!splitDisabled) callbacks.onOpenInSplit?.(item.id);
            break;
          case 'trajectory':
            callbacks.onInspectTrajectory?.(item.id);
            break;
        }
      },
    };
  });
}

/** 行右键菜单内容（Radix ContextMenu 的 Content；由 SessionRow 的 Trigger 唤出） */
export function SessionRowMenuContent({
  item,
  labels,
  callbacks,
}: {
  item: SidebarSessionItem;
  labels: SidebarLabels;
  callbacks: RowMenuCallbacks;
}): ReactNode {
  const entries = rowMenuEntries(item, labels, callbacks);
  if (entries.length === 0) return null;
  return (
    <ContextMenuContent data-testid="session-row-menu" data-session-id={item.id}>
      {entries.map((entry) => (
        <Fragment key={entry.action}>
          {entry.separatorBefore && <ContextMenuSeparator />}
          <ContextMenuItem
            data-menu-action={entry.action}
            disabled={entry.disabled}
            {...(entry.title !== undefined ? { title: entry.title } : {})}
            onSelect={entry.run}
          >
            {entry.label}
          </ContextMenuItem>
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}

/** 行 ⋯ 按钮的下拉菜单内容（P0-2/Z-10 第二入口；动作集与右键同源） */
export function SessionRowMoreMenuContent({
  item,
  labels,
  callbacks,
}: {
  item: SidebarSessionItem;
  labels: SidebarLabels;
  callbacks: RowMenuCallbacks;
}): ReactNode {
  const entries = rowMenuEntries(item, labels, callbacks);
  if (entries.length === 0) return null;
  return (
    <DropdownMenuContent align="end" data-testid="session-row-more-menu" data-session-id={item.id}>
      {entries.map((entry) => (
        <Fragment key={entry.action}>
          {entry.separatorBefore && <DropdownMenuSeparator />}
          <DropdownMenuItem
            data-menu-action={entry.action}
            disabled={entry.disabled}
            {...(entry.title !== undefined ? { title: entry.title } : {})}
            onSelect={entry.run}
          >
            {entry.label}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </DropdownMenuContent>
  );
}
