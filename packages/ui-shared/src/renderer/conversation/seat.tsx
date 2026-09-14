// seat.tsx — 会话席位（ui-conversation 的**宿主无关**装配）：视图环 + 常驻 composer + 提交边界。
//
// 本文件是共享包里的唯一「会话页装配点」：数据源（store/controller）与视图注册表、持久缝、
// 图片缓存、composer 链**全部由壳注入**（不抓全局单例，注入式才可测）。各壳自己的组装根
// （desktop `conversation/assembly.tsx`、web `src/app.tsx`）负责决定注入什么。
//
// 语义归属（与桌面 P5-C/P6 完全同一份实现，本阶段只搬不改语义）：
//   1. 视图环（D-30/D-32）：注册表由壳提供；本组件只渲染 + 切换。
//   2. 视图选择（D-31）：持久选择走注入缝（`Persistence`）；环外改写（inspect 跳轨迹）可订阅。
//   3. 会话绑定（D-32）：同一会话内 session 对象引用稳定（切换视图不重建会话、不重订阅）。
//   4. 图片 URL 缓存（D-39）：`peekUrl` 传给视图环（Chat 与 Trajectory 共用一次授权读取）；
//      未注入读取器时恒 null（如实占位，绝不伪造 URL）。
//   5. composer 真实 IO（D-34/D-35/D-36/D-37）：submit 走 controller.submitMessage（finalText 前
//      trim 载荷）、stop 走 controller.cancelTurn、running 取 store 真实运行态、附件走
//      `FileUploadQueue`（并发上限默认 2）。
//   6. 提交边界：`@path` → 内容与 references 在此解析（`shared/file-ref.ts` + 注入的读取通道）；
//      ack 落定后 rejected → 上抛（Composer 还原草稿 + 附件并显示原因），unknown → 交给可见队列
//      如实标注（不假报成功、不诱导重发）。
//   7. D-46 壳的义务：composer 以浮层置于全高内容之上，实测高度经 `ComposerOverlayHost` 给视图，
//      并写 CSS 变量 `--trajectory-composer-inset`；未测量（0）时不写变量 = 不虚构预留。
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { newClientMessageId } from '../../shared/ids.js';
import { resolveFileRefs, type FileRefReader } from '../../shared/file-ref.js';
import type { MessageReferenceShape, SubmitAckStateShape } from '../../shared/protocol.js';
import { lastTurnIdOf, type Controller } from '../app-controller.js';
import { ChatTranscript } from '../components/ChatView.js';
import { ambientHostBridge } from '../host-bridge.js';
import type { AppStore } from '../store.js';
import {
  attachmentReference,
  DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  type ComposerAttachment,
  type ImageReadIO,
  type UploadTransport,
} from './composer/attachments.js';
import { Composer, type ComposerIO } from './composer/Composer.js';
import { ComposerChain } from './composer/composer-chain.js';
import {
  ComposerStore,
  createComposerState,
  createSubmissionQueue,
  draftText,
  enqueueSubmission,
  submissionOrder,
  type PendingSubmission,
  type SubmissionQueueState,
} from './composer/composer-state.js';
import { DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior } from './composer/submit-policy.js';
import { createImageUrlCache, type ImageUrlCache, type ConversationImageReader } from './views/image-url-cache.js';
import type { ConversationViewRegistry, ConversationViewProps } from './views/view-registry.js';
import { ConversationViewRing, type ViewSelectionPersistence } from './views/view-ring.js';
import {
  TRAJECTORY_COMPOSER_INSET_VAR,
  createComposerOverlayHost,
  useComposerOverlayInset,
  type ComposerOverlayHost,
} from '../trajectory/shell-contract.js';
import { createInMemoryPersistence, type Persistence } from '../ports.js';

/**
 * 会话对象（D-32 身份稳定）：视图环只依赖它订阅会话级更新，并把它交给视图作为数据源。
 * 数据源（store/controller）随会话对象一起传给视图 —— 视图不抓全局单例，注入 store 测试才成立。
 */
export interface ConversationSession {
  readonly id: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly store: AppStore;
  readonly controller: Controller;
}

/** `chat` 视图的归属包名（D-02 口径：一个 UI 能力一个包名） */
export const CONVERSATION_CHAT_OWNER = 'ui-chat';

/**
 * `chat` 视图内容：既有转录渲染（`ChatTranscript`）。
 * 数据源从会话对象取（与视图环同一份 store）——会话内数据不因视图切换而换源。
 */
export function ConversationChatView({ sessionId, session }: ConversationViewProps<ConversationSession>): ReactNode {
  return <ChatTranscript streamId={sessionId} store={session.store} controller={session.controller} />;
}

/** 共享缺省：不落任何浏览器存储的视图选择（D-14 口径），壳要持久化须自行注入实现 */
export const sharedViewPersistence: Persistence = createInMemoryPersistence();
/** 共享缺省：没有图片授权读取通道 → read 恒 null（视图显示占位，绝不伪造 URL） */
export const noImageRead: ConversationImageReader = () => null;
/** 共享缺省图片 URL 缓存（会话内逐附件去重） */
export const sharedImageUrls: ImageUrlCache = createImageUrlCache({ read: noImageRead });
/** 共享缺省 composer 链（当前无 takeover 注册项 = 默认 composer 常驻） */
export const sharedComposerChain: ComposerChain = new ComposerChain();
/** 共享缺省浮层测量宿主（应用级单例；壳也可自行注入） */
export const sharedComposerOverlay: ComposerOverlayHost = createComposerOverlayHost();

/**
 * 缺省 upload transport：**如实失败**（不伪造 token）。壳若有上传通道（如未来的桌面上传 IPC /
 * serve 上传端点）应注入自己的实现；缺省下失败项留在附件列表供重提。
 */
export const noUploadTransport: UploadTransport = {
  upload: async () => {
    throw new Error('未配置文件上传通道（该壳未注入 UploadTransport）');
  },
};

export interface ConversationComposerPortDeps {
  readonly store: AppStore;
  readonly controller: Controller;
  /** clientMessageId 生成器（测试注入确定性 id；生产 = shared/ids） */
  readonly createClientMessageId?: () => string;
  /** 文件上传通道（缺省 = noUploadTransport，如实失败） */
  readonly transport?: UploadTransport;
  readonly maxConcurrentFileUploads?: number;
  /** `@path` 读取通道（缺省 = 宿主能力端口 HostBridge.readFileForRef） */
  readonly readRef?: FileRefReader;
  /** ack 等待超时（不用于谎报；超时只是不再等待 ack 结果） */
  readonly ackTimeoutMs?: number;
}

/** 提交台账上限（防无界增长；权威在途状态仍在 store.pendingSubmits，见 pendingSubmissions 注释） */
const SUBMISSION_LEDGER_LIMIT = 200;

/** 已就绪附件的引用（**只取真能送出去的**：无凭证/图片等无通道附件不产引用，不伪造 kind —— P1-3） */
function readyAttachmentReferences(attachments: readonly ComposerAttachment[]): MessageReferenceShape[] {
  const out: MessageReferenceShape[] = [];
  for (const attachment of attachments) {
    if (attachment.state !== 'ready') continue;
    const reference = attachmentReference(attachment);
    if (reference !== undefined) out.push(reference);
  }
  return out;
}

/**
 * 等一次提交的 ack 结论（三态 `accepted | rejected | unknown`）。
 *   - accepted → resolve；
 *   - unknown → resolve（语义是「还没确认」，可见队列已如实标「未确认，勿重复提交」；
 *     此时**不**把内容还原进草稿，避免诱导用户重发造成重复）；
 *   - rejected → reject（Composer 按 P0-2 的还原语义把内容还给用户，并显示原因 —— 不静默）。
 * ack 由 store 的既有收敛路径写入（WS 帧 / 5s 超时标 unknown），此处不新增通道。
 */
function waitForSubmitAck(
  store: AppStore,
  sessionId: string,
  clientMessageId: string,
): Promise<{ state: SubmitAckStateShape; reason?: string }> {
  const read = (): { state: SubmitAckStateShape; reason?: string } | undefined =>
    store.peekStream(sessionId)?.submitAcks[clientMessageId];
  const existing = read();
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      const ack = read();
      if (ack === undefined) return;
      unsubscribe();
      resolve(ack);
    });
  });
}

export function createConversationComposerPort(deps: ConversationComposerPortDeps): ConversationComposerPort {
  let ledger: SubmissionQueueState = createSubmissionQueue();
  // 壳未注入 readRef 时走宿主能力端口（HostBridge.readFileForRef）；端口也没有 = 如实返回失败并标注
  // `reason:'unavailable'`（P2-3：本壳没有读取通道 ≠ 文件不存在；file-ref 据此分开归因，不误导用户）。
  const bridge = ambientHostBridge() ?? {};
  const readRef: FileRefReader =
    deps.readRef ??
    ((path, cwd) =>
      bridge.readFileForRef?.(path, cwd) ??
      Promise.resolve({ ok: false, reason: 'unavailable', error: '该壳未提供文件引用读取通道' }));

  /**
   * 提交边界（D-34 detached attempt 的落点）。按上游 `input/facade.ts` 的顺序：
   * trim 载荷 → 序列化引用 → 投递 → 等落定。失败一律上抛，由 Composer 走 P0-2 的还原。
   */
  const deliver = async (submission: PendingSubmission): Promise<void> => {
    const sessionId = submission.sessionId;
    // P0-1：**在提交边界 trim**（上游 facade.ts:736 / :760 `defaultSink(draft.trim(), …)`）。
    // 只 trim 发出去的载荷：草稿内容与失败台账保留用户原文（还原要还原文）。
    const wireDraft = submission.rawText.trim();
    const cwd = deps.store.getState().sessions.find((s) => s.id === sessionId)?.cwd;
    // P1-1：`@path` 引用解析（复用 shared/file-ref 的既有实现 + 注入的读取通道）。
    // 无 `@` / cwd 未知 → 原样返回（零读取，不发多余请求）。
    const resolved = await resolveFileRefs(wireDraft, cwd, readRef);
    // 引用来源可见（D1）：进了上下文的 / 被拒的 / 未找到的，全部记账后由 ChatTranscript 展示
    deps.store.setRefReport(sessionId, {
      sources: resolved.sources,
      skipped: resolved.skipped,
      notFound: resolved.notFound,
      unavailable: resolved.unavailable,
    });
    // 解析到的文件同时作为结构化引用上报（kind:'file' + 原 token 作 path；不伪造其它 kind）
    const fileRefReferences: MessageReferenceShape[] = resolved.sources.map((source) => ({
      id: `file-ref:${source.token}`,
      kind: 'file',
      path: source.token,
    }));
    // D-35 的 intent 语义由 core 判定，壳只投递意图；references = chip 引用 + 已就绪附件引用 + @引用
    await deps.controller.submitMessage(sessionId, resolved.finalText, {
      clientMessageId: submission.clientMessageId,
      intent: submission.intent,
      references: [
        ...submission.references,
        ...readyAttachmentReferences(submission.attachments),
        ...fileRefReferences,
      ],
      ...(submission.expectedTurnId !== undefined ? { expectedTurnId: submission.expectedTurnId } : {}),
    });
    // 投递已进通道，等 ack 结论：rejected 必须让用户看见原因并把内容拿回来（P1-2）
    const ack = await waitForSubmitAck(deps.store, sessionId, submission.clientMessageId);
    if (ack.state === 'rejected') {
      throw new Error(ack.reason ?? '服务端拒绝了本次提交（未给出原因）');
    }
  };

  const io: ComposerIO = {
    createClientMessageId: deps.createClientMessageId ?? newClientMessageId,
    submit: (submission: PendingSubmission) => {
      ledger = enqueueSubmission(ledger, submission);
      if (ledger.entries.length > SUBMISSION_LEDGER_LIMIT) {
        ledger = { entries: ledger.entries.slice(-SUBMISSION_LEDGER_LIMIT) };
      }
      return deliver(submission);
    },
    stop: () => {
      // 停止 = 既有取消动作（三态 ack；不把取消当 undo、不假报停止）；目标会话取当前选中
      const id = deps.store.getState().selectedId;
      if (id !== null) void deps.controller.cancelTurn(id);
    },
    transport: deps.transport ?? noUploadTransport,
    maxConcurrentFileUploads: deps.maxConcurrentFileUploads ?? DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  };
  return { io, pendingSubmissions: () => submissionOrder(ledger) };
}

/** composer 的外部 IO 组合（D-34～D-37）。`pendingSubmissions()` 是**提交顺序台账**。 */
export interface ConversationComposerPort {
  readonly io: ComposerIO;
  pendingSubmissions(): readonly string[];
}

export interface ConversationSeatProps {
  readonly store: AppStore;
  readonly controller: Controller;
  /** 会话视图注册表（壳装配：每个壳至少要注册 `chat`，否则视图环按 D-31 不渲染） */
  readonly registry: ConversationViewRegistry<ConversationSession>;
  /** 视图选择持久缝（缺省 = 内存实现，不落存储） */
  readonly persistence?: ViewSelectionPersistence;
  readonly imageUrls?: ImageUrlCache;
  readonly chain?: ComposerChain;
  /** 会话头（壳注入：不同壳的头部信息面不同；缺省不渲染头部） */
  readonly header?: (info: { readonly sessionId: string; readonly cwd?: string }) => ReactNode;
  /** 繁忙态 Enter 偏好（缺省 = 默认 queue；壳无配置通道时保持缺省，缺口如实登记） */
  readonly busyEnter?: BusyEnterBehavior;
  readonly maxConcurrentFileUploads?: number;
  readonly createClientMessageId?: () => string;
  readonly transport?: UploadTransport;
  /** 图片读取缝（图片附件走 FileReader data URL；测试注入假实现） */
  readonly imageIO?: ImageReadIO;
  /** `@path` 读取通道（缺省 = 宿主能力端口；测试注入假实现） */
  readonly readRef?: FileRefReader;
  /** 预组装的 composer port（测试/诊断用；缺省内部按 deps 组装） */
  readonly port?: ConversationComposerPort;
  /** D-46：composer 浮层测量宿主（缺省 = 共享单例） */
  readonly composerOverlayHost?: ComposerOverlayHost;
}

/**
 * 会话席位内容（ui-conversation）：会话头（可选）+ 视图环 + **常驻 composer**。
 * D-33：composer 不因「无会话」卸载 —— 无会话时仍然挂载但 inert（由 Composer 内部落实）。
 */
export function ConversationSeat(props: ConversationSeatProps): ReactNode {
  const { store, controller } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const sessionId = state.selectedId;
  const registry = props.registry;
  const persistence = props.persistence ?? sharedViewPersistence;
  const imageUrls = props.imageUrls ?? sharedImageUrls;
  const chain = props.chain ?? sharedComposerChain;

  // composer IO：controller 真身 + 确定性 id/transport 注入（测试）；台账随 port 存活
  const port = useMemo(
    () =>
      props.port ??
      createConversationComposerPort({
        store,
        controller,
        ...(props.createClientMessageId !== undefined ? { createClientMessageId: props.createClientMessageId } : {}),
        ...(props.transport !== undefined ? { transport: props.transport } : {}),
        ...(props.maxConcurrentFileUploads !== undefined
          ? { maxConcurrentFileUploads: props.maxConcurrentFileUploads }
          : {}),
        ...(props.readRef !== undefined ? { readRef: props.readRef } : {}),
      }),
    [
      props.port,
      props.createClientMessageId,
      props.transport,
      props.maxConcurrentFileUploads,
      props.readRef,
      store,
      controller,
    ],
  );

  // D-32：同一会话内会话对象引用稳定（切换视图不重建会话、不重订阅）；换会话才换引用
  const session = useMemo<ConversationSession | undefined>(
    () => (sessionId === null ? undefined : { id: sessionId, subscribe: store.subscribe, store, controller }),
    [sessionId, store, controller],
  );

  // D-33 草稿隔离：每会话一个草稿 store（切换会话换 store，不串味）；首次进入用持久草稿播种
  const draftsRef = useRef(new Map<string, ComposerStore>());
  const composerStore = useMemo(() => {
    if (sessionId === null) return new ComposerStore();
    const existing = draftsRef.current.get(sessionId);
    if (existing !== undefined) return existing;
    const persisted = store.draftFor(sessionId);
    const created = new ComposerStore(
      persisted.length > 0
        ? createComposerState({ atoms: [{ kind: 'text', text: persisted }], caret: { node: 1, offset: 0 } })
        : createComposerState(),
    );
    draftsRef.current.set(sessionId, created);
    return created;
  }, [sessionId, store]);

  // 草稿落盘（D1）：内存即时生效，落盘走 controller 的去抖合并 —— 不直连桥，不另开通道。
  // 只写「变化后」的值：挂载时不回写，避免把磁盘草稿（若因异步加载晚到而未被播种）误清空。
  useEffect(() => {
    if (sessionId === null) return undefined;
    let last = draftText(composerStore.getState());
    return composerStore.subscribe(() => {
      const next = draftText(composerStore.getState());
      if (next === last) return;
      last = next;
      controller.setDraft(sessionId, next);
    });
  }, [composerStore, sessionId, controller]);

  const cwd = sessionId === null ? undefined : state.sessions.find((s) => s.id === sessionId)?.cwd;
  const stream = sessionId === null ? undefined : store.peekStream(sessionId);
  const running = stream?.running === true;
  // P1-2：steer 的 expectedTurnId 用**控制层同一推导**（`lastTurnIdOf`，与取消目标定位同一函数）。
  // `stream.activeAttempt?.turnId` 只在 resume-snapshot 到达时才有值（事件/重放路径只置 running），
  // 只读它会让 steer 恒缺 expectedTurnId → core 直接 rejected（sessions-tasks.ts:95-104）。
  const activeTurnId = stream === undefined ? undefined : (stream.activeAttempt?.turnId ?? lastTurnIdOf(stream));
  const composerSession =
    sessionId === null
      ? undefined
      : { id: sessionId, running, ...(activeTurnId !== undefined ? { activeTurnId } : {}) };

  // D-46：composer 以浮层置于全高内容之上，并预留**实测**高度。
  // 测量源 = ResizeObserver（环境无 RO 时静默不测 → 预留 0，绝不虚构），
  // 出口两处：具备轨迹/浮层能力的视图经 host 读 props；其余视图读 CSS 变量 `--trajectory-composer-inset`。
  const composerOverlayHost = props.composerOverlayHost ?? sharedComposerOverlay;
  const composerInsetPx = useComposerOverlayInset(composerOverlayHost);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    composerOverlayHost.observe(composerRef.current);
    return () => composerOverlayHost.observe(null);
  }, [composerOverlayHost]);
  const seatStyle: CSSProperties | undefined =
    composerInsetPx === undefined
      ? undefined
      : ({ [TRAJECTORY_COMPOSER_INSET_VAR]: `${composerInsetPx}px` } as CSSProperties);

  return (
    <div className="conversation-seat" data-testid="conversation-seat" style={seatStyle}>
      {sessionId !== null && session !== undefined ? (
        <>
          {props.header?.({ sessionId, ...(cwd !== undefined ? { cwd } : {}) })}
          <ConversationViewRing
            registry={registry}
            sessionId={sessionId}
            session={session}
            persistence={persistence}
            imageUrl={imageUrls.peekUrl}
            emptyFallback={
              <div className="chat empty-pane">
                <p>当前没有可渲染的会话视图</p>
              </div>
            }
          />
        </>
      ) : (
        <div className="chat empty-pane">
          <p>选择左侧会话开始对话（Ctrl+K 打开命令面板）</p>
        </div>
      )}
      <div className="composer-overlay" ref={composerRef} data-testid="composer-overlay">
        <Composer
          sessionId={sessionId ?? undefined}
          session={composerSession}
          running={running}
          busyEnter={props.busyEnter ?? DEFAULT_BUSY_ENTER_BEHAVIOR}
          // owner/parent 离线 = 锁定编辑；无会话也锁定（Composer 内部另判 sessionId）
          locked={state.status !== 'connected'}
          stopAvailable={running}
          store={composerStore}
          chain={chain}
          io={port.io}
          {...(props.imageIO !== undefined ? { imageIO: props.imageIO } : {})}
        />
      </div>
    </div>
  );
}
