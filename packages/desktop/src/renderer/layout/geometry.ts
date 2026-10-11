// 三栅几何（纯函数，Z2-01a）：给定视口宽与各栏偏好 → 实际宽度 + 空间不足报告。
// 规格依据 docs/refs/refs-zcode-layout.md（Z-05 左栏默认与几何 / Z-06 折叠形态 /
// Z-12 分栏嵌套与默认比例 / Z-15 自动收起规则 / §8 几何与常量表）：
//   Z-05 左栏默认 264、最小 264、最大 = 容器 × 0.5、键盘步长 16
//   Z-06 折叠后 4px（无图标轨道）
//   Z-12 内容列最小 320；右栏 default 0 / min 240 / max 65% / 展开 45%（**分母 = 内容区宽**，
//        即 视口 − 左栏；Z2-03 起右栏比例相对内容区，不再相对视口）
//   Z-12 内层纵向分栏 conversation（min 35%）| terminal（default 0 / min 140 / max 50% / 展开 30%）
//   Z-15 自动收起按**会话列宽**判定（右栏 480 / 左栏 360），resize idle 300ms
// 让步链（D-12，deepseek-harness 口径）保留：available 不足右栏在场下界 → 右栏轨道摘除，
// 由占用方自行关闭；只有没有右栏轨道时中栏才可能低于 MAIN_MIN_WIDTH。
// 纯函数：不读 DOM、不写 storage、不改入参（偏好宽度原样保留 —— D-12「不修改用户偏好宽度」）。

/** 侧栏默认宽度（Z-05：264） */
export const SIDEBAR_DEFAULT_WIDTH = 264;
/** 侧栏拖宽下界（Z-05：264） */
export const SIDEBAR_MIN_WIDTH = 264;
/** 侧栏拖宽上界比例 = 容器 × 0.5（Z-05 / §8） */
export const SIDEBAR_MAX_WIDTH_RATIO = 0.5;
/** 侧栏折叠宽度（Z-05 / Z-06：桌面 4px，无图标轨道） */
export const SIDEBAR_COLLAPSED_WIDTH = 4;
/** 侧栏键盘调宽步长（Z-05：16px） */
export const SIDEBAR_RESIZE_STEP_PX = 16;

/** 内容区（会话列）最小宽度（Z-12 / §8：320px） */
export const MAIN_MIN_WIDTH = 320;

/** 右栏默认（收起）比例（Z-12：default 0px） */
export const RIGHTBAR_DEFAULT_RATIO = 0;
/** 右栏展开比例（Z-12：45%） */
export const RIGHTBAR_EXPANDED_RATIO = 0.45;
/** 右栏最小宽度（Z-12：240px） */
export const RIGHTBAR_MIN_PX = 240;
/** 右栏最大比例（Z-12：65%） */
export const RIGHTBAR_MAX_RATIO = 0.65;

/** 会话列默认比例（Z-12：右栏可见时 52%）—— 常量供后续 Z2-03 接线 */
export const CONVERSATION_DEFAULT_RATIO = 0.52;
/** 会话列最小比例（Z-12：35%） */
export const CONVERSATION_MIN_RATIO = 0.35;
/** 底部终端默认比例（Z-12：0 = 关闭） */
export const TERMINAL_DEFAULT_RATIO = 0;
/** 底部终端展开比例（Z-12：30%） */
export const TERMINAL_EXPANDED_RATIO = 0.3;
/** 底部终端最小高度（Z-12：140px） */
export const TERMINAL_MIN_PX = 140;
/** 底部终端最大比例（§8：50%） */
export const TERMINAL_MAX_RATIO = 0.5;

/** 右栏自动收起阈值：会话列 < 480px（Z-15） */
export const AUTO_COLLAPSE_RIGHTBAR_CONVERSATION_WIDTH = 480;
/** 左栏自动收起阈值：会话列 < 360px（Z-15） */
export const AUTO_COLLAPSE_SIDEBAR_CONVERSATION_WIDTH = 360;
/** 窗口 resize 后的判定 idle（Z-15：300ms） */
export const AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;

/** 几何输入（全部来自即时的 React state + 当前视口宽；不持久化） */
export interface FrameGeometryInput {
  /** 视口宽度（px，同时作为侧栏最大宽度的容器） */
  readonly viewportWidth: number;
  /** 侧栏偏好宽度（px，未被钳制的用户值） */
  readonly sidebarWidth: number;
  /** 侧栏折叠偏好 */
  readonly sidebarCollapsed: boolean;
  /** 右栏是否展开 */
  readonly rightbarOpen: boolean;
  /** 右栏宽度偏好（null = 首开未定 → 取**内容区宽** 45%） */
  readonly rightbarWidth: number | null;
  /** 右栏是否全屏形态（D-74 分形态；全屏时覆盖窗口且不显示拖宽手柄） */
  readonly rightbarFullscreen?: boolean;
}

/** 空间不足的占用方（D-12：报告给占用方，由其自行关闭，壳不代关） */
export type ShortageOwner = 'rightbar' | null;

export interface FrameGeometry {
  /** 实际渲染宽度（折叠 = SIDEBAR_COLLAPSED_WIDTH） */
  readonly sidebar: number;
  /** 展开时的钳制宽度（折叠时内容仍按此宽度排版，只隐藏不重排） */
  readonly sidebarExpandedWidth: number;
  /** 内容区宽 = 视口 − 左栏（右栏展开/上限比例的分母，Z2-03 / Z-12） */
  readonly contentWidth: number;
  readonly main: number;
  readonly rightbar: number;
  /** 侧栏此刻是否折叠（几何层口径，不写回状态） */
  readonly sidebarCollapsed: boolean;
  /**
   * 右栏此刻是否还能以普通形态在场（上游 AppFrame.tsx:227 的 `canShow`）：
   * `available = 视口 − 侧栏 − 会话列保底 320` 不足 RIGHTBAR_MIN_PX 时为 false ——
   * 此时右栏轨道被摘除（rightbar = 0），帧把该 props 交给右栏占用方，由占用方自行关闭。
   */
  readonly rightbarCanShow: boolean;
  /** 右栏被让步链压窄（有轨道，但比（钳制后的）偏好窄）；轨道摘除不算「压窄」 */
  readonly rightbarShrunk: boolean;
  /** 会话列是否已被压到 MAIN_MIN_WIDTH 以下（让步链的最后一步，只可能发生在右栏无轨道时） */
  readonly mainCompressed: boolean;
  /** 仍缺多少 px 才够会话列保底（0 = 空间充足） */
  readonly shortage: number;
  /** 空间不足的占用方；无不足或右栏未开时为 null */
  readonly shortageOwner: ShortageOwner;
  /** 会话列宽是否低于左栏自动收起阈值（供状态层在 resize idle 时判定，Z-15） */
  readonly belowAutoCollapse: boolean;
}

/** 把宽度钳制到 [min, max]（NaN 归到下界、±Infinity 归到边界，避免非法宽度进 DOM） */
export function clampWidth(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  const upper = Math.max(min, max);
  return Math.min(upper, Math.max(min, Math.round(value)));
}

/**
 * 侧栏展开宽度上限 = 容器 × 0.5（Z-05 / §8）。
 * 容器宽未知/非正时返回 +Infinity（只受下界约束，不制造非法上限）。
 */
export function sidebarMaxWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(containerWidth * SIDEBAR_MAX_WIDTH_RATIO));
}

/** 右栏展开宽度：**内容区宽** × 45%（Z-12；首次打开无像素偏好时取此值）。
 *  Z2-03 起分母是内容区（视口 − 左栏），不是视口 —— 右栏打开时会话列约占内容区 55%
 *  （上游 conversation-column defaultSize 52% 为独立面板配置，见 Z-12；本仓单自由度实现取 45% 口径）。 */
export function defaultRightbarWidth(contentWidth: number): number {
  return Math.max(0, Math.round(contentWidth * RIGHTBAR_EXPANDED_RATIO));
}

/**
 * 内容区宽 = 视口 − 左栏渲染宽（折叠时左栏为 4px，Z-06）。
 * 右栏的展开比例 / 上限比例都相对它（Z2-03 / Z-12）。
 */
export function resolveContentWidth(viewportWidth: number, sidebarWidth: number, sidebarCollapsed: boolean): number {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.round(viewportWidth)) : 0;
  const preference = Number.isFinite(sidebarWidth) ? sidebarWidth : SIDEBAR_DEFAULT_WIDTH;
  const expanded = clampWidth(preference, SIDEBAR_MIN_WIDTH, sidebarMaxWidth(viewport));
  const sidebar = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : expanded;
  return Math.max(0, viewport - sidebar);
}

/** 底部终端高度上限 = 主列高 × 50%（§8 / Z-12；非正主列高退化为最小高 140） */
export function terminalMaxHeight(columnHeight: number): number {
  const height = Number.isFinite(columnHeight) ? Math.max(0, columnHeight) : 0;
  return Math.round(height * TERMINAL_MAX_RATIO);
}

/** 把终端高度钳制到 [TERMINAL_MIN_PX(140), 主列高 × 50%]（Z-12 / §8） */
export function clampTerminalHeight(columnHeight: number, value: number): number {
  return clampWidth(value, TERMINAL_MIN_PX, terminalMaxHeight(columnHeight));
}

/**
 * 终端展开高度 = 主列高 × 30%，钳制在 [140, 主列高 × 50%]（Z-12 / §8）。
 * 主列高未知（0）时落到最小高 140，不给 0 高度（避免「展开了却看不见」）。
 */
export function resolveTerminalHeight(columnHeight: number): number {
  const height = Number.isFinite(columnHeight) ? Math.max(0, columnHeight) : 0;
  return clampTerminalHeight(height, Math.round(height * TERMINAL_EXPANDED_RATIO));
}

/** 会话列宽是否触发右栏自动收起（Z-15：< 480px；未测量 0 不误判） */
export function shouldAutoCollapseRightbar(conversationWidth: number): boolean {
  return conversationWidth > 0 && conversationWidth < AUTO_COLLAPSE_RIGHTBAR_CONVERSATION_WIDTH;
}

/** 会话列宽是否触发左栏自动收起（Z-15：< 360px；未测量 0 不误判） */
export function shouldAutoCollapseSidebar(conversationWidth: number): boolean {
  return conversationWidth > 0 && conversationWidth < AUTO_COLLAPSE_SIDEBAR_CONVERSATION_WIDTH;
}

/** 自动收起判定输入（会话列实测宽 + 各栏即时开合事实） */
export interface AutoCollapseInput {
  /** 会话列实测宽度（px；0 = 未测量） */
  readonly conversationWidth: number;
  readonly rightbarOpen: boolean;
  /** 右栏当前渲染宽度（用于右栏收起后「会话列拿回多少」的复算） */
  readonly rightbarWidth: number;
  readonly sidebarCollapsed: boolean;
}

export interface AutoCollapseDecision {
  readonly collapseRightbar: boolean;
  readonly collapseSidebar: boolean;
}

/**
 * 自动收起决策（Z-15）：**先右栏（< 480）后左栏（< 360）**。
 * 右栏先收后会话列会拿回右栏占用的宽度，故左栏判定用「右栏收起后」的会话列宽复算 ——
 * 与上游 `WorkspaceShellLayout.tsx:481-509`（收右栏 → rAF 后重测 → 再判左栏）同序。
 * 只返回「应否收起」，不含任何计时；计时（resize idle 300ms）在 hook 层，且**只在窗口 resize 后**判定。
 */
export function resolveAutoCollapse(input: AutoCollapseInput): AutoCollapseDecision {
  if (!(input.conversationWidth > 0)) return { collapseRightbar: false, collapseSidebar: false };
  const collapseRightbar = input.rightbarOpen && shouldAutoCollapseRightbar(input.conversationWidth);
  const afterRightbar = collapseRightbar
    ? input.conversationWidth + Math.max(0, input.rightbarWidth)
    : input.conversationWidth;
  const collapseSidebar = !input.sidebarCollapsed && shouldAutoCollapseSidebar(afterRightbar);
  return { collapseRightbar, collapseSidebar };
}

/**
 * 三栅几何 + 让步链（D-12，次序照上游 columns.ts:50-57）：
 *   ① 侧栏取宽（折叠 → 4px，Z-06；展开 → clamp(偏好, 264, 容器 50%)）
 *   ①' 内容区宽 = 视口 − 侧栏（右栏比例的分母，Z2-03）
 *   ② available = 内容区 − 会话列保底 320
 *   ③ available < 240（右栏在场下界）→ **右栏宽度归零（轨道摘除）**，`rightbarCanShow = false`
 *      —— 该 props 交给右栏占用方，由占用方自行关闭（上游 AppFrame.tsx:227 / SidebarRight.tsx:378）
 *   ④ 有轨道时右栏 = min(available, clamp(偏好, 240, 内容区 65%))：先把右栏缩到 available 为止
 *   ⑤ 只有没有右栏轨道时中栏才可能低于 320（mainCompressed / shortage）
 * 任何分支都不改写入参（偏好宽度原样保留 —— 变宽后右栏不自动重新展开由状态层负责）。
 */
export function computeFrameGeometry(input: FrameGeometryInput): FrameGeometry {
  const viewport = Number.isFinite(input.viewportWidth) ? Math.max(0, Math.round(input.viewportWidth)) : 0;
  const preference = Number.isFinite(input.sidebarWidth) ? input.sidebarWidth : SIDEBAR_DEFAULT_WIDTH;
  const sidebarCollapsed = input.sidebarCollapsed === true;
  const sidebarExpandedWidth = clampWidth(preference, SIDEBAR_MIN_WIDTH, sidebarMaxWidth(viewport));
  // ① 折叠后恒为 4px（Z-06：无图标轨道；极窄窗口也保持折叠宽，不与视口宽比较取小）
  const sidebar = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarExpandedWidth;
  // ①' 内容区宽（视口 − 左栏）：右栏比例（展开 45% / 上限 65%）的分母（Z2-03 / Z-12）
  const contentWidth = Math.max(0, viewport - sidebar);
  const rightbarOpen = input.rightbarOpen === true;
  // ② 右栏还能占道的空间：内容区扣除会话列保底（与上游 `available` 同式）
  const available = contentWidth - MAIN_MIN_WIDTH;
  // ③ 空间不足 → 轨道摘除；canShow=false 交给占用方自关（上游 canShow = normal.rightbar > 0）
  const rightbarCanShow = rightbarOpen && available >= RIGHTBAR_MIN_PX;

  if (rightbarOpen && input.rightbarFullscreen === true) {
    // 全屏形态：右栏覆盖窗口（中栏/侧栏被覆盖，不再参与挤压）；canShow 仍按普通形态口径报告
    return {
      sidebar,
      sidebarExpandedWidth,
      contentWidth,
      main: 0,
      rightbar: viewport,
      sidebarCollapsed,
      rightbarCanShow,
      rightbarShrunk: false,
      mainCompressed: false,
      shortage: 0,
      shortageOwner: null,
      belowAutoCollapse: false,
    };
  }

  const wantedRightbar = input.rightbarWidth ?? defaultRightbarWidth(contentWidth);
  const cap = Math.round(contentWidth * RIGHTBAR_MAX_RATIO);
  const wanted = clampWidth(wantedRightbar, RIGHTBAR_MIN_PX, cap);
  // ④ 有轨道：右栏先缩到 available（不多让）；无轨道：0
  const rightbar = rightbarCanShow ? Math.min(available, wanted) : 0;
  // ⑤ 剩余全给会话列；低于保底即「最后压中栏」（无右栏轨道时才可能发生）
  const main = Math.max(0, contentWidth - rightbar);
  const shortage = Math.max(0, MAIN_MIN_WIDTH - main);
  return {
    sidebar,
    sidebarExpandedWidth,
    contentWidth,
    main,
    rightbar,
    sidebarCollapsed,
    rightbarCanShow,
    rightbarShrunk: rightbarCanShow && rightbar < wanted,
    mainCompressed: main < MAIN_MIN_WIDTH,
    shortage,
    shortageOwner: shortage > 0 && rightbarOpen ? 'rightbar' : null,
    belowAutoCollapse: shouldAutoCollapseSidebar(main),
  };
}
