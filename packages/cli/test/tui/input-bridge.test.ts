// T1-4 输入路径迁移：stdin 原始字节 → 统一解析器（src/input/parser.ts）→ 事件桥。
//  - MouseEvent/FocusEvent → 既有 wheel/focus TerminalEvent（行为与开关 HARNESS2_MOUSE 语义不变）；
//  - KeyEvent/PasteEvent → 序列化回注给 ink useInput/usePaste（键盘/粘贴逐字节等价，SS3→CSI 为
//    ink 解析等价改写；Ctrl+C 双击、Esc、粘贴归一链路全部不变）；
//  - 孤立 ESC 由 flushIdle 空闲超时按 Esc 键回注（对齐 legacy PENDING_FLUSH=40ms）；
//  - HARNESS2_INPUT=legacy 时完全绕过统一解析器，走旧 TerminalEventParser 字节回注路径。
// 用原始字节驱动假 stdin（PassThrough + 'readable'，注册顺序 = 桥先、ink 消费者后）。
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { attachTerminalEvents, type TerminalEvent } from '../../src/tui/terminal-events.js';
import { createUnifiedEventParser, keyEventToSequence, pasteEventToSequence } from '../../src/tui/input-bridge.js';

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStreams(): { stdin: PassThrough; stdout: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => undefined;
  return { stdin, stdout };
}

/** 模拟 ink：晚于桥接注册 'readable' 消费者，收集回注字节 */
function attachInkReader(stdin: PassThrough): { read: () => string } {
  let acc = '';
  stdin.setEncoding('utf8');
  stdin.on('readable', () => {
    let c: string | null;
    while ((c = stdin.read() as string | null) !== null) acc += c;
  });
  return { read: () => acc };
}

describe('keyEventToSequence / pasteEventToSequence：事件 → ink 可消费字节序列', () => {
  it('可打印字符（含中文）原样', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'a',
        text: 'a',
        modifiers: { shift: false, alt: false, ctrl: false },
        consumed: false,
      }),
    ).toBe('a');
    expect(
      keyEventToSequence({
        type: 'key',
        key: '终',
        text: '终',
        modifiers: { shift: false, alt: false, ctrl: false },
        consumed: false,
      }),
    ).toBe('终');
  });

  it('Ctrl+字母 → 控制字节（Ctrl+C 双击语义逐字节不变）', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'c',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x03');
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'j',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\n');
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'g',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x07');
  });

  it('Ctrl+Space / Ctrl+符号 → 对应控制字节', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: ' ',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x00');
    expect(
      keyEventToSequence({
        type: 'key',
        key: '\\',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x1c');
  });

  it('规范键 → ink 认识的序列（Enter/Tab/Backspace/Esc/方向/Home/End/Delete/PageUp）', () => {
    const noMods = { shift: false, alt: false, ctrl: false };
    const k = (key: string): { type: 'key'; key: string; modifiers: typeof noMods; consumed: boolean } => ({
      type: 'key',
      key,
      modifiers: noMods,
      consumed: false,
    });
    expect(keyEventToSequence(k('enter'))).toBe('\r');
    expect(keyEventToSequence(k('tab'))).toBe('\t');
    expect(keyEventToSequence(k('backspace'))).toBe('\x7f');
    expect(keyEventToSequence(k('escape'))).toBe('\x1b');
    expect(keyEventToSequence(k('up'))).toBe('\x1b[A');
    expect(keyEventToSequence(k('down'))).toBe('\x1b[B');
    expect(keyEventToSequence(k('left'))).toBe('\x1b[D');
    expect(keyEventToSequence(k('right'))).toBe('\x1b[C');
    expect(keyEventToSequence(k('home'))).toBe('\x1b[H');
    expect(keyEventToSequence(k('end'))).toBe('\x1b[F');
    expect(keyEventToSequence(k('delete'))).toBe('\x1b[3~');
    expect(keyEventToSequence(k('pageup'))).toBe('\x1b[5~');
    expect(keyEventToSequence(k('pagedown'))).toBe('\x1b[6~');
  });

  it('带修饰方向键/F 键回写修饰段（1;5=ctrl 等）', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'left',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x1b[1;5D');
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'f5',
        modifiers: { shift: false, alt: false, ctrl: true },
        consumed: false,
      }),
    ).toBe('\x1b[15;5~');
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'f1',
        modifiers: { shift: false, alt: false, ctrl: false },
        consumed: false,
      }),
    ).toBe('\x1b[11~');
  });

  it('Shift+Tab → CSI Z（ink isShiftKey 识别）', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'tab',
        modifiers: { shift: true, alt: false, ctrl: false },
        consumed: false,
      }),
    ).toBe('\x1b[Z');
  });

  it('Alt+char → ESC 前缀', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'x',
        text: 'x',
        modifiers: { shift: false, alt: true, ctrl: false },
        consumed: false,
      }),
    ).toBe('\x1bx');
  });

  it('kitty CSI-u 保真回写（codepoint;mods[:event]u）', () => {
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'a',
        text: 'a',
        modifiers: { shift: false, alt: false, ctrl: true },
        kitty: { codepoint: 97, event: 'press' },
        consumed: false,
      }),
    ).toBe('\x1b[97;5u');
    expect(
      keyEventToSequence({
        type: 'key',
        key: 'a',
        text: 'a',
        modifiers: { shift: false, alt: false, ctrl: false },
        kitty: { codepoint: 97, event: 'release' },
        consumed: false,
      }),
    ).toBe('\x1b[97;1:3u'); // kitty 语法：event 段前必须有 mods 段（缺省写 1）
  });

  it('PasteEvent → 还原 bracketed paste 包装（与 paste.ts 归一链路衔接）', () => {
    expect(pasteEventToSequence({ type: 'paste', text: '你好\n第二行\r\n', consumed: false })).toBe(
      '\x1b[200~你好\n第二行\r\n\x1b[201~',
    );
  });
});

describe('createUnifiedEventParser：统一解析器 → TerminalEvent / 回注字节', () => {
  /** 注入时钟：t 毫秒，手动推进（flushIdle 空闲阈值语义可测） */
  function makeParser(escTimeoutMs = 40): {
    p: ReturnType<typeof createUnifiedEventParser>;
    advance: (ms: number) => void;
  } {
    let t = 1000;
    const p = createUnifiedEventParser({ now: () => t, escTimeoutMs });
    return { p, advance: (ms: number) => (t += ms) };
  }

  it('SGR 滚轮上/下 → wheel 事件，无回注', () => {
    const { p } = makeParser();
    expect(p.push('\x1b[<64;12;5M')).toEqual({ events: [{ type: 'wheel', up: true }], forward: '' });
    expect(p.push('\x1b[<65;12;5M')).toEqual({ events: [{ type: 'wheel', up: false }], forward: '' });
  });

  it('点击/拖拽/移动/释放静默消费（不进 ink、不产生事件）', () => {
    const { p } = makeParser();
    expect(p.push('\x1b[<0;12;5M')).toEqual({ events: [], forward: '' });
    expect(p.push('\x1b[<0;12;5m')).toEqual({ events: [], forward: '' });
    expect(p.push('\x1b[<32;7;3M')).toEqual({ events: [], forward: '' });
  });

  it('焦点 I / O → focus 事件（SSI I 即时；CSI O 即时）', () => {
    const { p } = makeParser();
    expect(p.push('\x1b[I').events).toEqual([{ type: 'focus', focused: true }]);
    expect(p.push('\x1b[O').events).toEqual([{ type: 'focus', focused: false }]);
  });

  it('普通键盘逐字节等价回注：字符 / Ctrl+C / Ctrl+J / 方向键 / 粘贴', () => {
    const { p } = makeParser();
    expect(p.push('hi').forward).toBe('hi');
    expect(p.push('\x03').forward).toBe('\x03'); // Ctrl+C（双击退出语义不变）
    expect(p.push('\n').forward).toBe('\n'); // Ctrl+J（ink enter/ctrl+j 口径不变）
    expect(p.push('\x1b[A').forward).toBe('\x1b[A'); // CSI 方向键逐字节相同
    expect(p.push('\x1b[1;5D').forward).toBe('\x1b[1;5D'); // 带修饰方向键逐字节相同
    expect(p.push('\x1b[200~多行\n粘贴\x1b[201~').forward).toBe('\x1b[200~多行\n粘贴\x1b[201~');
  });

  it('SS3 方向键 → CSI 等价回注（ink 同解析为 up，键盘行为不变）', () => {
    const { p } = makeParser();
    expect(p.push('\x1bOA')).toEqual({ events: [], forward: '\x1b[A' });
    expect(p.push('\x1bOP')).toEqual({ events: [], forward: '\x1b[11~' });
  });

  it('kitty CSI-u 保真回写', () => {
    const { p } = makeParser();
    expect(p.push('\x1b[97;5u').forward).toBe('\x1b[97;5u');
  });

  it('分片：ESC 先到无产出，[A 后到 → 回注 \\x1b[A', () => {
    const { p } = makeParser();
    expect(p.push('\x1b')).toEqual({ events: [], forward: '' });
    expect(p.hasPending()).toBe(true);
    expect(p.push('[A')).toEqual({ events: [], forward: '\x1b[A' });
    expect(p.hasPending()).toBe(false);
  });

  it('分片：SGR 鼠标序列拆两次 → wheel down 一次，无字节泄漏', () => {
    const { p } = makeParser();
    expect(p.push('\x1b[<')).toEqual({ events: [], forward: '' });
    expect(p.hasPending()).toBe(true);
    expect(p.push('65;10;5M')).toEqual({ events: [{ type: 'wheel', up: false }], forward: '' });
    expect(p.hasPending()).toBe(false);
  });

  it('孤立 ESC：未超时不出（hasPending 保持），超时后按 Esc 键回注 \\x1b', () => {
    const { p, advance } = makeParser();
    expect(p.push('\x1b')).toEqual({ events: [], forward: '' });
    expect(p.hasPending()).toBe(true);
    advance(20);
    expect(p.flushPending()).toEqual({ events: [], forward: '' }); // 未达空闲阈值
    expect(p.hasPending()).toBe(true);
    advance(25); // 累计 45ms ≥ 40ms
    expect(p.flushPending()).toEqual({ events: [], forward: '\x1b' }); // Esc 键
    expect(p.hasPending()).toBe(false);
  });

  it('半包鼠标残片超时冲刷：按字面回注（与 legacy flushPending 逐字节一致）', () => {
    const { p, advance } = makeParser();
    expect(p.push('\x1b[<64;1')).toEqual({ events: [], forward: '' });
    advance(45);
    expect(p.flushPending()).toEqual({ events: [], forward: '\x1b[<64;1' });
  });

  it('半包 SS3（\\x1bO）超时冲刷：回注 \\x1bO（ink 端与 legacy 立即回注等价）', () => {
    const { p, advance } = makeParser();
    expect(p.push('\x1bO')).toEqual({ events: [], forward: '' });
    advance(45);
    expect(p.flushPending()).toEqual({ events: [], forward: '\x1bO' });
  });

  it('paste 聚合期间 flushPending 不冲刷（大粘贴分片不被切碎）', () => {
    const { p, advance } = makeParser();
    expect(p.push('\x1b[200~abc')).toEqual({ events: [], forward: '' });
    advance(100); // 远超阈值：paste 仍不得被冲刷
    expect(p.flushPending()).toEqual({ events: [], forward: '' });
    expect(p.push('def\x1b[201~')).toEqual({
      events: [],
      forward: '\x1b[200~abcdef\x1b[201~',
    });
  });
});

describe('attachTerminalEvents（unified 默认）：stdin 桥接', () => {
  afterEach(() => {
    delete process.env.HARNESS2_INPUT;
  });

  it('滚轮 → subscribe 收到 wheel 事件（HARNESS2_MOUSE 语义不变，enabled=false 不写序列）', async () => {
    const { stdin, stdout } = fakeStreams();
    let out = '';
    stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const events: TerminalEvent[] = [];
    bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[<64;1;1M');
    stdin.write('\x1b[<65;1;1M');
    await tick();
    expect(out).toBe('');
    expect(events).toEqual([
      { type: 'wheel', up: true },
      { type: 'wheel', up: false },
    ]);
    bridge.dispose();
  });

  it('焦点事件 → focus 通知（通知门控状态源不变）', async () => {
    const { stdin, stdout } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const events: TerminalEvent[] = [];
    bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[I');
    stdin.write('\x1b[O');
    await tick();
    expect(events).toEqual([
      { type: 'focus', focused: true },
      { type: 'focus', focused: false },
    ]);
    bridge.dispose();
  });

  it('普通键盘 → ink 消费者读到等价字节（字符 / Ctrl+C / 方向键）', async () => {
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('hi');
    await tick();
    stdin.write('\x03'); // Ctrl+C
    await tick();
    stdin.write('\x1b[A'); // up
    await tick();
    expect(ink.read()).toBe('hi\x03\x1b[A'); // 逐字节等价
    bridge.dispose();
  });

  it('粘贴 → ink 读到完整 bracketed paste（usePaste 通道不变）', async () => {
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('\x1b[200~你好\n第二行\x1b[201~');
    await tick();
    expect(ink.read()).toBe('\x1b[200~你好\n第二行\x1b[201~');
    bridge.dispose();
  });

  it('分片滚轮 + 后续键盘：wheel 事件一次，ink 只读到键盘字节', async () => {
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    const events: TerminalEvent[] = [];
    bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[<'); // 序列前半
    stdin.write('65;10;5M'); // 后半 → wheel down
    stdin.write('ok');
    await tick();
    expect(events).toEqual([{ type: 'wheel', up: false }]);
    expect(ink.read()).toBe('ok'); // 鼠标序列不泄漏进 ink
    bridge.dispose();
  });

  it('孤立 ESC 空闲超时 → ink 恰好收到一次 \\x1b（flushIdle 接线，Esc 键不吞不重）', async () => {
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('\x1b');
    await tick(120); // > 挂起冲刷间隔
    expect(ink.read()).toBe('\x1b');
    bridge.dispose();
  });

  it('默认（HARNESS2_INPUT 未设置）走统一解析器：未识别 CSI（\\x1b[E）静默消费，不进 ink', async () => {
    delete process.env.HARNESS2_INPUT;
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('\x1b[E');
    await tick();
    expect(ink.read()).toBe('');
    bridge.dispose();
  });
});

describe('HARNESS2_INPUT=legacy：完全绕过统一解析器走旧路径', () => {
  afterEach(() => {
    delete process.env.HARNESS2_INPUT;
  });

  it('旧解析器仍把未识别 CSI 原样回注（与 unified 的判别点）', async () => {
    process.env.HARNESS2_INPUT = 'legacy';
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('\x1b[E');
    await tick();
    expect(ink.read()).toBe('\x1b[E'); // legacy：字面回注
    bridge.dispose();
  });

  it('legacy：滚轮/焦点/键盘照常（旧 TerminalEventParser 路径完好）', async () => {
    process.env.HARNESS2_INPUT = 'legacy';
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
      },
    );
    const ink = attachInkReader(stdin);
    const events: TerminalEvent[] = [];
    bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[<64;1;1M');
    stdin.write('\x1b[I');
    stdin.write('a');
    await tick();
    expect(events).toEqual([
      { type: 'wheel', up: true },
      { type: 'focus', focused: true },
    ]);
    expect(ink.read()).toBe('a');
    bridge.dispose();
  });

  it("AttachOptions.parser='unified' 显式覆盖 legacy 环境变量", async () => {
    process.env.HARNESS2_INPUT = 'legacy';
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      {
        enabled: false,
        parser: 'unified',
      },
    );
    const ink = attachInkReader(stdin);
    stdin.write('\x1b[E');
    await tick();
    expect(ink.read()).toBe(''); // unified：静默消费
    bridge.dispose();
  });
});
