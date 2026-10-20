import {
  defaultSessionsRoot,
  SessionManager,
  loadConfig,
  defaultConfigPaths,
  createProvider,
  redactSecrets,
  readAuthFile,
  runTurn,
  ToolRegistry,
} from '@harness2/core';

import type { HarnessConfig, ChatProvider, SessionWriter, SessionAppender, ToolRegistry as ToolRegistryType } from '@harness2/core';

export {
  defaultSessionsRoot,
  SessionManager,
  loadConfig,
  defaultConfigPaths,
  createProvider,
  redactSecrets,
  readAuthFile,
  runTurn,
  ToolRegistry,
};

export type { HarnessConfig, ChatProvider, SessionWriter, SessionAppender };
export type { ToolRegistry as ToolRegistryType } from '@harness2/core';

export function resolveSessionsRoot(homeOverride?: string): string {
  return defaultSessionsRoot(homeOverride);
}

export function createSessionManager(root?: string, homeOverride?: string): SessionManager {
  return new SessionManager(root ?? defaultSessionsRoot(homeOverride));
}
