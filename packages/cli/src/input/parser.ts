// parser.ts — P1 统一输入层的增量字节解析器（纯逻辑，零 DOM/Node 特有 API，可单测）。
//
// 职责：把终端 stdin 的原始字节流（可分片、可半包）解析成语义事件（types.ts）。
// 支持序列：
//  - 可打印字符（UTF-8 多字节流式解码，跨 feed 不撕裂中文）；
//  - 控制键：\r=Enter、\t=Tab、\x7f=Backspace、0x01-0x1A=Ctrl+字母（\n=Ctrl+J，
//    与 kitty/legacy「裸 0x0A 即 Ctrl+J」口径一致；raw mode 下 Enter 实际发 \r）；
//  - CSI 转义：方向键 A~D、Home/End（H/F 与 1~/4~/7~/8~）、Delete/Insert（3~/2~）、
//    PageUp/PageDown（5~/6~ 与 putty 的 [[5~/[[6~）、F1-F12（P..S 与 11~..24~）、
//    Shift+Tab（Z）、Linux console [[A..[[E → f1..f5；
//  - SS3（ESC O 前缀）功能键：OA-OD 方向、OP-S F1-F4、小写 Oa-Oe（ctrl+方向/clear，
//    ink isCtrlKey 口径）与 Oh/Of（home/end）；
//  - kitty CSI-u（CSI code[:shifted][:base];mods[:event] u），含 press/repeat/release；
//  - SGR 鼠标（CSI < b;x;y M/m）：含滚轮（bit6）、修饰位（shift=4/alt=8/ctrl=16）、
//    motion（bit5）；坐标减一归一为 0 基；
//  - legacy X10 鼠标（ESC[M + 3 原始字节）：字节按裸值解码，绝不经过 UTF-8；
//  - bracketed paste（CSI 200~ / 201~）：内容原样聚合为单个 PasteEvent（不做 CRLF
//    归一——归一属于 paste.ts 的职责，保持解析层与策略层分离）；终止符 201~ 永不到达
//    （流损坏）时，聚合空闲超过 pasteIdleTimeoutMs（默认 1500ms）由 flushIdle 把已聚合
//    内容作为单个 PasteEvent 兜底产出；
//  - 焦点 1004（CSI I / CSI O）。
//
// 分片容错与 ESC 超时语义（设计取舍）：
//  - feed() 只输出**已完整**的序列；半包留在内部缓冲等下一次 feed（flush 前）。
//  - 解析器本身**不持有 timer**（保持纯逻辑、可确定性单测）。孤立 ESC 的「按 Esc 键」
//    语义由调用方驱动：
//      · flushIdle(now)：paste 聚合空闲 >= pasteIdleTimeoutMs 时把聚合内容产出为
//        PasteEvent；或缓冲以 ESC 开头且 now - lastFeedAt >= escTimeoutMs 时冲刷
//        （TUI 主循环在输入空闲时调用即可，等价于传统 ESC 超时 50ms 方案）；
//      · flush(now?)：无条件强制冲刷（退出/暂停时兜底），保证不静默吞字节。
//  - flush 的降级策略：孤立/半包 ESC → 产出 Esc 键事件；残余字节按普通文本解码
//    （UTF-8 残缺半字节 → U+FFFD）。宁可产出可解释的事件，绝不静默丢弃。
//  - 例外（有意为之）：**结构合法但参数非法/语义未知的序列**（如 SGR 参数 NaN、
//    未识别的 CSI final 字节）按垃圾输入静默消费不产出事件——它们不是「待解析
//    的字节」而是「解析不了的噪声」，产出伪事件反而污染输入流。
//  - TextDecoder 是 WHATWG 标准接口（Node 18+/浏览器均内建），不算 DOM/Node 特有 API。
import { modifiersFromBits, noModifiers } from './types.js';
import type { FocusEvent, InputEvent, KeyEvent, MouseEvent, PasteEvent } from './types.js';

export interface InputParserOptions {
  /** 时钟注入（flushIdle 计算 ESC 空闲时长用）；默认 Date.now */
  now?: () => number;
  /** 孤立 ESC 视为 Esc 键的空闲阈值（毫秒）；默认 50 */
  escTimeoutMs?: number;
  /**
   * bracketed paste 聚合空闲上限（毫秒）；默认 1500。终止符 201~ 永不到达（流损坏）时，
   * 超过该空闲时长后 flushIdle 把已聚合内容作为单个 PasteEvent 产出（终端发了 200~ 就是
   * 想粘这个内容，只是流断了——比按字面逐字节回注更接近用户意图）。
   */
  pasteIdleTimeoutMs?: number;
}

export interface InputParser {
  /** 喂入原始字节（或 UTF-8 字符串，测试便利），返回本次产出的语义事件（可为空数组） */
  feed(bytes: Uint8Array | string): InputEvent[];
  /** 无条件强制冲刷内部缓冲（退出/暂停兜底；含未闭合 paste、孤立 ESC、残缺 UTF-8） */
  flush(now?: number): InputEvent[];
  /**
   * 空闲超时冲刷：paste 聚合空闲 >= pasteIdleTimeoutMs 时把已聚合内容作为单个
   * PasteEvent 产出（流损坏兜底）；或缓冲以 ESC 开头且空闲 >= escTimeoutMs 时按
   * Esc 键冲刷。未达阈值返回 []。
   */
  flushIdle(now?: number): InputEvent[];
  /** 当前缓冲字节数（含 paste 聚合内容；诊断用） */
  pendingLength(): number;
  /** 是否处于 bracketed paste 聚合中（桥接层保活定时器直到 pasteIdleTimeoutMs） */
  hasPendingPaste(): boolean;
  /** 丢弃全部缓冲状态（会话重置用） */
  reset(): void;
}

const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e] as const; // CSI 201~

const encoder = new TextEncoder();

function newDecoder(): TextDecoder {
  return new TextDecoder('utf-8'); // fatal: false → 非法字节自动产出 U+FFFD
}

function escKeyEvent(): KeyEvent {
  return { type: 'key', key: 'escape', modifiers: noModifiers(), consumed: false };
}

function keyEvent(key: string, modifiers: ReturnType<typeof noModifiers>, text?: string): KeyEvent {
  return { type: 'key', key, modifiers, ...(text !== undefined ? { text } : {}), consumed: false };
}

/** 在字节数组中找子序列，返回起始下标（找不到 -1）。 */
function findSubsequence(hay: readonly number[], needle: readonly number[]): number {
  if (needle.length === 0 || hay.length < needle.length) return -1;
  outer: for (let i = 0; i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** CSI/SS3 "n;mod" 参数的修饰段 → 位码（bits-1）。 */
function modifierBitsFromParams(parts: readonly string[]): number {
  const second = parts[1];
  if (second === undefined) return 0;
  const n = Number.parseInt(second, 10);
  return Number.isNaN(n) ? 0 : Math.max(0, n - 1);
}

const TILDE_KEYS: Record<number, string> = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home', // rxvt
  8: 'end', // rxvt（ink keyName 表同款：'[7~': 'home'、'[8~': 'end'）
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

/** kitty unicode-key-code 中的特殊功能键。 */
function kittyKeyOf(codepoint: number): { key: string; text?: string } | null {
  switch (codepoint) {
    case 13:
      return { key: 'enter' };
    case 9:
      return { key: 'tab' };
    case 27:
      return { key: 'escape' };
    case 127:
      return { key: 'backspace' };
    default:
      return null;
  }
}

export function createInputParser(options: InputParserOptions = {}): InputParser {
  const now = options.now ?? (() => Date.now());
  const escTimeoutMs = options.escTimeoutMs ?? 50;
  const pasteIdleTimeoutMs = options.pasteIdleTimeoutMs ?? 1500;

  let buf: number[] = []; // 待解析原始字节（半包缓存）
  let pasteBuf: number[] | null = null; // bracketed paste 聚合中
  let decoder = newDecoder(); // 流式 UTF-8 解码（跨 feed 保持半字节状态）
  let lastFeedAt = now();

  function consume(n: number): void {
    buf = buf.slice(n);
  }

  function emitText(bytes: readonly number[], events: InputEvent[]): void {
    // stream: true → 末尾残缺多字节留在 decoder 内，等下次 feed / flush 续解
    const s = decoder.decode(Uint8Array.from(bytes), { stream: true });
    emitDecodedText(s, events);
  }

  function emitDecodedText(s: string, events: InputEvent[]): void {
    for (const ch of s) {
      // for..of / Array.from 按码点迭代，surrogate pair 不拆
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x0d) {
        events.push(keyEvent('enter', noModifiers()));
      } else if (cp === 0x0a) {
        events.push(keyEvent('j', { shift: false, alt: false, ctrl: true }));
      } else if (cp === 0x09) {
        events.push(keyEvent('tab', noModifiers()));
      } else if (cp === 0x7f) {
        events.push(keyEvent('backspace', noModifiers()));
      } else if (cp === 0x00) {
        events.push(keyEvent(' ', { shift: false, alt: false, ctrl: true })); // Ctrl+Space（Ctrl+@）
      } else if (cp >= 0x01 && cp <= 0x1a) {
        events.push(keyEvent(String.fromCharCode(0x60 + cp), { shift: false, alt: false, ctrl: true }));
      } else if (cp >= 0x1c && cp <= 0x1f) {
        const k = ['\\', ']', '^', '_'][cp - 0x1c] ?? '?';
        events.push(keyEvent(k, { shift: false, alt: false, ctrl: true }));
      } else if (cp === 0x1b) {
        events.push(escKeyEvent()); // 理论上不会走到（run 以 ESC 截断），兜底
      } else {
        events.push(keyEvent(ch, noModifiers(), ch));
      }
    }
  }

  type EscapeResult = 'consumed' | 'incomplete';

  function tryEscape(events: InputEvent[]): EscapeResult {
    if (buf.length < 2) return 'incomplete'; // 孤立 ESC（可能还在等 '[' / 'O' / Alt+char）
    const b1 = buf[1];
    if (b1 === undefined) return 'incomplete';
    if (b1 === 0x5b) return tryCsi(events);
    if (b1 === 0x4f) return trySs3(events);
    if (b1 >= 0x20 && b1 < 0x7f) {
      // Alt+char（meta 前缀）：终端对 Alt+x 的经典编码
      const ch = String.fromCharCode(b1);
      events.push(keyEvent(ch, { shift: false, alt: true, ctrl: false }, ch));
      consume(2);
      return 'consumed';
    }
    // ESC + 控制字节 / 高位字节：按孤立 Esc 键处理，剩余字节下一轮按文本解析
    events.push(escKeyEvent());
    consume(1);
    return 'consumed';
  }

  function tryCsi(events: InputEvent[]): EscapeResult {
    const b2 = buf[2];
    if (b2 === undefined) return 'incomplete';
    if (b2 === 0x3c) return trySgrMouse(events); // '<'
    if (b2 === 0x4d) return tryX10Mouse(events); // 'M'
    if (b2 === 0x5b) return tryCsiDoubleBracket(events); // '['（Linux console / putty）
    // 通用 CSI：参数 0x30-0x3F、中间字节 0x20-0x2F、final 0x40-0x7E
    for (let i = 2; i < buf.length; i += 1) {
      const c = buf[i];
      if (c === undefined) break;
      if (c >= 0x40 && c <= 0x7e) {
        const body = String.fromCharCode(...buf.slice(2, i));
        const final = String.fromCharCode(c);
        consume(i + 1);
        parseCsi(body, final, events);
        return 'consumed';
      }
      if (c < 0x20 || c > 0x3f) {
        // 非法 CSI：孤立 Esc 降级，后续字节按文本解析
        events.push(escKeyEvent());
        consume(1);
        return 'consumed';
      }
    }
    return 'incomplete';
  }

  /**
   * CSI [[ 前缀（Linux console / putty，ink keyName 表同款）：
   * \x1b[[A..[[E → f1..f5、\x1b[[5~/[[6~ → pageup/pagedown。
   * 不走通用 CSI 解析（'[' 本身落在 final 字节区，通用路径会把 [[A 吞成未知 final）。
   */
  function tryCsiDoubleBracket(events: InputEvent[]): EscapeResult {
    const c = buf[3];
    if (c === undefined) return 'incomplete'; // \x1b[[ 半包，等后续字节
    const fn = { 0x41: 'f1', 0x42: 'f2', 0x43: 'f3', 0x44: 'f4', 0x45: 'f5' }[c];
    if (fn !== undefined) {
      consume(4);
      events.push(keyEvent(fn, noModifiers()));
      return 'consumed';
    }
    if ((c === 0x35 || c === 0x36) && buf[4] === 0x7e) {
      consume(5);
      events.push(keyEvent(c === 0x35 ? 'pageup' : 'pagedown', noModifiers()));
      return 'consumed';
    }
    // 未识别的 [[ 序列：按孤立 Esc 降级，其余字节按文本解析（与未知 final 口径一致）
    events.push(escKeyEvent());
    consume(1);
    return 'consumed';
  }

  function trySgrMouse(events: InputEvent[]): EscapeResult {
    for (let i = 3; i < buf.length; i += 1) {
      const c = buf[i];
      if (c === undefined) break;
      if (c === 0x4d || c === 0x6d) {
        // 'M' 按下/移动，'m' 释放
        const params = String.fromCharCode(...buf.slice(3, i));
        consume(i + 1);
        parseSgrMouse(params, c === 0x4d, events);
        return 'consumed';
      }
      if (c < 0x30 || c > 0x3b) {
        events.push(escKeyEvent());
        consume(1);
        return 'consumed';
      }
    }
    return 'incomplete';
  }

  function tryX10Mouse(events: InputEvent[]): EscapeResult {
    if (buf.length < 6) return 'incomplete'; // ESC [ M + 3 原始字节
    const cb = buf[3] ?? 0;
    const cx = buf[4] ?? 0;
    const cy = buf[5] ?? 0;
    consume(6);
    const b = Math.max(0, cb - 32);
    const wheel = (b & 64) !== 0;
    const kind: MouseEvent['kind'] = wheel ? 'scroll' : 'down';
    const button = wheel ? b & 3 : (b & 128) !== 0 ? (b & 3) + 4 : b & 3;
    const ev: MouseEvent = {
      type: 'mouse',
      kind,
      button,
      col: Math.max(0, cx - 33),
      row: Math.max(0, cy - 33),
      modifiers: modifiersFromBits((b >> 2) & 7),
      consumed: false,
    };
    events.push(ev);
    return 'consumed';
  }

  function trySs3(events: InputEvent[]): EscapeResult {
    for (let i = 2; i < buf.length; i += 1) {
      const c = buf[i];
      if (c === undefined) break;
      if (c >= 0x40 && c <= 0x7e) {
        const parts = String.fromCharCode(...buf.slice(2, i)).split(';');
        const final = String.fromCharCode(c);
        consume(i + 1);
        parseSs3Final(final, modifierBitsFromParams(parts), events);
        return 'consumed';
      }
      if (c < 0x20 || c > 0x3b) {
        events.push(escKeyEvent());
        consume(1);
        return 'consumed';
      }
    }
    return 'incomplete';
  }

  function parseSs3Final(final: string, bits: number, events: InputEvent[]): void {
    const mods = modifiersFromBits(bits);
    const arrow =
      final === 'A' ? 'up' : final === 'B' ? 'down' : final === 'C' ? 'right' : final === 'D' ? 'left' : null;
    if (arrow !== null) {
      events.push(keyEvent(arrow, mods));
      return;
    }
    if (final === 'H') return void events.push(keyEvent('home', mods));
    if (final === 'F') return void events.push(keyEvent('end', mods));
    const fn = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }[final];
    if (fn !== undefined) {
      events.push(keyEvent(fn, mods));
      return;
    }
    // SS3 小写 final（rxvt；ink keyName 表 Oa-De 属 isCtrlKey → ctrl 修饰，实测 7.1.1 一致）
    const ctrlKey = { a: 'up', b: 'down', c: 'right', d: 'left', e: 'clear' }[final];
    if (ctrlKey !== undefined) {
      events.push(keyEvent(ctrlKey, { shift: false, alt: false, ctrl: true }));
      return;
    }
    // SS3 小写 Oh/Of → home/end（ink 表为 OH/OF 大写；部分终端发小写形式，
    // 桥接层把 home/end 改写为 CSI 等价 \x1b[H / \x1b[F，ink 两形式同键）
    if (final === 'h') return void events.push(keyEvent('home', noModifiers()));
    if (final === 'f') return void events.push(keyEvent('end', noModifiers()));
    // 未识别的 SS3 final：序列已完整，静默吞掉（终端私有序列，不产垃圾事件）
  }

  function parseCsi(body: string, final: string, events: InputEvent[]): void {
    const parts = body === '' ? [] : body.split(';');
    const mods = modifiersFromBits(modifierBitsFromParams(parts));
    if (final === 'I' && parts.length === 0) {
      const ev: FocusEvent = { type: 'focus', direction: 'in', consumed: false };
      events.push(ev);
      return;
    }
    if (final === 'O' && parts.length === 0) {
      const ev: FocusEvent = { type: 'focus', direction: 'out', consumed: false };
      events.push(ev);
      return;
    }
    if (final === 'u') {
      parseKitty(parts, events);
      return;
    }
    if (final === '~') {
      const code = Number.parseInt(parts[0] ?? '', 10);
      if (Number.isNaN(code)) return;
      if (code === 200) {
        pasteBuf = []; // 开启聚合；后续 feed 的原始字节并入 pasteBuf
        return;
      }
      if (code === 201) return; // 游离终止符（正常路径在 pasteBuf 扫描中消费）：忽略
      const name = TILDE_KEYS[code];
      if (name !== undefined) events.push(keyEvent(name, mods));
      return;
    }
    const arrow =
      final === 'A' ? 'up' : final === 'B' ? 'down' : final === 'C' ? 'right' : final === 'D' ? 'left' : null;
    if (arrow !== null) {
      events.push(keyEvent(arrow, mods));
      return;
    }
    if (final === 'H') return void events.push(keyEvent('home', mods));
    if (final === 'F') return void events.push(keyEvent('end', mods));
    if (final === 'Z') return void events.push(keyEvent('tab', modifiersFromBits(1)));
    const fn = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }[final];
    if (fn !== undefined) {
      events.push(keyEvent(fn, mods));
      return;
    }
    // 其它 final（E/G/J/K 等）：完整但未解释的序列，静默吞掉
  }

  function parseKitty(parts: readonly string[], events: InputEvent[]): void {
    const codeSegs = (parts[0] ?? '').split(':');
    const code = Number.parseInt(codeSegs[0] ?? '', 10);
    if (Number.isNaN(code)) return;
    let bits = 0;
    let event: 'press' | 'repeat' | 'release' = 'press';
    const modSeg = parts[1];
    if (modSeg !== undefined) {
      const segs = modSeg.split(':');
      const n = Number.parseInt(segs[0] ?? '1', 10);
      bits = Number.isNaN(n) ? 0 : Math.max(0, n - 1);
      const evNum = segs[1] !== undefined ? Number.parseInt(segs[1], 10) : NaN;
      if (evNum === 2) event = 'repeat';
      else if (evNum === 3) event = 'release';
    }
    const mods = modifiersFromBits(bits);
    const special = kittyKeyOf(code);
    const key = special !== null ? special.key : String.fromCodePoint(code);
    const ev: KeyEvent = {
      type: 'key',
      key,
      modifiers: mods,
      kitty: { codepoint: code, event },
      ...(special === null ? { text: key } : {}),
      consumed: false,
    };
    events.push(ev);
  }

  function parseSgrMouse(params: string, pressOrMotion: boolean, events: InputEvent[]): void {
    const parts = params.split(';');
    const cb = Number.parseInt(parts[0] ?? '', 10);
    const x = Number.parseInt(parts[1] ?? '', 10);
    const y = Number.parseInt(parts[2] ?? '', 10);
    if (Number.isNaN(cb) || Number.isNaN(x) || Number.isNaN(y)) return;
    const wheel = (cb & 64) !== 0;
    const motion = (cb & 32) !== 0;
    const kind: MouseEvent['kind'] = wheel ? 'scroll' : motion ? 'move' : pressOrMotion ? 'down' : 'up';
    const button = (cb & 128) !== 0 ? (cb & 3) + 4 : cb & 3;
    const ev: MouseEvent = {
      type: 'mouse',
      kind,
      button,
      col: Math.max(0, x - 1),
      row: Math.max(0, y - 1),
      modifiers: modifiersFromBits((cb >> 2) & 7),
      consumed: false,
    };
    events.push(ev);
  }

  function tryFinishPaste(events: InputEvent[]): void {
    if (pasteBuf === null) return;
    const pb = pasteBuf;
    for (const b of buf) pb.push(b);
    buf = [];
    const idx = findSubsequence(pb, PASTE_END);
    if (idx === -1) return; // 终止符未到，继续聚合
    const content = pb.slice(0, idx);
    const rest = pb.slice(idx + PASTE_END.length);
    pasteBuf = null;
    const text = newDecoder().decode(Uint8Array.from(content)); // 整体解码，与流式状态隔离
    const ev: PasteEvent = { type: 'paste', text, consumed: false };
    events.push(ev);
    buf = rest; // 终止符之后的字节按普通输入继续
  }

  function process(events: InputEvent[]): void {
    for (;;) {
      if (pasteBuf !== null) {
        tryFinishPaste(events);
        if (pasteBuf !== null) return; // 仍在聚合，等下一批字节
        continue; // paste 已终结，残余 buf 继续按普通输入解析
      }
      if (buf.length === 0) return;
      const b0 = buf[0];
      if (b0 === undefined) return;
      if (b0 === 0x1b) {
        const r = tryEscape(events);
        if (r === 'incomplete') return; // 半包，等下一批
        continue;
      }
      // 普通文本 run：吃到下一个 ESC（或末尾）为止
      let i = 1; // b0 非 ESC
      while (i < buf.length && buf[i] !== 0x1b) i += 1;
      const run = buf.slice(0, i);
      buf = buf.slice(i);
      emitText(run, events);
    }
  }

  function drain(forceText: (bytes: readonly number[], events: InputEvent[]) => void): InputEvent[] {
    const events: InputEvent[] = [];
    if (pasteBuf !== null) {
      for (const b of buf) pasteBuf.push(b);
      buf = [];
      const text = newDecoder().decode(Uint8Array.from(pasteBuf));
      events.push({ type: 'paste', text, consumed: false });
      pasteBuf = null;
    }
    while (buf.length > 0) {
      const b0 = buf[0];
      if (b0 === 0x1b) {
        events.push(escKeyEvent());
        consume(1);
        continue;
      }
      let i = 1;
      while (i < buf.length && buf[i] !== 0x1b) i += 1;
      const run = buf.slice(0, i);
      buf = buf.slice(i);
      forceText(run, events);
    }
    return events;
  }

  // 先赋给具名常量再返回：flushIdle 等内部方法经 parser.flush() 互调，
  // 不依赖 this（调用方解构 const { flushIdle } = parser 也不会 TypeError）。
  const parser: InputParser = {
    feed(bytes) {
      const chunk = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
      lastFeedAt = now();
      for (const b of chunk) buf.push(b);
      const events: InputEvent[] = [];
      process(events);
      return events;
    },

    flush() {
      // 强制冲刷：孤立/半包 ESC → Esc 键；残余文本走「解码 + 冲刷 decoder」，
      // 把流式挂起的残缺半字节以 U+FFFD 产出，绝不静默吞字节。
      const events = drain((bytes, evs) => {
        emitDecodedText(decoder.decode(Uint8Array.from(bytes), { stream: true }), evs);
      });
      emitDecodedText(decoder.decode(), events); // 最终冲刷：decoder 内挂起的残缺半字节 → U+FFFD
      return events;
    },

    flushIdle(nowArg) {
      const t = nowArg ?? now();
      if (pasteBuf !== null) {
        // paste 聚合空闲超过上限：终止符 201~ 永不到达（流损坏），把已聚合内容作为
        // 单个 PasteEvent 产出（未超时则保持聚合，分片到达不被切碎）。
        if (t - lastFeedAt < pasteIdleTimeoutMs) return [];
        for (const b of buf) pasteBuf.push(b); // 防御性并入（process() 保证聚合期 buf 恒空）
        buf = [];
        const pb = pasteBuf;
        pasteBuf = null;
        const text = newDecoder().decode(Uint8Array.from(pb));
        return [{ type: 'paste', text, consumed: false }];
      }
      const first = buf[0];
      if (first === 0x1b && t - lastFeedAt >= escTimeoutMs) return parser.flush();
      return [];
    },

    pendingLength() {
      return buf.length + (pasteBuf !== null ? pasteBuf.length : 0);
    },

    hasPendingPaste() {
      return pasteBuf !== null;
    },

    reset() {
      buf = [];
      pasteBuf = null;
      decoder = newDecoder();
      lastFeedAt = now();
    },
  };
  return parser;
}
