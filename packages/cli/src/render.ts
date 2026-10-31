// chat 流式渲染器：text-delta 直写 stdout（不换行拼流）；工具调用/结果单行；
// reasoning 不渲染。piped 模式无颜色（Windows readline/ANSI 风险缓解，见阶段计划）。
import type { TurnResult } from '@harness2/core';

/** 渲染目标（可注入便于测试；默认 process.stdout） */
export interface RenderOutput {
  write(text: string): void;
}

const ARGS_SUMMARY_MAX = 96;

/**
 * 控制字符过滤（安全修复 #308）：剥离 ESC 引入的 OSC/危险 CSI/其它终端序列与 C0/C1 控制字符，
 * 防止模型可控文本注入 OSC52（剪贴板劫持）、OSC8（超链接钓鱼）、OSC0/2（标题伪造）、
 * CSI 光标/模式切换等。保留换行、制表符与形状合法的 SGR 颜色序列（\x1b[31m 等），
 * 其余控制字符一律清除。
 *
 * 逐增量（chunk）调用即可中和注入——任何以 ESC 开头的序列若被 chunk 切断，其 ESC 引入符
 * 会被整体丢弃，不会与后续增量拼成完整序列，故无需跨 chunk 状态机。
 */
export function stripEscapes(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const code = ch.charCodeAt(0);
    if (ch !== '\u001b') {
      // C0 控制字符（含 \r）除 \n/\t 外丢弃；C1 8 位控制字符一并丢弃
      if ((code < 0x20 && ch !== '\n' && ch !== '\t') || (code >= 0x80 && code <= 0x9f)) {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    // 命中 ESC：吞掉其后的完整序列；未终止的序列连同引入符一并丢弃
    const next = text[i + 1];
    if (next === ']') {
      // OSC：至 BEL(\x07) 或 ST(ESC \) 终止
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === '\x07') {
          j += 1;
          break;
        }
        if (text[j] === '\u001b' && text[j + 1] === '\\') {
          j += 2;
          break;
        }
        j += 1;
      }
      i = j; // 未找到终止符时 j === text.length → 丢弃余下
      continue;
    }
    if (next === '[') {
      // CSI：至 0x40..0x7e 终结字节；仅保留形状合法的 SGR（终结 m）颜色序列，
      // 其余 CSI（光标移动/清屏/模式切换等）一律剥离（对齐 status-line stripNonColorEscapes 语义）
      let j = i + 2;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j += 1;
          break;
        }
        j += 1;
      }
      const isSgr =
        j > i + 2 &&
        text[j - 1] === 'm' &&
        text
          .slice(i + 2, j - 1)
          .split('')
          .every((ch) => {
            const c = ch.charCodeAt(0);
            return (c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f);
          });
      if (isSgr) {
        out += text.slice(i, j); // 合法 ANSI 颜色序列：保留
      }
      i = j;
      continue;
    }
    if (next === undefined) {
      i += 1;
      continue;
    } // 落单 ESC：丢弃
    i += 2; // 其它 ESC 双字节序列（ESC c/=/7/8/\ 等）：整体丢弃
  }
  return out;
}

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

/**
 * turn 耗时文案（P11-T4）：<60s → `12.3s`；≥60s → `1m35s`。
 * 数据源 = `TurnResult.durationMs`（core 真实计时，loop 内 `performance.now()` 差值）——
 * 无该字段/非法值不产出文案（调用方按需省略，绝不补 0 秒假数据）。
 */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`;
}

/** turn 结束摘要行（end_turn/error/cancelled 等如实展示；P11-T4 并入真实耗时） */
export function turnSummaryLine(result: TurnResult): string {
  const duration = formatTurnDuration(result.durationMs);
  const parts = [
    `[${result.stopReason}`,
    // P11-T4：耗时来自 TurnResult.durationMs（真实计时）；非法/缺失值不占位（不伪造）
    ...(duration.length > 0 ? [duration] : []),
    `steps ${result.steps}`,
    `toolCalls ${result.toolCalls}`,
  ];
  // error/warning 可携带工具执行输出文本（loop.ts:828/892/901），输出前过滤控制字符
  if (result.error !== undefined) parts.push(`error: ${stripEscapes(result.error)}`);
  if (result.warning !== undefined) parts.push(`warning: ${stripEscapes(result.warning)}`);
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

  /** provider 文本增量：直写 stdout，不换行拼流（输出前过滤控制字符，见 stripEscapes） */
  textDelta(text: string): void {
    if (text.length === 0) return;
    this.out.write(stripEscapes(text));
    this.wroteText = true;
  }

  /** 推理过程增量（仅 /reasoning on 时由 REPL 转发）：灰色斜体；无色模式用 [reasoning] 标记 */
  reasoning(text: string): void {
    if (text.length === 0) return;
    // 先过滤模型可控内容的控制字符，再套渲染器自加的样式码（否则会连样式一并清除）
    const safe = stripEscapes(text);
    const styled = this.color ? `\x1b[90m\x1b[3m${safe}\x1b[0m` : `[reasoning] ${oneLine(safe)}`;
    this.out.write(styled);
    this.wroteText = true;
  }

  /** 工具调用单行：> tool (args摘要)（tool 名与 args 均模型可控，输出前过滤控制字符） */
  toolCall(tool: string, rawArguments: string): void {
    this.out.write(stripEscapes(`${this.wroteText ? '\n' : ''}> ${tool} (${summarizeArgs(rawArguments)})\n`));
    this.wroteText = false;
  }

  /** 工具结果单行：< ok/FAILED [callId]（callId/工具错误均模型可控，输出前过滤控制字符） */
  toolResult(callId: string, ok: boolean, error?: string): void {
    this.out.write(
      stripEscapes(
        `< ${ok ? 'ok' : 'FAILED'} [${callId}]${error !== undefined && error.length > 0 ? ` ${oneLine(error)}` : ''}\n`,
      ),
    );
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
