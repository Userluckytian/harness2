// T2 terminal-events：SGR 鼠标 + DECSET 1004 焦点序列解析（纯函数）与 stdin 桥接。
// - 滚轮上/下（\x1b[<64;…M / \x1b[<65;…M）→ wheel 事件；点击/拖拽/释放消费但不转发
// - 焦点 \x1b[I / \x1b[O → focus 事件；SS3 功能键（\x1b[OA 等）整体回注，不被误判为焦点丢失
// - 分片投递 / 挂起超时 / 普通键/粘贴字节原样回注（键盘回归红线）
// - 桥接：prependListener 先于 ink 消费；enabled 时写 enable 序列、dispose 还原
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  TerminalEventParser,
  parseSgrMouse,
  attachTerminalEvents,
  type TerminalEvent,
} from '../../src/tui/terminal-events.js';

describe('parseSgrMouse：滚轮与无关事件', () => {
  it('滚轮上（64）→ wheel up', () => {
    expect(parseSgrMouse('\x1b[<64;12;5M')).toEqual({ type: 'wheel', up: true });
  });
  it('滚轮下（65）→ wheel down', () => {
    expect(parseSgrMouse('\x1b[<65;12;5M')).toEqual({ type: 'wheel', up: false });
  });
  it('左键点击（0）/拖拽/其他按钮 → null（消费不处理，YAGNI）', () => {
    expect(parseSgrMouse('\x1b[<0;12;5M')).toBeNull();
    expect(parseSgrMouse('\x1b[<32;12;5M')).toBeNull();
    expect(parseSgrMouse('\x1b[<35;12;5M')).toBeNull();
  });
  it('释放事件（m 结尾）→ null（滚动已在按下时处理）', () => {
    expect(parseSgrMouse('\x1b[<64;12;5m')).toBeNull();
    expect(parseSgrMouse('\x1b[<65;12;5m')).toBeNull();
  });
  it('畸形序列 → null（静默消费，不污染输入）', () => {
    expect(parseSgrMouse('\x1b[<abc')).toBeNull();
  });
});

describe('TerminalEventParser：增量解析与回注', () => {
  const p = (): TerminalEventParser => new TerminalEventParser();

  it('完整滚轮序列 → wheel 事件，无回注', () => {
    const r = p().push('\x1b[<64;12;5M');
    expect(r.events).toEqual([{ type: 'wheel', up: true }]);
    expect(r.forward).toBe('');
  });

  it('点击序列被消费（不回注，不进 ink 草稿）', () => {
    const r = p().push('\x1b[<0;12;5M');
    expect(r.events).toEqual([]);
    expect(r.forward).toBe('');
  });

  it('焦点 in/out', () => {
    expect(p().push('\x1b[I').events).toEqual([{ type: 'focus', focused: true }]);
    expect(p().push('\x1b[O').events).toEqual([]); // 裸 \x1b[O 挂起等待
  });

  it('SS3 方向键 \x1b[OA 整体回注（不误判焦点丢失，键盘回归）', () => {
    const r = p().push('\x1b[OA');
    expect(r.events).toEqual([]);
    expect(r.forward).toBe('\x1b[OA');
  });

  it('普通键/粘贴字节原样回注', () => {
    const r = p().push('hello');
    expect(r.forward).toBe('hello');
    expect(r.events).toEqual([]);
    const paste = p().push('\x1b[200~pasted\x1b[201~');
    expect(paste.forward).toBe('\x1b[200~pasted\x1b[201~');
  });

  it('滚轮与后续字节同 chunk：事件 + 剩余回注', () => {
    const r = p().push('\x1b[<64;1;1Mabc');
    expect(r.events).toEqual([{ type: 'wheel', up: true }]);
    expect(r.forward).toBe('abc');
  });

  it('分片投递：\x1b[< 与参数分两次到达', () => {
    const parser = p();
    const r1 = parser.push('\x1b[<');
    expect(r1.events).toEqual([]);
    expect(r1.forward).toBe('');
    expect(parser.hasPending()).toBe(true);
    const r2 = parser.push('65;10;5M');
    expect(r2.events).toEqual([{ type: 'wheel', up: false }]);
    expect(r2.forward).toBe('');
    expect(parser.hasPending()).toBe(false);
  });

  it('焦点丢失 \x1b[O 挂起后接普通键：焦点事件 + 普通键回注', () => {
    const parser = p();
    expect(parser.push('\x1b[O').events).toEqual([]);
    expect(parser.hasPending()).toBe(true);
    const r = parser.push('x');
    expect(r.events).toEqual([{ type: 'focus', focused: false }]);
    expect(r.forward).toBe('x');
  });

  it('挂起超时：鼠标残片按字面回注（对齐 ink pending escape）', () => {
    const parser = p();
    parser.push('\x1b[<64;1');
    expect(parser.hasPending()).toBe(true);
    const r = parser.flushPending();
    expect(r.events).toEqual([]);
    expect(r.forward).toBe('\x1b[<64;1');
    expect(parser.hasPending()).toBe(false);
  });

  it('挂起超时：裸 \x1b[O 按焦点丢失消费（不回注垃圾字节）', () => {
    const parser = p();
    parser.push('\x1b[O');
    const r = parser.flushPending();
    expect(r.events).toEqual([{ type: 'focus', focused: false }]);
    expect(r.forward).toBe('');
  });

  it('普通键在挂起前已被回注，后续字节继续回注', () => {
    const parser = p();
    const r1 = parser.push('a\x1b[<64;1;1M');
    expect(r1.events).toEqual([{ type: 'wheel', up: true }]);
    expect(r1.forward).toBe('a');
    expect(parser.push('b').forward).toBe('b');
  });
});

describe('attachTerminalEvents：stdin 桥接', () => {
  function fakeStreams(): { stdin: PassThrough; stdout: PassThrough } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => undefined;
    return { stdin, stdout };
  }

  it('enabled：attach 写 SGR+焦点 enable 序列；dispose 还原', () => {
    const { stdin, stdout } = fakeStreams();
    let out = '';
    stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const bridge = attachTerminalEvents(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, {
      enabled: true,
    });
    expect(out).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1004h');
    bridge.dispose();
    expect(out).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[?1006l\x1b[?1000l\x1b[?1004l');
  });

  it('disabled：不写 enable 序列；仍解析事件', async () => {
    const { stdin, stdout } = fakeStreams();
    let out = '';
    stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const bridge = attachTerminalEvents(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, {
      enabled: false,
    });
    const events: TerminalEvent[] = [];
    bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[<64;1;1M');
    stdin.write('a');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(out).toBe('');
    expect(events).toEqual([{ type: 'wheel', up: true }]);
    bridge.dispose();
  });

  it('非鼠标字节回注：后续可被另一 readable 消费者读到（不吞键）', () => {
    const { stdin } = fakeStreams();
    const bridge = attachTerminalEvents(
      stdin as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
      { enabled: false },
    );
    // 模拟 ink：注册一个 'readable' 监听（晚于桥接），消费回注字节
    const readByInk: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('readable', () => {
      let c: string | null;
      while ((c = stdin.read() as string | null) !== null) readByInk.push(c);
    });
    stdin.write('\x1b[<65;1;1M'); // 鼠标：桥接消费
    stdin.write('hi'); // 普通键：回注给 ink
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(readByInk.join('')).toBe('hi');
        bridge.dispose();
        resolve();
      }),
    );
  });

  it('subscribe 退订后不再收到事件', async () => {
    const { stdin, stdout } = fakeStreams();
    const bridge = attachTerminalEvents(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream, {
      enabled: false,
    });
    const events: TerminalEvent[] = [];
    const unsub = bridge.subscribe((e) => events.push(e));
    stdin.write('\x1b[I');
    await new Promise<void>((resolve) => setTimeout(resolve, 30)); // 等第一条事件投递完成
    unsub();
    stdin.write('\x1b[<64;1;1M');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual([{ type: 'focus', focused: true }]);
    bridge.dispose();
  });
});
