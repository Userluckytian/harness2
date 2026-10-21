import { describe, it, expect } from 'vitest';
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
