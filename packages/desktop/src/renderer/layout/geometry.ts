// 三栅几何（纯函数，D-11 / D-12 / D-13）：给定视口宽与各栏偏好 → 实际宽度 + 空间不足报告。
// 规格依据 docs/refs/refs-deepseek-harness.md + 上游权威实现
//   refs/deepseek-harness packages/client/ui-layout/src/client/columns.ts:50-57（computeColumns）
//   与 AppFrame.tsx:165-236（normal/canShow 口径）：
//   D-11 侧栏拖宽 264～420px（默认 280）；右栏首开取视口宽 45%，上限 70%
//   D-12 让步链（上游次序）：available < 300 → **右栏轨道摘除（宽度归零）并把 canShow=false 交给占用方**，
//        由占用方自行关闭 → 只有没有右栏轨道时中栏才可能低于 400；不改偏好宽度
//   D-13 侧栏收起保留 56px 轨道；窗口 < 1024px 自动收起
// 纯函数：不读 DOM、不写 storage、不改入参（偏好宽度原样保留 —— D-12「不修改用户偏好宽度」）。

/** 侧栏拖宽下界（D-11） */
export const SIDEBAR_MIN_WIDTH = 264;
/** 侧栏拖宽上界（D-11） */
export const SIDEBAR_MAX_WIDTH = 420;
/** 侧栏默认宽度（D-11） */
export const SIDEBAR_DEFAULT_WIDTH = 280;
/** 侧栏收起后的控制轨道宽度（D-13） */
export const SIDEBAR_RAIL_WIDTH = 56;
/** 中栏保底目标宽度（D-12：为给中栏保留 400px） */
export const MAIN_MIN_WIDTH = 400;
/** 右栏首开宽度 = 视口宽 × 45%（D-11） */
export const RIGHTBAR_DEFAULT_RATIO = 0.45;
/** 右栏宽度上限 = 视口宽 × 70%（D-11） */
export const RIGHTBAR_MAX_RATIO = 0.7;
/** 右栏在场下界（D-12：available 不足 300 → 轨道摘除、canShow=false，交占用方自关） */
export const RIGHTBAR_GIVE_MIN_WIDTH = 300;
/** 自动收起侧栏的窗口宽度阈值（D-13：低于 1024px 自动收起） */
export const AUTO_COLLAPSE_VIEWPORT = 1024;

/** 几何输入（全部来自即时的 React state + 当前视口宽；D-14 不持久化） */
export interface FrameGeometryInput {
  /** 视口宽度（px） */
  readonly viewportWidth: number;
  /** 侧栏偏好宽度（px，未被钳制的用户值） */
  readonly sidebarWidth: number;
  /** 侧栏开关偏好 */
  readonly sidebarCollapsed: boolean;
  /** 右栏是否展开 */
  readonly rightbarOpen: boolean;
  /** 右栏宽度偏好（null = 首开未定 → 取视口宽 45%） */
  readonly rightbarWidth: number | null;
  /** 右栏是否全屏形态（D-74 分形态；全屏时覆盖窗口且不显示拖宽手柄） */
  readonly rightbarFullscreen?: boolean;
}

/** 空间不足的占用方（D-12：报告给占用方，由其自行关闭，壳不代关） */
export type ShortageOwner = 'rightbar' | null;

export interface FrameGeometry {
  /** 实际渲染宽度 */
  readonly sidebar: number;
  readonly main: number;
  readonly rightbar: number;
  /** 侧栏此刻是否处于收起轨道态（几何层口径，不写回状态） */
  readonly sidebarRail: boolean;
  /**
   * 右栏此刻是否还能以普通形态在场（上游 AppFrame.tsx:227 的 `canShow`）：
   * `available = 视口 − 侧栏 − 中栏保底 400` 不足 300 时为 false —— 此时右栏轨道被摘除
   * （rightbar = 0），帧把该 props 交给右栏占用方，由占用方自行关闭。
   */
  readonly rightbarCanShow: boolean;
  /** 右栏被让步链压窄（有轨道，但比（钳制后的）偏好窄）；轨道摘除不算「压窄」 */
  readonly rightbarShrunk: boolean;
  /** 中栏是否已被压到 400px 以下（让步链的最后一步，只可能发生在右栏无轨道时） */
  readonly mainCompressed: boolean;
  /** 仍缺多少 px 才够中栏保底（0 = 空间充足） */
  readonly shortage: number;
  /** 空间不足的占用方；无不足或右栏未开时为 null */
  readonly shortageOwner: ShortageOwner;
  /** 该视口宽是否低于自动收起阈值（D-13） */
  readonly belowAutoCollapse: boolean;
}

/** 把宽度钳制到 [min, max]（NaN 归到下界、±Infinity 归到边界，避免非法宽度进 DOM） */
export function clampWidth(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  const upper = Math.max(min, max);
  return Math.min(upper, Math.max(min, Math.round(value)));
}

/** 视口宽是否触发侧栏自动收起（D-13；>= 1024 不收起） */
export function shouldAutoCollapse(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth < AUTO_COLLAPSE_VIEWPORT;
}

/** 右栏首开宽度：视口宽 45%（D-11） */
export function defaultRightbarWidth(viewportWidth: number): number {
  return Math.max(0, Math.round(viewportWidth * RIGHTBAR_DEFAULT_RATIO));
}

/**
 * 三栅几何 + 让步链（D-12，次序照上游 columns.ts:50-57）：
 *   ① 侧栏取宽（收起 → 56px 轨道；极窄窗口也保留轨道，D-13）
 *   ② available = 视口 − 侧栏 − 中栏保底 400
 *   ③ available < 300（右栏让步下界）→ **右栏宽度归零（轨道摘除）**，`rightbarCanShow = false`
 *      —— 该 props 交给右栏占用方，由占用方自行关闭（上游 AppFrame.tsx:227 / SidebarRight.tsx:378）
 *   ④ 有轨道时右栏 = min(available, clamp(偏好, 300, 视口 70%))：先把右栏缩到 available 为止
 *   ⑤ 只有没有右栏轨道时中栏才可能低于 400（mainCompressed / shortage）
 * 任何分支都不改写入参（偏好宽度原样保留 —— 变宽后右栏不自动重新展开由状态层负责）。
 */
export function computeFrameGeometry(input: FrameGeometryInput): FrameGeometry {
  const viewport = Number.isFinite(input.viewportWidth) ? Math.max(0, Math.round(input.viewportWidth)) : 0;
  const insufficient = Number.isFinite(input.sidebarWidth) ? input.sidebarWidth : SIDEBAR_DEFAULT_WIDTH;
  const sidebarRail = input.sidebarCollapsed;
  // 收起后恒为 56px 轨道（D-13：极窄窗口下轨道仍保留，故不与视口宽比较取小）
  const sidebar = sidebarRail ? SIDEBAR_RAIL_WIDTH : clampWidth(insufficient, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  const belowAutoCollapse = shouldAutoCollapse(viewport);
  const rightbarOpen = input.rightbarOpen === true;
  // ② 右栏还能占道的空间：视口扣除侧栏与中栏保底（与上游 `available` 同式）
  const available = viewport - sidebar - MAIN_MIN_WIDTH;
  // ③ 空间不足 → 轨道摘除；canShow=false 交给占用方自关（上游 canShow = normal.rightbar > 0）
  const rightbarCanShow = rightbarOpen && available >= RIGHTBAR_GIVE_MIN_WIDTH;

  if (rightbarOpen && input.rightbarFullscreen === true) {
    // 全屏形态：右栏覆盖窗口（中栏/侧栏被覆盖，不再参与挤压）；canShow 仍按普通形态口径报告
    return {
      sidebar,
      main: 0,
      rightbar: viewport,
      sidebarRail,
      rightbarCanShow,
      rightbarShrunk: false,
      mainCompressed: false,
      shortage: 0,
      shortageOwner: null,
      belowAutoCollapse,
    };
  }

  const wantedRightbar = input.rightbarWidth ?? defaultRightbarWidth(viewport);
  const cap = Math.round(viewport * RIGHTBAR_MAX_RATIO);
  const wanted = clampWidth(wantedRightbar, RIGHTBAR_GIVE_MIN_WIDTH, cap);
  // ④ 有轨道：右栏先缩到 available（不多让）；无轨道：0
  const rightbar = rightbarCanShow ? Math.min(available, wanted) : 0;
  // ⑤ 剩余全给中栏；低于保底即「最后压中栏」（无右栏轨道时才可能发生）
  const main = Math.max(0, viewport - sidebar - rightbar);
  const shortage = Math.max(0, MAIN_MIN_WIDTH - main);
  return {
    sidebar,
    main,
    rightbar,
    sidebarRail,
    rightbarCanShow,
    rightbarShrunk: rightbarCanShow && rightbar < wanted,
    mainCompressed: main < MAIN_MIN_WIDTH,
    shortage,
    shortageOwner: shortage > 0 && rightbarOpen ? 'rightbar' : null,
    belowAutoCollapse,
  };
}
