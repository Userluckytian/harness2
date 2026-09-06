// WS 事件面（服务 API 契约 v1）：单连接多会话订阅；hub 观察者分发到订阅连接。
// 消息契约（全部 JSON 单帧）：
//   → {op:'subscribe'|'unsubscribe', sessionId} / {op:'abort', sessionId}
//   → {op:'user-message', sessionId, text}          # 触发 runTurn（同会话串行排队）
//   → {op:'approval-response', requestId, decision} # 审批往返（allow/deny）
//   ← {type:'delta', sessionId, kind:'text'|'reasoning', text} / {kind:'tool', call}
//   ← {type:'event', sessionId, event}              # 落盘事件镜像（含 rewind/marker）
//   ← {type:'turn-end', sessionId, stopReason, error?, warning?}
//   ← {type:'approval-request', sessionId, tool, args, requestId}
//   ← {type:'nudge-started', sessionId}             # 后台复盘开始（提示帧，UI 自行决定展示）
//   ← {type:'nudge-finished', sessionId, stopReason, toolCalls, staged, error?}
//   ← {type:'error', error}                         # 协议/输入错误（不在契约帧型内，仅诊断）
// 崩溃安全：turn 全部事件已落盘，服务重启后客户端以 GET /api/sessions/:id/events 重放恢复。
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { TurnStopReason } from '../agent/types.js';
import type { ToolCallRequest } from '../provider/types.js';
import type { AnySessionEvent } from '../session/types.js';
import { HubError, SessionHub, type TurnDelta } from './sessions.js';

export const WS_PATH = '/ws';

export type WsClientMessage =
  | { op: 'subscribe'; sessionId: string }
  | { op: 'unsubscribe'; sessionId: string }
  | { op: 'abort'; sessionId: string }
  | { op: 'user-message'; sessionId: string; text: string }
  | { op: 'approval-response'; requestId: string; decision: 'allow' | 'deny' }
  | { op: 'fork'; sessionId: string; atSeq?: number };

export type WsServerMessage =
  | { type: 'delta'; sessionId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'delta'; sessionId: string; kind: 'tool'; call: ToolCallRequest }
  | { type: 'event'; sessionId: string; event: AnySessionEvent }
  | {
      type: 'turn-end';
      sessionId: string;
      stopReason: TurnStopReason;
      error?: string;
      warning?: string;
    }
  | { type: 'approval-request'; sessionId: string; tool: string; args: unknown; requestId: string }
  | { type: 'nudge-started'; sessionId: string }
  | {
      type: 'nudge-finished';
      sessionId: string;
      stopReason: string;
      toolCalls: number;
      /** ask 模式下本次复盘新增暂存的待审批条数 */
      staged: number;
      error?: string;
    }
  | { type: 'forked'; sessionId: string; parentSession: string; copiedEvents: number }
  | { type: 'cron'; op: 'finished'; id: string; ok: boolean; error?: string }
  | { type: 'error'; error: string };

export interface WsPlaneOptions {
  /** 升级路径（默认 /ws） */
  path?: string;
}

export interface WsPlane {
  /** 关闭：断开全部连接并摘除 hub 观察者 */
  close(): Promise<void>;
  /** cron 通知帧广播（阶段 7：不按会话订阅过滤，投递全部连接） */
  broadcastCron(frame: Extract<WsServerMessage, { type: 'cron' }>): void;
}

function deltaFrame(sessionId: string, delta: TurnDelta): WsServerMessage {
  if (delta.kind === 'tool') return { type: 'delta', sessionId, kind: 'tool', call: delta.call };
  return { type: 'delta', sessionId, kind: delta.kind, text: delta.text };
}

/** 把 WS 事件面挂到 HTTP server 上（hub 观察者 → 订阅连接分发） */
export function attachWsServer(server: Server, hub: SessionHub, options: WsPlaneOptions = {}): WsPlane {
  const wss = new WebSocketServer({ server, path: options.path ?? WS_PATH });
  interface Conn {
    ws: WebSocket;
    subs: Set<string>;
  }
  const conns = new Set<Conn>();

  const broadcast = (sessionId: string, frame: WsServerMessage): void => {
    if (conns.size === 0) return;
    const data = JSON.stringify(frame);
    for (const conn of conns) {
      if (!conn.subs.has(sessionId)) continue;
      try {
        conn.ws.send(data);
      } catch {
        // 发送失败（连接关闭中）：close 事件统一清理
      }
    }
  };

  const offHooks = hub.addHooks({
    onEvent: (sessionId, event) => broadcast(sessionId, { type: 'event', sessionId, event }),
    onDelta: (sessionId, delta) => broadcast(sessionId, deltaFrame(sessionId, delta)),
    onTurnEnd: (sessionId, result) =>
      broadcast(sessionId, {
        type: 'turn-end',
        sessionId,
        stopReason: result.stopReason,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      }),
    onApprovalRequest: (a) =>
      broadcast(a.sessionId, {
        type: 'approval-request',
        sessionId: a.sessionId,
        tool: a.tool,
        args: a.args,
        requestId: a.requestId,
      }),
    onNudgeStarted: (sessionId) => broadcast(sessionId, { type: 'nudge-started', sessionId }),
    onNudgeFinished: (sessionId, result) =>
      broadcast(sessionId, {
        type: 'nudge-finished',
        sessionId,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls,
        staged: result.staged,
        ...(result.error !== undefined ? { error: result.error } : {}),
      }),
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = { ws, subs: new Set<string>() };
    conns.add(conn);
    ws.on('message', (data: unknown) => {
      let msg: WsClientMessage;
      try {
        msg = parseClientMessage(data);
      } catch (e) {
        sendSafe(ws, { type: 'error', error: (e as Error).message });
        return;
      }
      try {
        switch (msg.op) {
          case 'subscribe': {
            hub.locate(msg.sessionId); // 未知会话 → error 帧
            conn.subs.add(msg.sessionId);
            break;
          }
          case 'unsubscribe': {
            conn.subs.delete(msg.sessionId);
            break;
          }
          case 'abort': {
            hub.abort(msg.sessionId); // 无运行中 turn = no-op（停止按钮竞态容忍）
            break;
          }
          case 'user-message': {
            hub.sendUserMessage(msg.sessionId, msg.text);
            break;
          }
          case 'approval-response': {
            hub.respondApproval(msg.requestId, msg.decision); // false = 已超时/取消：静默忽略
            break;
          }
          case 'fork': {
            // 响应帧 {type:'forked', sessionId: 新会话 id, parentSession, copiedEvents}
            const r = hub.fork(msg.sessionId, msg.atSeq !== undefined ? { atSeq: msg.atSeq } : {});
            sendSafe(ws, {
              type: 'forked',
              sessionId: r.id,
              parentSession: r.parentSession,
              copiedEvents: r.copiedEvents,
            });
            break;
          }
        }
      } catch (e) {
        const detail = e instanceof HubError ? e.message : `请求处理失败: ${(e as Error).message}`;
        sendSafe(ws, { type: 'error', error: detail });
      }
    });
    ws.on('close', () => {
      conns.delete(conn);
    });
    ws.on('error', () => {
      conns.delete(conn);
    });
  });

  return {
    broadcastCron(frame: Extract<WsServerMessage, { type: 'cron' }>): void {
      if (conns.size === 0) return;
      const data = JSON.stringify(frame);
      for (const conn of conns) {
        try {
          conn.ws.send(data);
        } catch {
          // 发送失败（连接关闭中）：close 事件统一清理
        }
      }
    },
    close(): Promise<void> {
      offHooks();
      return new Promise((resolve) => {
        for (const conn of conns) {
          try {
            conn.ws.terminate();
          } catch {
            // 已关闭
          }
        }
        conns.clear();
        wss.close(() => resolve());
      });
    },
  };
}

function sendSafe(ws: WebSocket, frame: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // 连接关闭中
  }
}

const OPS = new Set(['subscribe', 'unsubscribe', 'abort', 'user-message', 'approval-response', 'fork']);

export function parseClientMessage(data: unknown): WsClientMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(String(data));
  } catch {
    throw new Error('帧不是合法 JSON');
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('帧必须是 JSON 对象');
  const m = obj as Record<string, unknown>;
  if (typeof m['op'] !== 'string' || !OPS.has(m['op'])) throw new Error('未知 op');
  const op = m['op'] as WsClientMessage['op'];
  switch (op) {
    case 'subscribe':
    case 'unsubscribe':
    case 'abort':
      return { op, sessionId: requireString(m['sessionId'], 'sessionId') };
    case 'user-message':
      return {
        op,
        sessionId: requireString(m['sessionId'], 'sessionId'),
        text: requireString(m['text'], 'text'),
      };
    case 'approval-response': {
      const decision = m['decision'];
      if (decision !== 'allow' && decision !== 'deny') throw new Error("decision 必须是 'allow' | 'deny'");
      return { op, requestId: requireString(m['requestId'], 'requestId'), decision };
    }
    case 'fork': {
      const atSeq = m['atSeq'];
      if (atSeq === undefined) return { op, sessionId: requireString(m['sessionId'], 'sessionId') };
      if (typeof atSeq !== 'number' || !Number.isInteger(atSeq) || atSeq < 1) {
        throw new Error('atSeq 必须是 >= 1 的整数');
      }
      return { op, sessionId: requireString(m['sessionId'], 'sessionId'), atSeq };
    }
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} 必须是非空字符串`);
  return v;
}
