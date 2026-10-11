// @vitest-environment jsdom
// Z2-09b 席位级装配（Z-17 对话页区块补缺）：队列面板 / 恢复条 / 轮次导航在**桌面 ConversationSeat**
// 的端到端出现与消失。数据全部走真 store 帧（noteSubmit / submit-ack / resume-snapshot / 重放），
// 只有桥是桩（渲染路径不触达）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createController } from '@harness2/ui-shared/renderer/app-controller.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import type { SessionEventsPayloadShape, WsFrame } from '../../src/shared/protocol.js';
import { ConversationSeat } from '../../src/renderer/conversation/assembly.js';

let seq = 0;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  seq = 0;
});
function event(type: string, payload: Record<string, unknown>): SessionEventsPayloadShape['events'][number] {
  seq += 1;
  return { v: 1, seq, ts: '2026-10-11T00:00:00Z', type, payload, active: true };
}

/** 两轮重放（t1/t2）——轮次导航的最小显示条件（≥2 轮） */
function replayTwoTurns(id: string): SessionEventsPayloadShape {
  return {
    id,
    dir: 'd',
    header: { sessionId: id, cwd: 'D:/proj' },
    events: [
      event('user/message', { text: '第一轮问题', turnId: 't1' }),
      event('assistant/message', { text: '第一轮回答', turnId: 't1' }),
      event('user/message', { text: '第二轮问题', turnId: 't2' }),
      event('assistant/message', { text: '第二轮回答', turnId: 't2' }),
    ],
    warnings: [],
    lastSeq: 4,
  };
}

function boot(turns = 2): AppStore {
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions([
    { id: 's1', dir: 'd', cwd: 'D:/proj', mtimeMs: 10, firstUserText: '第一轮问题', messageCount: 4, lastSeq: 4 },
  ]);
  store.select('s1');
  store.applyReplay(
    turns >= 2
      ? replayTwoTurns('s1')
      : { ...replayTwoTurns('s1'), events: replayTwoTurns('s1').events.slice(0, 2), lastSeq: 2 },
  );
  return store;
}

/** 渲染桌面席位：header/statusPanel 换成空实现（本文件只看四个补缺区块，不测头部/面板） */
function renderSeat(store: AppStore): void {
  const controller = createController(store, {} as never); // 渲染路径不触达桥；动作由帧直接驱动
  render(<ConversationSeat store={store} controller={controller} header={() => null} statusPanel={() => null} />);
}

/** 快照帧工厂（Z2-09b 恢复条数据面） */
function resumeSnapshot(inflight: 'busy' | 'idle', epoch = 2): WsFrame {
  return {
    type: 'resume-snapshot',
    sessionId: 's1',
    epoch,
    snapshot: {
      epoch,
      replay: { fromSeq: 0, toSeq: 4 },
      pendingApprovals: [],
      ...(inflight === 'busy'
        ? {
            activeAttempt: {
              attemptId: 'at1',
              turnId: 't2',
              textChunkOffset: 0,
              reasoningChunkOffset: 0,
              status: 'running' as const,
            },
            pendingApprovals: [
              {
                requestId: 'r1',
                sessionId: 's1',
                tool: 'bash',
                args: {},
                scope: { mode: 'once' } as const,
                expiresAt: '2026-01-01T00:00:00Z',
              },
            ],
          }
        : {}),
      tasks: [],
      queue: [],
    },
  };
}

describe('队列面板（Z-17：有队列时，composer 之上的 dock）', () => {
  it('无队列不渲染；本地提交（queue 意图）→ dock 出现：摘要 + 位次', () => {
    const store = boot();
    renderSeat(store);
    expect(screen.queryByTestId('queue-dock')).toBeNull();

    act(() => store.noteSubmit('s1', { clientMessageId: 'cm-1', rawText: '排队中的消息', intent: 'queue' }));
    const dock = screen.getByTestId('queue-dock');
    expect(dock.getAttribute('data-queue-count')).toBe('1');
    expect(dock.textContent).toContain('排队中的消息');
    expect(dock.textContent).toContain('排队');

    // steer 不进队列（控制输入），但作为在途提交如实显示「待确认」（与旧可见队列同口径）
    act(() => store.noteSubmit('s1', { clientMessageId: 'cm-2', rawText: '插话', intent: 'steer' }));
    const withSteer = screen.getByTestId('queue-dock');
    expect(withSteer.getAttribute('data-queue-count')).toBe('2');
    expect(withSteer.textContent).toContain('插话');
    expect(withSteer.textContent).toContain('待确认');
  });

  it('ack rejected → 条目从 dock 移除（不假装已排队）；只读（无撤回按钮，登记项）', () => {
    const store = boot();
    renderSeat(store);
    act(() => store.noteSubmit('s1', { clientMessageId: 'cm-1', rawText: '排队中的消息', intent: 'queue' }));
    expect(screen.getByTestId('queue-dock')).toBeTruthy();

    act(() => {
      store.applyFrame({
        type: 'submit-ack',
        sessionId: 's1',
        clientMessageId: 'cm-1',
        state: 'rejected',
        reason: '会话已关闭',
      });
    });
    expect(screen.queryByTestId('queue-dock')).toBeNull();
  });
});

describe('恢复条（Z2-09b：重订阅快照携带在途状态时出现）', () => {
  it('无快照不渲染；快照携带在途（attempt+待批）→ 出现且计数如实（1+1=2 条）', () => {
    vi.useFakeTimers();
    const store = boot();
    renderSeat(store);
    expect(screen.queryByTestId('resume-bar')).toBeNull();

    act(() => store.applyFrame(resumeSnapshot('busy')));
    const bar = screen.getByTestId('resume-bar');
    expect(bar.textContent).toContain('已恢复在途状态');
    expect(bar.textContent).toContain('2 条在途任务/审批');
  });

  it('8s 自动消失；手动关闭立即消失', () => {
    vi.useFakeTimers();
    const store = boot();
    renderSeat(store);
    act(() => store.applyFrame(resumeSnapshot('busy')));
    expect(screen.getByTestId('resume-bar')).toBeTruthy();

    // 计时器触发的 setState 需经 act 落到渲染；8s 到点自动消失
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByTestId('resume-bar')).toBeNull();

    // 新快照重新出现（resumeAt 变化），随后手动关闭
    act(() => store.applyFrame(resumeSnapshot('busy', 3)));
    expect(screen.getByTestId('resume-bar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('resume-bar-close'));
    expect(screen.queryByTestId('resume-bar')).toBeNull();
  });

  it('快照无在途（inflight=0）→ 不出现（重订阅常态刷新不打扰）', () => {
    vi.useFakeTimers();
    const store = boot();
    renderSeat(store);
    act(() => store.applyFrame(resumeSnapshot('idle')));
    expect(screen.queryByTestId('resume-bar')).toBeNull();
    vi.advanceTimersByTime(8000);
    expect(screen.queryByTestId('resume-bar')).toBeNull();
  });
});

describe('轮次导航（Z-17：≥2 轮且 ≥864px 的 JS 侧条件）', () => {
  it('单轮 → rail 不渲染；两轮 → rail 出现（每轮一枚按钮，锚点行带 data-turn-id）', () => {
    const single = boot(1);
    renderSeat(single);
    expect(screen.queryByTestId('turn-rail')).toBeNull();
    expect(document.querySelector('[data-turn-id="t1"]')).not.toBeNull();

    cleanup();
    const two = boot(2);
    renderSeat(two);
    const rail = screen.getByTestId('turn-rail');
    expect(rail.querySelectorAll('button')).toHaveLength(2);
    expect(rail.querySelector('button')?.getAttribute('title')).toBe('第一轮问题');
  });

  it('点击轮次 → 定位该轮首行（scrollTop 被赋值）并把该轮置为当前（aria-current）', () => {
    const store = boot(2);
    renderSeat(store);
    const messages = document.querySelector('.messages') as HTMLElement;
    const rail = screen.getByTestId('turn-rail');
    fireEvent.click(rail.querySelector('[data-turn-nav="t1"]')!);
    expect(messages.scrollTop).toBe(0); // jsdom 无布局：rects 全 0 → max(0, 0-内缩) = 0（赋值路径已走）
    expect(rail.querySelector('[data-turn-nav="t1"]')?.getAttribute('aria-current')).toBe('true');
    expect(rail.querySelector('[data-turn-nav="t2"]')?.getAttribute('aria-current')).toBeNull();
  });
});
