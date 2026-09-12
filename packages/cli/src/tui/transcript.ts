// T3 typed transcript（纯模型，无 ink/react 依赖）：
// - 结构事件身份：稳定 id（由 seq / callId / turnId 派生，重投影幂等）
// - transcriptReducer：消费 core 会话事件与流式/终态事件；tool call↔result 按 callId 原地合并
// - projectSession：从磁盘会话日志重投影（只读 core 的 loadSession/computeProjection）
// - computeViewport / transcriptHeightCache：长历史虚拟化 viewport 与高度缓存
//
// 冻结语义（docs/API-STABILITY.md「跨端展示语义」）：
//   assistant/message → assistant(outcome:'final')
//   assistant/attempt 有正文 → partial（渲染须标「未完成 / 已中断」+ stopReason/error）
//   失败且无正文 → empty（只渲染 stopReason/error 与已执行工具行，禁止空白气泡）
//   finalText 与 partialText 互斥，textOutcome 是唯一判别。
import { computeProjection, loadSession, SUBAGENT_TOOL_NAMES, type AnySessionEvent } from '@harness2/core';
import { summarizeArgs } from '../render.js';
import { displayWidth } from './input.js';

/** 已落定的结构条目（判别联合；id 稳定，供展开态/高度缓存按 id 引用） */
export type TranscriptItem =
  | { kind: 'user'; id: string; seq: number; text: string }
  | { kind: 'assistant'; id: string; seq: number; text: string; outcome: 'final'; reasoning?: string }
  | { kind: 'partial'; id: string; seq: number; text: string; error: string; stopReason?: string }
  | { kind: 'empty'; id: string; seq: number; error?: string; stopReason?: string }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      tool: string;
      args?: string;
      summary: string;
      status: 'pending' | 'ok' | 'failed';
      output?: string;
      error?: string;
      /** T1：subagent_start/subagent_continue 的结果 JSON 中可解析出的子会话 id（解析不到就不存在） */
      childSessionId?: string;
    }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'status'; id: string; text: string };

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

export interface TranscriptState {
  items: TranscriptItem[];
  readonly byId: Map<string, number>;
}

export function emptyTranscript(): TranscriptState {
  return stateWith([]);
}

/**
 * 构造 TranscriptState：byId 惰性构建（首次访问才建 Map 并缓存）。
 * 长历史重投影会逐事件产生数千次 append；若每次 append 都 `new Map(state.byId)` 克隆，
 * 就是 O(n²)（万级事件下实测单 reduce 逾 500ms，逼近 1.5s 性能预算）。
 * 惰性索引让 reducer 全程只做「数组追加 + 反查」，Map 仅在读取时构建一次，
 * 同时保持 reducer 纯函数语义（不原地改旧 state 的 items/byId，React updater 可安全重放）。
 */
function stateWith(items: TranscriptItem[]): TranscriptState {
  let cached: Map<string, number> | undefined;
  return {
    items,
    get byId(): Map<string, number> {
      if (cached === undefined) {
        cached = new Map();
        for (let i = 0; i < items.length; i += 1) cached.set(items[i]!.id, i);
      }
      return cached;
    },
  };
}

/** 从尾向前查找 id 的数组下标（-1 = 不存在）；tool/result 紧跟 tool/call，尾部命中更快 */
function findItemIndex(items: TranscriptItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.id === id) return i;
  }
  return -1;
}

/**
 * reducer 输入事件：
 * - core 会话事件语义（seq 权威，用于 projectSession 与落定）
 * - 流式 tool 事件（callId 稳定身份）
 * - turn 终态事件（final/partial/empty，来自 TurnResult 的 textOutcome 投影）
 * - shell 文本（system/status；显式 id 时幂等 upsert）
 */
export type TranscriptEvent =
  | { type: 'user/message'; seq: number; text: string; turnId?: string; id?: string }
  | { type: 'assistant/message'; seq: number; text: string; reasoning?: string; turnId?: string; id?: string }
  | {
      type: 'assistant/attempt';
      seq: number;
      text?: string;
      error: string;
      turnId?: string;
      stopReason?: string;
      id?: string;
    }
  | { type: 'tool/call'; seq: number; callId: string; tool: string; args?: string; summary?: string; turnId?: string }
  | {
      type: 'tool/result';
      seq?: number;
      callId: string;
      tool?: string;
      ok: boolean;
      output?: string;
      error?: string;
      turnId?: string;
    }
  | {
      /** T4：step 边界的完整正文（工具/推理分隔出的中间 assistant 段）；id = turnId+stepIndex 稳定 */
      type: 'assistant/step';
      turnId?: string;
      stepIndex: number;
      text: string;
      reasoning?: string;
    }
  | { type: 'turn-final'; turnId?: string; seq?: number; text: string; reasoning?: string }
  | { type: 'turn-partial'; turnId?: string; seq?: number; text: string; error?: string; stopReason?: string }
  | { type: 'turn-empty'; turnId?: string; seq?: number; error?: string; stopReason?: string }
  | { type: 'system'; text: string; id?: string }
  | { type: 'status'; text: string; id?: string };

function scopedId(
  kind: string,
  seq: number | undefined,
  turnId: string | undefined,
  explicit: string | undefined,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (turnId !== undefined && turnId.length > 0) return `${kind}:${turnId}`;
  return `${kind}:${seq ?? 0}`;
}

/** 按 id 追加或原地替换（惰性 byId 见 stateWith；未变化时复用 items） */
function put(state: TranscriptState, item: TranscriptItem): TranscriptState {
  const idx = findItemIndex(state.items, item.id);
  if (idx < 0) return stateWith(state.items.concat(item));
  const items = state.items.slice();
  items[idx] = item;
  return stateWith(items);
}

/** subagent 工具名判定（与 core SUBAGENT_TOOL_NAMES 同源，避免 CLI 侧硬编码漂移） */
export function isSubagentTool(tool: string | undefined): boolean {
  return tool !== undefined && SUBAGENT_TOOL_NAMES.includes(tool as never);
}

/**
 * T1：从 subagent 工具结果 output（JSON）解析子会话 id。
 * 只认 subagent 工具 + 可解析且非空的字符串；其余（错误文案/其他工具）一律 undefined，绝不伪造。
 */
export function childSessionIdFromToolResult(tool: string | undefined, output: string | undefined): string | undefined {
  if (!isSubagentTool(tool) || output === undefined || output.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'object' && parsed !== null) {
      const id = (parsed as Record<string, unknown>).childSessionId;
      if (typeof id === 'string' && id.trim().length > 0) return id;
    }
  } catch {
    // 非 JSON 输出（真实 error 文案等）→ 不显示入口
  }
  return undefined;
}

function toolArgsString(args: string | undefined): string | undefined {
  return args === undefined || args.length === 0 ? undefined : args;
}

function toolSummary(args: string | undefined, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return args === undefined ? '' : summarizeArgs(args);
}

/** 「有可展示正文」：非 undefined 且含非空白字符；空白正文按 empty 处理（禁止空白气泡） */
function hasBody(text: string | undefined): text is string {
  return text !== undefined && text.trim().length > 0;
}

/** 纯 reducer：稳定 id + tool 原地合并 + final/partial/empty 冻结映射 */
export function transcriptReducer(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  switch (event.type) {
    case 'user/message':
      return put(state, {
        kind: 'user',
        id: scopedId('user', event.seq, event.turnId, event.id),
        seq: event.seq,
        text: event.text,
      });
    case 'assistant/message': {
      const item: TranscriptItem = {
        kind: 'assistant',
        id: scopedId('assistant', event.seq, event.turnId, event.id),
        seq: event.seq,
        text: event.text,
        outcome: 'final',
        ...(event.reasoning !== undefined && event.reasoning.length > 0 ? { reasoning: event.reasoning } : {}),
      };
      return put(state, item);
    }
    case 'assistant/attempt': {
      const id = scopedId('attempt', event.seq, event.turnId, event.id);
      if (hasBody(event.text)) {
        return put(state, {
          kind: 'partial',
          id,
          seq: event.seq,
          text: event.text,
          error: event.error,
          ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
        });
      }
      return put(state, {
        kind: 'empty',
        id,
        seq: event.seq,
        error: event.error,
        ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
      });
    }
    case 'tool/call': {
      const existing = state.items[findItemIndex(state.items, `tool:${event.callId}`)];
      const args = toolArgsString(event.args) ?? (existing?.kind === 'tool' ? existing.args : undefined);
      return put(state, {
        kind: 'tool',
        id: `tool:${event.callId}`,
        callId: event.callId,
        tool: event.tool,
        ...(args !== undefined ? { args } : {}),
        summary: toolSummary(args, event.summary),
        status: 'pending',
      });
    }
    case 'tool/result': {
      const id = `tool:${event.callId}`;
      const existing = state.items[findItemIndex(state.items, id)];
      const base: ToolItem =
        existing?.kind === 'tool'
          ? existing
          : {
              kind: 'tool',
              id,
              callId: event.callId,
              tool: event.tool ?? '?',
              summary: event.error ?? '',
              status: 'pending',
            };
      const tool = event.tool ?? base.tool;
      const output = event.output;
      const childSessionId = childSessionIdFromToolResult(tool, output);
      return put(state, {
        ...base,
        tool,
        status: event.ok ? 'ok' : 'failed',
        ...(output !== undefined ? { output } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(childSessionId !== undefined ? { childSessionId } : {}),
      });
    }
    case 'assistant/step': {
      // 工具/推理分隔出的中间正文段：稳定 id 以 turnId+stepIndex 为作用域（重放同一 turn 幂等）
      const id =
        event.turnId !== undefined && event.turnId.length > 0
          ? `assistant:${event.turnId}:step:${event.stepIndex}`
          : `assistant:step:${event.stepIndex}`;
      return put(state, {
        kind: 'assistant',
        id,
        seq: 0,
        text: event.text,
        outcome: 'final',
        ...(event.reasoning !== undefined && event.reasoning.length > 0 ? { reasoning: event.reasoning } : {}),
      });
    }
    case 'turn-final':
      return put(state, {
        kind: 'assistant',
        id: scopedId('assistant', event.seq, event.turnId, undefined),
        seq: event.seq ?? 0,
        text: event.text,
        outcome: 'final',
        ...(event.reasoning !== undefined && event.reasoning.length > 0 ? { reasoning: event.reasoning } : {}),
      });
    case 'turn-partial': {
      const id = scopedId('attempt', event.seq, event.turnId, undefined);
      if (hasBody(event.text)) {
        return put(state, {
          kind: 'partial',
          id,
          seq: event.seq ?? 0,
          text: event.text,
          error: event.error ?? '（未提供错误信息）',
          ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
        });
      }
      return put(state, {
        kind: 'empty',
        id,
        seq: event.seq ?? 0,
        error: event.error,
        ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
      });
    }
    case 'turn-empty':
      return put(state, {
        kind: 'empty',
        id: scopedId('attempt', event.seq, event.turnId, undefined),
        seq: event.seq ?? 0,
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
      });
    case 'system':
      return put(state, {
        kind: 'system',
        id: scopedId('system', state.items.length, undefined, event.id),
        text: event.text,
      });
    case 'status':
      return put(state, {
        kind: 'status',
        id: scopedId('status', state.items.length, undefined, event.id),
        text: event.text,
      });
    default:
      return state;
  }
}

function argsToString(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  if (typeof args === 'string') return args.length > 0 ? args : undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

/**
 * core 会话事件 → transcript 事件；结构性事件（header/step/memory/compaction/rewind）返回 null。
 *
 * 重投影 id 语义（为何显式给 seq id，而不是让 scopedId 改判 seq 优先）：
 * core 的 loop 一个 turn 只分配**一个 turnId**，但每个 step 都会 append 一条
 * `assistant/message`（见 core/src/agent/loop.ts）。若沿用 scopedId 的 turnId 优先，
 * 同一 turn 的所有 assistant 段都会得到 `assistant:<turnId>`，put() 原地覆盖 →
 * 前面的解释被静默丢弃，且最终答案渲染在工具卡之前（验收 4 重投影 / T3 顺序保真被破坏）。
 * 因此重投影按事件 seq 派生唯一 id（seq 在日志内严格单调），保证顺序与完整性。
 *
 * 不能在 scopedId 里全局改成 seq 优先：live 事件可能带 `seq:0`/缺省（如 useTurnStream 的
 * 流式事件），会互相碰撞，破坏真实流式的 turn 级稳定 id（assistant:<turnId>:step:N / turn-final）。
 * tool/call、tool/result 仍按 callId 键控（本就在日志内唯一，且是 call↔result 原地合并所必需）。
 */
export function sessionEventToTranscript(event: AnySessionEvent): TranscriptEvent | null {
  switch (event.type) {
    case 'user/message':
      return {
        type: 'user/message',
        id: `user:${event.seq}`,
        seq: event.seq,
        text: event.payload.text,
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      };
    case 'assistant/message':
      return {
        type: 'assistant/message',
        id: `assistant:${event.seq}`,
        seq: event.seq,
        text: event.payload.text,
        ...(event.payload.reasoning !== undefined ? { reasoning: event.payload.reasoning } : {}),
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      };
    case 'assistant/attempt':
      return {
        type: 'assistant/attempt',
        id: `attempt:${event.seq}`,
        seq: event.seq,
        error: event.payload.error,
        ...(event.payload.text !== undefined ? { text: event.payload.text } : {}),
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      };
    case 'tool/call':
      return {
        type: 'tool/call',
        seq: event.seq,
        callId: event.payload.callId,
        tool: event.payload.tool,
        ...(argsToString(event.payload.args) !== undefined ? { args: argsToString(event.payload.args) } : {}),
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      };
    case 'tool/result':
      return {
        type: 'tool/result',
        seq: event.seq,
        callId: event.payload.callId,
        ...(event.payload.tool !== undefined ? { tool: event.payload.tool } : {}),
        ok: event.payload.ok,
        ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
        ...(event.payload.error !== undefined ? { error: event.payload.error } : {}),
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      };
    default:
      return null;
  }
}

/**
 * 从磁盘会话目录重投影为 TranscriptState（会话切换用）。
 * 只读 core：loadSession 解析、computeProjection 求活动性（影子事件必须剔除）。
 */
export function projectSession(dir: string): TranscriptState {
  const session = loadSession(dir);
  computeProjection(session); // 就地写入 item.active（影子事件 false）
  let state = emptyTranscript();
  for (const { event, active } of session.events) {
    if (!active) continue;
    const te = sessionEventToTranscript(event);
    if (te !== null) state = transcriptReducer(state, te);
  }
  return state;
}

export interface ViewportInput {
  heights: number[];
  totalHeight: number;
  height: number;
  follow: boolean;
  anchorId?: string;
  scrollTop: number;
}

export interface ViewportResult {
  /** 渲染区间 [start, end) */
  start: number;
  end: number;
  /** 首个可见 item 被顶部裁掉的行数（行级精确裁剪的挂点） */
  offset: number;
  follow: boolean;
  anchorIndex: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 纯 viewport 计算：follow 时贴尾；非 follow 时按绝对 scrollTop 切片；
 * 给定 anchorId 时保证锚点 item 可见（追加新 item 不把它挤出视口）。
 */
export function computeViewport(items: { id: string }[], input: ViewportInput): ViewportResult {
  const n = items.length;
  const height = Math.max(1, Math.floor(input.height));
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i += 1) prefix[i + 1] = (prefix[i] ?? 0) + (input.heights[i] ?? 0);
  const maxScroll = Math.max(0, input.totalHeight - height);
  const anchorIndex = input.anchorId !== undefined ? items.findIndex((i) => i.id === input.anchorId) : -1;

  let follow = input.follow;
  let scrollTop = clamp(input.scrollTop, 0, maxScroll);
  if (input.totalHeight <= height) {
    // 内容不足一屏：永远贴顶/贴尾（同一位置）
    follow = true;
    scrollTop = 0;
  } else if (follow) {
    scrollTop = maxScroll;
  } else if (anchorIndex >= 0) {
    const anchorTop = prefix[anchorIndex] ?? 0;
    const anchorBottom = anchorTop + (input.heights[anchorIndex] ?? 0);
    if (anchorTop < scrollTop) scrollTop = anchorTop;
    else if (anchorBottom > scrollTop + height) scrollTop = Math.min(maxScroll, Math.max(0, anchorBottom - height));
  }
  scrollTop = clamp(scrollTop, 0, maxScroll);

  if (n === 0) return { start: 0, end: 0, offset: 0, follow, anchorIndex: -1 };

  let start = 0;
  while (start < n - 1 && (prefix[start + 1] ?? 0) <= scrollTop) start += 1;
  const offset = Math.max(0, scrollTop - (prefix[start] ?? 0));
  const bottom = scrollTop + height;
  let end = start;
  while (end < n && (prefix[end] ?? 0) < bottom) end += 1;
  if (end <= start) end = Math.min(n, start + 1);
  return { start, end, offset, follow, anchorIndex };
}

export interface TranscriptHeightCache {
  set(id: string, height: number): void;
  get(id: string): number | undefined;
  total(ids: string[]): number;
  /** 清除某前缀的高度（缺省清空全部）；宽度/展开态变化时调用 */
  invalidate(prefix?: string): void;
}

/** 简单 Map 高度缓存（估高，不做真实测量；按 id 或复合 key 存取） */
export function transcriptHeightCache(): TranscriptHeightCache {
  const map = new Map<string, number>();
  return {
    set: (id, height) => {
      map.set(id, height);
    },
    get: (id) => map.get(id),
    total: (ids) => {
      let sum = 0;
      for (const id of ids) sum += map.get(id) ?? 0;
      return sum;
    },
    invalidate: (prefix) => {
      if (prefix === undefined) {
        map.clear();
        return;
      }
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}

function countWrappedLines(text: string, width: number): number {
  if (text.length === 0) return 1;
  let total = 0;
  for (const segment of text.split('\n')) total += Math.max(1, Math.ceil(displayWidth(segment) / width));
  return total;
}

/** 估高（按显示宽度软折行估算）；供高度缓存与 viewport 使用，非真实测量 */
export function estimateItemHeight(item: TranscriptItem, width: number): number {
  const w = Math.max(1, Math.floor(width));
  let text: string;
  switch (item.kind) {
    case 'tool':
      text = item.summary;
      break;
    case 'partial':
      text = `${item.text}\n${item.error}`;
      break;
    case 'empty':
      text = [item.stopReason !== undefined ? `[${item.stopReason}]` : '', item.error ?? '']
        .filter((s) => s.length > 0)
        .join(' ');
      break;
    default:
      text = item.text;
      break;
  }
  return Math.max(1, countWrappedLines(text, w));
}

/** item 内容签名（长度级）：内容变化时使高度缓存失效（不做真实测量，故用长度近似） */
export function itemContentSignature(item: TranscriptItem): string {
  switch (item.kind) {
    case 'tool':
      return `${item.status}:${item.output?.length ?? 0}:${item.error?.length ?? 0}:${item.summary.length}`;
    case 'partial':
      return `${item.text.length}:${item.error.length}`;
    case 'assistant':
      return `${item.text.length}:${item.reasoning?.length ?? 0}`;
    case 'empty':
      return `${item.stopReason?.length ?? 0}:${item.error?.length ?? 0}`;
    default:
      return String(item.text.length);
  }
}
