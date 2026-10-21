import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStubService } from '../stub-factory.js';
import { createSessionManager, defaultSessionsRoot } from './core-bridge.js';
import { readSessionMeta } from './task-index.js';
import type { IProjectService } from '@zcode/services';

// 任务列表的唯一事实源是磁盘会话日志；不再维护进程内 tracked 数组（无界增长且重启必空）。

export function createProjectService(options: { home?: string } = {}): IProjectService {
  const home = options.home ?? process.env.HARNESS2_HOME ?? homedir();
  const manager = createSessionManager(defaultSessionsRoot(home));
  const impl = {
    async readTree(params?: {
      includeDeleted?: boolean;
      includeDeletedTasks?: boolean;
      hostId?: string;
    }): Promise<unknown> {
      const includeArchived = params?.includeDeleted === true || params?.includeDeletedTasks === true;
      // 重启后 tracked 内存数组必空；任务列表的唯一事实源是磁盘会话日志。
      const tasks = manager
        .list()
        .map((s) => {
          const meta = readSessionMeta(s.dir);
          return {
            taskId: s.id,
            traceId: 'harness2',
            title: s.title ?? (s.firstUserText || 'New task'),
            workspacePath: s.cwd ?? process.cwd(),
            createdAt: s.mtimeMs,
            updatedAt: s.mtimeMs,
            mode: 'build',
            hostId: 'local',
            projectId: null,
            pinned: meta.pinned,
            archived: meta.archived,
          };
        })
        .filter((t) => (includeArchived ? true : !(t as { archived: boolean }).archived));
      // pinned 优先 → mtime 倒序
      tasks.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
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
