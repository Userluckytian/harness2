// P1 输入解析器测试（原始字节驱动，不 mock 解析器内部）：
// 可打印字符 / 控制键 / Ctrl+字母 / CSI 与 SS3 转义序列 / kitty CSI-u / SGR 与 X10 鼠标 /
// bracketed paste / 焦点 1004 / UTF-8 多字节（含跨 feed 撕裂）/ 分片与半包 / flush 超时语义。
// 所有用例只喂 Uint8Array 原始字节，不直接构造事件对象。
import { describe, expect, it } from 'vitest';
import { createInputParser } from '../../src/input/parser.js';
import type { FocusEvent, InputEvent, KeyEvent, MouseEvent, PasteEvent } from '../../src/input/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const raw = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

function keys(events: InputEvent[]): KeyEvent[] {
  return events.filter((e): e is KeyEvent => e.type === 'key');
}
function keyOf(events: InputEvent[]): KeyEvent {
  const k = keys(events);
  expect(k.length).toBe(1);
  const first = k[0];
  expect(first).toBeDefined();
  return first as KeyEvent;
}
function mouseOf(events: InputEvent[]): MouseEvent {
  const m = events.filter((e): e is MouseEvent => e.type === 'mouse');
  expect(m.length).toBe(1);
  const first = m[0];
  expect(first).toBeDefined();
  return first as MouseEvent;
}
function pasteOf(events: InputEvent[]): PasteEvent {
  const p = events.filter((e): e is PasteEvent => e.type === 'paste');
  expect(p.length).toBe(1);
  const first = p[0];
  expect(first).toBeDefined();
  return first as PasteEvent;
}
function focusOf(events: InputEvent[]): FocusEvent {
  const f = events.filter((e): e is FocusEvent => e.type === 'focus');
  expect(f.length).toBe(1);
  const first = f[0];
  expect(first).toBeDefined();
  return first as FocusEvent;
}

describe('parser：可打印字符与基本控制键', () => {
  it('可打印 ASCII 逐字符产生 KeyEvent（text=key）', () => {
    const p = createInputParser();
    const events = p.feed(enc('ab1'));
    expect(events.length).toBe(3);
    expect(keys(events).map((k) => k.key)).toEqual(['a', 'b', '1']);
    expect(keys(events).every((k) => k.text === k.key && !k.consumed)).toBe(true);
  });

  it('Enter(\\r) / Tab(\\t) / Backspace(\\x7f) 规范键名', () => {
    const p = createInputParser();
    expect(keyOf(p.feed(enc('\r'))).key).toBe('enter');
    expect(keyOf(p.feed(enc('\t'))).key).toBe('tab');
    expect(keyOf(p.feed(enc('\x7f'))).key).toBe('backspace');
  });

  it('Ctrl+字母（0x01-0x1A）解码为字母 + ctrl 修饰', () => {
    const p = createInputParser();
    const events = p.feed(raw(0x01, 0x1a));
    const [a, z] = keys(events);
    expect(a?.key).toBe('a');
    expect(a?.modifiers.ctrl).toBe(true);
    expect(z?.key).toBe('z');
    expect(z?.modifiers.ctrl).toBe(true);
  });

  it('\\n 解码为 Ctrl+J（kitty/legacy 口径，见设计取舍）', () => {
    const p = createInputParser();
    const j = keyOf(p.feed(enc('\n')));
    expect(j.key).toBe('j');
    expect(j.modifiers.ctrl).toBe(true);
  });

  it('Alt+char（ESC x）解码为 alt+x', () => {
    const p = createInputParser();
    const x = keyOf(p.feed(enc('\x1bx')));
    expect(x.key).toBe('x');
    expect(x.modifiers.alt).toBe(true);
  });
});

describe('parser：UTF-8 多字节与中文分片', () => {
  it('中文单 feed 正确解码为逐字符 KeyEvent', () => {
    const p = createInputParser();
    const events = p.feed(enc('终端'));
    expect(keys(events).map((k) => k.text)).toEqual(['终', '端']);
  });

  it('中文按整字拆两次 feed 不撕裂', () => {
    const p = createInputParser();
    expect(keys(p.feed(enc('终'))).map((k) => k.text)).toEqual(['终']);
    expect(keys(p.feed(enc('端'))).map((k) => k.text)).toEqual(['端']);
  });

  it('单字符字节流撕裂（feed 切在「终」字节中间）仍解码正确', () => {
    const p = createInputParser();
    const bytes = enc('终端');
    const first = p.feed(bytes.slice(0, 2)); // 「终」= E7 BB 88，切在前 2 字节 → 流式解码挂起
    expect(first).toEqual([]);
    const rest = p.feed(bytes.slice(2));
    expect(keys(rest).map((k) => k.text)).toEqual(['终', '端']);
  });

  it('文本与转义序列混合（a ESC[D b）', () => {
    const p = createInputParser();
    const events = p.feed(enc('a\x1b[Db'));
    expect(keys(events).map((k) => k.key)).toEqual(['a', 'left', 'b']);
  });
});

describe('parser：CSI / SS3 转义序列', () => {
  it('方向键 CSI A~D', () => {
    const p = createInputParser();
    expect(keyOf(p.feed(enc('\x1b[A'))).key).toBe('up');
    expect(keyOf(p.feed(enc('\x1b[B'))).key).toBe('down');
    expect(keyOf(p.feed(enc('\x1b[C'))).key).toBe('right');
    expect(keyOf(p.feed(enc('\x1b[D'))).key).toBe('left');
  });

  it('带修饰方向键（1;5=ctrl, 1;2=shift, 1;3=alt）', () => {
    const p = createInputParser();
    const ctrlLeft = keyOf(p.feed(enc('\x1b[1;5D')));
    expect(ctrlLeft.key).toBe('left');
    expect(ctrlLeft.modifiers.ctrl).toBe(true);
    const shiftRight = keyOf(p.feed(enc('\x1b[1;2C')));
    expect(shiftRight.key).toBe('right');
    expect(shiftRight.modifiers.shift).toBe(true);
    const altUp = keyOf(p.feed(enc('\x1b[1;3A')));
    expect(altUp.key).toBe('up');
    expect(altUp.modifiers.alt).toBe(true);
  });

  it('Home/End/Delete/PageUp/PageDown（H F 1~ 4~ 3~ 5~ 6~）', () => {
    const p = createInputParser();
    expect(keyOf(p.feed(enc('\x1b[H'))).key).toBe('home');
    expect(keyOf(p.feed(enc('\x1b[F'))).key).toBe('end');
    expect(keyOf(p.feed(enc('\x1b[1~'))).key).toBe('home');
    expect(keyOf(p.feed(enc('\x1b[4~'))).key).toBe('end');
    expect(keyOf(p.feed(enc('\x1b[3~'))).key).toBe('delete');
    expect(keyOf(p.feed(enc('\x1b[5~'))).key).toBe('pageup');
    expect(keyOf(p.feed(enc('\x1b[6~'))).key).toBe('pagedown');
  });

  it('Shift+Tab（CSI Z）', () => {
    const p = createInputParser();
    const t = keyOf(p.feed(enc('\x1b[Z')));
    expect(t.key).toBe('tab');
    expect(t.modifiers.shift).toBe(true);
  });

  it('SS3 功能键（ESC O 前缀）', () => {
    const p = createInputParser();
    expect(keyOf(p.feed(enc('\x1bOA'))).key).toBe('up');
    expect(keyOf(p.feed(enc('\x1bOB'))).key).toBe('down');
    expect(keyOf(p.feed(enc('\x1bOP'))).key).toBe('f1');
    expect(keyOf(p.feed(enc('\x1bOS'))).key).toBe('f4');
  });
});

describe('parser：kitty CSI-u', () => {
  it('裸 CSI-u（97u）→ 可打印字符 a 带 kitty 编码信息', () => {
    const p = createInputParser();
    const k = keyOf(p.feed(enc('\x1b[97u')));
    expect(k.key).toBe('a');
    expect(k.text).toBe('a');
    expect(k.kitty?.codepoint).toBe(97);
  });

  it('kitty 修饰位（97;5u → ctrl+a；13;2u → shift+enter）', () => {
    const p = createInputParser();
    const ctrlA = keyOf(p.feed(enc('\x1b[97;5u')));
    expect(ctrlA.key).toBe('a');
    expect(ctrlA.modifiers.ctrl).toBe(true);
    const shiftEnter = keyOf(p.feed(enc('\x1b[13;2u')));
    expect(shiftEnter.key).toBe('enter');
    expect(shiftEnter.modifiers.shift).toBe(true);
  });

  it('kitty 事件类型（97;1:3u → release）', () => {
    const p = createInputParser();
    const k = keyOf(p.feed(enc('\x1b[97;1:3u')));
    expect(k.key).toBe('a');
    expect(k.kitty?.event).toBe('release');
  });
});

describe('parser：SGR 鼠标（CSI < b;x;y M/m）', () => {
  it('按下与释放（0;10;5 M/m）→ 0 基列/行', () => {
    const p = createInputParser();
    const down = mouseOf(p.feed(enc('\x1b[<0;10;5M')));
    expect(down.kind).toBe('down');
    expect(down.button).toBe(0);
    expect(down.col).toBe(9);
    expect(down.row).toBe(4);
    const up = mouseOf(p.feed(enc('\x1b[<0;10;5m')));
    expect(up.kind).toBe('up');
    expect(up.button).toBe(0);
  });

  it('滚轮（64=up, 65=down）→ kind=scroll', () => {
    const p = createInputParser();
    const wheelUp = mouseOf(p.feed(enc('\x1b[<64;3;2M')));
    expect(wheelUp.kind).toBe('scroll');
    expect(wheelUp.button).toBe(0);
    expect(wheelUp.col).toBe(2);
    expect(wheelUp.row).toBe(1);
    const wheelDown = mouseOf(p.feed(enc('\x1b[<65;3;2M')));
    expect(wheelDown.kind).toBe('scroll');
    expect(wheelDown.button).toBe(1);
  });

  it('修饰位组合（4=shift, 8=alt, 16=ctrl）', () => {
    const p = createInputParser();
    const ctrl = mouseOf(p.feed(enc('\x1b[<16;1;1M')));
    expect(ctrl.kind).toBe('down');
    expect(ctrl.modifiers.ctrl).toBe(true);
    expect(ctrl.modifiers.shift).toBe(false);
    expect(ctrl.modifiers.alt).toBe(false);
    const all = mouseOf(p.feed(enc('\x1b[<28;1;1M')));
    expect(all.modifiers.shift).toBe(true);
    expect(all.modifiers.alt).toBe(true);
    expect(all.modifiers.ctrl).toBe(true);
  });

  it('移动事件（bit5=32 + 最终符 M）→ kind=move', () => {
    const p = createInputParser();
    const move = mouseOf(p.feed(enc('\x1b[<32;7;3M')));
    expect(move.kind).toBe('move');
    expect(move.col).toBe(6);
    expect(move.row).toBe(2);
  });
});

describe('parser：legacy X10 鼠标（ESC[M + 3 原始字节）', () => {
  it('按下事件坐标解码（0 基）', () => {
    const p = createInputParser();
    const m = mouseOf(p.feed(raw(0x1b, 0x5b, 0x4d, 32 + 0, 32 + 1, 32 + 2)));
    expect(m.kind).toBe('down');
    expect(m.button).toBe(0);
    expect(m.col).toBe(0);
    expect(m.row).toBe(1);
  });

  it('X10 滚轮（cb bit6=64）→ scroll up', () => {
    const p = createInputParser();
    const m = mouseOf(p.feed(raw(0x1b, 0x5b, 0x4d, 32 + 64, 32 + 5, 32 + 5)));
    expect(m.kind).toBe('scroll');
    expect(m.button).toBe(0);
  });

  it('X10 坐标不经过 UTF-8 解码（高位字节不产生乱码键）', () => {
    const p = createInputParser();
    const events = p.feed(raw(0x1b, 0x5b, 0x4d, 32 + 2, 32 + 200, 32 + 200));
    expect(events.length).toBe(1);
    const m = mouseOf(events);
    expect(m.col).toBe(199);
    expect(m.row).toBe(199);
  });
});

describe('parser：bracketed paste', () => {
  it('粘贴内容原样聚合为单个 PasteEvent（含换行与中文）', () => {
    const p = createInputParser();
    const events = p.feed(enc('\x1b[200~第一行\n第二行\r\n第三行\x1b[201~'));
    expect(events.length).toBe(1);
    expect(pasteOf(events).text).toBe('第一行\n第二行\r\n第三行');
  });

  it('粘贴分片（终止符 CSI 201~ 拆两次 feed）', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b[200~abc\x1b'))).toEqual([]);
    const events = p.feed(enc('[201~'));
    expect(events.length).toBe(1);
    expect(pasteOf(events).text).toBe('abc');
  });

  it('未闭合粘贴 flush() 强制输出已聚合内容', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b[200~abc'))).toEqual([]);
    const events = p.flush();
    expect(pasteOf(events).text).toBe('abc');
  });
});

describe('parser：焦点 1004', () => {
  it('CSI I / CSI O → focus in / out', () => {
    const p = createInputParser();
    expect(focusOf(p.feed(enc('\x1b[I'))).direction).toBe('in');
    expect(focusOf(p.feed(enc('\x1b[O'))).direction).toBe('out');
  });
});

describe('parser：分片容错与 flush 语义', () => {
  it('转义序列拆两次 feed（ESC 先到）→ 序列完整时才输出', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b'))).toEqual([]);
    expect(keyOf(p.feed(enc('[A'))).key).toBe('up');
  });

  it('kitty 序列拆三次 feed（半包）→ 完整时输出', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b'))).toEqual([]);
    expect(p.feed(enc('[97'))).toEqual([]);
    const k = keyOf(p.feed(enc(';5u')));
    expect(k.key).toBe('a');
    expect(k.modifiers.ctrl).toBe(true);
  });

  it('孤立 ESC：不 flush 不输出；flush() 按 Esc 键输出', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b'))).toEqual([]);
    const events = p.flush();
    expect(keyOf(events).key).toBe('escape');
  });

  it('flushIdle：注入 now()，未超时不出 Esc，超时后才出', () => {
    const now = 1000;
    const p = createInputParser({ now: () => now, escTimeoutMs: 50 });
    expect(p.feed(enc('\x1b'))).toEqual([]);
    expect(p.flushIdle(1049)).toEqual([]);
    const events = p.flushIdle(1050);
    expect(keyOf(events).key).toBe('escape');
  });

  it('flush() 强制输出半包 CSI：Esc + 残余字节按文本降级（无静默吞字节）', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b[1;'))).toEqual([]);
    const events = p.flush();
    const first = events[0];
    expect(first).toBeDefined();
    expect((first as KeyEvent).key).toBe('escape');
    // 残余 "1;" 降级为普通文本键，绝不静默丢弃
    expect(keys(events).map((k) => k.key)).toEqual(expect.arrayContaining(['1', ';']));
  });

  it('flush() 冲刷 UTF-8 残缺半字节 → U+FFFD 替换字符', () => {
    const p = createInputParser();
    expect(p.feed(enc('终').slice(0, 2))).toEqual([]);
    const events = p.flush();
    expect(keys(events).map((k) => k.text)).toEqual(['\u{FFFD}']);
  });

  it('flush 后解析器可继续使用（复位状态）', () => {
    const p = createInputParser();
    expect(p.feed(enc('\x1b'))).toEqual([]);
    p.flush();
    expect(keyOf(p.feed(enc('\x1b[B'))).key).toBe('down');
  });
});
