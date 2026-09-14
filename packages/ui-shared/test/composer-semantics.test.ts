// composer 纯语义（共享包内唯一一份）：乐观提交事务（D-34）、主按钮矩阵（D-36）、
// 繁忙态 Enter（D-35）、附件 FIFO/并发/失败不阻塞（D-37）。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  FileUploadQueue,
  restoreAttachments,
  type ComposerAttachment,
  type UploadTask,
} from '../src/renderer/conversation/composer/attachments.js';
import {
  commitDraft,
  createComposerState,
  draftText,
  setDraftText,
} from '../src/renderer/conversation/composer/composer-state.js';
import {
  canSubmit,
  resolveEnterPolicy,
  resolveMainButton,
  resolveSubmitMode,
  type SubmitPolicyInput,
} from '../src/renderer/conversation/composer/submit-policy.js';

const baseInput: SubmitPolicyInput = {
  running: false,
  busyEnter: 'queue',
  steeringAvailable: true,
  submittable: true,
  slashCommand: false,
  uploadsPending: false,
  locked: false,
  stopAvailable: false,
};

describe('乐观提交（D-34）：清空草稿与冻结载荷在同一事务', () => {
  it('一次调用同时给出空草稿与 detached 载荷（保序、附件原样带走）', () => {
    const state = setDraftText(createComposerState(), '原始 文本');
    const attachment: ComposerAttachment = {
      id: 'f1',
      kind: 'file',
      name: 'a.bin',
      mimeType: 'x',
      bytes: 1,
      state: 'ready',
      token: 'tok',
    };
    const { state: next, submission } = commitDraft(state, {
      sessionId: 's1',
      intent: 'queue',
      placement: 'queue-dock',
      clientMessageId: 'cm-1',
      attachments: [attachment],
    });
    expect(draftText(next)).toBe('');
    expect(next.history).toEqual([]); // 撤销历史同事务归零
    expect(next.revision).toBe(state.revision + 1); // 只 +1（一次通知）
    expect(submission.detached).toBe(true);
    expect(submission.rawText).toBe('原始 文本');
    expect(submission.attachments).toEqual([attachment]);
    expect(submission.placement).toBe('queue-dock');
  });
});

describe('主按钮矩阵（D-36）与繁忙态 Enter（D-35）', () => {
  it('繁忙且空草稿 → 同一位置变 Stop（绝不并列两个按钮）', () => {
    const policy = resolveMainButton({ ...baseInput, running: true, submittable: false, stopAvailable: true });
    expect(policy.kind).toBe('stop');
    expect(policy.label).toBe('停止');
    expect(policy.disabled).toBe(false);
  });

  it('繁忙且可提交 → Send 标签跟随 Enter 模式（排队发送 / 插话发送）', () => {
    expect(resolveMainButton({ ...baseInput, running: true }).label).toBe('排队发送');
    expect(resolveMainButton({ ...baseInput, running: true, busyEnter: 'steer' }).label).toBe('插话发送');
  });

  it('空闲 / `/` 命令行 / 待传文件 / 不支持 steer → 普通「发送」', () => {
    expect(resolveMainButton(baseInput).label).toBe('发送');
    expect(resolveMainButton({ ...baseInput, running: true, slashCommand: true }).label).toBe('发送');
    expect(resolveMainButton({ ...baseInput, running: true, uploadsPending: true }).label).toBe('发送');
    expect(resolveMainButton({ ...baseInput, running: true, steeringAvailable: false }).label).toBe('发送');
  });

  it('加速和弦恒用另一模式（D-36）', () => {
    expect(resolveSubmitMode('queue', true, 'accelerated', true)).toBe('steer');
    expect(resolveSubmitMode('steer', true, 'accelerated', true)).toBe('queue');
    expect(resolveSubmitMode('steer', false, 'enter', true)).toBe('queue'); // 空闲恒 queue
  });

  it('Enter 落点：空闲 transcript / 繁忙 queue-dock / 繁忙 steer 插话', () => {
    expect(resolveEnterPolicy(baseInput).delivery).toBe('transcript');
    expect(resolveEnterPolicy({ ...baseInput, running: true }).delivery).toBe('enqueue');
    expect(resolveEnterPolicy({ ...baseInput, running: true, busyEnter: 'steer' }).delivery).toBe('steer');
  });

  it('空草稿 / 锁定 / 待传文件一律不可提交', () => {
    expect(canSubmit(baseInput)).toBe(true);
    expect(canSubmit({ ...baseInput, submittable: false })).toBe(false);
    expect(canSubmit({ ...baseInput, locked: true })).toBe(false);
    expect(canSubmit({ ...baseInput, uploadsPending: true })).toBe(false);
  });
});

describe('附件上传队列（D-37）', () => {
  const task = (id: string): UploadTask => ({ id, name: `${id}.bin`, mimeType: 'x', bytes: 1, file: null });

  it('FIFO 保序 + 并发上限默认 2 + 峰值取证', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const queue = new FileUploadQueue({
      transport: {
        upload: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return { token: `tok-${peak}` };
        },
      },
    });
    queue.enqueue([task('a'), task('b'), task('c')]);
    expect(queue.attachments().map((a) => a.id)).toEqual(['a', 'b', 'c']); // 选择顺序
    expect(queue.activeCount).toBe(DEFAULT_MAX_CONCURRENT_FILE_UPLOADS);
    releases.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    releases.forEach((r) => r());
    await queue.whenIdle();
    expect(peak).toBe(2);
    expect(queue.attachments().every((a) => a.state === 'ready')).toBe(true);
    expect(queue.uploadsPending).toBe(false);
  });

  it('失败不阻塞后续，失败项留在列表供重提（不自动重发）', async () => {
    const queue = new FileUploadQueue({
      transport: {
        upload: async (t) => {
          if (t.id === 'bad') throw new Error('网络断开');
          return { token: 'ok' };
        },
      },
      maxConcurrent: 1,
    });
    queue.enqueue([task('bad'), task('good')]);
    await queue.whenIdle();
    const items = queue.attachments();
    expect(items[0]).toMatchObject({ id: 'bad', state: 'failed', error: '网络断开' });
    expect(items[1]).toMatchObject({ id: 'good', state: 'ready', token: 'ok' });

    queue.retryFailed();
    await queue.whenIdle();
    expect(queue.attachments()[0]?.state).toBe('failed'); // 仍失败：如实，不假报成功
  });

  it('还原附件：去重后插回草稿头部，用户期间新加的附件保持不动', () => {
    const restored: ComposerAttachment = {
      id: 'f1',
      kind: 'file',
      name: 'x',
      mimeType: 'x',
      bytes: 1,
      state: 'failed',
    };
    const current: ComposerAttachment = { id: 'f2', kind: 'file', name: 'y', mimeType: 'x', bytes: 1, state: 'ready' };
    expect(restoreAttachments([restored], [current]).map((a) => a.id)).toEqual(['f1', 'f2']);
    expect(restoreAttachments([restored], [restored, current])).toEqual([restored, current]);
  });

  it('并发上限非法值当场拒绝（不静默取默认）', () => {
    expect(
      () =>
        new FileUploadQueue({
          transport: { upload: async () => ({ token: 't' }) },
          maxConcurrent: 0,
        }),
    ).toThrow('maxConcurrentFileUploads');
  });
});
