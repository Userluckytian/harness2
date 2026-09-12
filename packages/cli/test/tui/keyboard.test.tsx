// T1 键盘集成测试（虚拟 TTY，真实按键注入 + 渲染回读）：
// 多字符输入/视觉光标、左右与 Home/End、按 grapheme 退格、词移动（Ctrl/Alt+方向键）、
// Shift+Enter 与行尾 \ 替代键、历史往返恢复 draft 与 selection、软折行多行渲染。
//
// 说明：ink 的 Text 用 chalk 上色，vitest 环境下 chalk 默认 level 0 会把 inverse 抹掉。
// 本文件在 beforeAll 里先设 FORCE_COLOR=1 再动态 import ink，从而能断言视觉光标/选区的反显；
// afterAll 复原环境变量，避免影响其它测试文件。运行结束注意 flush 后再断言（React 批处理）。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';

type ComposerModule = typeof import('../../src/tui/Composer.js');
type HarnessModule = typeof import('./harness.js');

let ComposerCmp!: ComposerModule['Composer'];
let mountTui!: HarnessModule['mountTui'];

beforeAll(async () => {
  process.env['FORCE_COLOR'] = '1';
  ({ Composer: ComposerCmp } = await import('../../src/tui/Composer.js'));
  ({ mountTui } = await import('./harness.js'));
});

afterAll(() => {
  delete process.env['FORCE_COLOR'];
});

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'; // 👨‍👩‍👧‍👦
const SHIFT_ENTER = '\x1b[13;2u'; // kitty: shift+return
const CTRL_LEFT = '\x1b[1;5D';
const ALT_LEFT = '\x1b[1;3D';
const SHIFT_LEFT = '\x1b[1;2D';
const HOME = '\x1b[H';
const END = '\x1b[F';
const INVERSE = '\u001b[7m'; // 反显（视觉光标/选区）

function mountComposer(overrides: { busy?: boolean; columns?: number } = {}) {
  const onSend = vi.fn();
  const t = mountTui(<ComposerCmp busy={overrides.busy ?? false} active onSend={onSend} onExit={() => undefined} />, {
    columns: overrides.columns ?? 80,
  });
  return { t, onSend };
}

describe('Composer T1 键盘：输入与光标', () => {
  it('多字符输入并渲染视觉光标（反显）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('abc');
      await t.flush();
      expect(t.output()).toContain('abc');
      expect(t.output()).toContain(INVERSE); // 光标以反显单元渲染
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      t.unmount();
    }
  });

  it('左右键移动光标后插入', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('abc');
      await t.flush();
      t.write('\x1b[D'); // left
      t.write('\x1b[D'); // left
      await t.flush();
      t.write('X');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('aXbc');
    } finally {
      t.unmount();
    }
  });

  it('backspace 一次删除整个 ZWJ emoji（grapheme）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(`a${FAMILY}`);
      await t.flush();
      t.write('\x7f'); // backspace
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('a');
    } finally {
      t.unmount();
    }
  });
});

describe('Composer T1 键盘：Home/End 与词移动', () => {
  it('Home/End 作用于当前逻辑行而非全文', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('ab');
      t.write(SHIFT_ENTER);
      t.write('cd');
      await t.flush();
      t.write(HOME); // 第二行行首（index 3），不是全文 0
      await t.flush();
      t.write('X');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('ab\nXcd');
    } finally {
      t.unmount();
    }
  });

  it('End 回到当前逻辑行行尾', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('ab');
      t.write(SHIFT_ENTER);
      t.write('cd');
      await t.flush();
      t.write(HOME);
      t.write(END);
      await t.flush();
      t.write('Y');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('ab\ncdY');
    } finally {
      t.unmount();
    }
  });

  it('Ctrl+Left（\\x1b[1;5D）做词移动', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('foo bar');
      await t.flush();
      t.write(CTRL_LEFT);
      await t.flush();
      t.write('X');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('foo Xbar');
    } finally {
      t.unmount();
    }
  });

  it('Alt+Left（\\x1b[1;3D，ink 解析为 meta）同样做词移动', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('foo bar');
      await t.flush();
      t.write(ALT_LEFT);
      await t.flush();
      t.write('X');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('foo Xbar');
    } finally {
      t.unmount();
    }
  });
});

describe('Composer T1 键盘：换行与替代键', () => {
  it('Shift+Enter 换行不发送，页脚给出替代键提示', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('a');
      await t.flush();
      t.write(SHIFT_ENTER);
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('a¶'); // 硬换行渲染标记
      t.write('b');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('a\nb');
      expect(t.output()).toContain('Shift+Enter 换行');
      expect(t.output()).toContain('行尾 \\');
    } finally {
      t.unmount();
    }
  });

  it('行尾反斜杠回车作为替代换行键（终端无法区分 Shift+Enter 时）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('a\\');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      t.write('b');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('a\nb');
    } finally {
      t.unmount();
    }
  });
});

describe('Composer T1 键盘：历史往返 / 软折行', () => {
  it('历史 up/up/down/down 恢复原 draft 文本与 selection', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write('one');
      await t.flush();
      t.write('\r');
      await t.flush();
      t.write('two');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenNthCalledWith(1, 'one');
      expect(onSend).toHaveBeenNthCalledWith(2, 'two');
      // 输入草稿并建立反向选区 [2,5)
      t.write('draft');
      await t.flush();
      t.write(SHIFT_LEFT);
      t.write(SHIFT_LEFT);
      t.write(SHIFT_LEFT);
      await t.flush();
      expect(t.output()).toContain(INVERSE); // 选区高亮
      // 上翻两条历史
      t.write('\x1b[A');
      await t.flush();
      t.write('\x1b[A');
      await t.flush();
      // 下翻回草稿（应恢复 'draft' 与 selection [2,5)）
      t.write('\x1b[B');
      await t.flush();
      t.write('\x1b[B');
      await t.flush();
      t.write('X'); // 若 selection 已恢复则替换选区 -> 'drX'
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenLastCalledWith('drX');
    } finally {
      t.unmount();
    }
  });

  it('Up/Down 跨软折行视觉行移动（就近列）', async () => {
    const { t, onSend } = mountComposer({ columns: 24 }); // 文本区宽度 20
    try {
      t.write('abcdefghijklmnopqrstuvwxyz'); // 26 字符 → row0 20 + row1 6
      await t.flush();
      t.write('\x1b[A'); // 上移到 row0 col6
      await t.flush();
      t.write('X');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledWith('abcdefXghijklmnopqrstuvwxyz');
    } finally {
      t.unmount();
    }
  });

  it('软折行按显示宽度渲染成多视觉行', async () => {
    const { t } = mountComposer({ columns: 24 }); // 文本区宽度 20
    try {
      t.write('abcdefghijklmnopqrstuvwxyz');
      await t.flush();
      const out = t.output();
      expect(out).toContain('abcdefghijklmnopqrst');
      expect(out).toContain('uvwxyz');
      // 两段必须落在不同的渲染行（行间有边框/光标转义）
      expect(out).toMatch(/abcdefghijklmnopqrst[^\n]*\n[^\n]*uvwxyz/);
    } finally {
      t.unmount();
    }
  });
});
