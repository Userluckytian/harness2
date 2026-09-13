// esc-machine 单测：G-14～G-20 每一行规格至少一个用例（含边界与负向断言）。
// 时间注入：所有用例用显式 now 数值驱动；跨按键测试用 drive 帮手把 lastEscAt /
// rewindGraceUntil 副作用回写进下一拍输入（同时验证副作用回写契约）。
import { describe, expect, it } from 'vitest';
import {
  DOUBLE_ESC_MS,
  ESC_CANCEL_HINT_TEXT,
  ESC_CANCEL_REWIND_GRACE,
  ESC_PARK_HINT_TEXT,
  reduceEsc,
  withinDoubleEscWindow,
  type EscDecision,
  type EscMachineInput,
  type EscSideEffects,
} from '../../../src/tui/input/esc-machine.js';

/** 输入构造（缺省 = 空闲、无卡片、无草稿、无历史、无武装、无宽限） */
function input(overrides: Partial<EscMachineInput> = {}): EscMachineInput {
  return {
    turnState: 'idle',
    draftLength: 0,
    cardDepth: 0,
    historyCount: 0,
    now: 10_000,
    lastEscAt: null,
    rewindGraceUntil: 0,
    ...overrides,
  };
}

/** 跨按键驱动：每次按键后把 lastEscAt / rewindGraceUntil 副作用回写（装配层职责的模拟） */
function drive(start: EscMachineInput, presses: ReadonlyArray<Partial<EscMachineInput>>): EscDecision[] {
  const decisions: EscDecision[] = [];
  let state = start;
  for (const patch of presses) {
    state = { ...state, ...patch };
    const decision = reduceEsc(state);
    decisions.push(decision);
    const se: EscSideEffects = decision.sideEffects;
    state = {
      ...state,
      lastEscAt: se.lastEscAt !== undefined ? se.lastEscAt : state.lastEscAt,
      rewindGraceUntil: se.rewindGraceUntil !== undefined ? se.rewindGraceUntil : state.rewindGraceUntil,
    };
  }
  return decisions;
}

const SIDE_EFFECT_KEYS = new Set([
  'hintCancel',
  'exitCard',
  'clearStash',
  'openRewind',
  'rewindGraceUntil',
  'lastEscAt',
]);

describe('常量与窗口判定', () => {
  it('DOUBLE_ESC_MS=800、ESC_CANCEL_REWIND_GRACE=1000（宽限必须长于双击窗口：吸收整个双击手势）', () => {
    expect(DOUBLE_ESC_MS).toBe(800);
    expect(ESC_CANCEL_REWIND_GRACE).toBe(1000);
    expect(ESC_CANCEL_REWIND_GRACE).toBeGreaterThan(DOUBLE_ESC_MS);
  });

  it('双击窗口：now - arm < 800 开火；arm+800 整点已过期（上游 expired(): now >= arm+ttl）', () => {
    expect(withinDoubleEscWindow(1000, 1799)).toBe(true);
    expect(withinDoubleEscWindow(1000, 1800)).toBe(false); // 整点过期
    expect(withinDoubleEscWindow(1000, 1801)).toBe(false);
  });
});

describe('G-14 回合运行中：Esc 永不取消，提示 Press Ctrl+C to cancel the turn', () => {
  it('running + Esc → hint-cancel；文案逐字；标记每回合去重；草稿原样保留（无任何草稿变更副作用）', () => {
    const d = reduceEsc(input({ turnState: 'running', draftLength: 42 }));
    expect(d.action).toBe('hint-cancel');
    expect(d.sideEffects.hintCancel).toEqual({
      text: ESC_CANCEL_HINT_TEXT,
      dedupePerTurn: true,
    });
    expect(ESC_CANCEL_HINT_TEXT).toBe('Press Ctrl+C to cancel the turn'); // 逐字锁死
    expect(d.sideEffects.clearStash).toBeUndefined(); // 草稿保留：没有清空/stash 副作用
    expect(d.sideEffects.exitCard).toBeUndefined();
    expect(d.sideEffects.openRewind).toBeUndefined();
  });

  it('running + Esc 同时推进 G-19 宽限并废弃任何 idle 残留武装（回合中不开火）', () => {
    const d = reduceEsc(input({ turnState: 'running', now: 5_000, lastEscAt: 4_500 }));
    expect(d.sideEffects.rewindGraceUntil).toBe(6_000); // now + 1000
    expect(d.sideEffects.lastEscAt).toBeNull();
  });

  it('mid-turn 连按：每次都产出提示（dedupePerTurn=true），去重执行归装配层', () => {
    const decisions = drive(input({ turnState: 'running' }), [{ now: 100 }, { now: 300 }, { now: 700 }]);
    expect(decisions.map((d) => d.action)).toEqual(['hint-cancel', 'hint-cancel', 'hint-cancel']);
    for (const d of decisions) expect(d.sideEffects.hintCancel?.dedupePerTurn).toBe(true);
  });

  it('running 优先级低于卡片（有卡片时走 G-20 退出，不给取消提示）', () => {
    const d = reduceEsc(input({ turnState: 'running', cardDepth: 1 }));
    expect(d.action).toBe('exit-card');
    expect(d.sideEffects.hintCancel).toBeUndefined();
  });
});

describe('G-15 正在取消中：Esc 无声吞掉（连提示也不给）', () => {
  it('cancelling + Esc → swallow；无提示、无任何用户可见副作用', () => {
    const d = reduceEsc(input({ turnState: 'cancelling', draftLength: 7, historyCount: 3 }));
    expect(d.action).toBe('swallow');
    expect(d.sideEffects.hintCancel).toBeUndefined();
    expect(d.sideEffects.clearStash).toBeUndefined();
    expect(d.sideEffects.openRewind).toBeUndefined();
    expect(d.sideEffects.exitCard).toBeUndefined();
  });

  it('cancelling 双击同样吞掉（不存在「取消中 Esc 加速」语义）', () => {
    const decisions = drive(input({ turnState: 'cancelling' }), [{ now: 100 }, { now: 400 }]);
    expect(decisions.map((d) => d.action)).toEqual(['swallow', 'swallow']);
  });

  it('（装配层登记）Ctrl+C 在取消中升级为退出：状态机不产取消/退出事件，升级归 Ctrl+C 通道', () => {
    // G-15 后半句是对 Ctrl+C 的要求（G-38），Esc 机器范围内可验证的只有：Esc 侧不发任何
    // 取消/退出动作——即 cancelling 的输出永远不含操作类副作用（见 G-16 负向断言）。
    const d = reduceEsc(input({ turnState: 'cancelling' }));
    expect(Object.keys(d.sideEffects).every((k) => k === 'rewindGraceUntil' || k === 'lastEscAt')).toBe(true);
  });
});

describe('G-16 负向断言：取消中不存在「Esc 重发取消」路径', () => {
  it('cancelling 下任意输入组合的副作用键都在白名单内（无取消重发/提示/开卡/清稿/rewind）', () => {
    const variants: EscMachineInput[] = [
      input({ turnState: 'cancelling' }),
      input({ turnState: 'cancelling', draftLength: 99, historyCount: 5 }),
      input({ turnState: 'cancelling', lastEscAt: 9_900, now: 10_000 }), // 双击窗口内
      input({ turnState: 'cancelling', cardDepth: 0, pane: 'scrollback', draftLength: 3 }),
      input({ turnState: 'cancelling', rewindGraceUntil: 0, lastEscAt: null }),
    ];
    for (const v of variants) {
      const d = reduceEsc(v);
      // 动作必须是 no-op 类（G-15 吞掉；派工文本的 action=none 口径即「无操作」，见报告差异表）
      expect(d.action).toBe('swallow');
      for (const key of Object.keys(d.sideEffects)) {
        expect(SIDE_EFFECT_KEYS.has(key)).toBe(true);
      }
      expect(d.sideEffects.hintCancel).toBeUndefined(); // 连提示也不给（上游仅 running 给提示）
      // 取消重试事件在类型层就不存在：EscSideEffects 无 cancelRetry 字段（编译期保证）。
    }
  });
});

describe('G-17 空闲 + 草稿非空：800ms 内双击 Esc 清空草稿并 stash', () => {
  it('第一击：静默武装（action=none，lastEscAt=now）', () => {
    const d = reduceEsc(input({ draftLength: 12, now: 1_000 }));
    expect(d.action).toBe('none');
    expect(d.sideEffects.lastEscAt).toBe(1_000);
    expect(d.sideEffects.clearStash).toBeUndefined();
  });

  it('第二击 +799ms：开火 clear-stash（草稿入 stash、绝不进历史），武装清除', () => {
    const [first, second] = drive(input({ draftLength: 12 }), [{ now: 1_000 }, { now: 1_799 }]);
    expect(first!.action).toBe('none'); // 第一击武装
    expect(second!.action).toBe('clear-stash');
    expect(second!.sideEffects.clearStash).toEqual({ stashedDraftLength: 12 });
    expect(second!.sideEffects.lastEscAt).toBeNull();
  });

  it('800ms 整点边界：arm+800 已过期 → 不开火（派工文本 799/800 口径与上游相反而按上游，见报告）', () => {
    const [first, second] = drive(input({ draftLength: 12 }), [{ now: 1_000 }, { now: 1_800 }]);
    expect(first!.action).toBe('none'); // 第一击武装（lastEscAt=1000）
    expect(second!.action).toBe('none'); // +800 整点：expired → 不开火，重新武装
    expect(second!.sideEffects.clearStash).toBeUndefined();
    expect(second!.sideEffects.lastEscAt).toBe(1_800);
    // 重新武装后的下一对按键可正常开火（过期只是丢掉旧武装，不是锁死）
    const [third] = drive(input({ draftLength: 12, lastEscAt: 1_800 }), [{ now: 1_800 + DOUBLE_ESC_MS - 1 }]);
    expect(third!.action).toBe('clear-stash');
  });

  it('清草稿限 prompt 窗格（G-18 括注）：scrollback + 非空草稿 = 吞掉，不清也不 stash', () => {
    const [first, second] = drive(input({ draftLength: 12, pane: 'scrollback', now: 1_000 }), [
      { now: 1_100 },
      { now: 1_300 },
    ]);
    expect(first!.action).toBe('swallow'); // 连武装都不发生
    expect(second!.action).toBe('swallow');
    expect(second!.sideEffects.clearStash).toBeUndefined();
  });
});

describe('G-18 空闲 + 草稿为空 + 有历史：双击 Esc 开 rewind picker', () => {
  it('三条件齐备（idle + 空草稿 + historyCount>0）：双击 → open-rewind（prompt 侧）', () => {
    const [first, second] = drive(input({ historyCount: 4, now: 1_000 }), [{ now: 1_050 }, { now: 1_200 }]);
    expect(first!.action).toBe('none'); // 静默武装第一击
    expect(second!.action).toBe('open-rewind');
    expect(second!.sideEffects.openRewind).toEqual({ armedFrom: 'prompt' });
  });

  it('条件一缺（非空闲）：running 下双击 Esc 绝不开 rewind（永不取消/不弹窗）', () => {
    const decisions = drive(input({ turnState: 'running', historyCount: 4 }), [{ now: 100 }, { now: 300 }]);
    expect(decisions.map((d) => d.action)).toEqual(['hint-cancel', 'hint-cancel']);
  });

  it('条件二缺（草稿非空且在 prompt）：走 G-17 清草稿，不开 rewind', () => {
    const [first, second] = drive(input({ draftLength: 5, historyCount: 4, now: 1_000 }), [
      { now: 1_050 },
      { now: 1_150 },
    ]);
    expect(first!.action).toBe('none'); // 武装
    expect(second!.action).toBe('clear-stash');
    expect(second!.sideEffects.openRewind).toBeUndefined();
  });

  it('条件三缺（无历史）：无可武装，双击全吞掉，不开 rewind（上游 "No undoable prompts" 保护）', () => {
    const decisions = drive(input({ historyCount: 0 }), [{ now: 100 }, { now: 200 }]);
    expect(decisions.map((d) => d.action)).toEqual(['swallow', 'swallow']);
    expect(decisions[1]!.sideEffects.openRewind).toBeUndefined();
  });

  it('两窗格皆可武装（G-18）：scrollback 侧空草稿双击同样开 rewind', () => {
    const [first, second] = drive(input({ historyCount: 2, pane: 'scrollback', now: 1_000 }), [
      { now: 1_050 },
      { now: 1_400 },
    ]);
    expect(first!.action).toBe('none'); // 武装
    expect(second!.action).toBe('open-rewind');
    expect(second!.sideEffects.openRewind).toEqual({ armedFrom: 'scrollback' });
  });
});

describe('G-19 mid-turn Esc 宽限期：deadline 推移与穿越保护', () => {
  it('回合中每次 Esc 把 deadline 推到 now+1000；连打持续顺延（推移非置定）', () => {
    const decisions = drive(input({ turnState: 'running' }), [{ now: 0 }, { now: 800 }, { now: 1_500 }]);
    expect(decisions[0]!.sideEffects.rewindGraceUntil).toBe(1_000);
    expect(decisions[1]!.sideEffects.rewindGraceUntil).toBe(1_800); // 800+1000（顺延）
    expect(decisions[2]!.sideEffects.rewindGraceUntil).toBe(2_500); // 1500+1000
  });

  it('cancelling 中 Esc 也顺延宽限（长取消期连打的保护；内部状态不可见，不违反无声吞掉）', () => {
    const d = reduceEsc(input({ turnState: 'cancelling', now: 5_000 }));
    expect(d.sideEffects.rewindGraceUntil).toBe(6_000);
  });

  it('Esc 连打穿越回合结束（取消或自然完成）：宽限内的 idle Esc 被吞且不武装', () => {
    const decisions = drive(input({ turnState: 'running', historyCount: 3 }), [
      { now: 0 }, // running：deadline 1000
      { now: 900 }, // running：deadline 1900
      { now: 950, turnState: 'idle' }, // 回合自然结束；此拍 Esc 落在宽限内（950 < 1900）→ 吞
      { now: 1_000 }, // 宽限内：吞掉、不武装（连打的一部分）
      { now: 1_500 }, // 仍在宽限内（< 1900）：吞掉
    ]);
    expect(decisions.map((d) => d.action)).toEqual([
      'hint-cancel',
      'hint-cancel',
      'swallow', // 回合结束后第一拍就在宽限内：被压制，绝不武装 rewind
      'swallow',
      'swallow',
    ]);
    // 宽限内的三拍都不产生副作用回写（lastEscAt 保持 null、deadline 不动）
    expect(decisions[2]!.sideEffects).toEqual({});
    expect(decisions[3]!.sideEffects).toEqual({});
    expect(decisions[4]!.sideEffects).toEqual({});
  });

  it('宽限过期后的 Esc 恢复正常语义：过期 deadline 退役（回写 0）并武装', () => {
    const [after] = drive(
      input({ historyCount: 3, rewindGraceUntil: 1_900, lastEscAt: null }),
      [{ now: 1_950 }], // 宽限已过期 50ms
    );
    expect(after!.action).toBe('none'); // 重新武装
    expect(after!.sideEffects.rewindGraceUntil).toBe(0); // check-and-retire
    expect(after!.sideEffects.lastEscAt).toBe(1_950);
  });

  it('端到端穿越场景：宽限内的连打全吞；宽限过期后的双击是合法 rewind（不是连打误开）', () => {
    const decisions = drive(input({ turnState: 'running', historyCount: 3 }), [
      { now: 0 }, // running → deadline 1000
      { now: 950, turnState: 'idle' }, // 回合结束；950 < 1000 宽限内 → 吞
      { now: 1_200 }, // 宽限（1000）已过期：退役（回写 0）+ 武装
      { now: 1_400 }, // 双击第二击（delta 200 < 800）：合法开火
    ]);
    expect(decisions.map((d) => d.action)).toEqual(['hint-cancel', 'swallow', 'none', 'open-rewind']);
    expect(decisions[2]!.sideEffects.rewindGraceUntil).toBe(0); // check-and-retire
  });
});

describe('G-20 阻塞卡片打开时：Esc 逐级退出，退到最后 park 到 scrollback', () => {
  it('cardDepth=2：退一层到 1，不 park', () => {
    const d = reduceEsc(input({ cardDepth: 2 }));
    expect(d.action).toBe('exit-card');
    expect(d.sideEffects.exitCard).toEqual({ remainingDepth: 1, parkedToScrollback: false });
    expect(d.sideEffects.lastEscAt).toBeNull(); // 卡片按键废弃 idle 武装
  });

  it('cardDepth=1：退到最后，park 到 scrollback（提示文案常量备好，装配层出）', () => {
    const d = reduceEsc(input({ cardDepth: 1 }));
    expect(d.action).toBe('exit-card');
    expect(d.sideEffects.exitCard).toEqual({ remainingDepth: 0, parkedToScrollback: true });
    expect(ESC_PARK_HINT_TEXT.length).toBeGreaterThan(0);
  });

  it('逐级序列：3 → 2 → 1 → park，每按一次退一层', () => {
    let depth = 3;
    const actions: string[] = [];
    let parked = false;
    while (depth > 0) {
      const d = reduceEsc(input({ cardDepth: depth, turnState: 'running' }));
      actions.push(d.action);
      parked = d.sideEffects.exitCard?.parkedToScrollback ?? false;
      depth = d.sideEffects.exitCard?.remainingDepth ?? 0;
    }
    expect(actions).toEqual(['exit-card', 'exit-card', 'exit-card']);
    expect(parked).toBe(true);
  });

  it('卡片优先于一切回合状态：cancelling + cardDepth 仍走逐级退出', () => {
    const d = reduceEsc(input({ cardDepth: 1, turnState: 'cancelling' }));
    expect(d.action).toBe('exit-card');
    expect(d.sideEffects.exitCard?.parkedToScrollback).toBe(true);
  });
});
