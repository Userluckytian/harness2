// useTurnStream（T3）：把 runTurn 流式事件桥接为 typed transcript 事件，带稳定身份与 turnId。
// - tool-call/tool-result 立即经 onTranscriptEvent 交给 shell 的 transcriptReducer（卡片落定后仍可展开）；
// - text/reasoning 增量仍 50ms 节流合并进 live 快照（一次真正重绘，长流不抖动）；
// - finalize(TurnResult) 依冻结的 textOutcome 生成 final|partial|empty 终态事件（缺省按 finalText/partialText 推断）。
import { useCallback, useRef, useState } from 'react';
import type { TurnResult, TurnTextOutcome } from '@harness2/core';
import { summarizeArgs } from '../render.js';
import type { TurnStreamHandler } from '../chat-setup.js';
import type { TranscriptEvent } from './transcript.js';

export interface TurnSnapshot {
  /** 本 turn 的真实 id（首个流式事件即已知；用于终态事件归属） */
  turnId: string | undefined;
  /** 当前 turn 流式累积正文（仅 live） */
  text: string;
  /** 当前 turn 流式累积推理（仅 provider 明确暴露的 reasoning-delta） */
  reasoning: string;
}

export interface UseTurnStream {
  /** 当前流式快照（未完结，随每次 flush 更新） */
  live: TurnSnapshot;
  /** 注册到 runUserTurn 的 onStream 回调（内部节流合并 + typed 事件分发） */
  handler: TurnStreamHandler;
  /** turn 结束后调用：返回终态 transcript 事件（final/partial/empty）；无结果返回 null */
  finalize: (result: TurnResult | undefined) => TranscriptEvent | null;
  /** turn 开始前/结束后重置 live 缓冲 */
  reset: () => void;
}

const FLUSH_MS = 50;

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

export function useTurnStream(onTranscriptEvent: (event: TranscriptEvent) => void): UseTurnStream {
  const [live, setLive] = useState<TurnSnapshot>({ turnId: undefined, text: '', reasoning: '' });
  const bufferRef = useRef<TurnSnapshot>({ turnId: undefined, text: '', reasoning: '' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledRef = useRef(false);
  const onEventRef = useRef(onTranscriptEvent);
  onEventRef.current = onTranscriptEvent;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    scheduledRef.current = false;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (scheduledRef.current || timerRef.current !== null) return;
    scheduledRef.current = true;
    timerRef.current = setTimeout(() => {
      scheduledRef.current = false;
      timerRef.current = null;
      setLive({ ...bufferRef.current });
    }, FLUSH_MS);
  }, []);

  const handler: TurnStreamHandler = useCallback(
    (event) => {
      const buf = bufferRef.current;
      if (event.type === 'text-delta') {
        buf.turnId = event.turnId;
        buf.text += event.text;
        scheduleFlush();
        return;
      }
      if (event.type === 'reasoning-delta') {
        buf.turnId = event.turnId;
        buf.reasoning += event.text;
        scheduleFlush();
        return;
      }
      if (event.type === 'tool-call') {
        buf.turnId = event.turnId;
        onEventRef.current({
          type: 'tool/call',
          seq: 0,
          callId: event.call.id,
          tool: event.call.name,
          args: event.call.arguments,
          summary: summarizeArgs(event.call.arguments),
          turnId: event.turnId,
        });
        return;
      }
      // tool-result
      buf.turnId = event.turnId;
      onEventRef.current({
        type: 'tool/result',
        callId: event.callId,
        ok: event.ok,
        ...(event.error !== undefined ? { error: event.error } : {}),
        turnId: event.turnId,
      });
    },
    [scheduleFlush],
  );

  const finalize = useCallback(
    (result: TurnResult | undefined): TranscriptEvent | null => {
      clearTimer();
      return terminalEvent(result, bufferRef.current);
    },
    [clearTimer],
  );

  const reset = useCallback(() => {
    clearTimer();
    bufferRef.current = { turnId: undefined, text: '', reasoning: '' };
    setLive({ turnId: undefined, text: '', reasoning: '' });
  }, [clearTimer]);

  return { live, handler, finalize, reset };
}
