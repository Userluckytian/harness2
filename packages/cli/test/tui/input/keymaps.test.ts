// keymaps 单测：simple/vim 两套键位表对 G-07～G-13 的映射断言（表即文档的机器可读版）。
// 原则：逐动作精确断言（chord 集合、from 限定、G 条目号注释在源码），不做宽松快照；
// 另覆盖 chordMatches 的双编码口径（legacy 大写字符 = shift / kitty shift 位）与 Esc 负向断言。
import { describe, expect, it } from 'vitest';
import { noModifiers, type KeyEvent } from '../../../src/input/types.js';
import {
  SIMPLE_KEYMAP,
  VIM_KEYMAP,
  chordMatches,
  keymapFor,
  resolveKeyAction,
  type KeyActionId,
  type KeyBinding,
} from '../../../src/tui/input/keymaps.js';

/** 无修饰键的按键事件（KeyEvent 手工构造，等价 parser 产出） */
function key(key: string, mods?: Partial<{ shift: boolean; alt: boolean; ctrl: boolean }>): KeyEvent {
  return {
    type: 'key',
    key,
    modifiers: { ...noModifiers(), ...mods },
    consumed: false,
  };
}

/** 从表里取出某动作的绑定（每个动作在一张表内至多一条） */
function bindingOf(table: readonly KeyBinding[], action: KeyActionId): KeyBinding {
  const hits = table.filter((b) => b.action === action);
  expect(hits, `动作 ${action} 应恰好在表中登记一次`).toHaveLength(1);
  return hits[0]!;
}

function chordsOf(table: readonly KeyBinding[], action: KeyActionId): ReadonlyArray<Record<string, unknown>> {
  return bindingOf(table, action).chords.map((c) => ({ ...c }));
}

/** 两套表并行的动作全集（G-07：两套键位表并行存在 → 每个动作两表都有） */
const ALL_ACTIONS: readonly KeyActionId[] = [
  'focus.toggle',
  'focus.to-prompt',
  'nav.down',
  'nav.up',
  'nav.turn-next',
  'nav.turn-prev',
  'nav.viewport-turn-above',
  'nav.viewport-turn-below',
  'nav.first',
  'nav.last',
  'scroll.line-up',
  'scroll.line-down',
  'scroll.page-up',
  'scroll.page-down',
  'scroll.half-up',
  'scroll.half-down',
  'shell.bang',
  'paste.image',
  'draft.stash-toggle',
];

describe('G-07 两种输入模式：两套键位表并行', () => {
  it('simple 与 vim 两表都覆盖全部动作（无遗漏、无多余）', () => {
    for (const table of [SIMPLE_KEYMAP, VIM_KEYMAP]) {
      const actions = new Set(table.map((b) => b.action));
      expect([...actions].sort()).toEqual([...ALL_ACTIONS].sort());
    }
  });

  it('keymapFor 按模式取表；simple 为默认', () => {
    expect(keymapFor('simple')).toBe(SIMPLE_KEYMAP);
    expect(keymapFor('vim')).toBe(VIM_KEYMAP);
  });

  it('负向断言：Esc 不出现在任何一张表的任何和弦里（G-08「Esc 不是焦点键」+ Esc 语义归 esc-machine）', () => {
    for (const table of [SIMPLE_KEYMAP, VIM_KEYMAP]) {
      for (const binding of table) {
        for (const chord of binding.chords) {
          expect(chord.key, `${binding.action} 的和弦不得是 Esc`).not.toBe('escape');
        }
      }
    }
    expect(resolveKeyAction('simple', key('escape'))).toBeNull();
    expect(resolveKeyAction('vim', key('escape'))).toBeNull();
  });

  it('焦点动作的模式差异（G-08）：simple 是 Tab+Space，vim 是 Tab+i', () => {
    // simple：Space 切回输入框；无 i（i 在 simple 的 scrollback 侧是文本导航/输入语义）
    expect(chordsOf(SIMPLE_KEYMAP, 'focus.to-prompt')).toEqual([{ key: ' ' }]);
    expect(bindingOf(SIMPLE_KEYMAP, 'focus.to-prompt').from).toBe('scrollback');
    // vim：i 回输入框；无 Space
    expect(chordsOf(VIM_KEYMAP, 'focus.to-prompt')).toEqual([{ key: 'i' }]);
    expect(bindingOf(VIM_KEYMAP, 'focus.to-prompt').from).toBe('scrollback');
    // Tab 双模式通用、不限窗格
    expect(chordsOf(SIMPLE_KEYMAP, 'focus.toggle')).toEqual([{ key: 'tab' }]);
    expect(chordsOf(VIM_KEYMAP, 'focus.toggle')).toEqual([{ key: 'tab' }]);
    expect(bindingOf(SIMPLE_KEYMAP, 'focus.toggle').from).toBeUndefined();
    expect(bindingOf(VIM_KEYMAP, 'focus.toggle').from).toBeUndefined();
  });
});

describe('G-09 导航键位', () => {
  it('j/k ↔ ↓/↑（scrollback 侧）', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.down')).toEqual([{ key: 'down' }, { key: 'j' }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.up')).toEqual([{ key: 'up' }, { key: 'k' }]);
    expect(bindingOf(SIMPLE_KEYMAP, 'nav.down').from).toBe('scrollback');
  });

  it('Shift+L/H ↔ Shift+→/Shift+← 按 turn；Shift+J/K 跳视口顶上/下方 turn（2026-09-13 修正语义）', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.turn-next')).toEqual([
      { key: 'l', shift: true },
      { key: 'right', shift: true },
    ]);
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.turn-prev')).toEqual([
      { key: 'h', shift: true },
      { key: 'left', shift: true },
    ]);
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.viewport-turn-above')).toEqual([{ key: 'k', shift: true }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.viewport-turn-below')).toEqual([{ key: 'j', shift: true }]);
  });

  it('g / Shift+G 首尾', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.first')).toEqual([{ key: 'g' }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'nav.last')).toEqual([{ key: 'g', shift: true }]);
  });

  it('vim 表的滚动区侧导航键与 simple 重叠（G-07 🟡 登记：prompt 侧 vi 编辑下放 P7）', () => {
    expect(chordsOf(VIM_KEYMAP, 'nav.down')).toEqual(chordsOf(SIMPLE_KEYMAP, 'nav.down'));
    expect(chordsOf(VIM_KEYMAP, 'nav.viewport-turn-below')).toEqual(chordsOf(SIMPLE_KEYMAP, 'nav.viewport-turn-below'));
    expect(chordsOf(VIM_KEYMAP, 'nav.last')).toEqual(chordsOf(SIMPLE_KEYMAP, 'nav.last'));
  });
});

describe('G-10 滚动粒度', () => {
  it('Ctrl+K/Ctrl+J 行、PageUp/PageDown 整页、Ctrl+U/Ctrl+D 半页', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.line-up')).toEqual([{ key: 'k', ctrl: true }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.line-down')).toEqual([{ key: 'j', ctrl: true }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.page-up')).toEqual([{ key: 'pageup' }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.page-down')).toEqual([{ key: 'pagedown' }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.half-up')).toEqual([{ key: 'u', ctrl: true }]);
    expect(chordsOf(SIMPLE_KEYMAP, 'scroll.half-down')).toEqual([{ key: 'd', ctrl: true }]);
  });

  it('滚动键两窗格皆可（不限 from；PageUp/Ctrl+U/D 与 chat-controller 现状一致）', () => {
    for (const action of ['scroll.line-up', 'scroll.page-up', 'scroll.half-down'] as const) {
      expect(bindingOf(SIMPLE_KEYMAP, action).from).toBeUndefined();
      expect(bindingOf(VIM_KEYMAP, action).from).toBeUndefined();
    }
  });
});

describe('G-11 / G-12 / G-17 的键位登记', () => {
  it('G-11 shell.bang 以 draft-prefix 种类登记（非和弦；检测器在 shell-mode.ts）', () => {
    const binding = bindingOf(SIMPLE_KEYMAP, 'shell.bang');
    expect(binding.kind).toBe('draft-prefix');
    expect(binding.chords).toEqual([{ key: '!' }]);
    // resolveKeyAction 不解析 draft-prefix 种类（专管权在 shell-mode.ts）
    expect(resolveKeyAction('simple', key('!'))).toBeNull();
  });

  it('G-12 paste.image = Alt+V', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'paste.image')).toEqual([{ key: 'v', alt: true }]);
    expect(chordsOf(VIM_KEYMAP, 'paste.image')).toEqual([{ key: 'v', alt: true }]);
  });

  it('G-17 stash 恢复通道 = Ctrl+S / Alt+S', () => {
    expect(chordsOf(SIMPLE_KEYMAP, 'draft.stash-toggle')).toEqual([
      { key: 's', ctrl: true },
      { key: 's', alt: true },
    ]);
  });
});

describe('chordMatches：双编码口径（legacy 大写字符 / kitty shift 位）', () => {
  it('Shift+J：legacy（key=大写 J、无 shift 位）与 kitty（key=j + shift 位）都命中', () => {
    const chord = { key: 'j', shift: true };
    expect(chordMatches(chord, key('J'))).toBe(true); // legacy：shift 体现在字符本身
    expect(chordMatches(chord, key('j', { shift: true }))).toBe(true); // kitty CSI-u
  });

  it('无 shift 和弦不匹配大写字符（Shift+J 不得误中 j 的绑定）', () => {
    const chord = { key: 'j' };
    expect(chordMatches(chord, key('j'))).toBe(true);
    expect(chordMatches(chord, key('J'))).toBe(false);
    expect(chordMatches(chord, key('j', { shift: true }))).toBe(false);
  });

  it('ctrl/alt 精确匹配（Ctrl+Shift+J 不误中 Shift+J；Alt+V 不误中 V）', () => {
    expect(chordMatches({ key: 'j', shift: true }, key('J', { ctrl: true }))).toBe(false);
    expect(chordMatches({ key: 'j', shift: true }, key('j', { shift: true, ctrl: true }))).toBe(false);
    expect(chordMatches({ key: 'v', alt: true }, key('v'))).toBe(false);
    expect(chordMatches({ key: 'v', alt: true }, key('V'))).toBe(false); // legacy Alt+V = \x1bv → key='v'
  });
});

describe('resolveKeyAction：窗格过滤与匹配主路径', () => {
  it('scrollback 侧：j 命中 nav.down；vim 下 i 命中 focus.to-prompt', () => {
    expect(resolveKeyAction('simple', key('j'), 'scrollback')?.action).toBe('nav.down');
    expect(resolveKeyAction('vim', key('i'), 'scrollback')?.action).toBe('focus.to-prompt');
  });

  it('prompt 侧：simple 的 Space 不解析为焦点动作（prompt 里 Space 是文本输入）', () => {
    expect(resolveKeyAction('simple', key(' '), 'prompt')?.action).toBeUndefined();
    expect(resolveKeyAction('vim', key('i'), 'prompt')).toBeNull(); // vim 的 i 在 prompt 是字符
  });

  it('不传窗格时不做过滤（Space 在 simple 下返回 focus.to-prompt，窗格裁决留给调用方）', () => {
    expect(resolveKeyAction('simple', key(' '))?.action).toBe('focus.to-prompt');
  });

  it('修饰不符不命中：Ctrl+J 是滚动、裸 j 是导航；Esc 恒 null（负向）', () => {
    expect(resolveKeyAction('simple', key('j', { ctrl: true }), 'scrollback')?.action).toBe('scroll.line-down');
    expect(resolveKeyAction('simple', key('k', { ctrl: true }), 'scrollback')?.action).toBe('scroll.line-up');
    expect(resolveKeyAction('simple', key('u', { ctrl: true }), 'prompt')?.action).toBe('scroll.half-up');
    expect(resolveKeyAction('simple', key('escape'), 'scrollback')).toBeNull();
  });
});
