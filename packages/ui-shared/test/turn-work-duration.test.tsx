// @vitest-environment jsdom
// Z-97（T4b）轮次耗时行「工作中 {duration} / 已工作 {duration} / 已停止」——
// 派生层（projectChatItems 的 workStartedAt/workDurationMs/workRunning 推导）+
// 渲染层（WorkIndicator memo 叶子自持 1s tick）+ ChatItemView turn-header 挂载。
// 计时一律 vitest fake timers（Date.now 与 setInterval 同源于假钟）。
// tick 纪律用例（e）：外层组件渲染计数断言 —— tick 一次只重渲染 WorkIndicator 叶子。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { projectChatItems, emptyLive, formatWorkDuration } from '../src/renderer/chat-model.js';
import type { ActiveEvent, TurnEndInfo } from '../src/renderer/chat-model.js';
import { WorkIndicator, WORK_TICK_MS } from '../src/renderer/conversation/turn-work.js';
import { ChatItemView } from '../src/renderer/components/ChatView.js';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const iso = (ms: number): string => new Date(ms).toISOString();

function ev(seq: number, type: string, payload: Record<string, unknown>, ts = iso(0)): ActiveEvent {
  return { v: 1, seq, ts, type, payload, active: true };
}

/** 一轮 user/message 事件（turnId 默认 t1；ts=null 注入旧数据形态 —— 显式 undefined 会被默认参吞掉） */
function turnEvents(turnId = 't1', ts: string | null = iso(0)): ActiveEvent[] {
  return [
    { v: 1, seq: 1, ts: ts === null ? '' : ts, type: 'user/message', payload: { turnId, text: 'q' }, active: true },
  ];
}

// ═════════════════════════ 派生层：projectChatItems ═════════════════════════

describe('Z-97（T4b）派生层：turn-header 的耗时字段推导', () => {
  it('running（末轮无终态）→ workRunning=true + workStartedAt=首事件 ts；不现算 duration', () => {
    const items = projectChatItems(turnEvents('t1', iso(5_000)), emptyLive(), {}, { running: true });
    const header = items.find((i) => i.kind === 'turn-header');
    expect(header?.workRunning).toBe(true);
    expect(header?.workStartedAt).toBe(5_000);
    // tick 纪律：now 不进派生层 —— running 中不产 workDurationMs（叶子自持现算）
    expect(header?.workDurationMs).toBeUndefined();
  });

  it('真终态 + turnEndedAt → workDurationMs 锁定为 endedAt − startedAt', () => {
    const ends: Record<string, TurnEndInfo> = { t1: { stopReason: 'end_turn' } };
    const items = projectChatItems(turnEvents('t1', iso(1_000)), emptyLive(), ends, {
      turnEndedAt: { t1: 66_000 },
      running: false,
    });
    const header = items.find((i) => i.kind === 'turn-header');
    expect(header?.workDurationMs).toBe(65_000);
    expect(header?.workRunning).toBeUndefined();
    expect(header?.stopReason).toBe('end_turn');
    expect(header?.synthetic).toBeUndefined();
  });

  it('合成终态（T4a synthetic）→ synthetic + interrupted 透传到 turn-header', () => {
    const ends: Record<string, TurnEndInfo> = { t1: { stopReason: 'interrupted', synthetic: true } };
    const items = projectChatItems(turnEvents('t1', iso(0)), emptyLive(), ends, {
      turnEndedAt: { t1: 30_000 },
    });
    const header = items.find((i) => i.kind === 'turn-header');
    expect(header?.synthetic).toBe(true);
    expect(header?.stopReason).toBe('interrupted');
    expect(header?.workDurationMs).toBe(30_000);
  });

  it('旧数据无 ts → workStartedAt/workDurationMs 全缺省（不显示假值，红线⑩）', () => {
    const ends: Record<string, TurnEndInfo> = { t1: { stopReason: 'end_turn' } };
    const items = projectChatItems(turnEvents('t1', null), emptyLive(), ends, {
      turnEndedAt: { t1: 66_000 },
    });
    const header = items.find((i) => i.kind === 'turn-header');
    expect(header?.workStartedAt).toBeUndefined();
    expect(header?.workDurationMs).toBeUndefined();
  });

  it('有终态但 turnEndedAt 缺失（旧 store 数据）→ 不锁耗时', () => {
    const ends: Record<string, TurnEndInfo> = { t1: { stopReason: 'end_turn' } };
    const items = projectChatItems(turnEvents('t1', iso(0)), emptyLive(), ends, {});
    expect(items.find((i) => i.kind === 'turn-header')?.workDurationMs).toBeUndefined();
  });

  it('多轮：running 只标末轮头；先前轮即便会话 running 也按终态锁定', () => {
    const events = [
      ev(1, 'user/message', { turnId: 't1', text: 'q1' }, iso(0)),
      ev(2, 'assistant/message', { turnId: 't1', text: 'a1' }, iso(2_000)),
      ev(3, 'user/message', { turnId: 't2', text: 'q2' }, iso(10_000)),
    ];
    const ends: Record<string, TurnEndInfo> = { t1: { stopReason: 'end_turn' } };
    const items = projectChatItems(events, emptyLive(), ends, {
      turnEndedAt: { t1: 8_000 },
      running: true,
    });
    const headers = items.filter((i) => i.kind === 'turn-header');
    expect(headers).toHaveLength(2);
    expect(headers[0]?.turnId).toBe('t1');
    expect(headers[0]?.workRunning).toBeUndefined();
    expect(headers[0]?.workDurationMs).toBe(8_000);
    expect(headers[1]?.turnId).toBe('t2');
    expect(headers[1]?.workRunning).toBe(true);
    expect(headers[1]?.workStartedAt).toBe(10_000);
  });

  it('不传 work 上下文（旧调用面）→ 行为与 T4a 前一致（全字段缺省）', () => {
    const items = projectChatItems(turnEvents(), emptyLive(), {});
    const header = items.find((i) => i.kind === 'turn-header');
    expect(header).toBeDefined();
    expect(header?.workStartedAt).toBe(0); // ts 合法照常解析（派生层不因缺上下文丢事实）
    expect(header?.workRunning).toBeUndefined();
    expect(header?.workDurationMs).toBeUndefined();
  });
});

// ═════════════════════════ 渲染层：WorkIndicator（a-d） ═════════════════════════

describe('Z-97（T4b）WorkIndicator 三态文案与 tick', () => {
  it('a) running 起点 ts=0：推进 5s →「工作中 5 秒」；推进到 65s →「工作中 1 分 5 秒」', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { container } = render(<WorkIndicator startedAt={0} running />);
    expect(container.querySelector('.turn-work')?.textContent).toBe('工作中 不到 1 秒');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector('.turn-work')?.textContent).toBe('工作中 5 秒');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(container.querySelector('.turn-work')?.textContent).toBe('工作中 1 分 5 秒');
    expect(container.querySelector('.turn-work')?.getAttribute('role')).toBe('status');
  });

  it('b) 完成态锁「已工作 1 分 5 秒」：不随 tick 漂移（无 running 不起表）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * 60_000);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { container } = render(<WorkIndicator startedAt={0} durationMs={65_000} stopReason="end_turn" />);
    expect(container.querySelector('.turn-work')?.textContent).toBe('已工作 1 分 5 秒');
    // tick 纪律：终态不起表（禁止每会话常驻定时器）
    expect(setIntervalSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(container.querySelector('.turn-work')?.textContent).toBe('已工作 1 分 5 秒');
    setIntervalSpy.mockRestore();
  });

  it('c) T4a 合成终态 →「已停止（无响应超时）」；真停（cancelled）→「已停止」两态区分', () => {
    const synthetic = render(<WorkIndicator startedAt={0} durationMs={30_000} synthetic stopReason="interrupted" />);
    expect(synthetic.container.querySelector('.turn-work')?.textContent).toBe('已停止（无响应超时）');
    synthetic.unmount();

    const realStop = render(<WorkIndicator startedAt={0} durationMs={12_000} stopReason="cancelled" />);
    expect(realStop.container.querySelector('.turn-work')?.textContent).toBe('已停止');
  });

  it('d) 旧数据无 ts/无终态时刻 → 不渲染耗时行（无 undefined/NaN 字样）', () => {
    const { container } = render(<WorkIndicator stopReason="end_turn" />);
    expect(container.querySelector('.turn-work')).toBeNull();
    expect(container.textContent).not.toMatch(/undefined|NaN/);

    const bare = render(<WorkIndicator />);
    expect(bare.container.textContent).toBe('');
  });

  it('e) tick 纪律：1s tick 只重渲染 WorkIndicator 叶子（memo + 内部 state，父组件计数不动）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      // 父层每次渲染都传等价原语 props（memo 浅比较生效的前提）
      return <WorkIndicator startedAt={0} running />;
    }
    const { container } = render(<Parent />);
    expect(parentRenders).toBe(1);

    act(() => {
      vi.advanceTimersByTime(WORK_TICK_MS);
    });
    // 叶子文本已走秒（tick 生效），父层没有因时间流逝重渲染（now 不进父链）
    expect(container.querySelector('.turn-work')?.textContent).toBe('工作中 1 秒');
    expect(parentRenders).toBe(1);
  });

  it('running → 终态切换：interval 清理（卸载即停表）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { rerender, container } = render(<WorkIndicator startedAt={0} running />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector('.turn-work')?.textContent).toBe('工作中 5 秒');

    rerender(<WorkIndicator startedAt={0} durationMs={5_000} stopReason="end_turn" />);
    expect(container.querySelector('.turn-work')?.textContent).toBe('已工作 5 秒');
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});

// ═════════════════════════ 挂载：ChatItemView turn-header ═════════════════════════

function harness(): { store: AppStore; controller: ReturnType<typeof createController> } {
  const store = new AppStore();
  const controller = createController(store, {} as never);
  return { store, controller };
}

describe('Z-97（T4b）turn-header 挂载（ChatItemView）', () => {
  it('running item → turn-header 内渲染「工作中」行（role=status + tabular-nums 类）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const { store, controller } = harness();
    render(
      <ChatItemView
        item={{ kind: 'turn-header', turnId: 't1', workStartedAt: 0, workRunning: true }}
        store={store}
        controller={controller}
      />,
    );
    const work = document.querySelector('.turn-header .turn-work');
    expect(work?.textContent).toBe('工作中 3 秒');
    expect(work?.getAttribute('role')).toBe('status');
  });

  it('字段全缺省（旧数据/既有结构）→ turn-header 保持零内容（G15 纯留白断言不破）', () => {
    const { store, controller } = harness();
    render(<ChatItemView item={{ kind: 'turn-header', turnId: 't7' }} store={store} controller={controller} />);
    const header = document.querySelector('.turn-header');
    expect(header).not.toBeNull();
    expect(header?.textContent).toBe('');
    expect(header?.getAttribute('data-turn-id')).toBe('t7');
  });
});

// ═════════════════════════ store 端到端（chatItems 注入 work 上下文） ═════════════════════════

describe('Z-97（T4b）store.chatItems 端到端：起点/终点全链', () => {
  it('user/message(ts=T0) → turn-end(T0+65s)：turn-header 锁「65 秒耗时」且 running 标记消失', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new AppStore();
    store.applyFrame({
      type: 'event',
      sessionId: 'a',
      event: { v: 1, seq: 1, ts: iso(1_000), type: 'user/message', payload: { turnId: 't1', text: 'q' } },
    });
    let header = store.chatItems('a').find((i) => i.kind === 'turn-header');
    expect(header?.workRunning).toBe(true);
    expect(header?.workStartedAt).toBe(1_000);

    vi.advanceTimersByTime(65_000);
    store.applyFrame({ type: 'turn-end', sessionId: 'a', stopReason: 'end_turn', finalText: '答' });
    header = store.chatItems('a').find((i) => i.kind === 'turn-header');
    expect(header?.workRunning).toBeUndefined();
    expect(header?.workDurationMs).toBe(65_000);
    expect(formatWorkDuration(header!.workDurationMs!)).toBe('1 分 5 秒');
  });

  it('悬挂收敛（T4a 合成）→ turn-header synthetic=true（渲染层文案「已停止（无响应超时）」）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new AppStore();
    store.applyFrame({
      type: 'event',
      sessionId: 'a',
      event: { v: 1, seq: 1, ts: iso(0), type: 'user/message', payload: { turnId: 't1', text: 'q' } },
    });
    vi.advanceTimersByTime(30_000); // HUNG_TURN_TIMEOUT_MS 静默 → 惰性收敛
    const header = store.chatItems('a').find((i) => i.kind === 'turn-header');
    expect(header?.synthetic).toBe(true);
    expect(header?.stopReason).toBe('interrupted');
    expect(header?.workDurationMs).toBe(30_000);
  });
});
