// D-35 / D-36 提交策略矩阵：Enter 投递落点、主按钮 Stop↔Send 切换、标签跟随模式、组合键反向。
import { describe, expect, it } from 'vitest';
import {
  canSubmit,
  placementNotice,
  resolveEnterPolicy,
  resolveMainButton,
  resolveSubmitMode,
  type SubmitPolicyInput,
} from '@harness2/ui-shared/renderer/conversation/composer/submit-policy.js';

const base: SubmitPolicyInput = {
  running: false,
  busyEnter: 'queue',
  steeringAvailable: true,
  submittable: true,
  slashCommand: false,
  uploadsPending: false,
  locked: false,
  stopAvailable: true,
};

const input = (patch: Partial<SubmitPolicyInput>): SubmitPolicyInput => ({ ...base, ...patch });

describe('D-35 繁忙态 Enter 投递', () => {
  it('空闲 → transcript（intent 仍为 queue，服务端按空闲投递正文）', () => {
    expect(resolveEnterPolicy(input({ running: false }), 'enter')).toEqual({
      delivery: 'transcript',
      placement: 'transcript',
      intent: 'queue',
    });
  });

  it('繁忙 + 偏好 queue → enqueue / queue-dock / intent queue', () => {
    expect(resolveEnterPolicy(input({ running: true, busyEnter: 'queue' }), 'enter')).toEqual({
      delivery: 'enqueue',
      placement: 'queue-dock',
      intent: 'queue',
    });
  });

  it('繁忙 + 偏好 steer → steer / pending-steering / intent steer', () => {
    expect(resolveEnterPolicy(input({ running: true, busyEnter: 'steer' }), 'enter')).toEqual({
      delivery: 'steer',
      placement: 'pending-steering',
      intent: 'steer',
    });
  });

  it('繁忙但不支持 steer → 回退 queue（本会话传输层裁决）', () => {
    expect(resolveEnterPolicy(input({ running: true, busyEnter: 'steer', steeringAvailable: false }))).toEqual({
      delivery: 'enqueue',
      placement: 'queue-dock',
      intent: 'queue',
    });
  });

  it('空闲下加速和弦仍是 transcript（不提交新回合的语义由服务端空闲队列承接）', () => {
    expect(resolveEnterPolicy(input({ running: false }), 'accelerated').delivery).toBe('transcript');
  });
});

describe('resolveSubmitMode（组合键恒用另一模式）', () => {
  it('非繁忙 / 不支持 steer → 恒 queue', () => {
    expect(resolveSubmitMode('steer', false, 'enter', true)).toBe('queue');
    expect(resolveSubmitMode('steer', true, 'enter', false)).toBe('queue');
  });

  it('繁忙：普通 Enter 用偏好，加速和弦用另一模式（两向对称）', () => {
    expect(resolveSubmitMode('queue', true, 'enter', true)).toBe('queue');
    expect(resolveSubmitMode('queue', true, 'accelerated', true)).toBe('steer');
    expect(resolveSubmitMode('steer', true, 'enter', true)).toBe('steer');
    expect(resolveSubmitMode('steer', true, 'accelerated', true)).toBe('queue');
  });
});

describe('D-36 主指针：单一位置在 Stop 与 Send 之间切换', () => {
  it('空闲 + 有草稿 → Send「发送」可用，投递模式 queue', () => {
    expect(resolveMainButton(input({ running: false }))).toEqual({
      kind: 'send',
      label: '发送',
      labelKind: 'input.send',
      disabled: false,
      submitMode: 'queue',
    });
  });

  it('空闲 + 空草稿 → 仍是 Send「发送」但禁用（不出现 Stop）', () => {
    const policy = resolveMainButton(input({ running: false, submittable: false }));
    expect(policy.kind).toBe('send');
    expect(policy.label).toBe('发送');
    expect(policy.disabled).toBe(true);
  });

  it('繁忙 + 空草稿 → Stop「停止」（同一位置切换，不并列两个按钮）', () => {
    const policy = resolveMainButton(input({ running: true, submittable: false }));
    expect(policy).toEqual({
      kind: 'stop',
      label: '停止',
      labelKind: 'input.stop',
      disabled: false,
      submitMode: 'queue',
    });
  });

  it('繁忙 + 无 Stop 目标 → Stop 禁用', () => {
    expect(resolveMainButton(input({ running: true, submittable: false, stopAvailable: false })).disabled).toBe(true);
  });

  it('繁忙 + 锁定 → 位置仍为 Stop（owner block 语义）', () => {
    expect(resolveMainButton(input({ running: true, locked: true })).kind).toBe('stop');
  });

  it('繁忙 + 草稿 + 偏好 queue → 「排队发送」（标签跟随 Enter 模式）', () => {
    const policy = resolveMainButton(input({ running: true, busyEnter: 'queue' }));
    expect(policy.kind).toBe('send');
    expect(policy.label).toBe('排队发送');
    expect(policy.labelKind).toBe('input.send.queue');
    expect(policy.submitMode).toBe('queue');
    expect(policy.disabled).toBe(false);
  });

  it('繁忙 + 草稿 + 偏好 steer → 「插话发送」', () => {
    const policy = resolveMainButton(input({ running: true, busyEnter: 'steer' }));
    expect(policy.label).toBe('插话发送');
    expect(policy.labelKind).toBe('input.send.steer');
    expect(policy.submitMode).toBe('steer');
  });

  it('繁忙 + `/` 命令行 → 保留普通 Send 标签（点击走命令裁定，不是消息投递）', () => {
    const policy = resolveMainButton(input({ running: true, busyEnter: 'steer', slashCommand: true }));
    expect(policy.label).toBe('发送');
    expect(policy.labelKind).toBe('input.send');
    expect(policy.kind).toBe('send');
  });

  it('繁忙 + 仍有文件在传 → 保留普通 Send 且禁用', () => {
    const policy = resolveMainButton(input({ running: true, uploadsPending: true }));
    expect(policy.label).toBe('发送');
    expect(policy.disabled).toBe(true);
  });

  it('繁忙但不支持 steer → 普通 Send 标签（模式回退 queue，不声称插话）', () => {
    const policy = resolveMainButton(input({ running: true, busyEnter: 'steer', steeringAvailable: false }));
    expect(policy.label).toBe('发送');
    expect(policy.submitMode).toBe('queue');
  });
});

describe('canSubmit', () => {
  it('空草稿 / 锁定 / 待传文件一律不提交', () => {
    expect(canSubmit(input({}))).toBe(true);
    expect(canSubmit(input({ submittable: false }))).toBe(false);
    expect(canSubmit(input({ locked: true }))).toBe(false);
    expect(canSubmit(input({ uploadsPending: true }))).toBe(false);
  });
});

describe('placementNotice（P2-1：placement 的真实消费方文案）', () => {
  it('三个落点各有专属文案，且与投递落点一一对应', () => {
    expect(placementNotice('transcript')).toContain('transcript');
    expect(placementNotice('queue-dock')).toContain('queue-dock');
    expect(placementNotice('pending-steering')).toContain('pending-steering');
    expect(
      new Set([placementNotice('transcript'), placementNotice('queue-dock'), placementNotice('pending-steering')]).size,
    ).toBe(3);
  });
});
