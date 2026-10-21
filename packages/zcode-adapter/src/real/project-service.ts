import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    /**
     * 左侧「新建任务/新建对话」入口：返回 app 管理的对话工作区并确保目录存在。
     * 项目选择暂未实现（projectId 原样回传，不读项目表）。
     */
    async prepareSession(params?: { projectId?: string; hostId?: string }): Promise<unknown> {
      const base = process.env.ZCODE_DATA_BASE_DIR ?? homedir();
      const workspacePath = base.endsWith('.zcode')
        ? join(base, 'workspace', 'default')
        : join(base, '.zcode', 'workspace', 'default');
      mkdirSync(workspacePath, { recursive: true });
      return {
        workspacePath,
        projectId: params?.projectId ?? null,
        additionalDirectories: [],
      };
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
