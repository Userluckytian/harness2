// p3d-wiring.test.ts — P3-D 接线棒验收（headless，FakeOut + mock runtime）：
// - G-01 [接线]：minimal 基座实体化——initialRenderMode=minimal 不进 alt-screen；转录
//   追加式写进原生滚动区（printLines）；live 尾部（流式 step / pending 工具）落定后追加；
//   阻塞卡（审批）画进 prompt 块（不可隐形）；
// - G-02 [接线]：/minimal /fullscreen 真·进程内切换（状态提交 + 基座互换 + 会话/草稿
//   保留）；fullscreen→minimal 全量重放；minimal→fullscreen 新建 alt-screen 全帧重画；
// - G-03 [接线]：门控真实生效——minimal 下 /theme /search 被拒（文案含「运行 /fullscreen
//   切换本会话」指向替代语义）；/expand 仅 minimal 可用且为真实重放动作；
// - G-05 [接线]：folds 规格机——respect_manual_folds 对 live 尾部 autoFold 的两种裁决
//   （true 不覆盖手动展开 / false 覆盖）与重投影保留/重置；minimal 下折叠键如实提示；
// - G-06 [接线]：block-ops 真实回调——y/Shift+Y 走 OSC52 复制通道（out.buffer 含 OSC52
//   序列），Enter/Ctrl+F 开 overlay 查看器（真实浮层，Esc/q/Enter 关闭）；
// - G-09 [接线]：turn 锚点注册（user 回合首行）+ Shift+H/L/J/K 键位消费与视口移动；
// - G-11 [接线]：`!` shell 模式——回显、执行缝注入、输出进转录系统行 + [exit N] 标注、
//   stderr 前缀、多条串行、`!!` 转义不触发（走模型回合）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnResult } from '@harness2/core';
import type { ChatRuntime } from '../../../src/chat-setup.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';
import type { ShellExecResult } from '../../../src/tui/next/shell-exec.js';
import { Scrollback } from '../../../src/tui/next/scrollback.js';

const ENTER = '\r';
const TAB = '\t';
const ESC = '\x1b';
const CTRL_F = '\x06';
const ARROW_UP = '\x1b[A';

function result(finalText: string, turnId = 't1'): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId,
    textOutcome: 'final',
    finalText,
  };
}

class FakeOut {
  buffer = '';
  columns = 80;
  rows = 24;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function makeRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: { list: () => [], locate: () => undefined } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-p3d-test',
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
    submitSteer: () => ({ state: 'unknown', reason: 'stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: () => () => undefined,
    finish: async () => undefined,
    ...overrides,
  };
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
    bootLines?: string[];
    initialRenderMode?: 'fullscreen' | 'minimal';
    minimalStatusLine?: boolean;
    respectManualFolds?: boolean;
    shellExec?: (command: string, opts: { cwd: string }) => Promise<ShellExecResult>;
    cwd?: string;
    home?: string;
  } = {},
): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: opts.bootLines ?? [],
    env: {},
    gate,
    exit: () => undefined,
    ...(opts.initialRenderMode !== undefined ? { initialRenderMode: opts.initialRenderMode } : {}),
    ...(opts.minimalStatusLine !== undefined ? { minimalStatusLine: opts.minimalStatusLine } : {}),
    ...(opts.respectManualFolds !== undefined ? { respectManualFolds: opts.respectManualFolds } : {}),
    ...(opts.shellExec !== undefined ? { shellExec: opts.shellExec } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
  return { h, out, gate, runtime };
}

/** 推进 timers 并让 microtask 落定（50ms live flush + 16ms scheduler flush 都收敛） */
async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

/** 提交一条消息并等 turn 收尾 */
async function submitTurn(h: NextChatHarness, text: string): Promise<void> {
  h.feed(text);
  h.feed(ENTER);
  await settle(h);
}

function shellResult(overrides: Partial<ShellExecResult> = {}): ShellExecResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— G-01：minimal 基座实体化 ——

describe('G-01 minimal 基座（initialRenderMode=minimal，不进 alt-screen）', () => {
  it('minimal 初值启动：不写 alt-screen 进入序列（不接管屏幕，MINIMAL_CONTRACT.altScreen=false）', () => {
    const { h, out } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    expect(h.renderMode()).toBe('minimal');
    expect(out.buffer).not.toContain('\x1b[?1049h'); // ALT_SCREEN_ENTER 未出现
    expect(out.buffer).not.toContain('\x1b[?1000h'); // 鼠标上报未开（不接管鼠标）
    h.dispose();
  });

  it('bootLines（系统行）直写原生滚动区：启动即追加式写出', () => {
    const { h, out } = makeHarness(undefined, {
      bootLines: ['会话: s1（新建）'],
      initialRenderMode: 'minimal',
    });
    expect(out.buffer).toContain('会话: s1（新建）\n'); // 逐行 text\n（write-through）
    expect(h.minimalPrintedLines()).toContain('会话: s1（新建）');
    h.dispose();
  });

  it('用户回显与助手回复落定后追加（不重绘已写行）', async () => {
    const { h, out } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    await submitTurn(h, '你好');
    expect(out.buffer).toContain('❯ 你好\n'); // 用户回显（write-through）
    expect(out.buffer).toContain('收到：你好\n'); // 助手终态
    expect(h.minimalPrintedLines()).toContain('❯ 你好');
    expect(h.minimalPrintedLines()).toContain('收到：你好');
    const countAfter = h.minimalPrintedLines().length;
    h.flushUi(); // 空转：追加式管线不重复写已落定行
    expect(h.minimalPrintedLines().length).toBe(countAfter);
    h.dispose();
  });

  it('live 尾部暂扣：流式 step 在 turn 收尾（落定）后才一次性写出', async () => {
    let release: (() => void) | null = null;
    const releaseTurn = (): void => {
      release?.();
    };
    const runtime = makeRuntime({
      runUserTurn: async (_text, onStream) => {
        onStream({ type: 'text-delta', text: '第一段', turnId: 't1' });
        await new Promise<void>((r) => {
          release = r;
        });
        return result('第一段');
      },
    });
    const { h, out } = makeHarness(runtime, { initialRenderMode: 'minimal' });
    h.feed('hi');
    h.feed(ENTER);
    await settle(h, 120); // 50ms live flush 已发生（step item 在转录中被原地替换）
    // live step 未落定（turn 未收尾）：正文尚未写进原生滚动区
    expect(out.buffer).not.toContain('第一段');
    releaseTurn();
    await settle(h);
    expect(out.buffer).toContain('第一段\n'); // 收尾（openStep 关闭）后一次性写出
    h.dispose();
  });

  it('pending 工具暂扣：result 落定（含失败原因）后才写出该块', async () => {
    let release: (() => void) | null = null;
    const releaseTurn = (): void => {
      release?.();
    };
    const runtime = makeRuntime({
      runUserTurn: async (_text, onStream) => {
        onStream({
          type: 'tool-call',
          call: { id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'sleep' }) },
          turnId: 't1',
        });
        await new Promise<void>((r) => {
          release = r;
        });
        onStream({ type: 'tool-result', callId: 'c1', ok: false, error: 'boom', turnId: 't1' });
        return result('x');
      },
    });
    const { h, out } = makeHarness(runtime, { initialRenderMode: 'minimal' });
    h.feed('run');
    h.feed(ENTER);
    await settle(h, 60);
    expect(out.buffer).not.toContain('⏺ bash'); // pending 工具未写出
    releaseTurn();
    await settle(h, 60);
    expect(out.buffer).toContain('⏺ bash'); // 落定后一次性写出
    expect(out.buffer).toContain('└ ✗ boom');
    h.dispose();
  });

  it('minimalStatusLine 开启：状态行画进 prompt 块（MINIMAL_STATUS_LINE_DEFAULT=false 的装配缝）', () => {
    const { h, out } = makeHarness(undefined, {
      initialRenderMode: 'minimal',
      minimalStatusLine: true,
      cwd: '/tmp/p3d',
      home: '/tmp',
    });
    h.flushUi();
    expect(out.buffer).toContain('~/p3d'); // statusLineFor 的 cwd 段（home=/tmp → ~ 短化）
    h.dispose();
  });

  it('缺省 minimalStatusLine=false：状态行不占行（最接近 legacy readline 形态）', () => {
    const { h, out } = makeHarness(undefined, {
      initialRenderMode: 'minimal',
      cwd: '/tmp/p3d',
      home: '/tmp',
    });
    h.flushUi();
    expect(out.buffer).not.toContain('/tmp/p3d');
    h.dispose();
  });
});

// —— G-02：进程内切换 ——

describe('G-02 真·进程内切换（fullscreen ↔ minimal，不重启）', () => {
  it('fullscreen→minimal：退 alt-screen + 已落定转录全量重放 + 状态提交', async () => {
    const { h, out } = makeHarness();
    await submitTurn(h, '切换前');
    out.buffer = '';
    h.submit('/minimal');
    h.flushUi();
    expect(h.renderMode()).toBe('minimal'); // 状态机真实提交
    expect(out.buffer).toContain('\x1b[?1049l'); // ALT_SCREEN_EXIT（退 alt-screen）
    expect(out.buffer).toContain('❯ 切换前\n'); // 重放（minimal 记账从零开始）
    expect(out.buffer).toContain('收到：切换前\n');
    expect(h.minimalPrintedLines()).toContain('收到：切换前');
    h.dispose();
  });

  it('minimal→fullscreen：擦 prompt 块 + 新建 alt-screen + 全帧重画（会话保留）', async () => {
    const { h, out } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    await submitTurn(h, '在 minimal 里');
    out.buffer = '';
    h.submit('/fullscreen');
    h.flushUi();
    expect(h.renderMode()).toBe('fullscreen');
    expect(out.buffer).toContain('\x1b[?1049h'); // 重新进 alt-screen（新 Screen 实例）
    expect(out.buffer).toContain('\x1b[?1000;1002;1006h'); // 鼠标上报随全屏基座恢复
    expect(out.buffer).toContain('\x1b[?1003h'); // 全 motion 上报补开（幂等）
    expect(h.logicalLines().join('\n')).toContain('收到：在 minimal 里'); // 转录原样
    h.dispose();
  });

  it('往返切换（full→minimal→full→minimal）：转录/草稿跨切换保留，重放幂等不翻倍', async () => {
    const { h, out } = makeHarness();
    await submitTurn(h, '往返');
    h.feed('草稿');
    h.submit('/minimal');
    h.flushUi();
    expect(h.state.draft).toBe('草稿');
    const replay1 = h.minimalPrintedLines().filter((l) => l === '收到：往返').length;
    h.submit('/fullscreen');
    h.flushUi();
    h.submit('/minimal');
    h.flushUi();
    const replay2 = h.minimalPrintedLines().filter((l) => l === '收到：往返').length;
    expect(replay1).toBe(1);
    expect(replay2).toBe(1); // 每次进入 minimal 重放一次（resetMinimalReplay 记账）
    expect(out.buffer).toContain('\x1b[?1049l');
    h.dispose();
  });

  it('minimal 基座下跑完整回合：内容走追加式写出、不进 alt-screen（不重启的直接证据）', async () => {
    // 注：busy 中斜杠命令按既有 submit 队列语义入队（G-26），切换发生在空闲态——
    // 本用例锁「切换后同进程同一会话继续出回合且走 minimal 管线」。
    let release: (() => void) | null = null;
    const releaseTurn = (): void => {
      release?.();
    };
    const runtime = makeRuntime({
      runUserTurn: async (text) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return result(`收到：${text}`);
      },
    });
    const { h, out } = makeHarness(runtime, { initialRenderMode: 'minimal' });
    h.submit('minimal 里跑回合');
    h.feed(ENTER);
    await settle(h, 20);
    releaseTurn();
    await settle(h);
    expect(h.isBusy()).toBe(false);
    expect(out.buffer).toContain('收到：minimal 里跑回合\n'); // write-through 落定写出
    expect(out.buffer).not.toContain('\x1b[?1049h'); // 全程未进 alt-screen
    expect(h.renderMode()).toBe('minimal');
    h.dispose();
  });
});

// —— G-03：模式限定命令 ——

describe('G-03 门控真实生效（指向替代语义）', () => {
  it('minimal 下 /theme 被拒：文案含「运行 /fullscreen 切换本会话」', () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    h.submit('/theme');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain(
      '当前渲染模式（minimal）下不可用：/theme（仅 fullscreen 模式提供；运行 /fullscreen 切换本会话）',
    );
    h.dispose();
  });

  it('G-84：minimal 下 /t 别名与规范 /theme 同门控（拒绝文案取规范命令名，回显保留原输入）', () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    h.submit('/t');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain(
      '当前渲染模式（minimal）下不可用：/theme（仅 fullscreen 模式提供；运行 /fullscreen 切换本会话）',
    );
    expect(all).toContain('> /t'); // 用户原输入照常回显
    h.dispose();
  });

  it('minimal 下 /search 被拒（P1-2：/search 已在 FULLSCREEN_ONLY_COMMANDS，与 badge 同源）', () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    h.submit('/search hi');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain(
      '当前渲染模式（minimal）下不可用：/search（仅 fullscreen 模式提供；运行 /fullscreen 切换本会话）',
    );
    h.dispose();
  });

  it('minimal 下 /expand 真实可用 = 完整转录重放（resetMinimalReplay）', async () => {
    const { h, out } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    await submitTurn(h, '第一轮');
    expect(h.minimalPrintedLines().filter((l) => l === '收到：第一轮').length).toBe(1); // 首次写出
    h.submit('/expand');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain('已重新输出完整转录到原生滚动区（/expand）');
    // 重放记账清零后整份重写：账本里是重放后的一份；stdout 里新旧共两份
    expect(h.minimalPrintedLines().filter((l) => l === '收到：第一轮').length).toBe(1);
    expect(out.buffer.split('收到：第一轮\n').length - 1).toBe(2); // 原始 + 重放
    expect(h.minimalPrintedLines()).toContain('已重新输出完整转录到原生滚动区（/expand）');
    h.dispose();
  });
});

// —— G-05：folds 规格机接线 ——

describe('G-05 respect_manual_folds（folds.ts 规格机可观测消费）', () => {
  interface HeldTurn {
    runtime: ChatRuntime;
    release: () => void;
  }
  /** 流式 thinking 块 + 挂起不收尾的 turn（autoFold 的作用对象 = 开口 step） */
  function heldThinkingTurn(): HeldTurn {
    let release: (() => void) | null = null;
    const runtime = makeRuntime({
      runUserTurn: async (_text, onStream) => {
        onStream({ type: 'reasoning-delta', text: '推理内容', turnId: 't1' });
        await new Promise<void>((r) => {
          release = r;
        });
        return result('done');
      },
    });
    return { runtime, release: () => release?.() };
  }

  it('respect=true（缺省）：手动展开的流式 thinking 块不被 autoFold 重新折叠', async () => {
    const held = heldThinkingTurn();
    const { h } = makeHarness(held.runtime);
    h.feed('go');
    h.feed(ENTER);
    await settle(h, 80); // 50ms flush：assistant/step 落转录（开口 step，自动折叠态）
    h.feed(TAB);
    h.feed('l'); // 手动展开最近块（manual=true）
    expect(h.logicalLines().join('\n')).toContain('│ 推理内容');
    await settle(h, 80); // 再 flush：autoFold 每轮推送 collapsed=true
    expect(h.logicalLines().join('\n')).toContain('│ 推理内容'); // 手动展开存活（不覆盖）
    const snap = h.foldSnapshot();
    const thinkingId = 'f:assistant:t1:step:0'; // turnId=t1 的开口 step → 折叠块 id
    expect(snap.manual).toContain(thinkingId); // 手动开合已记账
    expect(snap.collapsed).not.toContain(thinkingId); // 且未被自动折叠覆盖
    held.release();
    await settle(h);
    h.dispose();
  });

  it('respect=false：autoFold 覆盖手动折叠（流式块被重新折叠，manual 标记失效）', async () => {
    const held = heldThinkingTurn();
    const { h } = makeHarness(held.runtime, { respectManualFolds: false });
    h.feed('go');
    h.feed(ENTER);
    await settle(h, 80);
    h.feed(TAB);
    h.feed('l'); // 手动展开 → 同一轮 reproject 内 autoFold（respect=false）即覆盖回折叠
    const thinkingId = 'f:assistant:t1:step:0';
    expect(h.logicalLines().join('\n')).not.toContain('│ 推理内容'); // 展开不可见（被覆盖）
    const snap = h.foldSnapshot();
    expect(snap.collapsed).toContain(thinkingId); // 回到自动折叠态
    expect(snap.manual).not.toContain(thinkingId); // 手动标记被覆盖清失效（reduceFolds.autoFold 语义）
    held.release();
    await settle(h);
    h.dispose();
  });

  it('minimal 下折叠键如实提示（追加式转录已写出内容不可撤回）', async () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    await submitTurn(h, 'hi');
    h.feed(TAB);
    h.feed('e');
    h.flushUi();
    expect((h.state.indicators ?? []).join(' ')).toContain('minimal：折叠/视图变更仅影响后续输出');
    h.dispose();
  });
});

// —— G-06：block-ops 真实回调注入 ——

describe('G-06 块内容操作（y/Shift+Y 复制、Enter/Ctrl+F 查看器）', () => {
  async function turnWithTool(h: NextChatHarness): Promise<void> {
    // 直接走 submit → runtime 流一个 tool call/result + 正文
    await submitTurn(h, 'hi');
  }

  it('y（滚动区焦点，无选择）= 复制最近块正文（OSC52 写 stdout + 提示）', async () => {
    const { h, out } = makeHarness();
    await turnWithTool(h);
    out.buffer = '';
    h.feed(TAB);
    h.feed('y');
    await settle(h, 10);
    expect(out.buffer).toContain('\x1b]52;c;'); // OSC52 复制序列（base64 载荷）
    expect((h.state.indicators ?? []).join(' ')).toContain('已复制块正文');
    h.dispose();
  });

  it('Shift+Y = 复制块正文+元数据（role/tool/call 行）', async () => {
    const { h, out } = makeHarness();
    await turnWithTool(h);
    out.buffer = '';
    h.feed(TAB);
    h.feed('Y'); // legacy 大写字符 = Shift+Y
    await settle(h, 10);
    expect(out.buffer).toContain('\x1b]52;c;');
    expect((h.state.indicators ?? []).join(' ')).toContain('已复制块正文+元数据');
    h.dispose();
  });

  it('Enter（滚动区焦点）= 打开最近块查看器（真实 overlay；Esc 关闭还焦点）', async () => {
    const { h } = makeHarness();
    await turnWithTool(h);
    h.feed(TAB);
    h.feed(ENTER);
    h.flushUi();
    expect(h.state.overlays.length).toBe(1);
    expect(h.state.overlays[0]?.title).toContain('查看 · ');
    h.feed(ESC); // 孤立 ESC 经空闲超时产出（parser 语义；跨 idle 周期相位留足余量）
    await settle(h, 200);
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('Ctrl+F = 同一查看器双入口；查看器内 Ctrl+F 再按关闭（对称收口）', async () => {
    const { h } = makeHarness();
    await turnWithTool(h);
    h.feed(TAB);
    h.feed(CTRL_F);
    h.flushUi();
    expect(h.state.overlays.length).toBe(1);
    h.feed(CTRL_F);
    h.flushUi();
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('查看器内 q 关闭；接管期字母不透传 composer（P1-1 防御）', async () => {
    const { h } = makeHarness();
    await turnWithTool(h);
    h.feed(TAB);
    h.feed(ENTER);
    h.flushUi();
    expect(h.state.overlays.length).toBe(1);
    h.feed('q');
    h.flushUi();
    expect(h.state.overlays.length).toBe(0);
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('空转录 y：诚实提示（无可操作的块），不写 OSC52', () => {
    const { h, out } = makeHarness();
    h.feed(TAB);
    h.feed('y');
    h.flushUi();
    expect(out.buffer).not.toContain('\x1b]52;c;');
    h.dispose();
  });
});

// —— G-09：turn 粒度导航 ——

describe('G-09 turn 锚点 API（Scrollback）', () => {
  /** 12 行内容、锚点 [0, 4, 8]；视口 4 行（maxScroll=8）——钳制不干扰的干净场景 */
  function makeScrollback(): Scrollback {
    const sb = new Scrollback([], 20);
    sb.appendLines(['t1a', 't1b', 't1c', 't1d', 't2a', 't2b', 't2c', 't2d', 't3a', 't3b', 't3c', 't3d']);
    sb.markTurn(0);
    sb.markTurn(4);
    sb.markTurn(8);
    return sb;
  }

  it('markTurn 升序去重；turnAnchors 快照；clearTurns 清空', () => {
    const sb = makeScrollback();
    sb.markTurn(4); // 重复忽略
    expect(sb.turnAnchors()).toEqual([0, 4, 8]);
    sb.clearTurns();
    expect(sb.turnAnchors()).toEqual([]);
  });

  it("jumpTurn('next')：下一 turn 贴视口顶；脱开 follow", () => {
    const sb = makeScrollback();
    sb.visibleWindow(4);
    sb.goToTop(); // 视口顶 = 行 0（turn1）
    expect(sb.jumpTurn('next', 4)).toBe(true);
    expect(sb.follow).toBe(false);
    expect(sb.scrollTopRow).toBe(4); // turn2 首行贴顶
  });

  it("jumpTurn('prev')：上一 turn；已在首个 turn 不动（false）", () => {
    const sb = makeScrollback();
    sb.visibleWindow(4);
    sb.goToTop();
    sb.jumpTurn('next', 4); // → turn2 顶（行 4）
    expect(sb.jumpTurn('prev', 4)).toBe(true);
    expect(sb.scrollTopRow).toBe(0); // turn1 首行
    expect(sb.jumpTurn('prev', 4)).toBe(false); // 已在首个 turn
  });

  it("jumpTurn('above')：视口顶上方最近的 turn（含回到当前 turn 首行）", () => {
    const sb = makeScrollback();
    sb.visibleWindow(4);
    sb.goToTop();
    sb.scrollBy(5); // 视口顶 = 行 5（turn2 中间）
    expect(sb.jumpTurn('above', 4)).toBe(true);
    expect(sb.scrollTopRow).toBe(4); // turn2 首行（在视口顶上方最近）
  });

  it("jumpTurn('below')：视口底下方的首个 turn", () => {
    const sb = makeScrollback();
    sb.visibleWindow(4);
    sb.goToTop(); // 视口 [0..3]（bottom=3）
    expect(sb.jumpTurn('below', 4)).toBe(true);
    expect(sb.scrollTopRow).toBe(4); // turn3 之外的下方首个 turn = turn2（行 4）
  });

  it("jumpTurn('next') 至末 turn 后无目标 = false（不移动）", () => {
    const sb = makeScrollback();
    sb.visibleWindow(4);
    sb.goToTop();
    sb.scrollBy(8); // 视口顶 = 行 8（turn3 首）
    expect(sb.jumpTurn('next', 4)).toBe(false);
    expect(sb.scrollTopRow).toBe(8);
  });

  it('无锚点 jumpTurn = false（不移动）', () => {
    const sb = new Scrollback(['a', 'b'], 20);
    sb.visibleWindow(4);
    expect(sb.jumpTurn('next', 4)).toBe(false);
    expect(sb.follow).toBe(true);
  });
});

describe('G-09 turn 粒度导航接线（Shift+H/L/J/K，仅 scrollback 焦点）', () => {
  /** 长回复（30 行）保证两回合内容超出视口（跳转有真实位移空间）；turnId 唯一防原地替换 */
  function longTextRuntime(): ChatRuntime {
    const body = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    let n = 0;
    return makeRuntime({
      runUserTurn: async (text: string) => result(`${body}\n（回复：${text}）`, `turn${++n}`),
    });
  }

  async function twoTurns(h: NextChatHarness): Promise<void> {
    await submitTurn(h, '第一轮');
    await submitTurn(h, '第二轮');
  }

  it('user 回合首行注册为锚点（两回合 → 两锚点）', async () => {
    const { h } = makeHarness(longTextRuntime());
    await twoTurns(h);
    const anchors = h.turnAnchors();
    expect(anchors.length).toBe(2);
    const lines = h.logicalLines();
    expect(lines[anchors[0] ?? -1]).toBe('❯ 第一轮');
    expect(lines[anchors[1] ?? -1]).toBe('❯ 第二轮');
    h.dispose();
  });

  it('Shift+H（nav.turn-prev）回上一 turn；Shift+L（nav.turn-next）跳下一 turn；不进草稿', async () => {
    const { h } = makeHarness(longTextRuntime());
    await twoTurns(h);
    h.feed(TAB);
    h.feed('H'); // legacy 大写 = Shift+H：turn2（视口顶）→ turn1 首行贴顶
    h.flushUi();
    expect(h.state.scrollback.follow).toBe(false);
    const anchor0 = h.turnAnchors()[0] ?? 0;
    const anchor1 = h.turnAnchors()[1] ?? 0;
    expect(h.state.scrollback.scrollTopRow).toBe(h.state.scrollback.lineStart(anchor0));
    h.feed('L'); // Shift+L：turn1 → turn2 首行贴顶
    h.flushUi();
    expect(h.state.scrollback.scrollTopRow).toBe(h.state.scrollback.lineStart(anchor1));
    expect(h.state.draft).toBe(''); // 键位消费，不落草稿
    h.dispose();
  });

  it('Shift+J（nav.viewport-turn-below）在末回合无下方目标 = 边界提示（不移动）', async () => {
    const { h } = makeHarness(longTextRuntime());
    await twoTurns(h);
    h.feed(TAB);
    h.feed('J'); // 贴底跟随态：视口底下无 turn
    h.flushUi();
    expect((h.state.indicators ?? []).join(' ')).toContain('已是边界回合');
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('Shift+K（nav.viewport-turn-above）回到视口顶上方最近的 turn 首行', async () => {
    const { h } = makeHarness(longTextRuntime());
    await twoTurns(h);
    h.feed(TAB);
    h.feed('L'); // → turn2 首行贴顶
    h.flushUi();
    h.feed(ARROW_UP); // 单行上滚：视口顶进入 turn1 尾部（anchor 33 之上）
    h.flushUi();
    h.feed('K'); // Shift+K → 视口顶上方最近的 turn = turn2 首行
    h.flushUi();
    const anchor1 = h.turnAnchors()[1] ?? 0;
    expect(h.state.scrollback.scrollTopRow).toBe(h.state.scrollback.lineStart(anchor1));
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('minimal 下 turn 导航如实提示（终端原生滚动）', async () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'minimal' });
    await submitTurn(h, 'hi');
    h.feed(TAB);
    h.feed('L');
    h.flushUi();
    expect((h.state.indicators ?? []).join(' ')).toContain('minimal：转录在终端原生滚动区');
    h.dispose();
  });
});

// —— G-11：`!` shell 模式 ——

describe('G-11 shell 模式（行首 ! 直接执行；不经 core 工具审批）', () => {
  it('!cmd → 回显 > !cmd + 输出系统行 + [exit 0]', async () => {
    const calls: string[] = [];
    const { h } = makeHarness(undefined, {
      shellExec: async (command) => {
        calls.push(command);
        return shellResult({ stdout: 'hello\nworld\n' });
      },
    });
    h.feed('!echo hi');
    h.feed(ENTER);
    await settle(h, 20);
    expect(calls).toEqual(['echo hi']); // 剥 ! 前缀与至多一个空白
    const lines = h.logicalLines();
    expect(lines).toContain('> !echo hi'); // 用户回显（与斜杠命令同通道）
    expect(lines).toContain('hello'); // stdout 逐行
    expect(lines).toContain('world');
    expect(lines).toContain('[exit 0]'); // 退出码如实标注
    h.dispose();
  });

  it('stderr 行加 [stderr] 前缀；非零退出码如实标注', async () => {
    const { h } = makeHarness(undefined, {
      shellExec: async () => shellResult({ code: 3, stdout: 'out', stderr: 'err line\n' }),
    });
    h.feed('!false');
    h.feed(ENTER);
    await settle(h, 20);
    const lines = h.logicalLines();
    expect(lines).toContain('out');
    expect(lines).toContain('[stderr] err line');
    expect(lines).toContain('[exit 3]');
    h.dispose();
  });

  it('多行输出超限截断并如实标注；末行恒为退出码', async () => {
    const { h } = makeHarness(undefined, {
      shellExec: async () => shellResult({ stdout: Array.from({ length: 260 }, (_, i) => `l${i}`).join('\n') }),
    });
    h.feed('!seq');
    h.feed(ENTER);
    await settle(h, 20);
    const lines = h.logicalLines();
    expect(lines).toContain('l199'); // 缺省 200 行预算内
    expect(lines).not.toContain('l200');
    expect(lines).toContain('（输出截断：共 260 行，仅显示前 200 行）');
    expect(lines).toContain('[exit 0]');
    h.dispose();
  });

  it('多条 ! 命令按提交序串行执行（shellChain）', async () => {
    const calls: string[] = [];
    const { h } = makeHarness(undefined, {
      shellExec: async (command) => {
        calls.push(command);
        return shellResult({ stdout: command });
      },
    });
    h.feed('!first');
    h.feed(ENTER);
    h.feed('!second');
    h.feed(ENTER);
    await settle(h, 30);
    expect(calls).toEqual(['first', 'second']);
    const lines = h.logicalLines();
    const i1 = lines.indexOf('first');
    const i2 = lines.indexOf('second');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    h.dispose();
  });

  it('!! 转义不触发 shell（字面文本走模型回合）', async () => {
    const calls: string[] = [];
    const { h } = makeHarness(undefined, {
      shellExec: async (command) => {
        calls.push(command);
        return shellResult();
      },
    });
    h.feed('!!not-a-command');
    h.feed(ENTER);
    await settle(h);
    expect(calls).toEqual([]);
    expect(h.logicalLines().join('\n')).toContain('收到：!!not-a-command'); // 走了模型回合
    h.dispose();
  });

  it('busy 时 ! 命令入队（G-26 队列语义），turn 收尾后执行', async () => {
    let release: (() => void) | null = null;
    let turnDone = false;
    const releaseTurn = (): void => {
      release?.();
    };
    const runtime = makeRuntime({
      runUserTurn: async (text) => {
        await new Promise<void>((r) => {
          release = r;
        });
        turnDone = true;
        return result(`收到：${text}`);
      },
    });
    const calls: string[] = [];
    const { h } = makeHarness(runtime, {
      shellExec: async (command) => {
        calls.push(command);
        return shellResult({ stdout: `ran:${command}` });
      },
    });
    h.feed('busy msg');
    h.feed(ENTER);
    await settle(h, 20);
    h.feed('!queued');
    h.feed(ENTER);
    await settle(h, 20);
    expect(calls).toEqual([]); // 忙时未执行（入队）
    expect(h.queueSnapshot()).toContain('!queued');
    releaseTurn();
    await settle(h, 30);
    expect(turnDone).toBe(true);
    expect(calls).toEqual(['queued']); // drain 后执行
    h.dispose();
  });

  it('shell 输出进 minimal 基座同通道（追加式写出）', async () => {
    const { h, out } = makeHarness(undefined, {
      initialRenderMode: 'minimal',
      shellExec: async () => shellResult({ stdout: 'minimal out' }),
    });
    h.feed('!ls');
    h.feed(ENTER);
    await settle(h, 20);
    expect(out.buffer).toContain('minimal out\n');
    expect(out.buffer).toContain('[exit 0]\n');
    h.dispose();
  });
});
