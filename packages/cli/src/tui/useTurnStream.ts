// useTurnStream（T3/T4）：把 runTurn 流式事件桥接为 typed transcript 事件，带稳定身份与 turnId。
// - tool-call/tool-result 立即经 onTranscriptEvent 交给 shell 的 transcriptReducer（卡片落定后仍可展开）；
// - T4 step 顺序保真：tool-call（或推理边界）到达前累积的正文先 flush 为该 step 的独立 assistant item
//   （id 以 turnId+stepIndex 为作用域），再落工具项；后续文本另起一段——`解释→工具→解释` 不再塌成一块；
// - text/reasoning 增量仍 50ms 节流合并进 live 快照（一次真正重绘，长流不抖动）；
// - finalize(TurnResult) 依冻结的 textOutcome 生成 final|partial|empty 终态事件（缺省按 finalText/partialText 推断）。
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const stepIndexRef = useRef(0);
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

  /**
   * 把当前累积正文 flush 为该 step 的独立 assistant item（有正文或有推理才发，避免空气泡）。
   * 返回是否真的发出了 item；发出后清空文本缓冲、step 计数 +1、并同步 live 快照（避免与已落定项重复显示）。
   */
  const flushStep = useCallback((): boolean => {
    const buf = bufferRef.current;
    const hasText = buf.text.trim().length > 0;
    const hasReasoning = buf.reasoning.trim().length > 0;
    if (!hasText && !hasReasoning) return false;
    const stepIndex = stepIndexRef.current;
    stepIndexRef.current += 1;
    onEventRef.current({
      type: 'assistant/step',
      ...(buf.turnId !== undefined ? { turnId: buf.turnId } : {}),
      stepIndex,
      text: hasText ? buf.text : '',
      ...(hasReasoning ? { reasoning: buf.reasoning } : {}),
    });
    buf.text = '';
    buf.reasoning = '';
    clearTimer();
    setLive({ ...buf });
    return true;
  }, [clearTimer]);

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
        // 顺序保真：先落本 step 正文，再落工具项（后续文本另起一段）
        flushStep();
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
    [scheduleFlush, flushStep],
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
    stepIndexRef.current = 0;
    bufferRef.current = { turnId: undefined, text: '', reasoning: '' };
    setLive({ turnId: undefined, text: '', reasoning: '' });
  }, [clearTimer]);

  // 卸载清理（审查 P2）：挂起中的 50ms flush timer 必须随组件卸载取消，
  // 否则 ink 卸载后仍会 setLive 一次（悬挂 timer + 无效重渲）。
  useEffect(() => () => clearTimer(), [clearTimer]);

  return { live, handler, finalize, reset };
}
