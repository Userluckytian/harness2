// preload 桥：contextBridge 暴露 window.harness2 —— 渲染进程零 Node 的唯一出口。
// 只透传 ipcRenderer.invoke 与两个事件频道；不暴露任何 Node 能力（sandbox 安全）。
// 注意：sandbox 模式的 preload 不允许 require 相对模块——IPC 通道名在此内联，
// 与 shared/protocol.ts 保持一致（test/protocol.test.ts 有静态一致性校验）。
import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConnectionStatus,
  Harness2Api,
  StatusDetail,
  WsFrame,
} from '../shared/protocol.js';

const IPC_INVOKE = 'harness2:invoke';
const IPC_EVENT = 'harness2:event';
const IPC_STATUS = 'harness2:status';

const api: Harness2Api = {
  listSessions: (cwd?: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'listSessions', cwd }),
  createSession: (cwd?: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'createSession', cwd }),
  events: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'events', sessionId }),
  undo: (sessionId: string, opts?: { n?: number; dryRun?: boolean }) =>
    ipcRenderer.invoke(IPC_INVOKE, { cmd: 'undo', sessionId, ...opts }),
  redo: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'redo', sessionId }),
  subscribe: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'subscribe', sessionId }),
  unsubscribe: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'unsubscribe', sessionId }),
  sendMessage: (sessionId: string, text: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'sendMessage', sessionId, text }),
  abort: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'abort', sessionId }),
  respondApproval: (requestId: string, decision: 'allow' | 'deny') =>
    ipcRenderer.invoke(IPC_INVOKE, { cmd: 'respondApproval', requestId, decision }),
  loadLayout: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'loadLayout' }),
  saveLayout: (layout: unknown) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'saveLayout', layout }),
  getStatus: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'getStatus' }),
  settingsGetConfig: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:getConfig' }),
  settingsUpdateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:updateConfig', patch }),
  settingsGetAuthMasked: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:getAuthMasked' }),
  settingsUpdateAuth: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:updateAuth', patch }),
  settingsGetPreferences: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:getPreferences' }),
  settingsSetPreferences: (preferences: unknown) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:setPreferences', preferences }),
  settingsGetDoctorReport: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:getDoctorReport' }),
  settingsGetCrashReports: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'settings:getCrashReports' }),
  gitBranch: (dir: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'gitBranch', dir }),
  getContextUsage: (sessionId: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'getContextUsage', sessionId }),
  readFileForRef: (path: string, cwd: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'readFileForRef', path, cwd }),
  notify: (title: string, body: string, sessionId?: string) => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'notify', title, body, sessionId }),
  metadataGet: () => ipcRenderer.invoke(IPC_INVOKE, { cmd: 'metadata:get' }),
  metadataSet: (id: string, patch: { title?: string; archived?: boolean; deleted?: boolean }) =>
    ipcRenderer.invoke(IPC_INVOKE, { cmd: 'metadata:set', id, patch }),
  onEvent: (listener: (frame: WsFrame) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, frame: WsFrame): void => listener(frame);
    ipcRenderer.on(IPC_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, wrapped);
    };
  },
  onConnectionStatus: (listener: (status: ConnectionStatus, detail?: StatusDetail) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, status: ConnectionStatus, detail?: StatusDetail): void =>
      listener(status, detail);
    ipcRenderer.on(IPC_STATUS, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_STATUS, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('harness2', api);
