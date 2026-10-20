// 侧栏外壳（依据 docs/refs/refs-zcode-layout.md Z-05～Z-07 + Z-16 槽位表；席位模型沿用 refs-deepseek-harness.md D-21～D-25）：
//   Z-16 #0：aside **无品牌行**——品牌与折叠钮在左上浮层（FrameTopOverlay），入口不丢；
//            aside 顶部第一个槽位就是「新建任务」（ZCode 实测 y=66）。
//   D-21 新会话作用域：显式指定 → 当前会话所属 → 最近活跃 → 空白（见 new-session-scope.ts）
//   Z-06 折叠形态：折叠后只剩 4px，内容 opacity-0 + pointer-events-none（只隐藏不卸载、无图标轨道）
//   D-23 区域席位：`sidebar.workspaces`（会话列表）+ 底部固定 `sidebar.settings`
//   Z-07/Z-16 分区顺序：New Task（#1）→ 搜索（#2）→ 自动化（#3）→ 插件市场（#4，占位）
//            → 会话区域（#5～#9）→ Footer（#10 固定账号槽 + 设置席位）
//   Z-16 槽位先行（用户拍板 2026-10-12）：ZCode 有的槽位一律摆出来；缺功能的 =
//   disabled + title 悬停说明 + data-placeholder 旗标（红线⑩），DOM 与真入口可 machine 分辨。
//   D-24 滚动条可供性：指针不在列内即静默，离开后滞留 2 秒；未溢出则本就不画（见 scroll-affordance.ts）
//   D-25 版本徐标：aside 品牌行移除后落到 footer 末行（见 brand.ts；无版本元数据不画）。
// 本组件**自包含**：不 import App / layout / slots / app-shared；
// 装配（席位注入、数据接线）由接线阶段传入 props 完成（席位为渲染函数，非全局注册表）。
import { useRef } from 'react';
import { ClockIcon, PlusIcon, PuzzleIcon, SearchIcon } from 'lucide-react';
import { SIDEBAR_DEFAULT_WIDTH } from './geometry.js';
import { resolveBuildVersion } from './brand.js';
import { resolveNewSessionScope, type NewSessionScope, type NewSessionScopeInput } from './new-session-scope.js';
import { sidebarStateClasses } from './collapse.js';
import { useCollapse } from './use-collapse.js';
import { useScrollAffordance } from './use-scroll-affordance.js';
import { DEFAULT_SIDEBAR_LABELS, type SidebarLabels } from './labels.js';
import { SessionBrowser, type SessionRowDrag, type WorkspacesOwnerProps } from './SessionBrowser.js';
import type { ProjectGroupInput } from './project-groups.js';
import type { RowMenuCallbacks } from './session-row-menu.js';
import type { SidebarSessionItem } from './session-items.js';

/** 底部设置席位属主事实（D-23）：只需宽窄态 */
export interface SettingsOwnerProps {
  /** 是否按展开形态渲染（Z-06：折叠态内容只隐藏不卸载，始终给 true） */
  wide: boolean;
}

/** 席位渲染函数（缺省即用外壳回落实现） */
export interface SidebarSeats {
  /** D-23 区域席位；缺省用 SessionBrowser（会话列表） */
  renderWorkspaces?: ((owner: WorkspacesOwnerProps) => React.ReactNode) | undefined;
  /** D-23 底部设置席位；缺省不渲染（没有占用方就不摆假入口） */
  renderSettings?: ((owner: SettingsOwnerProps) => React.ReactNode) | undefined;
  /**
   * Z-16 #10 账号槽「状态行」席位：注入后在账号名**下方**渲染（如连接状态角标）。
   * 缺省不画（不摆假状态）。账号槽本身仍由 `placeholders` 旗标决定是否在场。
   */
  renderAccountStatus?: (() => React.ReactNode) | undefined;
}

export interface SidebarRootProps extends SidebarSeats {
  /** 是否折叠（Z-06：折叠后只剩 4px，内容只隐藏不卸载、无图标轨道） */
  collapsed: boolean;
  /** 展开宽度（Z-05 264～容器 50%；缺省 264） */
  width?: number | undefined;
  /** 收起/展开切换（布局 owner 的动作；Z-16 #0 起折叠入口外置到左上浮层，本回调仅供区域席位 expandSidebar 回落） */
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
   * 搜索入口（Z-16 #2，原「命令中心」）：点击打开既有命令面板。
   * 不传则不渲染该入口（硬约束：界面上不摆点击无效的假入口）——
   * 装配层经覆层链路（shell-overlays 的 setOverlay('palette', true)）注入，本组件不 import App 私有状态。
   */
  onOpenCommandPalette?: (() => void) | undefined;
  /** 搜索快捷键提示（缺省 Ctrl+K，与 App 的 Ctrl+K 唤出链路一致） */
  commandPaletteHint?: string | undefined;
  /**
   * Z-07 #3 / Z-16 #3：「自动化」真入口（cron 右栏 tab；桌面主进程读通道）。
   * 不传但 `placeholders=true` 时，渲染 disabled 占位槽（web：无本地 cron 通道）。
   */
  onOpenAutomations?: (() => void) | undefined;
  /**
   * Z-16 槽位先行（用户拍板 2026-10-12）：置 true 渲染「自动化（无通道时）/ 插件市场」
   * disabled 占位槽与「固定账号槽」（title 悬停说明，data-placeholder 可辨）。
   * 缺省 false = 完全不画——不把占位强加给不想要它的宿主/测试。
   */
  placeholders?: boolean | undefined;
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
  // —— P0-3b 侧栏项目轻量版（透传给缺省区域席位 SessionBrowser；语义见其 props 注释） ——
  /** 显式项目表（projects.json 投影）；缺省 / 空数组 = 既有分组（web 行为不变） */
  projects?: readonly ProjectGroupInput[] | undefined;
  /** 项目区头「添加项目」真动作；缺省 = disabled 占位（红线⑩） */
  onAddProject?: (() => void) | undefined;
  /** 组头「移出项目」真动作；缺省 = disabled 占位 */
  onRemoveProject?: ((cwd: string) => void) | undefined;
  /** Z-48 #2：显式项目组头 hover「在此项目新建会话」真动作（带 cwd）；缺省 = 不渲染该钮 */
  onNewSessionInProject?: ((cwd: string) => void) | undefined;
  /** Z-49：删除会话真执行（软删）；缺省 = 行菜单不出现「删除」。确认对话框由 SessionBrowser 承载 */
  onDeleteSession?: ((id: string) => Promise<void> | void) | undefined;
  /** U1 复审 P2：确认框 live running 复查判据，透传 SessionBrowser（ac0df60 补链）。 */
  isSessionRunning?: ((id: string) => boolean) | undefined;
  /** 任务区头「新建任务」真动作；缺省 = 不渲染该钮 */
  onNewTask?: (() => void) | undefined;
  /**
   * U2 批D（D7）：项目表读取失败提示（透传 SessionBrowser 行内 Alert）；null/缺省 = 不渲染。
   */
  projectsError?: string | null | undefined;
  /** 失败条「重试」动作；缺省 = 不渲染重试钮 */
  onRetryProjects?: (() => void) | undefined;
  /** 失败条「忽略」；缺省 = 不渲染关闭钮 */
  onDismissProjectsError?: (() => void) | undefined;
  /** 文案覆盖（缺省中文） */
  labels?: Partial<SidebarLabels> | undefined;
  className?: string | undefined;
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
  const { contentWidth, reducedMotion } = useCollapse({
    collapsed: props.collapsed,
    width: props.width ?? SIDEBAR_DEFAULT_WIDTH,
  });
  const column = useRef<HTMLDivElement>(null);
  const affordance = useScrollAffordance(column);
  const quietBars = affordance.status === 'quiet';
  const classes = [
    'h2-sidebar',
    // Z-06 折叠形态：内容只隐藏不卸载（不可见亦不可点），无图标轨道
    ...(props.collapsed ? ['opacity-0', 'pointer-events-none'] : []),
    // Z-08：宽度由容器过渡（app-frame.css），内容透明度跟随折叠 200ms
    'transition-opacity',
    'duration-200',
    ...sidebarStateClasses({ quietBars, reducedMotion }),
    ...(props.className !== undefined ? [props.className] : []),
  ].join(' ');
  const version = props.buildVersion ?? resolveBuildVersion(props.buildEnv ?? readBuildEnv());

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
        // P0-3b：项目表与组头动作透传（缺省全部不传 = SessionBrowser 既有行为逐字节不变）
        {...(props.projects !== undefined ? { projects: props.projects } : {})}
        {...(props.onAddProject !== undefined ? { onAddProject: props.onAddProject } : {})}
        {...(props.onRemoveProject !== undefined ? { onRemoveProject: props.onRemoveProject } : {})}
        {...(props.onNewSessionInProject !== undefined ? { onNewSessionInProject: props.onNewSessionInProject } : {})}
        {...(props.onDeleteSession !== undefined ? { onDeleteSession: props.onDeleteSession } : {})}
        {...(props.isSessionRunning !== undefined ? { isSessionRunning: props.isSessionRunning } : {})}
        {...(props.onNewTask !== undefined ? { onNewTask: props.onNewTask } : {})}
        {...(props.projectsError !== undefined ? { projectsError: props.projectsError } : {})}
        {...(props.onRetryProjects !== undefined ? { onRetryProjects: props.onRetryProjects } : {})}
        {...(props.onDismissProjectsError !== undefined
          ? { onDismissProjectsError: props.onDismissProjectsError }
          : {})}
      />
    ));

  return (
    <div
      ref={column}
      className={classes}
      data-testid="sidebar-root"
      data-collapsed={props.collapsed ? 'true' : 'false'}
      data-scroll-bars={affordance.status}
      style={{ width: contentWidth }}
      role="complementary"
      aria-label={labels.sidebar}
      {...affordance.handlers}
    >
      {/* Z-16 #0：品牌行整行移除（品牌与折叠钮在左上浮层 FrameTopOverlay，入口不丢）。
          Z-16 #1：aside 顶部第一槽 = 新建任务。D-21：作用域解析在点击时做（数据是最新的）。
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
          <PlusIcon size={16} />
        </span>
        <span className="h2-sidebar-new-label">{labels.newSession}</span>
        {props.newSessionShortcut !== undefined && (
          <span className="h2-sidebar-new-hint" aria-hidden="true">
            {props.newSessionShortcut}
          </span>
        )}
      </button>

      {/* Z-16 #2：搜索入口（行为仍 = 打开命令面板）；无回调则不渲染（不摆假入口） */}
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
            <SearchIcon size={16} />
          </span>
          <span className="h2-sidebar-command-label">{labels.commandCenter}</span>
          <span className="h2-sidebar-command-hint" aria-hidden="true">
            {props.commandPaletteHint ?? labels.commandCenterHint}
          </span>
        </button>
      )}

      {/* Z-16 #3：「自动化」两壳都摆——桌面传 onOpenAutomations = 真入口；
          web 无通道但 placeholders=true = disabled 占位槽（title 悬停说明，data-placeholder 可辨）。 */}
      {props.onOpenAutomations !== undefined ? (
        <button
          type="button"
          className="h2-sidebar-command"
          data-testid="sidebar-automation-entry"
          aria-label={labels.automationEntry}
          title={labels.automationEntry}
          onClick={props.onOpenAutomations}
        >
          <span className="h2-sidebar-command-icon" aria-hidden="true">
            <ClockIcon size={16} />
          </span>
          <span className="h2-sidebar-command-label">{labels.automationEntry}</span>
        </button>
      ) : (
        props.placeholders === true && (
          <button
            type="button"
            className="h2-sidebar-command h2-sidebar-placeholder"
            data-testid="sidebar-automation-entry"
            data-placeholder="true"
            aria-label={labels.automationEntry}
            title={labels.automationTodo}
            disabled
          >
            <span className="h2-sidebar-command-icon" aria-hidden="true">
              <ClockIcon size={16} />
            </span>
            <span className="h2-sidebar-command-label">{labels.automationEntry}</span>
          </button>
        )
      )}

      {/* Z-16 #4：插件市场诚实占位（用户拍板不开发）。disabled + data-placeholder + 悬停说明——
          与真入口在 DOM 上可分辨；不摆可点的假功能。placeholders 旗标为真才渲染。 */}
      {props.placeholders === true && (
        <button
          type="button"
          className="h2-sidebar-command h2-sidebar-placeholder"
          data-testid="sidebar-plugin-market-placeholder"
          data-placeholder="true"
          aria-label={labels.pluginMarketTodo}
          title={labels.pluginMarketTodo}
          disabled
        >
          <span className="h2-sidebar-command-icon" aria-hidden="true">
            <PuzzleIcon size={16} />
          </span>
          <span className="h2-sidebar-command-label">插件市场</span>
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

      {/* D-23：底部固定区 = Z-16 #10 账号槽（左） + 设置席位（右）。
          账号槽 = 用户拍板（2026-10-11）的**固定显示**：196×32 与 ZCode 同形状、32px 头像圆槽 +
          固定名称「本地用户」——视觉如实；无菜单动作 → disabled + title + data-placeholder 旗标。
          替换 P0-3a 的窄占位实现。D-25：版本徐标随品牌行下移到 footer 末行（无元数据不画）。 */}
      <div className="h2-sidebar-foot" data-testid="sidebar-foot">
        <div className="h2-sidebar-foot-row">
          {props.placeholders === true && (
            <button
              type="button"
              className="h2-sidebar-account h2-sidebar-placeholder"
              data-testid="sidebar-account-slot"
              data-placeholder="true"
              aria-label={labels.accountName}
              title={labels.accountTodo}
              disabled
            >
              <span className="h2-sidebar-account-avatar" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" focusable="false">
                  <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M4.5 20c1.2-3.4 4-5.2 7.5-5.2s6.3 1.8 7.5 5.2"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              {/* 账号块两行：上行「用户名」、下行「状态行」（renderAccountStatus 席位，缺省不画）。
                  Z-16 #10 校正：状态角标从右侧设置区移入本块（用户 2026-10-13 拍板）。 */}
              <span className="h2-sidebar-account-body">
                <span className="h2-sidebar-account-label">{labels.accountName}</span>
                {props.renderAccountStatus !== undefined && (
                  <span className="h2-sidebar-account-status" data-testid="sidebar-account-status">
                    {props.renderAccountStatus()}
                  </span>
                )}
              </span>
            </button>
          )}
          <div className="h2-sidebar-settings-area">
            {props.renderSettings !== undefined ? props.renderSettings({ wide: true }) : null}
          </div>
        </div>
        {version !== undefined && (
          <span className="h2-sidebar-version" data-testid="sidebar-version-badge">
            {version}
          </span>
        )}
      </div>
    </div>
  );
}
