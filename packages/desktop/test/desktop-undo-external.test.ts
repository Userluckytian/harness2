// D5 安全撤销测试（F5）：dryRun 比对 → 外部改动拦截 → 显式覆盖才真正恢复；无冲突直接恢复。
// 用假 api 断言调用序列（真实链路）——不是纯函数自测。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import type { Harness2Api, UndoRedoResponseShape } from '../src/shared/protocol.js';

const preview = (dirty: boolean): UndoRedoResponseShape => ({
  results: [
    {
      kind: 'undo',
      dryRun: true,
      markerSeq: 5,
      rewindToSeq: 0,
      messages: 1,
      files: [{ file: '/w/a.txt', target: dirty ? 'x' : null, externallyModified: dirty }],
    },
  ],
});

function makeApi(dirty: boolean): {
  api: Harness2Api;
  undo: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
} {
  const undo = vi.fn(async (_id: string, opts?: { dryRun?: boolean }) =>
    opts?.dryRun === true ? preview(dirty) : ({ results: [] } as UndoRedoResponseShape),
  );
  const listSessions = vi.fn(async () => []);
  const api = { undo, listSessions } as unknown as Harness2Api;
  return { api, undo, listSessions };
}

describe('undoWithGuard（F5：外部改动不静默覆盖）', () => {
  it('无外部冲突：dryRun 后直接真撤销（两次调用：preview + 真 undo）', async () => {
    const { api, undo } = makeApi(false);
    const controller = createController(new AppStore(), api);
    const result = await controller.undoWithGuard('s1');
    expect(result).toEqual({ blocked: false, externallyModified: 0 });
    expect(undo).toHaveBeenNthCalledWith(1, 's1', { dryRun: true });
    expect(undo).toHaveBeenNthCalledWith(2, 's1', {});
  });

  it('有外部改动且未决定：拦截，**不执行真撤销**（只调用 dryRun 一次）', async () => {
    const { api, undo } = makeApi(true);
    const controller = createController(new AppStore(), api);
    const result = await controller.undoWithGuard('s1');
    expect(result).toEqual({ blocked: true, externallyModified: 1 });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith('s1', { dryRun: true });
  });

  it('用户显式 abort：仍拦截（等同未决定）', async () => {
    const { api, undo } = makeApi(true);
    const controller = createController(new AppStore(), api);
    const result = await controller.undoWithGuard('s1', { decision: 'abort' });
    expect(result?.blocked).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('用户显式 overwrite：放行并真正恢复', async () => {
    const { api, undo } = makeApi(true);
    const controller = createController(new AppStore(), api);
    const result = await controller.undoWithGuard('s1', { decision: 'overwrite' });
    expect(result).toEqual({ blocked: false, externallyModified: 1 });
    expect(undo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenNthCalledWith(2, 's1', {});
  });

  it('n 透传（可支持粒度撤销）', async () => {
    const { api, undo } = makeApi(false);
    const controller = createController(new AppStore(), api);
    await controller.undoWithGuard('s1', { n: 2 });
    expect(undo).toHaveBeenNthCalledWith(1, 's1', { n: 2, dryRun: true });
    expect(undo).toHaveBeenNthCalledWith(2, 's1', { n: 2 });
  });

  it('失败：报错进 statusDetail，返回 undefined（不谎报已撤销）', async () => {
    const store = new AppStore();
    const api = {
      undo: vi.fn(async () => {
        throw new Error('服务错误');
      }),
    } as unknown as Harness2Api;
    const controller = createController(store, api);
    const result = await controller.undoWithGuard('s1');
    expect(result).toBeUndefined();
    expect(store.getState().statusDetail?.error).toContain('撤销失败');
  });
});
