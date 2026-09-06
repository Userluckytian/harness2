// 主进程桥：IPC 命令分发（渲染端唯一入口）+ 服务 WS 连接（事件帧转发给渲染端）。
// 安全边界：渲染进程零 Node——一切经 ipcRenderer.invoke('harness2:invoke') 到这里，
// 这里只与 127.0.0.1 的本地 serve 通信；WS 帧（含密钥三不约束的脱敏事件）原样转发。
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
  ConnectionStatus,
  InvokeCommand,
  StatusDetail,
  WsFrame,
} from '../shared/protocol.js';
import { readLayout, writeLayout } from './layout-file.js';
import type { ServeManager } from './serve-manager.js';

export interface BridgeDeps {
  serve: ServeManager;
  /** serve 的 --root（工具执行 cwd + 新会话分组；渲染端不感知文件系统） */
  root: string;
  /** 用户数据根（分屏布局持久化 ~/.harness2/desktop-layout.json） */
  home: string;
  /** 渲染窗口 webContents 推送（帧） */
  sendEvent: (frame: WsFrame) => void;
  /** 渲染窗口推送（连接状态） */
  sendStatus: (status: ConnectionStatus, detail?: StatusDetail) => void;
}

export interface Bridge {
  /** 连接（或重连）服务 WS；serve 每次变 ready 后调用 */
  connectWs(): void;
  /** 断开 WS（不触发出错帧） */
  disconnectWs(): void;
  /** IPC invoke 入口（registerBridgeIpc 挂到 ipcMain） */
  handleInvoke(_event: IpcMainInvokeEvent, req: unknown): Promise<unknown>;
}

export class InvokeError extends Error {}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new InvokeError(`服务请求失败: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new InvokeError(`服务响应不是 JSON（status ${res.status}）`);
    }
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `服务错误（status ${res.status}）`;
    throw new InvokeError(msg);
  }
  return body as T;
}

export function createBridge(deps: BridgeDeps): Bridge {
  let ws: WebSocket | null = null;
  let wsIntentionalClose = false;
  let wsReconnectTimer: NodeJS.Timeout | null = null;

  const sendFrame = (frame: WsFrame): void => {
    try {
      deps.sendEvent(frame);
    } catch {
      // 窗口已销毁：忽略
    }
  };

  const connectWs = (): void => {
    wsIntentionalClose = false;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      ws = null;
    }
    try {
      const socket = new WebSocket(deps.serve.wsUrl);
      socket.addEventListener('open', () => {
        ws = socket;
      });
      socket.addEventListener('message', (ev) => {
        try {
          sendFrame(JSON.parse(String(ev.data)) as WsFrame);
        } catch {
          // 非 JSON 帧：忽略
        }
      });
      socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
        if (wsIntentionalClose) return;
        // 服务重启中：1s 后重试（重连成功前渲染端保持 reconnecting 角标）
        if (wsReconnectTimer === null && deps.serve.status !== 'offline') {
          wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            if (!wsIntentionalClose) connectWs();
          }, 1000);
        }
      });
      socket.addEventListener('error', () => {
        // close 事件统一收尾
      });
    } catch (e) {
      sendFrame({ type: 'error', error: `WS 连接失败: ${(e as Error).message}` });
    }
  };

  const disconnectWs = (): void => {
    wsIntentionalClose = true;
    if (wsReconnectTimer !== null) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
      ws = null;
    }
  };

  const wsSendOrThrow = (frame: unknown): void => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new InvokeError('与服务的事件通道未连接（等待 serve 就绪）');
    }
    ws.send(JSON.stringify(frame));
  };

  const handleInvoke = async (_event: IpcMainInvokeEvent, req: unknown): Promise<unknown> => {
    if (typeof req !== 'object' || req === null || typeof (req as { cmd?: unknown }).cmd !== 'string') {
      throw new InvokeError('invoke 请求必须是 {cmd, ...}');
    }
    const cmd = (req as { cmd: string }).cmd;
    const args = req as Record<string, unknown>;
    const base = deps.serve.baseUrl;
    switch (cmd) {
      case 'listSessions': {
        const cwd = args['cwd'];
        return httpJson(`${base}/api/sessions${typeof cwd === 'string' && cwd.length > 0 ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
      }
      case 'createSession':
        return httpJson(`${base}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: typeof args['cwd'] === 'string' && args['cwd'].length > 0 ? args['cwd'] : deps.root }),
        });
      case 'events':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/events`);
      case 'undo':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/undo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(typeof args['n'] === 'number' ? { n: args['n'] } : {}),
            ...(typeof args['dryRun'] === 'boolean' ? { dryRun: args['dryRun'] } : {}),
          }),
        });
      case 'redo':
        return httpJson(`${base}/api/sessions/${encodeURIComponent(String(args['sessionId']))}/redo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      case 'subscribe':
        wsSendOrThrow({ op: 'subscribe', sessionId: args['sessionId'] });
        return null;
      case 'unsubscribe':
        wsSendOrThrow({ op: 'unsubscribe', sessionId: args['sessionId'] });
        return null;
      case 'sendMessage':
        wsSendOrThrow({ op: 'user-message', sessionId: args['sessionId'], text: args['text'] });
        return null;
      case 'abort':
        wsSendOrThrow({ op: 'abort', sessionId: args['sessionId'] });
        return null;
      case 'respondApproval':
        wsSendOrThrow({
          op: 'approval-response',
          requestId: args['requestId'],
          decision: args['decision'] === 'allow' ? 'allow' : 'deny',
        });
        return null;
      case 'loadLayout':
        return readLayout(deps.home);
      case 'saveLayout':
        return writeLayout(deps.home, args['layout']);
      default:
        throw new InvokeError(`未知命令 ${cmd}`);
    }
  };

  return { connectWs, disconnectWs, handleInvoke };
}

/** 挂 IPC 通道（主进程启动时调用一次） */
export function registerBridgeIpc(bridge: Bridge): void {
  ipcMain.handle('harness2:invoke', (event, req) => bridge.handleInvoke(event, req));
}
