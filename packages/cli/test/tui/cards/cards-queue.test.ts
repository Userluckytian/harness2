// cards/queue 单测：固定优先级矩阵（G-21～G-24）、resolve 顶出次序、同级 FIFO、幂等与纯度。
import { describe, expect, it } from 'vitest';
import {
  activeCard,
  hasCard,
  nextCardAfter,
  pendingCards,
  priorityOf,
  pushCard,
  resolveCard,
} from '../../../src/tui/cards/queue.js';
import { makeCancelTurnCard, makeElicitationCard, makePermissionCard, makeQuestionCard, pushAll } from './helpers.js';

const FOUR = [makePermissionCard(), makeCancelTurnCard(), makeQuestionCard(), makeElicitationCard()];

describe('G-21～G-24 优先级矩阵：四卡同时到达的展示顺序', () => {
  it('任意 push 顺序，展示顺序恒为 permission > cancel-turn > question > elicitation', () => {
    const orders = [
      FOUR, // 正序
      [...FOUR].reverse(), // 最低优先级先到
      [FOUR[1]!, FOUR[3]!, FOUR[0]!, FOUR[2]!], // 交错
      [FOUR[2]!, FOUR[0]!, FOUR[3]!, FOUR[1]!],
    ];
    for (const order of orders) {
      const state = pushAll(order);
      expect(pendingCards(state).map((c) => c.kind)).toEqual(['permission', 'cancel-turn', 'question', 'elicitation']);
      expect(activeCard(state)?.kind).toBe('permission'); // G-21：permission 遮盖其他卡
    }
  });

  it('迟到的高优先级卡插队到最前（遮盖已在展示的卡）', () => {
    const state = pushAll([makeQuestionCard(), makeElicitationCard()]);
    expect(activeCard(state)?.kind).toBe('question');
    const withPermission = pushCard(state, makePermissionCard('perm-late'));
    expect(activeCard(withPermission)?.id).toBe('perm-late');
    expect(pendingCards(withPermission).map((c) => c.id)).toEqual(['perm-late', 'q-1', 'elicit-1']);
  });

  it('priorityOf 与常量表一致', () => {
    expect(priorityOf('permission')).toBeGreaterThan(priorityOf('cancel-turn'));
    expect(priorityOf('cancel-turn')).toBeGreaterThan(priorityOf('question'));
    expect(priorityOf('question')).toBeGreaterThan(priorityOf('elicitation'));
  });
});

describe('resolve 后按优先级顶出次序', () => {
  it('依次结算 active，下一张按 permission → cancel-turn → question → elicitation 顶出', () => {
    let state = pushAll(FOUR);
    const popped: string[] = [];
    for (const expected of FOUR) {
      expect(activeCard(state)?.id).toBe(expected.id);
      const settled = resolveCard(state, expected.id);
      popped.push(settled.card?.id ?? '<none>');
      state = settled.state;
    }
    expect(popped).toEqual(['perm-1', 'cancel-1', 'q-1', 'elicit-1']);
    expect(activeCard(state)).toBeNull();
    expect(pendingCards(state)).toEqual([]);
  });

  it('nextCardAfter 只窥视不结算：原状态不变', () => {
    const state = pushAll(FOUR);
    expect(nextCardAfter(state, 'perm-1')?.id).toBe('cancel-1');
    expect(activeCard(state)?.id).toBe('perm-1');
    expect(hasCard(state, 'perm-1')).toBe(true);
  });
});

describe('同优先级 FIFO', () => {
  it('两张 permission 卡：先 push 的先展示、先结算', () => {
    const state = pushAll([makePermissionCard('p1'), makePermissionCard('p2')]);
    expect(pendingCards(state).map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(activeCard(state)?.id).toBe('p1');
    const after = resolveCard(state, 'p1').state;
    expect(activeCard(after)?.id).toBe('p2');
  });

  it('同级卡不插同级队（FIFO），更高优先级仍插到同级之前', () => {
    const state = pushAll([makeQuestionCard('q1'), makeQuestionCard('q2')]);
    expect(pendingCards(state).map((c) => c.id)).toEqual(['q1', 'q2']);
    const withCancel = pushCard(state, makeCancelTurnCard());
    expect(pendingCards(withCancel).map((c) => c.id)).toEqual(['cancel-1', 'q1', 'q2']);
  });
});

describe('结算任意位置 / 幂等 / 纯度', () => {
  it('resolve 排队中（非 active）的卡：active 不变，队列收缩', () => {
    const state = pushAll(FOUR);
    const { state: after, card } = resolveCard(state, 'elicit-1');
    expect(card?.id).toBe('elicit-1');
    expect(activeCard(after)?.id).toBe('perm-1');
    expect(pendingCards(after).map((c) => c.id)).toEqual(['perm-1', 'cancel-1', 'q-1']);
  });

  it('resolve 未知 id：原引用返回、卡为 null（不抛错，接线层可据此回 unknown）', () => {
    const state = pushAll(FOUR);
    const result = resolveCard(state, 'no-such-id');
    expect(result.state).toBe(state);
    expect(result.card).toBeNull();
  });

  it('重复 id 的 push 幂等忽略（对齐 core ApprovalQueue 重复 requestId 拒绝）', () => {
    const state = pushAll([makePermissionCard('dup'), makePermissionCard('dup')]);
    expect(pendingCards(state).map((c) => c.id)).toEqual(['dup']);
  });

  it('纯函数：push/resolve 绝不原地改写入参状态', () => {
    const before = pushAll([makeQuestionCard()]);
    const snapshot = structuredClone(before);
    pushCard(before, makePermissionCard());
    resolveCard(before, 'q-1');
    expect(before).toEqual(snapshot);
  });
});
