// cards 测试夹具：四类卡片的规范实例（id/kind/payload/route 全字段可预期）。
import { initialCardQueue, pushCard, type CardQueueState } from '../../../src/tui/cards/queue.js';
import type {
  BlockCard,
  CancelTurnCard,
  ElicitationCard,
  PermissionCard,
  QuestionCard,
} from '../../../src/tui/cards/types.js';

export function makePermissionCard(id = 'perm-1'): PermissionCard {
  return {
    id,
    kind: 'permission',
    source: { system: 'core-approval' },
    payload: {
      sessionId: 's1',
      tool: 'write',
      args: { path: '/tmp/a.txt' },
      scope: { mode: 'once' },
      expiresAt: '2026-09-13T00:00:00.000Z',
      cwd: '/work',
    },
    route: { via: 'core-approval', requestId: id },
  };
}

export function makeCancelTurnCard(id = 'cancel-1'): CancelTurnCard {
  return {
    id,
    kind: 'cancel-turn',
    source: { system: 'ui' },
    payload: { turnId: 'turn-1', reason: '模型仍在流式输出中' },
    route: { via: 'core-cancel', turnId: 'turn-1' },
  };
}

export function makeQuestionCard(id = 'q-1'): QuestionCard {
  return {
    id,
    kind: 'question',
    source: { system: 'tool', tool: 'ask_user_question' },
    payload: {
      question: '选择实现方案',
      options: [
        { id: 'opt-a', label: '方案 A', description: '最小改动' },
        { id: 'opt-b', label: '方案 B' },
      ],
      allowFreeText: true,
    },
    route: { via: 'tool-result', callId: 'call-1' },
  };
}

export function makeElicitationCard(id = 'elicit-1'): ElicitationCard {
  return {
    id,
    kind: 'elicitation',
    source: { system: 'mcp-elicit', server: 'x.ai' },
    payload: { server: 'x.ai', message: '请提供访问令牌', requestedSchema: { type: 'string' } },
    route: { via: 'mcp-elicit', requestId: id },
  };
}

/** 依给定顺序依次 push（返回最终状态） */
export function pushAll(cards: readonly BlockCard[]): CardQueueState {
  let state = initialCardQueue();
  for (const card of cards) state = pushCard(state, card);
  return state;
}
