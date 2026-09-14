// G-26/27/28/30 四条语义状态机单测（输入注入式；逐条对齐 refs-grok-build.md 与上游
// 03-keyboard-shortcuts.md「Follow-ups mid-turn」节）。边界用例覆盖任务要求：
// 空队列 Enter、send-now 无活动回合（空闲 no-op）、卡片等待中 Enter 直送不入队。
import { describe, expect, it } from 'vitest';
import {
  SEND_NOW_CHORDS,
  matchesSendNow,
  reduceFollowUpInput,
  resolveFollowUpInput,
  sendNowLabel,
  type FollowUpContext,
} from '../../../src/tui/queue/wiring-contract.js';
import { createQueueState, enqueueFollowUp, type QueueState } from '../../../src/tui/queue/queue.js';
import { noModifiers } from '../../../src/input/types.js';
import type { KeyEvent } from '../../../src/input/types.js';

/** 键事件构造（legacy：可打印字符为字符本体；kitty：键名 + 修饰位） */
function key(key: string, ctrl = false): KeyEvent {
  return { type: 'key', key, modifiers: { ...noModifiers(), ctrl }, consumed: false };
}

function ctx(overrides: Partial<FollowUpContext> = {}): FollowUpContext {
  return { phase: 'idle', draft: '', steerSeq: 1, ...overrides };
}

function queueWith(...texts: string[]): QueueState {
  let state = createQueueState();
  for (const text of texts) state = enqueueFollowUp(state, text).state;
  return state;
}

describe('G-26 回合运行中普通 Enter（入队不打断 / steer 实时转向）', () => {
  it('queue 模式（缺省）：running + Enter + 草稿非空 → 入队、无取消语义、草稿清空', () => {
    const state = createQueueState(); // behavior = queue
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: '接着做 B', turnId: 't1' }), { type: 'enter' });
    expect(r.effect.kind).toBe('enqueue');
    if (r.effect.kind !== 'enqueue') return;
    expect(r.effect.entry.text).toBe('接着做 B');
    expect(r.effect.message).toContain('不打断');
    expect(r.state.entries.map((e) => e.text)).toEqual(['接着做 B']);
    expect(r.draftCleared).toBe(true);
  });

  it('steer 模式：同一 Enter 仍入队展示 + 构造 SteerRequest（expectedTurnId = 当前 turn）', () => {
    const state = createQueueState('steer');
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: '停一下，先跑测试', turnId: 'turn-9' }), {
      type: 'enter',
    });
    expect(r.effect.kind).toBe('steer');
    if (r.effect.kind !== 'steer') return;
    expect(r.effect.request).toMatchObject({ expectedTurnId: 'turn-9', text: '停一下，先跑测试' });
    expect(r.effect.entry.text).toBe('停一下，先跑测试'); // 上游：still shows the row in the queue
    expect(r.state.entries).toHaveLength(1);
    expect(r.draftCleared).toBe(true);
  });

  it('steer 模式 turnId 未知（首个流事件未到）→ steer-unknown 草稿保留，不入队不猜 id', () => {
    const state = createQueueState('steer');
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: 'x', turnId: undefined }), { type: 'enter' });
    expect(r.effect).toMatchObject({ kind: 'steer-unknown', draftKept: true });
    expect(r.state.entries).toHaveLength(0);
    expect(r.draftCleared).toBe(false);
  });

  it('两模式共同边界：草稿空白 → 无操作（不入队、不清草稿）', () => {
    for (const behavior of ['queue', 'steer'] as const) {
      const r = reduceFollowUpInput(createQueueState(behavior), ctx({ phase: 'running', draft: '  ' }), {
        type: 'enter',
      });
      expect(r.effect.kind).toBe('none');
      expect(r.draftCleared).toBe(false);
    }
  });
});

describe('G-27 空 composer 再 Enter 发送队首一条', () => {
  it('running + 空 composer + 队列非空 → send-head（严格队首；队列余量保序）', () => {
    const state = queueWith('first', 'second', 'third');
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: '' }), { type: 'enter' });
    expect(r.effect.kind).toBe('send-head');
    if (r.effect.kind !== 'send-head') return;
    expect(r.effect.entry.text).toBe('first');
    expect(r.state.entries.map((e) => e.text)).toEqual(['second', 'third']); // FIFO 余序
    expect(r.draftCleared).toBe(false); // 草稿本来就空
  });

  it('边界：空队列 + 空 composer Enter → 无操作（不造假发送）', () => {
    const r = reduceFollowUpInput(createQueueState(), ctx({ phase: 'running', draft: '' }), { type: 'enter' });
    expect(r.effect).toMatchObject({ kind: 'none' });
  });

  it('边界：running + 空 composer + 草稿空白字符同理按空处理 → 空队列无操作', () => {
    const r = reduceFollowUpInput(createQueueState(), ctx({ phase: 'running', draft: ' \n ' }), { type: 'enter' });
    expect(r.effect.kind).toBe('none');
  });
});

describe('G-28 send-now 和弦 = cancel-and-send（三终端族 + 三目标 + no-op 边界）', () => {
  it('和弦表：default 主 Ctrl+Enter 备 Ctrl+I；apple-terminal 主 Ctrl+O；vscode-family 仅 Ctrl+L', () => {
    expect(sendNowLabel('default')).toBe('Ctrl+Enter');
    expect(sendNowLabel('apple-terminal')).toBe('Ctrl+O');
    expect(sendNowLabel('vscode-family')).toBe('Ctrl+L');
    expect(SEND_NOW_CHORDS['vscode-family']).toHaveLength(1); // 上游：无备用、Ctrl+I 不用
  });

  it('和弦判定按终端族取表（kitty Ctrl+Enter / legacy 可达的 Ctrl+O、Ctrl+L）', () => {
    expect(matchesSendNow(key('enter', true), 'default')).toBe(true);
    expect(matchesSendNow(key('i', true), 'default')).toBe(true);
    expect(matchesSendNow(key('o', true), 'apple-terminal')).toBe(true);
    expect(matchesSendNow(key('l', true), 'vscode-family')).toBe(true);
    // 家族差异是硬边界：vscode 族 Ctrl+I 不命中；default 族 Ctrl+L 不命中
    expect(matchesSendNow(key('i', true), 'vscode-family')).toBe(false);
    expect(matchesSendNow(key('l', true), 'default')).toBe(false);
    expect(matchesSendNow(key('enter'), 'default')).toBe(false); // 无 Ctrl 的普通 Enter 不串
  });

  it('running + 非空草稿 + send-now → 取消当前回合并立即发送草稿（队列不动）', () => {
    const state = queueWith('queued-1');
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: '插队这条' }), { type: 'send-now' });
    expect(r.effect).toMatchObject({ kind: 'send-now-text', text: '插队这条', cancelTurn: true });
    expect(r.state.entries.map((e) => e.text)).toEqual(['queued-1']); // 余量照常（上游：rest of the queue keeps running）
    expect(r.draftCleared).toBe(true);
  });

  it('running + 空草稿 + 队列非空 → 取消并立即发送队首（余量保序）', () => {
    const state = queueWith('head', 'tail');
    const r = reduceFollowUpInput(state, ctx({ phase: 'running', draft: '' }), { type: 'send-now' });
    expect(r.effect).toMatchObject({ kind: 'send-now-head', cancelTurn: true });
    if (r.effect.kind !== 'send-now-head') return;
    expect(r.effect.entry.text).toBe('head');
    expect(r.state.entries.map((e) => e.text)).toEqual(['tail']);
  });

  it('面板打开（队列焦点）+ send-now → 发送高亮行（非队首也可；该行移出、余序保持）', () => {
    const state = queueWith('a', 'b', 'c');
    const r = reduceFollowUpInput(
      state,
      ctx({ phase: 'running', draft: '顺手打的字', panel: { open: true, focus: 'queue', activeIndex: 1 } }),
      { type: 'send-now' },
    );
    expect(r.effect).toMatchObject({ kind: 'send-now-selected', cancelTurn: true });
    if (r.effect.kind !== 'send-now-selected') return;
    expect(r.effect.entry.text).toBe('b'); // 高亮行优先于草稿/队首
    expect(r.state.entries.map((e) => e.text)).toEqual(['a', 'c']);
    expect(r.draftCleared).toBe(false); // 草稿不是本次发送目标，保留
  });

  it('边界：空闲（无活动回合）+ send-now → 无操作（G-28：idle no-op；Ctrl+Enter 不提交新回合）', () => {
    const r = reduceFollowUpInput(queueWith('x'), ctx({ phase: 'idle', draft: '草稿还在' }), { type: 'send-now' });
    expect(r.effect).toMatchObject({ kind: 'none' });
    expect(r.state.entries.map((e) => e.text)).toEqual(['x']);
  });

  it('边界：running + 空草稿 + 空队列 + send-now → 无操作（G-28：empty composer with nothing queued）', () => {
    const r = reduceFollowUpInput(createQueueState(), ctx({ phase: 'running', draft: '' }), { type: 'send-now' });
    expect(r.effect).toMatchObject({ kind: 'none' });
  });
});

describe('G-30 阻塞等待中 Enter 直送（不入队）', () => {
  it('blocked + Enter + 非空草稿 → direct-send（取消阻塞回合、立即执行下一条；队列状态零变化）', () => {
    const state = queueWith('queued-1');
    const r = reduceFollowUpInput(state, ctx({ phase: 'blocked', draft: '直接回答这条' }), { type: 'enter' });
    expect(r.effect).toMatchObject({ kind: 'direct-send', text: '直接回答这条', cancelTurn: true });
    expect(r.state).toBe(state); // 直送不入队：队列原引用不变
    expect(r.draftCleared).toBe(true);
  });

  it('边界：卡片等待中 + Enter + 空草稿 → 无操作（无可直送文本）', () => {
    const r = reduceFollowUpInput(queueWith('x'), ctx({ phase: 'blocked', draft: '' }), { type: 'enter' });
    expect(r.effect).toMatchObject({ kind: 'none' });
  });

  it('blocked + send-now + 非空草稿 → 同为取消+发送（cancel-and-send 语义一致）', () => {
    const r = reduceFollowUpInput(createQueueState(), ctx({ phase: 'blocked', draft: 'now' }), { type: 'send-now' });
    expect(r.effect).toMatchObject({ kind: 'send-now-text', text: 'now', cancelTurn: true });
  });
});

describe('附带路由与面板内语义（状态机完整接管 Enter 家族）', () => {
  it('idle + Enter + 非空草稿 → submit-normal（既有基线普通发送，不入队）', () => {
    const r = reduceFollowUpInput(createQueueState(), ctx({ phase: 'idle', draft: 'hello' }), { type: 'enter' });
    expect(r.effect).toMatchObject({ kind: 'submit-normal', text: 'hello' });
    expect(r.draftCleared).toBe(true);
  });

  it('面板内 Enter → 立即发送高亮行（cancel-and-send 同路径）；面板内 e → 编辑（行移出、文本落 composer 由装配层执行）', () => {
    const state = queueWith('a', 'b');
    const panel = { open: true, focus: 'queue' as const, activeIndex: 0 };
    const send = reduceFollowUpInput(state, ctx({ phase: 'running', panel }), { type: 'panel-send-selected' });
    expect(send.effect).toMatchObject({ kind: 'send-now-selected', entry: { text: 'a' }, cancelTurn: true });
    const edit = reduceFollowUpInput(state, ctx({ phase: 'running', panel }), { type: 'panel-edit-selected' });
    expect(edit.effect).toMatchObject({ kind: 'edit-selected', entry: { text: 'a' } });
    expect(edit.state.entries.map((e) => e.text)).toEqual(['b']);
  });

  it('resolveFollowUpInput：面板接管期 Enter/e 折叠为面板语义、其余键不吞；空闲期 Ctrl+I 归 send-now', () => {
    const panel = { open: true, focus: 'queue' as const, activeIndex: 0 };
    expect(resolveFollowUpInput(key('enter'), { family: 'default', panel, queueCount: 2 })).toEqual({
      type: 'panel-send-selected',
    });
    expect(resolveFollowUpInput(key('e'), { family: 'default', panel, queueCount: 2 })).toEqual({
      type: 'panel-edit-selected',
    });
    expect(resolveFollowUpInput(key('j'), { family: 'default', panel, queueCount: 2 })).toBeNull(); // 面板导航归 panel 层
    expect(resolveFollowUpInput(key('i', true), { family: 'default', queueCount: 0 })).toEqual({ type: 'send-now' });
    expect(resolveFollowUpInput(key('enter'), { family: 'default', queueCount: 0 })).toEqual({ type: 'enter' });
    expect(resolveFollowUpInput(key('x'), { family: 'default', queueCount: 0 })).toBeNull();
  });

  it('纯函数性：同输入恒同输出（reduction 不改入参 state）', () => {
    const state = queueWith('a');
    const c = ctx({ phase: 'running', draft: 'z' });
    const r1 = reduceFollowUpInput(state, c, { type: 'enter' });
    const r2 = reduceFollowUpInput(state, c, { type: 'enter' });
    expect(r1).toEqual(r2);
    expect(state.entries.map((e) => e.text)).toEqual(['a']); // 入参未被修改
  });
});
