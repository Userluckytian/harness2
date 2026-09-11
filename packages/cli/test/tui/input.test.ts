// T1 输入内核纯函数单测：grapheme 边界、按 grapheme 删除、词移动/选区、Home/End、
// 软折行（CJK 宽字符 + 光标显示列）、硬换行、历史往返恢复 draft 与 selection、paste 原子插入。
import { describe, expect, it } from 'vitest';
import {
  canSubmit,
  createHistory,
  createHistoryState,
  createInputState,
  graphemeBoundaries,
  historyNext,
  historyPrev,
  historyPush,
  layoutInput,
  moveVertical,
  reduceInput,
  selectionRange,
  type InputState,
} from '../../src/tui/input.js';

// grapheme 用例
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 👨‍👩‍👧‍👦（ZWJ 序列，11 UTF-16）
const COMBINING = 'e\u0301'; // é（组合音标，2 UTF-16）
const FLAG = '\u{1F1E8}\u{1F1F3}'; // 🇨🇳（区域指示符，4 UTF-16）

describe('input.ts grapheme 边界', () => {
  it('ZWJ 序列整体是一个 grapheme', () => {
    expect(graphemeBoundaries(`a${FAMILY}b`)).toEqual([0, 1, 12, 13]);
  });

  it('组合字符 e + 音标是一个 grapheme', () => {
    expect(graphemeBoundaries(`${COMBINING}x`)).toEqual([0, 2, 3]);
  });

  it('区域指示符国旗是一个 grapheme', () => {
    expect(graphemeBoundaries(`${FLAG}x`)).toEqual([0, 4, 5]);
  });

  it('空串只有一个边界 0', () => {
    expect(graphemeBoundaries('')).toEqual([0]);
  });
});

describe('input.ts 按 grapheme 编辑', () => {
  it('backspace 一次删除整个 ZWJ emoji', () => {
    const s = createInputState(`a${FAMILY}`);
    const next = reduceInput(s, { type: 'backspace' });
    expect(next.value).toBe('a');
    expect(next.cursor).toBe(1);
  });

  it('backspace 一次删除组合字符', () => {
    const next = reduceInput(createInputState(COMBINING), { type: 'backspace' });
    expect(next.value).toBe('');
    expect(next.cursor).toBe(0);
  });

  it('delete 一次删除整个国旗', () => {
    const s = { ...createInputState(`${FLAG}x`), cursor: 0 };
    const next = reduceInput(s, { type: 'delete' });
    expect(next.value).toBe('x');
    expect(next.cursor).toBe(0);
  });

  it('左右移动落在 grapheme 边界，不会进入 emoji 内部', () => {
    const s = createInputState(`a${FAMILY}`);
    // 左移两次：从末尾 12 到 1（跳过整个 emoji），再到 0
    const one = reduceInput(s, { type: 'move', dir: 'left' });
    expect(one.cursor).toBe(1);
    const two = reduceInput(one, { type: 'move', dir: 'left' });
    expect(two.cursor).toBe(0);
    const three = reduceInput(two, { type: 'move', dir: 'left' });
    expect(three.cursor).toBe(0);
    const back = reduceInput(two, { type: 'move', dir: 'right' });
    expect(back.cursor).toBe(1);
  });

  it('insert 多字符原子插入，光标落在插入末尾', () => {
    const s = { ...createInputState('ad'), cursor: 1 };
    const next = reduceInput(s, { type: 'insert', text: 'bc' });
    expect(next.value).toBe('abcd');
    expect(next.cursor).toBe(3);
  });
});

describe('input.ts 词移动与选区', () => {
  it('latin 词移动：下划线算词内，空格/标点分隔', () => {
    const s = createInputState('foo bar_baz qux');
    const w1 = reduceInput(s, { type: 'move', dir: 'wordLeft' });
    expect(w1.cursor).toBe(12);
    const w2 = reduceInput(w1, { type: 'move', dir: 'wordLeft' });
    expect(w2.cursor).toBe(4);
    const w3 = reduceInput(w2, { type: 'move', dir: 'wordLeft' });
    expect(w3.cursor).toBe(0);
    const r1 = reduceInput(w3, { type: 'move', dir: 'wordRight' });
    expect(r1.cursor).toBe(3);
    const r2 = reduceInput(r1, { type: 'move', dir: 'wordRight' });
    expect(r2.cursor).toBe(11);
  });

  it('CJK 连续表意文字视为一个词单位', () => {
    const s = createInputState('\u4F60\u597D world'); // 你好 world
    const w1 = reduceInput(s, { type: 'move', dir: 'wordLeft' });
    expect(w1.cursor).toBe(3);
    const w2 = reduceInput(w1, { type: 'move', dir: 'wordLeft' });
    expect(w2.cursor).toBe(0);
  });

  it('select wordLeft 建立反向选区，selectionRange 归一化', () => {
    const s = createInputState('foo bar');
    const sel = reduceInput(s, { type: 'select', dir: 'wordLeft' });
    expect(sel.selectionAnchor).toBe(7);
    expect(sel.cursor).toBe(4);
    expect(selectionRange(sel)).toEqual({ start: 4, end: 7 });
  });

  it('普通 move 清除选区；edit 用 selection 替换', () => {
    const s = { ...createInputState('abcdef'), cursor: 2, selectionAnchor: 5 };
    const moved = reduceInput(s, { type: 'move', dir: 'left' });
    expect(moved.selectionAnchor).toBeNull();
    expect(moved.cursor).toBe(2); // 有选区时左移收敛到选区 start
    const replaced = reduceInput(s, { type: 'insert', text: 'X' });
    expect(replaced.value).toBe('abXf');
    expect(replaced.cursor).toBe(3);
    expect(replaced.selectionAnchor).toBeNull();
  });

  it('selectAll 覆盖全文', () => {
    const s = reduceInput(createInputState('abc'), { type: 'selectAll' });
    expect(s.selectionAnchor).toBe(0);
    expect(s.cursor).toBe(3);
    expect(selectionRange(s)).toEqual({ start: 0, end: 3 });
  });
});

describe('input.ts Home/End 与逻辑上下行', () => {
  it('lineStart/lineEnd 作用于当前逻辑行', () => {
    const s = { ...createInputState('ab\ncd'), cursor: 4 };
    const home = reduceInput(s, { type: 'move', dir: 'lineStart' });
    expect(home.cursor).toBe(3);
    const end = reduceInput(home, { type: 'move', dir: 'lineEnd' });
    expect(end.cursor).toBe(5);
    const s2 = { ...createInputState('ab\ncd'), cursor: 1 };
    expect(reduceInput(s2, { type: 'move', dir: 'lineStart' }).cursor).toBe(0);
    expect(reduceInput(s2, { type: 'move', dir: 'lineEnd' }).cursor).toBe(2);
  });

  it('reduceInput 的 up/down 跨逻辑行并保持列', () => {
    const s = { ...createInputState('ab\ncd'), cursor: 4 }; // 第二行 col1
    const up = reduceInput(s, { type: 'move', dir: 'up' });
    expect(up.cursor).toBe(1);
    const down = reduceInput(up, { type: 'move', dir: 'down' });
    expect(down.cursor).toBe(4);
  });
});

describe('input.ts 软折行 layoutInput', () => {
  it('按显示宽度折行，光标为显示列', () => {
    const s = { ...createInputState('abcdef'), cursor: 6 };
    const l = layoutInput(s, 4);
    expect(l.rows).toEqual(['abcd', 'ef']);
    expect(l.cursorRow).toBe(1);
    expect(l.cursorCol).toBe(2);
  });

  it('CJK 宽字符占 2 列，光标列按显示宽度', () => {
    const s = { ...createInputState('\u4F60\u597D\u4E16'), cursor: 1 }; // 你好世
    const l = layoutInput(s, 4);
    expect(l.rows).toEqual(['\u4F60\u597D', '\u4E16']);
    expect(l.cursorRow).toBe(0);
    expect(l.cursorCol).toBe(2);
    // 光标在软折行边界（index 2）落到下一行行首
    const s2 = { ...createInputState('\u4F60\u597D\u4E16'), cursor: 2 };
    const l2 = layoutInput(s2, 4);
    expect(l2.cursorRow).toBe(1);
    expect(l2.cursorCol).toBe(0);
  });

  it('硬换行强制断行，行尾光标在上一行末尾', () => {
    const s = { ...createInputState('ab\ncd'), cursor: 2 };
    const l = layoutInput(s, 80);
    expect(l.rows).toEqual(['ab', 'cd']);
    expect(l.cursorRow).toBe(0);
    expect(l.cursorCol).toBe(2);
    const s2 = { ...createInputState('ab\ncd'), cursor: 3 };
    const l2 = layoutInput(s2, 80);
    expect(l2.cursorRow).toBe(1);
    expect(l2.cursorCol).toBe(0);
  });

  it('末尾硬换行保留空行', () => {
    const s = { ...createInputState('a\n'), cursor: 2 };
    const l = layoutInput(s, 80);
    expect(l.rows).toEqual(['a', '']);
    expect(l.cursorRow).toBe(1);
    expect(l.cursorCol).toBe(0);
  });

  it('moveVertical 跨软折行并就近列', () => {
    const s = { ...createInputState('abcdef'), cursor: 5 }; // row1 col1
    const up = moveVertical(s, 4, 'up');
    expect(up.cursor).toBe(1);
    const down = moveVertical({ ...createInputState('abcdef'), cursor: 1 }, 4, 'down');
    expect(down.cursor).toBe(5);
  });
});

describe('input.ts 历史往返', () => {
  it('上到最旧、下回草稿时恢复原 draft 文本与 selection', () => {
    let h = createHistoryState(['one', 'two']);
    const draft: InputState = { ...createInputState('my draft'), cursor: 3, selectionAnchor: 7 };
    const r1 = historyPrev(h, draft);
    h = r1.history;
    expect(r1.next?.value).toBe('two');
    const r2 = historyPrev(h, r1.next as InputState);
    h = r2.history;
    expect(r2.next?.value).toBe('one');
    // 最旧处继续上翻不动
    const r2b = historyPrev(h, r2.next as InputState);
    expect(r2b.next).toBeNull();
    const r3 = historyNext(h, r2.next as InputState);
    h = r3.history;
    expect(r3.next?.value).toBe('two');
    const r4 = historyNext(h, r3.next as InputState);
    expect(r4.next?.value).toBe('my draft');
    expect(r4.next?.cursor).toBe(3);
    expect(r4.next?.selectionAnchor).toBe(7);
    // 草稿处继续下翻不动
    const r4b = historyNext(r4.history, r4.next as InputState);
    expect(r4b.next).toBeNull();
  });

  it('historyPush 追加并重置浏览位置', () => {
    const h = historyPush(createHistoryState([]), 'hi');
    expect(h.entries).toEqual(['hi']);
    expect(h.index).toBe(-1);
    expect(createHistory).toBe(createHistoryState);
  });
});

describe('input.ts paste 原子插入与 composing', () => {
  it('paste 单次转换插入多行文本', () => {
    const s = { ...createInputState('ac'), cursor: 1 };
    const next = reduceInput(s, { type: 'paste', text: 'b\n1' });
    expect(next.value).toBe('ab\n1c');
    expect(next.cursor).toBe(4);
  });

  it('paste 命中选区时整体替换', () => {
    const s: InputState = { ...createInputState('abcdef'), cursor: 6, selectionAnchor: 2 };
    const next = reduceInput(s, { type: 'paste', text: 'XY' });
    expect(next.value).toBe('abXY');
    expect(next.cursor).toBe(4);
  });

  it('composing 非空时 canSubmit 为 false，insert 提交后清空', () => {
    const composing = reduceInput(createInputState(''), { type: 'compose', text: 'ni' });
    expect(composing.composing).toBe('ni');
    expect(canSubmit(composing)).toBe(false);
    const committed = reduceInput(composing, { type: 'insert', text: '\u4F60' });
    expect(committed.composing).toBe('');
    expect(canSubmit(committed)).toBe(true);
  });

  it('setValue 归一化光标并清选区', () => {
    const s = { ...createInputState('abc'), cursor: 1, selectionAnchor: 2 };
    const next = reduceInput(s, { type: 'setValue', value: 'xy' });
    expect(next.value).toBe('xy');
    expect(next.cursor).toBe(2);
    expect(next.selectionAnchor).toBeNull();
  });
});
