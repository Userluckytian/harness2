// useTurnStream：把 runTurn 事件桥接进 React state，带 50ms 节流合并（一次真正重绘）。
// 完结 turn 直接落 lines（调用方 set）；流式中只有最后一块随 state 重绘，避免长会话闪烁。
import { useCallback, useRef, useState } from 'react';
import { summarizeArgs } from '../render.js';
import type { TurnStreamHandler } from '../chat-setup.js';

export interface ToolCallState {
  callId: string;
  tool: string;
  summary: string;
  /** 工具参数原始 JSON 串（供 DiffCard 解析变更片段，如 edit.old_text/new_text） */
  args: string;
  status: 'pending' | 'ok' | 'failed';
}

export interface TurnSnapshot {
  text: string;
  /** 当前 turn 流式累积的推理过程（仅 live；commit 后丢弃，因默认 off 且落定期退化） */
  reasoning: string;
  tools: ToolCallState[];
}

export interface UseTurnStream {
  /** 当前流式快照（未完结，随每次 flush 更新） */
  live: TurnSnapshot;
  /** 注册到 runUserTurn 的 onStream 回调（内部做节流合并） */
  handler: TurnStreamHandler;
  /** turn 结束后调用：把暂存的完整文本/工具卡片落定到 history（调用方持有 lines setter） */
  commit: () => TurnSnapshot;
  /** turn 开始前重置 */
  reset: () => void;
}

const FLUSH_MS = 50;

export function useTurnStream(onCommit: (snapshot: TurnSnapshot) => void): UseTurnStream {
  const [live, setLive] = useState<TurnSnapshot>({ text: '', reasoning: '', tools: [] });
  const bufferRef = useRef<TurnSnapshot>({ text: '', reasoning: '', tools: [] });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledRef = useRef(false);
  const toolsByIdRef = useRef(new Map<string, ToolCallState>());

  const scheduleFlush = useCallback(() => {
    if (scheduledRef.current || timerRef.current !== null) return;
    scheduledRef.current = true;
    timerRef.current = setTimeout(() => {
      scheduledRef.current = false;
      timerRef.current = null;
      setLive({
        text: bufferRef.current.text,
        reasoning: bufferRef.current.reasoning,
        tools: Array.from(toolsByIdRef.current.values()),
      });
    }, FLUSH_MS);
  }, []);

  const handler: TurnStreamHandler = useCallback((event) => {
    const buf = bufferRef.current;
    if (event.type === 'text-delta') {
      buf.text += event.text;
    } else if (event.type === 'reasoning-delta') {
      buf.reasoning += event.text;
    } else if (event.type === 'tool-call') {
      const summary = summarizeArgs(event.call.arguments);
      toolsByIdRef.current.set(event.call.id, {
        callId: event.call.id,
        tool: event.call.name,
        summary,
        args: event.call.arguments,
        status: 'pending',
      });
      buf.text += buf.text.length > 0 && !buf.text.endsWith('\n') ? '\n' : '';
      buf.text += `> ${event.call.name} (${summary})\n`;
    } else if (event.type === 'tool-result') {
      const existing = toolsByIdRef.current.get(event.callId);
      if (existing) {
        existing.status = event.ok ? 'ok' : 'failed';
        if (event.error) existing.summary = event.error;
      }
      buf.text += `\n< ${event.ok ? 'ok' : 'FAILED'} [${event.callId}]${event.error ? ` ${event.error}` : ''}\n`;
    }
    scheduleFlush();
  }, [scheduleFlush]);

  const commit = useCallback((): TurnSnapshot => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      scheduledRef.current = false;
    }
    const snapshot: TurnSnapshot = {
      text: bufferRef.current.text,
      reasoning: bufferRef.current.reasoning,
      tools: Array.from(toolsByIdRef.current.values()),
    };
    onCommit(snapshot);
    return snapshot;
  }, [onCommit]);

  const reset = useCallback(() => {
    bufferRef.current = { text: '', reasoning: '', tools: [] };
    toolsByIdRef.current.clear();
    setLive({ text: '', reasoning: '', tools: [] });
  }, []);

  return { live, handler, commit, reset };
}