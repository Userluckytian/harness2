// P0-2（Z-10）会话行右键菜单：只列**可兑现**的项——每个动作对应一条已核实的通道，
// 壳不传该回调 = 该项不渲染（红线⑩：不摆点了没反应的假菜单项）。
// 顺序按 ZCode `TaskActionMenuContent.tsx:82-206`：置顶 → 重命名 → 归档 →（在分屏打开）
// →（分隔）→ 查看 Model Trajectory。
// **跳过的 Z-10 项（无通道，登记于 issue-log）**：标记未读（store 无 unread 覆写 API）、
// 在文件管理器显示 / 复制工作区路径 / 复制任务路径 / 复制日志路径 / 复制 Session ID / 反馈
// （桌面 shell 无对应 IPC 或本轮未接）。
import { Fragment, type ReactNode } from 'react';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../../components/ui/context-menu.js';
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
  const actions = rowMenuActions({
    pinned: item.pinned,
    archived: item.archived,
    canPin: callbacks.onPin !== undefined,
    canRename: callbacks.onRename !== undefined,
    canArchive: callbacks.onArchive !== undefined,
    canSplit: callbacks.onOpenInSplit !== undefined,
    canTrajectory: callbacks.onInspectTrajectory !== undefined,
  });
  if (actions.length === 0) return null;
  const splitDisabled = callbacks.splitLimitReached === true;
  return (
    <ContextMenuContent data-testid="session-row-menu" data-session-id={item.id}>
      {actions.map((action) => {
        // 「查看轨迹」前分隔（Z-10：其前有分隔线）
        const sepBefore =
          action === 'trajectory' &&
          actions.some(
            (a) =>
              a === 'split' || a === 'archive' || a === 'unarchive' || a === 'rename' || a === 'pin' || a === 'unpin',
          );
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
        return (
          <Fragment key={action}>
            {sepBefore && <ContextMenuSeparator />}
            <ContextMenuItem
              data-menu-action={action}
              disabled={action === 'split' && splitDisabled}
              {...(action === 'split' && splitDisabled ? { title: labels.menuSplitLimit } : {})}
              onSelect={() => {
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
              }}
            >
              {label}
            </ContextMenuItem>
          </Fragment>
        );
      })}
    </ContextMenuContent>
  );
}
