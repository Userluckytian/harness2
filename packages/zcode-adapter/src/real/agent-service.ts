import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createStubService } from '../stub-factory.js';
import { Emitter, Event } from '@zcode/rpc';
import {
  createSessionManager,
  defaultSessionsRoot,
  loadConfig,
  createProvider,
  runTurn,
  resolveHarness2Home,
  MockProvider,
  ToolRegistry,
  UserInputQueue,
  extensionEventTypes,
  loadSession,
  redactSecrets,
} from './core-bridge.js';
import type { IZCodeAgentService } from '@zcode/services';
import type {
  ApprovalHandler,
  ChatContentPart,
  MockScript,
  UserInputAnswer,
  UserInputRequestContract,
} from '@harness2/core';
import type { PendingInteraction } from '@zcode/shared/zcode-protocol-v4';
import { encodeTopicWireFrames, measureTopicNotificationEnvelopeBytes } from '@zcode/shared/zcode-protocol-v4';
import {
  buildSnapshot,
  makeAssistantTextRow,
  makeControl,
  makeReasoningRow,
  makeToolCallRow,
  makeTurnHeaderRow,
  makeUserInputRow,
  projectEvents,
  USER_ATTACHMENTS_EVENT,
} from './v4-projection.js';
import type { ControlPhase, ProjectedRow } from './v4-projection.js';
import type { SessionWriter, ToolRegistryTypeExport } from './core-bridge.js';
import { AttachmentStore } from './attachment-store.js';
import type {
  AttachmentBeginParams,
  AttachmentChunkParams,
  AttachmentPreviewParams,
  AttachmentReadParams,
  AttachmentTerminalParams,
} from './attachment-store.js';

/** harness2 本地 auth.json 路径（P2-8：提为常量，避免散落硬编码） */
const HARNESS2_AUTH_PATH = (home: string): string => join(home, '.harness2', 'auth.json');

/**
 * ZS3-T0 ACK 白名单：只有已实现的命令可以回 accepted，其余一律 rejected。
 * 红线⑩：任何情况不得回假 accepted；新增命令实现时同步加入本表。
 */
const SUPPORTED_COMMAND_TYPES = new Set([
  'createSession',
  'sendText',
  'stop',
  'resolveInteraction',
  'snoozeInteractionAutoResolution',
]);

/** ZS3-T2 审批截止时间（与 core approvalTimeoutMs 同口径）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/** 审批审计事件：走 core extension event 落 JSONL，不扩内建事件白名单。 */
const APPROVAL_REQUEST_EVENT = 'adapter/permission-request';
const APPROVAL_RESOLVED_EVENT = 'adapter/permission-resolved';

function ensureApprovalEventTypes(): void {
  if (!extensionEventTypes.has(APPROVAL_REQUEST_EVENT)) {
    extensionEventTypes.register({
      type: APPROVAL_REQUEST_EVENT,
      validator: (p) => typeof p.interactionId === 'string' && typeof p.toolName === 'string',
      projection: 'opaque',
    });
  }
  if (!extensionEventTypes.has(APPROVAL_RESOLVED_EVENT)) {
    extensionEventTypes.register({
      type: APPROVAL_RESOLVED_EVENT,
      validator: (p) => typeof p.interactionId === 'string' && typeof p.allowed === 'boolean',
      projection: 'opaque',
    });
  }
  if (!extensionEventTypes.has(USER_ATTACHMENTS_EVENT)) {
    extensionEventTypes.register({
      type: USER_ATTACHMENTS_EVENT,
      validator: (p) => typeof p.turnId === 'string' && Array.isArray(p.attachments),
      projection: 'opaque',
    });
  }
}

// 进程级注册：loadSession 可能早于首个 runSession，扩展类型必须先于读日志注册。
ensureApprovalEventTypes();

export interface AgentServiceOptions {
  dataRoot?: string;
  home?: string;
  /** 测试缝：脚本化 MockProvider，跳过 config 加载（service 层帧序列断言用）。 */
  mockScript?: MockScript;
  /** 测试缝：工具注册表（审批用例需要真实工具）；生产缺省空表。 */
  tools?: ToolRegistryTypeExport;
  /** 审批截止时间；测试可缩短，缺省 120s。 */
  approvalTimeoutMs?: number;
  /** 测试缝：创建后回传 provider 实例（断言 ChatRequest 形状用）。 */
  providerSink?: (provider: unknown) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  emitter?: Emitter<any>;
}

/** ZS3-T2 待审批条目：onAsk 的 promise 与 UI 交互 id 一一对应。 */
interface PendingApprovalEntry {
  interactionId: string;
  sessionId: string;
  toolRowId: number | null;
  toolCallId: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

/** ZS3-T4 delta 日志条目：支持 (base.seq, current] 真续传，不靠重放快照。 */
interface DeltaLogEntry {
  seq: number;
  deltas: unknown[];
}

export function createAgentService(opts: AgentServiceOptions = {}): IZCodeAgentService {
  const home = opts.home ?? resolveHarness2Home();
  const sessionsRoot = defaultSessionsRoot(home);
  const manager = createSessionManager(sessionsRoot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const emitter = opts.emitter ?? new Emitter<any>();

  // provider
  const defaultMock: MockScript = [{ text: 'Hello from harness2 mock provider.' }];
  const __diagPath = process.env.ZS2_DIAG_PATH || join(tmpdir(), 'zs2-diag.log');
  const __diagEnabled = process.env.ZS2_DIAG === '1';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  const __diag = (m: any) => {
    if (!__diagEnabled) return;
    try {
      appendFileSync(__diagPath, '[agent] ' + m);
    } catch {
      // 诊断写盘失败不影响主链路
    }
  };
  __diag('cwd=' + process.cwd() + ' home=' + home + ' HARNESS2_HOME=' + process.env.HARNESS2_HOME);
  let provider: unknown;
  if (opts.mockScript) {
    provider = new MockProvider(opts.mockScript);
    __diag('provider mocked (test seam)');
  } else {
    try {
      const loaded = loadConfig({ root: process.cwd(), home });
      __diag('loadConfig ok=' + !!loaded.config);
      if (loaded.config) {
        provider = createProvider(loaded.config, 'main', {
          authPath: HARNESS2_AUTH_PATH(home),
        });
        __diag('provider created: ' + (provider && provider.constructor && provider.constructor.name));
      } else {
        provider = new MockProvider(defaultMock);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      __diag('provider load FAILED: ' + (e && e.message));
      provider = new MockProvider(defaultMock);
    }
  }
  // ZS3 e2e 审批轮专用：确定性脚本化工具调用，避免依赖真实模型是否决定调工具。
  const e2eApproval = process.env.ZS3_E2E_APPROVAL === '1';
  if (e2eApproval) {
    provider = new MockProvider([
      {
        text: '审批测试：准备调用 write 工具',
        toolCalls: [
          {
            id: 'call-e2e-approval',
            name: 'write',
            arguments: '{"path":"zs3-approval.txt","content":"x"}',
          },
        ],
      },
      { text: '审批测试完成' },
    ]);
  }
  opts.providerSink?.(provider);

  /** 快照里的有效模型配置：UI Composer 的发送门禁依赖 config.modelSelection。 */
  let snapshotConfig: Parameters<typeof buildSnapshot>[0]['config'];
  try {
    const loadedForConfig = loadConfig({ root: process.cwd(), home });
    const main = loadedForConfig.config?.roles?.main;
    if (main !== undefined) {
      snapshotConfig = {
        provider: main.channel,
        model: main.model,
        thought: 'medium',
        thoughtLevels: ['medium'],
        followupMode: 'queue',
        mode: 'build',
        modelSelection: {
          providerId: main.channel,
          modelId: main.model,
          options: { reasoningLevel: 'medium' },
        },
      };
    }
  } catch {
    // 配置不可读时保持空配置（mock/测试路径）
  }

  const subs = new Map<string, { sessionId: string; seq: number; ordinal: number }>();
  const rowCounters = new Map<string, number>();
  const toolRowByCall = new Map<string, number>();

  // Per-session conversation state retained so that a later subscribe/resync
  // (the UI re-subscribes after promoting a draft session) can rebuild the
  // projection instead of starting from an empty snapshot. See task: UI not
  // rendering reply in draft prewarm flow.
  const sessionRows = new Map<string, ProjectedRow[]>();
  const sessionPhase = new Map<string, ControlPhase>();
  const sessionSeq = new Map<string, number>();
  /** 待审批/待问询交互（T2 起填充）；T0 保持空数组但集中存放，不在快照里散落硬编码。 */
  const sessionPendingInteractions = new Map<string, PendingInteraction[]>();
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  /** 用户 deny 时填写的理由，按 toolCallId 暂存，供 tool-result 错误文案使用。 */
  const deniedReasons = new Map<string, string>();
  /** 审批审计事件需要写回会话日志；runSession 期间登记，结束后清理。 */
  const sessionWriters = new Map<string, SessionWriter>();

  /** 本进程日志代际：进程重启即换代，客户端据此从 snapshot 重建而不是拼旧状态。 */
  const logEpoch = `zs3-${process.pid}-${Date.now()}`;
  const sessionDeltaLog = new Map<string, DeltaLogEntry[]>();
  const MAX_DELTA_LOG_ENTRIES = 2000;
  const MAX_CACHED_SESSIONS = 32;
  const sessionLastAccess = new Map<string, number>();
  const runningSessions = new Set<string>();
  /** 运行中 turn 的取消源（stop 命令真正 abort）。 */
  const runningAborts = new Map<string, AbortController>();
  const attachmentStore = new AttachmentStore({ home });
  /** ZS3.5：ask_user 工具的问询队列（core 原语；adapter 直接桥接 v4 pendingInteractions）。 */
  const userInputs = new UserInputQueue();
  const userInputTimers = new Map<string, NodeJS.Timeout>();

  // ZS3 e2e 审批轮专用工具：只写会话工作目录下的测试文件，不触碰用户数据。
  let e2eToolRegistry: ToolRegistryTypeExport | undefined;
  if (e2eApproval && !opts.tools) {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write',
      description: 'ZS3 e2e approval test tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      execute: (args, ctx) => {
        const a = args as { path?: string; content?: string };
        writeFileSync(join(ctx.cwd, a.path ?? 'zs3-approval.txt'), a.content ?? '');
        return { output: 'written' };
      },
    });
    e2eToolRegistry = registry;
  }

  /** 附件回读授权白名单：当前会话投影里的 ref + 该会话已提交的上传。 */
  function authorizedAttachmentRefs(sessionId: string): Set<string> {
    const refs = new Set<string>();
    for (const row of sessionRows.get(sessionId) ?? []) {
      for (const attachment of row.attachments ?? []) {
        if (
          attachment !== null &&
          typeof attachment === 'object' &&
          typeof (attachment as { ref?: unknown }).ref === 'string'
        ) {
          refs.add(resolve((attachment as { ref: string }).ref));
        }
      }
    }
    for (const upload of attachmentStore.listCommitted(sessionId)) {
      refs.add(resolve(upload.ref));
    }
    return refs;
  }

  /** 从当前会话投影取 ref 对应的 MIME（UI 的 read/预览请求不带 MIME）。 */
  function attachmentMimeForRef(sessionId: string, ref: string): string | undefined {
    const target = resolve(ref);
    for (const row of sessionRows.get(sessionId) ?? []) {
      for (const attachment of row.attachments ?? []) {
        if (
          attachment !== null &&
          typeof attachment === 'object' &&
          typeof (attachment as { ref?: unknown }).ref === 'string' &&
          typeof (attachment as { mime?: unknown }).mime === 'string' &&
          resolve((attachment as { ref: string }).ref) === target
        ) {
          return (attachment as { mime: string }).mime;
        }
      }
    }
    return undefined;
  }

  /** 本地零拷贝附件持久化：复制进 zs/attachments，保证重放/模型请求可读。 */
  function materializeAttachments(attachments: unknown[] | undefined): unknown[] | undefined {
    if (!Array.isArray(attachments)) return attachments;
    return attachments.map((attachment) => {
      if (attachment === null || typeof attachment !== 'object') return attachment;
      const ref = (attachment as { ref?: unknown }).ref;
      if (typeof ref !== 'string') return attachment;
      try {
        return { ...attachment, ref: attachmentStore.materialize(ref) };
      } catch {
        return attachment;
      }
    });
  }

  /** 模型附件解析：图片 → image part；文本 → 内联文本；超限/不支持 → null（由 core 占位）。 */
  function resolveAttachmentForModel(ref: string, mime: string, fileName: string): ChatContentPart | null {
    try {
      const path = resolve(ref);
      const stat = statSync(path);
      const baseMime = mime.split(';', 1)[0]?.trim().toLowerCase() ?? mime;
      if (baseMime.startsWith('image/')) {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(baseMime)) return null;
        if (stat.size > 5 * 1024 * 1024) return null;
        return {
          type: 'image',
          mimeType: baseMime,
          dataBase64: readFileSync(path).toString('base64'),
        };
      }
      if (baseMime === 'text/plain' || baseMime === 'text/markdown') {
        const max = 256 * 1024;
        const buffer = readFileSync(path);
        const text = buffer.subarray(0, max).toString('utf8');
        return {
          type: 'text',
          text: `[附件 ${fileName}]\n${text}${buffer.byteLength > max ? '\n[附件内容已截断]' : ''}`,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * ZS3.5 最小可测交互面（adapter-only）：把模型发起的 ask_user 变成 v4 userInput 弹窗。
   * 生产不使用 core SessionHub，这里直接用 core UserInputQueue 原语桥接。
   */
  function requestUserInputForTool(sessionId: string, raw: unknown): Promise<UserInputAnswer> {
    const args = (raw ?? {}) as {
      prompt?: unknown;
      options?: unknown;
      freeText?: unknown;
      questions?: unknown;
    };
    // 原生 AskUserQuestion 形状：questions[] 才会触发 UI 的 ElicitationDialog（完整样式）。
    const questions = Array.isArray(args.questions)
      ? args.questions
          .filter(
            (q): q is { question: string; header?: unknown; options?: unknown; multiSelect?: unknown } =>
              q !== null && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string',
          )
          .map((q) => {
            const rawOptions = Array.isArray(q.options) ? q.options : [];
            const options = rawOptions
              .filter(
                (o): o is { value: string; label: string; description?: string } =>
                  o !== null &&
                  typeof o === 'object' &&
                  typeof (o as { value?: unknown }).value === 'string' &&
                  typeof (o as { label?: unknown }).label === 'string',
              )
              .map((o) => ({
                value: o.value,
                label: o.label,
                ...(typeof o.description === 'string' ? { description: o.description } : {}),
              }));
            return {
              question: q.question,
              header: typeof q.header === 'string' && q.header.trim().length > 0 ? q.header : q.question.slice(0, 16),
              options,
              ...(q.multiSelect === true ? { multiSelect: true } : {}),
            };
          })
      : [];
    const legacyOptions = Array.isArray(args.options)
      ? args.options
          .filter(
            (o): o is { value: string; label: string } =>
              o !== null &&
              typeof o === 'object' &&
              typeof (o as { value?: unknown }).value === 'string' &&
              typeof (o as { label?: unknown }).label === 'string',
          )
          .map((o) => ({ optionId: o.value, label: o.label }))
      : [];
    const firstQuestion = questions[0];
    const prompt =
      firstQuestion?.question ??
      (typeof args.prompt === 'string' && args.prompt.trim().length > 0 ? args.prompt : '请选择');
    const options = firstQuestion
      ? firstQuestion.options.map((o) => ({ optionId: o.value, label: o.label }))
      : legacyOptions;
    const freeText = questions.length > 0 ? false : args.freeText === true || options.length === 0;
    const requestId = randomUUID();
    const now = Date.now();
    const expiresAt = now + DEFAULT_APPROVAL_TIMEOUT_MS;
    const request: UserInputRequestContract = {
      requestId,
      sessionId,
      prompt,
      freeText,
      ...(options.length > 0 ? { options } : {}),
      ...(questions.length > 0 ? { questions, currentQuestionIndex: 0, toolName: 'AskUserQuestion' } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const interaction: PendingInteraction = {
      interactionId: requestId,
      kind: 'userInput',
      anchorRowId: null,
      createdAt: now,
      autoResolution: {
        state: 'visibleCountdown',
        startedAt: now,
        visibleAt: now,
        deadlineAt: expiresAt,
      },
      payload: {
        kind: 'userInput',
        prompt,
        freeText,
        ...(options.length > 0 ? { options } : {}),
        ...(questions.length > 0 ? { questions, currentQuestionIndex: 0, toolName: 'AskUserQuestion' } : {}),
      },
    };
    return new Promise<UserInputAnswer>((resolveAnswer) => {
      const finish = (answer: UserInputAnswer): void => {
        const timer = userInputTimers.get(requestId);
        if (timer) clearTimeout(timer);
        userInputTimers.delete(requestId);
        const remaining = (sessionPendingInteractions.get(sessionId) ?? []).filter(
          (x) => x.interactionId !== requestId,
        );
        sessionPendingInteractions.set(sessionId, remaining);
        emitToSession(sessionId, [{ op: 'state.updated', patch: { pendingInteractions: remaining } }]);
        resolveAnswer(answer);
      };
      const timer = setTimeout(() => {
        userInputs.settle(requestId, { action: 'cancel' }, 'timeout');
      }, DEFAULT_APPROVAL_TIMEOUT_MS);
      userInputTimers.set(requestId, timer);
      if (!userInputs.register({ request, settle: finish })) {
        clearTimeout(timer);
        userInputTimers.delete(requestId);
        resolveAnswer({ action: 'cancel' });
        return;
      }
      const list = [...(sessionPendingInteractions.get(sessionId) ?? []), interaction];
      sessionPendingInteractions.set(sessionId, list);
      emitToSession(sessionId, [{ op: 'state.updated', patch: { pendingInteractions: list } }]);
    });
  }

  /** 生产缺省工具面：Write（审批演示/真实写文件）+ AskUserQuestion（原生样式问询弹窗）。 */
  function createDefaultTools(sessionId: string): ToolRegistryTypeExport {
    const registry = new ToolRegistry();
    registry.register({
      name: 'write',
      description:
        '在会话工作目录内创建或覆盖文件。会触发用户审批；path 必须是相对会话目录的路径，content 是文件内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对会话工作目录的文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path'],
      },
      execute: (toolArgs, ctx) => {
        const a = (toolArgs ?? {}) as { path?: unknown; content?: unknown };
        if (typeof a.path !== 'string' || a.path.length === 0) {
          return { error: 'path is required' };
        }
        const root = resolve(ctx.cwd);
        const target = resolve(root, a.path);
        if (target !== root && !target.startsWith(root + sep)) {
          return { error: 'path escapes the session working directory' };
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, typeof a.content === 'string' ? a.content : '');
        return { output: `wrote ${a.path}` };
      },
    });
    registry.register({
      // core ToolRegistry 只允许小写名；UI 的 tool identity 是大小写不敏感映射，
      // askuserquestion 会命中原生 AskUserQuestion 家族并走 ElicitationDialog。
      name: 'askuserquestion',
      description:
        '向用户提出一个或多个结构化问题并等待回答。用户要求你提供选项、让你做选择、或需要用户确认/补充信息时，必须调用本工具；不要把选项写成普通文字。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            description: '要问用户的问题列表；每个问题包含 header、question 与 options',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '完整问题文本' },
                header: { type: 'string', description: '简短标题（用于 tab/标题）' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' },
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['value', 'label'],
                  },
                },
                multiSelect: { type: 'boolean', description: '是否允许多选' },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
      execute: async (toolArgs) => {
        const answer = await requestUserInputForTool(sessionId, toolArgs);
        return { output: JSON.stringify(answer) };
      },
    });
    return registry;
  }

  /**
   * 重启后的会话恢复：从磁盘事件日志重建投影，避免把“内存里没有”误判成 running。
   * 日志不可读/会话不存在 → 空 idle 会话，至少不会卡住发送。
   */
  function ensureSessionLoaded(sessionId: string): void {
    if (sessionRows.has(sessionId)) return;
    try {
      const resumed = manager.resume(sessionId);
      const loaded = loadSession(resumed.dir);
      try {
        resumed.writer.close();
      } catch {
        // 只读恢复，writer 关闭失败不影响投影
      }
      const projection = projectEvents(
        loaded.events.map((e) => e.event),
        loaded.extensionEvents.map((e) => e.event),
      );
      sessionRows.set(sessionId, projection.rows);
      sessionSeq.set(sessionId, projection.lastSeq);
      // 空日志（草稿/新会话）按 idle；有历史的会话按投影终态。
      sessionPhase.set(sessionId, projection.rows.length > 0 ? projection.state.controlPhase : 'completedSuccess');
      rowCounters.set(
        sessionId,
        projection.rows.reduce((max, row) => Math.max(max, row.rowId), 0),
      );
      touchSession(sessionId);
    } catch {
      sessionRows.set(sessionId, []);
      sessionSeq.set(sessionId, 0);
      sessionPhase.set(sessionId, 'completedSuccess');
      rowCounters.set(sessionId, 0);
      touchSession(sessionId);
    }
  }

  function nextRowId(sessionId: string): number {
    const c = (rowCounters.get(sessionId) ?? 0) + 1;
    rowCounters.set(sessionId, c);
    return c;
  }

  type DeliveryKind = 'initial' | 'online' | 'recovery';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
  function emitWire(subId: string, frame: any, deliveryKind: DeliveryKind = 'online') {
    const sub = subs.get(subId);
    if (!sub) return;
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      logicalFrameId: `lf-${sub.ordinal}`,
      logicalFrameOrdinal: sub.ordinal++,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
      measurePhysicalFrameBytes: (w: any) => measureTopicNotificationEnvelopeBytes(w).maxBytes,
    });
    for (const w of wires) emitter.fire(w);
  }

  function emitSnapshot(
    subId: string,
    rows: ProjectedRow[],
    phase: ControlPhase,
    deliveryKind: DeliveryKind = 'initial',
  ) {
    const sub = subs.get(subId);
    if (!sub) return;
    const seq = sessionSeq.get(sub.sessionId) ?? sub.seq;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: Date.now(),
      payload: {
        kind: 'snapshot',
        snapshot: buildSnapshot({
          sessionId: sub.sessionId,
          seq,
          rows,
          phase,
          pendingInteractions: sessionPendingInteractions.get(sub.sessionId) ?? [],
          logEpoch,
          ...(snapshotConfig ? { config: snapshotConfig } : {}),
        }),
      },
    };
    sub.seq = seq;
    emitWire(subId, frame, deliveryKind);
  }

  /** 真续传帧：只回放 (fromSeq,toSeq] 的 delta，不推进 session 水位。 */
  function emitReplayDeltas(
    subId: string,
    fromSeq: number,
    toSeq: number,
    deltas: unknown[],
    deliveryKind: DeliveryKind,
  ) {
    const sub = subs.get(subId);
    if (!sub) return;
    const frame = {
      topic: `conversation/${sub.sessionId}`,
      subscriptionId: subId,
      fromSeq,
      toSeq,
      sentAt: Date.now(),
      payload: { kind: 'deltas', deltas },
    };
    sub.seq = toSeq;
    emitWire(subId, frame, deliveryKind);
  }

  /** 广播一批 delta：session 水位 +1，写入有界 delta 日志，所有订阅者同批对齐。 */
  function emitToSession(sessionId: string, deltas: unknown[], deliveryKind: DeliveryKind = 'online') {
    const nextSeq = (sessionSeq.get(sessionId) ?? 0) + 1;
    const entry: DeltaLogEntry = { seq: nextSeq, deltas };
    const log = sessionDeltaLog.get(sessionId) ?? [];
    log.push(entry);
    if (log.length > MAX_DELTA_LOG_ENTRIES) log.splice(0, log.length - MAX_DELTA_LOG_ENTRIES);
    sessionDeltaLog.set(sessionId, log);
    sessionSeq.set(sessionId, nextSeq);

    for (const [sid, sub] of subs) {
      if (sub.sessionId !== sessionId) continue;
      const frame = {
        topic: `conversation/${sessionId}`,
        subscriptionId: sid,
        fromSeq: sub.seq,
        toSeq: nextSeq,
        sentAt: Date.now(),
        payload: { kind: 'deltas', deltas },
      };
      sub.seq = nextSeq;
      emitWire(sid, frame, deliveryKind);
    }
  }

  /** 计算 base 是否可续传；epoch 换代/断档/超前一律回 snapshot（合法降级）。 */
  function resolveResume(
    sessionId: string,
    base: { logEpoch?: string; seq?: number } | null | undefined,
  ): { mode: 'resume' | 'snapshot'; fromSeq: number; toSeq: number; deltas: unknown[] } {
    const currentSeq = sessionSeq.get(sessionId) ?? 0;
    const baseSeq = base?.seq;
    if (!base || base.logEpoch !== logEpoch || typeof baseSeq !== 'number' || baseSeq < 0 || baseSeq > currentSeq) {
      return { mode: 'snapshot', fromSeq: 0, toSeq: currentSeq, deltas: [] };
    }
    const entries = (sessionDeltaLog.get(sessionId) ?? []).filter((e) => e.seq > baseSeq);
    let expected = baseSeq + 1;
    for (const entry of entries) {
      if (entry.seq !== expected) {
        return { mode: 'snapshot', fromSeq: 0, toSeq: currentSeq, deltas: [] };
      }
      expected += 1;
    }
    if (expected - 1 !== currentSeq) {
      return { mode: 'snapshot', fromSeq: 0, toSeq: currentSeq, deltas: [] };
    }
    return {
      mode: 'resume',
      fromSeq: baseSeq,
      toSeq: currentSeq,
      deltas: entries.flatMap((e) => e.deltas),
    };
  }

  function touchSession(sessionId: string) {
    sessionLastAccess.set(sessionId, Date.now());
  }

  function activeSessionIds(): Set<string> {
    const active = new Set(runningSessions);
    for (const sub of subs.values()) active.add(sub.sessionId);
    return active;
  }

  /** 投影缓存有界化（P2-1）：活跃订阅/运行中的会话豁免，其余按最近访问淘汰。 */
  function evictSessionsIfNeeded(): void {
    if (sessionRows.size <= MAX_CACHED_SESSIONS) return;
    const active = activeSessionIds();
    const candidates = [...sessionRows.keys()]
      .filter((id) => !active.has(id))
      .sort((a, b) => (sessionLastAccess.get(a) ?? 0) - (sessionLastAccess.get(b) ?? 0));
    while (sessionRows.size > MAX_CACHED_SESSIONS && candidates.length > 0) {
      const id = candidates.shift()!;
      sessionRows.delete(id);
      sessionSeq.delete(id);
      sessionPhase.delete(id);
      sessionPendingInteractions.delete(id);
      sessionDeltaLog.delete(id);
      rowCounters.delete(id);
      sessionLastAccess.delete(id);
    }
  }

  /** 审批落定：清 pending、更新工具行、落审计事件、resolve producer promise。 */
  function settleApproval(interactionId: string, allowed: boolean): boolean {
    const entry = pendingApprovals.get(interactionId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pendingApprovals.delete(interactionId);

    const remaining = (sessionPendingInteractions.get(entry.sessionId) ?? []).filter(
      (x) => x.interactionId !== interactionId,
    );
    sessionPendingInteractions.set(entry.sessionId, remaining);

    const rows = sessionRows.get(entry.sessionId) ?? [];
    const row = rows.find((r) => r.rowId === entry.toolRowId);
    const deltas: Array<{ op: string; row?: ProjectedRow; patch?: unknown }> = [];
    if (row) {
      row.status = allowed ? 'running' : 'cancelled';
      delete row.approvalInteractionId;
      deltas.push({ op: 'row.upserted', row });
    }
    deltas.push({ op: 'state.updated', patch: { pendingInteractions: remaining } });
    emitToSession(entry.sessionId, deltas);

    const writer = sessionWriters.get(entry.sessionId);
    try {
      writer?.appendExtension?.(APPROVAL_RESOLVED_EVENT, {
        interactionId,
        allowed,
        toolCallId: entry.toolCallId,
        resolvedAt: new Date().toISOString(),
      });
    } catch {
      // 会话已关闭：审计事件尽力而为，不影响审批落定
    }

    entry.resolve(allowed);
    return true;
  }

  async function runSession(sessionId: string, text: string, dirHint?: string, attachments?: unknown[]) {
    __diag(
      'runSession start provider=' +
        (provider && provider.constructor && provider.constructor.name) +
        ' fetch=' +
        typeof globalThis.fetch,
    );
    touchSession(sessionId);
    runningSessions.add(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    let resumed: any;
    if (dirHint) {
      const cb = await import('./core-bridge.js');
      resumed = { id: sessionId, dir: dirHint, writer: cb.SessionWriter.open(dirHint) };
    } else {
      resumed = manager.resume(sessionId);
    }
    ensureApprovalEventTypes();
    sessionWriters.set(sessionId, resumed.writer);
    const userRowId = nextRowId(sessionId);
    const turnHeaderRowId = nextRowId(sessionId);
    const assistantRowId = nextRowId(sessionId);
    let reasoningRowId: number | null = null;
    const toolCallIds: string[] = [];
    let reasoningAccumulated = '';
    const turnId = `turn-${Date.now()}`;
    const now = Date.now();

    // 附件审计登记（ZS3.5：同时供 buildChatMessages 还原模型 parts）。
    const modelAttachments = materializeAttachments(attachments);
    const userAttachments = Array.isArray(modelAttachments)
      ? modelAttachments.filter(
          (attachment): attachment is { ref: string; fileName?: string; mime: string; bytes?: number } =>
            attachment !== null &&
            typeof attachment === 'object' &&
            typeof (attachment as { ref?: unknown }).ref === 'string' &&
            typeof (attachment as { mime?: unknown }).mime === 'string',
        )
      : undefined;
    if (modelAttachments && modelAttachments.length > 0) {
      try {
        resumed.writer.appendExtension?.(USER_ATTACHMENTS_EVENT, { turnId, attachments: modelAttachments });
      } catch {
        // 审计事件尽力而为，不影响对话主链
      }
    }

    const userRow = makeUserInputRow(
      { rowId: userRowId, turnId, createdAt: now, createdAtSeq: 0 },
      text,
      modelAttachments,
    );
    const turnHeaderRow = makeTurnHeaderRow(
      { rowId: turnHeaderRowId, turnId, createdAt: now, createdAtSeq: 0 },
      'running',
    );
    const assistantTextRow = makeAssistantTextRow(
      { rowId: assistantRowId, turnId, createdAt: now, createdAtSeq: 0 },
      '',
      'streaming',
    );
    const previousRows = sessionRows.get(sessionId) ?? [];
    const rows: ProjectedRow[] = [...previousRows, userRow, turnHeaderRow, assistantTextRow];
    sessionRows.set(sessionId, rows);
    sessionPhase.set(sessionId, 'running');

    const initialDeltas = [
      { op: 'row.appended', row: userRow },
      { op: 'row.appended', row: turnHeaderRow },
      { op: 'row.appended', row: assistantTextRow },
    ];
    emitToSession(sessionId, initialDeltas);

    let accumulated = '';
    const tools = opts.tools ?? e2eToolRegistry ?? createDefaultTools(sessionId);
    const ac = new AbortController();
    runningAborts.set(sessionId, ac);
    const approval: ApprovalHandler = {
      // ask_user 本身是问询入口，不再叠加一层审批；其余工具统一走审批（可被拒绝）。
      decide: (input) => (input.tool.toLowerCase() === 'askuserquestion' ? 'allow' : 'ask'),
      onAsk: (input) =>
        new Promise<boolean>((resolve) => {
          const interactionId = randomUUID();
          const createdAt = Date.now();
          const deadlineAt = createdAt + (opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
          const argsText =
            typeof input.args === 'string' ? input.args : input.args !== undefined ? JSON.stringify(input.args) : '';
          const toolRow = rows.find(
            (r) =>
              r.kind === 'toolCall' &&
              r.toolName === input.tool &&
              (r.status === 'running' || r.status === 'inputStreaming') &&
              (r.inputText === argsText || !r.inputText),
          );
          const interaction: PendingInteraction = {
            interactionId,
            kind: 'permission',
            anchorRowId: toolRow?.rowId ?? null,
            createdAt,
            autoResolution: {
              state: 'visibleCountdown',
              startedAt: createdAt,
              visibleAt: createdAt,
              deadlineAt,
            },
            payload: {
              kind: 'permission',
              toolCallId: toolRow?.toolCallId ?? '',
              toolName: input.tool,
              summary: `允许执行 ${input.tool} 吗？`,
              detail: input.args,
              options: [
                { optionId: 'allowOnce', label: '允许本次', kind: 'allowOnce' },
                { optionId: 'allowAlways', label: '总是允许', kind: 'allowAlways' },
                { optionId: 'deny', label: '拒绝', kind: 'deny' },
              ],
            },
          };

          if (toolRow) {
            toolRow.status = 'pendingApproval';
            toolRow.approvalInteractionId = interactionId;
            emitToSession(sessionId, [{ op: 'row.upserted', row: toolRow }]);
          }
          const list = [...(sessionPendingInteractions.get(sessionId) ?? []), interaction];
          sessionPendingInteractions.set(sessionId, list);
          emitToSession(sessionId, [{ op: 'state.updated', patch: { pendingInteractions: list } }]);

          try {
            resumed.writer.appendExtension?.(APPROVAL_REQUEST_EVENT, {
              interactionId,
              toolCallId: toolRow?.toolCallId ?? '',
              toolName: input.tool,
              args: input.args,
              createdAt,
              expiresAt: deadlineAt,
            });
          } catch {
            // 审计事件尽力而为，不影响审批主链
          }

          const timeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
          const timer = setTimeout(() => settleApproval(interactionId, false), timeoutMs);
          pendingApprovals.set(interactionId, {
            interactionId,
            sessionId,
            toolRowId: toolRow?.rowId ?? null,
            toolCallId: toolRow?.toolCallId ?? '',
            resolve,
            timer,
          });
          if (ac.signal.aborted) settleApproval(interactionId, false);
        }),
    };
    let turnError: string | undefined;
    let turnStopReason: string | undefined;
    try {
      const result = await runTurn(resumed.writer, {
        provider: provider as never,
        tools: tools as never,
        cwd: resumed.dir,
        environment: { cwd: resumed.dir, platform: process.platform },
        resolveAttachment: resolveAttachmentForModel,
        userText: text,
        ...(userAttachments !== undefined && userAttachments.length > 0 ? { userAttachments } : {}),
        signal: ac.signal,
        approval,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
        onStream: (chunk: any) => {
          if (chunk.type === 'text-delta') {
            accumulated += chunk.text;
            emitToSession(sessionId, [{ op: 'row.delta', rowId: assistantRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'reasoning-delta') {
            if (reasoningRowId === null) {
              reasoningRowId = nextRowId(sessionId);
              const rrow = makeReasoningRow(
                { rowId: reasoningRowId, turnId, createdAt: now, createdAtSeq: 0 },
                '',
                'streaming',
              );
              rows.push(rrow);
              emitToSession(sessionId, [{ op: 'row.appended', row: rrow }]);
            }
            reasoningAccumulated += chunk.text;
            emitToSession(sessionId, [{ op: 'row.delta', rowId: reasoningRowId, path: 'text', append: chunk.text }]);
          } else if (chunk.type === 'tool-call') {
            const tr = nextRowId(sessionId);
            toolRowByCall.set(chunk.call.id, tr);
            toolCallIds.push(chunk.call.id);
            const argsText =
              typeof chunk.call.arguments === 'string'
                ? chunk.call.arguments
                : chunk.call.arguments !== undefined
                  ? JSON.stringify(chunk.call.arguments)
                  : '';
            const identity = { rowId: tr, turnId, createdAt: now, createdAtSeq: 0 };
            const toolRowBase = makeToolCallRow(identity, {
              toolCallId: chunk.call.id,
              toolName: chunk.call.name,
              status: 'inputStreaming',
              inputText: '',
            });
            const toolRowRunning = makeToolCallRow(identity, {
              toolCallId: chunk.call.id,
              toolName: chunk.call.name,
              status: 'running',
              inputText: argsText,
            });
            rows.push(toolRowRunning);
            const toolDeltas: unknown[] = [{ op: 'row.appended', row: toolRowBase }];
            if (argsText) {
              toolDeltas.push({ op: 'row.delta', rowId: tr, path: 'inputText', append: argsText });
            }
            toolDeltas.push({ op: 'row.upserted', row: toolRowRunning });
            emitToSession(sessionId, toolDeltas);
          } else if (chunk.type === 'tool-result') {
            const tr = toolRowByCall.get(chunk.callId);
            toolRowByCall.delete(chunk.callId);
            if (tr) {
              const existing = rows.find((r) => r.rowId === tr);
              const toolName = existing?.toolName ?? '';
              const inputText = existing?.inputText ?? '';
              const deniedReason = deniedReasons.get(chunk.callId);
              deniedReasons.delete(chunk.callId);
              const newRow = makeToolCallRow(
                { rowId: tr, turnId, createdAt: now, createdAtSeq: 0 },
                {
                  toolCallId: chunk.callId,
                  toolName,
                  status: chunk.ok ? 'success' : 'error',
                  inputText,
                  ...(chunk.ok
                    ? { output: { text: chunk.output ?? '' } }
                    : { error: { code: 'toolError', message: deniedReason ?? chunk.error ?? '' } }),
                },
              );
              const idx = rows.findIndex((r) => r.rowId === tr);
              if (idx >= 0) rows[idx] = newRow;
              emitToSession(sessionId, [{ op: 'row.upserted', row: newRow }]);
            }
          }
        },
      });
      turnError = result.error;
      turnStopReason = result.stopReason;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      turnError = (e as Error)?.message ?? String(e);
      __diag('runTurn FAILED: ' + (e && e.message));
      console.error('[zs2] runTurn failed:', (e as Error)?.message ?? e);
    }
    __diag('runTurn done accumulated=' + accumulated.length);
    // 轮次结束时仍挂着的审批一律 fail-closed，避免 producer promise 悬挂。
    for (const [id, entry] of [...pendingApprovals]) {
      if (entry.sessionId === sessionId) settleApproval(id, false);
    }
    sessionWriters.delete(sessionId);
    try {
      resumed.writer.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    } catch (e: any) {
      __diag('close failed ' + (e && e.message));
      console.error('[zs2] close failed', (e as Error)?.message);
    }

    const safeTurnError = turnError !== undefined ? redactSecrets(turnError).slice(0, 800) : undefined;
    const interrupted = ac.signal.aborted;
    const failed = !interrupted && (safeTurnError !== undefined || turnStopReason === 'error');
    const finalPhase: ControlPhase = interrupted ? 'completedInterrupted' : failed ? 'error' : 'completedSuccess';
    const failureText = safeTurnError !== undefined ? `模型请求失败：${safeTurnError}` : '模型请求失败';
    const assistantText = accumulated || (interrupted ? '已停止' : failed ? failureText : 'done');
    const assistantState = failed ? 'failed' : interrupted ? 'interrupted' : 'complete';
    const assistantRow = rows.find((r) => r.rowId === assistantRowId);
    if (assistantRow) {
      assistantRow.text = assistantText;
      assistantRow.state = assistantState;
    }
    sessionPhase.set(sessionId, finalPhase);
    sessionRows.set(sessionId, rows);
    sessionSeq.set(sessionId, sessionSeq.get(sessionId) ?? 0);

    const finishedTurnHeader = rows.find((r) => r.rowId === turnHeaderRowId);
    if (finishedTurnHeader) {
      finishedTurnHeader.state = failed ? 'failed' : interrupted ? 'completedInterrupted' : 'completedSuccess';
    }

    // 清理本轮工具调用索引（正常结果已删；取消/无结果调用在这里兜底），避免无界增长。
    for (const callId of toolCallIds) {
      toolRowByCall.delete(callId);
      deniedReasons.delete(callId);
    }

    const finalDeltas: Array<{ op: string; row?: ProjectedRow; patch?: unknown }> = [];
    if (reasoningRowId !== null) {
      finalDeltas.push({
        op: 'row.upserted',
        row: makeReasoningRow(
          { rowId: reasoningRowId, turnId, createdAt: now, createdAtSeq: 0 },
          reasoningAccumulated,
          'complete',
        ),
      });
    }
    if (finishedTurnHeader) {
      finalDeltas.push({ op: 'row.upserted', row: finishedTurnHeader });
    }
    finalDeltas.push({
      op: 'row.upserted',
      row: makeAssistantTextRow(
        { rowId: assistantRowId, turnId, createdAt: now, createdAtSeq: 0 },
        assistantText,
        assistantState,
      ),
    });
    finalDeltas.push({ op: 'state.updated', patch: { control: makeControl(finalPhase) } });
    emitToSession(sessionId, finalDeltas);
    runningSessions.delete(sessionId);
    runningAborts.delete(sessionId);
    evictSessionsIfNeeded();
  }

  const impl: Record<string, unknown> = {
    async helloConversationV4(): Promise<unknown> {
      return {
        kind: 'hello',
        protocolVersion: 3,
        connectionId: 'zs2',
        clientMode: 'desktop-continuous',
        deliveryProfile: 'continuous',
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: 'none',
          independentPlanState: true,
        },
        auth: {},
      };
    },
    async initializeConversationV4(): Promise<unknown> {
      return { ok: true };
    },
    async subscribeConversationV4(params: {
      sessionId?: string;
      base?: { logEpoch?: string; seq?: number };
    }): Promise<unknown> {
      const sessionId = params?.sessionId ?? 'default';
      touchSession(sessionId);
      ensureSessionLoaded(sessionId);
      const subscriptionId = `zs3-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resume = resolveResume(sessionId, params?.base);
      subs.set(subscriptionId, {
        sessionId,
        seq: resume.mode === 'resume' ? resume.toSeq : 0,
        ordinal: 1,
      });
      const rows = sessionRows.get(sessionId) ?? [];
      const phase = sessionPhase.get(sessionId) ?? 'completedSuccess';
      setTimeout(() => {
        if (resume.mode === 'resume') {
          // 真续传：initial 帧只带 (base.seq, current] 的 delta，不重发快照。
          emitReplayDeltas(subscriptionId, resume.fromSeq, resume.toSeq, resume.deltas, 'initial');
        } else {
          emitSnapshot(subscriptionId, rows, phase, 'initial');
        }
      }, 0);
      return { ack: { subscriptionId, mode: resume.mode, logEpoch } };
    },
    async resyncConversationV4(params: {
      subscriptionId?: string;
      base?: { logEpoch?: string; seq?: number } | null;
      forceSnapshot?: boolean;
    }): Promise<unknown> {
      const sid = params?.subscriptionId ?? '';
      const sub = subs.get(sid);
      if (!sub) {
        return { ack: { subscriptionId: sid, mode: 'snapshot', logEpoch } };
      }
      touchSession(sub.sessionId);
      ensureSessionLoaded(sub.sessionId);
      const resume = params?.forceSnapshot
        ? {
            mode: 'snapshot' as const,
            fromSeq: 0,
            toSeq: sessionSeq.get(sub.sessionId) ?? 0,
            deltas: [] as unknown[],
          }
        : resolveResume(sub.sessionId, params?.base);
      const rows = sessionRows.get(sub.sessionId) ?? [];
      const phase = sessionPhase.get(sub.sessionId) ?? 'completedSuccess';
      setTimeout(() => {
        if (resume.mode === 'resume') {
          emitReplayDeltas(sid, resume.fromSeq, resume.toSeq, resume.deltas, 'recovery');
        } else {
          emitSnapshot(sid, rows, phase, 'recovery');
        }
      }, 0);
      return { ack: { subscriptionId: sid, mode: resume.mode, logEpoch } };
    },
    async unsubscribeConversationV4(params: { subscriptionId?: string }): Promise<void> {
      if (params?.subscriptionId) {
        subs.delete(params.subscriptionId);
        evictSessionsIfNeeded();
      }
    },
    async attachmentBeginV4(params: AttachmentBeginParams): Promise<unknown> {
      return attachmentStore.begin(params);
    },
    async attachmentChunkV4(params: AttachmentChunkParams): Promise<unknown> {
      return attachmentStore.chunk(params);
    },
    async attachmentCommitV4(params: AttachmentTerminalParams): Promise<unknown> {
      return attachmentStore.commit(params);
    },
    async attachmentAbortV4(params: AttachmentTerminalParams): Promise<void> {
      attachmentStore.abort(params);
    },
    async attachmentReadV4(params: AttachmentReadParams): Promise<unknown> {
      return attachmentStore.read(
        params,
        authorizedAttachmentRefs(params.sessionId),
        attachmentMimeForRef(params.sessionId, params.ref),
      );
    },
    async attachmentPreviewSourceV4(params: AttachmentPreviewParams): Promise<unknown> {
      const sessionId = params.sessionId ?? '';
      return attachmentStore.previewSource(
        params,
        authorizedAttachmentRefs(sessionId),
        attachmentMimeForRef(sessionId, params.ref),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
    async sendConversationCommandV4(params: { workspacePath?: string; envelope?: any }): Promise<unknown> {
      const env = params?.envelope ?? {};
      if (!SUPPORTED_COMMAND_TYPES.has(env.type)) {
        return {
          commandId: env.commandId,
          status: 'rejected',
          reasonCode: 'proto.commandUnsupported',
          revisionAtDecision: 1,
        };
      }
      if (env.type === 'stop') {
        const sid = typeof env.sessionId === 'string' ? env.sessionId : '';
        const ac = sid ? runningAborts.get(sid) : undefined;
        if (ac) ac.abort();
        // 取消时一并收口挂起的交互，避免弹窗悬挂。
        for (const [id, entry] of [...pendingApprovals]) {
          if (entry.sessionId === sid) settleApproval(id, false);
        }
        for (const interaction of [...(sessionPendingInteractions.get(sid) ?? [])]) {
          if (interaction.kind === 'userInput') {
            userInputs.settle(interaction.interactionId, { action: 'cancel' }, 'cancelled');
          }
        }
        return { commandId: env.commandId, status: 'accepted', revisionAtDecision: 1 };
      }
      if (env.type === 'resolveInteraction') {
        const interactionId = env?.payload?.interactionId;
        if (typeof interactionId !== 'string' || interactionId.length === 0) {
          return {
            commandId: env.commandId,
            status: 'rejected',
            reasonCode: 'proto.invalidCommand',
            revisionAtDecision: 1,
          };
        }
        const answer = env?.payload?.answer ?? {};
        // 先查 userInput 队列（ask_user）；未知时才落到审批队列。
        const userInputAck = userInputs.respond(interactionId, answer);
        if (userInputAck.state !== 'unknown') {
          const uiOptionId = typeof answer.optionId === 'string' ? answer.optionId : undefined;
          if (userInputAck.state === 'applied') {
            return {
              commandId: env.commandId,
              status: 'accepted',
              revisionAtDecision: 1,
              result: {
                type: 'resolveInteraction',
                resolvedBy: {
                  clientId: env.clientId ?? 'unknown',
                  ...(uiOptionId ? { optionId: uiOptionId } : {}),
                },
              },
            };
          }
          return {
            commandId: env.commandId,
            status: 'noop',
            reasonCode: 'proto.alreadyResolved',
            revisionAtDecision: 1,
          };
        }
        const entry = pendingApprovals.get(interactionId);
        if (!entry) {
          // 先到先得：重复/迟到 resolve 幂等 noop。
          return {
            commandId: env.commandId,
            status: 'noop',
            reasonCode: 'proto.alreadyResolved',
            revisionAtDecision: 1,
          };
        }
        const optionId = typeof answer.optionId === 'string' ? answer.optionId : undefined;
        const allowed = optionId === 'allowOnce' || optionId === 'allowAlways' || answer.action === 'accept';
        if (!allowed && typeof answer.freeText === 'string' && answer.freeText.length > 0) {
          deniedReasons.set(entry.toolCallId, answer.freeText);
        }
        settleApproval(interactionId, allowed);
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: {
            type: 'resolveInteraction',
            resolvedBy: {
              clientId: env.clientId ?? 'unknown',
              ...(optionId ? { optionId } : {}),
            },
          },
        };
      }
      if (env.type === 'snoozeInteractionAutoResolution') {
        // ZS3 不实现倒计时暂停语义（登记 ZS4）；幂等 noop，不改变 pending 状态。
        return {
          commandId: env.commandId,
          status: 'noop',
          reasonCode: 'proto.snoozeUnsupported',
          revisionAtDecision: 1,
        };
      }
      if (env.type === 'createSession') {
        const created = manager.create(process.cwd());
        try {
          created.writer.close();
        } catch {}
        const sid = created.id;
        sessionRows.set(sid, []);
        sessionPhase.set(sid, 'completedSuccess');
        sessionSeq.set(sid, 0);
        rowCounters.set(sid, 0);
        touchSession(sid);
        evictSessionsIfNeeded();
        const firstInput = env?.payload?.firstInput;
        if (firstInput?.text) {
          setTimeout(() => {
            runSession(sid, firstInput.text, created.dir, firstInput.attachments).catch((e) =>
              console.error('[zs2] runSession failed:', (e as Error)?.message ?? e),
            );
          }, 0);
        }
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: { type: 'createSession', sessionId: sid, input: { delivery: 'startNow', inputId: env.commandId } },
        };
      }
      if (env.type === 'sendText') {
        let sid = env.sessionId;
        let dirHint: string | undefined;
        if (!sid) {
          const created = manager.create(process.cwd());
          try {
            created.writer.close();
          } catch {}
          sid = created.id;
          dirHint = created.dir;
          sessionRows.set(sid, []);
          sessionPhase.set(sid, 'completedSuccess');
          sessionSeq.set(sid, 0);
          rowCounters.set(sid, 0);
          touchSession(sid);
          evictSessionsIfNeeded();
        }
        const text = env?.payload?.text ?? '';
        setTimeout(() => {
          runSession(sid, text, dirHint, env?.payload?.attachments).catch((e) =>
            console.error('[zs2] runSession failed:', (e as Error)?.message ?? e),
          );
        }, 0);
        return {
          commandId: env.commandId,
          status: 'accepted',
          revisionAtDecision: 1,
          result: { type: 'inputAccepted', delivery: 'startNow', inputId: env.commandId },
        };
      }
      return {
        commandId: env.commandId,
        status: 'rejected',
        reasonCode: 'proto.commandUnsupported',
        revisionAtDecision: 1,
      };
    },
    async conversationRowsRangeV4(params: {
      sessionId?: string;
      beforeRowId?: number;
      limit?: number;
    }): Promise<unknown> {
      const sessionId = params?.sessionId ?? '';
      touchSession(sessionId);
      const rows = sessionRows.get(sessionId) ?? [];
      const limit = Math.max(1, Math.min(params?.limit ?? 60, 200));
      const before = params?.beforeRowId;
      const eligible = before === undefined ? rows : rows.filter((r) => r.rowId < before);
      const window = eligible.slice(-limit);
      return {
        rows: window,
        hasMore: eligible.length > window.length,
        atSeq: sessionSeq.get(sessionId) ?? 0,
        atRevision: 1,
        atLogEpoch: logEpoch,
      };
    },
    async conversationPlansV4(): Promise<unknown> {
      return { plans: [], atSeq: 0, atLogEpoch: logEpoch };
    },
    async queryConversationCommandsV4(): Promise<unknown> {
      return { results: [] };
    },
    onDynamicConversationFrame(): unknown {
      return emitter.event;
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
      const created = manager.create(params?.workspacePath ?? process.cwd());
      try {
        created.writer.close();
      } catch {}
      sessionRows.set(created.id, []);
      sessionPhase.set(created.id, 'completedSuccess');
      sessionSeq.set(created.id, 0);
      rowCounters.set(created.id, 0);
      touchSession(created.id);
      evictSessionsIfNeeded();
      return { sessionId: created.id };
    },
    async resumeSession(params: { sessionId: string }): Promise<unknown> {
      const r = manager.resume(params.sessionId);
      return { sessionId: r.id };
    },
    async listSessions(): Promise<unknown[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/协议边界动态类型，仅用于 lint 收敛，不改变运行时行为
      return manager.list().map((s: any) => ({ sessionId: s.id }));
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
