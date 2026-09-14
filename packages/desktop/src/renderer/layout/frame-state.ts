// 面板几何的即时状态（D-13 / D-14）：只存 React state（本模块是纯 reducer，不碰 storage）。
//  - D-14：宽度/开合状态不持久化；刷新或切会话即回到 initialFrameState()
//  - D-13：视口 < 1024px 自动收起侧栏；**打开右栏只在窄屏清掉「窄屏手动展开」override**
//    （上游 stores.ts:131 `if (!rightbarShown && viewportWidth < SIDEBAR_AUTO_COLLAPSE) narrowExpanded = false`）
//  - D-13：跨 1024 阈值**双向**重置窄屏 override（上游 stores.ts:115-122 setViewportWidth）：
//    变宽回到宽态偏好（侧栏按偏好展开），不把窄屏的临时收起写死成偏好
//  - D-12：让步链只改渲染几何（geometry.ts），不改这里的偏好宽度；**右栏**不自动重新展开
// 侧栏开合因此分两份事实（照上游 layoutInfo.sidebar / narrowExpanded）：
//   sidebarCollapsed = 宽屏偏好（用户手动收起/展开）
//   narrowExpanded   = 窄屏临时展开 override（窄屏默认自动收起）
import {
  clampWidth,
  defaultRightbarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  RIGHTBAR_GIVE_MIN_WIDTH,
  RIGHTBAR_MAX_RATIO,
  shouldAutoCollapse,
} from './geometry.js';
import { MAIN_CONVERSATION_KEY } from './frame-seats.js';

export { MAIN_CONVERSATION_KEY };

export interface FrameState {
  /** 侧栏偏好宽度（拖宽后的用户值；D-11 264～420） */
  readonly sidebarWidth: number;
  /** 侧栏**宽屏偏好**是否收起（窄屏不看它，见 narrowExpanded） */
  readonly sidebarCollapsed: boolean;
  /** 窄屏「手动展开」override（窄屏默认自动收起；跨阈值双向重置） */
  readonly narrowExpanded: boolean;
  /** 最近一次视口测量值（上游 layoutInfo.viewportWidth；0 = 尚未测量） */
  readonly viewportWidth: number;
  readonly rightbarOpen: boolean;
  /** 右栏宽度偏好（null = 本次会话尚未首开 → 首开取视口宽 45%） */
  readonly rightbarWidth: number | null;
  /** 右栏全屏形态（D-74；本阶段仅提供状态与几何，无 UI 入口） */
  readonly rightbarFullscreen: boolean;
  /** main keyed 席位当前 key（'conversation' = 会话界面） */
  readonly mainKey: string;
}

/** 默认面板几何（每次挂载/刷新都从这里开始 —— D-14） */
export function initialFrameState(): FrameState {
  return {
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidebarCollapsed: false,
    narrowExpanded: false,
    viewportWidth: 0,
    rightbarOpen: false,
    rightbarWidth: null,
    rightbarFullscreen: false,
    mainKey: MAIN_CONVERSATION_KEY,
  };
}

export type FrameAction =
  /** 手动收起/展开侧栏（宽屏改偏好；窄屏改「手动展开」override） */
  | { readonly type: 'sidebar/toggle' }
  /** 拖宽侧栏（钳制 264～420） */
  | { readonly type: 'sidebar/width'; readonly width: number }
  /** 打开/收起右栏；打开时若偏好未定则取视口宽 45%（窄屏同时清掉侧栏的手动展开 override） */
  | { readonly type: 'rightbar/toggle' }
  /** 拖宽右栏（钳制 300～视口 70%） */
  | { readonly type: 'rightbar/width'; readonly width: number }
  /** 右栏全屏形态切换（D-74） */
  | { readonly type: 'rightbar/fullscreen'; readonly fullscreen: boolean }
  /** 视口宽测量：记录 + 跨 1024 阈值双向重置窄屏 override（不写宽屏偏好） */
  | { readonly type: 'viewport'; readonly viewportWidth: number }
  /** 切换 main keyed 席位的 key（null = 回到保留的会话界面 key） */
  | { readonly type: 'main/select-key'; readonly key: string | null }
  /** 复位为默认几何（等价于重新挂载） */
  | { readonly type: 'reset' };

/** 右栏宽度上限（视口 70%，且不低于在场下界） */
export function rightbarMaxWidth(viewportWidth: number): number {
  const cap = Math.round(viewportWidth * RIGHTBAR_MAX_RATIO);
  return Math.max(RIGHTBAR_GIVE_MIN_WIDTH, cap);
}

/**
 * 侧栏此刻是否收起（上游 AppFrame.tsx:160-164）：
 * 窄屏看「手动展开」override（默认自动收起），宽屏看偏好；视口未测量（0）按宽屏处理。
 */
export function isSidebarCollapsed(state: FrameState): boolean {
  return shouldAutoCollapse(state.viewportWidth) ? !state.narrowExpanded : state.sidebarCollapsed;
}

/** 帧状态 reducer（纯函数：同入参同出参，且**不修改**入参） */
export function applyFrameAction(state: FrameState, action: FrameAction): FrameState {
  switch (action.type) {
    case 'sidebar/toggle':
      // 窄屏：只翻 override（宽度偏好原样保留，回到宽屏仍是拖过的宽度）
      return shouldAutoCollapse(state.viewportWidth)
        ? { ...state, narrowExpanded: !state.narrowExpanded }
        : { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'sidebar/width': {
      const width = clampWidth(action.width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
      return width === state.sidebarWidth ? state : { ...state, sidebarWidth: width };
    }
    case 'rightbar/toggle': {
      if (state.rightbarOpen) {
        return { ...state, rightbarOpen: false, rightbarFullscreen: false };
      }
      return {
        ...state,
        rightbarOpen: true,
        // D-11：首开取视口宽 45%；之后保留用户像素宽度偏好
        rightbarWidth: clampWidth(
          state.rightbarWidth ?? defaultRightbarWidth(state.viewportWidth),
          RIGHTBAR_GIVE_MIN_WIDTH,
          rightbarMaxWidth(state.viewportWidth),
        ),
        // D-13（上游 stores.ts:131）：只有窄屏开启才清掉「窄屏手动展开」override；
        // 宽屏打开右栏不动侧栏（侧栏是宽屏偏好说了算）
        narrowExpanded: shouldAutoCollapse(state.viewportWidth) ? false : state.narrowExpanded,
      };
    }
    case 'rightbar/width': {
      const width = clampWidth(action.width, RIGHTBAR_GIVE_MIN_WIDTH, rightbarMaxWidth(state.viewportWidth));
      return width === state.rightbarWidth ? state : { ...state, rightbarWidth: width };
    }
    case 'rightbar/fullscreen':
      return state.rightbarFullscreen === action.fullscreen
        ? state
        : { ...state, rightbarFullscreen: action.fullscreen };
    case 'viewport': {
      // 同宽重复测量：不改状态引用（ResizeObserver 抖动不发无意义渲染）
      if (state.viewportWidth === action.viewportWidth) return state;
      // 跨阈值（任意方向）→ 重置窄屏 override：窄屏默认自动收起，宽屏回到偏好
      const crossed = shouldAutoCollapse(state.viewportWidth) !== shouldAutoCollapse(action.viewportWidth);
      return {
        ...state,
        viewportWidth: action.viewportWidth,
        narrowExpanded: crossed ? false : state.narrowExpanded,
      };
    }
    case 'main/select-key': {
      const key = action.key ?? MAIN_CONVERSATION_KEY;
      return key === state.mainKey ? state : { ...state, mainKey: key };
    }
    case 'reset':
      // 等价于重新挂载：视口测量值不是面板几何偏好，重挂载会立刻重新测到同一个值，故原样保留
      return { ...initialFrameState(), viewportWidth: state.viewportWidth };
  }
}
