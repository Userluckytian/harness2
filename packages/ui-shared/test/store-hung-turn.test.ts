// Z-97（T4a）悬挂回合 30s 惰性收敛 —— 只钉 store 公开面（applyFrame / applyReplay /
// markSending / removeApproval / peekStream）。合成终态是 UI 态（不写盘、不发网络），
// 断言口径：`turnEnds[turnId] = {stopReason:'interrupted', synthetic:true}` + running 清除。
// 计时一律 vitest fake timers（Date.now 与 setTimeout 同源于假钟）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore, HUNG_TURN_TIMEOUT_MS } from '../src/renderer/store.js';
import { formatWorkDuration } from '../src/renderer/chat-model.js';

function event(seq: number, type: string, payload: Record<string, unknown>) {
  return { v: 1 as const, seq, ts: '2026-09-14T00:00:00.000Z', type, payload };
}

/** 用户消息落盘帧：absorbEvent 置 running（悬挂看门狗的回合起点） */
function userMessageFrame(turnId = 't1') {
  return {
    type: 'event' as const,
    sessionId: 'a',
    event: event(1, 'user/message', { turnId, text: 'q' }),
  };
}

describe('Z-97（T4a）悬挂回合惰性收敛', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 阈值前一瞬：不许提前合成 */
    // 契约字面量：阈值口径 = 30s（口径对齐 ZCode 逻辑帧装配超时），刻意不取实现常量，
    // 否则实现常量被改值时本用例失去自证能力（a/b 钉字面量，其余用例走常量）。
    const THIRTY_SECONDS = 30_000;

    it('a) running + 30s 无任何帧 → 合成 interrupted(synthetic) 且 running 清除', () => {
      const store = new AppStore();
      store.applyFrame(userMessageFrame());
      expect(store.peekStream('a')?.running).toBe(true);

      vi.advanceTimersByTime(THIRTY_SECONDS - 1);
      expect(store.peekStream('a')?.running).toBe(true);
      expect(store.peekStream('a')?.turnEnds['t1']).toBeUndefined();

      vi.advanceTimersByTime(1);
      const stream = store.peekStream('a')!;
      expect(stream.running).toBe(false);
      expect(stream.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
      // 合成终态同时落定墙钟（Z-97 T4② turnEndedAt 独立于纯协议事实的 turnEnds）
      expect(stream.turnEndedAt['t1']).toBe(Date.now());
      expect(stream.live.text).toBe('');
    });

    it('b) 25s 注入活帧 → 原 30s 时点不合成交；从该帧起再静默 30s 才合成', () => {
      const store = new AppStore();
      store.applyFrame(userMessageFrame());
      vi.advanceTimersByTime(25_000);
      // 活帧：delta 增量（running 维持、计时重置）
      store.applyFrame({ type: 'delta', sessionId: 'a', kind: 'text', text: 'still alive' });

      // 走到原 30s 时点（活帧后 5s）：不许合成
      vi.advanceTimersByTime(5_000);
      expect(store.peekStream('a')?.turnEnds['t1']).toBeUndefined();
      expect(store.peekStream('a')?.running).toBe(true);

      // 活帧起再静默满 30s → 收敛
      vi.advanceTimersByTime(THIRTY_SECONDS - 5_000);
      const stream = store.peekStream('a')!;
      expect(stream.running).toBe(false);
      expect(stream.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
    });

  it('c) 真 turn-end 先到：记录无 synthetic 标记；挂着的定时器到点也不再改写', () => {
    const store = new AppStore();
    store.applyFrame(userMessageFrame());
    store.applyFrame({ type: 'turn-end', sessionId: 'a', stopReason: 'end_turn', finalText: '答' });
    const stream = store.peekStream('a')!;
    expect(stream.turnEnds['t1']).toEqual({ stopReason: 'end_turn', finalText: '答' });
    expect(stream.turnEnds['t1']?.synthetic).toBeUndefined();
    // Z-97 T4②：真终态也落定墙钟
    expect(typeof stream.turnEndedAt['t1']).toBe('number');
    const endedAt = stream.turnEndedAt['t1'];

    // 越过收敛阈值：running 已 false → 定时器空转，协议事实与墙钟都不许被扰动
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS + 5_000);
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({ stopReason: 'end_turn', finalText: '答' });
    expect(store.peekStream('a')?.turnEndedAt['t1']).toBe(endedAt);
  });

  it('c′) 先合成、后到真 turn-end → 合成被真帧整体覆盖（synthetic 消失）', () => {
    const store = new AppStore();
    store.applyFrame(userMessageFrame());
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });

    store.applyFrame({ type: 'turn-end', sessionId: 'a', stopReason: 'end_turn', finalText: '迟到的真终态' });
    const stream = store.peekStream('a')!;
    expect(stream.turnEnds['t1']).toEqual({ stopReason: 'end_turn', finalText: '迟到的真终态' });
    expect(stream.turnEnds['t1']?.synthetic).toBeUndefined();
    expect(stream.running).toBe(false);
  });

  it('d) replay 尾部 step/end 无 turn-end 且被置 running → 30s 静默后收敛（turnId 取事件流尾部）', () => {
    const store = new AppStore();
    store.applyReplay({
      id: 'a',
      dir: 'dir-a',
      header: { sessionId: 'a' },
      events: [
        { ...event(1, 'user/message', { turnId: 't1', text: 'q' }), active: true },
        { ...event(2, 'step/end', { turnId: 't1', durationMs: 800 }), active: true },
      ],
      warnings: [],
      lastSeq: 2,
    });
    // store 实际行为：replay 本身不置 running（历史加载 ≠ 在跑）
    expect(store.peekStream('a')?.running).toBe(false);
    // 置 running（悬挂提交路径）后静默 → 合成终态归属 replay 尾部 step/end 的 turnId
    store.markSending('a');
    expect(store.peekStream('a')?.running).toBe(true);
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    const stream = store.peekStream('a')!;
    expect(stream.running).toBe(false);
    expect(stream.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
    expect(stream.turnEndedAt['t1']).toBe(Date.now());
    expect(stream.loaded).toBe(true);
  });

  it('e) pending 审批帧在等 → 30s+ 不合成；审批移除后下一活帧起恢复正常收敛', () => {
    const store = new AppStore();
    store.applyFrame(userMessageFrame());
    vi.advanceTimersByTime(10_000);
    store.applyFrame({ type: 'approval-request', sessionId: 'a', requestId: 'r1', tool: 'bash', args: {} });

    // 跨过原始与审批帧重置后的各 30s 阈值：审批等待是用户侧显式等待，不许误报「已停止」
    vi.advanceTimersByTime(50_000);
    const stream = store.peekStream('a')!;
    expect(stream.turnEnds['t1']).toBeUndefined();
    expect(stream.running).toBe(true);
    expect(stream.approvals.map((a) => a.requestId)).toEqual(['r1']);

    // 审批清除 + 新活帧重新挂表 → 恢复静默 30s 后照常收敛
    store.removeApproval('r1');
    store.applyFrame({ type: 'delta', sessionId: 'a', kind: 'text', text: 'resumed' });
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    expect(store.peekStream('a')?.running).toBe(false);
    expect(store.peekStream('a')?.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
  });

  it('g) resume-snapshot 把 running 从 false 翻成 true（断线重连补在途 attempt）→ 必须重新挂表，静默 30s 后收敛', () => {
    const store = new AppStore();
    // 历史重放：有 turnId 供合成归属，但 replay 本身不置 running（旧值 false）
    store.applyReplay({
      id: 'a',
      dir: 'dir-a',
      header: { sessionId: 'a' },
      events: [{ ...event(1, 'user/message', { turnId: 't1', text: 'q' }), active: true }],
      warnings: [],
      lastSeq: 1,
    });
    expect(store.peekStream('a')?.running).toBe(false);
    // 重订阅快照报告在途 attempt → applyResumeSnapshot 翻转 running=false→true
    // （applyFrame 开头的对表看到的还是旧值 false → 未挂表；翻转点必须补挂，否则痛点⑤复发）
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 'a',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 1 },
        activeAttempt: {
          attemptId: 'x',
          turnId: 't1',
          textChunkOffset: 0,
          reasoningChunkOffset: 0,
          status: 'running',
        },
        tasks: [],
        pendingApprovals: [],
        queue: [],
      },
    });
    expect(store.peekStream('a')?.running).toBe(true);
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    const stream = store.peekStream('a')!;
    expect(stream.running).toBe(false);
    expect(stream.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
  });

  it('h) 审批等待期定时器到点让路（不撤表不合成）→ removeApproval 清审批后必须重新挂表，否则永久转圈', () => {
    const store = new AppStore();
    store.applyFrame(userMessageFrame());
    store.applyFrame({ type: 'approval-request', sessionId: 'a', requestId: 'r1', tool: 'bash', args: {} });
    // 跨过阈值：定时器到点 → converge 因审批在等让路（返回 false），定时器已消费、running 仍真
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    expect(store.peekStream('a')?.running).toBe(true);
    expect(store.peekStream('a')?.turnEnds['t1']).toBeUndefined();
    // 审批清除：此刻无任何活帧到达 —— 若 removeApproval 不重挂表，running 永无收敛（P1 回归）
    store.removeApproval('r1');
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS);
    const stream = store.peekStream('a')!;
    expect(stream.running).toBe(false);
    expect(stream.turnEnds['t1']).toEqual({ stopReason: 'interrupted', synthetic: true });
  });

  it('i) removeSessionFromView 撤除悬挂定时器（删除会话后定时器不再触发、不空转 notify）', () => {
    const store = new AppStore();
    store.applyFrame({ ...userMessageFrame(), sessionId: 'gone' });
    // 视图列表同步加项（removeSessionFromView 的清理面按会话 id，与列表无关，这里只求真实形态）
    let notifyAfterRemove = 0;
    store.subscribe(() => {
      notifyAfterRemove += 1;
    });
    store.removeSessionFromView('gone');
    expect(store.peekStream('gone')?.running).toBe(true); // 流缓冲保留（既有语义），但定时器已撤
    const before = notifyAfterRemove;
    vi.advanceTimersByTime(HUNG_TURN_TIMEOUT_MS + 5_000);
    // 定时器若泄漏：到点 converge → notify + 合成终态写进已删会话流。两者都不得发生。
    expect(notifyAfterRemove).toBe(before);
    expect(store.peekStream('gone')?.turnEnds['t1']).toBeUndefined();
    expect(store.peekStream('gone')?.running).toBe(true);
  });

  it.each([
    [5_000, '5 秒'],
    [65_000, '1 分 5 秒'],
    [3_600_000, '1 时'],
    [90_061_000, '1 天 1 时'],
    [500, '不到 1 秒'],
  ])('f) formatWorkDuration(%i) → 「%s」（天/时/分/秒四级、最多 2 单位、零值跳过）', (ms, expected) => {
    expect(formatWorkDuration(ms)).toBe(expected);
  });
});
