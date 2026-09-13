// PD1（D-P2）：redo 冲突守卫 —— undo 已有守卫，redo 同口径。
// 契约现状（冻结区）：core serve `/redo` 不接受 dryRun 参数（http.ts 直接 hub.redo(id)），
// 桌面侧无法像 undo 那样拿 core 的比对报告；redo 的冲突基准 =「该次 undo 实际恢复到的内容」
// （core change-review.ts：redo 期望 = 最早 before，即 undo 基线）。本端真 undo 的响应里
// 恰好带 per-file target —— 守卫用它作基线，对照 change-review 实时 current 比对。
// 红线：冲突阻止 + 可行动提示（不静默重放）；显式 overwrite 才放行；undo 语义零改动。
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import { summarizeRedoConflict } from '../src/renderer/features/workspace/change-review-model.js';
import type { ChangeSetShape, Harness2Api, UndoRedoResponseShape } from '../src/shared/protocol.js';

const realUndoRes = (file: string, target: string | null): UndoRedoResponseShape => ({
  results: [
    {
      kind: 'undo',
      dryRun: false,
      markerSeq: 6,
      rewindToSeq: 4,
      messages: 1,
      files: [{ file, target, externallyModified: false }],
    },
  ],
});

const changeSetWithCurrent = (file: string, current: string | null): ChangeSetShape => ({
  sourceDir: '/s',
  files: [
    {
      file,
      planned: { before: null, after: 'BASE' },
      current,
      lastKnown: 'BASE',
      dirty: current !== 'BASE',
      matchesPlan: current === 'BASE',
    },
  ],
  changedFiles: 1,
  dirtyFiles: current !== 'BASE' ? 1 : 0,
  readOnly: true,
});

interface ApiSpy {
  api: Harness2Api;
  undo: ReturnType<typeof vi.fn>;
  redo: ReturnType<typeof vi.fn>;
  changeReview: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
}

function makeApi(current: string | null): ApiSpy {
  const undo = vi.fn(async (_id: string, opts?: { dryRun?: boolean }) =>
    opts?.dryRun === true
      ? ({
          results: [{ kind: 'undo', dryRun: true, markerSeq: 6, rewindToSeq: 4, messages: 1, files: [] }],
        } as UndoRedoResponseShape)
      : realUndoRes('/w/a.txt', 'BASE'),
  );
  const redo = vi.fn(async (_id: string) => ({ results: [] }) as UndoRedoResponseShape);
  const changeReview = vi.fn(async (_id: string) => changeSetWithCurrent('/w/a.txt', current));
  const listSessions = vi.fn(async () => []);
  const api = { undo, redo, changeReview, listSessions } as unknown as Harness2Api;
  return { api, undo, redo, changeReview, listSessions };
}

describe('redoWithGuard（PD1：外部改动不静默重放）', () => {
  it('无外部改动：真 undo 后 redo 直接放行（api.redo 恰一次）', async () => {
    const { api, redo } = makeApi('BASE');
    const controller = createController(new AppStore(), api);
    await controller.undoWithGuard('s1'); // 干净 undo：真撤销建立基线
    const result = await controller.redoWithGuard('s1');
    expect(result).toEqual({ blocked: false, externallyModified: 0 });
    expect(redo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledWith('s1');
  });

  it('undo 后文件被外部修改：redo 被阻止，不调 api.redo（冲突数 + reason=conflict）', async () => {
    const { api, redo, changeReview } = makeApi('HUMAN-EDIT');
    const controller = createController(new AppStore(), api);
    await controller.undoWithGuard('s1');
    const result = await controller.redoWithGuard('s1');
    expect(result).toEqual({ blocked: true, externallyModified: 1, reason: 'conflict' });
    expect(changeReview).toHaveBeenCalledTimes(1); // 比对用实时磁盘视图
    expect(redo).not.toHaveBeenCalled(); // 未决定前绝不重放
  });

  it('显式 overwrite：放行并真正 redo；基线随重做消费（再 redo = 无基线 fail-closed）', async () => {
    const { api, redo } = makeApi('HUMAN-EDIT');
    const controller = createController(new AppStore(), api);
    await controller.undoWithGuard('s1');
    const result = await controller.redoWithGuard('s1', { decision: 'overwrite' });
    expect(result).toEqual({ blocked: false, externallyModified: 1 });
    expect(redo).toHaveBeenCalledTimes(1);
    const again = await controller.redoWithGuard('s1');
    expect(again).toEqual({ blocked: true, externallyModified: 0, reason: 'no-baseline' });
    expect(redo).toHaveBeenCalledTimes(1); // 未新增重放
  });

  it('本端没有 undo 基线（未经过本端 undo）：fail-closed 阻止且不调 api.redo', async () => {
    const { api, redo, changeReview } = makeApi('BASE');
    const controller = createController(new AppStore(), api);
    const result = await controller.redoWithGuard('s1');
    expect(result).toEqual({ blocked: true, externallyModified: 0, reason: 'no-baseline' });
    expect(changeReview).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it('undoSession（旧入口）执行的真 undo 同样记录基线（冲突时同样拦截）', async () => {
    const { api, redo } = makeApi('HUMAN-EDIT');
    const controller = createController(new AppStore(), api);
    await controller.undoSession('s1');
    const result = await controller.redoWithGuard('s1');
    expect(result).toEqual({ blocked: true, externallyModified: 1, reason: 'conflict' });
    expect(redo).not.toHaveBeenCalled();
  });

  it('redo 失败：报错进 statusDetail，返回 undefined（不谎报已重做）', async () => {
    const store = new AppStore();
    const { api } = makeApi('BASE');
    (api as unknown as { redo: ReturnType<typeof vi.fn> }).redo = vi.fn(async () => {
      throw new Error('服务错误');
    });
    const controller = createController(store, api);
    await controller.undoWithGuard('s1');
    const result = await controller.redoWithGuard('s1');
    expect(result).toBeUndefined();
    expect(store.getState().statusDetail?.error).toContain('重做失败');
  });
});

describe('summarizeRedoConflict（纯逻辑锚点）', () => {
  const baseline = [
    { file: '/w/a.txt', target: 'BASE' as string | null },
    { file: '/w/gone.txt', target: null },
  ];

  it('current == target 全部一致 → 无冲突', () => {
    const set = {
      sourceDir: '/s',
      files: [
        {
          file: '/w/a.txt',
          planned: { before: null, after: 'BASE' },
          current: 'BASE',
          lastKnown: 'BASE',
          dirty: false,
          matchesPlan: true,
        },
        {
          file: '/w/gone.txt',
          planned: { before: 'x', after: 'BASE' },
          current: null,
          lastKnown: 'BASE',
          dirty: true,
          matchesPlan: false,
        },
      ],
      changedFiles: 2,
      dirtyFiles: 1,
      readOnly: true,
    } as ChangeSetShape;
    expect(summarizeRedoConflict(set, baseline)).toEqual({ externallyModified: 0, files: [] });
  });

  it('current ≠ target（含视图缺失的基线文件）→ 计入冲突（fail-closed）', () => {
    const set = {
      sourceDir: '/s',
      files: [
        {
          file: '/w/a.txt',
          planned: { before: null, after: 'BASE' },
          current: 'HUMAN',
          lastKnown: 'BASE',
          dirty: true,
          matchesPlan: false,
        },
      ],
      changedFiles: 1,
      dirtyFiles: 1,
      readOnly: true,
    } as ChangeSetShape;
    const summary = summarizeRedoConflict(set, baseline);
    expect(summary.externallyModified).toBe(2); // a.txt 被改 + gone.txt 无法核实
    expect(summary.files).toEqual(['/w/a.txt', '/w/gone.txt']);
  });
});
