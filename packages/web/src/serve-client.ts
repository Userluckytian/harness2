// serve 客户端：web 壳对 `HarnessClient` 端口的实现（HTTP `/api/*` + WS `/ws`）。
//
// 契约来源（不发明形状）：
//   * HTTP：`packages/core/src/server/http.ts` 的 `route()`（GET/POST `/api/sessions`、
//     `GET /api/sessions/:id/events`、`/run-config`、`/plan-state`、`/execution-view`、
//     `/change-review`、`POST /fork|/undo|/redo`）；
//   * WS：`packages/core/src/server/ws.ts` 的 `WsClientMessage` / `WsServerMessage`
//     （路径 `/ws`；帧形状镜像在 `@harness2/ui-shared/shared/protocol.js`）；
//   * token：`x-harness2-token` 请求头（WS 握手可退化为 `?token=` 查询参数）；
//   * 跨端版本协商：`protocolVersion=2`（core `PROTOCOL_VERSION`）；真正切到带水位帧（v2）是在
//     `resume-subscription` 成功后（core ws.ts 置 `conn.v2 = true`），因此本实现对每个会话都发一次
//     `resume-subscription` —— 查询参数只是声明，不假装它已生效。
//
// 边界（如实登记，见文件末）：本壳**不实现**元数据覆层 / 草稿落盘 / 设置写入 / 布局文件等宿主通道，
// 端口里对应成员一律不提供，共享控制层会如实降级（内存生效 + 明确提示），不会假装成功。
import type { HarnessClient } from '@harness2/ui-shared/renderer/ports.js';
import type {
  ChangeSetShape,
  ConnectionStatus,
  EffectiveRunConfigShape,
  MessageReferenceShape,
  PlanStateShape,
  SessionEventsPayloadShape,
  SessionSummaryShape,
  StatusDetail,
  SubmitIntentShape,
  ToolExecutionViewShape,
  UndoRedoResponseShape,
  WsClientOp,
  WsFrame,
} from '@harness2/ui-shared/shared/protocol.js';

/** 与 core `PROTOCOL_VERSION` 同值（WS 能力协商底线；跨壳不得各自发明） */
export const PROTOCOL_VERSION = 2;
/** core `DEFAULT_SERVE_PORT`（dev 代理缺省目标同值，见 vite.config.mts） */
export const DEFAULT_SERVE_ORIGIN = 'http://127.0.0.1:46213';

/** 浏览器 WebSocket 的最小调用面（测试注入假实现；真机 = 全局 WebSocket） */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface ServeClientOptions {
  /** serve 源；缺省 '' = 同源（dev 走 vite 代理）。直连示例：'http://127.0.0.1:46213' */
  readonly origin?: string;
  /** 一次性 serve token（严格模式必需） */
  readonly token?: string;
  /** WebSocket 工厂（缺省 = 全局 WebSocket；测试注入假实现） */
  readonly socketFactory?: SocketFactory;
  /** fetch 实现（测试注入） */
  readonly fetchImpl?: typeof fetch;
  /** 重连上限（超过 → 状态 offline，如实告知而不是永远「重连中」） */
  readonly maxReconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
}

export interface ServeClient extends HarnessClient {
  /** 当前连接状态（等价 getStatus().status 的同步读取） */
  status(): ConnectionStatus;
  /** 主动断开（页面卸载/测试收尾） */
  close(): void;
}

const OPEN = 1;

class ServeError extends Error {}

export function createServeClient(options: ServeClientOptions = {}): ServeClient {
  const origin = (options.origin ?? '').replace(/\/$/, '');
  const token = options.token ?? '';
  const maxAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input as RequestInfo, init));
  const socketFactory: SocketFactory =
    options.socketFactory ?? ((url) => new (globalThis.WebSocket as unknown as new (u: string) => WebSocketLike)(url));

  const frameListeners = new Set<(frame: WsFrame) => void>();
  const statusListeners = new Set<(status: ConnectionStatus, detail?: StatusDetail) => void>();
  let current: ConnectionStatus = 'connecting';
  let detail: StatusDetail | undefined;
  let attempts = 0;
  let socket: WebSocketLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** 最近一次列出的会话 cwd（新建会话的缺省作用域：本壳没有目录选择通道）。 */
  let lastKnownCwd: string | undefined;

  const emitStatus = (status: ConnectionStatus, nextDetail?: StatusDetail): void => {
    current = status;
    detail = nextDetail;
    for (const listener of [...statusListeners]) listener(status, nextDetail);
  };

  const wsUrl = (): string => {
    const base = origin.length > 0 ? origin : globalThis.location.origin;
    const url = new URL('/ws', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('protocolVersion', String(PROTOCOL_VERSION));
    // 浏览器 WebSocket 不支持自定义请求头 → 走查询参数（serve 端 extractServeToken 接受）
    if (token.length > 0) url.searchParams.set('token', token);
    return url.toString();
  };

  const connect = (): void => {
    if (closed) return;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    emitStatus(attempts === 0 ? 'connecting' : 'reconnecting', {
      ...(attempts > 0 ? { attemptsLeft: maxAttempts - attempts } : {}),
    });
    let nextSocket: WebSocketLike;
    try {
      nextSocket = socketFactory(wsUrl());
    } catch (e) {
      emitStatus('offline', { error: `WS 连接创建失败: ${(e as Error).message}` });
      return;
    }
    socket = nextSocket;
    nextSocket.onopen = () => {
      attempts = 0;
      emitStatus('connected');
    };
    nextSocket.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (frame === null) return; // 非帧/畸形帧：丢弃（不把脏数据喂给状态层）
      for (const listener of [...frameListeners]) listener(frame);
    };
    nextSocket.onerror = () => {
      // 连接错误最终会走 close；这里不重复改状态（避免「offline → reconnecting」抖动）
    };
    nextSocket.onclose = () => {
      socket = null;
      if (closed) return;
      attempts += 1;
      if (attempts > maxAttempts) {
        emitStatus('offline', { attemptsLeft: 0, error: 'WS 重连次数用尽（serve 未就绪？）' });
        return;
      }
      emitStatus('reconnecting', { attemptsLeft: maxAttempts - attempts });
      retryTimer = setTimeout(connect, reconnectDelayMs);
    };
  };

  const send = (op: WsClientOp): void => {
    if (socket === null || socket.readyState !== OPEN) {
      // 如实失败：调用方（控制层）会把它记成 unknown / 可重试错误，绝不假装已送达
      throw new ServeError(`WS 未连接：op '${op.op}' 未送达`);
    }
    socket.send(JSON.stringify(op));
  };

  const http = async (path: string, init?: RequestInit): Promise<unknown> => {
    const base = origin.length > 0 ? origin : globalThis.location.origin;
    const headers = new Headers(init?.headers);
    if (token.length > 0) headers.set('x-harness2-token', token);
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    const res = await doFetch(new URL(path, base).toString(), { ...init, headers });
    const text = await res.text();
    const body: unknown = text.length === 0 ? undefined : safeJson(text);
    if (!res.ok) {
      const message =
        typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      throw new ServeError(message);
    }
    return body;
  };

  connect();

  return {
    status: () => current,
    close: () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const active = socket;
      socket = null;
      active?.close();
    },

    // —— 会话面 ——

    async listSessions(cwd) {
      const query = cwd === undefined || cwd.length === 0 ? '' : `?cwd=${encodeURIComponent(cwd)}`;
      const body = (await http(`/api/sessions${query}`)) as { sessions?: SessionSummaryShape[] };
      const sessions = body.sessions ?? [];
      const withCwd = sessions.find((s) => typeof s.cwd === 'string' && s.cwd.length > 0);
      if (withCwd?.cwd !== undefined) lastKnownCwd = withCwd.cwd; // 记下缺省作用域（仅内存）
      return sessions;
    },
    async createSession(cwd) {
      // serve 的 POST /api/sessions 要求 cwd 非空（http.ts requireNonEmptyString）——
      // 本壳没有目录选择通道，故必须由调用方给出（通常取当前会话的 cwd）；给不出就如实拒绝。
      const effective = cwd !== undefined && cwd.length > 0 ? cwd : lastKnownCwd;
      if (effective === undefined || effective.length === 0) {
        throw new ServeError('无法新建会话：serve 要求 cwd，而 web 壳没有目录选择通道（列表里也没有可用 cwd）');
      }
      return (await http('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: effective }) })) as {
        id: string;
      };
    },
    async events(sessionId): Promise<SessionEventsPayloadShape> {
      return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/events`)) as SessionEventsPayloadShape;
    },
    async subscribe(sessionId) {
      send({ op: 'subscribe', sessionId });
    },
    async unsubscribe(sessionId) {
      send({ op: 'unsubscribe', sessionId });
    },
    async sendMessage(sessionId, text) {
      send({ op: 'user-message', sessionId, text });
    },
    async abort(sessionId) {
      send({ op: 'abort', sessionId });
    },
    async respondApproval(requestId, decision) {
      send({ op: 'approval-response', requestId, decision });
    },
    async getStatus() {
      return { status: current, ...(detail !== undefined ? { detail } : {}) };
    },
    onEvent: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onConnectionStatus: (listener) => {
      statusListeners.add(listener);
      // 订阅即补一次当前状态：避免错过订阅前已发生的 connected（与桌面 getStatus 补齐同口径）
      listener(current, detail);
      return () => {
        statusListeners.delete(listener);
      };
    },

    // —— S3 交互 op（全部走 WS 契约） ——

    async submit(op: {
      clientMessageId: string;
      sessionId: string;
      rawText: string;
      intent: SubmitIntentShape;
      references?: MessageReferenceShape[];
      expectedTurnId?: string;
    }) {
      send({ op: 'submit', ...op });
    },
    async cancel(op: {
      requestId: string;
      target: { kind: 'turn' | 'task'; id: string };
      expectedId?: string;
      expectedTurnGeneration?: number;
    }) {
      send({ op: 'cancel', ...op });
    },
    async resumeSubscription(sessionId, lastSeq, epoch) {
      send({ op: 'resume-subscription', sessionId, lastSeq, epoch });
    },
    async fork(sessionId, atSeq) {
      send({ op: 'fork', sessionId, ...(atSeq !== undefined ? { atSeq } : {}) });
    },
    async undo(sessionId, opts): Promise<UndoRedoResponseShape> {
      return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/undo`, {
        method: 'POST',
        body: JSON.stringify({
          ...(opts?.n !== undefined ? { n: opts.n } : {}),
          ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        }),
      })) as UndoRedoResponseShape;
    },
    async redo(sessionId): Promise<UndoRedoResponseShape> {
      return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/redo`, {
        method: 'POST',
      })) as UndoRedoResponseShape;
    },

    // —— S7 只读查询 ——

    async runConfig(sessionId): Promise<EffectiveRunConfigShape> {
      return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/run-config`)) as EffectiveRunConfigShape;
    },
    async planState(sessionId): Promise<PlanStateShape | null> {
      try {
        return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/plan-state`)) as PlanStateShape;
      } catch (e) {
        // serve 对「会话暂无计划数据」回 404：这是**正常空态**，不是错误
        if (e instanceof ServeError && /暂无计划数据|not found/i.test(e.message)) return null;
        throw e;
      }
    },
    async executionViews(sessionId): Promise<ToolExecutionViewShape[]> {
      const body = (await http(`/api/sessions/${encodeURIComponent(sessionId)}/execution-view`)) as {
        views?: ToolExecutionViewShape[];
      };
      return body.views ?? [];
    },
    async changeReview(sessionId): Promise<ChangeSetShape> {
      return (await http(`/api/sessions/${encodeURIComponent(sessionId)}/change-review`)) as ChangeSetShape;
    },
  };
}

/** 解析 WS 帧：只接受带 string `type` 的对象；其余（二进制/畸形 JSON）丢弃 */
function parseFrame(data: unknown): WsFrame | null {
  const text = typeof data === 'string' ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : null;
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
  return parsed as WsFrame;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// —— 本壳**未实现**的宿主通道（如实登记；不提供 = 共享控制层降级并明确提示） ——
//   * metadataGet/metadataSet（会话重命名/归档/删除标记：web 无覆层存储）
//   * draftsGet/draftsSet（草稿落盘：仅内存，刷新即丢）
//   * loadLayout（桌面旧版分屏文件：web 无此历史包袱）
//   * settingsUpdateConfig（审批模式写全局配置：web 无配置写入通道，UI 不摆该入口）
//   * setBusy（关窗口运行态上报：web 没有「关窗口」，无此语义）
//   * capabilities（能力盘点探测：web 后续可接，当前如实不提供）
//   * HostBridge.readFileForRef / getSnapshotForCall（附件与快照读取：serve 无对应只读端点）
