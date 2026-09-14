// 工具卡 → 右栏 / 轨迹视图的**跳转契约**（D-86 的两条路由 + 注入面）。
//
// D-86 原文两条：
//   ① 「文件路径经 owner `openFile` 路由右栏文本预览」→ `openFile()`：路由目标见 `TOOL_OPEN_FILE_TARGET`。
//   ② 「`inspect` 开轨迹视图」→ `inspect()`：路由目标 = `ui-trajectory`（`TRAJECTORY_VIEW_KEY`）。
//
// 边界与注入（D-6x 原则：通过席位或 ctx 注入，不跨层 import）：
//   本模块只**登记请求并投递给已装配的消费者**，不自己画右栏、不自己开视图；
//   右栏消费者 = 右栏内容（SidePanel 的文件预览分区）；轨迹消费者 = A 棒 `ui-trajectory` 通过
//   `registerTrajectoryView()` 注册。**未装配的消费者不渲染入口**（不造假按钮）——
//   `canInspect()` 为 false 时工具卡不显示「查看轨迹」（见 ToolCard）。
//
// 只存内存、不落任何浏览器存储（D-14 口径）；快照不可变，无变化时引用稳定。
import { createContext, useContext, useSyncExternalStore } from 'react';
import { TRAJECTORY_VIEW_KEY } from '../trajectory/trajectory-view.js';

/** D-86 ①：文件打开的路由目标（右栏文本预览） */
export const TOOL_OPEN_FILE_TARGET = 'rightbar';
/** D-86 ②：inspect 的路由目标（轨迹视图） */
export const TOOL_INSPECT_TARGET = 'trajectory';
/**
 * `ui-trajectory`（A 棒 `renderer/trajectory`，D-40）在会话视图环里的 key。
 * P2-3：**唯一来源是轨迹模块自身**（`trajectory-view.tsx` 的 `TRAJECTORY_VIEW_KEY`）——
 * 本模块只**转出**该常量，不再自写一份字面量（两处字面量会漂移，且与本文件此前的注释自相矛盾）。
 */
export { TRAJECTORY_VIEW_KEY };

/** 轨迹视图消费者（A 棒注册进来的打开回调 + 它的视图 key） */
export interface TrajectoryViewConsumer {
  /** 会话视图环里的视图 key（A 棒 `TRAJECTORY_VIEW_KEY`） */
  readonly key: string;
  /** 打开该视图（宿主实现：切视图环选中项 / 记录待选 key） */
  readonly open: (request: ToolInspectRequest) => void;
}

export type ToolNavigationTarget = typeof TOOL_OPEN_FILE_TARGET | typeof TOOL_INSPECT_TARGET;

/** 路由失败原因（如实回报，不用假的成功态糊过去） */
export type ToolNavigationFailureReason =
  /** 工具参数里没有可用文件路径 */
  | 'empty-path'
  /** 轨迹跳转缺少会话上下文（无法定位会话视图环） */
  | 'missing-session'
  /** 轨迹视图消费者未装配（A 棒未落地 / 未注册） */
  | 'view-not-assembled';

export type ToolNavigationResult =
  | { readonly ok: true; readonly target: ToolNavigationTarget }
  | { readonly ok: false; readonly target: ToolNavigationTarget; readonly reason: ToolNavigationFailureReason };

/** 打开文件请求（工具卡 → owner.openFile） */
export interface ToolFileOpenRequest {
  /** 文件路径（工具参数 `file_path` / `path`；空路径视为失败） */
  readonly path: string;
  /** 1 起算行号（D-76 `openResource` 的 `{ line }` 导航口径；无则不定位） */
  readonly line?: number;
  readonly sessionId?: string;
  readonly callId?: string;
}

/** inspect 请求（工具卡 → 轨迹视图） */
export interface ToolInspectRequest {
  readonly sessionId: string;
  readonly callId?: string;
  readonly seq?: number;
}

/** 右栏文件预览的待打开状态（右栏内容订阅它来显示文本预览） */
export interface ToolFilePreview {
  readonly path: string;
  readonly line?: number;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly openedAt: number;
}

export interface ToolNavigationState {
  readonly filePreview: ToolFilePreview | null;
}

const EMPTY_STATE: ToolNavigationState = Object.freeze({ filePreview: null });

/** 跳转契约（可注入实现：测试与替换消费者都用它，不依赖模块单例） */
export interface ToolNavigation {
  getSnapshot(): Readonly<ToolNavigationState>;
  subscribe(listener: () => void): () => void;
  /** D-86 ①：把文件路径路由到右栏文本预览 */
  openFile(request: ToolFileOpenRequest): ToolNavigationResult;
  /** D-86 ②：把调用路由到轨迹视图（未装配 → 失败，调用方据此不渲染入口） */
  inspect(request: ToolInspectRequest): ToolNavigationResult;
  /** 轨迹视图是否已装配（工具卡据此决定是否显示「查看轨迹」） */
  canInspect(): boolean;
  /** 已装配的轨迹视图 key（未装配 → null） */
  inspectViewKey(): string | null;
  /** A 棒 `ui-trajectory` 的接入点：注册轨迹视图消费者；返回幂等 disposer */
  registerTrajectoryView(consumer: TrajectoryViewConsumer): () => void;
  /** 清空待打开文件（右栏消费后 / 测试） */
  clearFilePreview(): void;
}

/** 建一个跳转契约实例（应用用模块单例；测试各自新建，互不串扰） */
export function createToolNavigation(): ToolNavigation {
  let snapshot: ToolNavigationState = EMPTY_STATE;
  const listeners = new Set<() => void>();
  let trajectory: TrajectoryViewConsumer | null = null;

  const emit = (): void => {
    for (const l of [...listeners]) l();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openFile(request) {
      if (request.path.length === 0) {
        return { ok: false, target: TOOL_OPEN_FILE_TARGET, reason: 'empty-path' };
      }
      snapshot = Object.freeze({
        filePreview: Object.freeze({
          path: request.path,
          ...(request.line !== undefined ? { line: request.line } : {}),
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          ...(request.callId !== undefined ? { callId: request.callId } : {}),
          openedAt: Date.now(),
        }),
      });
      emit();
      return { ok: true, target: TOOL_OPEN_FILE_TARGET };
    },
    inspect(request) {
      if (request.sessionId.length === 0) {
        return { ok: false, target: TOOL_INSPECT_TARGET, reason: 'missing-session' };
      }
      if (trajectory === null) {
        // 视图未装配：不假装成功（工具卡也不渲染这个入口）
        return { ok: false, target: TOOL_INSPECT_TARGET, reason: 'view-not-assembled' };
      }
      trajectory.open(request);
      return { ok: true, target: TOOL_INSPECT_TARGET };
    },
    canInspect: () => trajectory !== null,
    inspectViewKey: () => trajectory?.key ?? null,
    registerTrajectoryView(consumer) {
      trajectory = consumer;
      let disposed = false;
      return () => {
        if (disposed) return; // 幂等 disposer
        disposed = true;
        if (trajectory === consumer) trajectory = null;
      };
    },
    clearFilePreview() {
      if (snapshot.filePreview === null) return;
      snapshot = EMPTY_STATE;
      emit();
    },
  };
}

/** 应用单例（右栏内容与工具卡共用同一条通路） */
export const toolNavigation: ToolNavigation = createToolNavigation();

const ToolNavigationContext = createContext<ToolNavigation>(toolNavigation);

export const ToolNavigationProvider = ToolNavigationContext.Provider;

/** 取跳转契约（未包 Provider 时 = 应用单例） */
export function useToolNavigation(): ToolNavigation {
  return useContext(ToolNavigationContext);
}

/** 订阅待打开文件状态（右栏文件预览分区用） */
export function useToolFilePreview(): ToolFilePreview | null {
  const navigation = useToolNavigation();
  const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  return state.filePreview;
}

/** 从工具卡数据折出跳转动作（只给已装配的入口；未装配的返回 undefined → 按钮不渲染） */
export function toolJumpActions(navigation: ToolNavigation): {
  openFile: (request: ToolFileOpenRequest) => ToolNavigationResult;
  inspect: ((request: ToolInspectRequest) => ToolNavigationResult) | undefined;
} {
  return {
    openFile: (request) => navigation.openFile(request),
    inspect: navigation.canInspect() ? (request) => navigation.inspect(request) : undefined,
  };
}
