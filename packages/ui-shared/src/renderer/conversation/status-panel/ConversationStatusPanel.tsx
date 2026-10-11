// 会话状态面板（Z-95 / Z-17）：会话列右上区域的会话状态一览。
//
// 结构权威：
//   * Z-17：有内容才渲染（无数据返回 null，不摆假面板）；auto 模式下容器 <1280px 出 mini 胶囊、
//     ≥1280px 出完整面板；Git/Plan 子块默认展开、Agents 默认收起；面板内状态只存组件 state
//     （Z-17 持久化口径「pane 内状态」+ D-14 渲染端禁浏览器存储——不落盘）。
//   * Z-95：容器 `rounded-2xl border bg-popover shadow-md`，展开态 `max-h-[min(64dvh,32rem)] w-80`；
//     子块头部 h-8（标题 + 右侧计数），展开箭头悬停才显现；mini 胶囊 max-h 8.5、宽 ≤320，
//     内容走兜底链（status-panel-model.capsuleEntryOf），点击胶囊切回展开态。
//   * 断点用 CSS 容器查询（挂载点须有 `@container` 祖先，见 seat 的包裹行），不做 JS 测量。
//
// 实现选型：变体菜单**手写**（Trigger + role=menu 浮层 + Escape/外点关闭），不经 radix
// DropdownMenu —— 本文件落地时 `components/ui/*` 内部的 `@/lib/utils` 在两壳 vitest 均无
// alias，引入即破坏测试面（Z3-04 起两壳 vitest 已补 alias，composer-controls 已改用原语；
// 本组件维持手写实现，不动已验证的交互与测试）。
//
// 扩展缝：子块 = STATUS_SECTIONS 注册表 + hasSectionData/sectionBadge + 本文件的 body 分支；
// 数据源到位后（todo/goal/terminals/workflows）加注册行即可，见 status-panel-model.ts 文件头。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ActivityIcon, BotIcon, ChevronRightIcon, EllipsisIcon, GitBranchIcon, ListTodoIcon } from 'lucide-react';
import type { AppStore } from '../../store.js';
import type { StatusVariant } from './status-panel-model.js';
import {
  activeSections,
  capsuleEntryOf,
  capsuleIconKindOf,
  collectStatusData,
  sectionBadge,
  type CapsuleEntry,
  type StatusData,
  type StatusSectionKey,
  type StatusSectionMeta,
} from './status-panel-model.js';

/** 面板 body 单类清单条数上限（超出收进「其余 N 条」，防止极端会话撑爆面板） */
const MAX_LIST_ROWS = 8;

export interface ConversationStatusPanelProps {
  /** 会话数据源（壳注入；不抓全局单例，测试才可注入假 store） */
  readonly store: AppStore;
  readonly sessionId: string;
  /**
   * 变体偏好（Z-17 的「pane 内状态」，默认 auto）。
   * 注意：面板自身也维护同一份偏好（菜单可改，仅内存）；显式传入 = 壳固定形态（测试/分屏用）。
   */
  readonly variant?: StatusVariant;
  /**
   * Z2-08 轻联动（可选）：Agents 子块展开态底部的「在右栏打开」入口。壳注入（右栏开合是壳的
   * 帧/布局职责，共享面板不抓宿主上下文）；缺省 = 不渲染入口（不摆死按钮）。
   */
  readonly onOpenTasksPane?: () => void;
}

export function ConversationStatusPanel(props: ConversationStatusPanelProps): ReactNode {
  const { store, sessionId } = props;
  // 视图缓存（views）不在 AppState 里，但每次写入都会 bump rev 产生新 state 引用 ——
  // 订阅 getState 即可在 plan/changeReview/tasks 任何一处到达时重渲。
  useSyncExternalStore(store.subscribe, store.getState);
  const [preferred, setPreferred] = useState<StatusVariant>('auto');
  const [capsuleOpen, setCapsuleOpen] = useState(false);
  // 子块展开覆盖（用户点过头部才记；未点过跟随注册表默认。组件内 state，不落盘——D-14）
  const [expandedOverride, setExpandedOverride] = useState<Partial<Record<StatusSectionKey, boolean>>>({});

  const variant = props.variant ?? preferred;
  const data = collectStatusData(store.peekStream(sessionId), store.peekViews(sessionId));
  const sections = activeSections(data);

  if (sections.length === 0) return null; // Z-17：有内容才渲染

  const preferAuto = (): void => {
    setPreferred('auto');
    setCapsuleOpen(false);
  };
  const preferCapsule = (): void => {
    setPreferred('capsule');
    setCapsuleOpen(false);
  };
  const menu = { variantNode: variant, onPreferAuto: preferAuto, onPreferCapsule: preferCapsule } as const;

  const panel = (
    <StatusPanelBody
      data={data}
      sections={sections}
      expandedOverride={expandedOverride}
      onToggleSection={(key) =>
        setExpandedOverride((current) => ({ ...current, [key]: !(current[key] ?? defaultExpandedOf(sections, key)) }))
      }
      menu={menu}
      onOpenTasksPane={props.onOpenTasksPane}
    />
  );
  const capsule = <StatusCapsule data={data} onOpen={() => setCapsuleOpen(true)} menu={menu} />;

  if (variant === 'capsule') {
    return capsuleOpen ? panel : capsule;
  }
  // auto：两种形态都渲染，容器查询决定显示哪个（jsdom 无布局，测试用 variant 显式定形态）
  return (
    <>
      <div data-testid="status-panel-auto-wide" className="hidden @min-[1280px]:block">
        {panel}
      </div>
      <div data-testid="status-panel-auto-mini" className="@min-[1280px]:hidden">
        {capsule}
      </div>
    </>
  );
}

function defaultExpandedOf(sections: readonly StatusSectionMeta[], key: StatusSectionKey): boolean {
  return sections.find((s) => s.key === key)?.defaultExpanded ?? true;
}

/**
 * 「当前是否有内容」谓词（与组件的渲染判定同一份数据口径）。
 * 壳的缺省回调据此在**无内容时返回 null** —— seat 的槽位包裹行也就整个不渲染
 * （JSX 元素在创建期不是 null，组件渲染期才返回 null，壳侧无法凭元素判空，须用本谓词）。
 */
export function statusPanelHasContent(store: AppStore, sessionId: string): boolean {
  return activeSections(collectStatusData(store.peekStream(sessionId), store.peekViews(sessionId))).length > 0;
}

// —— 完整面板（rounded-2xl border bg-popover shadow-md；展开态 max-h-[min(64dvh,32rem)] w-80） ——

interface VariantMenuState {
  readonly variantNode: StatusVariant;
  readonly onPreferAuto: () => void;
  readonly onPreferCapsule: () => void;
}

interface PanelBodyProps {
  readonly data: StatusData;
  readonly sections: readonly StatusSectionMeta[];
  readonly expandedOverride: Partial<Record<StatusSectionKey, boolean>>;
  readonly onToggleSection: (key: StatusSectionKey) => void;
  readonly menu: VariantMenuState;
  /** Z2-08：Agents 子块的「在右栏打开」入口（可选；缺省不渲染） */
  readonly onOpenTasksPane?: () => void;
}

function StatusPanelBody(props: PanelBodyProps): ReactNode {
  return (
    <div
      data-testid="conversation-status-panel-expanded"
      className="w-80 overflow-hidden rounded-2xl border border-border bg-popover text-foreground shadow-md"
    >
      {/* 右上 … 菜单（Z-95）：仅「自动展开」单选 + 「收起为胶囊」 */}
      <div className="flex h-7 flex-none items-center justify-end px-1.5">
        <StatusVariantMenu {...props.menu} />
      </div>
      <div className="max-h-[min(64dvh,32rem)] overflow-y-auto pb-1">
        {props.sections.map((section) => (
          <StatusSection
            key={section.key}
            section={section}
            data={props.data}
            expanded={props.expandedOverride[section.key] ?? section.defaultExpanded}
            onToggle={() => props.onToggleSection(section.key)}
            onOpenTasksPane={props.onOpenTasksPane}
          />
        ))}
      </div>
    </div>
  );
}

/** 变体偏好菜单：自动展开（单选）+ 收起为胶囊（手写浮层；Escape/外点关闭） */
function StatusVariantMenu(props: VariantMenuState & { readonly align?: 'start' | 'end' }): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="status-panel-menu-trigger"
        aria-label="状态面板选项"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
      >
        <EllipsisIcon className="size-3.5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="status-panel-menu"
          className={`absolute top-6 z-20 min-w-36 rounded-lg border border-border bg-popover p-1 shadow-md ${
            props.align === 'start' ? 'left-0' : 'right-0'
          }`}
        >
          <div
            role="menuitemradio"
            aria-checked={props.variantNode === 'auto'}
            data-testid="status-menu-auto"
            tabIndex={0}
            onClick={() => {
              props.onPreferAuto();
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.onPreferAuto();
                setOpen(false);
              }
            }}
            className="cursor-pointer rounded px-2 py-1 text-ui-xs text-foreground hover:bg-surface-hover"
          >
            自动展开
          </div>
          <div
            role="menuitem"
            aria-disabled={props.variantNode === 'capsule'}
            data-testid="status-menu-capsule"
            tabIndex={props.variantNode === 'capsule' ? -1 : 0}
            onClick={() => {
              if (props.variantNode === 'capsule') return;
              props.onPreferCapsule();
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (props.variantNode === 'capsule') return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.onPreferCapsule();
                setOpen(false);
              }
            }}
            className={`rounded px-2 py-1 text-ui-xs ${
              props.variantNode === 'capsule'
                ? 'cursor-default text-foreground-subtlest'
                : 'cursor-pointer text-foreground hover:bg-surface-hover'
            }`}
          >
            收起为胶囊
          </div>
        </div>
      )}
    </div>
  );
}

// —— 子块（h-8 头部：图标 + 标题 + 右侧计数 + 悬停才显现的展开箭头） ——

function StatusSection(props: {
  readonly section: StatusSectionMeta;
  readonly data: StatusData;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenTasksPane?: () => void;
}): ReactNode {
  const { section, data, expanded } = props;
  const badge = sectionBadge(data, section.key);
  return (
    <div data-testid={`status-section-${section.key}`} className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={props.onToggle}
        className="group flex h-8 w-full cursor-pointer items-center gap-1.5 px-2.5 text-left text-ui-sm text-foreground-subtle hover:text-foreground"
      >
        <SectionIcon kind={section.key} className="size-3.5 flex-none" />
        <span>{section.title}</span>
        {badge !== null && <span className="ml-auto flex-none text-ui-2xs text-foreground-subtlest">{badge}</span>}
        {/* 展开箭头：悬停/聚焦才显现；展开时转 90°（Z-93 同款交互语言） */}
        <ChevronRightIcon
          aria-hidden
          className={`size-3 flex-none opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {expanded && <div className="px-2.5 pb-2">{sectionBody(data, section.key, props.onOpenTasksPane)}</div>}
    </div>
  );
}

function SectionIcon(props: { readonly kind: StatusSectionKey; readonly className?: string }): ReactNode {
  switch (props.kind) {
    case 'git':
      return <GitBranchIcon className={props.className} aria-hidden />;
    case 'plan':
      return <ListTodoIcon className={props.className} aria-hidden />;
    case 'agents':
      return <BotIcon className={props.className} aria-hidden />;
  }
}

function sectionBody(data: StatusData, key: StatusSectionKey, onOpenTasksPane?: () => void): ReactNode {
  switch (key) {
    case 'git':
      return <GitBody data={data} />;
    case 'plan':
      return <PlanBody data={data} />;
    case 'agents':
      return <AgentsBody data={data} onOpenTasksPane={onOpenTasksPane} />;
  }
}

/** Git（会话变更）body：逐文件 +/- 行数（拟议快照现算）；脏文件标「外部改动」 */
function GitBody({ data }: { readonly data: StatusData }): ReactNode {
  const git = data.git;
  if (git === null) return null;
  const shown = git.files.slice(0, MAX_LIST_ROWS);
  return (
    <div className="flex flex-col gap-1">
      {shown.map((f) => (
        <div key={f.file} className="flex items-center gap-2 text-ui-xs">
          <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={f.file}>
            {f.file}
          </span>
          {f.dirty && <span className="flex-none text-ui-2xs text-warning">外部改动</span>}
          <span className="flex-none font-mono text-ui-2xs text-diff-added">+{f.added}</span>
          <span className="flex-none font-mono text-ui-2xs text-diff-removed">−{f.deleted}</span>
        </div>
      ))}
      {git.files.length > shown.length && (
        <div className="text-ui-2xs text-foreground-subtlest">其余 {git.files.length - shown.length} 个文件…</div>
      )}
      {git.files.length === 0 && (
        <div className="text-ui-2xs text-foreground-subtlest">仅登记外部改动，无本会话拟议变更</div>
      )}
    </div>
  );
}

/** Plan body：goal 一行 + 步骤清单（步骤只有 stepId/state——无文本是数据源事实，不编造标题） */
function PlanBody({ data }: { readonly data: StatusData }): ReactNode {
  const plan = data.plan;
  if (plan === null) return null;
  const shown = plan.steps.slice(0, MAX_LIST_ROWS);
  return (
    <div className="flex flex-col gap-1">
      {plan.goal.length > 0 && (
        <div className="text-ui-xs text-foreground" title={plan.goal}>
          {plan.goal}
        </div>
      )}
      {shown.map((s) => (
        <div key={s.stepId} className="flex items-center gap-2 text-ui-xs">
          <span
            aria-hidden
            className={`size-1.5 flex-none rounded-full ${
              s.state === 'completed' ? 'bg-success' : s.state === 'failed' ? 'bg-destructive' : 'bg-idle-task'
            }`}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-foreground-subtle" title={s.stepId}>
            {s.stepId}
          </span>
          <span
            className={`flex-none text-ui-2xs ${
              s.state === 'completed'
                ? 'text-success'
                : s.state === 'failed'
                  ? 'text-destructive'
                  : 'text-foreground-subtlest'
            }`}
          >
            {s.label}
          </span>
        </div>
      ))}
      {plan.steps.length > shown.length && (
        <div className="text-ui-2xs text-foreground-subtlest">其余 {plan.steps.length - shown.length} 个步骤…</div>
      )}
      {plan.steps.length === 0 && plan.goal.length > 0 && (
        <div className="text-ui-2xs text-foreground-subtlest">尚无步骤（仅登记了目标）</div>
      )}
    </div>
  );
}

/** Agents body：非终态任务清单（当前实现 = 后台子代理；bash 无后台模式）。
 *  Z2-08：壳注入 `onOpenTasksPane` 时在底部给「在右栏打开」入口（计数面板 → 右栏详情列表，
 *  ZCode 同构：状态面板 Agents 收起块 + side pane 承载详情）。子块头部是整行展开按钮，
 *  不能嵌套按钮 → 入口放展开态 body 底部（登记：非头部/「…」位）。 */
function AgentsBody({
  data,
  onOpenTasksPane,
}: {
  readonly data: StatusData;
  readonly onOpenTasksPane?: () => void;
}): ReactNode {
  const agents = data.agents;
  if (agents === null) return null;
  const shown = agents.active.slice(0, MAX_LIST_ROWS);
  return (
    <div className="flex flex-col gap-1">
      {shown.map((t) => (
        <div key={t.taskId} className="flex items-center gap-2 text-ui-xs">
          <span className="min-w-0 flex-1 truncate font-mono text-foreground-subtle" title={t.taskId}>
            {t.taskId}
          </span>
          {t.background && <span className="flex-none text-ui-2xs text-foreground-subtlest">后台</span>}
          <span className="flex-none text-ui-2xs text-foreground-subtlest">{t.label}</span>
        </div>
      ))}
      {agents.active.length > shown.length && (
        <div className="text-ui-2xs text-foreground-subtlest">其余 {agents.active.length - shown.length} 个任务…</div>
      )}
      {agents.active.length === 0 && (
        <div className="text-ui-2xs text-foreground-subtlest">无进行中的后台任务（终态任务 {agents.total} 个）</div>
      )}
      {onOpenTasksPane !== undefined && (
        <button
          type="button"
          data-testid="status-agents-open-pane"
          title="在右栏「后台任务」标签页查看全部任务详情"
          onClick={onOpenTasksPane}
          className="mt-0.5 flex-none cursor-pointer self-start rounded px-1 text-ui-2xs text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
        >
          在右栏打开 ↗
        </button>
      )}
    </div>
  );
}

// —— mini 胶囊（Z-95：max-h-8.5、宽 ≤320；点击切回展开态） ——

function StatusCapsule(props: {
  readonly data: StatusData;
  readonly onOpen: () => void;
  readonly menu: VariantMenuState;
}): ReactNode {
  const entry = capsuleEntryOf(props.data);
  if (entry === null) return null; // 兜底链全空 → 无胶囊（面板本体也不渲染，外层已保证）
  return (
    <div
      data-testid="conversation-status-panel-capsule"
      className="group relative flex max-w-80 items-center gap-0.5 rounded-full border border-border bg-popover py-0.5 pl-2 pr-0.5 shadow-md"
    >
      <button
        type="button"
        data-testid="status-capsule-expand"
        title="展开状态面板"
        onClick={props.onOpen}
        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full text-left text-ui-xs text-foreground-subtle hover:text-foreground"
      >
        <CapsuleIcon data={props.data} className="size-3.5 flex-none text-foreground-subtlest" />
        <CapsuleText entry={entry} />
      </button>
      {/* 胶囊上的 … 菜单：悬停/聚焦才显现（否则胶囊态无法回到「自动展开」） */}
      <div className="opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
        <StatusVariantMenu {...props.menu} align="end" />
      </div>
    </div>
  );
}

function CapsuleIcon(props: { readonly data: StatusData; readonly className?: string }): ReactNode {
  switch (capsuleIconKindOf(props.data)) {
    case 'plan':
      return <ListTodoIcon className={props.className} aria-hidden />;
    case 'git':
      return <GitBranchIcon className={props.className} aria-hidden />;
    case 'agents':
      return <BotIcon className={props.className} aria-hidden />;
    case 'activity':
      return <ActivityIcon className={props.className} aria-hidden />;
  }
}

function CapsuleText({ entry }: { readonly entry: CapsuleEntry }): ReactNode {
  switch (entry.kind) {
    case 'plan-goal':
      return (
        <span className="min-w-0 flex-1 truncate" title={entry.text}>
          {entry.text}
        </span>
      );
    case 'git-changes':
      return (
        <span className="flex-none whitespace-nowrap font-mono">
          <span className="text-diff-added">+{entry.added}</span>{' '}
          <span className="text-diff-removed">−{entry.deleted}</span>
        </span>
      );
    case 'plan-progress':
      return (
        <span className="flex-none whitespace-nowrap font-mono">
          {entry.completed}/{entry.total}
        </span>
      );
    case 'running': {
      const bits: string[] = [];
      if (entry.runningTurns > 0) bits.push(`运行 ${entry.runningTurns}`);
      if (entry.runningTasks > 0) bits.push(`任务 ${entry.runningTasks}`);
      return <span className="flex-none whitespace-nowrap">{bits.join(' · ')}</span>;
    }
  }
}
