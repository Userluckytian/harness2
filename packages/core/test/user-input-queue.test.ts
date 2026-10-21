import { describe, expect, it } from 'vitest';
import { UserInputQueue } from '../src/interaction/user-input-queue.js';
import { isUserInputAnswer } from '../src/interaction/user-input.js';
import type {
  UserInputAnswer,
  UserInputRequestContract,
  UserInputSettleReason,
} from '../src/interaction/user-input.js';

function request(overrides: Partial<UserInputRequestContract> = {}): UserInputRequestContract {
  return {
    requestId: 'r1',
    sessionId: 's1',
    prompt: 'pick one',
    freeText: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('UserInputQueue (ZS3-T6)', () => {
  it('applies the first answer and reports duplicates/unknown', () => {
    const queue = new UserInputQueue();
    const settled: Array<{ answer: UserInputAnswer; reason: UserInputSettleReason }> = [];
    expect(queue.register({ request: request(), settle: (answer, reason) => settled.push({ answer, reason }) })).toBe(
      true,
    );
    expect(queue.register({ request: request(), settle: () => {} })).toBe(false);

    expect(queue.respond('r1', { freeText: 'A' })).toEqual({ requestId: 'r1', state: 'applied' });
    expect(settled).toEqual([{ answer: { freeText: 'A' }, reason: 'response' }]);
    expect(queue.respond('r1', { freeText: 'B' })).toEqual({ requestId: 'r1', state: 'duplicate' });
    expect(queue.respond('missing', { freeText: 'B' })).toEqual({ requestId: 'missing', state: 'unknown' });
  });

  it('settles timeout as cancel and reports expired on late responses', () => {
    const queue = new UserInputQueue();
    const settled: Array<{ answer: UserInputAnswer; reason: UserInputSettleReason }> = [];
    queue.register({ request: request(), settle: (answer, reason) => settled.push({ answer, reason }) });

    queue.settle('r1', { action: 'cancel' }, 'timeout');
    expect(settled).toEqual([{ answer: { action: 'cancel' }, reason: 'timeout' }]);
    expect(queue.respond('r1', { freeText: 'late' })).toEqual({ requestId: 'r1', state: 'expired' });
  });

  it('fails closed when a request is already expired at respond time', () => {
    const queue = new UserInputQueue();
    const settled: Array<{ answer: UserInputAnswer; reason: UserInputSettleReason }> = [];
    queue.register({
      request: request({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      settle: (answer, reason) => settled.push({ answer, reason }),
    });
    expect(queue.respond('r1', { freeText: 'A' })).toEqual({ requestId: 'r1', state: 'expired' });
    expect(settled).toEqual([{ answer: { action: 'cancel' }, reason: 'expired' }]);
  });

  it('settleAll cancels every pending request and lists are per-session', () => {
    const queue = new UserInputQueue();
    const seen: string[] = [];
    queue.register({ request: request({ requestId: 'a' }), settle: () => seen.push('a') });
    queue.register({ request: request({ requestId: 'b', sessionId: 's2' }), settle: () => seen.push('b') });

    expect(queue.listPending()).toHaveLength(2);
    expect(queue.listForSession('s1').map((r) => r.requestId)).toEqual(['a']);
    queue.settleAll('cancelled');
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(queue.listPending()).toHaveLength(0);
  });

  it('guards answer shape', () => {
    expect(isUserInputAnswer({ optionId: 'x' })).toBe(true);
    expect(isUserInputAnswer({ freeText: 'x', action: 'accept' })).toBe(true);
    expect(isUserInputAnswer({ action: 'bogus' })).toBe(false);
    expect(isUserInputAnswer({ content: 'nope' })).toBe(false);
    expect(isUserInputAnswer(null)).toBe(false);
  });
});
