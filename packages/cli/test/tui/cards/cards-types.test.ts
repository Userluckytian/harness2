// cards/types 单测：固定优先级常量（G-21～G-24）+ core 审批契约适配层映射。
import { describe, expect, it } from 'vitest';
import type { ApprovalRequestContract } from '@harness2/core';
import {
  CARD_KINDS,
  CARD_PRIORITY,
  CARD_PRIORITY_ORDER,
  cardAnswerKindMatches,
  permissionCardFromApproval,
} from '../../../src/tui/cards/types.js';

describe('G-21～G-24 固定优先级：permission > cancel-turn > question > elicitation', () => {
  it('枚举位顺序即展示优先级（高→低），与数值表单调一致', () => {
    expect(CARD_KINDS).toEqual(['permission', 'cancel-turn', 'question', 'elicitation']);
    expect(CARD_PRIORITY_ORDER).toBe(CARD_KINDS); // 同一常量，防止两表漂移
    for (let i = 1; i < CARD_KINDS.length; i++) {
      const higher = CARD_KINDS[i - 1]!;
      const lower = CARD_KINDS[i]!;
      expect(CARD_PRIORITY[higher]).toBeGreaterThan(CARD_PRIORITY[lower]);
    }
  });
});

describe('适配层：core ApprovalRequestContract → permission 卡', () => {
  const contract: ApprovalRequestContract = {
    requestId: 'req-1',
    sessionId: 's1',
    tool: 'write',
    args: { path: '/tmp/a.txt' },
    cwd: '/work',
    scope: { mode: 'session', sessionId: 's1' },
    expiresAt: '2026-09-13T00:00:00.000Z',
    taskId: 't1',
    parentTaskId: 'p1',
  };

  it('字段全量映射（含可选字段），id 复用 requestId，route 指向 core 审批通道', () => {
    const card = permissionCardFromApproval(contract);
    expect(card.id).toBe('req-1');
    expect(card.kind).toBe('permission');
    expect(card.source).toEqual({ system: 'core-approval' });
    expect(card.payload).toEqual({
      sessionId: 's1',
      tool: 'write',
      args: { path: '/tmp/a.txt' },
      cwd: '/work',
      scope: { mode: 'session', sessionId: 's1' },
      expiresAt: '2026-09-13T00:00:00.000Z',
      taskId: 't1',
      parentTaskId: 'p1',
    });
    expect(card.route).toEqual({ via: 'core-approval', requestId: 'req-1' });
  });

  it('缺省可选字段不产生 undefined 键（无幽灵字段，与 core 契约形状严格对齐）', () => {
    const card = permissionCardFromApproval({
      requestId: 'req-2',
      sessionId: 's2',
      tool: 'read',
      args: undefined,
      scope: { mode: 'once' },
      expiresAt: '2026-09-13T00:00:00.000Z',
    });
    expect('cwd' in card.payload).toBe(false);
    expect('taskId' in card.payload).toBe(false);
    expect('parentTaskId' in card.payload).toBe(false);
  });

  it('适配是纯函数：不改动入参契约', () => {
    const snapshot = structuredClone(contract);
    permissionCardFromApproval(contract);
    expect(contract).toEqual(snapshot);
  });
});

describe('应答与卡片 kind 防错配', () => {
  it('kind 一致才允许配对（接线层按此丢弃错配应答）', () => {
    expect(cardAnswerKindMatches({ kind: 'permission' } as never, { kind: 'permission', allow: true })).toBe(true);
    expect(
      cardAnswerKindMatches({ kind: 'permission' } as never, {
        kind: 'question',
        answer: { type: 'option', optionId: 'o' },
      }),
    ).toBe(false);
  });
});
