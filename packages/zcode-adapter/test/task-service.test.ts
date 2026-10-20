import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskService } from '../src/real/task-service.js';

describe('task-service sendPrompt twice (P1-3)', () => {
  it('does not throw SessionLocked on second sendPrompt same session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-ts-'));
    process.env.HARNESS2_HOME = home;
    const svc = createTaskService({ home, useMock: true });
    const created: any = await (svc as any).createTask({ workspacePath: process.cwd() });
    const id = created.taskId;
    await (svc as any).sendPrompt({ taskId: id, content: 'hi' });
    await (svc as any).sendPrompt({ taskId: id, content: 'hi again' });
    rmSync(home, { recursive: true, force: true });
  }, 30000);
});
