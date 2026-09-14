// G-46/G-47/G-48 调度与降级单测（纯状态机、时钟注入）：
// 防抖 300/紧急 100、运行中不取消（dirty 重跑）、火并作一次与搭车 trigger、
// 超时占位文案、失败日志恒发、state 失败立刻画 / refresh 失败保输出 / 三连败才画错误。
import { describe, expect, it } from 'vitest';
import {
  CONSECUTIVE_FAILURES_BEFORE_ERROR,
  createStatusLineGovernorState,
  reduceStatusLineGovernor,
  runsScript,
  type StatusLineGovernorState,
} from '../../../src/tui/status-line/governor.js';
import {
  STATUS_LINE_DEBOUNCE_MS,
  STATUS_LINE_URGENT_DEBOUNCE_MS,
  STATUS_LINE_TIMEOUT_TEXT,
} from '../../../src/tui/status-line/config.js';
import { defaultStatusLineSettings, type ResolvedStatusLineSettings } from '../../../src/tui/status-line/config.js';

function commandSettings(overrides: Partial<ResolvedStatusLineSettings> = {}): ResolvedStatusLineSettings {
  return {
    ...defaultStatusLineSettings(),
    type: 'command',
    command: '~/.harness2/statusline.sh',
    ...overrides,
  };
}

function governor(settings = commandSettings()): StatusLineGovernorState {
  return createStatusLineGovernorState(settings);
}

/** 帮手：走一遍「state 变化 → 防抖到期 → 出发 run」并返回出发归约 */
function startRunAt(state: StatusLineGovernorState, changedAt: number, firedAt: number, urgent = false) {
  const changed = reduceStatusLineGovernor(state, { type: 'state-changed', urgent, nowMs: changedAt });
  expect(changed.directives.some((d) => d.kind === 'schedule-debounce')).toBe(true);
  const elapsed = reduceStatusLineGovernor(changed.state, { type: 'debounce-elapsed', nowMs: firedAt });
  expect(elapsed.directives).toContainEqual({ kind: 'start-run', trigger: 'state' });
  expect(elapsed.state.runActive).toBe(true);
  return elapsed;
}

describe('G-46 防抖与事件驱动（300ms / 紧急 100ms）', () => {
  it('disabled / builtin 行永不跑脚本：state 变化零指令（refresh_interval under builtin schedules nothing）', () => {
    for (const type of ['disabled', 'builtin'] as const) {
      const g = governor({ ...defaultStatusLineSettings(), type });
      expect(runsScript(g)).toBe(false);
      const r = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 });
      expect(r.directives).toEqual([]);
    }
  });

  it('普通变化排 300ms 防抖；紧急变化（resize/新快照/切 agent）排 100ms', () => {
    const g = governor();
    const normal = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 1000 });
    expect(normal.directives).toEqual([{ kind: 'schedule-debounce', fireAtMs: 1000 + STATUS_LINE_DEBOUNCE_MS }]);
    const urgent = reduceStatusLineGovernor(g, { type: 'state-changed', urgent: true, nowMs: 1000 });
    expect(urgent.directives).toEqual([{ kind: 'schedule-debounce', fireAtMs: 1000 + STATUS_LINE_URGENT_DEBOUNCE_MS }]);
  });

  it('连续变化取更早的防抖到期点（min 合并，不推迟已有截止）', () => {
    let g = governor();
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state; // deadline 300
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 50 }).state; // 350 候选 → 仍 300
    expect(g.debounceDeadline).toBe(300);
    g = reduceStatusLineGovernor(g, { type: 'state-changed', urgent: true, nowMs: 100 }).state; // 200 更早
    expect(g.debounceDeadline).toBe(200);
  });

  it('运行中的脚本永不取消：run 期间到达的变化记 dirty，run 结束后按 urgent 优先重排', () => {
    let g = governor();
    g = startRunAt(g, 0, 300).state;
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 400 }).state; // 运行中 → dirty
    expect(g.dirty).toBe(true);
    g = reduceStatusLineGovernor(g, { type: 'state-changed', urgent: true, nowMs: 450 }).state;
    expect(g.dirtyUrgent).toBe(true);
    const done = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: true, lines: ['out'] },
      nowMs: 500,
    });
    expect(done.paint).toEqual({ kind: 'output', lines: ['out'] });
    expect(done.directives).toEqual([{ kind: 'schedule-debounce', fireAtMs: 500 + STATUS_LINE_URGENT_DEBOUNCE_MS }]);
    expect(done.state.runActive).toBe(false);
    expect(done.state.dirty).toBe(false);
  });
});

describe('G-46 refresh_interval（火的合并、搭车、cadence）', () => {
  it('空闲期火到期 → 立即出发 refresh_interval run 并续算下一火（cadence 按到期点）', () => {
    let g = governor(commandSettings({ refreshIntervalSec: 60 }));
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state;
    g = reduceStatusLineGovernor(g, { type: 'debounce-elapsed', nowMs: 300 }).state; // state run 完成
    g = reduceStatusLineGovernor(g, { type: 'run-finished', outcome: { ok: true, lines: ['a'] }, nowMs: 400 }).state;
    const fire = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 60_000 });
    expect(fire.directives).toContainEqual({ kind: 'schedule-timer', fireAtMs: 120_000 });
    expect(fire.directives).toContainEqual({ kind: 'start-run', trigger: 'refresh_interval' });
    expect(fire.state.runActive).toBe(true);
    expect(fire.state.runTrigger).toBe('refresh_interval');
  });

  it('run 期间火到期 → 欠一次（owed ≤ 1，不 stack），脚本让位后下一 run 携带 refresh_interval', () => {
    let g = governor(commandSettings({ refreshIntervalSec: 60 }));
    g = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 0 }).state; // 立即出发一次 refresh run
    expect(g.runTrigger).toBe('refresh_interval');
    // 运行中第二次火到期：只欠一次
    const during = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 10 });
    expect(during.state.owedTimerFires).toBe(1);
    expect(during.directives.some((d) => d.kind === 'start-run')).toBe(false); // 不 burst
    // run 完成：无 dirty → 立即出发下一 run（trigger=refresh_interval）
    const done = reduceStatusLineGovernor(during.state, {
      type: 'run-finished',
      outcome: { ok: true, lines: [] },
      nowMs: 20,
    });
    expect(done.directives).toContainEqual({ kind: 'start-run', trigger: 'refresh_interval' });
    expect(done.state.runActive).toBe(true); // 指令即执行
    expect(done.state.owedTimerFires).toBe(0);
  });

  it('state 变化落在欠火的防抖前 → 搭车：该 run 的 trigger = refresh_interval（G-46 明文）', () => {
    let g = governor(commandSettings({ refreshIntervalSec: 60 }));
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state; // 防抖中（state 路由）
    g = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 100 }).state; // 火到期但防抖占位 → 欠
    expect(g.owedTimerFires).toBe(1);
    const elapsed = reduceStatusLineGovernor(g, { type: 'debounce-elapsed', nowMs: 300 });
    expect(elapsed.directives).toContainEqual({ kind: 'start-run', trigger: 'refresh_interval' }); // 搭车
    expect(elapsed.state.runTrigger).toBe('refresh_interval');
  });
});

describe('G-46 自举（started）：接线缺口的初始定时器来源', () => {
  it('command 型 + refresh_interval：started 排一次 schedule-timer（nowMs + interval），不发 start-run', () => {
    const r = reduceStatusLineGovernor(governor(commandSettings({ refreshIntervalSec: 1 })), {
      type: 'started',
      nowMs: 500,
    });
    expect(r.directives).toEqual([{ kind: 'schedule-timer', fireAtMs: 1500 }]);
    expect(r.state.timerDeadline).toBe(1500);
    expect(r.state.runActive).toBe(false); // 首绘仍归 state 变化的事件驱动路径（G-47/G-48 分派不变）
    expect(r.paint).toBeNull();
  });

  it('无 refresh_interval / builtin / disabled：started 零指令（不造无关定时器）', () => {
    const cases = [
      commandSettings(), // command 但未配 refresh_interval
      { ...defaultStatusLineSettings(), type: 'builtin' as const },
      { ...defaultStatusLineSettings(), type: 'disabled' as const },
    ];
    for (const settings of cases) {
      const r = reduceStatusLineGovernor(governor(settings), { type: 'started', nowMs: 0 });
      expect(r.directives).toEqual([]);
      expect(r.state.timerDeadline).toBeNull();
    }
  });

  it('重入不重排：已有定时器时 started 幂等（零指令）', () => {
    const armed = reduceStatusLineGovernor(governor(commandSettings({ refreshIntervalSec: 5 })), {
      type: 'started',
      nowMs: 0,
    }).state;
    const again = reduceStatusLineGovernor(armed, { type: 'started', nowMs: 100 });
    expect(again.directives).toEqual([]);
    expect(again.state.timerDeadline).toBe(5000);
  });

  it('全链：started → 首绘 state run → 定时器 1s 节奏自动续排，3s 内 ≥3 次运行（假时钟）', () => {
    let g = reduceStatusLineGovernor(governor(commandSettings({ refreshIntervalSec: 1 })), {
      type: 'started',
      nowMs: 0,
    }).state;
    let runs = 0;
    // 首绘：state 变化 → 300ms 防抖 → 出发（trigger=state）
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state;
    g = reduceStatusLineGovernor(g, { type: 'debounce-elapsed', nowMs: 300 }).state;
    runs += 1;
    g = reduceStatusLineGovernor(g, { type: 'run-finished', outcome: { ok: true, lines: ['x'] }, nowMs: 350 }).state;
    // 每 1s 到期的火续排下一火并出发 refresh run（此前无 started 则永远收不到火）
    for (let t = 1000; t <= 3000; t += 1000) {
      const fire = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: t });
      expect(fire.directives).toContainEqual({ kind: 'start-run', trigger: 'refresh_interval' });
      expect(fire.directives).toContainEqual({ kind: 'schedule-timer', fireAtMs: t + 1000 }); // cadence 续排
      g = fire.state;
      runs += 1;
      g = reduceStatusLineGovernor(g, {
        type: 'run-finished',
        outcome: { ok: true, lines: ['x'] },
        nowMs: t + 10,
      }).state;
    }
    expect(runs).toBeGreaterThanOrEqual(3); // 首绘 state + 两次 refresh（1s 节奏）
  });
});

describe('G-47 成功输出与超时', () => {
  it('成功零输出 → paint output []（收行；绝不回退 builtin——上游明文）', () => {
    let g = governor();
    g = startRunAt(g, 0, 300).state;
    const done = reduceStatusLineGovernor(g, { type: 'run-finished', outcome: { ok: true, lines: [] }, nowMs: 400 });
    expect(done.paint).toEqual({ kind: 'output', lines: [] });
    expect(done.state.lastOutput).toEqual([]);
    expect(done.state.consecutiveFailures).toBe(0);
  });

  it('超时 = 失败：state 触发立刻画 [status line: timed out]（G-47 逐字文案）', () => {
    let g = governor();
    g = startRunAt(g, 0, 300).state;
    const done = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: false, timedOut: true, error: 'status line 脚本超时（10s）' },
      nowMs: 10_300,
    });
    expect(done.paint).toEqual({ kind: 'error', message: STATUS_LINE_TIMEOUT_TEXT });
    expect(STATUS_LINE_TIMEOUT_TEXT).toBe('[status line: timed out]');
  });
});

describe('G-48 失败降级（日志恒发；state 立刻画 / refresh 保输出 / 三连败画错误）', () => {
  it('每一次失败都产生 log-failure 指令（装配层写 unified 日志）', () => {
    let g = governor();
    g = startRunAt(g, 0, 300).state;
    const done = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: false, timedOut: false, error: 'exit code 1' },
      nowMs: 400,
    });
    expect(done.directives).toContainEqual({ kind: 'log-failure', message: 'exit code 1', timedOut: false });
  });

  it('state 触发失败立刻画错误（上游：reports its failure at once, as ever）；成功清零连败', () => {
    let g = governor();
    g = startRunAt(g, 0, 300).state;
    const fail1 = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: false, error: 'e1' },
      nowMs: 400,
    });
    expect(fail1.paint).toEqual({ kind: 'error', message: 'e1' });
    expect(fail1.state.consecutiveFailures).toBe(1);
    // 成功一次 → 计数清零
    const changed = reduceStatusLineGovernor(fail1.state, { type: 'state-changed', nowMs: 500 });
    const done = reduceStatusLineGovernor(changed.state, { type: 'debounce-elapsed', nowMs: 800 });
    const ok = reduceStatusLineGovernor(done.state, {
      type: 'run-finished',
      outcome: { ok: true, lines: ['fresh'] },
      nowMs: 900,
    });
    expect(ok.state.consecutiveFailures).toBe(0);
    expect(ok.state.lastOutput).toEqual(['fresh']);
  });

  it('refresh 触发失败保住上一次输出（keep the last output），不画错误、不覆盖 lastOutput', () => {
    let g = governor(commandSettings({ refreshIntervalSec: 60 }));
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state;
    g = reduceStatusLineGovernor(g, { type: 'debounce-elapsed', nowMs: 300 }).state;
    g = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: true, lines: ['last-good'] },
      nowMs: 400,
    }).state;
    // 定时 run 失败
    g = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 60_000 }).state;
    const fail = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: false, error: 'flaky' },
      nowMs: 60_100,
    });
    expect(fail.paint).toEqual({ kind: 'output', lines: ['last-good'] }); // 保输出
    expect(fail.state.lastOutput).toEqual(['last-good']);
    expect(fail.state.consecutiveFailures).toBe(1);
  });

  it('refresh 失败但从未成功回答（nothing to keep）→ 立刻画错误', () => {
    let g = governor(commandSettings({ refreshIntervalSec: 60 }));
    g = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: 0 }).state; // 首次即 refresh run
    const fail = reduceStatusLineGovernor(g, {
      type: 'run-finished',
      outcome: { ok: false, error: 'boom' },
      nowMs: 50,
    });
    expect(g.lastOutput).toBeNull();
    expect(fail.paint).toEqual({ kind: 'error', message: 'boom' });
  });

  it(`连续三次失败才在状态行画错误（G-48；阈值 = ${CONSECUTIVE_FAILURES_BEFORE_ERROR}）：前两次保输出、第三次画`, () => {
    let g = governor(commandSettings({ refreshIntervalSec: 1 }));
    // 首次 state run 成功，建立 lastOutput
    g = reduceStatusLineGovernor(g, { type: 'state-changed', nowMs: 0 }).state;
    g = reduceStatusLineGovernor(g, { type: 'debounce-elapsed', nowMs: 300 }).state;
    g = reduceStatusLineGovernor(g, { type: 'run-finished', outcome: { ok: true, lines: ['good'] }, nowMs: 400 }).state;
    // 三次连续 refresh 失败
    let now = 1000;
    for (let i = 1; i <= 3; i += 1) {
      g = reduceStatusLineGovernor(g, { type: 'timer-fire', nowMs: now }).state;
      const fail = reduceStatusLineGovernor(g, {
        type: 'run-finished',
        outcome: { ok: false, error: `err-${i}` },
        nowMs: now + 10,
      });
      if (i < 3) {
        expect(fail.paint).toEqual({ kind: 'output', lines: ['good'] }); // 保输出
        // 失败后无 dirty 但可能欠火/直接出发：下一轮 timer-fire 前状态仍可推进
      } else {
        expect(fail.paint).toEqual({ kind: 'error', message: 'err-3' }); // 三连败 → 画错误
      }
      expect(fail.state.consecutiveFailures).toBe(i);
      g = fail.state;
      // 失败 run 结束后可能直接出发了欠火的下一 run（owed 路径）；先把它收尾再续时间线
      if (g.runActive) {
        g = reduceStatusLineGovernor(g, {
          type: 'run-finished',
          outcome: { ok: true, lines: ['good'] },
          nowMs: now + 20,
        }).state;
      }
      now += 1000;
    }
  });

  it('阈值常量钉死为 3（G-48「连续三次失败」）', () => {
    expect(CONSECUTIVE_FAILURES_BEFORE_ERROR).toBe(3);
  });
});
