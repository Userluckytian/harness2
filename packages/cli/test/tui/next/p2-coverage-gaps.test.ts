// p2-coverage-gaps.test.ts — P2-② 测试子代理：G-01～G-20 覆盖矩阵空格补齐（只加测试）。
// 覆盖以下矩阵空格（单元层空格见 render/mode.test.ts 追加段）：
// - G-02 [接线]：跨模式切换请求后运行时状态不丢——草稿保留、转录保留、同一进程内会话
//   照常执行回合（「不重启」在本阶段降级路径下的可观测等价断言）；
// - G-03 [接线]：分发层门控真实触发——fullscreen 下 /expand 被模式门控拒绝（先于
//   「未知命令」兜底），fullscreen-only 命令（/theme）不被门控误拦；
// - G-12 [接线]：Alt+V 到壳走 keymaps 'paste.image' → 诚实提示（不做假粘贴），草稿不动；
// - G-16 [接线]：cancelling 期 Esc 纯 no-op 的负向断言——不重发取消（abort 计数不变）、
//   无提示、无误开 rewind（G-16「重发取消路径已移除」在装配层的对偶验证）；
// - G-19 [接线]：Esc 连打穿越回合结束——宽限内全吞不误开 rewind；宽限过期后双击合法开。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createApprovalGate,
  createNextChatHarness,
  filterCommands,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';
import type { ChatRuntime, TurnResult, TurnStreamHandler } from '../../../src/chat-setup.js';

const ESC = '\x1b';
const ENTER = '\r';
const CTRL_C = '\x03';
const ALT_V = '\x1bv'; // legacy 编码：ESC 前缀 → key 'v' + alt 位（G-12 主和弦）
const ARROW_DOWN = '\x1b[B';

function result(finalText: string): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
  };
}

interface Fixture {
  h: NextChatHarness;
  exitCodes: number[];
  gate: ReturnType<typeof createApprovalGate>;
  calls: { abort: number };
}

function makeHarness(
  overrides: Partial<ChatRuntime> = {},
  opts: { initialRenderMode?: 'fullscreen' | 'minimal' } = {},
): Fixture {
  const calls = { abort: 0 };
  const runtime = {
    provider: { name: 'mock' },
    root: '/tmp/harness2-p2-gap-test',
    sessionManager: { list: () => [], search: () => [], locate: () => undefined },
    getCurrent: () => null,
    switchSession: () => {},
    observeSteer: () => {},
    mode: () => 'default',
    setMode: () => {},
    reasoning: () => false,
    setReasoning: () => {},
    abortTurn: () => {
      calls.abort += 1;
    },
    runUserTurn: async (_text: string, _onStream?: TurnStreamHandler) => result(`收到：${_text}`),
    finish: async () => {},
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    fork: () => {},
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: 'stub', draftKept: true, message: 'stub' }),
    ...overrides,
  } as unknown as ChatRuntime;
  const out = {
    buffer: '',
    columns: 80,
    rows: 24,
    write(s: string): boolean {
      this.buffer += s;
      return true;
    },
  };
  const exitCodes: number[] = [];
  const gate = createApprovalGate();
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: {},
    gate,
    exit: (code) => exitCodes.push(code),
    ...(opts.initialRenderMode !== undefined ? { initialRenderMode: opts.initialRenderMode } : {}),
  });
  return { h, exitCodes, gate, calls };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

/** 提交一条消息并等 turn 收尾（转录获得 user + assistant 条目 = 会话活着的直接证据） */
async function submitTurn(h: NextChatHarness, text: string): Promise<void> {
  h.feed(text);
  h.feed(ENTER);
  await settle(h);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('G-02 跨模式切换后的运行时状态（P3-D 实体化：真切换不重启）', () => {
  it('/minimal 真切换不触碰运行时状态：草稿保留、转录保留、同进程会话照常出回合', async () => {
    // 规格迁移（P3-D）：原断言锁「降级路径不改状态」（G-02 🟡）；minimal 基座实体化后
    // 升级为锁「真切换不改状态」——切换只换渲染基座，会话/草稿/队列等运行时状态原样。
    const { h } = makeHarness();
    await submitTurn(h, '切换前的任务'); // 会话已有真实回合
    h.feed('未发送草稿'); // 未提交草稿留在 composer
    expect(h.state.draft).toBe('未发送草稿');
    h.submit('/minimal'); // 跨模式切换（G-02 实体化：进程内换基座）
    h.flushUi();
    expect(h.renderMode()).toBe('minimal'); // 状态机真实提交
    const lines = h.logicalLines().join('\n');
    expect(lines).toContain('收到：切换前的任务'); // 转录原样（切换不重建转录/会话）
    expect(h.state.draft).toBe('未发送草稿'); // 草稿原样（命令分发路径不碰运行时状态）
    h.feed('并续写'); // 同一进程同一 composer 继续编辑（minimal 基座下照常出回合）
    h.feed(ENTER);
    await settle(h);
    expect(h.logicalLines().join('\n')).toContain('收到：未发送草稿并续写'); // 会话活着：回合照常执行
    h.dispose();
  });

  it('/fullscreen 同模式幂等请求同样不触碰草稿与转录（空切换 = 无事件 = 无重绘/重建理由）', async () => {
    const { h } = makeHarness();
    h.feed('幂等前的草稿');
    h.submit('/fullscreen');
    h.flushUi();
    expect(h.renderMode()).toBe('fullscreen');
    expect(h.logicalLines().join('\n')).toContain('当前已是 fullscreen 渲染模式');
    expect(h.state.draft).toBe('幂等前的草稿'); // 幂等路径不清草稿
    h.dispose();
  });
});

describe('G-03 分发层模式门控真实行为', () => {
  it('fullscreen 下 /expand 被模式门控拒绝（仅 minimal 提供），且先于「未知命令」兜底', () => {
    const { h } = makeHarness();
    h.submit('/expand');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain('> /expand'); // 命令回显照常
    // 规格迁移（P3-D）：拒绝文案补上游「指向替代」语义（Run /fullscreen to switch this
    // session. 的中文等价——审查 P2-5 遗留）
    expect(all).toContain(
      '当前渲染模式（fullscreen）下不可用：/expand（仅 minimal 模式提供；运行 /minimal 切换本会话）',
    ); // 门控文案（含指向替代）
    expect(all).not.toContain('未知命令'); // 门控先于 core 未知命令兜底触发
    h.dispose();
  });

  it('门控只拦限定清单：fullscreen-only 命令（/theme）在 fullscreen 下不被误拦，正常进命令管线', () => {
    const { h } = makeHarness();
    h.submit('/theme');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).not.toContain('当前渲染模式'); // 门控未触发（available 形态放行）
    expect(all).toContain('主题:'); // /theme 本体执行（next 本地命令表）
    h.dispose();
  });
});

describe('G-12 Alt+V 接线：诚实提示通道（不做假粘贴）', () => {
  it('Alt+V（\\x1bv）命中 keymaps paste.image → 提示通道未接入；不插字符、不清草稿', async () => {
    const { h } = makeHarness();
    h.feed('草');
    h.feed(ALT_V); // legacy Alt+V 编码（ESC 前缀）
    await vi.advanceTimersByTimeAsync(0);
    expect((h.state.indicators ?? []).join(' ')).toContain('图片粘贴通道未接入'); // G-12 🟡 登记可见
    expect((h.state.indicators ?? []).join(' ')).toContain('G-12');
    expect(h.state.draft).toBe('草'); // 和弦被消费：v 不落入草稿、草稿也不被清
    h.dispose();
  });

  it('裸 v 仍按普通字符插入（Alt 修饰不符不命中 paste.image 和弦）', async () => {
    const { h } = makeHarness();
    h.feed('v');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe('v');
    expect((h.state.indicators ?? []).join(' ')).not.toContain('图片粘贴');
    h.dispose();
  });
});

describe('G-16 接线层负向：cancelling 期 Esc 纯 no-op（重发取消路径已移除）', () => {
  it('Ctrl+C 取消后连按 Esc：abort 计数不变（无重发）、无提示、无误开 rewind；收尾正常', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const { h, calls } = makeHarness({
      runUserTurn: async () => {
        await blocker;
        return result('done');
      },
    });
    h.submit('长任务');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(CTRL_C); // 第一次：取消当前 turn → cancelling
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.abort).toBe(1);
    h.feed(ESC); // cancelling 期第一拍
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC); // 第二拍（连打）
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.abort).toBe(1); // G-16 负向：不存在「Esc 重发取消」路径
    expect((h.state.indicators ?? []).join(' ')).not.toContain('Press Ctrl+C'); // 连提示也不给（G-15）
    expect(h.state.overlays.length).toBe(0); // 不误开 rewind picker
    release();
    await settle(h);
    h.dispose();
  });
});

describe('G-19 接线层：Esc 连打穿越回合结束不误开 rewind，宽限过期后双击合法开', () => {
  it('宽限内 idle Esc 全吞（不武装）；越过 deadline 退役后双击正常开 rewind picker', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const { h } = makeHarness({
      runUserTurn: async () => {
        await blocker;
        return result('done');
      },
    });
    h.submit('穿越任务');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(ESC); // 回合中：hint + G-19 宽限 deadline = now+1000
    await vi.advanceTimersByTimeAsync(120);
    expect((h.state.indicators ?? []).join(' ')).toContain('Press Ctrl+C to cancel the turn');
    release();
    await settle(h); // 回合自然结束（宽限仍在走）
    expect(h.isBusy()).toBe(false);
    h.feed(ESC); // 宽限内第一拍：吞（不武装）
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC); // 宽限内第二拍：仍吞
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(0); // 穿越回合结束不误开 rewind
    expect(h.state.draft).toBe('');
    await vi.advanceTimersByTimeAsync(1200); // 越过宽限 deadline
    h.feed(ESC); // 过期退役 + 重新武装（空草稿 + 有历史）
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC); // 双击第二击：合法开火
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(1);
    expect(h.state.overlays[0]?.title).toContain('Rewind');
    h.dispose();
  });
});

describe('候选过滤钳位分支补覆盖（迁移断言「/c 候选收缩」的附带缺口恢复）', () => {
  function typeText(h: NextChatHarness, text: string): void {
    h.feed(text);
    h.flushUi();
  }

  it('过滤收缩到低于当前高亮时 activeIndex 钳到末位（P2-C 候选表加性 /fullscreen 后，/c 不再触发钳位分支——本用例以 he 触发）', () => {
    const { h } = makeHarness();
    typeText(h, '/');
    expect(h.state.candidates?.items.length).toBe(filterCommands('/').length); // 全量候选（含加性 /fullscreen /minimal）
    h.feed(ARROW_DOWN);
    h.feed(ARROW_DOWN);
    h.feed(ARROW_DOWN);
    h.flushUi();
    expect(h.state.candidates?.activeIndex).toBe(3);
    typeText(h, 'he'); // '/he' → ['/help','/theme']：收缩到 2 条 < 高亮 3 → 触发钳位分支
    expect(h.state.candidates?.items).toEqual(['/help', '/theme']);
    expect(h.state.candidates?.activeIndex).toBe(1); // min(3, items.length-1) = 1
    h.dispose();
  });
});
