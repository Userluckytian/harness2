import { createStubService } from '../stub-factory.js';
import { createSessionManager, defaultSessionsRoot } from './core-bridge.js';
import { resolveHarness2Home } from './core-bridge.js';
import type { IZCodeSessionService } from '@zcode/services';

export interface SessionServiceOptions {
  dataRoot?: string;
  home?: string;
}

export function createSessionService(opts: SessionServiceOptions = {}): IZCodeSessionService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);

  const impl: Record<string, unknown> = {
    async listSessions(params: { workspacePath?: string }): Promise<unknown[]> {
      const cwd = params?.workspacePath;
      const summaries = manager.list(cwd);
      return summaries.map((s: { id: string; title?: string; firstUserText?: string; mtimeMs: number }) => ({
        sessionId: s.id,
        workspace: cwd ?? '',
        title: s.title ?? s.firstUserText ?? '',
        mode: 'agent',
        status: 'idle',
        model: '',
        createdAt: s.mtimeMs,
        updatedAt: s.mtimeMs,
      }));
    },
    async initializeWorkspace(): Promise<{ available: boolean; workspaceKey: string }> {
      return { available: true, workspaceKey: 'harness2' };
    },
    async getWorkspaceRuntimeIdentity(): Promise<{ generation: number; identity: string; workspaceKey: string }> {
      return { generation: 1, identity: 'harness2', workspaceKey: 'harness2' };
    },
    async readWorkspacePresentation(): Promise<unknown> {
      return { title: 'harness2' };
    },
    async createSession(params: { sessionId?: string }): Promise<unknown> {
      const created = manager.create(process.cwd());
      return { sessionId: created.id };
    },
    async resumeSession(params: { sessionId: string }): Promise<unknown> {
      const r = manager.resume(params.sessionId);
      return { sessionId: r.id };
    },
    async readSession(params: { sessionId: string }): Promise<unknown> {
      return { sessionId: params.sessionId };
    },
    async readSessionMessages(params: { sessionId: string }): Promise<unknown[]> {
      return [];
    },
    async readSessionEvents(params: { sessionId: string }): Promise<unknown[]> {
      return [];
    },
    async closeSession(params: { sessionId: string }): Promise<void> {},
    async promoteDeferredDraftSession(): Promise<void> {},
    async closeDeferredDraftSession(): Promise<boolean> {
      return true;
    },
  };

  return createStubService<IZCodeSessionService>({
    channelName: 'zcode-session',
    classification: 'B',
    impl: impl as Record<string, unknown>,
  });
}
