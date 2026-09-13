// P1-Dev-2 内核下沉第二棒：cli 命令路由测试（回归安全网之外的加性覆盖）。
// 覆盖四条路由不变量：
//   (a) shellOnly 命令（mode/reasoning）走壳侧 ShellCommand 分发表、不走 core——/mode 切换后
//       审批模式真变了（core 对 shellOnly 无执行体，壳表必须拦截）；
//   (b) core 命令经 runCoreCommand 执行（/sessions 输出非空；/context /compact /tasks 与
//       改造前文案逐字一致——compact/tasks 缝未注入时走 core 降级文案）；
//   (c) 未知命令文案不变（含 commands.ts facade 的兼容转发）；
//   (d) 三处入口分发结果一致：legacy 路径（runCoreCommand 直调）与 ink/next 路径
//       （runSharedCommand → runCoreCommand）对同一输入产出逐行一致；next 经 harness 验证
//       同一 core 文案与其 /mode UI 四态 override（登记的收敛差异）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalMode, SessionManager, TurnResult } from '@harness2/core';
import { getContextUsage, HELP_TEXT, parseCoreCommand, runCoreCommand } from '@harness2/core';
import type { ChatRuntime } from '../src/chat-setup.js';
import { handleCommand, parseCommand, type CommandContext } from '../src/commands.js';
import { createShellCommandDispatcher, type ShellCommandContext } from '../src/shell-commands.js';
import { runSharedCommand, type InkCommandIo } from '../src/tui/ink-commands.js';
import { createApprovalGate, createNextChatHarness, type NextChatHarness } from '../src/tui/next/next-shell.js';
import { createTestRuntime, type TestRuntime } from './tui/shell-runtime.js';

// —— 测试替身 ——

/** 记录型壳侧 runtime（只实现 shell 表消费的面：mode/reasoning 状态） */
function makeShellRuntime() {
  const calls = { setMode: [] as string[], setReasoning: [] as boolean[] };
  let mode: string = 'default';
  let reasoning = false;
  const runtime = {
    mode: () => mode,
    setMode: (m: string) => {
      calls.setMode.push(m);
      mode = m;
      return m;
    },
    reasoning: () => reasoning,
    setReasoning: (on: boolean) => {
      calls.setReasoning.push(on);
      reasoning = on;
      return on;
    },
  };
  return { runtime: runtime as unknown as ChatRuntime, calls };
}

/** 壳侧命令 ctx（print 收集到 lines；缝可注入） */
function makeShellCtx(
  runtime: ChatRuntime,
  lines: string[],
  seams: Partial<ShellCommandContext> = {},
): ShellCommandContext {
  return { print: (t) => lines.push(t), runtime, ...seams };
}

/** core 命令 ctx（内存 manager + 状态记录；缝缺省不注入） */
function makeCoreCtx(manager: Partial<SessionManager> = {}) {
  const lines: string[] = [];
  const exits = vi.fn(() => undefined);
  const switches: unknown[] = [];
  const ctx: CommandContext = {
    print: (t) => lines.push(t),
    manager: {
      list: () => [],
      search: () => [],
      ...manager,
    } as unknown as SessionManager,
    cwd: '/tmp/routing-test',
    current: () => null,
    switchSession: (id) => switches.push(id),
    requestExit: () => exits(),
    snapshots: () => undefined,
  };
  return { ctx, lines, exits, switches };
}

/** next harness 用的内存 mock runtime（对齐 test/tui/next/slash-commands.test 的最小面） */
function makeNextRuntime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
  const calls = { setMode: [] as ApprovalMode[], setReasoning: [] as boolean[] };
  let mode: ApprovalMode = 'default';
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [],
      search: () => [],
      locate: () => undefined,
    } as unknown as ChatRuntime['sessionManager'],
    root: '/tmp/harness2-routing-test',
    getCurrent: () => null,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string): Promise<TurnResult> => ({
      stopReason: 'end_turn',
      steps: 1,
      toolCalls: 0,
      durationMs: 1,
      turnId: 't1',
      textOutcome: 'final',
      finalText: `收到：${text}`,
    }),
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => mode,
    setMode: (m) => {
      calls.setMode.push(m);
      mode = m;
      return m;
    },
    reasoning: () => calls.setReasoning[calls.setReasoning.length - 1] ?? false,
    setReasoning: (on) => {
      calls.setReasoning.push(on);
      return on;
    },
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: () => () => undefined,
    finish: async () => undefined,
    ...overrides,
  };
  return runtime;
}

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.cleanup();
});

/** runCoreCommand 返回类型含异步缝（void | Promise<void>）；测试路径全同步，显式 void 标注 */
function execCore(line: string, ctx: CommandContext): void {
  void runCoreCommand(parseCoreCommand(line)!, ctx);
}

// —— (a) shellOnly 命令走壳表，不走 core ——

describe('shellOnly 命令（mode/reasoning）经壳侧分发表', () => {
  it('/mode <别名> → runtime 审批模式真切换，确认文案 = legacy 基准（逐字）', () => {
    const { runtime, calls } = makeShellRuntime();
    const lines: string[] = [];
    const dispatched = createShellCommandDispatcher()('mode', 'plan', makeShellCtx(runtime, lines));
    expect(dispatched).toBe(true);
    expect(calls.setMode).toEqual(['plan']);
    expect(runtime.mode()).toBe('plan');
    expect(lines).toEqual(['已切换模式: plan（plan（只读放行，其余拒绝，等待手动切换））']);
  });

  it('core 对 shellOnly 无执行体（壳表必须拦截，否则降级报错）', () => {
    const { ctx, lines } = makeCoreCtx();
    const parsed = parseCoreCommand('/mode');
    expect(parsed?.id).toBe('mode');
    void runCoreCommand(parsed!, ctx);
    expect(lines).toEqual(['error: 命令 /mode 由界面层实现（shellOnly），core 未提供执行体']);
  });

  it('/mode 无参 = 列出当前模式与可选模式（legacy 基准呈现）；未知别名报错', () => {
    const { runtime } = makeShellRuntime();
    const lines: string[] = [];
    const dispatch = createShellCommandDispatcher();
    expect(dispatch('mode', '', makeShellCtx(runtime, lines))).toBe(true);
    expect(lines).toEqual([
      '当前模式: normal（default：只读自动放行，其余询问）',
      '可选模式:',
      '  normal\tnormal（default：只读自动放行，其余询问）',
      '  allow-approve\tallow-approve（acceptEdits：编辑类自动放行）',
      '  auto\tauto（bypass：全部放行）',
      '  plan\tplan（只读放行，其余拒绝，等待手动切换）',
      '用法: /mode <别名>（如 /mode plan）',
    ]);
    const err: string[] = [];
    expect(dispatch('mode', 'xxx', makeShellCtx(runtime, err))).toBe(true);
    expect(err).toEqual(['error: 未知模式 xxx（可选: normal, allow-approve, auto, plan）']);
  });

  it('/reasoning on/off → 推理开关真切换；off 触发 ink 收起缝；非法参数报错（legacy 基准文案）', () => {
    const { runtime, calls } = makeShellRuntime();
    const dispatch = createShellCommandDispatcher();
    const on: string[] = [];
    expect(dispatch('reasoning', 'on', makeShellCtx(runtime, on))).toBe(true);
    expect(calls.setReasoning).toEqual([true]);
    expect(on).toEqual(['推理展示已开启（灰色斜体折叠输出）。']);

    const collapse = vi.fn(() => undefined);
    const off: string[] = [];
    expect(dispatch('reasoning', 'off', makeShellCtx(runtime, off, { onReasoningOff: collapse }))).toBe(true);
    expect(calls.setReasoning).toEqual([true, false]);
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(off).toEqual(['推理展示已关闭。']);

    const status: string[] = [];
    expect(dispatch('reasoning', '', makeShellCtx(runtime, status))).toBe(true);
    expect(status).toEqual(['推理展示: 关闭（/reasoning on|off）']);

    const err: string[] = [];
    expect(dispatch('reasoning', 'wat', makeShellCtx(runtime, err))).toBe(true);
    expect(err).toEqual(['error: 未知参数 wat（用 on|off，或留空查看当前状态）']);
  });

  it('ink 呈现缝：注入 openModePicker 后无参 /mode 打开浮层（带参仍走基准实现）', () => {
    const { runtime } = makeShellRuntime();
    const dispatch = createShellCommandDispatcher();
    const openPicker = vi.fn(() => undefined);
    const lines: string[] = [];
    expect(dispatch('mode', '', makeShellCtx(runtime, lines, { openModePicker: openPicker }))).toBe(true);
    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
    expect(dispatch('mode', 'auto', makeShellCtx(runtime, lines, { openModePicker: openPicker }))).toBe(true);
    expect(openPicker).toHaveBeenCalledTimes(1); // 带参不走浮层
    expect(lines).toEqual(['已切换模式: auto（auto（bypass：全部放行））']);
  });

  it('未注册命令 id 分发返回 false（调用方回落 core）', () => {
    const { runtime } = makeShellRuntime();
    expect(createShellCommandDispatcher()('sessions', '', makeShellCtx(runtime, []))).toBe(false);
  });
});

// —— (b) core 命令经 runCoreCommand 执行 ——

describe('core 命令经 runCoreCommand 执行', () => {
  it('/sessions 输出非空（列表逐行打印）', () => {
    const { ctx, lines } = makeCoreCtx({
      list: () => [{ id: 's1', mtimeMs: 1700000000000, messageCount: 3, firstUserText: '你好' }],
    } as Partial<SessionManager>);
    execCore('/sessions', ctx);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('s1');
    expect(lines[0]).toContain('3 条');
  });

  it('/quit 别名解析为 exit → requestExit；/new → switchSession(null)', () => {
    const { ctx, exits, switches } = makeCoreCtx();
    execCore('/quit', ctx);
    expect(exits).toHaveBeenCalledTimes(1);
    execCore('/new', ctx);
    expect(switches).toEqual([null]);
  });

  it('/context：缝注入取 runtime 口径；无活动会话 = 占位文案（与改造前逐字）', () => {
    const usage = vi.fn(() => 0.42);
    const { ctx, lines } = makeCoreCtx();
    void runCoreCommand(parseCoreCommand('/context')!, { ...ctx, contextUsage: usage });
    expect(lines).toEqual(['上下文占用: 42%']);
    const { ctx: ctx2, lines: lines2 } = makeCoreCtx();
    execCore('/context', ctx2);
    expect(lines2).toEqual(['上下文占用: —（无活动会话）']);
  });

  it('/compact 缝未注入 = 自动压缩提示（core 降级文案与改造前逐字一致）', () => {
    const { ctx, lines } = makeCoreCtx();
    execCore('/compact', ctx);
    expect(lines).toEqual(['压缩将在下一次 turn 开始时自动检查并执行；若已超阈值会自动触发。']);
  });

  it('/tasks 缝未注入 = cron 只读引导文案（core 降级文案与改造前逐字一致）', () => {
    const { ctx, lines } = makeCoreCtx();
    execCore('/tasks', ctx);
    expect(lines).toEqual(['任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。']);
  });

  it('/undo 无活动会话 → 共享错误文案', () => {
    const { ctx, lines } = makeCoreCtx();
    execCore('/undo', ctx);
    expect(lines).toEqual(['error: 无活动会话']);
  });
});

// —— (c) 未知命令文案不变 ——

describe('未知命令文案不变', () => {
  it('runCoreCommand：未知命令 = 旧文案逐字（含 /help 提示）', () => {
    const { ctx, lines } = makeCoreCtx();
    execCore('/foo', ctx);
    expect(lines).toEqual(['未知命令 /foo（/help 查看命令列表）']);
  });

  it('commands.ts facade（handleCommand）转发一致：未知文案与 /? 别名', () => {
    const { ctx, lines } = makeCoreCtx();
    handleCommand({ name: '/foo', rest: '' }, ctx);
    expect(lines).toEqual(['未知命令 /foo（/help 查看命令列表）']);
    handleCommand({ name: '/?', rest: '' }, ctx);
    expect(lines[1]).toBe(HELP_TEXT);
  });

  it('parseCommand facade 形状：name 含 / 前缀、别名原样、大小写归一', () => {
    expect(parseCommand('/MODE plan')).toEqual({ name: '/mode', rest: 'plan' });
    expect(parseCommand('/?')).toEqual({ name: '/?', rest: '' });
    expect(parseCommand('hello')).toBeNull();
  });
});

// —— (d) 三处入口分发结果一致 ——

describe('三处入口分发结果一致（同一输入同输出）', () => {
  it('legacy 路径（runCoreCommand 直调）与 ink/next 路径（runSharedCommand）逐行一致', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const legacyLines: string[] = [];
    const legacyCtx: CommandContext = {
      print: (t) => legacyLines.push(t),
      manager: tr.runtime.sessionManager,
      cwd: tr.runtime.root,
      current: () => tr.runtime.getCurrent(),
      switchSession: (id) => tr.runtime.switchSession(id, { print: (t) => legacyLines.push(t) }),
      requestExit: () => undefined,
      snapshots: () => undefined,
      fork: () => undefined,
      contextUsage: () => {
        const c = tr.runtime.getCurrent();
        return c === null ? undefined : getContextUsage(c.dir);
      },
    };
    const inkLines: string[] = [];
    const io: InkCommandIo = {
      print: (t) => inkLines.push(t),
      reproject: () => undefined,
      requestExit: () => undefined,
    };
    for (const line of ['/help', '/context', '/sessions', '/compact', '/tasks']) {
      legacyLines.length = 0;
      inkLines.length = 0;
      const parsed = parseCoreCommand(line)!;
      void runCoreCommand(parsed, legacyCtx);
      const fromLegacy = [...legacyLines];
      runSharedCommand({ name: parsed.raw, rest: parsed.rest }, tr.runtime, io);
      expect(inkLines).toEqual(fromLegacy);
      expect(fromLegacy.length).toBeGreaterThan(0);
    }
  });

  describe('next harness（HARNESS2_RENDERER=next 路径）', () => {
    let h: NextChatHarness;
    beforeEach(() => {
      vi.useFakeTimers();
      h = createNextChatHarness(makeNextRuntime(), {
        out: {
          columns: 100,
          rows: 30,
          write(s: string): number {
            return s.length;
          },
        },
        bootLines: [],
        env: {},
        gate: createApprovalGate(),
        exit: () => undefined,
      });
    });
    afterEach(() => {
      h.dispose();
      vi.useRealTimers();
    });

    it('/context /tasks /help → 与 core 同一份输出（文案逐字）', () => {
      h.submit('/context');
      h.flushUi();
      expect(h.logicalLines()).toContain('上下文占用: —（无活动会话）');
      h.submit('/tasks');
      h.flushUi();
      expect(h.logicalLines()).toContain('任务列表请使用 `harness2 cron list` 查看（REPL 只读展示将在后续版本提供）。');
      h.submit('/help');
      h.flushUi();
      // HELP_TEXT 为多行文本：next 转录以单条 system 行承载，逻辑行含各分段
      const after = h.logicalLines();
      expect(after.some((l) => l.includes('命令：'))).toBe(true);
      expect(after.some((l) => l.includes('/undo') && l.includes('撤销最近 n 个用户 turn'))).toBe(true);
    });

    it('/reasoning on → 壳表同一份实现（legacy 基准文案逐字）', () => {
      h.submit('/reasoning on');
      h.flushUi();
      expect(h.logicalLines()).toContain('推理展示已开启（灰色斜体折叠输出）。');
      h.submit('/reasoning');
      h.flushUi();
      expect(h.logicalLines()).toContain('推理展示: 开启（/reasoning on|off）');
    });

    it('/mode → 本壳 UI 四态 override（登记的收敛差异：非 core 审批模式语义）', () => {
      h.submit('/mode');
      h.flushUi();
      expect(h.state.indicators).toContain('plan');
      h.submit('/mode auto');
      h.flushUi();
      expect(h.state.indicators).toContain('auto');
      h.submit('/mode normal');
      h.flushUi();
      expect(h.state.indicators).not.toContain('auto');
    });

    it('未知命令 → core 共享文案', () => {
      h.submit('/foo');
      h.flushUi();
      expect(h.logicalLines()).toContain('未知命令 /foo（/help 查看命令列表）');
    });
  });
});

// —— (e) 渲染模式命令（P2-C：minimal/fullscreen/full 经壳表 + RenderModeControl 缝）——

describe('渲染模式命令（P2-C）经壳侧分发表', () => {
  it('未注入 renderMode 缝（legacy/ink 现状）→ 如实声明未接入，不静默吞掉', () => {
    const { runtime } = makeShellRuntime();
    const lines: string[] = [];
    const dispatch = createShellCommandDispatcher();
    expect(dispatch('minimal', '', makeShellCtx(runtime, lines))).toBe(true);
    expect(lines).toEqual(['error: 当前界面未接入渲染模式切换（/minimal 仅 next 渲染层提供）']);
  });

  it('同模式请求 → 幂等提示（状态机空切换）；带参被拒', () => {
    const { runtime } = makeShellRuntime();
    const lines: string[] = [];
    const dispatch = createShellCommandDispatcher();
    const current = (): 'fullscreen' => 'fullscreen';
    dispatch(
      'fullscreen',
      '',
      makeShellCtx(runtime, lines, { renderMode: { current, requestSwitch: () => 'same-mode' } }),
    );
    expect(lines).toEqual(['当前已是 fullscreen 渲染模式']);
    lines.length = 0;
    dispatch(
      'fullscreen',
      'now',
      makeShellCtx(runtime, lines, { renderMode: { current, requestSwitch: () => 'same-mode' } }),
    );
    expect(lines).toEqual(['error: /fullscreen 不接受参数（渲染模式切换无参数）']);
  });

  it('/full 别名解析为 fullscreen（core findCoreCommand 别名 → 壳表 id 命中）', () => {
    const { runtime } = makeShellRuntime();
    const lines: string[] = [];
    const dispatch = createShellCommandDispatcher();
    const parsed = parseCoreCommand('/full');
    expect(parsed?.id).toBe('fullscreen');
    dispatch(
      parsed!.id!,
      '',
      makeShellCtx(runtime, lines, { renderMode: { current: () => 'fullscreen', requestSwitch: () => 'same-mode' } }),
    );
    expect(lines).toEqual(['当前已是 fullscreen 渲染模式']);
  });

  it('跨模式请求 → degraded-unavailable 降级指引（G-02 🟡：重进 REPL、会话保留、未发生切换）', () => {
    const { runtime } = makeShellRuntime();
    const lines: string[] = [];
    const dispatch = createShellCommandDispatcher();
    const outcome = dispatch(
      'minimal',
      '',
      makeShellCtx(runtime, lines, {
        renderMode: { current: () => 'fullscreen', requestSwitch: () => 'degraded-unavailable' },
      }),
    );
    expect(outcome).toBe(true);
    expect(lines.join('\n')).toContain('G-02');
    expect(lines.join('\n')).toContain('重新进入 REPL');
    expect(lines.join('\n')).toContain('未发生切换');
  });
});
