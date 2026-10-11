// D2 修复批次：提交 ack 生命周期 —— 队列面板不得永久累积「幽灵条目」。
//
// 复现的缺陷（编排者内置浏览器实测）：
//   连发 2 条消息，回复均已到达，但「待发送队列」仍常驻显示「排队 / 待确认」。
// 根因（本测试先红后绿钉住）：
//   - AppStore.noteSubmit 把本地乐观项同时写进 stream.queue；resolveSubmitAck 在
//     accepted 时只 bump revision、**从不清除**，队列项永久常驻（渲染为「排队」）。
//   - turn-end 不清本地在途台账（pendingSubmits），ack 迟到/丢失时台账永不清空。
//
// 语义红线（不得为了消除幽灵条目而破坏）：
//   - ack 丢失（unknown）仍须如实显示「未收到确认，请勿重复提交」（fail-closed）；
//   - 服务端队列里真实排队的条目（快照 paused 等）仍要显示。
import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { composeQueueView } from '../src/renderer/features/composer/composer-model.js';

/** 读当前流的队列视图（store 唯一事实源 → 纯模型 → 用户可读清单） */
function viewOf(store: AppStore, sessionId: string) {
  const stream = store.peekStream(sessionId);
  if (stream === undefined) return [];
  return composeQueueView({
    queue: stream.queue,
    pendingSubmits: stream.pendingSubmits,
    submitAcks: stream.submitAcks,
  });
}

describe('D2：ack accepted 后该提交不再以 pending/queued 常驻', () => {
  it('noteSubmit → pending；submit-ack accepted → 队列项清除（不再常驻）', () => {
    const store = new AppStore();
    store.noteSubmit('s1', { clientMessageId: 'cm-1', rawText: '你好', intent: 'queue' });
    expect(viewOf(store, 's1').map((v) => v.kind)).toEqual(['pending']);

    store.applyFrame({
      type: 'submit-ack',
      clientMessageId: 'cm-1',
      sessionId: 's1',
      state: 'accepted',
      queueSeq: 0,
    });
    // 已确认送达：不得再以 pending/queued 形态留在「待发送队列」
    expect(viewOf(store, 's1')).toEqual([]);
    // ack 结论本身仍如实留档（诊断/幂等依据）
    expect(store.peekStream('s1')?.submitAcks['cm-1']?.state).toBe('accepted');
  });

  it('连发两条：两条都 accepted 后队列面板为空（复现缺陷的端到端口径）', () => {
    const store = new AppStore();
    for (const id of ['cm-1', 'cm-2']) {
      store.noteSubmit('s1', { clientMessageId: id, rawText: `第 ${id} 条`, intent: 'queue' });
      store.applyFrame({ type: 'submit-ack', clientMessageId: id, sessionId: 's1', state: 'accepted', queueSeq: 0 });
    }
    expect(viewOf(store, 's1')).toEqual([]);
  });
});

describe('D2：turn-end 清空本地在途提交台账', () => {
  it('turn-end 后 pendingSubmits 必须清空（ack 迟到/丢失也不遗留）', () => {
    const store = new AppStore();
    store.noteSubmit('s1', { clientMessageId: 'cm-1', rawText: '未确认', intent: 'queue' });
    expect(store.peekStream('s1')?.pendingSubmits['cm-1']).toBeDefined();

    store.applyFrame({ type: 'turn-end', sessionId: 's1', stopReason: 'end_turn' });

    expect(store.peekStream('s1')?.pendingSubmits).toEqual({});
    // fail-closed：清台账不等于谎报已送达 —— 未收到 ack 的提交如实标「未确认，勿重复提交」
    const view = viewOf(store, 's1');
    expect(view.map((v) => v.kind)).toEqual(['unconfirmed']);
    expect(view[0]!.note).toContain('请勿重复提交');
  });
});

describe('D2：边界语义不回归（红线）', () => {
  it('ack 丢失（unknown）仍显示「未收到确认，请勿重复提交」', () => {
    const store = new AppStore();
    store.noteSubmit('s1', { clientMessageId: 'cm-x', rawText: '可能已送达', intent: 'queue' });
    store.expirePendingSubmits(5000, Date.now() + 6000);

    const view = viewOf(store, 's1');
    expect(view.map((v) => v.kind)).toEqual(['unconfirmed']);
    expect(view[0]!.note).toContain('请勿重复提交');
    expect(store.peekStream('s1')?.submitAcks['cm-x']?.state).toBe('unknown');
  });

  it('服务端队列里真实排队的条目（快照 paused）仍要显示', () => {
    const store = new AppStore();
    store.applyFrame({
      type: 'resume-snapshot',
      sessionId: 's1',
      epoch: 1,
      snapshot: {
        epoch: 1,
        replay: { fromSeq: 0, toSeq: 0 },
        tasks: [],
        pendingApprovals: [],
        queue: [{ id: 'cm-p', revision: 1, rawText: '重启前排队', intent: 'queue', state: 'paused' }],
      },
    });

    const view = viewOf(store, 's1');
    expect(view.map((v) => [v.id, v.kind])).toEqual([['cm-p', 'paused']]);
  });

  it('ack rejected 仍从队列移除（不假装已排队）', () => {
    const store = new AppStore();
    store.noteSubmit('s1', { clientMessageId: 'cm-r', rawText: 'x', intent: 'queue' });
    store.applyFrame({
      type: 'submit-ack',
      clientMessageId: 'cm-r',
      sessionId: 's1',
      state: 'rejected',
      reason: '队列已满',
    });
    expect(viewOf(store, 's1')).toEqual([]);
  });
});
