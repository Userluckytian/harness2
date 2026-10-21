import { createStubService } from '../stub-factory.js';
import type { IProjectService } from '@zcode/services';

interface TrackedTask {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  createdAt: number;
}

const tracked: TrackedTask[] = [];

export function trackCreatedTask(taskId: string, workspacePath: string, workspaceIdentity?: string): void {
  if (tracked.some((t) => t.taskId === taskId)) return;
  tracked.push({ taskId, workspacePath, workspaceIdentity, createdAt: Date.now() });
}

export function createProjectService(): IProjectService {
  const impl = {
    async readTree(_params?: {
      includeDeleted?: boolean;
      includeDeletedTasks?: boolean;
      hostId?: string;
    }): Promise<unknown> {
      const tasks = tracked.map((t) => ({
        taskId: t.taskId,
        traceId: 'zs2',
        title: 'New task',
        workspacePath: t.workspacePath,
        ...(t.workspaceIdentity ? { workspaceIdentity: t.workspaceIdentity } : {}),
        createdAt: t.createdAt,
        updatedAt: t.createdAt,
        mode: 'build',
        hostId: 'local',
        projectId: null,
        pinned: false,
        archived: false,
      }));
      return { projects: [], tasks, deletedTasks: [] };
    },
    async readProjects(): Promise<unknown[]> {
      return [];
    },
    async resolveSessionDirectories(task: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId: string;
    }): Promise<unknown> {
      return {
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        additionalDirectories: [],
        projectId: null,
      };
    },
  };
  return createStubService<IProjectService>({
    channelName: 'project',
    classification: 'B',
    impl: impl as Record<string, unknown>,
  });
}
