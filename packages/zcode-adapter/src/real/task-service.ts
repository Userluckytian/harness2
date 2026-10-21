import { createStubService } from '../stub-factory.js';
import { Event } from '@zcode/rpc';
import {
  createSessionManager,
  defaultSessionsRoot,
  loadConfig,
  createProvider,
  runTurn,
  resolveHarness2Home,
} from './core-bridge.js';
import { MockProvider } from './core-bridge.js';
import type { IZCodeTaskService } from '@zcode/services';
import type { MockScript } from '@harness2/core';
import { readSessionMeta, writeSessionMeta } from './task-index.js';
import { buildModelTrajectory } from './trajectory-service.js';
import type { ZCodeTaskMeta } from '@zcode/shared';

export interface TaskServiceOptions {
  dataRoot?: string;
  home?: string;
  useMock?: boolean;
  mockScript?: string;
  emitter?: unknown;
}

export function createTaskService(opts: TaskServiceOptions = {}): IZCodeTaskService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);
  const aborts = new Map<string, AbortController>();

  const defaultMock: MockScript = [{ text: 'Hello from harness2 mock provider.' }];
  let provider: unknown;
  try {
    if (opts.useMock) {
      provider = new MockProvider((opts.mockScript as unknown as MockScript) ?? defaultMock);
    } else {
      const loaded = loadConfig({ root: process.cwd(), home });
      if (loaded.config) {
        provider = createProvider(loaded.config, 'main', {
          authPath: require('node:path').join(home, '.harness2', 'auth.json'),
        });
      } else {
        provider = new MockProvider(defaultMock);
      }
    }
  } catch {
    provider = new MockProvider(defaultMock);
  }

  function cwdOf(workspacePath?: string): string {
    return workspacePath ?? process.cwd();
  }

  function findSummary(taskId: string, workspacePath?: string) {
    const cwd = cwdOf(workspacePath);
    try {
      return manager.list(cwd).find((s: { id: string }) => s.id === taskId) ?? null;
    } catch {
      return null;
    }
  }

  function buildMeta(taskId: string, workspacePath?: string): ZCodeTaskMeta {
    const cwd = cwdOf(workspacePath);
    const summary = findSummary(taskId, workspacePath);
    let dir: string | undefined;
    try {
      dir = manager.locate(taskId, { cwd });
    } catch {
      dir = undefined;
    }
    const meta = dir ? readSessionMeta(dir) : { pinned: false, archived: false, unread: false, unreadAt: undefined };
    const title = summary?.title ?? (summary?.firstUserText || 'New task');
    const now = summary?.mtimeMs ?? Date.now();
    const workspace = summary?.cwd ?? cwd;
    const result: ZCodeTaskMeta = {
      taskId,
      traceId: 'harness2' as unknown as ZCodeTaskMeta['traceId'],
      title,
      workspacePath: workspace,
      createdAt: now,
      updatedAt: now,
      mode: 'default' as ZCodeTaskMeta['mode'],
    };
    if (meta.unreadAt !== undefined) result.unreadAt = meta.unreadAt;
    return result;
  }

  function listArchived(workspacePath?: string): ZCodeTaskMeta[] {
    const cwd = cwdOf(workspacePath);
    const out: ZCodeTaskMeta[] = [];
    for (const s of manager.list(cwd)) {
      let dir: string;
      try {
        dir = manager.locate(s.id, { cwd });
      } catch {
        continue;
      }
      const meta = readSessionMeta(dir);
      if (!meta.archived) continue;
      out.push(buildMeta(s.id, workspacePath));
    }
    return out;
  }

  const impl: Record<string, unknown> = {
    async initialize(): Promise<{ available: boolean; version?: string }> {
      return { available: true, version: 'zs2' };
    },
    async createTask(params: { workspacePath?: string; modelSelection?: unknown }): Promise<{ taskId: string }> {
      const cwd = params?.workspacePath ?? process.cwd();
      const created = manager.create(cwd);
      try {
        created.writer.close();
      } catch {}
      return { taskId: created.id };
    },
    async sendPrompt(params: { taskId: string; content: string | unknown }): Promise<void> {
      if (process.env.ZS2_PROBE === '1') console.error('[zs2-probe] task-service.sendPrompt', params?.taskId);
      const id = params.taskId;
      const text = typeof params.content === 'string' ? params.content : JSON.stringify(params.content);
      const resumed = manager.resume(id);
      const ac = new AbortController();
      aborts.set(id, ac);
      try {
        const tools = new (await import('./core-bridge.js')).ToolRegistry();
        await runTurn(resumed.writer, {
          provider: provider as never,
          tools: tools as never,
          cwd: resumed.dir,
          userText: text,
          signal: ac.signal,
          onStream: () => {},
        });
      } finally {
        try {
          resumed.writer.close();
        } catch {}
        aborts.delete(id);
      }
    },
    async stopGeneration(params: { taskId: string }): Promise<void> {
      const ac = aborts.get(params.taskId);
      if (ac) ac.abort();
    },
    async listTasks(): Promise<unknown[]> {
      return manager.list().map((s: { id: string; title?: string; firstUserText?: string }) => ({
        taskId: s.id,
        title: s.title ?? s.firstUserText,
      }));
    },
    async listTaskList(): Promise<{ items: unknown[]; total: number; hasMore: boolean }> {
      return { items: [], total: 0, hasMore: false };
    },
    onDynamicStreamEvent(): unknown {
      return Event.None;
    },
    onDynamicTaskEvent(): unknown {
      return Event.None;
    },
    onDynamicTaskTerminalOutcome(): unknown {
      return Event.None;
    },
    onDynamicTaskReady(): unknown {
      return Event.None;
    },

    // ---- 写面（ZS4-T3）----
    async archiveTask(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }): Promise<ZCodeTaskMeta> {
      const cwd = cwdOf(params?.workspacePath);
      const dir = manager.locate(params.taskId, { cwd });
      writeSessionMeta(dir, { archived: true });
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async unarchiveTask(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }): Promise<ZCodeTaskMeta> {
      const cwd = cwdOf(params?.workspacePath);
      const dir = manager.locate(params.taskId, { cwd });
      writeSessionMeta(dir, { archived: false });
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async deleteTask(params: { taskId: string; workspacePath?: string; workspaceIdentity?: string }): Promise<void> {
      const cwd = cwdOf(params?.workspacePath);
      manager.deleteSession(params.taskId, { cwd });
    },
    async renameTask(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      title: string;
    }): Promise<ZCodeTaskMeta> {
      const cwd = cwdOf(params?.workspacePath);
      manager.rename(params.taskId, params.title, { cwd, source: 'manual' });
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async setTaskPinned(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      pinned: boolean;
    }): Promise<ZCodeTaskMeta> {
      const cwd = cwdOf(params?.workspacePath);
      const dir = manager.locate(params.taskId, { cwd });
      writeSessionMeta(dir, { pinned: params.pinned });
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async setTaskUnread(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      unread: boolean;
      expectedUnreadAt?: number;
    }): Promise<ZCodeTaskMeta> {
      const cwd = cwdOf(params?.workspacePath);
      const dir = manager.locate(params.taskId, { cwd });
      const current = readSessionMeta(dir);
      if (!params.unread && typeof params.expectedUnreadAt === 'number') {
        if (current.unreadAt === params.expectedUnreadAt) {
          writeSessionMeta(dir, { unread: false, unreadAt: undefined });
        }
        return buildMeta(params.taskId, params?.workspacePath);
      }
      if (params.unread) {
        writeSessionMeta(dir, { unread: true, unreadAt: Date.now() });
      } else {
        writeSessionMeta(dir, { unread: false, unreadAt: undefined });
      }
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async getTaskMeta(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }): Promise<ZCodeTaskMeta | null> {
      const cwd = cwdOf(params?.workspacePath);
      try {
        manager.locate(params.taskId, { cwd });
      } catch {
        return null;
      }
      return buildMeta(params.taskId, params?.workspacePath);
    },
    async listArchivedTasks(params: { workspacePath?: string; workspaceIdentity?: string }): Promise<ZCodeTaskMeta[]> {
      return listArchived(params?.workspacePath);
    },
    async getModelTrajectory(params: { taskId: string; limit?: number }): Promise<unknown> {
      return buildModelTrajectory(manager, params.taskId, params.limit);
    },
    async deleteArchivedTask(params: {
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }): Promise<boolean> {
      const cwd = cwdOf(params?.workspacePath);
      let dir: string;
      try {
        dir = manager.locate(params.taskId, { cwd });
      } catch {
        return false;
      }
      const meta = readSessionMeta(dir);
      if (!meta.archived) return false;
      manager.deleteSession(params.taskId, { cwd });
      return true;
    },
    async deleteArchivedTasks(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      taskIds: string[];
    }): Promise<{ deletedTaskIds: string[]; skippedTaskIds: string[]; failedTaskIds: string[] }> {
      const result = { deletedTaskIds: [] as string[], skippedTaskIds: [] as string[], failedTaskIds: [] as string[] };
      const ids = [...new Set(params?.taskIds ?? [])];
      if (ids.length === 0) return result;
      for (const taskId of ids) {
        try {
          const ok = await (impl.deleteArchivedTask as (p: unknown) => Promise<boolean>)({
            taskId,
            workspacePath: params?.workspacePath,
            workspaceIdentity: params?.workspaceIdentity,
          });
          if (ok) result.deletedTaskIds.push(taskId);
          else result.skippedTaskIds.push(taskId);
        } catch {
          result.failedTaskIds.push(taskId);
        }
      }
      return result;
    },
  };

  return createStubService<IZCodeTaskService>({
    channelName: 'zcode-task',
    classification: 'B',
    impl,
  });
}
