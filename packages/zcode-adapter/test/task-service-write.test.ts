import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskService } from '../src/real/task-service.js';
import { createProjectService } from '../src/real/project-service.js';
import { SessionWriter } from '../src/real/core-bridge.js';

describe('task-service write surface', () => {
  it('archive -> readTree excludes, listArchived includes; unarchive reverses', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const id = created.taskId;
    const ws = process.cwd();
    await svc.archiveTask({ taskId: id, workspacePath: ws });
    const projectSvc: any = createProjectService({ home });
    const tree: any = await projectSvc.readTree();
    expect(tree.tasks.find((t: any) => t.taskId === id)).toBeUndefined();
    const archived: any = await svc.listArchivedTasks({ workspacePath: ws });
    expect(archived.find((t: any) => t.taskId === id)).toBeDefined();
    await svc.unarchiveTask({ taskId: id, workspacePath: ws });
    const tree2: any = await projectSvc.readTree();
    expect(tree2.tasks.find((t: any) => t.taskId === id)).toBeDefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('pin affects readTree ordering', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    await svc.createTask({ workspacePath: process.cwd() });
    const b: any = await svc.createTask({ workspacePath: process.cwd() });
    const ws = process.cwd();
    await svc.setTaskPinned({ taskId: b.taskId, workspacePath: ws, pinned: true });
    const projectSvc: any = createProjectService({ home });
    const tree: any = await projectSvc.readTree();
    expect(tree.tasks[0].taskId).toBe(b.taskId);
    expect(tree.tasks[0].pinned).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('rename updates title in readTree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const id = created.taskId;
    const ws = process.cwd();
    await svc.renameTask({ taskId: id, workspacePath: ws, title: 'Renamed Title' });
    const projectSvc: any = createProjectService({ home });
    const tree: any = await projectSvc.readTree();
    const t = tree.tasks.find((x: any) => x.taskId === id);
    expect(t.title).toBe('Renamed Title');
    rmSync(home, { recursive: true, force: true });
  });

  it('deleteTask removes session from list', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const id = created.taskId;
    const ws = process.cwd();
    await svc.deleteTask({ taskId: id, workspacePath: ws });
    const projectSvc: any = createProjectService({ home });
    const tree: any = await projectSvc.readTree();
    expect(tree.tasks.find((t: any) => t.taskId === id)).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('deleteArchivedTasks counts deleted/skipped/failed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    const ws = process.cwd();
    // normal archived -> deleted
    const a: any = await svc.createTask({ workspacePath: ws });
    await svc.archiveTask({ taskId: a.taskId, workspacePath: ws });
    // unarchived -> skipped
    const b: any = await svc.createTask({ workspacePath: ws });
    // archived + locked -> failed
    const c: any = await svc.createTask({ workspacePath: ws });
    await svc.archiveTask({ taskId: c.taskId, workspacePath: ws });
    // hold lock on c
    const { defaultSessionsRoot, SessionManager } = await import('../src/real/core-bridge.js');
    const mgr = new SessionManager(defaultSessionsRoot(home));
    const sessionDir = mgr.locate(c.taskId, { cwd: ws });
    const writer = SessionWriter.open(sessionDir, { fsync: false });

    const res: any = await svc.deleteArchivedTasks({
      workspacePath: ws,
      taskIds: [a.taskId, b.taskId, c.taskId],
    });
    expect(res.deletedTaskIds).toContain(a.taskId);
    expect(res.skippedTaskIds).toContain(b.taskId);
    expect(res.failedTaskIds).toContain(c.taskId);

    writer.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('invalid taskId throws invalid session id for all write ops (T8)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-invalid-'));
    const svc: any = createTaskService({ home, useMock: true });
    const ws = process.cwd();
    const invalidIds = ['../evil', 'a/b', '..%2f', ''];
    const { SessionManager } = await import('../src/real/core-bridge.js');
    const spy = vi.spyOn(SessionManager.prototype, 'locate');

    for (const id of invalidIds) {
      await expect(svc.archiveTask({ taskId: id, workspacePath: ws })).rejects.toThrow(/invalid session id/);
      await expect(svc.unarchiveTask({ taskId: id, workspacePath: ws })).rejects.toThrow(/invalid session id/);
      await expect(svc.renameTask({ taskId: id, workspacePath: ws, title: 'x' })).rejects.toThrow(/invalid session id/);
      await expect(svc.deleteTask({ taskId: id, workspacePath: ws })).rejects.toThrow(/invalid session id/);
      await expect(svc.setTaskUnread({ taskId: id, workspacePath: ws, unread: true })).rejects.toThrow(
        /invalid session id/,
      );
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it('renameTask title validation (T8)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-title-'));
    const svc: any = createTaskService({ home, useMock: true });
    const ws = process.cwd();
    const created: any = await svc.createTask({ workspacePath: ws });
    const id = created.taskId;

    await expect(svc.renameTask({ taskId: id, workspacePath: ws, title: 123 as unknown })).rejects.toThrow(
      /invalid title/,
    );
    await expect(svc.renameTask({ taskId: id, workspacePath: ws, title: '' })).rejects.toThrow(/invalid title/);
    await expect(svc.renameTask({ taskId: id, workspacePath: ws, title: '   ' })).rejects.toThrow(/invalid title/);
    await expect(svc.renameTask({ taskId: id, workspacePath: ws, title: 'a'.repeat(201) })).rejects.toThrow(
      /invalid title/,
    );

    // 200 字符合法
    const meta = await svc.renameTask({ taskId: id, workspacePath: ws, title: 'a'.repeat(200) });
    expect(meta).toBeTruthy();
    rmSync(home, { recursive: true, force: true });
  });

  it('setTaskUnread expectedUnreadAt mismatch does not clear', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-tsw-'));
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const id = created.taskId;
    const ws = process.cwd();
    const m1: any = await svc.setTaskUnread({ taskId: id, workspacePath: ws, unread: true });
    const unreadAt = m1.unreadAt;
    expect(typeof unreadAt).toBe('number');
    const m2: any = await svc.setTaskUnread({
      taskId: id,
      workspacePath: ws,
      unread: false,
      expectedUnreadAt: unreadAt + 1,
    });
    expect(m2.unreadAt).toBe(unreadAt);
    const m3: any = await svc.setTaskUnread({
      taskId: id,
      workspacePath: ws,
      unread: false,
      expectedUnreadAt: unreadAt,
    });
    expect(m3.unreadAt).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('window-controller.mutateTask 接线（ZS4-T6：hover 归档/删除路由缺口）', () => {
  it('archive/pin/rename/delete 经 controller 落到 taskService 写面；无 taskService 时保持 throw', async () => {
    const { createWindowControllerService } = await import('../src/root-mount-stubs.js');
    const { windowControllerServiceStub } = await import('../src/root-mount-stubs.js');
    // 旧桩：mutateTask throw（红线⑩：未接线不假成功）
    await expect(windowControllerServiceStub.mutateTask({} as never)).rejects.toThrow(/ZS1: not implemented/);

    const home = mkdtempSync(join(tmpdir(), 'h2-wctl-'));
    const svc: any = createTaskService({ home, useMock: true });
    const created: any = await svc.createTask({ workspacePath: process.cwd() });
    const ws = process.cwd();
    const addr = { taskId: created.taskId, workspacePath: ws };
    const ctrl: any = createWindowControllerService(svc);

    const archMeta: any = await ctrl.mutateTask({ address: addr, mutation: { kind: 'archive', archived: true } });
    expect(archMeta.taskId).toBe(created.taskId);
    const archivedList: any = await svc.listArchivedTasks({ workspacePath: ws });
    expect(archivedList.some((t: any) => t.taskId === created.taskId)).toBe(true);

    await ctrl.mutateTask({ address: addr, mutation: { kind: 'archive', archived: false } });
    const archivedList2: any = await svc.listArchivedTasks({ workspacePath: ws });
    expect(archivedList2.some((t: any) => t.taskId === created.taskId)).toBe(false);

    await ctrl.mutateTask({ address: addr, mutation: { kind: 'pin', pinned: true } });
    const meta: any = await ctrl.getTaskMeta({ address: addr });
    expect(meta.taskId).toBe(created.taskId);

    await ctrl.mutateTask({ address: addr, mutation: { kind: 'rename', title: '改名成功' } });
    const meta2: any = await svc.getTaskMeta({ taskId: created.taskId, workspacePath: ws });
    expect(meta2.title).toBe('改名成功');

    // open/resume 校验型 no-op 回 meta
    const openMeta: any = await ctrl.mutateTask({ address: addr, mutation: { kind: 'open' } });
    expect(openMeta.taskId).toBe(created.taskId);

    await ctrl.mutateTask({ address: addr, mutation: { kind: 'delete' } });
    const meta3: any = await svc.getTaskMeta({ taskId: created.taskId, workspacePath: ws });
    expect(meta3).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
