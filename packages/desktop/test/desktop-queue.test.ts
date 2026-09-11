// D1 可见队列测试：服务端队列 + 本地在途提交 + ack 结论 → 用户可读清单。
// 语义红线：ack 未到 = 待确认（不重发）；ack 丢失 = 未确认（提示勿重复提交）；paused 不自动执行。
import { describe, expect, it } from 'vitest';
import { composeQueueView } from '../src/renderer/features/composer/composer-model.js';
import type { QueueEntryShape } from '../src/shared/protocol.js';

const queued = (id: string, text: string, state: 'queued' | 'paused' = 'queued'): QueueEntryShape => ({
  id,
  revision: 1,
  rawText: text,
  intent: 'queue',
  state,
});

describe('composeQueueView', () => {
  it('服务端 queued 项 → 排队（无 note）', () => {
    const view = composeQueueView({
      queue: [queued('cm-1', '第一句'), queued('cm-2', '第二句')],
      pendingSubmits: {},
      submitAcks: { 'cm-1': { state: 'accepted' }, 'cm-2': { state: 'accepted' } },
    });
    expect(view.map((v) => [v.id, v.kind])).toEqual([
      ['cm-1', 'queued'],
      ['cm-2', 'queued'],
    ]);
  });

  it('ack 未到 → 待确认（显式提示，不重发）', () => {
    const view = composeQueueView({
      queue: [queued('cm-1', '排队中')],
      pendingSubmits: { 'cm-1': { clientMessageId: 'cm-1', rawText: '排队中', intent: 'queue' } },
      submitAcks: {},
    });
    expect(view[0]).toMatchObject({ kind: 'pending' });
    expect(view[0]!.note).toContain('等待服务端确认');
  });

  it('ack 丢失（unknown）→ 未确认 + 勿重复提交提示；队列项保留（不假装成功也不丢弃）', () => {
    const view = composeQueueView({
      queue: [queued('cm-x', '可能已送达')],
      pendingSubmits: {},
      submitAcks: { 'cm-x': { state: 'unknown', reason: '未收到服务端确认（连接中断）——请勿重复提交' } },
    });
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ kind: 'unconfirmed', text: '可能已送达' });
    expect(view[0]!.note).toContain('请勿重复提交');
  });

  it('paused（重启恢复）如实展示为需显式放行，不自动执行', () => {
    const view = composeQueueView({
      queue: [queued('cm-p', '重启前排队', 'paused')],
      pendingSubmits: {},
      submitAcks: {},
    });
    expect(view[0]).toMatchObject({ kind: 'paused' });
    expect(view[0]!.note).toContain('显式放行');
  });

  it('steer 在途（不进服务端队列）也可见，且标注为引导', () => {
    const view = composeQueueView({
      queue: [],
      pendingSubmits: { 'cm-s': { clientMessageId: 'cm-s', rawText: '换个方向', intent: 'steer' } },
      submitAcks: {},
    });
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: 'cm-s', kind: 'pending', text: '换个方向' });
    expect(view[0]!.note).toContain('引导');
  });

  it('已在服务端队列的 id 不重复展示（queue 与 pending 交汇去重）', () => {
    const view = composeQueueView({
      queue: [queued('cm-1', 'x')],
      pendingSubmits: { 'cm-1': { clientMessageId: 'cm-1', rawText: 'x', intent: 'queue' } },
      submitAcks: {},
    });
    expect(view.map((v) => v.id)).toEqual(['cm-1']);
  });
});
