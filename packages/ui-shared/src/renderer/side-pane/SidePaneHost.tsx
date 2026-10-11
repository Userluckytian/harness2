// SidePaneHost —— 壳无关的右栏标签宿主（Z2-04 / Z-13 / Z-14）。
//
// 承载方式：「tab 按需出现」——右栏打开但零 tab 时显示「打开标签页」加号启动器；
// tab 可关闭 / 拖拽排序 / 横向滚动（tab 最小宽 60、gap 4、标签条 h-12 border-b）；
// 状态 = ./side-pane-model + ./side-pane-store 的内存 Map（按会话分桶、LRU 50、不落盘 D-14）。
//
// 分工（本组件 = 纯承载，不带任何壳的数据语义）：
//   * 壳提供 `renderTab(id, sessionId)` —— 各 tab 的内容组件与数据源由壳决定；
//   * 壳提供启动器项白名单 `items` —— **凡该壳数据通道不具备的 tab 不在列表**（红线⑩：
//     不摆假入口）；缺省 = 全量静态面板 + 模型轨迹；
//   * 「刷新只读视图 / 重新同步」为可省动作（缺省不渲染）；「计划视图依赖任务账本」提示
//     由 `planAvailable` 决定。
// Z7 起桌面 SidePanel 与本组件共用同一份承载实现（桌面 SidePanel 只做内容映射与路由效应）。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AppStore } from '../store.js';
import { cn } from '../../lib/utils.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import {
  SIDE_PANE_LAUNCHER_ITEM_IDS,
  SIDE_PANE_NO_SESSION_KEY,
  SIDE_PANE_TAB_GAP_PX,
  SIDE_PANE_TAB_MIN_WIDTH_PX,
  sidePaneDropIndex,
  sidePaneMoveTarget,
  sidePaneOpenTarget,
  sidePaneTabLabel,
  type SidePaneLauncherItemId,
  type SidePaneTabId,
} from './side-pane-model.js';
import { sidePaneStore, useSidePaneTabs } from './side-pane-store.js';

/** 指针拖拽起手阈值（px）：小幅位移仍算点击，不误触重排 */
const DRAG_THRESHOLD_PX = 4;

/* 三个内联小图标（lucide 24×24 同形路径）：统一 stroke=currentColor，尺寸由 className 给。 */
function IconPlus({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function IconX({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function IconEllipsis({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

/** 加号菜单条目（启动器与标签条 + 共用同一份清单；已打开的给「已打开」提示，点击=激活） */
function TabMenuItems({
  items,
  openTabs,
  sessionId,
  backgroundTasksAvailable,
  onOpen,
}: {
  items: readonly SidePaneLauncherItemId[];
  openTabs: readonly SidePaneTabId[];
  /** 当前会话 id（null = 未选会话：「模型轨迹」项禁用 —— 轨迹按会话投影，无会话不摆空入口） */
  sessionId: string | null;
  /** 是否存在后台任务（store.allTasks() 非空；「后台任务」项的可用开关） */
  backgroundTasksAvailable: boolean;
  onOpen: (id: SidePaneLauncherItemId) => void;
}): ReactNode {
  return (
    <>
      {items.map((id) => {
        // 「模型轨迹」项：按当前会话解析成 model-trajectory:{sessionId}（Z-14）；无会话 → 禁用
        if (id === 'model-trajectory') {
          const target = sessionId !== null ? sidePaneOpenTarget(id, sessionId) : null;
          return (
            <DropdownMenuItem
              key={id}
              data-side-menu-item={id}
              disabled={target === null}
              title={target === null ? '选择会话后可查看模型轨迹' : undefined}
              onSelect={() => {
                if (target !== null) onOpen(id);
              }}
            >
              <span>{sidePaneTabLabel(sidePaneOpenTarget(id, sessionId ?? ''))}</span>
              {target !== null && openTabs.includes(target) && (
                <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>
              )}
            </DropdownMenuItem>
          );
        }
        // 「后台任务」项：按需可用（Z2-08）——无任务禁用 + title 说明；有任务同普通静态项
        if (id === 'background-tasks') {
          return (
            <DropdownMenuItem
              key={id}
              data-side-menu-item={id}
              disabled={!backgroundTasksAvailable}
              title={backgroundTasksAvailable ? undefined : '暂无后台任务（后台子代理启动后可在此查看）'}
              onSelect={() => {
                if (backgroundTasksAvailable) onOpen(id);
              }}
            >
              <span>{sidePaneTabLabel(id)}</span>
              {backgroundTasksAvailable && openTabs.includes(id) && (
                <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>
              )}
            </DropdownMenuItem>
          );
        }
        const opened = openTabs.includes(id);
        return (
          <DropdownMenuItem key={id} data-side-menu-item={id} onSelect={() => onOpen(id)}>
            <span>{sidePaneTabLabel(id)}</span>
            {opened && <span className="ml-auto pl-4 text-ui-xs text-foreground-subtlest">已打开</span>}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** 零 tab 启动器（Z-13：右栏打开但没有任何 tab 时的唯一内容） */
function SidePaneLauncher({
  items,
  openTabs,
  sessionId,
  backgroundTasksAvailable,
  onOpen,
}: {
  items: readonly SidePaneLauncherItemId[];
  openTabs: readonly SidePaneTabId[];
  sessionId: string | null;
  backgroundTasksAvailable: boolean;
  onOpen: (id: SidePaneLauncherItemId) => void;
}): ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4"
      data-testid="side-pane-launcher"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="side-pane-launcher-trigger"
          aria-label="打开标签页"
          title="打开标签页"
          className="flex size-10 cursor-pointer items-center justify-center rounded-lg border border-border text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
        >
          <IconPlus className="size-5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" data-testid="side-pane-launcher-menu">
          <TabMenuItems
            items={items}
            openTabs={openTabs}
            sessionId={sessionId}
            backgroundTasksAvailable={backgroundTasksAvailable}
            onOpen={onOpen}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="text-ui-sm text-foreground-subtle">打开标签页</p>
      <p className="text-ui-xs text-foreground-subtlest">面板按需出现，可随时关闭</p>
    </div>
  );
}

/** 标签条（Z-14）：h-12 border-b、横向滚动（溢出 tab 最小宽 60 / gap 4）、可关闭、指针拖拽排序 */
function SidePaneTabBar({
  bucket,
  items,
  openTabs,
  activeTab,
  approvalCount,
  backgroundTasksAvailable,
  onActivate,
  onClose,
  onMove,
}: {
  /** 关闭其他 / 全部关闭直接走 store（本菜单不经过宿主回调） */
  bucket: string;
  items: readonly SidePaneLauncherItemId[];
  openTabs: readonly SidePaneTabId[];
  activeTab: SidePaneTabId | null;
  approvalCount: number;
  /** 「后台任务」启动器项的可用开关（Z2-08） */
  backgroundTasksAvailable: boolean;
  onActivate: (id: SidePaneTabId) => void;
  onClose: (id: SidePaneTabId) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
}): ReactNode {
  const sessionId = bucket;
  const [draggingId, setDraggingId] = useState<SidePaneTabId | null>(null);
  const itemRefs = useRef(new Map<SidePaneTabId, HTMLElement | null>());
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const stopRef = useRef<(() => void) | null>(null);
  // 拖拽结束后的那次 click 不改激活（拖到别处松手 ≠ 点选）
  const suppressClickRef = useRef(false);

  // 卸载时收掉在途拖拽的全局监听（不留在 window 上）
  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLElement>, id: SidePaneTabId): void => {
    if (e.button !== 0) return;
    stopRef.current?.();
    const startX = e.clientX;
    let moved = false;
    const onPointerMove = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      moved = true;
      setDraggingId(id);
      // 按当前 DOM 顺序取矩形 → 指针越过哪个 tab 中点就落到它前面（纯函数换算，见 side-pane-model）
      const rects = openTabsRef.current.map(
        (t) => itemRefs.current.get(t)?.getBoundingClientRect() ?? { left: 0, right: 0 },
      );
      const drop = sidePaneDropIndex(rects, ev.clientX);
      if (drop === null) return;
      const from = openTabsRef.current.indexOf(id);
      const target = sidePaneMoveTarget(from, drop);
      if (target !== from) onMoveRef.current(from, target);
    };
    const stop = (): void => {
      suppressClickRef.current = moved;
      setDraggingId(null);
      stopRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    stopRef.current = stop;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  return (
    <div className="flex h-12 flex-none items-stretch border-b" data-testid="side-pane-tabstrip">
      <ScrollArea scrollbarOrientation="horizontal" className="min-w-0 flex-1">
        <div
          role="tablist"
          aria-label="工作面板标签"
          className="flex h-12 w-max min-w-full items-center px-1"
          style={{ gap: SIDE_PANE_TAB_GAP_PX }}
        >
          {openTabs.map((tab) => {
            const active = tab === activeTab;
            return (
              <div
                key={tab}
                ref={(el) => {
                  itemRefs.current.set(tab, el);
                }}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                data-side-tab={tab}
                data-side-tab-active={active ? 'true' : undefined}
                className={cn(
                  'group flex min-w-[60px] max-w-40 shrink-0 cursor-pointer select-none items-center gap-1 rounded-md px-2 py-1 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-border-hover',
                  active
                    ? 'bg-selected text-foreground'
                    : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
                  draggingId === tab && 'opacity-60',
                )}
                style={{ minWidth: SIDE_PANE_TAB_MIN_WIDTH_PX }}
                onPointerDown={(e) => startDrag(e, tab)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onActivate(tab);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(tab);
                  }
                }}
              >
                <span className="truncate">{sidePaneTabLabel(tab)}</span>
                {tab === 'approvals' && approvalCount > 0 && (
                  <span
                    className="flex-none rounded-full bg-warning px-1.5 text-ui-xs leading-4 text-warning-foreground"
                    data-side-badge="approvals"
                  >
                    {approvalCount}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`关闭 ${sidePaneTabLabel(tab)} 标签页`}
                  data-side-tab-close={tab}
                  className={cn(
                    'flex size-4 flex-none cursor-pointer items-center justify-center rounded text-foreground-subtlest hover:text-foreground',
                    active ? '' : 'invisible group-hover:visible',
                  )}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab);
                  }}
                >
                  <IconX className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {/* 常驻右簇：+（追加 tab）与 ⋯（关闭其他 / 全部关闭，Z-14 的一处实现） */}
      <div className="flex flex-none items-center gap-0.5 pr-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="打开标签页"
            title="打开标签页"
            data-testid="side-pane-add"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <IconPlus className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="side-pane-add-menu">
            <TabMenuItems
              items={items}
              openTabs={openTabs}
              sessionId={sessionId}
              backgroundTasksAvailable={backgroundTasksAvailable}
              onOpen={(id) => sidePaneStore.open(bucket, sidePaneOpenTarget(id, bucket))}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="标签页操作"
            title="标签页操作"
            data-testid="side-pane-actions"
            className="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <IconEllipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="side-pane-actions-menu">
            <DropdownMenuItem
              data-side-action="close-others"
              disabled={openTabs.length < 2}
              onSelect={() => {
                if (activeTab !== null) sidePaneStore.closeOthers(bucket, activeTab);
              }}
            >
              关闭其他标签页
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-side-action="close-all"
              variant="destructive"
              onSelect={() => sidePaneStore.closeAll(bucket)}
            >
              关闭全部标签页
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export interface SidePaneHostProps {
  /** 会话数据源（壳注入；不抓全局单例） */
  readonly store: AppStore;
  /** 当前选中会话 id（null = 未选；桶 = sessionId ?? 无会话桶） */
  readonly sessionId: string | null;
  /** 渲染激活 tab 的内容（壳提供；不同壳的 tab 内容面不同） */
  readonly renderTab: (id: SidePaneTabId, sessionId: string | null) => ReactNode;
  /** 可打开的启动器项白名单（缺省全量；壳按自己真实具备的数据通道裁剪） */
  readonly items?: readonly SidePaneLauncherItemId[];
  /** 「刷新只读视图」动作（缺省不渲染该按钮） */
  readonly onRefresh?: (sessionId: string) => void;
  /** 「重新同步」动作（缺省不渲染该按钮） */
  readonly onResync?: (sessionId: string) => void;
  /** 计划视图依赖提示（缺省不显示；仅在 sessionId 非空时评估） */
  readonly planAvailable?: boolean;
  /** 后台任务子会话跳转（缺省不渲染跳转） */
  readonly onOpenChildSession?: (childSessionId: string) => void;
}

/**
 * 右栏标签宿主：零 tab 启动器 / 标签条 / tab 内容槽 / 底部运维入口。
 * @param props - 会话数据源、tab 内容渲染函数、启动器白名单与可选动作。
 * @returns 右栏面板根元素。
 */
export function SidePaneHost(props: SidePaneHostProps): ReactNode {
  const { store, sessionId } = props;
  // 订阅 store：待批计数 / 后台任务可用性随流变化即时反映（与壳的 useAppState 同一订阅面）
  useSyncExternalStore(store.subscribe, store.getState);
  const bucket = sessionId ?? SIDE_PANE_NO_SESSION_KEY;
  const tabs = useSidePaneTabs(bucket);
  const approvalCount = store.allApprovals().length;
  // Z2-08：「后台任务」启动器项的可用开关（跨会话聚合口径——后台任务不随选中会话消失）
  const backgroundTasksAvailable = store.allTasks().length > 0;
  const items = props.items ?? SIDE_PANE_LAUNCHER_ITEM_IDS;
  const activeTab = tabs.activeTab;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background" aria-label="工作面板" data-testid="side-pane">
      {tabs.openTabs.length === 0 ? (
        <SidePaneLauncher
          items={items}
          openTabs={tabs.openTabs}
          sessionId={sessionId}
          backgroundTasksAvailable={backgroundTasksAvailable}
          onOpen={(id) => sidePaneStore.open(bucket, sidePaneOpenTarget(id, bucket))}
        />
      ) : (
        <SidePaneTabBar
          bucket={bucket}
          items={items}
          openTabs={tabs.openTabs}
          activeTab={activeTab}
          approvalCount={approvalCount}
          backgroundTasksAvailable={backgroundTasksAvailable}
          onActivate={(id) => sidePaneStore.activate(bucket, id)}
          onClose={(id) => sidePaneStore.close(bucket, id)}
          onMove={(from, to) => sidePaneStore.move(bucket, from, to)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="side-pane-body">
        {activeTab !== null && props.renderTab(activeTab, sessionId)}
      </div>
      {sessionId !== null && (props.onRefresh !== undefined || props.onResync !== undefined) && (
        <div className="flex flex-none items-center gap-2 border-t px-2 py-1.5 text-ui-sm" data-testid="side-pane-foot">
          {props.onRefresh !== undefined && (
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => props.onRefresh?.(sessionId)}
            >
              刷新只读视图
            </button>
          )}
          {props.onResync !== undefined && (
            <button
              type="button"
              title="重连/恢复后重拉服务端权威任务、队列与待批（resume-subscription）"
              className="cursor-pointer rounded px-1.5 py-0.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => props.onResync?.(sessionId)}
            >
              重新同步
            </button>
          )}
          {props.planAvailable === false && (
            <span className="text-ui-xs text-foreground-subtlest" title="会话无计划账本时该视图为空">
              计划视图依赖任务账本
            </span>
          )}
        </div>
      )}
    </div>
  );
}
