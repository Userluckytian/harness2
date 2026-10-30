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
    : typeof __filename !== 'undefined'
      ? __filename
      : 'file:///',
);

function loadCore(): unknown {
  // 1) 常规：@harness2/core 已声明为 workspace 依赖，经 createRequire 按包解析
  //    （测试/开发下另有 tsconfig/vitest alias 指向 core 源，同走此入口）
  try {
    return req('@harness2/core');
  } catch {
    // fall through
  }
  // 2) 兜底：monorepo 根为 cwd 时相对定位 core dist；不再内置任何机器特定绝对路径
  try {
    return req(path.resolve(process.cwd(), 'packages/core/dist/index.js'));
  } catch {
    // fall through
  }
  throw new Error('core-bridge: cannot load @harness2/core');
}

const core = loadCore() as typeof import('@harness2/core', { with: { 'resolution-mode': 'import' } });

export const defaultSessionsRoot = core.defaultSessionsRoot;
export const SessionManager = core.SessionManager;
export const SESSION_ID_PATTERN = core.SESSION_ID_PATTERN;
export const loadConfig = core.loadConfig;
export const defaultConfigPaths = core.defaultConfigPaths;
export const createProvider = core.createProvider;
export const redactSecrets = core.redactSecrets;
export const readAuthFile = core.readAuthFile;
export const writeAuthFile = core.writeAuthFile;
export const runTurn = core.runTurn;
export const loadSession = core.loadSession;
export const SessionWriter = core.SessionWriter;
export const ToolRegistry = core.ToolRegistry;
export const MockProvider = core.MockProvider;
export const extensionEventTypes = core.extensionEventTypes;
export const UserInputQueue = core.UserInputQueue;
export const SkillStore = core.SkillStore;
export const projectSkillsRoot = core.projectSkillsRoot;
export const defaultSkillsRoot = core.defaultSkillsRoot;
export const MemoryStore = core.MemoryStore;
export const defaultMemoriesRoot = core.defaultMemoriesRoot;
/** 模型未声明 contextWindow 时 core 运行时真实生效的兜底容量（ZS4.5c UI 基线同源用） */
export const writeCrashReport = core.writeCrashReport;
export const crashReportDir = core.crashReportDir;
export const formatCrashReport = core.formatCrashReport;
export const crashReportFileName = core.crashReportFileName;
export const noteCrashSessionId = core.noteCrashSessionId;
export const installCrashReporter = core.installCrashReporter;
export const CRASH_DIR_NAME = core.CRASH_DIR_NAME;
/** 模型未声明 contextWindow 时 core 运行时真实生效的兜底容量（ZS4.5c UI 基线同源用） */
export const DEFAULT_CONTEXT_WINDOW: number = core.DEFAULT_CONTEXT_WINDOW;

export type { HarnessConfig, ChatProvider, SessionAppender };
export type SessionWriter = SessionWriterType;
export type ToolRegistryTypeExport = ToolRegistryType;

export function resolveSessionsRoot(homeOverride?: string): string {
  return defaultSessionsRoot(homeOverride);
}

export function createSessionManager(root?: string, homeOverride?: string): InstanceType<typeof SessionManager> {
  return new SessionManager(root ?? defaultSessionsRoot(homeOverride));
}
