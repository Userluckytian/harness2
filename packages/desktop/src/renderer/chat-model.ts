// 对话视图纯模型：会话事件流 → 渲染条目（ChatItem）。
// 设计：SessionStream 持原始事件（含 active 标记）+ 在途增量（live）+ turn 终态；
// ChatItem 每次由 projectChatItems 派生——重放（/events 全量）、影子过滤（active=false 不显示）、
// undo 后重折叠（rewind 标记到达即事件集变化）全部天然成立，无增量修补路径。
// delta 一致性约束：assistant/message 落盘事件应用时清空在途 text/reasoning
// （WS 契约保证 delta 拼接 === 落盘文本，最终显示以落盘事件为准）。
import type { SessionEventShape, ToolCallShape } from '../shared/protocol.js';

export type ActiveEvent = SessionEventShape & { active: boolean };

/** 在途增量（未落盘；turn 内逐片累积，落盘事件到达即清空对应部分） */
export interface LiveDelta {
  text: string;
  reasoning: string;
  /** provider 已发出、尚未落盘 tool/call 的调用 */
  toolCalls: ToolCallShape[];
}

export function emptyLive(): LiveDelta {
  return { text: '', reasoning: '', toolCalls: [] };
}

export interface TurnEndInfo {
  stopReason: string;
  error?: string;
  warning?: string;
}

export interface ChatItem {
  kind: 'turn-header' | 'user' | 'assistant' | 'tool' | 'attempt' | 'streaming' | 'turn-summary';
  /** turnId（turn-header/summary 与其归属消息相同） */
  turnId?: string;
  seq?: number;
  // user / assistant / streaming
  text?: string;
  reasoning?: string;
  model?: string;
  // assistant 流式光标标记
  streaming?: boolean;
  // tool
  callId?: string;
  tool?: string;
  args?: unknown;
  result?: { ok: boolean; output?: string; error?: string; durationMs?: number };
  // attempt
  error?: string;
  // turn-summary
  durationMs?: number;
  stopReason?: string;
  warning?: string;
}

export function projectChatItems(events: readonly ActiveEvent[], live: LiveDelta, turnEnds: Readonly<Record<string, TurnEndInfo>>): ChatItem[] {
  const items: ChatItem[] = [];
  let currentTurnId: string | undefined;
  let currentDurationMs = 0;
  const toolIndex = new Map<string, number>(); // callId → items 下标

  const ensureTurnHeader = (turnId: string | undefined): void => {
    if (turnId === undefined || turnId === currentTurnId) return;
    currentTurnId = turnId;
    currentDurationMs = 0;
    items.push({ kind: 'turn-header', turnId });
  };

  for (const e of events) {
    if (!e.active) continue; // 影子事件不显示（undo 后重折叠天然生效）
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'user/message': {
        ensureTurnHeader(str(p['turnId']));
        items.push({ kind: 'user', seq: e.seq, turnId: str(p['turnId']), text: str(p['text']) });
        break;
      }
      case 'assistant/message': {
        ensureTurnHeader(str(p['turnId']));
        items.push({
          kind: 'assistant',
          seq: e.seq,
          turnId: str(p['turnId']),
          text: str(p['text']),
          ...(p['reasoning'] !== undefined ? { reasoning: str(p['reasoning'] as string) } : {}),
          ...(p['model'] !== undefined ? { model: str(p['model']) } : {}),
        });
        break;
      }
      case 'assistant/attempt': {
        ensureTurnHeader(str(p['turnId']));
        items.push({ kind: 'attempt', seq: e.seq, turnId: str(p['turnId']), error: str(p['error']) });
        break;
      }
      case 'tool/call': {
        ensureTurnHeader(str(p['turnId']));
        toolIndex.set(str(p['callId']), items.length);
        items.push({
          kind: 'tool',
          callId: str(p['callId']),
          seq: e.seq,
          turnId: str(p['turnId']),
          tool: str(p['tool']),
          ...(p['args'] !== undefined ? { args: p['args'] } : {}),
        });
        break;
      }
      case 'tool/result': {
        const idx = toolIndex.get(str(p['callId']));
        const item = idx !== undefined ? items[idx] : undefined;
        const result = {
          ok: p['ok'] === true,
          ...(p['output'] !== undefined ? { output: str(p['output']) } : {}),
          ...(p['error'] !== undefined ? { error: str(p['error']) } : {}),
          ...(p['durationMs'] !== undefined ? { durationMs: num(p['durationMs']) } : {}),
        };
        if (item && item.kind === 'tool') item.result = result;
        // 找不到宿主（异常日志）也不丢结果：单独成行
        else items.push({ kind: 'tool', callId: str(p['callId']), seq: e.seq, turnId: str(p['turnId']), tool: str(p['tool']), result });
        break;
      }
      case 'step/end': {
        currentDurationMs += p['durationMs'] === undefined ? 0 : num(p['durationMs']);
        break;
      }
      default:
        break; // header / step-start / rewind 不产生条目
    }
  }

  const lastTurnId = currentTurnId;
  // turn 摘要（优先取运行时 turn-end 终态；纯重放没有 stopReason，只有耗时）
  if (lastTurnId !== undefined) {
    const end = turnEnds[lastTurnId];
    items.push({
      kind: 'turn-summary',
      turnId: lastTurnId,
      durationMs: currentDurationMs,
      ...(end !== undefined
        ? { stopReason: end.stopReason, ...(end.error !== undefined ? { error: end.error } : {}), ...(end.warning !== undefined ? { warning: end.warning } : {}) }
        : {}),
    });
  }

  // 在途增量（流式光标）：provider 已产出、尚未落盘的内容
  if (live.toolCalls.length > 0) {
    for (const call of live.toolCalls) {
      items.push({ kind: 'streaming', tool: call.name, callId: call.id, args: safeArgs(call.arguments) });
    }
  }
  if (live.text.length > 0 || live.reasoning.length > 0) {
    items.push({
      kind: 'streaming',
      text: live.text,
      ...(live.reasoning.length > 0 ? { reasoning: live.reasoning } : {}),
      streaming: true,
    });
  }
  return items;
}

/** 从事件流统计 turn 摘要需的 turnId 列表等（预留；当前直接内联在 project 内） */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
function safeArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// —— 重放与去重 ——

/**
 * 切换会话的重放合并：/events 全量 vs 当前已缓冲事件。
 * - 服务响应 lastSeq < 已缓冲 lastSeq → 陈旧响应，丢弃（保持现有缓冲）
 * - 否则以服务响应为准整体替换（响应里可能含 undo 后的影子标记信息，须整体重折叠）
 * 返回 null = 不应用。
 */
export function mergeReplay(
  existingLastSeq: number,
  payload: { lastSeq: number; events: Array<SessionEventShape & { active: boolean }> },
): Array<SessionEventShape & { active: boolean }> | null {
  if (payload.lastSeq < existingLastSeq) return null;
  // seq 排序防御（服务端保证有序；重放路径仍按 seq 稳定排序）
  const sorted = [...payload.events].sort((a, b) => a.seq - b.seq);
  return sorted;
}

/** 应用单条落盘事件（订阅增量路径）：重复/落后 seq 忽略，返回新数组（或 null = 忽略） */
export function applyEvent(
  events: readonly ActiveEvent[],
  lastSeq: number,
  event: SessionEventShape,
): { events: ActiveEvent[]; lastSeq: number } | null {
  if (event.seq <= lastSeq) return null; // 重放已覆盖
  const next = [...events, { ...event, active: true }];
  return { events: next, lastSeq: event.seq };
}
