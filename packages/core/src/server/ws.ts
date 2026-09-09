// WS 事件面（服务 API 契约 v1 + S3c1 可恢复订阅/取消/提交帧）：单连接多会话订阅；hub 观察者分发。
// 消息契约（全部 JSON 单帧）：
//   → {op:'subscribe'|'unsubscribe', sessionId} / {op:'abort', sessionId}
//   → {op:'user-message', sessionId, text}          # 触发 runTurn（同会话串行排队）
//   → {op:'approval-response', requestId, decision} # 审批往返（allow/deny）
//   → {op:'resume-subscription', sessionId, lastSeq, epoch}  # S3c1 带水位重连握手 → resume-snapshot
//   → {op:'cancel', requestId, target:{kind,id}, expectedId?, expectedTurnGeneration?} # S3c1 取消 ack（三态；FixB turn 代次加性）
//   → {op:'submit', clientMessageId, sessionId, rawText, intent, references?, expectedTurnId?} # S3c1 帧+校验
//   ← {type:'delta', sessionId, kind:'text'|'reasoning', text} / {kind:'tool', call}   # 旧帧形状不变
//   ← {type:'text-delta'|'reasoning-delta', sessionId, turnId, attemptId, chunkOffset, text} # S0 带水位
//   ← {type:'attempt-final', sessionId, turnId, attemptId, state, finalText?, error?}  # S0 终态归属
//   ← {type:'resume-snapshot', epoch, replay, activeAttempt?, tasks, pendingApprovals, queue}
//   ← {type:'cancel-ack', requestId, state}         # stopping | cancelled | unknown
//   ← {type:'submit-ack', clientMessageId, sessionId, state, reason?, queueSeq?}
//   ← {type:'event', sessionId, event}              # 落盘事件镜像（含 rewind/marker）
//   ← {type:'turn-end', sessionId, stopReason, error?, warning?}
//   ← {type:'approval-request', sessionId, tool, args, requestId, scope, expiresAt, cwd?, taskId?, parentTaskId?}
//   ← {type:'nudge-started', sessionId} / {type:'nudge-finished', sessionId, stopReason, toolCalls, staged, error?}
//   ← {type:'forked', sessionId, parentSession, copiedEvents} / {type:'cron', op:'finished', ...}
//   ← {type:'error', error}                         # 协议/输入错误（不在契约帧型内，仅诊断）
// S3c1 只动传输帧层（不引入 session 日志事件类型变更）。resume/cancel/submit 的实际执行/队列
// 接线归 S3c2：本层经注入的 resumeStateProvider 缝消费，未接线时回相应 unknown/error，不冒充。
// 事件溯源不破坏：text/reasoning/reasoning-* delta 是**展示投影**，非模型上下文；模型可见输入仍
// 由 session.log 投影。旧客户端继续既有帧（未强制 protocolVersion=2 不突然切形状）。
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { TurnStopReason } from '../agent/types.js';
import type { ToolCallRequest } from '../provider/types.js';
import type { AnySessionEvent } from '../session/types.js';
import type {
  ApprovalRequestContract,
  ApprovalScope,
  AttemptFinalFrame,
  CancelAckState,
  MessageReference,
  ResumeSnapshot,
  SubmitAck,
} from '../interaction/types.js';
import {
  isCancelTargetKind,
  isSubmitIntent,
  isTurnGeneration,
  isValidEpoch,
  isValidLastSeq,
} from '../interaction/types.js';
import { HubError, SessionHub, type TurnDelta } from './sessions.js';
import type { ResumeStateProvider } from '../interaction/resume-state.js';
// S3c2 起 DeltaAttribution/WatermarkCursor/ResumeStateProvider 移驻 interaction/resume-state.ts
// （hub 与传输共用、避免 sessions↔ws 模块环）；此处重新导出保持 S3c1 公开导出面不变。
export { WatermarkCursor } from '../interaction/resume-state.js';
export type { DeltaAttribution, ResumeStateProvider } from '../interaction/resume-state.js';
import { isTrustedHost, isTrustedOrigin, normalizeOriginHeader, WS_MAX_PAYLOAD } from './trust.js';
import { extractServeToken, isServeTokenValid, warnServeNoTokenOnce, type ServeSecurityStats } from './security.js';

export const WS_PATH = '/ws';

export type WsClientMessage =
  | { op: 'subscribe'; sessionId: string }
  | { op: 'unsubscribe'; sessionId: string }
  | { op: 'abort'; sessionId: string }
  | { op: 'user-message'; sessionId: string; text: string }
  | { op: 'approval-response'; requestId: string; decision: 'allow' | 'deny' }
  | { op: 'fork'; sessionId: string; atSeq?: number }
  // S3c1 新增帧（对齐 S0 共享契约；旧客户端不感知）
  | { op: 'resume-subscription'; sessionId: string; lastSeq: number; epoch: number }
  | {
      op: 'cancel';
      requestId: string;
      target: { kind: 'turn' | 'task'; id: string };
      expectedId?: string;
      expectedTurnGeneration?: number;
    }
  | {
      op: 'submit';
      clientMessageId: string;
      sessionId: string;
      rawText: string;
      intent: 'queue' | 'steer';
      references?: MessageReference[];
      expectedTurnId?: string;
    };

export type WsServerMessage =
  | { type: 'delta'; sessionId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'delta'; sessionId: string; kind: 'tool'; call: ToolCallRequest }
  // S3c1/S0 带水位增量（展示投影）：chunkOffset 单调，续块 = 上一块 offset + 文本长度
  | { type: 'text-delta'; sessionId: string; turnId: string; attemptId: string; chunkOffset: number; text: string }
  | { type: 'reasoning-delta'; sessionId: string; turnId: string; attemptId: string; chunkOffset: number; text: string }
  | {
      type: 'attempt-final';
      sessionId: string;
      turnId: string;
      attemptId: string;
      state: AttemptFinalFrame['state'];
      finalText?: string;
      error?: string;
    }
  | { type: 'resume-snapshot'; sessionId: string; epoch: number; snapshot: ResumeSnapshot }
  | { type: 'cancel-ack'; requestId: string; state: CancelAckState }
  | {
      type: 'submit-ack';
      clientMessageId: string;
      sessionId: string;
      state: SubmitAck['state'];
      reason?: string;
      queueSeq?: number;
    }
  | { type: 'event'; sessionId: string; event: AnySessionEvent }
  | {
      type: 'turn-end';
      sessionId: string;
      stopReason: TurnStopReason;
      error?: string;
      warning?: string;
    }
  | {
      type: 'approval-request';
      sessionId: string;
      tool: string;
      args: unknown;
      requestId: string;
      /** scope：once=一次性 / 「本会话总是」（框定 sessionId；跨 session 卡片会被策略层拒收） */
      scope: ApprovalScope;
      /** 过期时刻 ISO；迟到将被拒（客户端可据此计时自弃） */
      expiresAt: string;
      /** 卡片归属会话 cwd（S1 起工具执行基于它；重连后客户端可展示） */
      cwd?: string;
      /** 桌面端任务分组链路（加性字段；旧客户端忽略） */
      taskId?: string;
      parentTaskId?: string;
    }
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
  /**
   * S3c1 → S3c2 接线缝：resume/cancel/submit 的**实际状态**提供者。
   * S3c1 只做传输帧：resume-snapshot 的 replay 从磁盘投影派生，activeAttempt/tasks/
   * pendingApprovals/queue 与 cancel/submit 的 ack 一律经此缝委托（S3c2 接线 hub/交付）。
   * 未注入（或返回 null / 缺省 unknown）时如实回 unknown/error，不冒充已接线执行。
   */
  resumeState?: ResumeStateProvider;
  /**
   * A3-1：WS 升级握手 token 鉴权（startServe 统一注入；未注入 = 仅白名单校验，向后兼容）。
   * 与 HTTP 同口径：带 token 必须匹配，不带 token 则严格模式拒 / 兼容模式放行并计数。
   */
  auth?: { token: string; requireToken: boolean; stats?: ServeSecurityStats };
}

export interface WsPlane {
  /** 关闭：断开全部连接并摘除 hub 观察者 */
  close(): Promise<void>;
  /** cron 通知帧广播（阶段 7：不按会话订阅过滤，投递全部连接） */
  broadcastCron(frame: Extract<WsServerMessage, { type: 'cron' }>): void;
}

// —— S3c1 传输层只做帧定义、校验与转发；实际执行/队列状态经 ResumeStateProvider 缝委托
//    （已移驻 interaction/resume-state.ts 由本文件重新导出，见文件头 import） ——

function deltaFrame(sessionId: string, delta: TurnDelta): WsServerMessage {
  if (delta.kind === 'tool') return { type: 'delta', sessionId, kind: 'tool', call: delta.call };
  return { type: 'delta', sessionId, kind: delta.kind, text: delta.text };
}

/** 审批上抛帧（卡片契约 → 出站；scope/expiresAt 必填，cwd/taskId/parentTaskId 加性） */
function approvalFrame(a: ApprovalRequestContract): WsServerMessage {
  return {
    type: 'approval-request',
    sessionId: a.sessionId,
    tool: a.tool,
    args: a.args,
    requestId: a.requestId,
    scope: a.scope,
    expiresAt: a.expiresAt,
    ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
    ...(a.parentTaskId !== undefined ? { parentTaskId: a.parentTaskId } : {}),
  };
}

/** 把 WS 事件面挂到 HTTP server 上（hub 观察者 → 订阅连接分发）。
 *  升级握手经信任域校验（Origin/Host 与 HTTP 同规则，Task 4）+ A3-1 token 鉴权；
 *  帧上限 1MiB 对齐 HTTP。 */
export function attachWsServer(server: Server, hub: SessionHub, options: WsPlaneOptions = {}): WsPlane {
  const path = options.path ?? WS_PATH;
  const auth = options.auth;
  const stats = auth?.stats;
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      url = new URL('http://127.0.0.1/');
    }
    // P2-5（阶段 7 审查）：与 HTTP 同口径——重复 Origin 头取首值规范化后再校验
    const origin = normalizeOriginHeader(req.headers.origin);
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : undefined;
    const trusted =
      isTrustedOrigin(origin) && (port === undefined || isTrustedHost(host, port)) && url.pathname === path;
    if (!trusted) {
      if (stats !== undefined) stats.trustRejected += 1;
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // A3-1：token 门禁（与 HTTP checkServeToken 同口径；错误 token 绝不回退）
    if (auth !== undefined) {
      const provided = extractServeToken(req.headers, url);
      if (provided !== undefined) {
        if (!isServeTokenValid(provided, auth.token)) {
          if (stats !== undefined) stats.invalidTokenRejected += 1;
          socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      } else if (auth.requireToken) {
        if (stats !== undefined) stats.noTokenRejected += 1;
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      } else {
        if (stats !== undefined) stats.noTokenAllowed += 1;
        warnServeNoTokenOnce();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  interface Conn {
    ws: WebSocket;
    subs: Set<string>;
    /** S3c1：客户端最近确认的连接代次（旧 epoch 的 resume/帧丢弃） */
    epoch: number;
    /** S3c2：已成功 resume-subscription → 带水位帧消费者。旧客户端（未 resume）继续收旧 delta 形状 */
    v2: boolean;
  }
  const conns = new Set<Conn>();
  const resumeState = options.resumeState;

  const broadcast = (sessionId: string, frame: WsServerMessage): void => broadcastTo([sessionId], frame);

  /** 按送达链投递：订阅命中 deliverTo 任一会话即广播（父/子/孙订阅者都能收到该审批卡） */
  const broadcastTo = (deliverTo: string[], frame: WsServerMessage): void => {
    if (conns.size === 0) return;
    const data = JSON.stringify(frame);
    for (const conn of conns) {
      if (!deliverTo.some((id) => conn.subs.has(id))) continue;
      try {
        conn.ws.send(data);
      } catch {
        // 发送失败（连接关闭中）：close 事件统一清理
      }
    }
  };

  /** S3c2 谓词投递：仅满足 match 的连接收到（旧 delta 只给非 v2、水位帧只给 v2） */
  const broadcastWhere = (frame: WsServerMessage, match: (conn: Conn) => boolean): void => {
    if (conns.size === 0) return;
    const data = JSON.stringify(frame);
    for (const conn of conns) {
      if (!match(conn)) continue;
      try {
        conn.ws.send(data);
      } catch {
        // 发送失败（连接关闭中）：close 事件统一清理
      }
    }
  };

  const offHooks = hub.addHooks({
    onEvent: (sessionId, event) => broadcast(sessionId, { type: 'event', sessionId, event }),
    // 旧 delta 帧：仅投递未升级（非 v2）连接；v2 连接消费带水位帧
    onDelta: (sessionId, delta) => broadcastWhere(deltaFrame(sessionId, delta), (c) => !c.v2 && c.subs.has(sessionId)),
    // S3c2 带水位增量 / attempt 终态：仅投递已恢复订阅（v2）的连接
    onDeliveryDelta: (sessionId, frame) => broadcastWhere(frame, (c) => c.v2 && c.subs.has(sessionId)),
    onAttemptFinal: (sessionId, frame) => broadcastWhere(frame, (c) => c.v2 && c.subs.has(sessionId)),
    onTurnEnd: (sessionId, result) =>
      broadcast(sessionId, {
        type: 'turn-end',
        sessionId,
        stopReason: result.stopReason,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      }),
    onApprovalRequest: (a, deliverTo) => broadcastTo(deliverTo, approvalFrame(a)),
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
    const conn: Conn = { ws, subs: new Set<string>(), epoch: 0, v2: false };
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
            // S2 重连恢复：订阅即补发该会话（含后代 subagent）的待处理审批卡
            for (const a of hub.pendingApprovalsFor(msg.sessionId)) {
              sendSafe(ws, approvalFrame(a));
            }
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
            // ack（applied/duplicate/expired/unknown）不回帧：经 HTTP respond 返回；
            // 此处迟到/重复响应按队列已落定天然收敛（duplicate/expired/unknown 均静默）
            hub.respondApproval(msg.requestId, msg.decision);
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
          case 'resume-subscription': {
            // S3c1 可恢复订阅握手：旧 epoch（< 本连接已确认代次）直接丢弃；
            // replay 范围以磁盘投影为准（fromSeq = lastSeq+1 → 服务端 lastSeq），
            // 防止 snapshot 与后续 delta 之间空窗；在途/队列状态经 resumeState 缝委托。
            if (msg.epoch < conn.epoch) break; // 旧 epoch 丢弃（不发帧）
            conn.epoch = msg.epoch;
            // 校验会话存在（未知会话 → error 帧）
            hub.locate(msg.sessionId);
            const fromSeq = msg.lastSeq + 1;
            const toSeq = hub.events(msg.sessionId).lastSeq;
            const state =
              resumeState !== undefined
                ? resumeState.resumeSnapshot({ sessionId: msg.sessionId, lastSeq: msg.lastSeq, epoch: msg.epoch })
                : null;
            if (state === null) {
              sendSafe(ws, { type: 'error', error: `resume 未支持或会话无恢复状态（S3c2 未接线）: ${msg.sessionId}` });
              break;
            }
            conn.v2 = true; // 成功恢复订阅 → 后续 delta/attempt-final 走带水位帧
            sendSafe(ws, {
              type: 'resume-snapshot',
              sessionId: msg.sessionId,
              epoch: msg.epoch,
              snapshot: { epoch: msg.epoch, replay: { fromSeq, toSeq }, ...state },
            });
            break;
          }
          case 'cancel': {
            // S3c1 cancel 帧：三态 ack 经 resumeState.cancelAck 决定（S3c2 接线执行）；
            // 缺省（未接线）回 unknown，绝不冒充已取消。expectedId 交由 provider 做并发防护。
            if (resumeState === undefined) {
              sendSafe(ws, { type: 'cancel-ack', requestId: msg.requestId, state: 'unknown' });
              break;
            }
            const ack = resumeState.cancelAck({
              requestId: msg.requestId,
              target: msg.target,
              expectedId: msg.expectedId,
              ...(msg.expectedTurnGeneration !== undefined
                ? { expectedTurnGeneration: msg.expectedTurnGeneration }
                : {}),
            });
            sendSafe(ws, { type: 'cancel-ack', requestId: ack.requestId, state: ack.state });
            break;
          }
          case 'submit': {
            // S3c1 submit 帧定义 + 校验；实际 durable 入队/ack 归 S3c2 delivery 接线。
            // 缺省（未接线）回 unknown（≠rejected，调用方不得当拒绝处理）。
            if (resumeState === undefined) {
              sendSafe(ws, {
                type: 'submit-ack',
                clientMessageId: msg.clientMessageId,
                sessionId: msg.sessionId,
                state: 'unknown',
                reason: 'submit 未接线（S3c2）; unknown ≠ rejected',
              });
              break;
            }
            const ack = resumeState.submitAck({
              clientMessageId: msg.clientMessageId,
              sessionId: msg.sessionId,
              rawText: msg.rawText,
              intent: msg.intent,
              ...(msg.references !== undefined ? { references: msg.references } : {}),
              ...(msg.expectedTurnId !== undefined ? { expectedTurnId: msg.expectedTurnId } : {}),
            });
            sendSafe(ws, {
              type: 'submit-ack',
              clientMessageId: ack.clientMessageId,
              sessionId: ack.sessionId,
              state: ack.state,
              ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
              ...(ack.queueSeq !== undefined ? { queueSeq: ack.queueSeq } : {}),
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

const OPS = new Set([
  'subscribe',
  'unsubscribe',
  'abort',
  'user-message',
  'approval-response',
  'fork',
  'resume-subscription',
  'cancel',
  'submit',
]);

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
    case 'resume-subscription': {
      const lastSeq = m['lastSeq'];
      const epoch = m['epoch'];
      if (!isValidLastSeq(lastSeq)) throw new Error('lastSeq 必须是非负整数');
      if (!isValidEpoch(epoch)) throw new Error('epoch 必须是非负整数');
      return { op, sessionId: requireString(m['sessionId'], 'sessionId'), lastSeq, epoch };
    }
    case 'cancel': {
      const target = m['target'];
      if (typeof target !== 'object' || target === null) throw new Error('target 必须是对象');
      const t = target as Record<string, unknown>;
      if (!isCancelTargetKind(t['kind'])) throw new Error("target.kind 必须是 'turn' | 'task'");
      const id = requireString(t['id'], 'target.id');
      const expectedId = m['expectedId'];
      if (expectedId !== undefined && (typeof expectedId !== 'string' || expectedId.length === 0)) {
        throw new Error('expectedId 必须是非空字符串');
      }
      // FixB 加性：turn 代次（>=1 整数；旧客户端不带 → 回退 target.id 匹配）
      const expectedTurnGeneration = m['expectedTurnGeneration'];
      if (expectedTurnGeneration !== undefined && !isTurnGeneration(expectedTurnGeneration)) {
        throw new Error('expectedTurnGeneration 必须是 >= 1 的整数');
      }
      const requestId = requireString(m['requestId'], 'requestId');
      const base = { op, requestId, target: { kind: t['kind'] as 'turn' | 'task', id } as const };
      return expectedId === undefined
        ? expectedTurnGeneration === undefined
          ? base
          : { ...base, expectedTurnGeneration }
        : expectedTurnGeneration === undefined
          ? { ...base, expectedId }
          : { ...base, expectedId, expectedTurnGeneration };
    }
    case 'submit': {
      const intent = m['intent'];
      if (!isSubmitIntent(intent)) throw new Error("intent 必须是 'queue' | 'steer'");
      const references = m['references'];
      if (references !== undefined && !Array.isArray(references)) throw new Error('references 必须是数组');
      const expectedTurnId = m['expectedTurnId'];
      if (expectedTurnId !== undefined && (typeof expectedTurnId !== 'string' || expectedTurnId.length === 0)) {
        throw new Error('expectedTurnId 必须是非空字符串');
      }
      const clientMessageId = requireString(m['clientMessageId'], 'clientMessageId');
      const sessionId = requireString(m['sessionId'], 'sessionId');
      const rawText = requireString(m['rawText'], 'rawText');
      const refs = references !== undefined ? { references: references as MessageReference[] } : {};
      return expectedTurnId === undefined
        ? { op, clientMessageId, sessionId, rawText, intent, ...refs }
        : { op, clientMessageId, sessionId, rawText, intent, ...refs, expectedTurnId };
    }
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} 必须是非空字符串`);
  return v;
}
