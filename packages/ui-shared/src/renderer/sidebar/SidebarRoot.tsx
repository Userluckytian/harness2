// 侧栏外壳（依据 docs/refs/refs-zcode-layout.md Z-05～Z-07；席位模型沿用 refs-deepseek-harness.md D-20～D-25）：
//   D-20 品牌席位：`sidebar.brand.mark` / `sidebar.brand.name` 两个 single 席位（可被品牌包接管）
//   D-21 新会话作用域：显式指定 → 当前会话所属 → 最近活跃 → 空白（见 new-session-scope.ts）
//   Z-06 折叠形态：折叠后只剩 4px，内容 opacity-0 + pointer-events-none（只隐藏不卸载、无图标轨道）
//   D-23 区域席位：`sidebar.workspaces`（会话列表）+ 底部固定 `sidebar.settings`
//   Z-07 分区顺序：品牌行 → New Task（分区 1）→ 命令中心入口（分区 2）→ 会话区域（分区 7/8）→ Footer（分区 9）
//   Z-07 缺前置分区（Automations / Plugin Store / 任务工具栏 / Pinned / Projects / 文件树）本壳不摆假入口
//   D-24 滚动条可供性：指针不在列内即静默，离开后滞留 2 秒；未溢出则本就不画（见 scroll-affordance.ts）
//   D-25 版本徐标：品牌行下方 `version[-commit][-dirty]`（见 brand.ts）
// 本组件**自包含**：不 import App / layout / slots / app-shared；
// 装配（席位注入、数据接线）由接线阶段传入 props 完成（席位为渲染函数，非全局注册表）。
import { useRef } from 'react';
import { SIDEBAR_DEFAULT_WIDTH } from './geometry.js';
import { resolveBuildVersion } from './brand.js';
import { resolveNewSessionScope, type NewSessionScope, type NewSessionScopeInput } from './new-session-scope.js';
import { sidebarStateClasses } from './collapse.js';
import { useCollapse } from './use-collapse.js';
import { useScrollAffordance } from './use-scroll-affordance.js';
import { DEFAULT_SIDEBAR_LABELS, type SidebarLabels } from './labels.js';
import { SessionBrowser, type SessionRowDrag, type WorkspacesOwnerProps } from './SessionBrowser.js';
import type { RowMenuCallbacks } from './session-row-menu.js';
import type { SidebarSessionItem } from './session-items.js';

/** 品牌标记席位属主事实（D-20）：只要一个方形边长 */
export interface BrandMarkOwnerProps {
  /** 请求的方形边长（px） */
  size: number;
}

/** 品牌名席位属主事实（D-20）：版本徐标文案由外壳解析后交给占用方（D-25） */
export interface BrandNameOwnerProps {
  /** 构建标签文案；无版本元数据时为 undefined（占用方据此不画徐标） */
  version?: string | undefined;
}

/** 底部设置席位属主事实（D-23）：只需宽窄态 */
export interface SettingsOwnerProps {
  /** 是否按展开形态渲染（Z-06：折叠态内容只隐藏不卸载，始终给 true） */
  wide: boolean;
}

/** 席位渲染函数（缺省即用外壳回落实现） */
export interface SidebarSeats {
  /** D-20 品牌标记席位；缺省用内置标记 */
  renderBrandMark?: ((owner: BrandMarkOwnerProps) => React.ReactNode) | undefined;
  /** D-20 品牌名席位；缺省用「本地构建 + 版本徐标」（D-25） */
  renderBrandName?: ((owner: BrandNameOwnerProps) => React.ReactNode) | undefined;
  /** D-23 区域席位；缺省用 SessionBrowser（会话列表） */
  renderWorkspaces?: ((owner: WorkspacesOwnerProps) => React.ReactNode) | undefined;
  /** D-23 底部设置席位；缺省不渲染（没有占用方就不摆假入口） */
  renderSettings?: ((owner: SettingsOwnerProps) => React.ReactNode) | undefined;
}

export interface SidebarRootProps extends SidebarSeats {
  /** 是否折叠（Z-06：折叠后只剩 4px，内容只隐藏不卸载、无图标轨道） */
  collapsed: boolean;
  /** 展开宽度（Z-05 264～容器 50%；缺省 264） */
  width?: number | undefined;
  /** 收起/展开切换（布局 owner 的动作，接进来即可） */
  onToggleCollapse: () => void;
  /** 新会话：外壳按 D-21 解析出作用域后回调（装配层据此建会话/开空白页） */
  onNewSession: (scope: NewSessionScope) => void;
  /** D-21 判定输入（显式指定 / 当前会话所属 / 最近活跃 / 已知集合） */
  newSessionScope?: NewSessionScopeInput | undefined;
  /** 新会话入口是否可用（装配层按连接状态给 false；缺省可用） */
  newSessionEnabled?: boolean | undefined;
  /** Z-07 #1：New Task 快捷键标注（如 'Ctrl+N'）；壳真正绑定了该键才传，缺省不画 */
  newSessionShortcut?: string | undefined;
  /**
   * 命令中心入口（Z-07 分区 2）：点击打开既有命令面板。
   * 不传则不渲染该入口（硬约束：界面上不摆点击无效的假入口）——
   * 装配层经覆层链路（shell-overlays 的 setOverlay('palette', true)）注入，本组件不 import App 私有状态。
   */
  onOpenCommandPalette?: (() => void) | undefined;
  /** 命令中心快捷键提示（缺省 Ctrl+K，与 App 的 Ctrl+K 唤出链路一致） */
  commandPaletteHint?: string | undefined;
  /** 会话行数据（默认区域席位用；给了 renderWorkspaces 则由占用方自取） */
  sessions?: readonly SidebarSessionItem[] | undefined;
  /** 已归档会话（折叠区） */
  archivedSessions?: readonly SidebarSessionItem[] | undefined;
  /** 当前会话 id（D-23 高亮） */
  selectedId?: string | null | undefined;
  /** 搜索串（受控；与 onQueryChange 同给才渲染搜索框） */
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
  /** D-25 版本徐标文案；缺省从宿主环境变量（DSH_CLIENT_*）解析，取不到就不显示徐标 */
  buildVersion?: string | undefined;
  /** 构建期环境表（默认读 globalThis.process.env；渲染进程通常由装配层显式传入） */
  buildEnv?: Record<string, string | undefined> | undefined;
  /** Z2-06：会话行拖拽（把会话拖进主区分屏）；缺省不传 = 行不可拖 */
  sessionRowDrag?: SessionRowDrag | undefined;
  /** Z8-1：Pinned 行的「取消置顶」回调；缺省不传 = 不渲染该按钮（不摆无效入口） */
  onTogglePin?: ((id: string, pinned: boolean) => void) | undefined;
  /**
   * P0-2（Z-10）右键菜单动作（壳注入；缺项 = 该项不渲染）。重命名对话框由
   * SessionBrowser 承载，提交经 `onSubmitRename`（壳接 controller.renameSession）。
   */
  rowMenu?: RowMenuCallbacks | undefined;
  /** P0-2：重命名提交（缺省 = 菜单不出现「重命名」项） */
  onSubmitRename?: ((id: string, title: string) => Promise<void> | void) | undefined;
  /** 文案覆盖（缺省中文） */
  labels?: Partial<SidebarLabels> | undefined;
  className?: string | undefined;
}

/** 内置品牌标记（鱼形轮廓的极简替代；品牌包可整只替换该席位） */
function FallbackBrandMark({ size }: BrandMarkOwnerProps): React.ReactNode {
  return (
    <svg
      className="h2-sidebar-mark-svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 12c3.2-4.2 7.2-6.3 12-6.3 2.6 0 4.9.7 6 1.9-1.5.9-2.4 2.2-2.7 4.4-.3 2.2.4 3.9 2.7 4.6-1.1 1.2-3.4 1.9-6 1.9-4.8 0-8.8-2.1-12-6.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 宿主环境变量表（浏览器渲染进程里 process 不存在 → 空表，徐标自然不显示） */
function readBuildEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/** 缺省无操作（未接线的席位上不让点击炸掉） */
function noop(): void {}

/**
 * 渲染侧栏外壳。
 * @param props - 宽窄态、布局动作、席位渲染函数与行数据。
 * @returns 侧栏列元素。
 */
export function SidebarRoot(props: SidebarRootProps): React.ReactNode {
  const labels: SidebarLabels = { ...DEFAULT_SIDEBAR_LABELS, ...props.labels };
  const { collapsed, contentWidth, reducedMotion } = useCollapse({
    collapsed: props.collapsed,
    width: props.width ?? SIDEBAR_DEFAULT_WIDTH,
  });
  const column = useRef<HTMLDivElement>(null);
  const affordance = useScrollAffordance(column);
  const quietBars = affordance.status === 'quiet';
  const classes = [
    'h2-sidebar',
    // Z-06 折叠形态：内容只隐藏不卸载（不可见亦不可点），无图标轨道
    ...(collapsed ? ['opacity-0', 'pointer-events-none'] : []),
    // Z-08：宽度由容器过渡（app-frame.css），内容透明度跟随折叠 200ms
    'transition-opacity',
    'duration-200',
    ...sidebarStateClasses({ quietBars, reducedMotion }),
    ...(props.className !== undefined ? [props.className] : []),
  ].join(' ');
  const version = props.buildVersion ?? resolveBuildVersion(props.buildEnv ?? readBuildEnv());

  const mark = (size: number): React.ReactNode =>
    props.renderBrandMark !== undefined ? props.renderBrandMark({ size }) : <FallbackBrandMark size={size} />;

  const brandName: React.ReactNode =
    props.renderBrandName !== undefined ? (
      props.renderBrandName({ version })
    ) : version === undefined ? (
      <span className="h2-sidebar-brand-local">{labels.brandLocalBuild}</span>
    ) : (
      <span className="h2-sidebar-brand-build">
        <span className="h2-sidebar-brand-local">{labels.brandLocalBuild}</span>
        <span className="h2-sidebar-version" data-testid="sidebar-version-badge">
          {version}
        </span>
      </span>
    );

  const startSession = (): void => {
    props.onNewSession(resolveNewSessionScope(props.newSessionScope ?? {}));
  };
  const openSession = props.onOpenSession ?? noop;
  // Z-06：折叠后没有图标轨道，区域席位始终按展开形态渲染（内容被容器裁切 + 透明）
  const workspacesSeat =
    props.renderWorkspaces ??
    ((owner: WorkspacesOwnerProps) => (
      <SessionBrowser
        {...owner}
        sessions={props.sessions ?? []}
        archived={props.archivedSessions ?? []}
        selectedId={props.selectedId ?? null}
        query={props.query}
        onQueryChange={props.onQueryChange}
        onOpenSession={openSession}
        labels={labels}
        {...(props.sessionRowDrag !== undefined ? { rowDrag: props.sessionRowDrag } : {})}
        {...(props.onTogglePin !== undefined ? { onTogglePin: props.onTogglePin } : {})}
        {...(props.rowMenu !== undefined ? { rowMenu: props.rowMenu } : {})}
        {...(props.onSubmitRename !== undefined ? { onSubmitRename: props.onSubmitRename } : {})}
      />
    ));

  return (
    <div
      ref={column}
      className={classes}
      data-testid="sidebar-root"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-scroll-bars={affordance.status}
      style={{ width: contentWidth }}
      role="complementary"
      aria-label={labels.sidebar}
      {...affordance.handlers}
    >
      <div className="h2-sidebar-brand-row">
        {/* 展开态：品牌行本身是新会话快捷入口（上游 figma 基线行为） */}
        <button
          type="button"
          className="h2-sidebar-brand"
          data-testid="sidebar-brand"
          aria-label={labels.newSessionLabel}
          onClick={startSession}
        >
          <span className="h2-sidebar-brand-mark" data-testid="sidebar-brand-mark">
            {mark(24)}
          </span>
          <span className="h2-sidebar-brand-name" data-testid="sidebar-brand-name">
            {brandName}
          </span>
        </button>
        {/* 折叠/展开的唯一入口（Z-01：入口外置到左上角浮层；本按钮是侧栏内的等价入口） */}
        <button
          type="button"
          className="h2-sidebar-toggle"
          data-testid="sidebar-toggle"
          aria-label={collapsed ? labels.expand : labels.collapse}
          title={collapsed ? labels.expand : labels.collapse}
          onClick={props.onToggleCollapse}
        >
          <span className="h2-sidebar-toggle-glyph" aria-hidden="true">
            {collapsed ? '»' : '«'}
          </span>
        </button>
      </div>

      {/* D-21：新会话按钮；作用域解析在点击时做（数据是最新的）。
          Z-07 #1：`newSessionShortcut` 由壳显式传入才画快捷键标注（壳保证真的绑定了该键，
          缺省不画 —— 不摆「显示了却按不生效」的假提示）。 */}
      <button
        type="button"
        className="h2-sidebar-new"
        data-testid="sidebar-new-session"
        aria-label={labels.newSessionLabel}
        title={
          props.newSessionShortcut !== undefined
            ? `${labels.newSessionLabel}（${props.newSessionShortcut}）`
            : labels.newSessionLabel
        }
        disabled={props.newSessionEnabled === false}
        onClick={startSession}
      >
        <span className="h2-sidebar-new-icon" aria-hidden="true">
          ＋
        </span>
        <span className="h2-sidebar-new-label">{labels.newSession}</span>
        {props.newSessionShortcut !== undefined && (
          <span className="h2-sidebar-new-hint" aria-hidden="true">
            {props.newSessionShortcut}
          </span>
        )}
      </button>

      {/* Z-07 分区 2：命令中心入口（搜索图标 + 快捷键）；无回调则不渲染（不摆假入口） */}
      {props.onOpenCommandPalette !== undefined && (
        <button
          type="button"
          className="h2-sidebar-command"
          data-testid="sidebar-command-center"
          aria-label={labels.commandCenterLabel}
          title={`${labels.commandCenterLabel}（${props.commandPaletteHint ?? labels.commandCenterHint}）`}
          onClick={props.onOpenCommandPalette}
        >
          <span className="h2-sidebar-command-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" focusable="false">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="h2-sidebar-command-label">{labels.commandCenter}</span>
          <span className="h2-sidebar-command-hint" aria-hidden="true">
            {props.commandPaletteHint ?? labels.commandCenterHint}
          </span>
        </button>
      )}

      {/* D-23：区域席位（会话列表）；Z-06 折叠态无图标轨道，始终按展开形态渲染 */}
      <div className="h2-sidebar-region-area" data-testid="sidebar-region-area">
        {workspacesSeat({
          wide: true,
          expandSidebar: () => {
            if (props.collapsed) props.onToggleCollapse();
          },
          registerScrollRegion: affordance.registerRegion,
          scrollBars: affordance.status,
        })}
      </div>

      {/* D-23：底部固定设置席位；没有占用方就什么都不渲染 */}
      <div className="h2-sidebar-foot" data-testid="sidebar-foot">
        <div className="h2-sidebar-settings-area">
          {props.renderSettings !== undefined ? props.renderSettings({ wide: true }) : null}
        </div>
      </div>
    </div>
  );
}
