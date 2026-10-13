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
import type {
  CredentialStatusShape,
  ModelsCredentialWriteResultShape,
  ModelsDeclarationAckShape,
  ModelsDiscoveryResultShape,
  ModelsDocumentShape,
  ModelsProviderInputShape,
  ModelsWriteResultShape,
  SettingsAuthMaskedShape,
  SettingsConfigShape,
  SettingsCrashReportShape,
  SettingsDoctorReportShape,
  SettingsHooksShape,
  SettingsModelReasoningShape,
  SettingsProviderShape,
  SettingsRoleShape,
  SettingsSkillsShape,
} from '@harness2/ui-shared/shared/settings.js';

/** config 写结果（与 SettingsPorts.updateConfig 同形；失败回可读错误，绝不假装成功） */
export interface ServeConfigUpdateResult {
  ok: boolean;
  config?: SettingsConfigShape;
  error?: string;
  warnings?: string[];
}

/** auth 写结果（与 SettingsPorts.updateAuth / 桌面 settings:updateAuth 同形；绝不回显明文） */
export interface ServeAuthUpdateResult {
  ok: boolean;
  error?: string;
}

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
  /**
   * Z9-5：发送终端客户端帧（`terminal/open|input|resize|close`，判别字段沿既有 `op`）。
   * WS 未连接时抛 ServeError —— 调用方据实失败，不假装已送达（红线⑩）。
   */
  sendTerminalOp(op: TerminalClientOp): void;
  /** Z9-5：订阅终端服务端帧（`terminal/opened|data|exit|error`，判别字段 `type`）；返回退订函数 */
  onTerminalFrame(listener: (frame: TerminalServerFrame) => void): () => void;

  // —— Z9-6b：设置数据端点（web 设置页面对齐桌面；GET/PUT /api/settings/*）——
  /** GET /api/settings/config → 适配成共享设置页的 SettingsConfigShape（脱敏；密钥字段绝不出现） */
  getSettingsConfig(): Promise<SettingsConfigShape>;
  /** PUT /api/settings/config → 白名单深合并写；HTTP 失败（400/405/401/500）回 {ok:false,error}（区块如实报错） */
  updateSettingsConfig(patch: Record<string, unknown>): Promise<ServeConfigUpdateResult>;
  /** GET /api/settings/auth → auth.json 掩码视图（只回掩码布尔，永不回明文） */
  getSettingsAuthMasked(): Promise<SettingsAuthMaskedShape>;
  /** GET /api/settings/doctor → doctor 六项检查 */
  getSettingsDoctor(): Promise<SettingsDoctorReportShape>;
  /** GET /api/settings/skills → 技能两级扫描结果 */
  getSettingsSkills(): Promise<SettingsSkillsShape>;
  /** GET /api/settings/crash-reports → 崩溃报告列表 */
  getSettingsCrashReports(): Promise<SettingsCrashReportShape[]>;

  // —— A2：模型配置通道面（与桌面 `ModelsSettingsApi` 同名同形；serve /api/settings/models*）——
  // 存在即可作为 SettingsPorts.modelsApi（Partial<ModelsSettingsApi>）注入；未提供的方法如实不实现。

  /** GET /api/settings/models → 分层模型文档视图（密钥只回状态，永不回明文） */
  settingsGetModels(): Promise<ModelsDocumentShape>;
  /** PUT /api/settings/models → provider upsert（写后回读；失败回 {ok:false,code?,field?,error?,document?}） */
  settingsUpdateModels(opts: {
    revision: string;
    provider: ModelsProviderInputShape;
    originalId?: string;
    mainModel?: string;
  }): Promise<ModelsWriteResultShape>;
  /** DELETE /api/settings/models → 删 provider（confirmRoute 必须与 route 一致） */
  settingsDeleteProvider(route: string, confirmRoute: string): Promise<ModelsWriteResultShape>;
  /** PUT /api/settings/models/credential → 写渠道密钥（响应只回具名引用，永不回显明文） */
  settingsWriteChannelKey(route: string, key: string): Promise<ModelsCredentialWriteResultShape>;
  /** POST /api/settings/models/credential-status → 凭据确认查询（只回状态 + 具名引用） */
  settingsGetCredentialStatus(routes: string[]): Promise<Record<string, CredentialStatusShape>>;
  /** POST /api/settings/models/ack-declaration → 首运行声明确认（版本化落盘覆层） */
  settingsAckModelsDeclaration(version: number): Promise<ModelsDeclarationAckShape>;
  /** POST /api/settings/models/discover → 拉模型列表（密钥取 auth.json 既有值；失败如实回错误） */
  settingsDiscoverModels(input: {
    route: string;
    baseUrl: string;
    protocol: ModelsProviderInputShape['protocol'];
  }): Promise<ModelsDiscoveryResultShape>;

  /** PUT /api/settings/auth → 写 auth.json 的 gateways 段（A2 放开；同桌面 settings:updateAuth） */
  updateSettingsAuth(patch: Record<string, unknown>): Promise<ServeAuthUpdateResult>;
}

/** Z9-5：终端客户端帧（`WsClientOp` 联合的终端子集；判别字段 `op`） */
export type TerminalClientOp = Extract<WsClientOp, { op: `terminal/${string}` }>;
/** Z9-5：终端服务端帧（`WsFrame` 联合的终端子集；判别字段 `type`） */
export type TerminalServerFrame = Extract<WsFrame, { type: `terminal/${string}` }>;

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

  /**
   * A2：非抛错的 HTTP 面 —— 模型写端点/凭据写拿到的是**结果对象**（{ok:false,code?,field?,error?}），
   * 由共享分区就地渲染可读错误（红线⑩：4xx/5xx 不画成成功/空数据）。读端点仍走上面的 http（失败即抛）。
   */
  const httpRaw = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    const base = origin.length > 0 ? origin : globalThis.location.origin;
    const headers = new Headers(init?.headers);
    if (token.length > 0) headers.set('x-harness2-token', token);
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    const res = await doFetch(new URL(path, base).toString(), { ...init, headers });
    const text = await res.text();
    const body: unknown = text.length === 0 ? undefined : safeJson(text);
    return { status: res.status, body };
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

    // —— Z9-5 终端帧（WS 契约：客户端 `op` / 服务端 `type`）——

    sendTerminalOp: (op) => {
      // 复用与其它 op 相同的发送口径：未连接即抛 ServeError（调用方如实降级，不静默）
      send(op);
    },
    onTerminalFrame: (listener) => {
      // 复用既有帧订阅泵（onEvent 同一 frameListeners），只按 `type` 前缀过滤终端帧
      const wrapped = (frame: WsFrame): void => {
        if (frame.type.startsWith('terminal/')) listener(frame as TerminalServerFrame);
      };
      frameListeners.add(wrapped);
      return () => {
        frameListeners.delete(wrapped);
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

    // —— Z9-6b 设置数据面（serve /api/settings/*；web 设置页各分区按端口可用性降级）——

    async getSettingsConfig(): Promise<SettingsConfigShape> {
      // Z9-6c：serve 读载荷已是与桌面 settings:getConfig 同形的**完整 config 视图**
      // （core readSettingsConfigView）；此处仍统一过一遍 mapServeConfigPayload 做形状归一（单一适配点）。
      return mapServeConfigPayload(await http('/api/settings/config'));
    },
    async updateSettingsConfig(patch: Record<string, unknown>): Promise<ServeConfigUpdateResult> {
      try {
        const body = (await http('/api/settings/config', { method: 'PUT', body: JSON.stringify(patch) })) as {
          ok?: boolean;
          warnings?: string[];
          config?: unknown;
        };
        return {
          ok: body.ok !== false,
          warnings: Array.isArray(body.warnings) ? body.warnings : [],
          config: mapServeConfigPayload(body.config),
        };
      } catch (e) {
        // 400（白名单/密钥/损坏）· 405 · 401 · 500 → 一律回 {ok:false,error}：调用分区如实报错，
        // 绝不把失败画成成功或空数据（红线⑩）。
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async getSettingsAuthMasked(): Promise<SettingsAuthMaskedShape> {
      return (await http('/api/settings/auth')) as SettingsAuthMaskedShape;
    },
    async getSettingsDoctor(): Promise<SettingsDoctorReportShape> {
      return (await http('/api/settings/doctor')) as SettingsDoctorReportShape;
    },
    async getSettingsSkills(): Promise<SettingsSkillsShape> {
      return (await http('/api/settings/skills')) as SettingsSkillsShape;
    },
    async getSettingsCrashReports(): Promise<SettingsCrashReportShape[]> {
      return (await http('/api/settings/crash-reports')) as SettingsCrashReportShape[];
    },

    // —— A2：模型配置通道面（与桌面 ModelsSettingsApi 同名同形）+ auth 写 ——

    async settingsGetModels(): Promise<ModelsDocumentShape> {
      // 读端点失败即抛（ModelsSettings.reload 的 catch 会把可读错误渲染成加载错误态）
      return (await http('/api/settings/models')) as ModelsDocumentShape;
    },
    async settingsUpdateModels(opts): Promise<ModelsWriteResultShape> {
      const { status, body } = await httpRaw('/api/settings/models', {
        method: 'PUT',
        body: JSON.stringify({
          revision: opts.revision,
          provider: opts.provider,
          ...(opts.originalId !== undefined ? { originalId: opts.originalId } : {}),
          ...(opts.mainModel !== undefined ? { mainModel: opts.mainModel } : {}),
        }),
      });
      return asWriteResult(body, status);
    },
    async settingsDeleteProvider(route, confirmRoute): Promise<ModelsWriteResultShape> {
      const { status, body } = await httpRaw('/api/settings/models', {
        method: 'DELETE',
        body: JSON.stringify({ route, confirmRoute }),
      });
      return asWriteResult(body, status);
    },
    async settingsWriteChannelKey(route, key): Promise<ModelsCredentialWriteResultShape> {
      const { status, body } = await httpRaw('/api/settings/models/credential', {
        method: 'PUT',
        // 密钥只随请求体发往 serve（写 auth.json），响应只回具名引用，绝不回显明文
        body: JSON.stringify({ route, key }),
      });
      if (isOkObject(body)) return body as ModelsCredentialWriteResultShape;
      return { ok: false, error: errorMessageFrom(body, status) };
    },
    async settingsGetCredentialStatus(routes): Promise<Record<string, CredentialStatusShape>> {
      return (await http('/api/settings/models/credential-status', {
        method: 'POST',
        body: JSON.stringify({ routes }),
      })) as Record<string, CredentialStatusShape>;
    },
    async settingsAckModelsDeclaration(version): Promise<ModelsDeclarationAckShape> {
      const { status, body } = await httpRaw('/api/settings/models/ack-declaration', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { ok?: unknown }).ok === 'boolean' &&
        typeof (body as { declarationAckVersion?: unknown }).declarationAckVersion === 'number'
      ) {
        return body as ModelsDeclarationAckShape;
      }
      return { ok: false, declarationAckVersion: 0, error: errorMessageFrom(body, status) };
    },
    async settingsDiscoverModels(input): Promise<ModelsDiscoveryResultShape> {
      const { status, body } = await httpRaw('/api/settings/models/discover', {
        method: 'POST',
        body: JSON.stringify({ route: input.route, baseUrl: input.baseUrl, protocol: input.protocol }),
      });
      if (isOkObject(body)) return body as ModelsDiscoveryResultShape;
      return { ok: false, error: errorMessageFrom(body, status) };
    },
    async updateSettingsAuth(patch): Promise<ServeAuthUpdateResult> {
      const { status, body } = await httpRaw('/api/settings/auth', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      if (typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true) return { ok: true };
      return { ok: false, error: errorMessageFrom(body, status) };
    },
  };
}

/** core `readSettingsConfigView`（GET /api/settings/config）的读载荷形状（与桌面 settings:getConfig 同形） */
interface ServeConfigViewPayloadShape {
  errors?: unknown;
  warnings?: unknown;
  sources?: { global?: unknown; project?: unknown };
  providers?: unknown;
  roles?: unknown;
  approval?: unknown;
  memory?: unknown;
  browser?: unknown;
  plugins?: unknown;
  mcpServers?: unknown;
  subagent?: unknown;
  gateways?: unknown;
  hooks?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 响应体是否带布尔 `ok`（模型写端点/发现/auth 写的结果对象判别） */
function isOkObject(v: unknown): v is { ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

/** 从错误响应体取可读错误（body.error 优先，否则 HTTP <status>）—— 绝不臆造成功 */
function errorMessageFrom(body: unknown, status: number): string {
  const e = asRecord(body)['error'];
  return typeof e === 'string' ? e : `HTTP ${status}`;
}

/** 模型写结果归一：serve 已回 ModelsWriteResultShape（含 code/field/document）则原样透传，否则回可读错误 */
function asWriteResult(body: unknown, status: number): ModelsWriteResultShape {
  if (isOkObject(body)) return body as ModelsWriteResultShape;
  return { ok: false, error: errorMessageFrom(body, status) };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function mapProviderModels(
  v: unknown,
): Record<string, { contextWindow?: number; maxOutputTokens?: number; reasoning?: SettingsModelReasoningShape }> {
  const out: Record<
    string,
    { contextWindow?: number; maxOutputTokens?: number; reasoning?: SettingsModelReasoningShape }
  > = {};
  for (const [id, raw] of Object.entries(asRecord(v))) {
    const m = asRecord(raw);
    out[id] = {
      ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
      ...(typeof m.maxOutputTokens === 'number' ? { maxOutputTokens: m.maxOutputTokens } : {}),
      // Z10-2b：模型档位声明（web 思考档位的合法档位集合来源；未声明 = 不出现，如实）
      ...(m.reasoning !== undefined ? { reasoning: mapModelReasoning(m.reasoning) } : {}),
    };
  }
  return out;
}

/** 模型 reasoning 档位声明映射（values 非空字符串数组；default 可选且为字符串）——非法形状一律丢弃（如实） */
function mapModelReasoning(v: unknown): SettingsModelReasoningShape {
  const r = asRecord(v);
  return {
    values: asStringArray(r.values),
    ...(typeof r.default === 'string' ? { default: r.default } : {}),
  };
}

function mapHookEntry(v: unknown): SettingsHooksShape['entries'][number] {
  const e = asRecord(v);
  return {
    event: typeof e.event === 'string' ? e.event : '',
    command: typeof e.command === 'string' ? e.command : '',
    ...(typeof e.matcher === 'string' ? { matcher: e.matcher } : {}),
    ...(typeof e.timeoutMs === 'number' ? { timeoutMs: e.timeoutMs } : {}),
    ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}),
    ...(typeof e.async === 'boolean' ? { async: e.async } : {}),
  };
}

function mapHooks(v: unknown): SettingsHooksShape {
  const h = asRecord(v);
  return {
    enabled: typeof h.enabled === 'boolean' ? h.enabled : true,
    timeoutMs: typeof h.timeoutMs === 'number' ? h.timeoutMs : 0,
    maxOutputBytes: typeof h.maxOutputBytes === 'number' ? h.maxOutputBytes : 0,
    entries: Array.isArray(h.entries) ? h.entries.map(mapHookEntry) : [],
  };
}

/**
 * serve 脱敏 config 载荷 → 共享设置页 `SettingsConfigShape`（Z9-6b 的唯一适配点；Z9-6c 起读载荷已是完整形状）。
 *
 * Z9-6c：serve `GET /api/settings/config` 已改为返回与桌面 `settings:getConfig` **同一完整形状**
 * （core `readSettingsConfigView`：providers/roles/approval + memory/browser/plugins/mcpServers/
 * subagent/gateways/hooks + sources/warnings/errors）。此处逐段**如实映射**（不做任何合并/补全语义，
 * 缺段才回 schema 缺省），因此依赖这些段的分区可如实渲染与保存，不再显示缺省值并覆盖用户真实配置。
 * 密钥边界：config.json 契约上无 key 字段；本适配不引入 auth 数据，密钥仍绝不出现。
 */
export function mapServeConfigPayload(payload: unknown): SettingsConfigShape {
  const p = asRecord(payload) as ServeConfigViewPayloadShape;
  const errors = asStringArray(p.errors);
  const warnings = asStringArray(p.warnings);
  const sources = asRecord(p.sources);

  const providers: Record<string, SettingsProviderShape> = {};
  for (const [name, raw] of Object.entries(asRecord(p.providers))) {
    const r = asRecord(raw);
    const models = mapProviderModels(r.models);
    providers[name] = {
      protocol: r.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
      ...(typeof r.envKey === 'string' ? { envKey: r.envKey } : {}),
      ...(Object.keys(models).length > 0 ? { models } : {}),
    };
  }

  const roles: Record<string, SettingsRoleShape> = {};
  for (const [name, raw] of Object.entries(asRecord(p.roles))) {
    const r = asRecord(raw);
    roles[name] = {
      channel: typeof r.channel === 'string' ? r.channel : '',
      model: typeof r.model === 'string' ? r.model : '',
      // Z10-2b：保留 effort（web 思考档位当前值来源；未配置 = 用模型缺省档位）
      ...(typeof r.effort === 'string' ? { effort: r.effort } : {}),
    };
  }

  const approvalRaw = asRecord(p.approval);
  const approvalTools = asRecord(approvalRaw.tools);
  const approval =
    Object.keys(approvalRaw).length > 0
      ? {
          mode: typeof approvalRaw.mode === 'string' ? approvalRaw.mode : 'default',
          ...(Object.keys(approvalTools).length > 0
            ? { tools: Object.fromEntries(Object.entries(approvalTools).map(([k, v]) => [k, String(v)])) }
            : {}),
        }
      : { mode: 'default' };

  const memoryRaw = asRecord(p.memory);
  const memory = {
    mode: typeof memoryRaw.mode === 'string' ? memoryRaw.mode : 'off',
    nudgeInterval: typeof memoryRaw.nudgeInterval === 'number' ? memoryRaw.nudgeInterval : 10,
  };
  const browserRaw = asRecord(p.browser);
  const browser = {
    enabled: typeof browserRaw.enabled === 'boolean' ? browserRaw.enabled : true,
    idleDestroyMs: typeof browserRaw.idleDestroyMs === 'number' ? browserRaw.idleDestroyMs : 300_000,
    maxConcurrent: typeof browserRaw.maxConcurrent === 'number' ? browserRaw.maxConcurrent : 2,
  };
  const pluginsRaw = asRecord(p.plugins);
  const plugins = {
    enabled: typeof pluginsRaw.enabled === 'boolean' ? pluginsRaw.enabled : true,
    allow: asStringArray(pluginsRaw.allow),
  };
  const subagentRaw = asRecord(p.subagent);
  const subagent = {
    maxDepth: typeof subagentRaw.maxDepth === 'number' ? subagentRaw.maxDepth : 1,
    maxTurns: typeof subagentRaw.maxTurns === 'number' ? subagentRaw.maxTurns : 25,
  };
  const hooks = p.hooks !== undefined ? mapHooks(p.hooks) : undefined;

  return {
    providers,
    roles,
    approval,
    memory,
    browser,
    plugins,
    mcpServers: asRecord(p.mcpServers),
    subagent,
    ...(p.gateways !== undefined ? { gateways: asRecord(p.gateways) } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    sources: { global: sources['global'] === true, project: sources['project'] === true },
    warnings,
    errors,
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
