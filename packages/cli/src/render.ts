// chat 流式渲染器：text-delta 直写 stdout（不换行拼流）；工具调用/结果单行；
// reasoning 不渲染。piped 模式无颜色（Windows readline/ANSI 风险缓解，见阶段计划）。
import type { TurnResult } from '@harness2/core';

/** 渲染目标（可注入便于测试；默认 process.stdout） */
export interface RenderOutput {
  write(text: string): void;
}

const ARGS_SUMMARY_MAX = 96;

/** 截断工具参数摘要（单行、可读优先） */
export function summarizeArgs(rawArguments: string): string {
  let text = rawArguments;
  try {
    text = JSON.stringify(JSON.parse(rawArguments));
  } catch {
    // 原样使用原始串（解析失败时 loop 会落 invalid JSON 的失败结果）
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= ARGS_SUMMARY_MAX ? oneLine : `${oneLine.slice(0, ARGS_SUMMARY_MAX)}…`;
}

/** turn 结束摘要行（end_turn/error/cancelled 等如实展示） */
export function turnSummaryLine(result: TurnResult): string {
  const parts = [`[${result.stopReason}`, `steps ${result.steps}`, `toolCalls ${result.toolCalls}`];
  if (result.error !== undefined) parts.push(`error: ${result.error}`);
  if (result.warning !== undefined) parts.push(`warning: ${result.warning}`);
  return parts.join(' · ') + ']';
}

/**
 * 流式渲染器：与 readline 的交错策略——turn 期间不调用 rl.prompt()，
 * 渲染器独占输出；turn 结束后由 REPL 恢复提示符（单写队列语义）。
 */
export class StreamRenderer {
  private wroteText = false;

  constructor(
    private readonly out: RenderOutput,
    /** TTY 色支持：false 时 reasoning 只用文本标记，避免非 TTY/CI 的 ANSI 乱码 */
    private readonly color = false,
  ) {}

  /** provider 文本增量：直写 stdout，不换行拼流 */
  textDelta(text: string): void {
    if (text.length === 0) return;
    this.out.write(text);
    this.wroteText = true;
  }

  /** 推理过程增量（仅 /reasoning on 时由 REPL 转发）：灰色斜体；无色模式用 [reasoning] 标记 */
  reasoning(text: string): void {
    if (text.length === 0) return;
    const styled = this.color
      ? `\x1b[90m\x1b[3m${text}\x1b[0m`
      : `[reasoning] ${oneLine(text)}`;
    this.out.write(styled);
    this.wroteText = true;
  }

  /** 工具调用单行：> tool (args摘要) */
  toolCall(tool: string, rawArguments: string): void {
    this.out.write(`${this.wroteText ? '\n' : ''}> ${tool} (${summarizeArgs(rawArguments)})\n`);
    this.wroteText = false;
  }

  /** 工具结果单行：< ok/FAILED [callId] */
  toolResult(callId: string, ok: boolean, error?: string): void {
    this.out.write(`< ${ok ? 'ok' : 'FAILED'} [${callId}]${error !== undefined && error.length > 0 ? ` ${oneLine(error)}` : ''}\n`);
    this.wroteText = false;
  }

  /** turn 结束：收尾换行 + 摘要行 */
  turnEnd(result: TurnResult): void {
    this.out.write(`${this.wroteText ? '\n' : ''}${turnSummaryLine(result)}\n`);
    this.wroteText = false;
  }

  /** 系统提示行（REPL 状态信息，渲染器外直用） */
  line(text: string): void {
    this.out.write(`${text}\n`);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
