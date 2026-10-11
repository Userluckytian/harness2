// 设置壳（Z-88 外壳：**全屏设置页**，承载在既有 overlay 席位里 —— fixed 全屏层，不新增席位/路由）。
//
// 职责边界：
//   壳 —— 全屏页骨架（左栏返回/分组导航/页脚 + 右栏面包屑/内容槽）、激活分区状态（**只内存**，
//         D-14：重挂载即回默认分区）；
//   分区内容 —— 由宿主传入的 `sections` 决定（本文件不 import 任何 IPC/能力模块）。
// 只有激活分区会被渲染（按需挂载）→ 未激活分区不产生副作用，也不会渲染「占位的假控件」。
//
// Z-88 要点：
//   - grid `grid-cols-[68px_minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]`；
//   - 左栏：48px 拖拽条 → 返回按钮（ghost/lg，ArrowLeft +「返回工作区」= 关 overlay）→
//     分组导航（Z-89 三组）→ 底部页脚（宿主注入；max-lg:hidden）；
//   - 导航项 `h-8 w-full rounded-xl px-2.5`，窄屏（<lg）收成图标（size-10，文字 sr-only）；
//     激活 `bg-surface-hover text-foreground`；分组标题 `text-ui-sm text-foreground-subtlest`；
//   - 右栏：容器 `border bg-background`（Windows rounded-[5px]，其余 rounded-xl —— 按平台判定）+
//     顶部 48px 面包屑行 + 主区滚动；内容列 `mx-auto w-full max-w-4xl px-4 pb-8`；
//   - **没有全局搜索框，也没有外壳级分段 tab**（搜索是分区级的，本期未引入）。
import { useCallback, useState } from 'react';
import { Button } from '@harness2/ui-shared/components/ui/button.js';
import { cn } from '@harness2/ui-shared/lib/utils.js';
import { desktopPlatform } from '../../platform.js';
import { IconArrowLeft, IconFallback, type SettingsIconProps } from './icons.js';
import {
  SETTINGS_SECTION_GROUPS,
  groupSections,
  sortSections,
  type SettingsSectionDefinition,
} from './section-model.js';

/** 壳契约错误（分区 id 重复 = 两套并存守门） */
export class SettingsShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsShellError';
  }
}

/** 折叠宿主给的分区（拒重复 id）；壳只负责排序、分组、导航与内容槽 */
export function resolveSections(sections: readonly SettingsSectionDefinition[]): readonly SettingsSectionDefinition[] {
  const byId = new Map<string, SettingsSectionDefinition>();
  for (const s of sections) {
    if (byId.has(s.id)) throw new SettingsShellError(`分区 id 重复: ${s.id}`);
    byId.set(s.id, s);
  }
  return sortSections([...byId.values()]);
}

export interface SettingsShellProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 分区声明（宿主装配；壳只负责分组、排序、导航与内容槽） */
  readonly sections: readonly SettingsSectionDefinition[];
  /** 页面语义名（aria-label；缺省「设置」） */
  readonly title?: string;
  /** 初始分区 id（缺省取排序后第一个） */
  readonly defaultSectionId?: string;
  /** 左栏底部页脚内容（ZCode 是账号菜单；我们放 About 数据的版本号，max-lg:hidden） */
  readonly footer?: React.ReactNode;
}

/** 分区分组标题（组 id → 中文标题；未分组 → undefined） */
function groupLabel(groupId: SettingsSectionDefinition['group']): string | undefined {
  return SETTINGS_SECTION_GROUPS.find((g) => g.id === groupId)?.label;
}

/** 设置壳页面（分组导航 + 面包屑 + 内容槽） */
export function SettingsShell({
  open,
  onClose,
  sections,
  title = '设置',
  defaultSectionId,
  footer,
}: SettingsShellProps): React.ReactNode {
  const resolved = resolveSections(sections);
  const fallbackId = resolved[0]?.id ?? '';
  const initialId = defaultSectionId ?? fallbackId;
  const [activeState, setActive] = useState(initialId);
  // 宿主分区表变化后，旧激活 id 可能已不存在 → 回落到第一个分区（不渲染空内容槽）
  const active = resolved.some((s) => s.id === activeState) ? activeState : fallbackId;
  const current = resolved.find((s) => s.id === active);
  const select = useCallback((id: string) => setActive(id), []);

  if (!open) return null;

  // Z-88：右栏容器圆角按平台（Windows 5px，其余 xl；非桌面宿主/测试夹具无 platform → xl）
  const contentRadius = desktopPlatform() === 'win32' ? 'rounded-[5px]' : 'rounded-xl';
  const groups = groupSections(resolved);
  // Z-88：面包屑 items.length < 2 → 不渲染（我们的分区都在组内 = 恒两项；裸分区兼容回落）
  const crumbGroup = groupLabel(current?.group);
  const crumbIcon = current?.icon;
  const CrumbIcon = crumbIcon ?? IconFallback;

  return (
    <div
      role="dialog"
      aria-label={title}
      data-settings-page
      className="fixed inset-0 z-[100] grid grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background text-foreground lg:grid-cols-[268px_minmax(0,1fr)]"
    >
      {/* —— 左栏：拖拽条 → 返回 → 分组导航 → 页脚 —— */}
      <aside
        data-settings-nav
        data-section-count={resolved.length}
        className="flex h-full min-h-0 flex-col overflow-y-auto px-2 pb-3 max-lg:items-center"
      >
        {/* Z-88：左栏顶部 48px 拖拽条（复用窗口外壳既有拖拽类；web 无 Electron 语义，类是惰性的） */}
        <div aria-hidden="true" className="app-frame-sidebar-drag max-lg:hidden" />
        <Button
          variant="ghost"
          size="lg"
          type="button"
          onClick={onClose}
          data-settings-back
          className="mt-1 w-full shrink-0 justify-start gap-2 px-2.5 text-foreground-subtle max-lg:size-10 max-lg:justify-center max-lg:px-0"
        >
          <IconArrowLeft className="size-4 shrink-0" />
          <span className="max-lg:sr-only">返回工作区</span>
        </Button>
        <nav aria-label={title} className="flex min-h-0 flex-1 flex-col">
          {groups.map((view, gi) => (
            <div
              key={view.group?.id ?? 'ungrouped'}
              {...(view.group !== null ? { 'data-settings-nav-group': view.group.id } : {})}
              className={cn('flex flex-col', gi > 0 && 'max-lg:border-t')}
            >
              {view.group !== null && (
                <div
                  data-settings-group-label={view.group.id}
                  className="px-2.5 pb-1 pt-4 text-ui-sm text-foreground-subtlest max-lg:sr-only"
                >
                  {view.group.label}
                </div>
              )}
              {view.sections.map((s) => {
                const Icon = (s.icon ?? IconFallback) as React.ComponentType<SettingsIconProps>;
                const on = s.id === active;
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-section-nav={s.id}
                    data-section-owner={s.owner}
                    aria-current={on ? 'page' : undefined}
                    onClick={() => select(s.id)}
                    className={cn(
                      'flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-ui-base transition-colors',
                      'max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0',
                      on
                        ? 'bg-surface-hover text-foreground'
                        : 'text-foreground-subtle hover:bg-hover hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate max-lg:sr-only">{s.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        {/* Z-88 底部页脚（ZCode = 账号菜单；我们无账号体系 → 宿主注入版本号；窄屏不显示） */}
        {footer !== undefined && (
          <div
            data-settings-footer
            className="shrink-0 px-2.5 pb-1 pt-3 text-ui-sm text-foreground-subtlest max-lg:hidden"
          >
            {footer}
          </div>
        )}
      </aside>

      {/* —— 右栏：容器（border + 平台圆角）+ 48px 面包屑行 + 滚动主区 —— */}
      <div className="min-h-0 min-w-0">
        <div
          className={cn('flex h-full min-h-0 flex-col border border-border bg-background', contentRadius)}
          data-settings-pane
        >
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-4" data-settings-breadcrumb>
            {crumbGroup !== undefined && (
              <>
                <CrumbIcon className="size-4 shrink-0 text-foreground-subtlest" />
                <span className="text-ui-sm text-foreground-subtlest">{crumbGroup}</span>
                <span className="text-ui-sm text-foreground-subtlest">/</span>
              </>
            )}
            <span className="truncate text-ui-sm text-foreground">{current?.label ?? title}</span>
          </div>
          {/* 内容槽：只渲染当前分区的正文（按需挂载） */}
          <div
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
            data-section={current?.id}
            data-section-owner={current?.owner}
            data-settings-body
          >
            <div className="mx-auto w-full max-w-4xl px-4 pb-8 pt-0 lg:px-8 lg:pb-10">
              <h2 data-settings-section-title className="pb-2 pt-6 text-2xl lg:text-3xl">
                {current?.label ?? title}
              </h2>
              {current?.render()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
