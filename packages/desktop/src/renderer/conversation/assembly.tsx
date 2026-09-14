// assembly.tsx — 桌面对话页接线（P5-C）：把「视图环（P5-A）」与「composer（P5-B）」接进会话席位。
//
// 本文件是**唯一装配点**（渲染侧），只做接线，不重新实现业务语义：
//   1. 视图环（D-30/D-32）：注册**真实存在**的视图 —— 当前只有 `chat`（转录渲染）。
//      Trajectory 归 P6，现在不注册（不画空标签、不放点了没反应的 tab）。
//   2. 视图选择（D-31）：持久选择走注入缝（`ViewSelectionPersistence`）——本文件给**内存**实现，
//      不碰任何浏览器端持久化存储（D-14 口径，`test/layout/no-persistence` 有反向守卫），
//      无持久源时按规则回落 `chat`。
//   3. 会话绑定（D-32）：同一会话内 session 对象引用稳定（切换视图不重建会话、不重订阅）。
//   4. 图片 URL 缓存（D-39）：`createImageUrlCache` 的 `peekUrl` 传给视图环（Chat 与未来 Trajectory 共用）。
//      授权读取来源：桌面桥**当前没有**图片/附件授权读取 IPC → read 恒 null（缺口登记，绝不伪造 URL）。
//   5. composer 真实 IO（D-34/D-35/D-36/D-37）：submit 走 `app-controller.submitMessage`
//      （最终是 bridge `op:'submit'`，intent 语义由 core 判定，桌面只投递意图）；stop 走既有取消；
//      running 取 store 真实运行态；附件走 B 的 `FileUploadQueue`（并发上限默认 2）。
//   6. 繁忙态 Enter 偏好（D-35）：桌面**暂无**配置通道（`settings:getPreferences` 无 busyEnter 字段，
//      `SettingsConfigShape` 也没有 `ui` 节）→ 先用默认 `queue` 并登记缺口，不造假配置读取。
//   7. 提交边界（P0-1/P1-1/P1-2/P1-3 修复后的口径）：
//      - **trim 在边界**（上游 `ui-conversation/src/client/input/facade.ts:736,760` `defaultSink(draft.trim(), …)`）：
//        只 trim 发出去的载荷，草稿/失败台账保留原文；
//      - `@path` → 内容与 references 的解析在此处恢复（复用 `shared/file-ref.ts` + 既有
//        `readFileForRef` IPC；解析结果进 `store.setRefReport` 由转录可见，不静默）；
//      - ack 落定后 rejected → 上抛给 Composer（按 P0-2 语义还原草稿 + 显示原因），
//        unknown → 交由可见队列如实标注，不假报成功；
//      - 附件引用只取真能送出去的（图片无通道 → 不产引用、如实标 failed）。
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { newClientMessageId } from '../../shared/ids.js';
import { resolveFileRefs, type FileRefReader } from '../../shared/file-ref.js';
import type { MessageReferenceShape, SubmitAckStateShape } from '../../shared/protocol.js';
import { lastTurnIdOf, type Controller } from '../app-controller.js';
import { ChatTranscript } from '../components/ChatView.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
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
import { createImageUrlCache, ImageUrlCache, type ConversationImageReader } from './views/image-url-cache.js';
import { CHAT_VIEW_KEY } from './views/view-selection.js';
import {
  createConversationViewRegistry as createViewRegistry,
  type ConversationViewProps,
  type ConversationViewRegistry,
} from './views/view-registry.js';
import { ConversationViewRing, type ViewSelectionPersistence } from './views/view-ring.js';

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
 * 数据源从会话对象取（与视图环同一份 store）—— 会话内数据不因视图切换而换源。
 */
export function ConversationChatView({ sessionId, session }: ConversationViewProps<ConversationSession>): ReactNode {
  return <ChatTranscript streamId={sessionId} store={session.store} controller={session.controller} />;
}

/** 会话视图注册表：只注册真实存在的视图（当前 = chat） */
export function createDesktopConversationViewRegistry(): ConversationViewRegistry<ConversationSession> {
  const registry = createViewRegistry<ConversationSession>();
  registry.register({
    key: CHAT_VIEW_KEY,
    title: 'Chat',
    owner: CONVERSATION_CHAT_OWNER,
    component: ConversationChatView,
  });
  return registry;
}

/** 应用级视图注册表（渲染端单例；与 shellSlots 同层） */
export const conversationViewRegistry = createDesktopConversationViewRegistry();

/**
 * 视图选择持久缝（D-31 / D-14）：**内存**实现 —— 只在本进程存活期内记住每个会话的选择。
 * 刻意不落浏览器存储（D-14 明令）；要跨重启持久须由宿主另注入实现（如主进程配置文件通道）。
 */
export function createInMemoryViewSelectionPersistence(): ViewSelectionPersistence {
  const bySession = new Map<string, string>();
  return {
    read: (sessionId) => bySession.get(sessionId) ?? null,
    write: (sessionId, key) => {
      if (key === null) bySession.delete(sessionId);
      else bySession.set(sessionId, key);
    },
  };
}

export const conversationViewPersistence = createInMemoryViewSelectionPersistence();

/**
 * D-39 授权读取（宿主注入）。**缺口登记**：preload 暴露的 IPC 面（见 shared/protocol.ts `Harness2Api`）
 * 没有图片/附件授权读取通道，`readFileForRef` / `getSnapshotForCall` 都只回文本快照、不是图片 URL 来源。
 * 故此处恒 null —— 视图拿不到图就显示占位，**绝不伪造 URL**；待主进程新增授权读取通道后只改这里。
 */
export const desktopConversationImageRead: ConversationImageReader = () => null;

/** 应用级图片 URL 缓存（会话内逐附件去重；Chat 与未来 Trajectory 共用同一入口） */
export const conversationImageUrls = createImageUrlCache({ read: desktopConversationImageRead });

/**
 * 文件上传 transport。**缺口登记**：桌面桥没有上传 IPC（core/gateway 也没有上传端点），
 * 因此如实失败（不伪造 token）。文件仍会走 `FileUploadQueue`（并发 2、FIFO、失败不阻塞后续），
 * 失败项留在附件列表供重提 —— 待上传通道落地后只替换本对象。
 */
export const desktopUploadTransport: UploadTransport = {
  upload: async () => {
    throw new Error('未配置文件上传通道（主进程未暴露上传 IPC）');
  },
};

/** composer 链（D-38）：壳持有唯一实例；当前无 takeover 注册项（无人接管 = 默认 composer 常驻） */
export const conversationComposerChain = new ComposerChain();

export interface ConversationComposerPortDeps {
  readonly store: AppStore;
  readonly controller: Controller;
  /** clientMessageId 生成器（测试注入确定性 id；生产 = shared/ids） */
  readonly createClientMessageId?: () => string;
  /** 文件上传通道（缺省 = desktopUploadTransport，如实失败） */
  readonly transport?: UploadTransport;
  readonly maxConcurrentFileUploads?: number;
  /** `@path` 读取通道（缺省 = window.harness2.readFileForRef，走主进程 fs 的既有通道） */
  readonly readRef?: FileRefReader;
  /** ack 等待超时（不用于谎报；超时只是不再等待 ack 结果） */
  readonly ackTimeoutMs?: number;
}

/** 提交台账上限（防无界增长；权威在途状态仍在 store.pendingSubmits，见 pendingSubmissions 注释） */
const SUBMISSION_LEDGER_LIMIT = 200;

/** 缺省 `@path` 读取：preload 暴露的既有通道（不新增 IPC 通道名） */
function browserReadRef(
  path: string,
  cwd: string,
): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }> {
  return window.harness2.readFileForRef(path, cwd);
}

/**
 * composer 的外部 IO 组合（D-34～D-37）。`pendingSubmissions()` 是**提交顺序台账**：
 * 每次投递按进入顺序追加（D-34 保序），供诊断与装配级断言；权威在途/acks 仍在 store
 * （`pendingSubmits` / `submitAcks`，ack 或超时后收敛）。
 */
export interface ConversationComposerPort {
  readonly io: ComposerIO;
  pendingSubmissions(): readonly string[];
}

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
  const readRef = deps.readRef ?? browserReadRef;

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
    // P1-1：`@path` 引用解析（复用 shared/file-ref 的既有实现 + 既有 readFileForRef 通道）。
    // 无 `@` / cwd 未知 → 原样返回（零 IPC，不发多余请求）。
    const resolved = await resolveFileRefs(wireDraft, cwd, readRef);
    // 引用来源可见（D1）：进了上下文的 / 被拒的 / 未找到的，全部记账后由 ChatTranscript 展示
    deps.store.setRefReport(sessionId, {
      sources: resolved.sources,
      skipped: resolved.skipped,
      notFound: resolved.notFound,
    });
    // 解析到的文件同时作为结构化引用上报（kind:'file' + 原 token 作 path；不伪造其它 kind）
    const fileRefReferences: MessageReferenceShape[] = resolved.sources.map((source) => ({
      id: `file-ref:${source.token}`,
      kind: 'file',
      path: source.token,
    }));
    // D-35 的 intent 语义由 core 判定，桌面只投递意图；references = chip 引用 + 已就绪附件引用 + @引用
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
    transport: deps.transport ?? desktopUploadTransport,
    maxConcurrentFileUploads: deps.maxConcurrentFileUploads ?? DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  };
  return { io, pendingSubmissions: () => submissionOrder(ledger) };
}

export interface ConversationSeatProps {
  readonly store: AppStore;
  readonly controller: Controller;
  readonly registry?: ConversationViewRegistry<ConversationSession>;
  readonly persistence?: ViewSelectionPersistence;
  readonly imageUrls?: ImageUrlCache;
  readonly chain?: ComposerChain;
  /** 繁忙态 Enter 偏好（缺省 = 默认 queue；桌面暂无配置通道，缺口见文件头 §6） */
  readonly busyEnter?: BusyEnterBehavior;
  readonly maxConcurrentFileUploads?: number;
  readonly createClientMessageId?: () => string;
  readonly transport?: UploadTransport;
  /** 图片读取缝（图片附件走 FileReader data URL；测试注入假实现） */
  readonly imageIO?: ImageReadIO;
  /** `@path` 读取通道（缺省 = window.harness2.readFileForRef；测试注入假实现） */
  readonly readRef?: FileRefReader;
  /** 预组装的 composer port（测试/诊断用；缺省内部按 deps 组装） */
  readonly port?: ConversationComposerPort;
}

/**
 * 会话席位内容（ui-conversation）：会话头 + 视图环 + **常驻 composer**。
 * D-33：composer 不因「无会话」卸载 —— 无会话时仍然挂载但 inert（由 Composer 内部落实）。
 */
export function ConversationSeat(props: ConversationSeatProps): ReactNode {
  const { store, controller } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const sessionId = state.selectedId;
  const registry = props.registry ?? conversationViewRegistry;
  const persistence = props.persistence ?? conversationViewPersistence;
  const imageUrls = props.imageUrls ?? conversationImageUrls;
  const chain = props.chain ?? conversationComposerChain;

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

  // 草稿落盘（D1）：内存即时生效，落盘走 controller 的 500ms 去抖合并 —— 不直连桥，不另开通道。
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

  return (
    <div className="conversation-seat" data-testid="conversation-seat">
      {sessionId !== null && session !== undefined ? (
        <>
          <ConversationHeader sessionId={sessionId} cwd={state.sessions.find((s) => s.id === sessionId)?.cwd} />
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
      <Composer
        sessionId={sessionId ?? undefined}
        session={composerSession}
        running={running}
        // D-35 繁忙态 Enter：桌面暂无配置通道 → 默认 queue（缺口登记，不伪造配置读取）
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
  );
}
