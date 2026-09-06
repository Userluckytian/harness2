// 轨迹渲染：纯函数（事件 → 渲染行数组），CLI 与桌面端共享。
// 默认只渲染活动投影；--includeShadowed 时以 "~ " 前缀显示影子事件。
// 消息/工具行保持纯 ASCII；turn 标头使用制表符「──」（阶段 2 计划定案，
// Windows Terminal 实机渲染列入残留手工验收清单）。
import { computeProjection, type LoadedSession } from '../session/reader.js';
import type { AnySessionEvent } from '../session/types.js';

export interface TrajectoryRenderOptions {
  /** 包含被回退遮蔽的影子事件（前缀 "~ "） */
  includeShadowed?: boolean;
  /** 单段文本最大长度，超出截断加省略号 */
  maxTextLength?: number;
}

function truncate(s: string, max: number): string {
  // 单行渲染：折叠换行，避免多行输出撑破时间线
  const oneLine = s.replace(/\r?\n/g, '\\n');
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}...`;
}

function preview(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? '';
  } catch {
    s = '<unserializable>';
  }
  return truncate(s, max);
}

/** 事件归属的 turnId（无 turnId 的事件归入 "-" 组） */
function turnIdOf(e: AnySessionEvent): string | undefined {
  const p = e.payload as { turnId?: unknown };
  return typeof p.turnId === 'string' ? p.turnId : undefined;
}

export function renderTrajectory(session: LoadedSession, options: TrajectoryRenderOptions = {}): string[] {
  const { includeShadowed = false, maxTextLength = 80 } = options;
  const projection = computeProjection(session);
  const lines: string[] = [];

  const header = session.header;
  if (header) {
    lines.push(`# session ${header.sessionId}${header.cwd ? ` (${header.cwd})` : ''}`);
  }

  // turn 标头：每个 turnId 首个事件前渲染「── turn <id>」；无 turnId 的事件归入「── turn -」
  let currentTurn: string | null = null;

  for (const { event: e, active } of session.events) {
    if (!active && !includeShadowed) continue;
    const p = active ? '' : '~ ';
    if (e.type === 'session/header') {
      continue; // 会话标头已在顶部渲染，且不参与 turn 分组
    }
    const turnKey = turnIdOf(e) ?? '-';
    if (turnKey !== currentTurn) {
      lines.push(`── turn ${turnKey}`);
      currentTurn = turnKey;
    }
    switch (e.type) {
      case 'user/message':
        lines.push('');
        lines.push(`${p}[USER] ${truncate(e.payload.text, maxTextLength)}`);
        break;
      case 'assistant/message': {
        const model = e.payload.model ? ` [${e.payload.model}]` : '';
        const usage = e.payload.usage
          ? ` (${e.payload.usage.inputTokens ?? '?'} in / ${e.payload.usage.outputTokens ?? '?'} out)`
          : '';
        lines.push(`${p}[ASSISTANT]${model} ${truncate(e.payload.text, maxTextLength)}${usage}`);
        break;
      }
      case 'assistant/attempt':
        lines.push(`${p}  ! attempt failed: ${truncate(e.payload.error, maxTextLength)}`);
        break;
      case 'step/start':
        lines.push(`${p}  + step ${e.payload.stepId}`);
        break;
      case 'step/end':
        lines.push(
          `${p}  - step ${e.payload.stepId} done${e.payload.durationMs != null ? ` (${e.payload.durationMs}ms)` : ''}`,
        );
        break;
      case 'tool/call':
        lines.push(`${p}  > tool ${e.payload.tool}(${preview(e.payload.args ?? {}, maxTextLength)})`);
        break;
      case 'tool/result': {
        const mark = e.payload.ok ? 'ok' : 'FAILED';
        const detail = e.payload.ok ? e.payload.output : e.payload.error;
        const ms = e.payload.durationMs != null ? ` ${e.payload.durationMs}ms` : '';
        lines.push(`${p}  < ${mark} [${e.payload.callId}]${ms}${detail ? `: ${truncate(detail, maxTextLength)}` : ''}`);
        break;
      }
      case 'rewind/marker':
        lines.push(`${p}[REWIND] to seq ${e.payload.rewindToSeq}${e.payload.reason ? ` (${e.payload.reason})` : ''}`);
        break;
      case 'compaction/applied':
        lines.push(
          `${p}[COMPACT] covered ≤ seq ${e.payload.coveredUpToSeq}: ${truncate(e.payload.summary, maxTextLength)}`,
        );
        break;
      default: {
        // exhaustive 兜底：未知事件类型显式渲染而非静默吞掉
        lines.push(`${p}? unknown event: ${(e as { type: string }).type}`);
        break;
      }
    }
  }

  lines.push('');
  const warn = session.warnings.length > 0 ? ` | ${session.warnings.length} warning(s)` : '';
  lines.push(
    `-- ${session.events.length} events | ${projection.messages.length} messages | ${projection.rewindCount} rewind(s) | shadowed ${projection.shadowedCount}${warn}`,
  );
  return lines;
}

export function formatTrajectory(session: LoadedSession, options: TrajectoryRenderOptions = {}): string {
  return renderTrajectory(session, options).join('\n');
}
