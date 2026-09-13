// p2c-wiring.test.ts — P2-C 接线棒验收（headless，FakeOut + mock runtime）：
// - G-14：忙时 Esc 提示逐字 + 每用户回合去重（新回合恢复提示）；
// - G-15/G-38：Ctrl+C 取消 → cancelling 期 Esc 全吞、Ctrl+C 升级退出请求（exit code 130）；
// - G-17：800ms 双击窗边界（迟到的第二击重新武装不误清）；Alt+S 暂存/恢复 / 空 stash 如实提示
//   （P1-1 上游三分支：非空=暂存并替换、空=恢复、空+无=提示）；
// - G-18：空草稿+有历史双击 Esc → rewind picker（真实条目）→ Enter 经 /undo 执行；
// - G-20：审批卡 Esc 退完 park 到 scrollback（提示 + 卡片保留 + Tab 回卡）；
// - G-08/G-09/G-10：焦点环 Tab/Space、scrollback 焦点 j/k/g/G 行滚与首尾、Ctrl+K/J 行滚；
// - G-01～G-03：/full /fullscreen 幂等提示、/minimal 降级指引（不落假状态）、无参带参边界。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApprovalGate, createNextChatHarness, type NextChatHarness } from '../../../src/tui/next/next-shell.js';
import type { ChatRuntime, TurnResult, TurnStreamHandler } from '../../../src/chat-setup.js';

const ESC = '\x1b';
const ENTER = '\r';
const TAB = '\t';
const CTRL_C = '\x03';
const CTRL_S = '\x13';
const ALT_S = '\x1bs';
const CTRL_K = '\x0b'; // VT：0x0b → key 'k' + ctrl（parser C0 映射）
const CTRL_J = '\x0a'; // LF → key 'j' + ctrl（G-10 行下滚依赖此）

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
  out: { buffer: string };
  exitCodes: number[];
  gate: ReturnType<typeof createApprovalGate>;
  runtime: ChatRuntime;
  calls: { abort: number };
}

function makeHarness(
  overrides: Partial<ChatRuntime> = {},
  opts: { bootLines?: string[]; initialRenderMode?: 'fullscreen' | 'minimal' } = {},
): Fixture {
  const calls = { abort: 0 };
  let releaseTurn: (() => void) | null = null;
  const runtime = {
    provider: { name: 'mock' },
    root: '/tmp/harness2-p2c-test',
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
    runUserTurn: async (_text: string, _onStream?: TurnStreamHandler) => {
      if (releaseTurn !== null) await new Promise<void>((r) => (releaseTurn = r));
      return result(`收到：${_text}`);
    },
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
    bootLines: opts.bootLines ?? [],
    env: {},
    gate,
    exit: (code) => exitCodes.push(code),
    ...(opts.initialRenderMode !== undefined ? { initialRenderMode: opts.initialRenderMode } : {}),
  });
  return { h, out, exitCodes, gate, runtime, calls };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

/** 提交一条消息并等 turn 收尾（转录获得 user + assistant 条目 = 1 个可 rewind 的用户回合） */
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

describe('G-14 忙时 Esc 提示与每回合去重', () => {
  it('同一用户回合内连按 Esc：提示只出现一次（dedupePerTurn 装配层执行）', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const { h } = makeHarness({
      runUserTurn: async () => {
        await blocker;
        return result('done');
      },
    });
    h.submit('长任务');
    await vi.advanceTimersByTimeAsync(0);
    const ind = (): string => (h.state.indicators ?? []).join(' ');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(ind()).toContain('Press Ctrl+C to cancel the turn');
    await vi.advanceTimersByTimeAsync(2000); // 瞬时提示过期（HINT_CLEAR_MS）
    expect(ind()).not.toContain('Press Ctrl+C');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(ind()).not.toContain('Press Ctrl+C'); // 同回合第二条被去重
    release();
    await settle(h);
    h.dispose();
  });

  it('新用户回合重置去重：再按 Esc 重新提示', async () => {
    const resolvers: Array<() => void> = [];
    const { h } = makeHarness({
      runUserTurn: async () => {
        await new Promise<void>((r) => resolvers.push(r));
        return result('done');
      },
    });
    h.submit('第一回合');
    await vi.advanceTimersByTimeAsync(0);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect((h.state.indicators ?? []).join(' ')).toContain('Press Ctrl+C to cancel the turn');
    resolvers.shift()?.(); // 第一回合收尾
    await settle(h);
    h.submit('第二回合'); // 每回合独立 blocker：turn 仍运行中
    await vi.advanceTimersByTimeAsync(0);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect((h.state.indicators ?? []).join(' ')).toContain('Press Ctrl+C to cancel the turn');
    resolvers.shift()?.(); // 收尾
    await settle(h);
    h.dispose();
  });
});

describe('G-15/G-38 cancelling 态：Esc 全吞、Ctrl+C 升级退出', () => {
  it('Ctrl+C 取消后 Esc 被吞（无提示无 picker）；再次 Ctrl+C 升级为退出请求（exit 130）', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const { h, exitCodes, calls } = makeHarness({
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
    h.feed('草稿'); // cancelling 期草稿仍可编辑（Esc 语义之外不收紧）
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.draft).toBe('草稿'); // G-15：吞掉——不清稿（双击也不会触发）
    expect((h.state.indicators ?? []).join(' ')).not.toContain('Press Ctrl+C'); // 连提示也不给
    h.feed(CTRL_C); // G-38：cancelling 中 Ctrl+C 升级 requestExit
    await vi.advanceTimersByTimeAsync(60);
    release();
    await settle(h);
    expect(exitCodes).toContain(130); // sigint 退出码（turn 收尾后收敛）
    h.dispose();
  });
});

describe('G-17 双击窗口边界与 stash 通道', () => {
  it('超过 800ms 的第二击：重新武装而非开火（草稿保留）；其后的合法双击才清空', async () => {
    const { h } = makeHarness();
    h.feed('abc');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 第一击武装（T1）
    await vi.advanceTimersByTimeAsync(810); // 越过 T1+800：双击窗过期
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 迟到的第二击（T2-T1 > 800）→ 不开火、重新武装
    expect(h.state.draft).toBe('abc');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 重新武装后的第二击（<800ms）→ clear-stash
    expect(h.state.draft).toBe('');
    h.dispose();
  });

  it('Alt+S 同样恢复（备用和弦）；非空草稿再按 = 暂存并替换旧 stash（P1-1 上游三分支）；空+无 stash 如实提示', async () => {
    const { h } = makeHarness();
    h.feed('xyz');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.draft).toBe('');
    h.feed(ALT_S); // Alt+S 备用恢复通道（keymaps 'draft.stash-toggle' 第二和弦）
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe('xyz');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 再次清空 → stash='xyz'
    expect(h.state.draft).toBe('');
    h.feed(CTRL_S); // 恢复
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe('xyz');
    // P1-1 分支②（数据安全）：composer 非空 + 已有 stash → 新 stash 替换旧 stash，
    // 新草稿必须可恢复（不是旧语义的「丢弃 stash」）
    h.feed(CTRL_S); // 非空 → 入槽（stash='xyz'、草稿清空）——为分支②准备「槽已占用」
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe('');
    h.feed('B'); // 草稿='B'，槽内仍是 'xyz'（非空草稿与已有 stash 并存）
    expect(h.state.draft).toBe('B');
    h.feed(CTRL_S); // 非空 + 已有 stash → 替换（上游：第二次 stash 丢弃槽内旧草稿）
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe(''); // 暂存并清空 composer
    h.feed(CTRL_S); // 恢复 → 拿回的是新草稿 'B'（替换不丢弃；旧 'xyz' 不再回来）
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.draft).toBe('B');
    // P1-1 分支③：composer 空且无 stash → 如实提示（不伪造恢复）
    h.feed('\x7f'); // 退格清稿（不经 stash 路径）→ 空 + 无 stash
    expect(h.state.draft).toBe('');
    h.feed(CTRL_S);
    await vi.advanceTimersByTimeAsync(0);
    expect((h.state.indicators ?? []).join(' ')).toContain('无暂存草稿');
    h.dispose();
  });
});

describe('G-18 rewind 最小 picker（接 /undo 能力，无假入口）', () => {
  it('空草稿+有历史双击 Esc → 浮层列出用户回合；Esc 关闭不执行', async () => {
    const { h } = makeHarness();
    await submitTurn(h, '第一个任务');
    await submitTurn(h, '第二个任务');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 第一击武装（空草稿 + 有历史 → G-18 预备）
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 第二击 → open-rewind
    expect(h.state.overlays.length).toBe(1);
    expect(h.state.overlays[0]?.title).toContain('Rewind');
    expect(h.state.overlays[0]?.items.length).toBe(2); // 两个用户回合，新在前
    expect(h.state.overlays[0]?.items[0]).toContain('第二个任务');
    h.feed(ESC); // 关闭（孤立 ESC 需 idle 兜底出键）
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('Enter 选中 → 经 /undo n 执行（命令回显进转录，无快照时如实报错，不伪造成功）', async () => {
    const { h } = makeHarness();
    await submitTurn(h, '第一个任务');
    await submitTurn(h, '第二个任务');
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(1);
    h.feed(ENTER); // 选中第 0 项 = 撤销 1 个回合 → /undo 1
    await settle(h);
    expect(h.state.overlays.length).toBe(0); // picker 已关
    const all = h.logicalLines().join('\n');
    expect(all).toContain('> /undo 1'); // 命令回显 = 真实走了既有命令管线
    h.dispose();
  });

  it('scrollback 窗格武装同样开 rewind（G-18 两窗格皆可），非空草稿在 scrollback 侧被吞', async () => {
    const { h } = makeHarness();
    await submitTurn(h, '唯一任务');
    h.feed(TAB); // 焦点 → scrollback
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(1); // 空草稿：scrollback 侧同样武装/开火
    expect(h.state.overlays[0]?.title).toContain('Rewind');
    h.feed('q'); // q 关闭（rewind 层接管期即时出键）
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });
});

describe('G-20 审批卡 Esc 逐级退完 → park 到 scrollback', () => {
  it('退完 park：卡片保留、审批挂起、焦点落 scrollback、提示文案出现；Tab 回卡可回答', async () => {
    const { h, gate } = makeHarness();
    let answer: string | null = null;
    const p = gate.ask('允许执行 write?').then((a) => {
      answer = a;
    });
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 孤立 ESC 兜底 → Esc 键 → exit-card（park）
    expect(h.state.overlays.length).toBe(1); // 卡片仍显示
    expect(h.pendingApproval()).toBe('允许执行 write?'); // 审批仍挂起
    expect((h.state.indicators ?? []).join(' ')).toContain('审批待答'); // 寄放标记保留
    expect((h.state.indicators ?? []).join(' ')).toContain('已退出阻塞卡片'); // G-20 park 提示
    expect((h.state.indicators ?? []).join(' ')).toContain('scrollback'); // 焦点 park 到滚动区
    h.feed(TAB); // 寄放态 Tab 回卡（优先于焦点环，登记取舍）
    h.feed('2'); // 数字直选落在卡上（不进草稿）
    await p;
    expect(answer).toBe('a');
    expect(h.state.overlays.length).toBe(0);
    h.dispose();
  });

  it('P2-2：寄放态（parked）双击 Esc 整体吞掉——不开 rewind picker、不误清草稿、审批不被回答', async () => {
    const { h, gate } = makeHarness();
    await submitTurn(h, '唯一任务'); // 1 个可 rewind 的用户回合（无历史时 picker 本就开不了，测不到回归）
    const p = gate.ask('允许执行 write?').then(() => undefined);
    h.feed(ESC);
    await vi.advanceTimersByTimeAsync(120); // 卡片接管 → Esc = 寄放（G-20）
    expect(h.pendingApproval()).toBe('允许执行 write?');
    expect((h.state.indicators ?? []).join(' ')).toContain('审批待答');
    h.feed(ESC); // 寄放态第一击（空草稿 + 有历史：无吞掉分支时会在此武装 G-18）
    await vi.advanceTimersByTimeAsync(120);
    h.feed(ESC); // 双击第二击：必须整体吞掉（上游 prompt.rs 758-762）
    await vi.advanceTimersByTimeAsync(120);
    expect(h.state.overlays.length).toBe(1); // 仍只有审批卡——没有 Rewind 浮层
    expect(h.state.overlays[0]?.title).toContain('Approval');
    expect(h.pendingApproval()).toBe('允许执行 write?'); // 审批未被回答/取消
    expect(h.state.draft).toBe(''); // 也未误入清稿/stash 路径
    h.cancelApproval();
    await p;
    h.dispose();
  });
});

describe('G-08/G-09/G-10 焦点环与滚动键位', () => {
  it('scrollback 焦点：k/j 行滚（脱开 follow/回贴底）、g/G 首尾、Ctrl+K/Ctrl+J 行滚（两窗格）', async () => {
    const boot = Array.from({ length: 60 }, (_, i) => `历史行 ${i}`);
    const { h } = makeHarness(undefined, { bootLines: boot });
    h.feed(TAB); // 焦点 → scrollback（贴底 follow）
    h.feed('k'); // nav.up → 上滚 1 物理行（脱开 follow）
    expect(h.state.scrollback.follow).toBe(false);
    const afterK = h.state.scrollback.scrollTopRow;
    expect(afterK).toBeLessThan(h.state.scrollback.maxScrollRow);
    h.feed('j'); // nav.down → 回滚一行（朝贴底方向）
    expect(h.state.scrollback.scrollTopRow).toBeGreaterThan(afterK);
    h.feed('g'); // nav.first → 视口顶
    expect(h.state.scrollback.scrollTopRow).toBe(0);
    h.feed('G'); // nav.last（legacy 大写编码）→ 贴底
    expect(h.state.scrollback.follow).toBe(true);
    h.feed(TAB); // 回输入框
    h.feed(CTRL_K); // prompt 侧行上滚（G-10：两窗格皆可）
    expect(h.state.scrollback.follow).toBe(false);
    h.feed(CTRL_J); // 行下滚
    h.dispose();
  });

  it('simple 下 Space 自 scrollback 回输入框并照常插入空格（G-08）；vim i 未启用（登记）', async () => {
    const { h } = makeHarness();
    h.feed(TAB);
    expect((h.state.indicators ?? []).join(' ')).toContain('scrollback');
    h.feed(' '); // Space → to-prompt（焦点环），空格照常插入草稿
    expect((h.state.indicators ?? []).join(' ')).not.toContain('scrollback');
    expect(h.state.draft).toBe(' ');
    h.dispose();
  });
});

describe('G-01～G-03 渲染模式命令与状态机', () => {
  it('/full 与 /fullscreen 同模式幂等（状态机空切换，无事件）', () => {
    const { h } = makeHarness();
    h.submit('/full');
    h.flushUi();
    expect(h.renderMode()).toBe('fullscreen');
    expect(h.logicalLines().join('\n')).toContain('当前已是 fullscreen 渲染模式');
    h.submit('/fullscreen');
    h.flushUi();
    expect(h.renderMode()).toBe('fullscreen');
    h.dispose();
  });

  it('/minimal 跨模式切换 → G-02 🟡 降级指引（会话保留、重进 REPL），不落假状态', () => {
    const { h } = makeHarness();
    h.submit('/minimal');
    h.flushUi();
    const all = h.logicalLines().join('\n');
    expect(all).toContain('G-02'); // 降级登记可见
    expect(all).toContain('重新进入 REPL'); // 重进 REPL 指引（会话保留）
    expect(all).toContain('未发生切换'); // 如实声明未切换
    expect(h.renderMode()).toBe('fullscreen'); // 状态未变（不做假切换）
    h.dispose();
  });

  it('/minimal 带参数被拒（渲染模式切换无参数）', () => {
    const { h } = makeHarness();
    h.submit('/minimal now');
    h.flushUi();
    expect(h.logicalLines().join('\n')).toContain('error: /minimal 不接受参数');
    expect(h.renderMode()).toBe('fullscreen');
    h.dispose();
  });

  it('初值可注入（config [ui] screen_mode 的解析缝）：fullscreen 语义不受影响', () => {
    const { h } = makeHarness(undefined, { initialRenderMode: 'fullscreen' });
    expect(h.renderMode()).toBe('fullscreen');
    h.dispose();
  });
});
