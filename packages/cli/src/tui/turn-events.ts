// turn-events.ts —— turn 终态事件的纯函数层（无 React/渲染库依赖，供 next 壳与单测直接复用）。
//
// 职责：把 runTurn 的 TurnResult 与 live 流式快照收敛为 typed transcript 终态事件：
// - inferTextOutcome：终态判别（textOutcome 恒为权威，缺失时按 finalText/partialText 推断）；
// - terminalEvent：依冻结契约产出 turn-final / turn-partial / turn-empty。
//
// 流式增量缓冲与 handler 装配不在本层：next 壳自持 50ms 节流缓冲（createTurnStreamBridge），
// 本层只保留「纯函数便于单测」的判别与构造。
import type { TurnResult, TurnTextOutcome } from '@harness2/core';
import type { TranscriptEvent } from './transcript.js';

export interface TurnSnapshot {
  /** 本 turn 的真实 id（首个流式事件即已知；用于终态事件归属） */
  turnId: string | undefined;
  /** 当前 turn 流式累积正文（仅 live） */
  text: string;
  /** 当前 turn 流式累积推理（仅 provider 明确暴露的 reasoning-delta） */
  reasoning: string;
}

/**
 * 终态判别（冻结契约 docs/API-STABILITY.md）：
 * textOutcome 恒为权威；缺失时按 finalText/partialText 推断（兼容旧 serve 实例），
 * 两者皆空 → empty。finalText 与 partialText 互斥。
 */
export function inferTextOutcome(result: TurnResult | undefined): TurnTextOutcome {
  if (result?.textOutcome !== undefined) return result.textOutcome;
  if ((result?.finalText?.length ?? 0) > 0) return 'final';
  if ((result?.partialText?.length ?? 0) > 0) return 'partial';
  return 'empty';
}

/** 由 TurnResult + live 快照构造终态 transcript 事件（纯函数，便于单测） */
export function terminalEvent(result: TurnResult | undefined, live: TurnSnapshot): TranscriptEvent | null {
  if (result === undefined) return null;
  const turnId = result.turnId ?? live.turnId;
  const scope = turnId !== undefined && turnId.length > 0 ? { turnId } : {};
  const outcome = inferTextOutcome(result);
  if (outcome === 'final') {
    const text = result.finalText !== undefined && result.finalText.length > 0 ? result.finalText : live.text;
    return { type: 'turn-final', ...scope, text, ...(live.reasoning.length > 0 ? { reasoning: live.reasoning } : {}) };
  }
  if (outcome === 'partial') {
    const text = result.partialText !== undefined && result.partialText.length > 0 ? result.partialText : live.text;
    return {
      type: 'turn-partial',
      ...scope,
      text,
      ...(result.error !== undefined ? { error: result.error } : {}),
      stopReason: result.stopReason,
    };
  }
  return {
    type: 'turn-empty',
    ...scope,
    ...(result.error !== undefined ? { error: result.error } : {}),
    stopReason: result.stopReason,
  };
}
