// 右栏（Side Pane）标签体系纯逻辑（Z2-04 / Z-13 / Z-14）。
//
// 行为依据 refs-zcode-layout.md：
//   - Z-13：右栏默认收起且**默认零 tab**；无可见 tab 时显示「打开标签页」加号启动器；
//     状态存**内存模块级 Map**（LRU 上限 50，重启不保留，不写任何浏览器存储，D-14）。
//   - Z-14：tab 全部**按需出现**（启动器 / 路由触发），可关闭、可拖拽排序、可横向滚动；
//     溢出常量 tab 最小宽 60px、gap 4px。
//
// 边界：本模块是纯函数集合 —— 每个 mutation 收 immutable Map、返回新 Map（无变化时返回**同一
// 引用**，调用方据此免渲染）；不含 React、不含计时、不含浏览器 API。React 桥（useSyncExternalStore
// 的单例 store）在 ./side-pane-store.tsx，桌面/未来 web 各自只做渲染接线。

/**
 * Z-14 `model-trajectory:{taskId}` 口径：轨迹 tab 的 id 前缀（后缀 = 会话 id）。
 * Z2-05：trajectory 不再是主视图（Z-16 主区无视图环），而是右栏 tab——
 * id 对齐 ZCode 的 `model-trajectory:{taskId}`（我们的任务标识 = 会话 id）。
 */
export const MODEL_TRAJECTORY_TAB_PREFIX = 'model-trajectory:';

/** 轨迹 tab id（Z-14 语义 id：`model-trajectory:{sessionId}`） */
export type TrajectoryTabId = `${typeof MODEL_TRAJECTORY_TAB_PREFIX}${string}`;

/** 由会话 id 折出轨迹 tab id（Z-14：每会话至多一个轨迹 tab） */
export function trajectoryTabId(sessionId: string): TrajectoryTabId {
  return `${MODEL_TRAJECTORY_TAB_PREFIX}${sessionId}`;
}

/** 轨迹 tab id → 会话 id（非轨迹 tab → null；不猜） */
export function trajectoryTabSessionId(id: SidePaneTabId): string | null {
  return id.startsWith(MODEL_TRAJECTORY_TAB_PREFIX) ? id.slice(MODEL_TRAJECTORY_TAB_PREFIX.length) : null;
}

/** 右栏 tab 类型：静态面板 id + 按会话解析的轨迹 tab（Z-14 `model-trajectory:{sessionId}`）。
 *  Z2-08：`background-tasks`（后台任务）= 固定 id、跨会话聚合（对齐 approvals 的全局面板口径），
 *  不引入 composite id —— 任务列表不随选中会话变化，无需按会话分桶。
 *  P0-3a：`automations`（自动化/cron 任务）= 同为固定 id、跨会话聚合（读本地 jobs.json 的只读列表，
 *  不随选中会话变化）；数据通道只有桌面有（主进程 fs），web 无 → web 白名单不列（红线⑩）。 */
export type SidePaneTabId =
  | 'plan'
  | 'tasks'
  | 'background-tasks'
  | 'automations'
  | 'approvals'
  | 'changes'
  | 'workspace'
  | 'file'
  | 'code-viewer'
  | 'config'
  | TrajectoryTabId;

export interface SidePaneTabDescriptor {
  readonly id: SidePaneTabId;
  readonly label: string;
}

/** 静态面板 tab 的展示目录（顺序 = Z-14 表意上的固定列举序，与打开顺序无关）；
 *  轨迹 tab 不在此列 —— 它的 id 按会话动态拼装，标签由 `sidePaneTabLabel` 按前缀识别。 */
export const SIDE_PANE_TABS: readonly SidePaneTabDescriptor[] = Object.freeze([
  { id: 'plan', label: '计划' },
  { id: 'tasks', label: '任务' },
  { id: 'background-tasks', label: '后台任务' },
  { id: 'automations', label: '自动化' },
  { id: 'approvals', label: '审批' },
  { id: 'changes', label: '变更' },
  { id: 'workspace', label: '工作区' },
  { id: 'file', label: '文件' },
  { id: 'code-viewer', label: '代码查看器' },
  { id: 'config', label: '配置' },
]) as readonly SidePaneTabDescriptor[];

/**
 * 加号启动器清单（对齐 ZCode `resolveOpenTabLauncherItemIds` 只列**可从菜单打开**的类型）：
 * 「文件」不在其中 —— 它只由 D-86 ① `openFile` 路由按需打开（ZCode 的 code-viewer 同款语义：
 * 打开文件才出现，加号菜单不列）。差异已在 Z2-04 报告登记：ZCode 启动器列的是
 * browser/git/terminal/developer-tools 等我们没有的面板，我们按实际拥有的列。
 * Z10-7：「代码查看器」（`code-viewer`）同样**不在**加号菜单 —— Z-14 的 `code-viewer` 入口是
 * 「打开文件/预览」（变更面板点文件名），不是启动器项；与 ZCode 一致（`resolveOpenTabLauncherItemIds`
 * 不含 code-viewer）。按需打开见桌面/web SidePanel 的 `onOpenFile` 路由。
 * Z2-05 新增「模型轨迹」项（ZCode 任务右键「查看 Model Trajectory」的等价入口）：
 * 启动器 item id 是**类型标记** `'model-trajectory'`，打开时经 `sidePaneOpenTarget`
 * 按当前会话解析成 `model-trajectory:{sessionId}` 后入列。
 * Z2-08 新增「后台任务」项（ZCode bash-output 的按需语义）：项**常列**（保留可发现性），
 * 可用性由宿主按「是否存在后台任务」控制（无任务禁用 + title 说明，见桌面 SidePanel）。
 */
export type SidePaneLauncherItemId = SidePaneTabId | 'model-trajectory';

export const SIDE_PANE_LAUNCHER_ITEM_IDS: readonly SidePaneLauncherItemId[] = Object.freeze([
  'plan',
  'tasks',
  'background-tasks',
  'automations',
  'approvals',
  'changes',
  'workspace',
  'config',
  'model-trajectory',
]);

/** 启动器项 → 实际打开的 tab id：「模型轨迹」按会话解析，其余原样 */
export function sidePaneOpenTarget(itemId: SidePaneLauncherItemId, sessionId: string): SidePaneTabId {
  return itemId === 'model-trajectory' ? trajectoryTabId(sessionId) : itemId;
}

/**
 * 零 tab 启动器卡片的目标（Z-13；审计形态「打开标签页」+ 卡片 156×88）。
 * - `tab`：打开启动器项对应的 tab（经 `sidePaneOpenTarget` 解析，与 + 菜单同一入口）；
 * - `terminal`：**跨 surface** 真动作 —— 终端在**底部 dock**（已实现），不另造右栏终端挂载。
 */
export type SidePaneLauncherCardTarget =
  { readonly kind: 'tab'; readonly item: SidePaneLauncherItemId } | { readonly kind: 'terminal' };

export interface SidePaneLauncherCard {
  /** 稳定 id（DOM 的 `data-launcher-card`；测试与图标映射用它，不用文案） */
  readonly id: string;
  readonly label: string;
  /** 一行说明（卡片副文案；诚实描述动作落点，不承诺不存在的面板） */
  readonly hint: string;
  readonly target: SidePaneLauncherCardTarget;
}

/**
 * 零 tab 启动器卡片清单（Z-13）。ZCode 启动器为「辅助对话 / 审查 / 终端」三卡，我们**只摆能
 * 诚实兑现**的目标：
 *   - 审查 → 我们已有的**变更** pane（`changes`，真）；
 *   - 终端 → **底部 dock** 的真开关（跨 surface；不为右栏再造第二套终端，见交付说明）；
 *   - 计划 → 我们已有的计划 pane（`plan`，真）—— ZCode 第三卡「辅助对话」我们**无对应能力**，
 *     按红线⑩**不摆假卡**；用一张真卡补足三卡形态（取舍见报告）。
 * ZCode 启动器的「浏览器 / 开发者工具」同样无对应能力 → 不摆卡（不摆 disabled 假入口）。
 * 宿主另渲染「更多标签页」菜单列出全部白名单项（保住其余 tab 的可达性）。
 */
export const SIDE_PANE_LAUNCHER_CARDS: readonly SidePaneLauncherCard[] = Object.freeze([
  { id: 'review', label: '审查', hint: '查看变更与逐行 diff', target: { kind: 'tab', item: 'changes' } },
  { id: 'terminal', label: '终端', hint: '在底部面板打开终端', target: { kind: 'terminal' } },
  { id: 'plan', label: '计划', hint: '查看会话计划与阶段', target: { kind: 'tab', item: 'plan' } },
]) as readonly SidePaneLauncherCard[];

/** 卡片尺寸（px）：审计形态 156×88（DOM 内联尺寸与测试共用同一常量） */
export const SIDE_PANE_LAUNCHER_CARD_WIDTH_PX = 156;
export const SIDE_PANE_LAUNCHER_CARD_HEIGHT_PX = 88;

/** tab 标签（宿主渲染用；未知 id 返回 id 本身，不摆假文案） */
export function sidePaneTabLabel(id: SidePaneTabId): string {
  if (id.startsWith(MODEL_TRAJECTORY_TAB_PREFIX)) return '模型轨迹';
  return SIDE_PANE_TABS.find((t) => t.id === id)?.label ?? id;
}

/** Z-14 溢出常量：tab 最小宽（px；宿主 CSS 消费） */
export const SIDE_PANE_TAB_MIN_WIDTH_PX = 60;
/** Z-14：tab 间距（px） */
export const SIDE_PANE_TAB_GAP_PX = 4;

/** 内存 Map 的 LRU 上限（Z-13：50 个会话条目，超出驱逐最久未动条目） */
export const SIDE_PANE_MEMORY_LIMIT = 50;

/** 未选择任何会话时的分桶 key（桌面 selectedId === null；与真实会话 id 同一命名空间，不冲突） */
export const SIDE_PANE_NO_SESSION_KEY = '(no-session)';

/** 单个会话桶：打开的 tab 列表（有序）+ 激活 tab（null = 无激活） */
export interface SidePaneSessionTabs {
  readonly openTabs: readonly SidePaneTabId[];
  readonly activeTab: SidePaneTabId | null;
}

/** 全量内存态：key = 会话 id（Map 的插入序 = LRU 新鲜度，最新在最后） */
export type SidePaneMemory = ReadonlyMap<string, SidePaneSessionTabs>;

export const EMPTY_SIDE_PANE_SESSION: SidePaneSessionTabs = Object.freeze({
  openTabs: Object.freeze([] as SidePaneTabId[]),
  activeTab: null,
});

/** 读桶（纯读，不触碰 LRU —— LRU 新鲜度只由 mutation 刷新，读路径保持无副作用） */
export function sidePaneOf(memory: SidePaneMemory, sessionId: string): SidePaneSessionTabs {
  return memory.get(sessionId) ?? EMPTY_SIDE_PANE_SESSION;
}

/** 命中上限时驱逐最旧条目（Map 首个 key） */
function withLimit(memory: SidePaneMemory): SidePaneMemory {
  if (memory.size <= SIDE_PANE_MEMORY_LIMIT) return memory;
  const oldest = memory.keys().next();
  if (oldest.done) return memory;
  const next = new Map(memory);
  next.delete(oldest.value);
  return next;
}

/** 触碰一个桶（删除重插到 Map 尾 = LRU 刷新），再套上限驱逐 */
function touch(memory: SidePaneMemory, sessionId: string, tabs: SidePaneSessionTabs): SidePaneMemory {
  const next = new Map(memory);
  next.delete(sessionId);
  next.set(sessionId, tabs);
  return withLimit(next);
}

/** 打开 tab：不存在则**追加到末尾**并激活；已存在则仅激活（顺序不动）。幂等。 */
export function openSidePaneTab(memory: SidePaneMemory, sessionId: string, tabId: SidePaneTabId): SidePaneMemory {
  const cur = sidePaneOf(memory, sessionId);
  const openTabs = cur.openTabs.includes(tabId) ? cur.openTabs : [...cur.openTabs, tabId];
  if (openTabs === cur.openTabs && cur.activeTab === tabId) return memory; // 全等 → 免渲染
  return touch(memory, sessionId, { openTabs, activeTab: tabId });
}

/**
 * 关闭 tab：激活 tab 被关时**回落到右邻**（同位次），无右邻则左邻，全空则 null；
 * 桶被关空 → 整条删除（启动器回归，LRU 槽位释放）。关闭不存在的 tab → 原样返回。
 */
export function closeSidePaneTab(memory: SidePaneMemory, sessionId: string, tabId: SidePaneTabId): SidePaneMemory {
  const cur = sidePaneOf(memory, sessionId);
  const index = cur.openTabs.indexOf(tabId);
  if (index < 0) return memory;
  const openTabs = cur.openTabs.filter((t) => t !== tabId);
  if (openTabs.length === 0) {
    const next = new Map(memory);
    next.delete(sessionId);
    return next;
  }
  const activeTab = cur.activeTab !== tabId ? cur.activeTab : (openTabs[index] ?? openTabs[index - 1] ?? null);
  return touch(memory, sessionId, { openTabs, activeTab });
}

/** 关闭其他：只留指定 tab 并激活它（tab 未打开 → 原样返回，不替用户开新 tab） */
export function closeOtherSidePaneTabs(
  memory: SidePaneMemory,
  sessionId: string,
  tabId: SidePaneTabId,
): SidePaneMemory {
  const cur = sidePaneOf(memory, sessionId);
  if (!cur.openTabs.includes(tabId)) return memory;
  if (cur.openTabs.length === 1 && cur.activeTab === tabId) return memory;
  return touch(memory, sessionId, { openTabs: [tabId], activeTab: tabId });
}

/** 全部关闭：删整条桶（等价于回到零 tab 启动器）。桶本就不存在 → 原样返回。 */
export function closeAllSidePaneTabs(memory: SidePaneMemory, sessionId: string): SidePaneMemory {
  if (!memory.has(sessionId)) return memory;
  const next = new Map(memory);
  next.delete(sessionId);
  return next;
}

/** 激活 tab：仅对**已打开**的 tab 生效（未打开 → 原样返回，不隐性开 tab） */
export function activateSidePaneTab(memory: SidePaneMemory, sessionId: string, tabId: SidePaneTabId): SidePaneMemory {
  const cur = sidePaneOf(memory, sessionId);
  if (!cur.openTabs.includes(tabId) || cur.activeTab === tabId) return memory;
  return touch(memory, sessionId, { openTabs: cur.openTabs, activeTab: tabId });
}

/**
 * 拖拽排序：把 `fromIndex` 的 tab 移动到**落位后的最终下标** `toIndex`（钳制 [0, n-1]）。
 * 激活 tab 不因重排改变。非法/等价输入 → 原样返回。
 */
export function moveSidePaneTab(
  memory: SidePaneMemory,
  sessionId: string,
  fromIndex: number,
  toIndex: number,
): SidePaneMemory {
  const cur = sidePaneOf(memory, sessionId);
  const n = cur.openTabs.length;
  const from = Math.trunc(fromIndex);
  const to = Math.trunc(toIndex);
  if (n === 0 || from < 0 || from >= n || to < 0 || to >= n || from === to) return memory;
  const openTabs = [...cur.openTabs];
  const [moved] = openTabs.splice(from, 1);
  openTabs.splice(to, 0, moved as SidePaneTabId);
  return touch(memory, sessionId, { openTabs, activeTab: cur.activeTab });
}

/**
 * 指针拖拽落点换算（宿主把当前 tab 的 DOM 矩形按顺序传入）：clientX 越过哪个 tab 的中点，
 * 就落到它前面；越过全部 → 落到最后。无有效矩形（jsdom / 空表）→ null（不重排）。
 */
export function sidePaneDropIndex(
  rects: ReadonlyArray<{ readonly left: number; readonly right: number }>,
  clientX: number,
): number | null {
  const midpoints: number[] = [];
  for (const r of rects) {
    if (!(r.right > r.left)) return null; // 无效矩形（宽 0）：测量不可信，不重排
    midpoints.push((r.left + r.right) / 2);
  }
  if (midpoints.length === 0) return null; // 没有 tab 可落：不重排
  for (let i = 0; i < midpoints.length; i += 1) {
    if (clientX < (midpoints[i] as number)) return i;
  }
  return midpoints.length;
}

/** 由「原始下标 from」与「矩形落点 dropIndex」折出 moveSidePaneTab 的最终下标（移除后补位） */
export function sidePaneMoveTarget(fromIndex: number, dropIndex: number): number {
  return dropIndex > fromIndex ? dropIndex - 1 : dropIndex;
}
