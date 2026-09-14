// P3-E 接线棒（串行）：四块接线在 next 渲染层的 harness 集成主路径（headless，mock runtime）。
// 覆盖（接线点 → 用例）：
//  1. palette 接线（G-31/G-50/G-03；A 棒五步缝）：Ctrl+P / ? 开关、查询键盘（draft-preserving）、
//     ↑↓/Enter、Esc 走 esc-machine exit-card、Enter → handleCommand 分发（G-03 门控自动生效）
//     与 shellOnly 路由 runPaletteShellCommand。
//  2. 卡片调度接线（G-21/G-25；B 棒）：审批卡经调度器 + CardView→OverlaySpec 映射；
//     G-25 全局环挂起缝（卡活动期 Tab 绝不落全局环）。卡内环走行/Enter 确认/数字直选由
//     next-shell.test.ts「P3-B 审批 blocking card」组覆盖，此处不重复。
//  3. 队列/转向接线（G-26~G-30；C 棒）：Enter 状态机路由（queue/steer 两态）、G-27 空草稿
//     发队首、G-28 send-now 和弦（kitty Ctrl+Enter）、G-30 blocked 直送、G-29 Ctrl+; 面板。
//  4. 状态行接线（G-42~G-49；C 棒）：builtin 型接管状态行；command 型 governor→runner→paint
//     全链（真实子进程；失败画错误行 + unified 日志落盘 injected home）。
// 诚实边界（任务红线）：cancel-turn/question/elicitation 三类卡在 harness2 无真实来源，
// 本文件不造任何演示卡（G-22/G-23/G-24 归存 P7）；steer 面板移除语义按 core 现状（无 cancel
// API，accepted 回帧才移除展示行）如实断言。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnySessionEvent, SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
  type SubagentEventSink,
} from '../../../src/tui/next/next-shell.js';
import type { ResolvedStatusLineSettings } from '../../../src/tui/status-line/config.js';

const CTRL_P = '\x10'; // Ctrl+P（0x10 → C0 控制字节 → key 'p' + ctrl）
const ESC = '\x1b';
const ENTER = '\r';
const KITTY_CTRL_ENTER = '\x1b[13;5u'; // kitty CSI-u：enter + ctrl（G-28 send-now 主键）
const KITTY_CTRL_SEMI = '\x1b[59;5u'; // kitty CSI-u：';' + ctrl（G-29 队列面板主键 Ctrl+;）

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

function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const steerObservers = new Set<(r: SteerResult) => void>();
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [],
      locate: () => undefined,
      // P7 加性：palette 全项枚举会执行 /reindex（core 会话能力命令）——stub 提供最小实现
      reindex: () => ({ sessions: 0, indexed: 0, messages: 0, failures: [] }),
      searchIndexed: () => [],
    } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p3e-wiring',
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
  // 观察者引用（steer 回帧测试用）：挂到对象上便于取出（同 next-shell.test.ts 口径）
  (runtime as unknown as { __steerObservers: Set<(r: SteerResult) => void> }).__steerObservers = steerObservers;
  return runtime;
}

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
  sink?: { emit: (sessionId: string, event: AnySessionEvent) => void };
}

function makeHarness(
  runtime: ChatRuntime = makeRuntime(),
  opts: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    home?: string;
    followUpBehavior?: 'queue' | 'steer';
    statusLine?: ResolvedStatusLineSettings;
  } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const sinkBridge: { sink: SubagentEventSink; emit: (sessionId: string, event: AnySessionEvent) => void } = (() => {
    let handler: ((sessionId: string, event: AnySessionEvent) => void) | null = null;
    return {
      sink: {
        set(fn) {
          handler = fn;
        },
      },
      emit: (sessionId, event) => handler?.(sessionId, event),
    };
  })();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: opts.env ?? {},
    gate,
    cwd: opts.cwd,
    home: opts.home,
    subagentEventSink: sinkBridge.sink,
    ...(opts.followUpBehavior !== undefined ? { followUpBehavior: opts.followUpBehavior } : {}),
    ...(opts.statusLine !== undefined ? { statusLine: opts.statusLine } : {}),
    exit: () => undefined,
  });
  return { h, out, gate, runtime, sink: { emit: sinkBridge.emit } };
}

async function settle(h: NextChatHarness, ms = 120): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

function linesOf(h: NextChatHarness): string[] {
  return h.logicalLines();
}

/** palette 行里是否含命令名（组头行「── x」不算命令） */
function paletteCommandNames(h: NextChatHarness): string[] {
  const rows = h.state.palette?.rows ?? [];
  return rows.flatMap((r) => (r.kind === 'command' ? [`/${r.entry.name}`] : []));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 接线1：palette（G-31/G-50/G-03；A 棒五步缝） ────────────────────────────

describe('P3-E 接线1：palette（Ctrl+P / ? / 键盘 / Enter 路由）', () => {
  it('Ctrl+P 打开：面板数据进 ChatScreenState；条目 = core ∪ 壳（单一来源派生，G-50）', () => {
    const { h } = makeHarness();
    expect(h.state.palette?.state.open ?? false).toBe(false);
    h.feed(CTRL_P);
    expect(h.state.palette?.state.open).toBe(true);
    const names = paletteCommandNames(h);
    expect(names).toContain('/help'); // core describeCapabilities（唯一来源）
    expect(names).toContain('/theme'); // 壳条目（NEXT_COMMANDS 派生，无第三份清单）
    expect(names).toContain('/doctor'); // P3-A shellOnly 批次（core catalog）
    expect(h.state.draft).toBe(''); // 面板不改写草稿
    h.feed(CTRL_P); // 再按 = 关闭（toggle）
    expect(h.state.palette?.state.open ?? false).toBe(false);
    h.dispose();
  });

  it('查询键盘：字符/退格进面板查询不进草稿（draft-preserving）；↑↓ 走行钳制', () => {
    const { h } = makeHarness();
    h.feed(CTRL_P);
    h.feed('plug');
    expect(h.state.palette?.state.query).toBe('plug');
    expect(h.state.draft).toBe(''); // 查询与草稿相互独立
    expect(paletteCommandNames(h)).toEqual(['/plugins']); // 过滤生效
    h.feed('\x7f'); // Backspace → 'plu'
    expect(h.state.palette?.state.query).toBe('plu');
    const before = h.state.palette?.state.active ?? -1; // PaletteState.active（rows 下标）
    h.feed('\x1b[B'); // ↓
    h.feed('\x1b[A'); // ↑（单条命中：端点钳制不回绕）
    expect(h.state.palette?.state.active).toBe(before);
    h.dispose();
  });

  it('Enter 执行（缝 #5）：/{name} 走 handleCommand；shellOnly 路由 runPaletteShellCommand', async () => {
    // /plugins = P3-A shellOnly（core 无 run 体）→ runPaletteShellCommand（A 棒 thin 实现）；
    // deps.home 注入不存在目录 → 扫描为空 →「（无插件）」（确定性输出，点了有反应）。
    const { h } = makeHarness(undefined, { home: '/tmp/hx-p3e-missing-home' });
    h.feed(CTRL_P);
    h.feed('plugins');
    h.feed(ENTER);
    expect(h.state.palette?.state.open ?? false).toBe(false); // 命中命令 → 关面板
    const all = linesOf(h).join('\n');
    expect(all).toContain('> /plugins'); // 经 handleUserText 既有回显
    expect(all).toContain('（无插件）'); // runPaletteShellCommand 输出（进转录系统行）
    h.dispose();
  });

  it('Enter 执行走 handleCommand：G-03 门控自动生效（fullscreen 下 /expand 拒绝并指向替代）', () => {
    const { h } = makeHarness();
    h.feed(CTRL_P);
    h.feed('expand');
    h.feed(ENTER);
    expect(linesOf(h).join('\n')).toContain(
      '当前渲染模式（fullscreen）下不可用：/expand（仅 minimal 模式提供；运行 /minimal 切换本会话）',
    );
    h.dispose();
  });

  it('? 仅空草稿触发（G-31 上游钉死语义）；打字中的 ? 进草稿不开面板', () => {
    const { h } = makeHarness();
    h.feed('?');
    expect(h.state.palette?.state.open).toBe(true); // 空草稿 → 面板
    h.feed(CTRL_P); // 关闭
    h.feed('hi');
    h.feed('?');
    expect(h.state.draft).toBe('hi?'); // 打字中的 ? 进草稿
    expect(h.state.palette?.state.open ?? false).toBe(false);
    h.dispose();
  });

  it('Esc 关闭走 esc-machine exit-card 级（缝 #3，面板无特例分支）；关闭后键盘回 composer', async () => {
    const { h } = makeHarness();
    h.feed(CTRL_P);
    expect(h.state.palette?.state.open).toBe(true);
    h.feed(ESC);
    await settle(h, 60); // 孤立 ESC 空闲超时（50ms）后 parser 产出 Esc 键
    expect(h.state.palette?.state.open ?? false).toBe(false);
    h.feed('x');
    expect(h.state.draft).toBe('x'); // 键盘已还 composer
    h.dispose();
  });

  it('执行不改写草稿（对齐上游 SendSlashCommandPreservingDraft）', async () => {
    const { h } = makeHarness(undefined, { home: '/tmp/hx-p3e-missing-home' });
    h.feed('abc');
    h.feed(CTRL_P);
    h.feed('plugins');
    h.feed(ENTER);
    await settle(h, 60);
    expect(h.state.draft).toBe('abc'); // 面板全生命周期草稿原样
    expect(linesOf(h).join('\n')).toContain('（无插件）');
    h.dispose();
  });

  // 完成定义「palette 每个面板项点了有反应」的机器证据：全量枚举面板行（core 29 单源 +
  // 壳 5 = 34；/search 已进 core catalog，故壳条目由 6 减为 5），逐项在**全新 harness** 里走
  // Ctrl+P → 查询 → Enter 的完整面板路径，断言无三类「断线」兜底文案。状态型反应（/exit 退出、
  // /new 换会话、/minimal 切模式）无 print 输出，由各自既有用例覆盖；此处的判据 = 不落兜底。
  it('每个面板项执行都不落兜底（全 34 项枚举；逐项新 harness 防状态串扰）', async () => {
    const probe = makeHarness(undefined, { home: '/tmp/hx-p3e-missing-home' });
    probe.h.feed(CTRL_P);
    const names = paletteCommandNames(probe.h).map((n) => n.slice(1));
    probe.h.dispose();
    expect(names).toHaveLength(34); // 29 core（describeCapabilities）+ 5 壳（plan/auto/always-approve/theme/expand）
    for (const name of names) {
      const { h } = makeHarness(undefined, { home: '/tmp/hx-p3e-missing-home' });
      h.feed(CTRL_P);
      const rows = h.state.palette?.rows ?? [];
      const idx = rows.findIndex((r) => r.kind === 'command' && r.entry.name === name);
      expect(idx, `面板缺条目 /${name}`).toBeGreaterThanOrEqual(0);
      // 空查询 = 全量条目；↑↓ 逐行到目标（跳过组头、端点钳制不回绕）——不用模糊查询：
      // 查询为子串匹配，如 'skills' 会同时命中 /doctor 的 summary（非唯一，避免误执行）
      const pos = rows.slice(0, idx + 1).filter((r) => r.kind === 'command').length - 1;
      for (let i = 0; i < pos; i += 1) h.feed('\x1b[B');
      h.feed(ENTER);
      await settle(h, 60);
      const all = linesOf(h).join('\n');
      // 回显 = 面板 Enter 确实经 executePaletteCommand → handleUserText 分发（缝 #5）
      expect(all, `/ ${name} 未经面板分发链回显`).toContain(`> /${name}`);
      // 断线信号三类：core 未知命令兜底 / core shellOnly 无 run 兜底 / 模式门控之外的静默
      expect(all, `/${name} 落「未知命令」兜底`).not.toContain('未知命令');
      expect(all, `/${name} 落 core shellOnly 无 run 兜底`).not.toContain('由界面层实现');
      h.dispose();
    }
  });
});

// ─── 接线2：卡片调度（G-21/G-25；B 棒） ─────────────────────────────────────

describe('P3-E 接线2：卡片调度（审批卡走 B 棒调度器；G-25 全局环挂起）', () => {
  it('审批 ask → pushCard（G-21 最高优先）：overlay = renderCard 映射（title/items/activeIndex）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    // CardView→OverlaySpec 零换算映射（B 棒 render.ts 契约）：title=`Approval · ${tool}`、
    // items[].label、焦点环下标 → activeIndex、1-3 直选（showNumbers）。
    expect(h.state.overlays).toHaveLength(1);
    expect(h.state.overlays[0]?.title).toBe('Approval · write');
    expect(h.state.overlays[0]?.items).toEqual(['y 允许（本次）', 'a 总是允许（本会话）', 'n 拒绝']);
    expect(h.state.overlays[0]?.activeIndex).toBe(0);
    expect(h.state.overlays[0]?.showNumbers).toBe(true);
    h.cancelApproval();
    h.dispose();
  });

  it('G-25 接缝谓词生效：卡活动期 Tab/Shift+Tab 只走卡内环，全局环挂起（scrollback 指示不出现）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.feed('\t'); // Tab → 卡内 next（index 1）
    h.feed('\t'); // → 2
    expect(h.state.overlays[0]?.activeIndex).toBe(2);
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback'); // 全局环未切换
    h.feed('\x1b[Z'); // Shift+Tab → 卡内 prev（1）
    expect(h.state.overlays[0]?.activeIndex).toBe(1);
    h.cancelApproval();
    // 卡退完：全局环恢复——Tab 正常切换焦点（'scrollback' 指示出现）
    h.feed('\t');
    expect((h.state.indicators ?? []).join(' ')).toContain('scrollback');
    h.dispose();
  });

  it('结算走 resolveCard：卡移除后可再次接卡（调度器可复用；新 ask 重新接管）', () => {
    const { h, gate } = makeHarness();
    void gate.ask('允许执行 write?');
    h.cancelApproval();
    expect(h.state.overlays).toHaveLength(0);
    void gate.ask('允许执行 bash?');
    expect(h.state.overlays).toHaveLength(1);
    expect(h.state.overlays[0]?.title).toBe('Approval · bash');
    h.cancelApproval();
    h.dispose();
  });
});

// ─── 接线3：队列/转向（G-26~G-30；C 棒） ────────────────────────────────────

describe('P3-E 接线3：Enter 状态机 / send-now / Ctrl+; 面板（G-26~G-30）', () => {
  function blockedHarness(opts: { followUpBehavior?: 'queue' | 'steer' } = {}): {
    f: Fixture;
    release: () => void;
  } {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    let turnSeq = 0; // 每回合唯一 turnId：result() 缺省恒 't1'，多回合 assistant item id 碰撞会互相覆盖
    const f = makeHarness(
      makeRuntime({
        runUserTurn: async (text: string) => {
          turnSeq += 1;
          const turnId = `t-${turnSeq}`;
          if (text === 'first') await blocker;
          return result(`收到：${text}`, { turnId });
        },
      }),
      opts,
    );
    f.h.submit('first'); // 占住 busy
    return { f, release };
  }

  it('G-26 queue（缺省）：busy 态非空草稿 Enter → 入队不打断（system 行 + 草稿清空）', async () => {
    const { f, release } = blockedHarness();
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed('跟一条');
    f.h.feed(ENTER);
    expect(f.h.queueSnapshot()).toEqual(['跟一条']); // C 队列本体（非旧 string[] FIFO）
    expect(f.h.state.draft).toBe(''); // draftCleared
    expect(linesOf(f.h)).toContain('已入队，不打断当前回合（收尾后按序执行）');
    release();
    await settle(f.h);
    expect(linesOf(f.h).join('\n')).toContain('收到：first');
    f.h.dispose();
  });

  it('G-26 steer：同 Enter 仍入队展示 + runtime.submitSteer 提交；accepted 回帧移除展示行', async () => {
    const submitted: string[] = [];
    const { f, release } = blockedHarness({
      followUpBehavior: 'steer',
    });
    f.runtime.submitSteer = (text: string) => {
      submitted.push(text);
      return { state: 'submitted', id: 'core-s1', turnId: 'turn-1', message: 'steer 已提交（测试）' };
    };
    f.runtime.currentTurnId = () => 'turn-1'; // turnId 可知（unknown → steer-unknown，另行降级）
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed('转向文本');
    f.h.feed(ENTER);
    expect(submitted).toEqual(['转向文本']); // 装配层经 core SessionSteerSink 通道提交
    expect(f.h.queueSnapshot()).toEqual(['转向文本']); // 展示行仍在（accepted 前保留）
    expect(linesOf(f.h).join('\n')).toContain('steer 已提交（测试）');
    // core 回帧 accepted → 移除展示行（stale/rejected 保留 = 转入下一回合）
    const observers = (f.runtime as unknown as { __steerObservers: Set<(r: SteerResult) => void> }).__steerObservers;
    for (const fn of observers) fn({ id: 'core-s1', expectedTurnId: 'turn-1', state: 'accepted' });
    f.h.flushUi();
    expect(f.h.queueSnapshot()).toEqual([]);
    release();
    await settle(f.h);
    f.h.dispose();
  });

  it('G-27：busy 态空草稿 Enter = 发送队首（立即出队；turn 收尾作为下一回合执行）', async () => {
    const { f, release } = blockedHarness();
    f.h.submit('second');
    f.h.submit('third');
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(ENTER); // 空草稿
    // G-27：running 回合中空草稿 Enter = 发送队首一条（本队列首 = 第二条提交 'second'）；
    // 'first' 是运行中回合（submit 空闲态直发，从不入队），出队后队列余 ['third']
    expect(f.h.queueSnapshot()).toEqual(['third']); // 队首 'second' 已出队（先发槽）
    release();
    await settle(f.h, 400);
    const all = linesOf(f.h).join('\n');
    expect(all).toContain('收到：first'); // 先发槽优先于 drain
    expect(all).toContain('收到：second'); // 收尾 drain 按序
    expect(all).toContain('收到：third');
    f.h.dispose();
  });

  it('G-28 send-now 和弦（kitty Ctrl+Enter）：取消当前回合并立即发送草稿（cancel-and-send）', async () => {
    let aborted = 0;
    const { f, release } = blockedHarness();
    f.runtime.abortTurn = () => {
      aborted += 1;
    };
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed('中断文本');
    f.h.feed(KITTY_CTRL_ENTER);
    expect(aborted).toBe(1); // 取消当前回合
    expect(linesOf(f.h).join('\n')).toContain('^C'); // 如实取消行
    expect(f.h.state.draft).toBe(''); // 草稿已转入先发槽
    release();
    await settle(f.h, 400);
    expect(linesOf(f.h).join('\n')).toContain('收到：中断文本'); // turn 收尾后立即发送
    f.h.dispose();
  });

  it('G-28：空闲态 send-now no-op（不提交新回合；草稿保留）', () => {
    const { h } = makeHarness();
    h.feed('空闲草稿');
    h.feed(KITTY_CTRL_ENTER);
    expect(h.state.draft).toBe('空闲草稿'); // 草稿保留
    expect(linesOf(h).join('\n')).not.toContain('收到：空闲草稿'); // 未提交
    h.dispose();
  });

  it('G-30 blocked 直送：审批寄放（卡等待）中 Enter → 取消审批 + 取消回合 + 直送草稿', async () => {
    let aborted = 0;
    const { f, release } = blockedHarness();
    f.runtime.abortTurn = () => {
      aborted += 1;
    };
    await vi.advanceTimersByTimeAsync(0);
    void f.gate.ask('允许执行 write?');
    expect(f.h.pendingApproval()).toBe('允许执行 write?');
    f.h.feed(ESC);
    await vi.advanceTimersByTimeAsync(60); // 孤立 ESC → 寄放（键盘回 composer）
    f.h.feed('直送文本');
    f.h.feed(ENTER);
    expect(f.h.pendingApproval()).toBeNull(); // gate.cancel（ASK_CANCELLED）
    expect(aborted).toBe(1); // 取消阻塞回合
    expect(f.h.queueSnapshot()).toEqual([]); // 直送不入队（G-30 明文）
    release();
    await settle(f.h, 400);
    expect(linesOf(f.h).join('\n')).toContain('收到：直送文本');
    f.h.dispose();
  });

  it('G-29：Ctrl+;（kitty 主键）开队列面板——高亮末行；面板 Enter = 立即发送高亮行', async () => {
    let aborted = 0;
    const { f, release } = blockedHarness();
    f.runtime.abortTurn = () => {
      aborted += 1;
    };
    f.h.submit('second');
    f.h.submit('third');
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed(KITTY_CTRL_SEMI);
    expect(f.h.state.overlays[0]?.title).toBe('Queue · 2 项'); // 'first' 是运行中回合，不在队列
    expect(f.h.state.overlays[0]?.activeIndex).toBe(1); // G-29：末行高亮
    f.h.feed(ENTER); // 面板内 Enter = panel-send-selected（G-28 cancel-and-send 同路径）
    expect(aborted).toBe(1);
    expect(f.h.queueSnapshot()).toEqual(['second']); // third 出队
    release();
    await settle(f.h, 400);
    const all = linesOf(f.h).join('\n');
    expect(all).toContain('收到：third'); // 高亮行立即发送
    expect(all).toContain('收到：first'); // 原回合收尾
    expect(all).toContain('收到：second'); // 余量 drain
    f.h.dispose();
  });

  it('G-29：空队列 Ctrl+; 不开假面板（「when non-empty」）', () => {
    const { h } = makeHarness();
    h.feed(KITTY_CTRL_SEMI);
    expect(h.state.overlays).toHaveLength(0);
    expect((h.state.indicators ?? []).join(' ')).toContain('队列为空');
    h.dispose();
  });

  it('steer 面板移除如实提示：core 无 cancel API，仅撤展示行、在途注入仍生效（登记 P7）', async () => {
    const { f, release } = blockedHarness({ followUpBehavior: 'steer' });
    f.runtime.submitSteer = () => ({
      state: 'submitted',
      id: 'core-s9',
      turnId: 'turn-9',
      message: 'steer 已提交（测试）',
    });
    f.runtime.currentTurnId = () => 'turn-9';
    await vi.advanceTimersByTimeAsync(0);
    f.h.feed('在途转向');
    f.h.feed(ENTER);
    expect(f.h.queueSnapshot()).toEqual(['在途转向']); // 展示行在（accepted 前保留）
    f.h.feed(KITTY_CTRL_SEMI); // 开面板（busy 且非空）
    f.h.feed('x'); // 取消高亮行
    const all = linesOf(f.h).join('\n');
    // 如实提示：不说「已取消注入」；core SessionSteerSink 无撤回 API（契约冻结，不 thaw core）
    expect(all).toContain('已撤销排队展示行');
    expect(all).toContain('core 无撤回 API');
    expect(all).not.toContain('已取消排队:'); // 在途 steer 行不走「已取消排队」文案
    expect(f.h.queueSnapshot()).toEqual([]); // 展示行已移出
    release();
    await settle(f.h);
    f.h.dispose();
  });
});

// ─── 接线4：状态行（G-42~G-49；C 棒） ───────────────────────────────────────
// command 型走真实子进程（runner spawn 不可注入 harness deps——装配层语义如此），
// 本组用真实 timers + vi.waitFor 轮询（每次运行全新进程，G-45/G-47 真链路证据）。

describe('P3-E 接线4：状态行（builtin / command 型接线）', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('builtin 型接管状态行：C 棒 renderBuiltinStatusLine 渲染（cwd 基名 · model；usage 未知省略 ctx）', () => {
    const { h } = makeHarness(undefined, {
      cwd: '/tmp/hx-p3e-wiring',
      statusLine: {
        type: 'builtin',
        items: ['cwd', 'model', 'context', 'cost', 'turn-timer', 'session-name'],
        command: undefined,
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    // 无活动会话 → usage/cost/turn/session-name 全部缺省省略（G-43/G-44 不造假）；
    // chrome 状态行（disabled 型的 cwd · model · ctx —）让位于 builtin 段渲染
    // （段间分隔符 = STATUS_LINE_SEPARATOR ' │ '，与 chrome 的 ' · ' 不同源，如实断言）。
    expect(h.state.statusline).toBe('hx-p3e-wiring │ mock');
    expect(h.state.statusline).not.toContain('ctx'); // usage 未知 → 段省略
    h.dispose();
  });

  it('command 型：governor 防抖 → runner 真子进程 → stdout 上屏（G-46/G-47 全链）', async () => {
    const { h } = makeHarness(undefined, {
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'echo SL_WIRED',
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    // 首绘：构造期 state-changed → 300ms 防抖 → start-run → 子进程 stdout → paint 上屏
    await vi.waitFor(
      () => {
        expect(h.state.statusLines).toEqual(['SL_WIRED']);
      },
      { timeout: 5000, interval: 50 },
    );
    expect(h.state.statusline).toBe(''); // 单行 chrome 让位（command 型走 statusLines 槽）
    h.dispose();
  });

  it('command 型失败（state 触发）：立刻画错误行 + unified 日志落盘 injected home（G-48）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hx-p3e-slw-'));
    const { h } = makeHarness(undefined, {
      home,
      statusLine: {
        type: 'command',
        items: ['cwd', 'model', 'context'],
        command: 'exit 3',
        padding: 0,
        refreshIntervalSec: undefined,
      },
    });
    await vi.waitFor(
      () => {
        expect((h.state.statusLines ?? []).join('\n')).toContain('status line 脚本退出码 3');
      },
      { timeout: 5000, interval: 50 },
    );
    const logFile = join(home, '.harness2', 'logs', 'unified.jsonl');
    expect(existsSync(logFile)).toBe(true);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"source":"status_line"');
    expect(log).toContain('退出码 3');
    h.dispose();
  });
});
