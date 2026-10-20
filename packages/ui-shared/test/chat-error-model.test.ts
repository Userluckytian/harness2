// Z-96 纯决策：latestSubmitAckError（最新 ack 结论）/ 指纹去重 / detail 配对。零 DOM。
import { describe, expect, it } from 'vitest';
import {
  errorFingerprint,
  latestSubmitAckError,
  mergeErrorDetail,
  withDismissedFingerprint,
  DISMISSED_FINGERPRINT_LIMIT,
} from '../src/renderer/conversation/chat-error-model.js';

describe('latestSubmitAckError', () => {
  it('空 acks → null', () => {
    expect(latestSubmitAckError({})).toBeNull();
  });

  it('最新 ack = accepted（重发成功）→ null：旧失败自然消失', () => {
    expect(
      latestSubmitAckError({
        c1: { state: 'unknown', reason: '提交未送达: boom' },
        c2: { state: 'accepted' },
      }),
    ).toBeNull();
  });

  it('最新 ack = unknown → 横幅候选（reason 为消息）', () => {
    const err = latestSubmitAckError({ c1: { state: 'unknown', reason: '提交未送达: fetch failed' } });
    expect(err).not.toBeNull();
    expect(err?.message).toBe('提交未送达: fetch failed');
    expect(err?.fingerprint).toBe(errorFingerprint('unknown', '提交未送达: fetch failed'));
  });

  it('最新 ack = rejected 无 reason → 兜底文案（不空横幅）', () => {
    const err = latestSubmitAckError({ c1: { state: 'rejected' } });
    expect(err?.message).toContain('服务端拒绝');
  });

  it('对象键序 = 插入序：取最后插入的 ack', () => {
    const err = latestSubmitAckError({
      old: { state: 'accepted' },
      fresh: { state: 'rejected', reason: '拒绝：内容违规' },
    });
    expect(err?.message).toBe('拒绝：内容违规');
  });
});

describe('errorFingerprint', () => {
  it('同 state+reason → 同指纹（不同 clientMessageId 也同 —— 重试同因视作一条）', () => {
    expect(errorFingerprint('unknown', 'a')).toBe(errorFingerprint('unknown', 'a'));
    expect(errorFingerprint('unknown', 'a')).not.toBe(errorFingerprint('rejected', 'a'));
    expect(errorFingerprint('unknown', undefined)).toBe(errorFingerprint('unknown', undefined));
  });
});

describe('mergeErrorDetail', () => {
  const base = { message: '提交未送达: boom', fingerprint: 'unknown:提交未送达: boom' };
  it('底层 error 与 ack 同源（reason 前缀配对）→ detail = stack（优先）或 message', () => {
    const merged = mergeErrorDetail(base, { message: 'boom', stack: 'Error: boom\n at x' });
    expect(merged.detail).toBe('Error: boom\n at x');
  });
  it('无 stack → detail = message', () => {
    const merged = mergeErrorDetail(base, { message: 'boom' });
    expect(merged.detail).toBe('boom');
  });
  it('不同源（旧 error 串场）→ 不附带 detail', () => {
    const merged = mergeErrorDetail(base, { message: '上一次别的错误' });
    expect(merged.detail).toBeUndefined();
  });
  it('failure=null → 原样', () => {
    expect(mergeErrorDetail(base, null)).toBe(base);
  });
});

describe('withDismissedFingerprint', () => {
  it('累积去重集合；超上限驱逐最旧（有界）', () => {
    let set = new Set<string>();
    for (let i = 0; i < DISMISSED_FINGERPRINT_LIMIT + 5; i += 1) {
      set = withDismissedFingerprint(set, `f${i}`);
    }
    expect(set.size).toBe(DISMISSED_FINGERPRINT_LIMIT);
    expect(set.has('f0')).toBe(false);
    expect(set.has(`f${DISMISSED_FINGERPRINT_LIMIT + 4}`)).toBe(true);
  });
});
