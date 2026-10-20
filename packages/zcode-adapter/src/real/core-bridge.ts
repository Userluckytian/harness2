import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export function resolveHarness2Home(): string {
  if (process.env.HARNESS2_HOME) return process.env.HARNESS2_HOME;
  return homedir();
}

import type {
  HarnessConfig,
  ChatProvider,
  SessionWriter as SessionWriterType,
  SessionAppender,
  ToolRegistry as ToolRegistryType,
} from '@harness2/core';

const req = createRequire(
  typeof import.meta !== 'undefined' && import.meta.url
    ? import.meta.url
    : (typeof __filename !== 'undefined' ? __filename : 'file:///'),
);

function loadCore(): any {
  // 1) 测试/开发：@harness2/core 已通过 tsconfig/vitest alias 解析
  try {
    return req('@harness2/core');
  } catch {
    // fall through
  }
  // 2) host bundle 运行时：core dist 相对 bundle 位置
  const candidates = [
    path.resolve(process.cwd(), 'packages/core/dist/index.js'),
    'D:/AI_Projects/harness2/packages/core/dist/index.js',
  ];
  for (const c of candidates) {
    try {
      return req(c);
    } catch {
      // try next
    }
  }
  throw new Error('core-bridge: cannot load @harness2/core');
}

const core: any = loadCore();

export const defaultSessionsRoot = core.defaultSessionsRoot;
export const SessionManager = core.SessionManager;
export const loadConfig = core.loadConfig;
export const defaultConfigPaths = core.defaultConfigPaths;
export const createProvider = core.createProvider;
export const redactSecrets = core.redactSecrets;
export const readAuthFile = core.readAuthFile;
export const runTurn = core.runTurn;
export const loadSession = core.loadSession;
export const SessionWriter = core.SessionWriter;
export const ToolRegistry = core.ToolRegistry;
export const MockProvider = core.MockProvider;

export type { HarnessConfig, ChatProvider, SessionAppender };
export type SessionWriter = SessionWriterType;
export type ToolRegistryTypeExport = ToolRegistryType;

export function resolveSessionsRoot(homeOverride?: string): string {
  return defaultSessionsRoot(homeOverride);
}

export function createSessionManager(root?: string, homeOverride?: string): InstanceType<typeof SessionManager> {
  return new SessionManager(root ?? defaultSessionsRoot(homeOverride));
}
