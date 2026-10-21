/**
 * v4-projection —— core 事件 → v4 conversation rows/frames（ZS2-T2）
 *
 * 输入：core 落盘事件流（AnySessionEvent[]）+ 可选 hub 回调增量。
 * 输出：投影行（kind/text/state）与控制相位/usage/meta 状态键。
 *
 * 未覆盖事件按映射详表 §3.5「可丢弃」清单如实处理（memory/snapshot、nudge、step/*）。
 */
import type { AnySessionEvent } from '@harness2/core';

export type ProjectedRowKind = 'turnHeader' | 'userInput' | 'assistantText' | 'reasoning' | 'toolCall';

export interface ProjectedRow {
  rowId: number; // = seq 空间
  kind: ProjectedRowKind;
  turnId?: string;
  text?: string;
  state?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: 'running' | 'success' | 'error';
  toolOutput?: string;
  createdAtSeq: number;
}

export interface ProjectionState {
  controlPhase: 'running' | 'completedSuccess' | 'completedInterrupted' | 'error';
  usage: { inputTokens: number; outputTokens: number };
  title: string;
}

export interface ProjectionResult {
  rows: ProjectedRow[];
  state: ProjectionState;
  lastSeq: number;
}

function stopReasonToPhase(sr: string | undefined): ProjectionState['controlPhase'] {
  if (!sr) return 'running';
  if (sr === 'end_turn') return 'completedSuccess';
  if (sr === 'cancelled') return 'completedInterrupted';
  if (sr === 'error') return 'error';
  return 'completedSuccess';
}

/**
 * 将 core 事件流投影为行 + 状态。rowId = 事件 seq（单调）。
 */
export function projectEvents(events: AnySessionEvent[]): ProjectionResult {
  const rows: ProjectedRow[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let title = '';
  let lastPhase: ProjectionState['controlPhase'] = 'running';

  // 先按 seq 排序
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  // rowId 分配：每行唯一整数，事件 seq 为基，同事件多行用稳定偏移；全局单调。
  let rowCounter = 0;
  const allocRowId = (seq: number): number => {
    if (seq > rowCounter) rowCounter = seq - 1;
    rowCounter += 1;
    if (rowCounter < seq) rowCounter = seq;
    return rowCounter;
  };

  for (const e of sorted) {
    switch (e.type) {
      case 'user/message': {
        const p = e.payload as { text: string; turnId?: string };
        rows.push({
          rowId: allocRowId(e.seq),
          kind: 'userInput',
          turnId: p.turnId,
          text: p.text,
          state: 'complete',
          createdAtSeq: e.seq,
        });
        // turnHeader 合成：由 user/message 触发
        rows.push({
          rowId: allocRowId(e.seq),
          kind: 'turnHeader',
          turnId: p.turnId,
          state: 'running',
          createdAtSeq: e.seq,
        });
        break;
      }
      case 'assistant/message': {
        const p = e.payload as {
          text: string;
          model?: string;
          usage?: { inputTokens?: number; outputTokens?: number };
          reasoning?: string;
          turnId?: string;
        };
        if (p.reasoning) {
          rows.push({
            rowId: allocRowId(e.seq),
            kind: 'reasoning',
            turnId: p.turnId,
            text: p.reasoning,
            state: 'complete',
            createdAtSeq: e.seq,
          });
        }
        rows.push({
          rowId: allocRowId(e.seq),
          kind: 'assistantText',
          turnId: p.turnId,
          text: p.text,
          state: 'complete',
          createdAtSeq: e.seq,
        });
        if (p.usage) {
          inputTokens += p.usage.inputTokens ?? 0;
          outputTokens += p.usage.outputTokens ?? 0;
        }
        break;
      }
      case 'assistant/attempt': {
        const p = e.payload as { error: string; text?: string; model?: string; turnId?: string };
        rows.push({
          rowId: allocRowId(e.seq),
          kind: 'assistantText',
          turnId: p.turnId,
          text: p.text ?? '',
          state: 'failed',
          createdAtSeq: e.seq,
        });
        break;
      }
      case 'tool/call': {
        const p = e.payload as { callId: string; tool: string; args?: unknown; turnId?: string };
        rows.push({
          rowId: allocRowId(e.seq),
          kind: 'toolCall',
          turnId: p.turnId,
          toolName: p.tool,
          toolCallId: p.callId,
          toolStatus: 'running',
          createdAtSeq: e.seq,
        });
        break;
      }
      case 'tool/result': {
        const p = e.payload as { callId: string; ok: boolean; output?: string; error?: string; turnId?: string };
        // upsert the matching toolCall row → mark success/error
        const target = rows.find((r) => r.kind === 'toolCall' && r.toolCallId === p.callId);
        if (target) {
          target.toolStatus = p.ok ? 'success' : 'error';
          target.toolOutput = p.ok ? p.output : p.error;
          target.state = p.ok ? 'success' : 'error';
        }
        break;
      }
      case 'session/header': {
        // no row; meta.title handled separately (titles not in event). Mark.
        break;
      }
      // 可丢弃：memory/snapshot, compaction/applied, rewind/marker, step/*, nudge
      default: {
        // 无对应 row——按 §3.5 可丢弃，不伪造
        break;
      }
    }
  }

  // control phase: need turn end stopReason. If no explicit, infer from last assistant.
  // We don't have stopReason in events; default completedSuccess if any assistant message.
  lastPhase = rows.some((r) => r.kind === 'assistantText' && r.state === 'failed')
    ? 'error'
    : rows.length > 0
      ? 'completedSuccess'
      : 'running';

  const lastSeq = sorted.length ? sorted[sorted.length - 1].seq : 0;

  return {
    rows,
    state: {
      controlPhase: lastPhase,
      usage: { inputTokens, outputTokens },
      title,
    },
    lastSeq,
  };
}

/**
 * 投影控制相位（由 onTurnEnd.stopReason 映射）。
 */
export function stopReasonToControlPhase(sr: string): ProjectionState['controlPhase'] {
  return stopReasonToPhase(sr);
}
