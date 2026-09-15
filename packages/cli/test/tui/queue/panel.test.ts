// G-29 队列面板纯逻辑单测：打开键位三变体（Ctrl+; / Ctrl+' / macOS VS Code Ctrl+4）、
// 非空才开、↑ 焦点裁决（队列/历史）、行导航钳制、条目渲染结构。
import { describe, expect, it } from 'vitest';
import {
  QUEUE_PANEL_OPEN_KEYS,
  clampQueuePanelSelection,
  createQueuePanelState,
  focusTargetForUp,
  matchesQueuePanelOpenKey,
  moveQueuePanelSelection,
  queueEntryPreview,
  renderQueuePanelRows,
  setQueuePanelOpen,
  toggleQueuePanel,
  transferQueuePanelFocus,
} from '../../../src/tui/queue/panel.js';
import { enqueueFollowUp, createQueueState } from '../../../src/tui/queue/queue.js';
import { noModifiers } from '../../../src/input/types.js';
import type { KeyEvent } from '../../../src/input/types.js';

/** 构造键事件（keymaps.ts 和弦口径：可打印字符为字符本体） */
function key(key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): KeyEvent {
  return { type: 'key', key, modifiers: { shift: false, alt: false, ctrl: false, ...mods }, consumed: false };
}

/** 三条队列（id/seq 稳定） */
function queue3() {
  let state = createQueueState();
  for (const text of ['alpha', 'beta text', 'gamma']) state = enqueueFollowUp(state, text).state;
  return state;
}

describe('G-29 打开键位（三变体数据化）', () => {
  it("键位表恰好三条：primary Ctrl+; / alt Ctrl+' / mac-vscode Ctrl+4（refs G-29）", () => {
    expect(QUEUE_PANEL_OPEN_KEYS.map((k) => k.variant)).toEqual(['primary', 'alt', 'mac-vscode']);
    expect(QUEUE_PANEL_OPEN_KEYS.map((k) => k.label)).toEqual(['Ctrl+;', "Ctrl+'", 'Ctrl+4']);
  });

  it("Ctrl+; 命中 primary；Ctrl+' 命中 alt；Ctrl+4 命中 mac-vscode（kitty 编码口径）", () => {
    expect(matchesQueuePanelOpenKey(key(';', { ctrl: true }))).toBe('primary');
    expect(matchesQueuePanelOpenKey(key("'", { ctrl: true }))).toBe('alt');
    expect(matchesQueuePanelOpenKey(key('4', { ctrl: true }))).toBe('mac-vscode');
  });

  it('无修饰/错误修饰不命中（精确相等，不 loose 匹配）', () => {
    expect(matchesQueuePanelOpenKey(key(';'))).toBeNull(); // 无 Ctrl（分号是输入字符）
    expect(matchesQueuePanelOpenKey(key(';', { ctrl: true, alt: true }))).toBeNull();
    expect(matchesQueuePanelOpenKey(key('4'))).toBeNull();
    expect(matchesQueuePanelOpenKey(key('enter', { ctrl: true }))).toBeNull(); // send-now 域不串
    expect(matchesQueuePanelOpenKey(key('o', { ctrl: true }))).toBeNull();
  });
});

describe('G-29 面板开合（when non-empty——空队列不开假入口）', () => {
  it('队列非空：toggle 打开 → 焦点落队列、高亮末行（上游：last row highlighted）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 3 });
    expect(opened.open).toBe(true);
    expect(opened.focus).toBe('queue');
    expect(opened.activeIndex).toBe(2); // 末行
  });

  it('空队列尝试打开 = 无操作（原引用；不开假面板）', () => {
    const state = createQueuePanelState();
    expect(toggleQueuePanel(state, { queueCount: 0 })).toBe(state);
  });

  it('再按一次（toggle）关闭；setQueuePanelOpen(false) 编程收起（turn 收尾伴生浮层语义）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 2 });
    expect(toggleQueuePanel(opened, { queueCount: 2 }).open).toBe(false);
    expect(setQueuePanelOpen(opened, false, { queueCount: 2 }).open).toBe(false);
    const closed = createQueuePanelState();
    expect(setQueuePanelOpen(closed, true, { queueCount: 0 })).toBe(closed); // 空队列不开假面板
  });

  it('打开期间队列变短：高亮行越界自愈（clamp 钳到新末行）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 3 });
    expect(clampQueuePanelSelection(opened, { queueCount: 1 }).activeIndex).toBe(0);
    expect(clampQueuePanelSelection(createQueuePanelState(), { queueCount: 0 })).toEqual(createQueuePanelState());
  });
});

describe('G-29 ↑ 焦点裁决（队列 / 历史间转焦点）', () => {
  it('空草稿 + 有排队 → 队列（焦点入面板）；空草稿 + 无排队 → 历史（装配层开）', () => {
    expect(focusTargetForUp({ draftEmpty: true, panelOpen: false, queueCount: 2 })).toBe('queue');
    expect(focusTargetForUp({ draftEmpty: true, panelOpen: false, queueCount: 0 })).toBe('history');
  });

  it('草稿非空 / 面板已开 → null（↑ 不是重复入口；条件不满足不吞键）', () => {
    expect(focusTargetForUp({ draftEmpty: false, panelOpen: false, queueCount: 2 })).toBeNull();
    expect(focusTargetForUp({ draftEmpty: true, panelOpen: true, queueCount: 2 })).toBeNull();
  });

  it('面板打开时 transferQueuePanelFocus 在队列/历史间往返；未打开 = 无操作（原引用）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 2 });
    const toHistory = transferQueuePanelFocus(opened, { queueCount: 2 });
    expect(toHistory.focus).toBe('history');
    expect(transferQueuePanelFocus(toHistory, { queueCount: 2 }).focus).toBe('queue');
    const closed = createQueuePanelState();
    expect(transferQueuePanelFocus(closed, { queueCount: 2 })).toBe(closed);
  });
});

describe('G-29 面板内行导航', () => {
  it('↑/↓ 走行且钳到 [0, n-1]（端点即停，不环绕）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 3 });
    const up = moveQueuePanelSelection(opened, -1, { queueCount: 3 });
    expect(up.activeIndex).toBe(1);
    const top = moveQueuePanelSelection(moveQueuePanelSelection(up, -1, { queueCount: 3 }), -1, { queueCount: 3 });
    expect(top.activeIndex).toBe(0);
    expect(moveQueuePanelSelection(top, -1, { queueCount: 3 })).toBe(top); // 端点原引用
    const down = moveQueuePanelSelection(top, 1, { queueCount: 3 });
    expect(down.activeIndex).toBe(1);
  });

  it('焦点不在队列 / 面板未开 / 空队列 → 无操作（原引用）', () => {
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 2 });
    const history = transferQueuePanelFocus(opened, { queueCount: 2 });
    expect(moveQueuePanelSelection(history, 1, { queueCount: 2 })).toBe(history);
    const closed = createQueuePanelState();
    expect(moveQueuePanelSelection(closed, 1, { queueCount: 2 })).toBe(closed);
    expect(moveQueuePanelSelection(opened, 1, { queueCount: 0 })).toBe(opened);
  });
});

describe('G-29 条目渲染结构（预览 42 列约定；高亮按焦点/下标）', () => {
  it('preview 折行合一 + 超长截断加省略号（不改队列原文；42 列约定与旧壳/next 层同源）', () => {
    expect(queueEntryPreview('a\n b\t c')).toBe('a b c');
    const long = 'x'.repeat(50);
    const p = queueEntryPreview(long);
    expect(p).toBe(`${'x'.repeat(42)}…`); // 截到 42 字符后接省略号
    expect(queueEntryPreview('短')).toBe('短');
  });

  it('rows 结构：id/seq 透传、active 只落在队列焦点的当前下标', () => {
    const state = queue3();
    const opened = toggleQueuePanel(createQueuePanelState(), { queueCount: 3 });
    const { header, rows } = renderQueuePanelRows(state.entries, opened);
    expect(header).toEqual({ title: 'Queue · 3', focus: 'queue' });
    expect(rows.map((r) => r.preview)).toEqual(['alpha', 'beta text', 'gamma']);
    expect(rows.map((r) => r.active)).toEqual([false, false, true]);
    const history = transferQueuePanelFocus(opened, { queueCount: 3 });
    expect(renderQueuePanelRows(state.entries, history).rows.every((r) => !r.active)).toBe(true);
    expect(renderQueuePanelRows(state.entries, createQueuePanelState()).header.title).toBe('Queue · 3');
  });

  it('空队列 rows 为空、头部计数 0（装配层据此隐藏面板槽位）', () => {
    const { rows } = renderQueuePanelRows([], toggleQueuePanel(createQueuePanelState(), { queueCount: 0 }));
    expect(rows).toEqual([]);
  });

  it('noModifiers 事件不含面板键（防御：与输入层事件形状对接的冒烟）', () => {
    const ev = key(';', { ctrl: true });
    expect(ev.modifiers).toEqual({ shift: false, alt: false, ctrl: true });
    expect(key('x', { ctrl: true }).modifiers.ctrl).toBe(true);
    expect(noModifiers()).toEqual({ shift: false, alt: false, ctrl: false });
  });
});
