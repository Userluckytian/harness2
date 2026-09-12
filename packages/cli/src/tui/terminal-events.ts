// terminal-events.ts — SGR 鼠标上报（DECSET 1000/1006）+ 焦点事件（DECSET 1004）的原生解析与 stdin 桥接。
// 零第三方依赖：直接用 ANSI 序列自行解析，不引 crossterm/readline 类包（计划红线：不新增运行时依赖）。
//
// 为什么必须拦截 stdin（而不是等 ink 解析）：
//   ink 7 的 useInput 经 parse-keypress 解析输入；SGR 鼠标序列 `\x1b[<64;12;5M` 不被任何分支识别，
//   会作为字面 input 流入 Composer 草稿（滚轮变乱码输入）。因此本模块在 ink 之前消费 stdin：
//   - 在 render() 之前用 on('readable') 挂接（Node 的 Readable.on 对 'readable' 有流状态特殊处理，
//     prependListener 不走该路径收不到事件；靠注册顺序保证先于 ink 的 'readable' 监听执行）；
//   - 从读到的字节里剥离完整鼠标/焦点序列，其余字节用 stream.unshift() 回注，ink 在同一事件周期内
//     原样 read 到（不改变键盘/粘贴/IME 字节流）。
//
// 上报开关：attach 时写 `\x1b[?1000h\x1b[?1006h\x1b[?1004h`，dispose 时还原 `\x1b[?1006l\x1b[?1000l\x1b[?1004l`。
// 环境变量 HARNESS2_MOUSE=0 可关闭上报（仍保留解析能力；计划 T2 降级条款的开关）。
//
// 只消费鼠标/焦点序列；PageUp/PageDown/Ctrl+G/Ctrl+O/Ctrl+R、Esc/Ctrl+C 等键盘字节一律原样回注。

export type TerminalEvent = { type: 'wheel'; up: boolean } | { type: 'focus'; focused: boolean };

export interface ParsedChunk {
  events: TerminalEvent[];
  /** 应原样回注给 ink 的字节（剩余字节） */
  forward: string;
}

/** 挂起判定超时：残缺序列（如只有一半的鼠标/焦点序列）超过此时长按字面回注（对齐 ink 的 pending escape 语义） */
const PENDING_FLUSH_MS = 40;

/** SS3 功能键终字母（ESC O + letter）：焦点丢失序列是裸 `\x1b[O`，带字母则可能是 SS3 键（箭头/Home/End/F1-F4） */
const SS3_LETTERS = new Set(['A', 'B', 'C', 'D', 'H', 'F', 'P', 'Q', 'R', 'S', 'a', 'b', 'c', 'd', 'h', 'f']);

/**
 * 增量解析器（纯逻辑，可单测）：push 一段 utf8 文本，返回事件与应回注字节。
 * 内部缓冲跨 chunk 的不完整序列。
 */
export class TerminalEventParser {
  private buf = '';
  /** 当前挂起的是哪种前缀（用于超时后的处理方式：鼠标残片回注为字面，焦点残片按焦点事件消费） */
  private pendingKind: 'mouse' | 'focus-out' | 'csi' | null = null;

  push(chunk: string): ParsedChunk {
    this.buf += chunk;
    const events: TerminalEvent[] = [];
    let forward = '';
    this.pendingKind = null;

    for (;;) {
      if (this.buf.length === 0) break;
      if (this.buf.startsWith('\x1b[<')) {
        // SGR 鼠标：\x1b[<Cb;Cx;CyM（按下/滚动）或 ...m（释放）
        let end = -1;
        for (let i = 3; i < this.buf.length; i += 1) {
          const c = this.buf.charAt(i);
          if (c === 'M' || c === 'm') {
            end = i;
            break;
          }
        }
        if (end < 0) {
          this.pendingKind = 'mouse';
          break; // 保留 buf，等后续字节
        }
        const seq = this.buf.slice(0, end + 1);
        this.buf = this.buf.slice(end + 1);
        const ev = parseSgrMouse(seq);
        if (ev !== null) events.push(ev);
        continue;
      }
      if (this.buf.startsWith('\x1b[I')) {
        // DECSET 1004 focus in：\x1b[I（恰好 3 字节，无更长形式）
        this.buf = this.buf.slice(3);
        events.push({ type: 'focus', focused: true });
        continue;
      }
      if (this.buf.startsWith('\x1b[O')) {
        if (this.buf.length === 3) {
          // 可能是焦点丢失（\x1b[O）或 SS3 键（\x1b[OA 等）的前半截：等后续字节
          this.pendingKind = 'focus-out';
          break;
        }
        const letter = this.buf.charAt(3);
        if (SS3_LETTERS.has(letter)) {
          // SS3 功能键（ESC O A/B/C/D/H/F/P/Q/R/S 等）：整体回注，让 ink 解析成方向键等
          this.buf = this.buf.slice(4);
          forward += '\x1b[O' + letter;
          continue;
        }
        // 非 SS3 字母 → 是焦点丢失后跟普通输入：消费焦点序列，其余留给下一轮
        this.buf = this.buf.slice(3);
        events.push({ type: 'focus', focused: false });
        continue;
      }
      if (this.buf === '\x1b[' || this.buf === '\x1b') {
        // 可能是不完整 CSI / 单独 ESC：等后续字节（ink 自身也有 pending escape 逻辑）
        this.pendingKind = 'csi';
        break;
      }
      if (this.buf.startsWith('\x1b')) {
        // 以 ESC 开头但非已知前缀（如 Alt+x 的 \x1bx、完整 CSI 功能键 \x1b[A）：
        // 取到下一个 ESC 为止整体交给 ink，后续（可能是鼠标序列）继续解析
        const nextEsc = this.buf.indexOf('\x1b', 1);
        const piece = nextEsc < 0 ? this.buf : this.buf.slice(0, nextEsc);
        forward += piece;
        this.buf = this.buf.slice(piece.length);
        continue;
      }
      // 普通字节：取到下一个 ESC 为止整体回注（避免把后续鼠标序列一起带出）
      const nextEsc = this.buf.indexOf('\x1b');
      const ordinary = nextEsc < 0 ? this.buf : this.buf.slice(0, nextEsc);
      forward += ordinary;
      this.buf = this.buf.slice(ordinary.length);
    }

    return { events, forward };
  }

  /** 是否有未完成的挂起序列 */
  hasPending(): boolean {
    return this.pendingKind !== null;
  }

  /** 超时落定：按挂起类型消费或回注 */
  flushPending(): ParsedChunk {
    const kind = this.pendingKind;
    this.pendingKind = null;
    if (kind === 'mouse' || kind === 'csi') {
      // 鼠标残片 / 孤立 ESC：按字面回注（对齐 ink 的 pending escape 语义）
      const forward = this.buf;
      this.buf = '';
      return { events: [], forward };
    }
    if (kind === 'focus-out') {
      this.buf = '';
      return { events: [{ type: 'focus', focused: false }], forward: '' };
    }
    this.buf = '';
    return { events: [], forward: '' };
  }
}

/** 解析一条完整 SGR 鼠标序列；非滚轮事件返回 null（点击/拖拽 YAGNI：消费掉，不进 ink） */
export function parseSgrMouse(seq: string): TerminalEvent | null {
  const m = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(seq);
  if (m === null) return null; // 畸形序列：静默消费（理论不出现；若出现也避免污染输入）
  if (m[2] === 'm') return null; // 释放事件：滚动已在按下时处理
  const button = Number(m[1]);
  if (button === 64) return { type: 'wheel', up: true };
  if (button === 65) return { type: 'wheel', up: false };
  return null; // 点击/拖拽：本阶段不处理（YAGNI）
}

export interface TerminalEventBridge {
  /** 订阅解析出的事件；返回退订函数 */
  subscribe: (fn: (event: TerminalEvent) => void) => () => void;
  /** 还原上报模式并摘除 stdin 监听（退出/卸载时调用） */
  dispose: () => void;
  /** 是否已挂接 stdin */
  attached: boolean;
}

export interface AttachOptions {
  /** 是否向上报 SGR 鼠标 + 焦点事件（写 enable 序列）；false = 仅解析不启用（HARNESS2_MOUSE=0） */
  enabled: boolean;
}

/**
 * 在 ink 挂载前对 stdin 挂接 'readable' 拦截（必须在 render() 之前 attach：
 * Node 的 Readable.on 对 'readable' 有流状态特殊处理，prependListener 收不到事件，
 * 只能靠注册顺序保证先于 ink 读取）。enabled 时向 stdout 写 enable 序列；dispose 时还原。
 */
export function attachTerminalEvents(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  options: AttachOptions,
): TerminalEventBridge {
  const parser = new TerminalEventParser();
  const listeners = new Set<(event: TerminalEvent) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** 超时回注后的一次性旁路：避免我们自己在同一次 'readable' 里再把回注字节捡回去 */
  let bypassNextRead = false;

  const notify = (event: TerminalEvent): void => {
    for (const fn of listeners) fn(event);
  };

  /**
   * 把应回注给 ink 的字节 unshift 回 stdin。
   * 只在存在其他 'readable' 消费者（即 ink 的监听）时回注：Node 的 unshift 会再次触发 'readable'，
   * 若只有本桥一个监听，我们会在下一次事件里重新读到自己的回注字节 → 无限循环。
   * 有 ink 消费者时，ink 在同一事件周期内 drain 掉回注字节，下一次 'readable' 读到 null，循环终止。
   */
  const forwardToInk = (text: string): void => {
    if (text.length === 0) return;
    if (stdin.listenerCount('readable') > 1) {
      stdin.unshift(text);
    }
    // 无其他消费者（测试/极端时序）：字节留在缓冲区即可，不重入
  };

  const schedulePending = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!parser.hasPending()) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      const result = parser.flushPending();
      for (const ev of result.events) notify(ev);
      if (result.forward.length > 0) {
        bypassNextRead = true;
        if (stdin.listenerCount('readable') > 1) {
          stdin.unshift(result.forward);
          // unshift 会触发 'readable'（唤醒 ink 的读取监听；我们的监听随后会旁路转发）
        }
      }
    }, PENDING_FLUSH_MS);
  };

  const onReadable = (): void => {
    const chunk = stdin.read();
    if (chunk === null || chunk === undefined) return;
    const text = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    let events: TerminalEvent[] = [];
    let forward = '';
    if (bypassNextRead) {
      bypassNextRead = false;
      forward = text;
    } else {
      const result = parser.push(text);
      events = result.events;
      forward = result.forward;
    }
    for (const ev of events) notify(ev);
    forwardToInk(forward);
    schedulePending();
  };

  stdin.on('readable', onReadable);
  if (options.enabled) {
    stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?1004h');
  }

  return {
    attached: true,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      stdin.removeListener('readable', onReadable);
      if (options.enabled) {
        stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1004l');
      }
    },
  };
}
