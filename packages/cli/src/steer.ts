// CLI 侧 steer 纯函数与提交结转类型（T5）。
//
// 会话级 sink 本体已收敛到 core：`SessionSteerSink`（`interaction/steer-sink.ts`）自解冻窗口 #2
// 起由 `@harness2/core` 主入口加性导出（api-surface-baseline 已同步登记）。CLI 不再持有本地实现，
// 装配处（`chat-setup.ts`）直接 `new SessionSteerSink()`——语义（同 id 全局只生效一次、
// take 在安全 step 边界、resolve 回帧 accepted/stale/rejected、stale 带 draftKept）由 core 单一实现
// 保证，CLI 侧只保留**纯函数**（id 生成 / 请求构造 / 回帧文案）。
// steer 是纯控制输入，不写 session.log，不进投影正文。
import type { SteerRequest, SteerResult } from '@harness2/core';

/** steer id 序列号（会话内唯一；带时间戳避免跨进程碰撞） */
export function makeSteerId(seq: number, now: number = Date.now()): string {
  return `cli-steer-${now}-${seq}`;
}

/**
 * 构造 steer 请求（纯函数）：turnId 未知或文本空白 → null。
 * 调用方据此「保留草稿并报 unknown」，绝不猜一个 turnId。
 */
export function buildSteerRequest(turnId: string | undefined, id: string, text: string): SteerRequest | null {
  if (turnId === undefined || turnId.length === 0) return null;
  if (text.trim().length === 0) return null;
  return { id, expectedTurnId: turnId, text };
}

/** 提交结转（同步）：submitted = 已入队待 boundary；unknown/rejected = 草稿保留 */
export type SteerSubmitOutcome =
  | { state: 'submitted'; id: string; turnId: string; message: string }
  | { state: 'unknown'; reason: string; draftKept: true; message: string }
  | { state: 'rejected'; id?: string; reason: string; draftKept: true; message: string };

/** 回帧 → UI 报告文案（stale 必须体现「草稿已保留」） */
export function describeSteerResult(result: SteerResult): { line: string; draftKept: boolean } {
  switch (result.state) {
    case 'accepted':
      return { line: `steer 已接受（已在安全 step 边界应用；不写日志正文）`, draftKept: false };
    case 'stale':
      return {
        line: `steer 已过期（expectedTurnId 与当前 turn 不匹配）· 草稿已保留（未 abort/未自动重发）`,
        draftKept: result.draftKept ?? true,
      };
    default:
      return { line: `steer 被拒绝（重复 id 或应用窗口已关闭）· 草稿已保留`, draftKept: true };
  }
}
