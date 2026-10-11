// @vitest-environment jsdom
// 恢复条（Z2-09b / Z-17「恢复条：按需」）：出现条件（快照携带在途状态）、手动关闭、
// 8s 自动消失、新快照重新出现。计数文案由 resumeInflightCount/resumeRecoveryText 钉住。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ResumeSnapshotShape } from '../src/shared/protocol.js';
import {
  RESUME_BAR_AUTO_DISMISS_MS,
  resumeInflightCount,
  resumeRecoveryText,
} from '../src/renderer/conversation/resume-model.js';
import { ResumeBar } from '../src/renderer/conversation/ResumeBar.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// —— 纯模型：计数只取 ResumeSnapshotShape 真实字段（红线⑩） ——

const snapshot = (overrides: Partial<ResumeSnapshotShape> = {}): ResumeSnapshotShape => ({
  epoch: 2,
  replay: { fromSeq: 0, toSeq: 9 },
  tasks: [],
  pendingApprovals: [],
  queue: [],
  ...overrides,
});

describe('resumeInflightCount（快照真实字段计数）', () => {
  it('空快照 → 0（无在途可恢复，恢复条不该出现）', () => {
    expect(resumeInflightCount(snapshot())).toBe(0);
  });

  it('activeAttempt 计 1 条在途任务；非终态任务逐条计；终态任务不计', () => {
    expect(
      resumeInflightCount(
        snapshot({
          activeAttempt: {
            attemptId: 'a1',
            turnId: 't1',
            textChunkOffset: 0,
            reasoningChunkOffset: 0,
            status: 'running',
          },
        }),
      ),
    ).toBe(1);
    expect(
      resumeInflightCount(
        snapshot({
          tasks: [
            { taskId: 'k1', background: true, state: 'running' },
            { taskId: 'k2', background: true, state: 'waiting-approval' },
            { taskId: 'k3', background: true, state: 'completed' },
            { taskId: 'k4', background: true, state: 'cancelled' },
          ],
        }),
      ),
    ).toBe(2);
  });

  it('pendingApprovals 逐条计；queue 不计入（队列面板另见，不属于任务/审批口径）', () => {
    expect(
      resumeInflightCount(
        snapshot({
          pendingApprovals: [
            {
              requestId: 'r1',
              sessionId: 's1',
              tool: 'bash',
              args: {},
              scope: { mode: 'once' },
              expiresAt: '2026-01-01T00:00:00Z',
            },
          ],
          queue: [{ id: 'cm-1', revision: 0, rawText: 'x', intent: 'queue', state: 'queued' }],
        }),
      ),
    ).toBe(1);
  });
});

describe('resumeRecoveryText', () => {
  it('有在途 → N 条在途任务/审批；无 → 如实说「无」（不显示 0 条假数字）', () => {
    expect(resumeRecoveryText(3)).toBe('已恢复在途状态（3 条在途任务/审批）');
    expect(resumeRecoveryText(0)).toBe('已恢复在途状态（无在途任务/审批）');
  });
});

// —— 组件：出现 / 关闭 / 自动消失 / 新快照重现 ——

describe('ResumeBar 组件', () => {
  it('inflight ≤ 0 → 不渲染（重订阅常态刷新不打扰）', () => {
    render(<ResumeBar resumeAt={1000} inflight={0} autoDismissMs={0} />);
    expect(screen.queryByTestId('resume-bar')).toBeNull();
  });

  it('携带在途状态 → 渲染计数文案 + 关闭按钮', () => {
    render(<ResumeBar resumeAt={1000} inflight={2} autoDismissMs={0} />);
    const bar = screen.getByTestId('resume-bar');
    expect(bar.textContent).toContain('已恢复在途状态');
    expect(bar.textContent).toContain('2 条在途任务/审批');
    expect(screen.getByTestId('resume-bar-close')).toBeTruthy();
  });

  it('手动关闭 → 消失；同一快照不复活', () => {
    const { rerender } = render(<ResumeBar resumeAt={1000} inflight={1} autoDismissMs={0} />);
    fireEvent.click(screen.getByTestId('resume-bar-close'));
    expect(screen.queryByTestId('resume-bar')).toBeNull();
    rerender(<ResumeBar resumeAt={1000} inflight={1} autoDismissMs={0} />);
    expect(screen.queryByTestId('resume-bar')).toBeNull();
  });

  it(`${RESUME_BAR_AUTO_DISMISS_MS}ms 自动消失（8s 不打扰阅读）`, () => {
    vi.useFakeTimers();
    render(<ResumeBar resumeAt={1000} inflight={1} />);
    expect(screen.getByTestId('resume-bar')).toBeTruthy();
    // 计时器触发的 setState 需经 act 落到渲染（React 19 批处理）
    act(() => {
      vi.advanceTimersByTime(RESUME_BAR_AUTO_DISMISS_MS);
    });
    expect(screen.queryByTestId('resume-bar')).toBeNull();
  });

  it('关闭后新的快照到达（resumeAt 变化）→ 重新显示（关闭态只在内存，D-14）', () => {
    const { rerender } = render(<ResumeBar resumeAt={1000} inflight={1} autoDismissMs={0} />);
    fireEvent.click(screen.getByTestId('resume-bar-close'));
    expect(screen.queryByTestId('resume-bar')).toBeNull();
    rerender(<ResumeBar resumeAt={2000} inflight={3} autoDismissMs={0} />);
    expect(screen.getByTestId('resume-bar').textContent).toContain('3 条在途任务/审批');
  });
});
