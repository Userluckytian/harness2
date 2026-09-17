// P3-F（窄范围）：G-32～G-41 Agent 级键位逐条归存 —— 接线与冲突修复的用例。
//
// 覆盖：
// - keymaps.AGENT_CHORD_TABLE：G-31～G-41 全覆盖、wired/deferred 归属、**无撞键**（同一和弦
//   不得被两个动作登记）、deferred 动作不消费按键（登记 ≠ 已接）。
// - chat-screen：快捷键帮助内容（G-39）分组与忠实性——未接线条目必须带「（P7 未接入）」；
//   首段复用快捷键条数据；两个新浮层的快捷键条文案。
// - harness 集成（G-39）：Ctrl+X / Ctrl+. 打开可滚动帮助浮层、toggle/ Esc 关闭、↑↓ 滚动；
//   **键位冲突修复**：Ctrl+X 不再开队列面板、Ctrl+; 仍开队列面板、面板内裸 x 取消高亮项、
//   面板内 Ctrl+X = 关面板 + 开帮助；Ctrl+C 在浮层内仍走 guard 协议（G-38）。
// - harness 集成（G-34）：Ctrl+R 会话选择器（列表 / * 当前标记 / Enter 经 /resume 切换 /
//   Esc 取消 / 空列表如实提示 / busy 拒切）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnySessionEvent, SessionSummary, SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import { shortcutsFor, shortcutsHelpLines, shortcutsHelpSections } from '../../../src/tui/next/chat-screen.js';
import { displayWidth } from '../../../src/tui/renderer/cell-buffer.js';
import {
  AGENT_CHORD_TABLE,
  agentActionWired,
  agentChordsFor,
  matchesSessionPicker,
  matchesShortcutsHelp,
} from '../../../src/tui/input/keymaps.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';

const ESC = '\x1b';
const CTRL_X = '\x18'; // legacy 可达：C0 0x18
const KITTY_CTRL_DOT = '\x1b[46;5u'; // kitty CSI-u：'.' + ctrl（Ctrl+.，legacy 无编码）
const KITTY_CTRL_SEMI = '\x1b[59;5u'; // kitty CSI-u：';' + ctrl（G-29 队列面板主键）
const KITTY_CTRL_R = '\x1b[114;5u'; // kitty CSI-u：'r' + ctrl（G-34）
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';

class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function result(finalText: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
    ...overrides,
  };
}

function summary(id: string, messageCount = 3, firstUserText = `第一条 ${id}`): SessionSummary {
  return { id, dir: `/tmp/sessions/${id}`, mtimeMs: messageCount, firstUserText, messageCount, lastSeq: 1 };
}

interface FixtureOptions {
  sessions?: readonly SessionSummary[];
  currentId?: string | null;
  runUserTurn?: (text: string) => Promise<TurnResult>;
}

function makeRuntime(opts: FixtureOptions = {}): { runtime: ChatRuntime; switched: string[]; aborts: () => number } {
  const switched: string[] = [];
  let abortCount = 0;
  const steerObservers = new Set<(r: SteerResult) => void>();
  const current = (): { id: string; dir: string } | null =>
    opts.currentId === null ? null : { id: opts.currentId ?? 's-now', dir: '/tmp/sessions/now' };
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [...(opts.sessions ?? [])],
      locate: () => undefined,
    } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p3f-test',
    getCurrent: current as ChatRuntime['getCurrent'],
    switchSession: (id: string | null, o?: { print?: (t: string) => void }) => {
      if (id !== null) switched.push(id);
      o?.print?.(`（切换会话 ${id ?? 'new'}）`);
    },
    fork: () => undefined,
    runUserTurn: opts.runUserTurn ?? (async (text: string) => result(`收到：${text}`)),
    abortTurn: () => {
      abortCount += 1;
    },
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m) => m,
    reasoning: () => false,
    setReasoning: (on) => on,
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: (fn) => {
      steerObservers.add(fn);
      return () => {
        steerObservers.delete(fn);
      };
    },
    finish: async () => undefined,
  };
  return { runtime, switched, aborts: () => abortCount };
}

function makeSink(): { sink: SubagentEventSink; emit: (sessionId: string, event: AnySessionEvent) => void } {
  let handler: ((sessionId: string, event: AnySessionEvent) => void) | null = null;
  return {
    sink: {
      set(fn) {
        handler = fn;
      },
    },
    emit: (sessionId, event) => handler?.(sessionId, event),
  };
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
  switched: string[];
  aborts: () => number;
}

function makeHarness(opts: FixtureOptions = {}): Fixture {
  const { runtime, switched, aborts } = makeRuntime(opts);
  const out = new FakeOut();
  const gate = createApprovalGate();
  const bridge = makeSink();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: {},
    gate,
    subagentEventSink: bridge.sink,
    exit: () => undefined,
  });
  return { h, out, gate, runtime, switched, aborts };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═══ A. keymaps：Agent 级键位归属表（登记即文档 + 无撞键）══════════════════════

describe('P3-F AGENT_CHORD_TABLE：G-31～G-41 逐条归存', () => {
  it('G-31～G-41 全覆盖（每条至少一行登记）', () => {
    const ids = new Set(AGENT_CHORD_TABLE.map((e) => e.id));
    for (const id of ['G-31', 'G-32', 'G-33', 'G-34', 'G-35', 'G-36', 'G-37', 'G-38', 'G-39', 'G-40', 'G-41']) {
      expect(ids.has(id), `缺 ${id}`).toBe(true);
    }
  });

  it('归属如实：已接线 = G-31/G-33/G-34/G-38/G-39；其余归存 P7 且写明理由', () => {
    const wiredActions = new Set(AGENT_CHORD_TABLE.filter((e) => e.owner === 'wired').map((e) => e.action));
    expect([...wiredActions].sort()).toEqual(
      [
        'cancel-or-exit',
        'help.shortcuts',
        'mode.always-approve',
        'mode.cycle',
        'palette.open',
        'session.picker',
      ].sort(),
    );
    for (const entry of AGENT_CHORD_TABLE.filter((e) => e.owner === 'deferred')) {
      expect(entry.note ?? '', `${entry.label} 缺归存理由`).toContain('归存 P7');
    }
  });

  it('无撞键：同一和弦不得被两个动作登记（Ctrl+X 冲突的回归防线）', () => {
    const seen = new Map<string, string>();
    for (const entry of AGENT_CHORD_TABLE) {
      for (const chord of entry.chords) {
        const k = `${chord.ctrl === true ? 'C' : ''}${chord.alt === true ? 'A' : ''}${chord.shift === true ? 'S' : ''}+${chord.key}`;
        const prev = seen.get(k);
        expect(prev === undefined || prev === entry.action, `撞键 ${k}: ${prev} vs ${entry.action}`).toBe(true);
        seen.set(k, entry.action);
      }
    }
  });

  it('deferred 动作不消费按键（登记 ≠ 已接）：Ctrl+M/T/G/L/B、F2、Ctrl+,、Ctrl+\\ 均不命中', () => {
    for (const action of [
      'model.picker',
      'pane.todos',
      'pane.tasks',
      'extensions.open',
      'turn.background',
      'settings.open',
      'agent.dashboard',
    ] as const) {
      expect(agentActionWired(action), action).toBe(false);
      for (const chord of agentChordsFor(action)) {
        const ev = {
          type: 'key' as const,
          key: chord.key,
          modifiers: { shift: chord.shift ?? false, alt: chord.alt ?? false, ctrl: chord.ctrl ?? false },
          consumed: false,
        };
        expect(matchesShortcutsHelp(ev), `${action} ${chord.key}`).toBe(false);
        expect(matchesSessionPicker(ev), `${action} ${chord.key}`).toBe(false);
      }
    }
  });

  it('G-39 帮助和弦 = Ctrl+. 主键 + Ctrl+X 备用；G-34 = Ctrl+R（精确修饰）', () => {
    const ev = (key: string, ctrl: boolean) => ({
      type: 'key' as const,
      key,
      modifiers: { shift: false, alt: false, ctrl },
      consumed: false,
    });
    expect(matchesShortcutsHelp(ev('.', true))).toBe(true);
    expect(matchesShortcutsHelp(ev('x', true))).toBe(true);
    expect(matchesShortcutsHelp(ev('x', false))).toBe(false); // 裸 x 是面板内取消键，不是帮助
    expect(matchesSessionPicker(ev('r', true))).toBe(true);
    expect(matchesSessionPicker(ev('r', false))).toBe(false);
    expect(agentChordsFor('help.shortcuts').map((c) => c.key)).toEqual(['.', 'x']); // 主键在前
  });
});

// ═══ B. chat-screen：帮助内容纯函数（G-39）══════════════════════════════════

describe('P3-F 快捷键帮助内容', () => {
  const ctx = { busy: false, queueCount: 0, approvalActive: false, subviewOpen: false };

  it('首段直接复用快捷键条数据（不抄第二份）', () => {
    const sections = shortcutsHelpSections(ctx);
    expect(sections[0]?.title).toBe('快捷键条（常用入口）');
    expect(sections[0]?.lines).toEqual([shortcutsFor(ctx).join(' · ')]);
  });

  it('Agent 级分组逐条呈现；未接线条目带「（P7 未接入）」，已接线条目不带', () => {
    const agent = shortcutsHelpSections(ctx).find((s) => s.title.includes('Agent 级键位'));
    expect(agent).toBeDefined();
    const lines = agent?.lines ?? [];
    expect(lines.some((l) => l.startsWith('Ctrl+R — 会话选择器'))).toBe(true);
    expect(lines.some((l) => l.includes('Ctrl+M — 模型选择器') && l.includes('（P7 未接入）'))).toBe(true);
    expect(
      lines.some(
        (l) => l.includes('Ctrl+\\ — agents dashboard') && l.includes('（P7 未接入）') && l.includes('参考级'),
      ),
    ).toBe(true);
    const ctrlR = lines.find((l) => l.startsWith('Ctrl+R —'));
    expect(ctrlR).not.toContain('（P7 未接入）');
  });

  it('shortcutsHelpLines：段标题 + 行；超宽行截断加省略号（不硬裁丢信息）', () => {
    const lines = shortcutsHelpLines(ctx);
    expect(lines).toContain('── 快捷键条（常用入口） ──');
    expect(lines).toContain('── Agent 级键位（G-31～G-41） ──');
    expect(lines.every((l) => displayWidth(l) <= 96)).toBe(true); // P11 残留 1：按显示宽（非 .length）
  });

  it('快捷键条两个新浮层态：帮助 / 会话选择器各给真实键位文案', () => {
    expect(shortcutsFor({ ...ctx, modal: 'help' })).toEqual(['Esc / q 关闭', '↑↓ / j k 滚动']);
    expect(shortcutsFor({ ...ctx, modal: 'session-picker' })).toEqual(['↑↓ 选择', 'Enter 切换', 'Esc 取消']);
    // 审批接管优先于浮层（dispatcher 首层优先级不变）
    expect(shortcutsFor({ ...ctx, approvalActive: true, modal: 'help' })).toEqual([
      'Tab/↑↓ 选择',
      'Enter 确认',
      'Esc 寄放',
    ]);
  });
});

// ═══ C. harness 集成：G-39 帮助浮层 + Ctrl+X 冲突修复 ═══════════════════════

function blockedHarness(opts: FixtureOptions = {}): { f: Fixture; release: () => void } {
  let release!: () => void;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const f = makeHarness({
    ...opts,
    runUserTurn: async (text: string) => {
      if (text === 'first') await blocker;
      return result('done');
    },
  });
  f.h.feed('first\r');
  return { f, release };
}

describe('P3-F G-39 快捷键帮助浮层', () => {
  it('Ctrl+X 打开帮助浮层（真实内容：队列段/会话选择器段/P7 段）', () => {
    const { h } = makeHarness();
    expect(h.state.overlays).toHaveLength(0);
    h.feed(CTRL_X);
    expect(h.state.overlays).toHaveLength(1);
    expect(h.state.overlays[0]?.title).toContain('Keyboard shortcuts');
    const items = h.state.overlays[0]?.items ?? [];
    const texts = items.map((l) => (typeof l === 'string' ? l : l.label));
    expect(texts).toContain('── Agent 级键位（G-31～G-41） ──');
    expect(texts.some((l) => l.includes('Ctrl+M — 模型选择器') && l.includes('（P7 未接入）'))).toBe(true);
    expect(h.state.shortcuts).toEqual(['Esc / q 关闭', '↑↓ / j k 滚动']);
    h.feed(CTRL_X); // toggle 关闭
    expect(h.state.overlays).toHaveLength(0);
    expect(h.state.shortcuts).toEqual(['/ 命令', 'Tab 焦点', 'Ctrl+C 退出']);
    h.dispose();
  });

  it('Ctrl+.（kitty CSI-u）打开同一浮层；Esc / q 关闭', async () => {
    const { h } = makeHarness();
    h.feed(KITTY_CTRL_DOT);
    expect(h.state.overlays[0]?.title).toContain('Keyboard shortcuts');
    expect(h.state.shortcuts).toEqual(['Esc / q 关闭', '↑↓ / j k 滚动']);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时（50ms）后 parser 才产出 Esc 键
    expect(h.state.overlays).toHaveLength(0);
    h.feed(KITTY_CTRL_DOT);
    expect(h.state.overlays).toHaveLength(1);
    h.feed('q');
    expect(h.state.overlays).toHaveLength(0);
    h.dispose();
  });

  it('↑↓ / j / k 滚动高亮（回绕）；接管期字母不进草稿', () => {
    const { h } = makeHarness();
    h.feed(CTRL_X);
    expect(h.state.overlays[0]?.activeIndex).toBe(0);
    h.feed(ARROW_DOWN);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.feed('j');
    expect(h.state.overlays[0]?.activeIndex).toBe(2);
    h.feed(ARROW_UP);
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.feed('abc'); // 若透传会进草稿
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('Ctrl+C 在帮助浮层内仍走 guard 协议（G-38 唯一取消键；busy → 取消回合）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(CTRL_X);
    expect(f.h.state.overlays[0]?.title).toContain('Keyboard shortcuts');
    f.h.feed('\x03'); // Ctrl+C
    expect(f.aborts()).toBe(1); // 浮层接管期不再「Ctrl+C 全哑」
    release();
    await settle(f.h);
    f.h.dispose();
  });
});

describe('P3-F Ctrl+X 键位冲突修复（Ctrl+X 归帮助，Ctrl+; 归队列面板）', () => {
  it('busy 且队列非空：Ctrl+X 开帮助、**不**开队列面板；Ctrl+; 仍开队列面板', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.submit('second message'); // 入队
    f.h.feed(CTRL_X);
    expect(f.h.state.overlays[0]?.title).toContain('Keyboard shortcuts'); // 不再是 Queue · N
    f.h.feed(CTRL_X); // 关帮助
    f.h.feed(KITTY_CTRL_SEMI);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 1 项');
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('队列面板内：裸 x = 取消高亮项；Ctrl+X = 关面板并开帮助（模态让位全局帮助键）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.submit('second');
    f.h.submit('third');
    f.h.feed(KITTY_CTRL_SEMI);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项');
    f.h.feed('x'); // 裸 x：取消末行（G-29 打开高亮 = 末行）；面板保持打开（仍剩 1 条）
    expect(f.h.queueSnapshot()).toEqual(['second']);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 1 项');
    f.h.feed(CTRL_X); // 面板内 Ctrl+X：关面板 + 开帮助（队列未被取消）
    expect(f.h.state.overlays[0]?.title).toContain('Keyboard shortcuts');
    expect(f.h.queueSnapshot()).toEqual(['second']);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('空队列 + Ctrl+X：只开帮助，不出现「（队列为空）」提示', () => {
    const { h } = makeHarness();
    h.feed(CTRL_X);
    expect(h.state.overlays[0]?.title).toContain('Keyboard shortcuts');
    expect((h.state.indicators ?? []).join(' ')).not.toContain('队列为空');
    h.dispose();
  });

  it('审批挂起时 Ctrl+X 不开帮助（审批最优先，卡片不被顶掉）', async () => {
    const { h, gate } = makeHarness();
    const p = gate.ask('允许执行 write?');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(CTRL_X);
    expect(h.state.overlays).toHaveLength(1);
    expect(h.state.overlays[0]?.title).toContain('Approval'); // 审批层在先消费
    h.approve('n');
    await p;
    h.dispose();
  });
});

// ═══ D. harness 集成：G-34 会话选择器 ════════════════════════════════════════

describe('P3-F G-34 会话选择器（Ctrl+R）', () => {
  it('Ctrl+R 打开列表（当前会话带 * 前缀）；Enter 经 /resume 切换会话', async () => {
    const f = makeHarness({
      sessions: [summary('s-new', 5), summary('s-old', 2)],
      currentId: 's-new',
    });
    f.h.feed(KITTY_CTRL_R);
    expect(f.h.state.overlays).toHaveLength(1);
    expect(f.h.state.overlays[0]?.title).toContain('会话 · 2');
    expect(f.h.state.overlays[0]?.items[0]).toContain('* s-new');
    expect(f.h.state.shortcuts).toEqual(['↑↓ 选择', 'Enter 切换', 'Esc 取消']);
    f.h.feed(ARROW_DOWN); // 高亮 s-old
    f.h.feed('\r');
    await settle(f.h);
    expect(f.switched).toEqual(['s-old']);
    expect(f.h.state.overlays).toHaveLength(0); // 确认后关闭
    expect(f.h.logicalLines().join('\n')).toContain('切换会话 s-old');
    f.h.dispose();
  });

  it('Esc / q 取消：不切换、关浮层', async () => {
    const f = makeHarness({ sessions: [summary('s-a'), summary('s-b')] });
    f.h.feed(KITTY_CTRL_R);
    f.h.feed('q');
    expect(f.switched).toEqual([]);
    expect(f.h.state.overlays).toHaveLength(0);
    f.h.feed(KITTY_CTRL_R);
    f.h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC 空闲超时后成为 Esc 键
    expect(f.switched).toEqual([]);
    expect(f.h.state.overlays).toHaveLength(0);
    f.h.dispose();
  });

  it('无历史会话：如实提示，不画空壳浮层', () => {
    const f = makeHarness({ sessions: [] });
    f.h.feed(KITTY_CTRL_R);
    expect(f.h.state.overlays).toHaveLength(0);
    expect((f.h.state.indicators ?? []).join(' ')).toContain('无历史会话');
    f.h.dispose();
  });

  it('busy 时确认：如实拒绝（不切换会话）', async () => {
    const { f, release } = blockedHarness({ sessions: [summary('s-a'), summary('s-b')] });
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(KITTY_CTRL_R);
    expect(f.h.state.overlays).toHaveLength(1);
    f.h.feed('\r');
    expect(f.switched).toEqual([]);
    expect((f.h.state.indicators ?? []).join(' ')).toContain('回合运行中不可切换');
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('审批挂起时 Ctrl+R 不开列表（审批最优先）', async () => {
    const f = makeHarness({ sessions: [summary('s-a')] });
    const p = f.gate.ask('允许执行 write?');
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(KITTY_CTRL_R);
    expect(f.h.state.overlays[0]?.title).toContain('Approval');
    f.h.approve('n');
    await p;
    f.h.dispose();
  });
});
