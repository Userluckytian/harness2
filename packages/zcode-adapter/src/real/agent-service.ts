import { createStubService } from '../stub-factory.js';
import { Event } from '@zcode/rpc';
import type { IZCodeAgentService } from '@zcode/services';

export interface AgentServiceOptions {
  dataRoot?: string;
  home?: string;
}

export function createAgentService(opts: AgentServiceOptions = {}): IZCodeAgentService {
  const impl: Record<string, unknown> = {
    async helloConversationV4(): Promise<unknown> {
      return {
        connectionId: 'zs2',
        clientMode: 'desktop-continuous',
        deliveryProfile: 'continuous',
        capabilities: {},
      };
    },
    async initializeConversationV4(): Promise<unknown> {
      return { ok: true };
    },
    async subscribeConversationV4(params: { sessionId?: string }): Promise<unknown> {
      return {
        ack: { subscriptionId: `zs2-${params?.sessionId ?? 'default'}`, mode: 'snapshot', logEpoch: 'zs2-epoch' },
      };
    },
    async resyncConversationV4(): Promise<unknown> {
      return {
        ack: { subscriptionId: 'zs2', mode: 'snapshot', logEpoch: 'zs2-epoch' },
      };
    },
    async unsubscribeConversationV4(): Promise<void> {},
    async sendConversationCommandV4(): Promise<unknown> {
      return { ok: true };
    },
    async conversationRowsRangeV4(): Promise<unknown> {
      return { rows: [], hasMore: false };
    },
    async conversationPlansV4(): Promise<unknown> {
      return { plans: [] };
    },
    onDynamicConversationFrame(): unknown {
      return Event.None;
    },
    onDynamicSessionsIndexFrame(): unknown {
      return Event.None;
    },
    async syncAppRuntimePreferences(): Promise<void> {},
    async prepareStorage(): Promise<void> {},
    async getStorageStartupState(): Promise<{ ready: boolean }> {
      return { ready: true };
    },
    async initialize(): Promise<{ available: boolean }> {
      return { available: true };
    },
    async createSession(params: { workspacePath?: string }): Promise<unknown> {
      return { sessionId: `zs2-${Date.now()}` };
    },
    async resumeSession(params: { sessionId: string }): Promise<unknown> {
      return { sessionId: params.sessionId };
    },
    async listSessions(): Promise<unknown[]> {
      return [];
    },
    async listSessionSubagents(): Promise<unknown> {
      return { sessions: [] };
    },
    async readSession(): Promise<unknown> {
      return {};
    },
    async readSessionMessages(): Promise<unknown[]> {
      return [];
    },
    async readSessionEvents(): Promise<unknown[]> {
      return [];
    },
    async readSessionDebug(): Promise<unknown> {
      return {};
    },
    async sendPrompt(): Promise<void> {},
    async compactSession(): Promise<void> {},
    async goalSession(): Promise<void> {},
    async closeSession(): Promise<boolean> {
      return true;
    },
    async setModel(): Promise<unknown> {
      return {};
    },
    async setThoughtLevel(): Promise<unknown> {
      return {};
    },
    async setMode(): Promise<unknown> {
      return {};
    },
    onDynamicSessionEvent(): unknown {
      return Event.None;
    },
  };

  return createStubService<IZCodeAgentService>({
    channelName: 'zcode-agent',
    classification: 'B',
    impl,
  });
}
