// D-86 ② 的**定位**通道（P2-5）：工具卡 `inspect` 请求带 `callId` / `seq` —— 打开轨迹时
// 必须定位到对应记录（选中该行、必要时滚动过去），而不是只切一个空标签页。
//
// 为什么用注入缝（`TrajectoryFocusStore`）而不是跨层 import：
//   `tool`（消费者注册方）与 `trajectory`（视图）互不依赖 —— 装配层 `conversation/assembly.tsx`
//   两处各接一次（注册消费者时 `request()`，创建视图定义时把同一 store 交给视图读）。
//   数据只在内存、只在进程内（D-14：不落任何浏览器存储）。
import type { TrajectoryModel } from './types.js';

/** 一次 inspect 的定位请求（与会话绑定；`callId` 优先于 `seq`） */
export interface TrajectoryFocusRequest {
  readonly sessionId: string;
  readonly callId?: string;
  readonly seq?: number;
}

export interface TrajectoryFocusStore {
  /** 记下待定位请求（覆盖上一条） */
  request(req: TrajectoryFocusRequest): void;
  /** 最近一条请求（无 = null）；快照引用稳定 */
  getSnapshot(): TrajectoryFocusRequest | null;
  subscribe(listener: () => void): () => void;
  /** 清空（消费后 / 测试） */
  clear(): void;
}

export function createTrajectoryFocusStore(): TrajectoryFocusStore {
  let snapshot: TrajectoryFocusRequest | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    request(req) {
      snapshot = Object.freeze({
        sessionId: req.sessionId,
        ...(req.callId !== undefined ? { callId: req.callId } : {}),
        ...(req.seq !== undefined ? { seq: req.seq } : {}),
      });
      emit();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      if (snapshot === null) return;
      snapshot = null;
      emit();
    },
  };
}

/**
 * 请求 → 目标行键（纯函数）。
 * 只认**真实存在**的步骤行：先按 `callId` 精确匹配，再退回 `seq`；
 * 会话不匹配或都找不到 → null（不猜，不选中任意一行）。
 */
export function findFocusRowKey(
  model: TrajectoryModel,
  request: TrajectoryFocusRequest | null,
  sessionId: string,
): string | null {
  if (request === null || request.sessionId !== sessionId) return null;
  const steps = model.rows.filter((row) => row.kind === 'step');
  if (request.callId !== undefined) {
    const byCall = steps.find((row) => row.step.callId === request.callId);
    if (byCall !== undefined) return byCall.key;
  }
  if (request.seq !== undefined) {
    const bySeq = steps.find((row) => row.step.seq === request.seq);
    if (bySeq !== undefined) return bySeq.key;
  }
  return null;
}
