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

export interface TaskServiceOptions {
  dataRoot?: string;
  home?: string;
  useMock?: boolean;
  mockScript?: string;
}

export function createTaskService(opts: TaskServiceOptions = {}): IZCodeTaskService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);
  const aborts = new Map<string, AbortController>();

  const defaultMock: MockScript = [
    { text: 'Hello from harness2 mock provider.' },
  ];
  let provider: unknown;
  try {
    if (opts.useMock) {
      provider = new MockProvider((opts.mockScript as unknown as MockScript) ?? defaultMock);
    } else {
      const loaded = loadConfig({ root: process.cwd(), home });
      if (loaded.config) {
        provider = createProvider(loaded.config, 'main', {
          authPath: (loaded as { paths?: { globalAuth: string } }).paths?.globalAuth ?? '',
        });
      } else {
        provider = new MockProvider(defaultMock);
      }
    }
  } catch {
    provider = new MockProvider(defaultMock);
  }

  const impl: Record<string, unknown> = {
    async initialize(): Promise<{ available: boolean; version?: string }> {
      return { available: true, version: 'zs2' };
    },
    async createTask(params: { workspacePath?: string; modelSelection?: unknown }): Promise<{ taskId: string }> {
      const cwd = params?.workspacePath ?? process.cwd();
      const created = manager.create(cwd);
      return { taskId: created.id };
    },
    async sendPrompt(params: { taskId: string; content: string | unknown }): Promise<void> {
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
        aborts.delete(id);
      }
    },
    async stopGeneration(params: { taskId: string }): Promise<void> {
      const ac = aborts.get(params.taskId);
      if (ac) ac.abort();
    },
    async listTasks(): Promise<unknown[]> {
      return manager.list().map((s: { id: string; title?: string; firstUserText?: string }) => ({ taskId: s.id, title: s.title ?? s.firstUserText }));
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
  };

  return createStubService<IZCodeTaskService>({
    channelName: 'zcode-task',
    classification: 'B',
    impl,
  });
}
