// 轨迹渲染：纯函数（事件 → 渲染行数组），CLI 与桌面端共享。
// 默认只渲染活动投影；--includeShadowed 时以 "~ " 前缀显示影子事件。
// 输出保持纯 ASCII，规避 Windows 终端代码页乱码。
import { computeProjection, type LoadedSession } from '../session/reader.js';

export interface TrajectoryRenderOptions {
  /** 包含被回退遮蔽的影子事件（前缀 "~ "） */
  includeShadowed?: boolean;
  /** 单段文本最大长度，超出截断加省略号 */
  maxTextLength?: number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
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

export function renderTrajectory(session: LoadedSession, options: TrajectoryRenderOptions = {}): string[] {
  const { includeShadowed = false, maxTextLength = 80 } = options;
  const projection = computeProjection(session);
  const lines: string[] = [];

  const header = session.header;
  if (header) {
    lines.push(`# session ${header.sessionId}${header.cwd ? ` (${header.cwd})` : ''}`);
  }

  for (const { event: e, active } of session.events) {
    if (!active && !includeShadowed) continue;
    const p = active ? '' : '~ ';
    switch (e.type) {
      case 'session/header':
        break;
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
        lines.push(`${p}  < ${mark}${ms}${detail ? `: ${truncate(detail, maxTextLength)}` : ''}`);
        break;
      }
      case 'rewind/marker':
        lines.push(`${p}[REWIND] to seq ${e.payload.rewindToSeq}${e.payload.reason ? ` (${e.payload.reason})` : ''}`);
        break;
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
