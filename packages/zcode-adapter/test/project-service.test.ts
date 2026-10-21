import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectService } from '../src/real/project-service.js';

describe('project-service readTree', () => {
  it('filters archived by default and includes when requested', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ps-'));
    const mgr: any = new (await import('../src/real/core-bridge.js')).SessionManager(
      (await import('../src/real/core-bridge.js')).defaultSessionsRoot(home),
    );
    const created = mgr.create(process.cwd());
    created.writer.close();
    // archive via sidecar
    const { writeSessionMeta } = await import('../src/real/task-index.js');
    writeSessionMeta(created.dir, { archived: true });
    const svc: any = createProjectService({ home });
    const tree1: any = await svc.readTree();
    expect(tree1.tasks.find((t: any) => t.taskId === created.id)).toBeUndefined();
    const tree2: any = await svc.readTree({ includeDeleted: true });
    expect(tree2.tasks.find((t: any) => t.taskId === created.id)).toBeDefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('title priority title.json over firstUserText', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ps-'));
    const mgr: any = new (await import('../src/real/core-bridge.js')).SessionManager(
      (await import('../src/real/core-bridge.js')).defaultSessionsRoot(home),
    );
    const created = mgr.create(process.cwd());
    created.writer.close();
    mgr.rename(created.id, 'Manual Title', { cwd: process.cwd() });
    const svc: any = createProjectService({ home });
    const tree: any = await svc.readTree();
    const t = tree.tasks.find((x: any) => x.taskId === created.id);
    expect(t.title).toBe('Manual Title');
    rmSync(home, { recursive: true, force: true });
  });
});
