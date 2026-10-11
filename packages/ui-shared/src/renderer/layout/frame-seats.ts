// 四席位声明与登记（D-10）：sidebar / main（keyed）/ rightbar / shell.overlay，
// 由布局包注册进内建 root 槽 —— 壳只渲染 root 槽里装配好的树。
import type { SeatDeclaration, SlotRegistry } from '../slots/index.js';

/** 内建根槽 */
export const FRAME_ROOT_SEAT = 'root';

/** 四个帧子席位 id（D-10） */
export const FRAME_SEAT = {
  sidebar: 'sidebar',
  main: 'main',
  rightbar: 'rightbar',
  overlay: 'shell.overlay',
} as const;

export type FrameSeatId = (typeof FRAME_SEAT)[keyof typeof FRAME_SEAT];

/** main 席位的保留 key：会话界面（D-10；其余 key 为全局面板） */
export const MAIN_CONVERSATION_KEY = 'conversation';

/**
 * 中栏**内层纵向分栏**的终端面板席位（Z2-03 / Z-12：conversation | terminal）。
 * 这是一个**注册缝**：只有该席位被注入内容时，MainSeatView 才渲染底部终端面板与其开关；
 * 未注入时（当前无真实终端内容提供方）界面不出现任何 terminal 痕迹（禁止假入口，
 * docs/refs/README.md §5 第 6 条）。owner = 未来的终端能力包。
 */
export const TERMINAL_SEAT = 'main.terminal';

/**
 * main 保留 key 的属主包（D-02）。
 * 保留 key 只接受**声明者 owner** 注入（slots/types.ts 的 SeatDeclaration.owner 契约，
 * registry.inject 强制校验）—— 会话界面的内容包就是该 key 的属主，故 main 席位声明的 owner 是它。
 */
export const CONVERSATION_OWNER = 'ui-conversation';

/**
 * main keyed 席位接受的全局面板 key（D-10「其余 key 为全局面板」/ D-79 的 selectPanel 目标）。
 * 与既有右栏只读面板同名，便于后续把面板在「中栏全局面板 / 右栏停靠面」之间切换。
 */
export const MAIN_PANEL_KEYS: readonly string[] = [
  'plan',
  'tasks',
  'approvals',
  'changes',
  'workspace',
  'config',
] as const;

/** 布局包标识（帧席位的声明者） */
export const LAYOUT_OWNER = 'shell/layout';

/** 内建席位声明（root = 帧子席位清单；main = keyed，conversation 为保留 key） */
export const FRAME_SEAT_DECLARATIONS: readonly SeatDeclaration[] = [
  { id: FRAME_ROOT_SEAT, kind: 'list', owner: LAYOUT_OWNER, description: '内建根槽：四个帧子席位注册于此' },
  { id: FRAME_SEAT.sidebar, kind: 'single', owner: LAYOUT_OWNER, description: '左侧栏（会话列表宿主）' },
  {
    id: FRAME_SEAT.main,
    kind: 'keyed',
    // owner = 保留 key 的属主包（保留 key 只由声明者注入，见 CONVERSATION_OWNER）
    owner: CONVERSATION_OWNER,
    keys: [MAIN_CONVERSATION_KEY, ...MAIN_PANEL_KEYS],
    reservedKeys: [MAIN_CONVERSATION_KEY],
    description: '中栏（keyed：conversation = 会话界面，保留 key；其余 key = 全局面板）',
  },
  { id: FRAME_SEAT.rightbar, kind: 'single', owner: LAYOUT_OWNER, description: '右栏（每会话停靠面宿主）' },
  {
    id: TERMINAL_SEAT,
    kind: 'single',
    owner: LAYOUT_OWNER,
    description: '中栏内层纵向分栏的底部终端面板（注册缝：无内容提供方时不渲染）',
  },
  { id: FRAME_SEAT.overlay, kind: 'list', owner: LAYOUT_OWNER, description: '窗口级覆层（设置 / 命令面板…）' },
];

/** 声明四席位（重复调用抛错，交给 registry 把关） */
export function declareFrameSeats(registry: SlotRegistry): void {
  for (const d of FRAME_SEAT_DECLARATIONS) registry.declare(d);
}

/** 帧子席位在 root 槽中的装配顺序（左 → 中 → 右 → 覆层） */
export const FRAME_SEAT_ORDER: readonly FrameSeatId[] = [
  FRAME_SEAT.sidebar,
  FRAME_SEAT.main,
  FRAME_SEAT.rightbar,
  FRAME_SEAT.overlay,
];

/**
 * 把四个子席位注册进 root 槽（D-10）。
 * 组件由调用方给出（AppFrame 提供容器组件），返回幂等 disposer。
 */
export function registerFrameSeats(
  registry: SlotRegistry,
  views: Record<FrameSeatId, React.ComponentType>,
): () => void {
  const disposers = FRAME_SEAT_ORDER.map((seat, order) =>
    registry.inject({ seat: FRAME_ROOT_SEAT, owner: LAYOUT_OWNER, key: seat, order, component: views[seat] }),
  );
  return () => {
    for (const d of disposers) d();
  };
}
