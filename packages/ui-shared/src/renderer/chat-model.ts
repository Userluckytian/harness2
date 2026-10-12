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
  /** P3 契约：终态文本展示判别（final/partial/empty；旧 serve 缺省 → 由正文推断） */
  textOutcome?: 'final' | 'partial' | 'empty';
  /** P3-a：完整最终正文（仅 textOutcome='final'） */
  finalText?: string;
  /** P3-b：半截 attempt 文本（仅 textOutcome='partial'；展示须标注未完成/已中断） */
  partialText?: string;
  error?: string;
  warning?: string;
}

export interface ChatItem {
  kind: 'turn-header' | 'user' | 'assistant' | 'tool' | 'marker' | 'streaming' | 'turn-summary';
  /** turnId（turn-header/summary 与其归属消息相同；marker 仅 assistant/attempt 来源携带） */
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
  /** subagent 工具行：子会话 id（从 tool/result.output JSON 解析；桌面端据此跳转子会话 traj） */
  childSessionId?: string;
  // marker（Z-92 timelineMarker 真实子集）：variant 必填（三种来源事件各自固定）
  variant?: TimelineMarkerVariant;
  /** marker/compact：压缩摘要原文（展示层负责截断） */
  summary?: string;
  /** marker/checkpoint-restored：回退目标 seq */
  rewindToSeq?: number;
  // marker/retry-notice（原 attempt 行）与 turn-summary
  error?: string;
  // turn-summary
  durationMs?: number;
  stopReason?: string;
  warning?: string;
  /** P3：turn 终态文本判别 + 半截文本（partial 须标注「未完成/已中断」） */
  textOutcome?: 'final' | 'partial' | 'empty';
  partialText?: string;
}

/**
 * Z-92 `timelineMarker` 行的真实子集（Z3-07）。我们数据面只有三种来源事件，因此只实现
 * 三个变体；Z-92 其余变体无数据源、不实现（登记于交付报告）：
 *   - `forkNotice` / `forkCreated`：我们的 fork 是另起新会话（`forked` 帧 + 新会话日志），
 *     原会话不产生 fork 行事件；
 *   - `modelChange`：无 model-change 事件（模型由 run-config 固定）；
 *   - `goalSet` / `goalVerify`：无 goal 事件（计划态走 S7 plan-state 只读查询，非事件流）。
 * `assistant/attempt`（失败/被取消的模型尝试）映射为 `retry-notice`（Z-92 retryNotice 语义）。
 */
export type TimelineMarkerVariant = 'compact' | 'checkpoint-restored' | 'retry-notice';

/**
 * 工具名展示（阶段 8）：来源前缀区分——
 *   mcp__<server>__<tool> → 「[MCP:<server>] <tool>」；
 *   subagent_start / subagent_continue → 「[子会话] <name>」；
 *   其余本地/插件工具原样。
 */
export function displayToolName(tool: string | undefined): string {
  if (tool === undefined) return '';
  if (tool.startsWith('subagent_')) return `[子会话] ${tool}`;
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) return `[MCP:${rest.slice(0, sep)}] ${rest.slice(sep + 2)}`;
  }
  return tool;
}

/**
 * 轮次摘要耗时文案（P0-1，ZCode 风格）：`持续了 N 秒`。
 * N = `max(1, ceil(ms / 1000))` —— 与 ZCode `ConversationRowView` 的 `durationSeconds`
 * 口径一致（不足 1 秒按 1 秒计，避免出现「持续了 0 秒」）。
 * 无真实时长（undefined / <= 0）→ 返回 undefined：**不显示假值**（红线⑩）。
 */
export function formatTurnDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs <= 0) return undefined;
  return `持续了 ${Math.max(1, Math.ceil(durationMs / 1000))} 秒`;
}

/** 解析 subagent 工具 output JSON 中的 childSessionId（非 JSON / 缺字段 → undefined） */
export function parseSubagentChildId(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['childSessionId'] === 'string'
    ) {
      return (parsed as { childSessionId: string }).childSessionId;
    }
  } catch {
    // 非 JSON 输出（如失败结果）→ 无跳转
  }
  return undefined;
}

export function projectChatItems(
  events: readonly ActiveEvent[],
  live: LiveDelta,
  turnEnds: Readonly<Record<string, TurnEndInfo>>,
): ChatItem[] {
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
        // Z-92 retryNotice 语义（Z3-07）：失败/被取消的模型尝试以时间线错误标记呈现。
        // P3-b：半截文本仍以本事件为日志权威（append-only），展示须标注「未完成 / 已中断」。
        ensureTurnHeader(str(p['turnId']));
        items.push({
          kind: 'marker',
          variant: 'retry-notice',
          seq: e.seq,
          turnId: str(p['turnId']),
          error: str(p['error']),
          ...(typeof p['text'] === 'string' && p['text'].length > 0 ? { text: p['text'] } : {}),
        });
        break;
      }
      case 'compaction/applied': {
        // Z-92 compact 语义（Z3-07）：上下文压缩边界标记。摘要原文随行携带（coveredUpToSeq
        // 是模型上下文概念，对话流不展示），展示层负责单行截断。
        items.push({
          kind: 'marker',
          variant: 'compact',
          seq: e.seq,
          summary: str(p['summary']),
        });
        break;
      }
      case 'rewind/marker': {
        // Z-92 checkpointRestored 语义（Z3-07）：回退标记。标记自身是结构性事件（core 投影
        // 恒活动），历史行是否被遮蔽由 active 标志决定（重放来自服务端；live 由 applyEvent
        // 本地重折叠）。
        items.push({
          kind: 'marker',
          variant: 'checkpoint-restored',
          seq: e.seq,
          rewindToSeq: num(p['rewindToSeq']),
        });
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
        const output = p['output'] !== undefined ? str(p['output']) : undefined;
        const result = {
          ok: p['ok'] === true,
          ...(output !== undefined ? { output } : {}),
          ...(p['error'] !== undefined ? { error: str(p['error']) } : {}),
          ...(p['durationMs'] !== undefined ? { durationMs: num(p['durationMs']) } : {}),
        };
        if (item && item.kind === 'tool') {
          item.result = result;
          // subagent 工具：解析子会话 id 供跳转（桌面端 traj 深链）
          if (item.tool !== undefined && item.tool.startsWith('subagent_')) {
            item.childSessionId = parseSubagentChildId(output);
          }
        }
        // 找不到宿主（异常日志）也不丢结果：单独成行
        else {
          const orphan: ChatItem = {
            kind: 'tool',
            callId: str(p['callId']),
            seq: e.seq,
            turnId: str(p['turnId']),
            tool: str(p['tool']),
            result,
          };
          if (orphan.tool !== undefined && orphan.tool.startsWith('subagent_')) {
            orphan.childSessionId = parseSubagentChildId(output);
          }
          items.push(orphan);
        }
        break;
      }
      case 'step/end': {
        currentDurationMs += p['durationMs'] === undefined ? 0 : num(p['durationMs']);
        break;
      }
      default:
        break; // header / step-start 不产生条目（memory/snapshot 走通用兜底口径，也不产条目）
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
        ? {
            stopReason: end.stopReason,
            ...(end.textOutcome !== undefined ? { textOutcome: end.textOutcome } : {}),
            ...(end.partialText !== undefined ? { partialText: end.partialText } : {}),
            ...(end.error !== undefined ? { error: end.error } : {}),
            ...(end.warning !== undefined ? { warning: end.warning } : {}),
          }
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
  // Z3-07：rewind/marker 到达时本地重折叠（与 core reader.computeProjection 同语义）——
  // undo/redo 只追加标记事件，客户端缓冲里被遮蔽事件仍带 active=true；不重折叠会让
  // undo 后的转录继续显示已被撤回的行（假状态）。重放路径由服务端 active 标志整体替换，不经过这里。
  if (event.type === 'rewind/marker') return { events: refoldShadowing(next), lastSeq: event.seq };
  return { events: next, lastSeq: event.seq };
}

/**
 * 对缓冲事件集重算回退遮蔽（与 core `session/reader.computeProjection` 单调并集 + redo 链
 * 中立化同语义，只是输入输出换成渲染端缓冲）：
 *   - 每个 rewind/marker 追溯遮蔽「标记之前已出现且 seq > rewindToSeq」的非标记事件；
 *   - reason 以 'redo' 开头的标记额外中立化 seq = rewindToSeq + 1 处的标记（undo/redo 约定
 *     redo.rewindToSeq = 被重做 undo 标记的 seq - 1），恢复该层的遮蔽贡献；
 *   - 标记自身恒活动（结构性事件）；标记之后新追加的事件属于新分支、默认活动。
 * 纯函数：不修改输入数组。
 */
export function refoldShadowing(events: readonly ActiveEvent[]): ActiveEvent[] {
  interface MarkerRule {
    seq: number;
    targets: Set<number>; // 该标记遮蔽的非标记事件 seq
    neutralized: boolean;
  }
  const rules: MarkerRule[] = [];
  const seen: ActiveEvent[] = [];
  for (const item of events) {
    if (item.type === 'rewind/marker') {
      const p = item.payload as Record<string, unknown>;
      const n = num(p['rewindToSeq']);
      if (str(p['reason']).startsWith('redo')) {
        // redo 链：中立化 seq = n+1 处的标记（undo/redo 约定的被重做 undo 标记）
        const victimSeq = n + 1;
        for (const rule of rules) {
          if (rule.seq === victimSeq) rule.neutralized = true;
        }
      }
      const targets = new Set<number>();
      for (const s of seen) {
        if (s.seq > n && s.type !== 'rewind/marker') targets.add(s.seq);
      }
      rules.push({ seq: item.seq, targets, neutralized: false });
    }
    seen.push(item);
  }
  const shadowed = new Set<number>();
  for (const rule of rules) {
    if (rule.neutralized) continue;
    for (const t of rule.targets) shadowed.add(t);
  }
  return events.map((item) => ({ ...item, active: item.type === 'rewind/marker' || !shadowed.has(item.seq) }));
}
