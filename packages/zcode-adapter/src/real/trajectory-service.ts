/**
 * trajectory-service —— ZS4-T5 轨迹降级投影
 *
 * harness2 core 的会话 JSONL 日志**不记录 model-io**（无逐次模型请求的完整上下文落盘），
 * 而 ZCode UI 的 `ModelTrajectoryPane` 期望 `ZCodeModelTrajectory`（request.messages 完整上下文等）。
 * 红线⑩：core 没有 model-io 能力，不得造假条目/伪造数据形状冒充；因此如实降级：
 *   - available: false（runtime 不支持读取 model-io 轨迹）
 *   - records: []（无记录可投影）
 *   - truncated: false（limit 收下不使用，无记录可截断）
 *   - sourceFiles: 用 manager.locate(taskId) 得到的真实会话目录；locate 抛错（会话不存在）
 *     → []，不 throw，UI 走空态兜底。
 *   - taskId 回显。
 */
import type { ZCodeModelTrajectory } from '@zcode/services';

export function buildModelTrajectory(
  manager: { locate: (taskId: string, opts?: { cwd?: string }) => string },
  taskId: string,
  _limit?: number,
): ZCodeModelTrajectory {
  let sourceFiles: string[] = [];
  try {
    const dir = manager.locate(taskId);
    if (typeof dir === 'string' && dir.length > 0) sourceFiles = [dir];
  } catch {
    sourceFiles = [];
  }
  return {
    taskId,
    available: false,
    records: [],
    sourceFiles,
    truncated: false,
  };
}
