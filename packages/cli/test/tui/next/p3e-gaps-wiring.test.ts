// P3-E 补缺口接线用例（P3-② 测试棒，只加测试文件、零 src 改动）：在 p3e-wiring.test.ts /
// p3e-chrome.test.ts 已有的**接线主路径**之外，补上任务点名的真空格：
//
//  1. G-25 卡内焦点不泄漏的**接线级**强证据：卡活动期 Tab/Shift+Tab 双向回环（3 项卡）、
//     字母不改草稿、全局焦点指示全程不出现 'scrollback'；卡退完后全局环立刻恢复。
//  2. G-29 队列面板接线级：Ctrl+; 开/关 toggle、Ctrl+' / Ctrl+4 变体、prompt 焦点 ↑
//     转焦到队列面板（末行高亮）、空队列 ↑ 不开假面板。
//  3. G-30 边界：卡接管键盘（未寄放）时 Enter = 确认卡片，**绝不**误走直送；直送不入队。
//  4. G-42~G-49 状态行接线级：
//     - builtin 数据来自**真实会话状态**（磁盘会话日志 → getContextUsage → 百分比段）；
//     - command 型真实子进程：零输出成功 → 收掉整行（不回退 builtin/chrome）；
//     - command 型随会话状态变化反复起停（每轮全新进程，间隔 > 防抖窗）+ 连续三次失败
//       端到端（unified.jsonl 逐次落盘 + 状态行画错误行）；
//     - **refresh_interval 自举（P3 修复棒）**：装配完成时发一次 governor `started` 事件
//       排下首个定时器，此后无任何输入也会按周期反复起真实子进程（此前缺口：schedule-timer
//       只由 timer-fire 产出，而 timer-fire 只回填「已排定」定时器 → 鸡生蛋，配了
//       refresh_interval 也不跑；模块级状态机语义本就完整，断在装配层）。
//
// 诚实边界（任务红线）：
//  - G-22/G-23/G-24（cancel-turn/question/elicitation 卡）在 harness2 无真实来源，归存 P7，
//    本文件不造演示卡（与 p3e-wiring 同口径）。
//  - 任务简报写作「三连败降级到 builtin」，但 G-47/G-48 明文与实现一致的口径是
//    「空输出**收掉整行**，绝不回退 builtin」+「连续三次失败才画错误行」——本文件按
//    上游规格与实现事实断言，不按简报措辞断言（报告里登记该措辞差异）。
//  - G-30 空草稿 Enter 的「no-op」由 C 棒 wiring-contract 单测覆盖；接线层可达路径是
//    「寄放态 + 非空草稿」，此处只补卡接管态 Enter≠直送 的边界。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContextUsage, SessionWriter } from '@harness2/core';
import type { SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime, ChatSession } from '../../../src/chat-setup.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';
import type { ResolvedStatusLineSettings } from '../../../src/tui/status-line/config.js';
import type { RenderMode } from '../../../src/tui/render/mode.js';

const ENTER = '\r';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const ARROW_UP = '\x1b[A';
const KITTY_CTRL_SEMI = '\x1b[59;5u'; // kitty CSI-u：';' + ctrl（G-29 主键）
const KITTY_CTRL_APOS = '\x1b[39;5u'; // kitty CSI-u：'\'' + ctrl（G-29 备用键）
const KITTY_CTRL_4 = '\x1b[52;5u'; // kitty CSI-u：'4' + ctrl（G-29 macOS VS Code 族主键）

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

// —— 临时资源登记（会话 fixture / 目录），afterAll 统一回收 ——

const tempDirs: string[] = [];
const writers: SessionWriter[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 写一个**真实**会话日志目录（SessionWriter：header + 一轮 user/assistant） */
function makeSessionDir(sessionId = 'p3e-gaps-sess', textLength = 16): { dir: string; writer: SessionWriter } {
  const dir = tempDir('hx-p3e-gaps-sess-');
  const writer = SessionWriter.create(dir, { sessionId }, { fsync: false });
  writers.push(writer);
  writer.append('user/message', { text: '第一轮问题', turnId: 't1' });
  writer.append('assistant/message', { text: '回答'.repeat(Math.max(1, textLength)), model: 'mock', turnId: 't1' });
  return { dir, writer };
}

function sessionOf(dir: string, writer: SessionWriter): ChatSession {
  return { id: 'p3e-gaps-sess', dir, writer };
}

function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const steerObservers = new Set<(r: SteerResult) => void>();
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: tempDir('hx-p3e-gaps-root-'),
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string) => result(`收到：${text}`),
    abortTurn: () => undefined,
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
    ...overrides,
  };
  (runtime as unknown as { __steerObservers: Set<(r: SteerResult) => void> }).__steerObservers = steerObservers;
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
}

function makeHarness(
  runtime: ChatRuntime = makeRuntime(),
  opts: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    home?: string;
    followUpBehavior?: 'queue' | 'steer';
    statusLine?: ResolvedStatusLineSettings;
    initialRenderMode?: RenderMode;
  } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const sinkBridge: { sink: SubagentEventSink } = {
    sink: { set: () => undefined },
  };
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: opts.env ?? {},
    gate,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.initialRenderMode !== undefined ? { initialRenderMode: opts.initialRenderMode } : {}),
    subagentEventSink: sinkBridge.sink,
    ...(opts.followUpBehavior !== undefined ? { followUpBehavior: opts.followUpBehavior } : {}),
    ...(opts.statusLine !== undefined ? { statusLine: opts.statusLine } : {}),
    exit: () => undefined,
  });
  return { h, out, gate, runtime };
}

async function settle(h: NextChatHarness, ms = 120): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

function linesOf(h: NextChatHarness): string[] {
  return h.logicalLines();
}

function indicatorText(h: NextChatHarness): string {
  return (h.state.indicators ?? []).join(' ');
}

/** 真实时钟轮询（command 型状态行走真实子进程，不能注入 harness 时钟） */
async function waitFor(cond: () => boolean, timeoutMs = 15_000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const w of writers) {
    try {
      w.close();
    } catch {
      // 已关闭/句柄异常不阻塞清理
    }
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放延迟（EBUSY 等）不阻塞测试收尾
    }
  }
});

// ─── G-25：卡内焦点不泄漏（接线级强证据） ────────────────────────────────────

describe('G-25 接线级：卡活动期卡内环独占，全局焦点环挂起', () => {
  it('3 项卡：Tab 双向回环、字母不改草稿/不切模式，全局指示全程无 scrollback；卡退完即恢复', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    expect(h.state.overlays[0]?.items).toHaveLength(3); // approval 卡三选项（y/a/n）
    expect(indicatorText(h)).not.toContain('scrollback');

    // 卡接管期字母被吞（controller 已 blur）：草稿/模式均不受影响
    h.feed('x');
    expect(h.state.draft).toBe('');
    expect(indicatorText(h)).not.toContain('plan');

    h.feed(TAB); // 0 → 1
    h.feed(TAB); // 1 → 2
    expect(h.state.overlays[0]?.activeIndex).toBe(2);
    h.feed(TAB); // 2 → 0（回环；证明按键真的进了卡内环）
    expect(h.state.overlays[0]?.activeIndex).toBe(0);
    h.feed(SHIFT_TAB); // 0 → 2（反向回环）
    expect(h.state.overlays[0]?.activeIndex).toBe(2);
    // 全程全局环未被喂键：焦点指示不出现 scrollback
    expect(indicatorText(h)).not.toContain('scrollback');

    h.cancelApproval();
    expect(h.state.overlays).toHaveLength(0);
    h.feed(TAB); // 卡退完：全局环恢复——第一次 Tab 即切到 scrollback
    expect(indicatorText(h)).toContain('scrollback');
    h.dispose();
  });

  it('结算后重新接卡：卡内环 reset 回第 0 项（新 ask 不继承旧下标）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed(TAB);
    h.feed(TAB);
    expect(h.state.overlays[0]?.activeIndex).toBe(2);
    h.cancelApproval();
    void gate.ask('允许执行 bash?');
    expect(h.state.overlays[0]?.activeIndex).toBe(0);
    expect(h.state.overlays[0]?.title).toBe('Approval · bash');
    h.cancelApproval();
    h.dispose();
  });
});

// ─── G-29：队列面板接线级（开/关/变体/↑ 转焦） ───────────────────────────────

describe('G-29 接线级：Ctrl+; 开合 toggle / 键位变体 / ↑ 转焦', () => {
  function busyWithQueue(): { f: Fixture; release: () => void } {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const f = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          if (text === 'first') await blocker;
          return result(`收到：${text}`);
        },
      }),
    );
    f.h.submit('first'); // 占住 busy（该条不入队）
    f.h.submit('second'); // 入队
    f.h.submit('third'); // 入队
    return { f, release };
  }

  it('Ctrl+; 打开（非空）→ 再按 Ctrl+; 关闭（toggle 对称）；打开即末行高亮', async () => {
    const { f, release } = busyWithQueue();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(KITTY_CTRL_SEMI);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项');
    expect(f.h.state.overlays[0]?.activeIndex).toBe(1); // 末行
    f.h.feed(KITTY_CTRL_SEMI); // 面板打开期：同键 = 关闭
    expect(f.h.state.overlays).toHaveLength(0);
    expect(f.h.queueSnapshot()).toEqual(['second', 'third']); // 关闭不动队列
    release();
    await settle(f.h, 400);
    f.h.dispose();
  });

  it("G-29 键位变体：Ctrl+'（备用）与 Ctrl+4（macOS VS Code 族）同样开面板", async () => {
    for (const key of [KITTY_CTRL_APOS, KITTY_CTRL_4]) {
      const { f, release } = busyWithQueue();
      await vi.advanceTimersByTimeAsync(0);
      f.h.feed(key);
      expect(f.h.state.overlays[0]?.title, `变体 ${JSON.stringify(key)} 未开面板`).toBe('Queue · 2 项');
      expect(f.h.state.overlays[0]?.activeIndex).toBe(1);
      release();
      await settle(f.h);
      f.h.dispose();
    }
  });

  it('prompt 焦点 + 空草稿 ↑ = 焦点转入队列面板（末行高亮）且键盘被面板接管', async () => {
    const { f, release } = busyWithQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.h.state.draft).toBe('');
    f.h.feed(ARROW_UP);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项');
    expect(f.h.state.overlays[0]?.activeIndex).toBe(1); // 「with the last row highlighted」
    f.h.feed('abc'); // 面板接管期字母不进草稿（P1-1 同款防御）
    expect(f.h.state.draft).toBe('');
    release();
    await settle(f.h, 400);
    f.h.dispose();
  });

  it('空队列 ↑ 不开假面板（退回内置历史/草稿路径，不产生浮层）', () => {
    const { h } = makeHarness();
    h.feed(ARROW_UP);
    expect(h.state.overlays).toHaveLength(0);
    h.dispose();
  });
});

// ─── G-30：卡接管态 Enter ≠ 直送（边界） ─────────────────────────────────────

describe('G-30 接线级边界：卡接管键盘时 Enter 只确认卡片', () => {
  it('审批卡接管（未寄放）时 Enter = 确认卡片，绝不取消回合/直送/入队', async () => {
    let aborted = 0;
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const f = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          if (text === 'first') await blocker;
          return result(`收到：${text}`);
        },
      }),
    );
    f.h.submit('first');
    f.runtime.abortTurn = () => {
      aborted += 1;
    };
    await vi.advanceTimersByTimeAsync(0);
    void f.gate.ask('允许执行 write?');
    expect(f.h.pendingApproval()).toBe('允许执行 write?');
    f.h.feed('x'); // 卡接管：草稿不受影响
    f.h.feed(ENTER); // = 确认卡片（默认 y）
    expect(f.h.pendingApproval()).toBeNull();
    expect(aborted).toBe(0); // 未取消回合
    expect(f.h.queueSnapshot()).toEqual([]); // 未入队
    release();
    await settle(f.h, 400);
    expect(linesOf(f.h).join('\n')).toContain('收到：first'); // 原回合照常收尾
    f.h.dispose();
  });
});

// ─── G-42~G-49：状态行接线级 ─────────────────────────────────────────────────
// command 型走真实子进程（runner spawn 不可注入 harness deps），本组用真实 timers + 轮询。

describe('P3-E 补口：状态行接线级（G-42~G-49）', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('G-43/G-44：builtin 数据来自真实会话状态——ctx 百分比取自磁盘会话（非 chrome 的 ctx —）', () => {
    const { dir, writer } = makeSessionDir('p3e-gaps-sess');
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(makeRuntime({ getCurrent: () => sessionOf(dir, writer) }), {
      cwd,
      home: cwd,
      statusLine: {
        type: 'builtin',
        items: ['cwd', 'model', 'context'],
        command: undefined,
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    const usage = getContextUsage(dir);
    expect(usage).toBeDefined(); // 真实会话可读出占用比
    const pct = Math.min(100, Math.max(0, Math.round((usage as number) * 100)));
    const base = cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop();
    expect(h.state.statusline).toBe(`${base} │ mock │ ${pct}% ctx`); // 段分隔符 = ' │ '（G-43）
    expect(h.state.statusline).not.toContain('ctx —'); // 与 chrome 的「未知占用」区分
    h.dispose();
  });

  it('G-47：command 型零输出成功 = 收掉整行（statusLines 空、chrome 让位），绝不回退 builtin', async () => {
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(undefined, {
      cwd,
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 0',
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    // 首绘 state-changed → 300ms 防抖 → 真子进程 → run-finished（ok, 零行）
    await new Promise((r) => setTimeout(r, 900));
    expect(h.state.statusLines).toEqual([]);
    expect(h.state.statusline).toBe(''); // command 型恒让位单行 chrome
    h.dispose();
  });

  it('G-46/G-48：command 型真实子进程随会话状态变化反复起停；连续三次失败全部落盘 + 状态行画错误行', async () => {
    const home = tempDir('hx-p3e-gaps-slhome-');
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(undefined, {
      cwd,
      home,
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 3', // cmd / sh 同义；无输出、非零退出 → 每次运行都失败
        padding: 0,
        refreshIntervalSec: undefined, // 纯事件驱动（本用例不依赖定时器；自举由下一用例覆盖）
      },
    });
    const logFile = join(home, '.harness2', 'logs', 'unified.jsonl');
    const logCount = (): number => {
      if (!existsSync(logFile)) return 0;
      const text = readFileSync(logFile, 'utf8').trim();
      return text.length === 0 ? 0 : text.split('\n').length;
    };
    // 装配期首绘已触发一次 state run；再以「turn 起/收 = 状态变化」驱动多轮真实运行
    // （每轮 run 均为全新子进程，间隔 > 300ms 防抖窗口 → 不合并）。
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 4; i += 1) {
      h.submit(`turn-${i}`);
      await sleep(700);
    }
    await waitFor(() => logCount() >= 3, 10_000);
    expect(logCount()).toBeGreaterThanOrEqual(3); // 三次（以上）连续失败逐次落盘 unified.jsonl
    await waitFor(() => (h.state.statusLines ?? []).join('\n').includes('status line 脚本退出码 3'), 5_000);
    expect(h.state.statusline).toBe(''); // command 型恒让位单行 chrome（错误行走 statusLines 槽）
    h.dispose();
  });

  it('G-45：run-finished 失败经 log-failure 指令落 unified.jsonl（source/字段逐条可读）', async () => {
    const home = tempDir('hx-p3e-gaps-slhome-');
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(undefined, {
      cwd,
      home,
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 3',
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    const logFile = join(home, '.harness2', 'logs', 'unified.jsonl');
    await waitFor(() => existsSync(logFile), 10_000);
    const entry = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'error', source: 'status_line', timedOut: false });
    expect(String(entry['message'])).toContain('退出码 3');
    h.dispose();
  });

  it('G-46 自举（fullscreen）：refresh_interval=1 的命令型状态行在无后续输入下按周期反复运行（≥3 次运行/日志）', async () => {
    const home = tempDir('hx-p3e-gaps-slhome-');
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(undefined, {
      cwd,
      home,
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 3',
        padding: 0,
        refreshIntervalSec: 1, // 1s 周期（修复前：首个定时器无来源 → 只有 1 条 state run 日志）
      },
    });
    const logFile = join(home, '.harness2', 'logs', 'unified.jsonl');
    const logCount = (): number => {
      if (!existsSync(logFile)) return 0;
      const text = readFileSync(logFile, 'utf8').trim();
      return text.length === 0 ? 0 : text.split('\n').length;
    };
    // 装配期首绘 = 唯一一次 state run（一次失败 → 1 条日志）。
    await waitFor(() => logCount() >= 1, 5_000);
    const baseline = logCount();
    // 此后**不再提交任何输入**：唯一的时间源是 refresh_interval 定时器，故新增日志只可能来自
    // 周期运行的 refresh run——这是「首个定时器真的启动并按节奏跑」的接线级强证据。
    await waitFor(() => logCount() >= baseline + 2, 8_000);
    expect(logCount()).toBeGreaterThanOrEqual(3); // 数秒内 ≥3 次运行（含首绘）
    // G-48 降级语义不回退：持续失败（空输出 + 非零退出）仍画错误行
    await waitFor(() => (h.state.statusLines ?? []).join('\n').includes('status line 脚本退出码 3'), 5_000);
    h.dispose();
  });

  it('G-46 自举（minimal 基座）：同一 governor 装配生效——refresh_interval=1 同样周期运行', async () => {
    const home = tempDir('hx-p3e-gaps-slhome-');
    const cwd = tempDir('hx-p3e-gaps-cwd-');
    const { h } = makeHarness(undefined, {
      cwd,
      home,
      initialRenderMode: 'minimal', // minimal 经 deps.minimalStatusLine 缝展示同一 statusLines 输出
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 3',
        padding: 0,
        refreshIntervalSec: 1,
      },
    });
    const logFile = join(home, '.harness2', 'logs', 'unified.jsonl');
    const logCount = (): number => {
      if (!existsSync(logFile)) return 0;
      const text = readFileSync(logFile, 'utf8').trim();
      return text.length === 0 ? 0 : text.split('\n').length;
    };
    await waitFor(() => logCount() >= 1, 5_000);
    const baseline = logCount();
    await waitFor(() => logCount() >= baseline + 2, 8_000);
    expect(h.renderMode()).toBe('minimal'); // 全程未切换基座
    expect(logCount()).toBeGreaterThanOrEqual(3);
    h.dispose();
  });
});
