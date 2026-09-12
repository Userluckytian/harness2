// input-bridge.ts — T1-4 输入路径迁移：统一解析器（src/input/parser.ts）→ stdin 事件桥适配层。
//
// 职责：把统一解析器产出的语义事件（InputEvent）映射为 terminal-events 的
// TerminalEvent（wheel/focus）与应回注给 ink 的字节序列（forward）：
//   - MouseEvent：kind='scroll' 且 button 0/1 → wheel up/down；点击/拖拽/移动/其他滚轮位
//     静默消费（对齐 legacy parseSgrMouse：不进 ink、不产生事件）；
//   - FocusEvent（CSI I / CSI O）→ focus focused 事件（通知门控状态源不变）；
//   - KeyEvent → keyEventToSequence 序列化回注（键盘逐字节等价，见下）；
//   - PasteEvent → 还原 bracketed paste 包装（\x1b[200~…\x1b[201~）回注，与 paste.ts
//     的 normalizePaste/classifyPaste 既有归一链路衔接（解析层不做 CRLF 归一）。
//
// 回注等价性说明（键盘逐字节等价的口径）：
//   - 可打印字符（含 UTF-8 多字节）、控制字节（\r \t \x7f \x00-\x1a）、孤立 ESC、
//     CSI 转义（方向/Home/End/Delete/PageUp/PageDown/Shift+Tab/F5-F12，含 ;mods 修饰段）
//     全部**逐字节还原**——ink 端收到的字节与迁移前完全一致；
//   - SS3（ESC O 前缀）按键改写为 ink 同样识别的 CSI 等价形式（\x1bOA→\x1b[A）：
//     ink parse-keypress 对两者解析出同名键（up/f1…），键盘行为不变；
//   - kitty CSI-u 按 codepoint;mods[:event]u 保真回写（本应用未启用 kitty 协议，属前向兼容）；
//   - 孤立/半包 ESC 由 flushIdle 空闲超时按 Esc 键回注（escTimeoutMs=30 < 桥接定时器 40ms，
//     与 legacy PENDING_FLUSH_MS=40 的挂起冲刷时机一致，Esc 键不吞不重不延迟）；
//   - 残缺鼠标/CSI 残片超时冲刷后按字面回注（与 legacy flushPending 逐字节一致）。
//
// flushIdle 接线：解析器不持有 timer（纯逻辑）；本适配器的 flushPending() 在挂起类型可
// 空闲冲刷（ESC 开头）且空闲 ≥ escTimeoutMs 时调用 parser.flushIdle()。paste 聚合期间
// flushIdle 不会冲刷，但聚合有空闲上限（pasteIdleTimeoutMs，默认 1500ms）：超时后
// flushPending 把已聚合内容作为完整 bracketed paste 回注（流损坏兜底）；聚合未超时期间
// flushPending 的空冲刷不累积饿死定时器（见 flushPending 内 hasPendingPaste 分支），
// 残缺 UTF-8 半字节挂起期间（缓冲不以 ESC 开头）连续两次空冲刷后 hasPending() 转 false，
// 桥接定时器停止重排（避免 40ms 空转；下一次 feed 自动复位）。
// flush()：无条件兜底冲刷（装配层 dispose 时调用一次，防退出丢键——未终结 paste /
// 半包 ESC / 残缺 UTF-8 一次性产出回注）。
import type { ParsedChunk, TerminalEvent } from './terminal-events.js';
import { createInputParser, type InputParser, type InputParserOptions } from '../input/parser.js';
import type { InputEvent, KeyEvent, KeyModifiers, PasteEvent } from '../input/types.js';

/** 适配器选项：直接复用统一解析器选项（时钟注入 + ESC 空闲阈值） */
export type UnifiedEventParserOptions = InputParserOptions;

export interface UnifiedEventParser {
  /** 喂入一段输入（string/Buffer 语义由上层转换），返回 wheel/focus 事件与应回注字节 */
  push(chunk: string): ParsedChunk;
  /** 是否有未完成的挂起序列（paste 聚合 / 半包转义 / 残缺 UTF-8） */
  hasPending(): boolean;
  /** 空闲超时冲刷（内部调 parser.flushIdle；未达阈值返回空且保持挂起） */
  flushPending(): ParsedChunk;
  /** 无条件兜底冲刷（装配层 dispose 时调用一次：未终结 paste / 半包 ESC 一次性产出） */
  flush(): ParsedChunk;
}

/** f5-f12 的 CSI ~ 编码号（f1-f4 用 11-14，与 ink keyName 表一致） */
const F_KEY_TILDE: Record<string, number> = {
  f1: 11,
  f2: 12,
  f3: 13,
  f4: 14,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

/** Ctrl+符号字节（0x1c-0x1f 的经典编码，解析器产生 \\ ] ^ _） */
const CTRL_SYMBOL_BYTES: Record<string, number> = { '\\': 0x1c, ']': 0x1d, '^': 0x1e, _: 0x1f };

/** 三元修饰 → kitty/xterm 修饰参数码（1 + shift + alt*2 + ctrl*4） */
function modifierCode(m: KeyModifiers): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

/**
 * KeyEvent → ink（parse-keypress）可消费的字节序列。
 * 见文件头「回注等价性说明」：除 SS3→CSI 与 kitty 规范化外全部逐字节还原。
 */
export function keyEventToSequence(ev: KeyEvent): string {
  // kitty CSI-u：保真回写（本应用未启用 kitty 协议，终端不应送来；前向兼容）
  if (ev.kitty !== undefined) {
    let s = `\x1b[${ev.kitty.codepoint}`;
    const code = modifierCode(ev.modifiers);
    // kitty 语法：CSI codepoint[;mods[:event]]u —— event 段前必须有 mods 段（缺省写 1）
    if (code > 1 || (ev.kitty.event !== undefined && ev.kitty.event !== 'press')) s += `;${code > 1 ? code : 1}`;
    if (ev.kitty.event === 'repeat') s += ':2';
    else if (ev.kitty.event === 'release') s += ':3';
    return `${s}u`;
  }
  const code = modifierCode(ev.modifiers);
  const csiLetter = (letter: string): string => `\x1b[${code > 1 ? `1;${code}` : ''}${letter}`;
  const csiTilde = (n: number): string => `\x1b[${n}${code > 1 ? `;${code}` : ''}~`;
  switch (ev.key) {
    case 'enter':
      return '\r';
    case 'tab':
      return ev.modifiers.shift ? '\x1b[Z' : '\t';
    case 'backspace':
      return '\x7f';
    case 'escape':
      return '\x1b';
    case 'up':
      return csiLetter('A');
    case 'down':
      return csiLetter('B');
    case 'right':
      return csiLetter('C');
    case 'left':
      return csiLetter('D');
    case 'home':
      return csiLetter('H');
    case 'end':
      return csiLetter('F');
    case 'insert':
      return csiTilde(2);
    case 'delete':
      return csiTilde(3);
    case 'pageup':
      return csiTilde(5);
    case 'pagedown':
      return csiTilde(6);
    default:
      break;
  }
  const tilde = F_KEY_TILDE[ev.key];
  if (tilde !== undefined) return csiTilde(tilde);
  // 可打印字符（text 与 key 同字符）：ctrl → 控制字节；alt → ESC 前缀；否则原样
  const ch = ev.text ?? ev.key;
  if (ev.modifiers.ctrl) {
    if (ch === ' ') return '\x00';
    const symbol = CTRL_SYMBOL_BYTES[ch];
    if (symbol !== undefined) return String.fromCharCode(symbol);
    const c = ch.toLowerCase().charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60);
    return ch; // 兜底：无法表达的控制组合按字符回注
  }
  if (ev.modifiers.alt) return `\x1b${ch}`;
  return ch;
}

/** PasteEvent → 还原 bracketed paste 包装（内容原样；归一属于 paste.ts） */
export function pasteEventToSequence(ev: PasteEvent): string {
  return `\x1b[200~${ev.text}\x1b[201~`;
}

/** 语义事件 → 桥接产出（wheel/focus 事件 + 回注字节；键盘/粘贴序列化进 forward） */
function eventsToParsedChunk(events: readonly InputEvent[]): ParsedChunk {
  const terminal: TerminalEvent[] = [];
  let forward = '';
  for (const ev of events) {
    switch (ev.type) {
      case 'mouse':
        // 滚轮 button 0/1 → up/down；点击/拖拽/移动/其他滚轮位静默消费（YAGNI，对齐 legacy）
        if (ev.kind === 'scroll' && ev.button === 0) terminal.push({ type: 'wheel', up: true });
        else if (ev.kind === 'scroll' && ev.button === 1) terminal.push({ type: 'wheel', up: false });
        break;
      case 'focus':
        terminal.push({ type: 'focus', focused: ev.direction === 'in' });
        break;
      case 'key':
        forward += keyEventToSequence(ev);
        break;
      case 'paste':
        forward += pasteEventToSequence(ev);
        break;
    }
  }
  return { events: terminal, forward };
}

/**
 * 统一解析器适配器：与 legacy TerminalEventParser 同构（push/hasPending/flushPending/flush），
 * 供 attachTerminalEvents 按开关二选一。挂起判定：连续两次空冲刷后视为「非 ESC 挂起」
 * （残缺 UTF-8 半字节等——flushIdle 不会处理），hasPending 转 false 停止定时器重排；
 * 下一次 push 复位。paste 聚合例外（有空闲上限，空冲刷不累积，见 flushPending）。
 * ESC 挂起在空闲 ≥ escTimeoutMs 时必被冲刷（Esc 键语义）；paste 聚合在空闲 ≥
 * pasteIdleTimeoutMs 时产出完整 bracketed paste（流损坏兜底）。
 */
export function createUnifiedEventParser(options: UnifiedEventParserOptions = {}): UnifiedEventParser {
  const escTimeoutMs = options.escTimeoutMs ?? 30; // < 桥接定时器 40ms：冲刷时机与 legacy 一致
  const now = options.now;
  const parser: InputParser = createInputParser({
    escTimeoutMs,
    ...(now !== undefined ? { now } : {}),
    ...(options.pasteIdleTimeoutMs !== undefined ? { pasteIdleTimeoutMs: options.pasteIdleTimeoutMs } : {}),
  });
  let emptyFlushes = 0;
  return {
    push(chunk: string): ParsedChunk {
      emptyFlushes = 0;
      return eventsToParsedChunk(parser.feed(chunk));
    },
    hasPending(): boolean {
      return emptyFlushes < 2 && parser.pendingLength() > 0;
    },
    flushPending(): ParsedChunk {
      const chunk = eventsToParsedChunk(parser.flushIdle(now !== undefined ? now() : undefined));
      if (chunk.events.length === 0 && chunk.forward.length === 0 && parser.pendingLength() > 0) {
        if (parser.hasPendingPaste()) {
          // paste 聚合有空闲上限（pasteIdleTimeoutMs）：超时后 flushIdle 必产出，
          // 空冲刷不累积饿死，保持桥接定时器重排直到超时产出。
          emptyFlushes = 0;
        } else {
          emptyFlushes += 1; // 未达阈值或非 ESC 挂起：连续两次后停止重排（见文件头）
        }
      } else {
        emptyFlushes = 0;
      }
      return chunk;
    },
    flush(): ParsedChunk {
      return eventsToParsedChunk(parser.flush());
    },
  };
}
