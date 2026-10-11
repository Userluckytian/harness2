// 「在右栏打开后台任务」请求通道（Z2-08 状态面板 Agents 子块 → 右栏 tab 的轻联动）。
//
// 为什么是通道而不是直接调 store/frame：状态面板（ui-shared）只暴露 `onOpenTasksPane` 回调缝，
// 不抓宿主的帧上下文（右栏开合是 AppFrame 的 React state，组件外拿不到 dispatch）。
// 装配层（conversation/assembly.tsx）把回调接到本通道 `request()`；右栏宿主
//（components/SidePanel.tsx）订阅同一通道，消费时负责**两件事**：
//   1. 打开/激活右栏的 `background-tasks` tab（sidePaneStore，按它自己的会话桶）；
//   2. 右栏收着就展开（不静默丢请求）—— 与 D-86 ② trajectory focus 的消费方式同款。
// 数据只在内存、只在进程内（D-14：不落任何浏览器存储）。请求无载荷：快照对象每次 request
// 产生**新引用**，消费方据引用判新（同一手法：ToolFilePreview / TrajectoryFocusRequest）。
export interface BackgroundTasksPaneRequest {
  /** 请求时刻（ms epoch；仅用于快照身份，不参与判定） */
  readonly at: number;
}

export interface BackgroundTasksPaneRequestChannel {
  /** 发一次打开请求（重复请求产生新快照引用，消费方逐条响应） */
  request(): void;
  /** 最近一条请求（无 = null）；快照引用稳定 */
  getSnapshot(): BackgroundTasksPaneRequest | null;
  subscribe(listener: () => void): () => void;
}

export function createBackgroundTasksPaneRequestChannel(): BackgroundTasksPaneRequestChannel {
  let snapshot: BackgroundTasksPaneRequest | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    request() {
      snapshot = Object.freeze({ at: Date.now() });
      emit();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 应用单例（装配层生产、右栏宿主消费共用同一条内存态） */
export const backgroundTasksPaneRequests: BackgroundTasksPaneRequestChannel = createBackgroundTasksPaneRequestChannel();
