// seat.tsx — 会话席位（ui-conversation 的**宿主无关**装配）：常驻 composer + 提交边界。
//
// 本文件是共享包里的唯一「会话页装配点」：数据源（store/controller）、图片缓存、composer 链
// **全部由壳注入**（不抓全局单例，注入式才可测）。各壳自己的组装根
// （desktop `conversation/assembly.tsx`、web `src/app.tsx`）负责决定注入什么。
//
// Z2-05（Z-16）：**主区事实单一 chat** —— ZCode 的主区没有视图环/标签条（切 automations /
// plugin-store 靠左栏按钮，且不渲染 WorkspaceHeader），对话主区只渲染转录。本组件不再装配
// ConversationViewRing / 视图注册表 / 视图选择持久缝（那一层已随 Z2-05 退役）；trajectory
// 改为右栏 tab（Z-14 `model-trajectory:{sessionId}`），由壳的右栏宿主渲染。
//
// 语义归属（与桌面 P5-C/P6 同一份实现的存留部分）：
//   1. 会话绑定（D-32）：同一会话内 session 对象引用稳定（换会话才换引用、重建草稿 store）。
//   2. 图片 URL 缓存（D-39）：缓存由壳注入并交给**需要它的视图**（轨迹 tab）；本席位自身
//      不消费图片 URL（转录不嵌图）。未注入读取器时恒 null（如实占位，绝不伪造 URL）。
//   3. composer 真实 IO（D-34/D-35/D-36/D-37）：submit 走 controller.submitMessage（finalText 前
//      trim 载荷）、stop 走 controller.cancelTurn、running 取 store 真实运行态、附件走
//      `FileUploadQueue`（并发上限默认 2）。
//   4. 提交边界：`@path` → 内容与 references 在此解析（`shared/file-ref.ts` + 注入的读取通道）；
//      ack 落定后 rejected → 上抛（Composer 还原草稿 + 附件并显示原因），unknown → 交给可见队列
//      如实标注（不假报成功、不诱导重发）。
//   5. D-46 壳的义务（chat 侧）：composer 以浮层置于全高转录之上，实测高度写 CSS 变量
//      `--composer-inset`（`.messages` 滚动叶容器消费）；未测量（0）时不写变量 = 不虚构预留。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { newClientMessageId } from '../../shared/ids.js';
import { resolveFileRefs, type FileRefReader } from '../../shared/file-ref.js';
import type { MessageReferenceShape, SubmitAckStateShape } from '../../shared/protocol.js';
import { lastTurnIdOf, type Controller } from '../app-controller.js';
import { ChatTranscript } from '../components/ChatView.js';
import { ConversationSuggestionChips } from './EmptyState.js';
import { ApprovalDock, toApprovalCardModel } from '../approval/index.js';
import { composeQueueView } from '../features/composer/composer-model.js';
import { ChatErrorBanner } from './ChatErrorBanner.js';
import {
  latestSubmitAckError,
  mergeErrorDetail,
  withDismissedFingerprint,
  type SubmitFailureInfo,
} from './chat-error-model.js';
import { QueuePanel } from './QueuePanel.js';
import { ResumeBar } from './ResumeBar.js';
import { ambientHostBridge } from '../host-bridge.js';
import type { AppStore } from '../store.js';
import {
  attachmentReference,
  DEFAULT_MAX_CONCURRENT_FILE_UPLOADS,
  type ComposerAttachment,
  type ImageReadIO,
  type UploadTransport,
} from './composer/attachments.js';
import {
  Composer,
  type ComposerContextChipsProps,
  type ComposerIO,
  type ComposerModeSwitchProps,
  type ComposerModelSelectProps,
  type ComposerThoughtLevelProps,
} from './composer/Composer.js';
import type { ComposerContextPickerOptions } from './composer/composer-context-menu.js';
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
import { composerPrefill, prefillAppendText } from './composer/prefill.js';
import { DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior } from './composer/submit-policy.js';
import { createImageUrlCache, type ImageUrlCache, type ConversationImageReader } from './views/image-url-cache.js';
import {
  COMPOSER_INSET_VAR,
  createComposerOverlayHost,
  useComposerOverlayInset,
  type ComposerOverlayHost,
} from '../trajectory/shell-contract.js';

/**
 * 会话对象（D-32 身份稳定）：转录与需要会话数据的面板（右栏轨迹 tab）都以它为数据源。
 * 数据源（store/controller）随会话对象一起传出去 —— 消费方不抓全局单例，注入 store 测试才成立。
 */
export interface ConversationSession {
  readonly id: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly store: AppStore;
  readonly controller: Controller;
}

/**
 * 共享缺省：没有图片授权读取通道 → read 恒 null（视图显示占位，绝不伪造 URL） */
export const noImageRead: ConversationImageReader = () => null;
/** 共享缺省图片 URL 缓存（会话内逐附件去重；壳可注入自己的实例） */
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
  /**
   * 该席位绑定的会话 id（Z2-06 分屏：每格渲染一个席位，绑定各自会话）。
   * 缺省（不传）= 跟随 `store.selectedId`（与旧行为完全一致）；显式传 `null` = 无会话空态。
   * 传入具体 id 时：composer 的提交/停止/草稿都作用于该会话（不再跟随全局选中），
   * 使非主分屏格也可独立交互。
   */
  readonly sessionId?: string | null;
  readonly chain?: ComposerChain;
  /** 会话头（壳注入：不同壳的头部信息面不同；缺省不渲染头部） */
  readonly header?: (info: { readonly sessionId: string; readonly cwd?: string }) => ReactNode;
  /**
   * 会话状态面板（Z-17 的 `ConversationStatusPanel`：会话列右上有内容才出现）。
   * 壳注入（与 header 同一注入口径）；返回 null = 无内容不渲染。缺省不渲染。
   * 面板自身的容器查询断点（Z-95：<1280 mini 胶囊 / ≥1280 面板）以本槽位包裹行为容器。
   */
  readonly statusPanel?: (info: { readonly sessionId: string }) => ReactNode;
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
  /**
   * Z3-04（Z-94）左簇模式切换数据面（壳注入）。undefined = 该壳无数据通道（如 web 壳），
   * 控件整体不渲染 —— 绝不渲染假状态。
   */
  readonly modeSwitch?: ComposerModeSwitchProps;
  /** Z3-04（Z-94）右簇模型选择数据面（壳注入；undefined 同上） */
  readonly modelSelect?: ComposerModelSelectProps;
  /** Z10-2b 右簇思考档位数据面（壳注入；undefined = 无通道/模型未声明档位 → 控件不渲染） */
  readonly thoughtLevel?: ComposerThoughtLevelProps;
  /**
   * Z10-2 composer 上方「项目」「Git 分支」上下文 chip 数据面（壳注入；undefined = 整行不渲染）。
   * 缺省不渲染；无切换通道的壳把 chip 渲染为只读（disabled + title，见 composer/context-chips.tsx）。
   */
  readonly contextChips?: ComposerContextChipsProps;
  /**
   * P0「添加上下文」选择器数据面（壳注入）。缺省（web）= 无目录通道 → 面板**仍渲染**并如实
   * 显示「web 无目录通道」（与左右簇控件「undefined = 不渲染」不同：本按钮是 ZCode 常驻项）。
   */
  readonly contextPicker?: ComposerContextPickerOptions;
  /**
   * Z10-1：空态建议 chip 的点击处理（壳注入）。
   * 壳经既有 composer 编辑原语（如 `composerPrefill` 通道）把文案**预填进本席位会话的活草稿**
   * ——非直接发送。缺省（未注入）= 内部直接写入本席位 `composerStore`（分屏各格各自正确）。
   */
  readonly onPickSuggestion?: (text: string) => void;
}

/**
 * 会话席位内容（ui-conversation）：会话头（可选）+ 转录（主区唯一视图，Z-16）+ **常驻 composer**。
 * D-33：composer 不因「无会话」卸载 —— 无会话时仍然挂载但 inert（由 Composer 内部落实）。
 */
export function ConversationSeat(props: ConversationSeatProps): ReactNode {
  const { store, controller } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // Z2-06：显式 sessionId（分屏每格绑定各自会话）优先；缺省跟随全局选中（旧行为不变）
  const selectedId = state.selectedId;
  const sessionId = props.sessionId !== undefined ? props.sessionId : selectedId;
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

  // D-32：同一会话内会话对象引用稳定；换会话才换引用（草稿 store 与订阅随之换绑）
  const session = useMemo<ConversationSession | undefined>(
    () => (sessionId === null ? undefined : { id: sessionId, subscribe: store.subscribe, store, controller }),
    [sessionId, store, controller],
  );

  // Z2-06：停止的目标 = **本席位绑定的会话**（分屏非主格也能正确停止自己的 turn）。
  // 缺省（sessionId === selectedId，含未分屏与主格）原样复用 port.io，行为与旧实现完全一致；
  // 仅在显式绑定到「非当前选中」会话时覆盖 stop（提交本就按 submission.sessionId 投递，无需改）。
  const io = useMemo<ComposerIO>(
    () =>
      sessionId === null || sessionId === selectedId
        ? port.io
        : {
            ...port.io,
            stop: () => {
              void controller.cancelTurn(sessionId);
            },
          },
    [port.io, sessionId, selectedId, controller],
  );

  // —— Z-96 发送失败可见化：composer 上方常驻错误横幅（主形态非 toast）——
  // 数据源 = 本席位会话的 submitAcks（controller 失败/超时/serve 拒绝都经 applyFrame 落这里）。
  // `lastFailure`：composer onSubmitError 回传的底层 error（含 stack），并入横幅 detail；
  // `dismissed`：X 关掉的指纹集合（同错误不立刻顶回，Z-96 去重语义）。切换会话双双归零。
  const [lastFailure, setLastFailure] = useState<SubmitFailureInfo | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setLastFailure(null);
    setDismissed(new Set());
  }, [sessionId]);
  // 给 io 接上 onSubmitError（此前全仓零调用点）：记录底层 error 供详情/复制。
  // 同时包装 submit：每次**新**提交尝试重新布防（清 dismissed/lastFailure）——关掉横幅后
  // 同一次错误不再顶回（Z-96 去重），但用户主动重试后若再失败，错误应重新可见。
  const ioWithErrors = useMemo<ComposerIO>(() => {
    const base: ComposerIO = {
      ...io,
      onSubmitError: (submission, error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        setLastFailure({ message, ...(stack !== undefined ? { stack } : {}) });
        io.onSubmitError?.(submission, error);
      },
    };
    const inner = io.submit;
    return {
      ...base,
      submit: (submission) => {
        setDismissed(new Set());
        setLastFailure(null);
        return inner(submission);
      },
    };
  }, [io]);

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

  // composer 编辑器外部引用（Z4-02/Z4-03：预填后按请求把焦点交回编辑器）
  const composerEditorRef = useRef<HTMLDivElement | null>(null);

  // Z4-02/Z4-03：外部引用预填（右栏文件 tab「评论」/ 转录划词「询问」）。
  // 与建议 chip 同通道：`insert-text` 进本席位会话的**活草稿 store**（随后由上面的既有订阅
  // 经 controller.setDraft 落盘）—— 不是只写持久层（那条路活 composer 不可见）。
  // 追加而非覆盖：光标先移到草稿末尾，非空草稿补空行分隔（prefillAppendText）。
  // 消费去重：同一会话可能有多个席位（Z2-06 分屏），nonce 首个消费者当事，其余跳过。
  useEffect(() => {
    return composerPrefill.subscribe((req) => {
      if (sessionId === null || req.sessionId !== sessionId) return;
      if (!composerPrefill.consume(req.nonce)) return;
      const before = composerStore.getState();
      const append = prefillAppendText(draftText(before), req.quote);
      if (append.length === 0) return;
      composerStore.dispatch({ type: 'set-caret', caret: { node: before.atoms.length, offset: 0 } });
      composerStore.dispatch({ type: 'insert-text', text: append });
      if (req.focus) composerEditorRef.current?.focus();
    });
  }, [composerStore, sessionId]);

  const cwd = sessionId === null ? undefined : state.sessions.find((s) => s.id === sessionId)?.cwd;
  const stream = sessionId === null ? undefined : store.peekStream(sessionId);
  const running = stream?.running === true;
  // Z-96：横幅候选。**刻意不用 useMemo**：store 对 SessionStream 就地变更（submitAcks 是
  // 原地重建的内层对象，stream 引用恒定），memo 依赖 [stream] 永不变化 → 会拿着旧 ack 不放
  // （重发成功后旧横幅不消失）。纯计算成本可忽略，逐帧现算即是正确语义（组件因 useSyncExternalStore
  // 已随任何 store 变更重渲）。
  const ackError = latestSubmitAckError(stream?.submitAcks ?? {});
  const bannerCandidate = ackError === null ? null : mergeErrorDetail(ackError, lastFailure);
  const banner = bannerCandidate !== null && !dismissed.has(bannerCandidate.fingerprint) ? bannerCandidate : null;
  // P1-2：steer 的 expectedTurnId 用**控制层同一推导**（`lastTurnIdOf`，与取消目标定位同一函数）。
  // `stream.activeAttempt?.turnId` 只在 resume-snapshot 到达时才有值（事件/重放路径只置 running），
  // 只读它会让 steer 恒缺 expectedTurnId → core 直接 rejected（sessions-tasks.ts:95-104）。
  const activeTurnId = stream === undefined ? undefined : (stream.activeAttempt?.turnId ?? lastTurnIdOf(stream));
  const composerSession =
    sessionId === null
      ? undefined
      : { id: sessionId, running, ...(activeTurnId !== undefined ? { activeTurnId } : {}) };

  // 草稿态判据（**唯一真相**，Z10-1 建议 chip 与草稿态卡片化/在流内布局共用同一表达式）：
  // 会话已加载、非运行中、且本会话尚无任何条目（= 新任务态）。
  const isDraft = sessionId !== null && stream?.loaded === true && !running && store.chatItems(sessionId).length === 0;
  // 队列 dock 的内容（渲染与判据共用同一份模型，不重复计算；空 = 不渲染）。
  const queueView =
    stream === undefined
      ? []
      : composeQueueView({
          queue: stream.queue,
          pendingSubmits: stream.pendingSubmits,
          submitAcks: stream.submitAcks,
        });
  const hasApprovals = stream !== undefined && stream.approvals.length > 0;
  // 草稿态**在流内**布局（ZCode ConversationTimeline.tsx:1759-1776 responsiveCenteredEmptyLayout）：
  // 仅当队列与审批 dock **都为空**时才切换 —— 有条目时两个 dock 必须仍可见且不破版，
  // 此时回落贴底浮层（会话态同一形态）。视觉规则见 shell.css 的 `[data-draft-inflow]`。
  const isDraftInFlow = isDraft && queueView.length === 0 && !hasApprovals;

  // D-46（chat 侧）：composer 以浮层置于全高转录之上，并预留**实测**高度。
  // 测量源 = ResizeObserver（环境无 RO 时静默不测 → 预留 0，绝不虚构），
  // 出口 = CSS 变量 `--composer-inset`（`.messages` 滚动叶容器消费）。
  const composerOverlayHost = props.composerOverlayHost ?? sharedComposerOverlay;
  const composerInsetPx = useComposerOverlayInset(composerOverlayHost);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    composerOverlayHost.observe(composerRef.current);
    return () => composerOverlayHost.observe(null);
  }, [composerOverlayHost]);
  const seatStyle: CSSProperties | undefined =
    composerInsetPx === undefined ? undefined : ({ [COMPOSER_INSET_VAR]: `${composerInsetPx}px` } as CSSProperties);

  return (
    <div
      className="conversation-seat"
      data-testid="conversation-seat"
      style={seatStyle}
      // 草稿态判据（唯一真相，见上方 isDraft）；undefined = 非草稿态不写属性。
      data-draft={isDraft ? 'true' : undefined}
      // 草稿态且队列/审批 dock 均为空 → 才切「在流内」布局（CSS 依据）。
      data-draft-inflow={isDraftInFlow ? 'true' : undefined}
    >
      {/* Z2-09b（Z-17）：恢复条 —— 重订阅快照实际携带在途状态时才出现（对话页顶部细横条），
          手动可关 + 8s 自动消失；inflight 由 store 从 ResumeSnapshotShape 真实字段计得。 */}
      {stream?.resume !== undefined && <ResumeBar resumeAt={stream.resume.at} inflight={stream.resume.inflight} />}
      {sessionId !== null && session !== undefined ? (
        <>
          {props.header?.({ sessionId, ...(cwd !== undefined ? { cwd } : {}) })}
          {/* Z-17：状态面板挂在会话列内（头部之下、转录之上），右对齐；
              包裹行带 `@container` 供面板的容器查询断点（<1280 mini 胶囊 / ≥1280 面板）。
              有内容（statusPanel 返回非 null）才渲染包裹行 —— 空面板不留任何占位高度；
              `empty:hidden` 兜底回调返回「渲染为空」的元素时也不占位（双保险）。 */}
          {(() => {
            const statusPanel = props.statusPanel?.({ sessionId });
            return statusPanel === null || statusPanel === undefined ? null : (
              <div
                data-testid="status-panel-slot"
                className="@container empty:hidden flex flex-none justify-end px-3 pt-2"
              >
                {statusPanel}
              </div>
            );
          })()}
          {/* Z-16：主区事实单一 chat —— 转录直接渲染，无视图环/标签条 */}
          <ChatTranscript streamId={sessionId} store={session.store} controller={session.controller} />
        </>
      ) : (
        /* U2-A6 空态兜底升级（无会话 = 冷启动无历史 / 列表清空后回落）：原先只有一行 `<p>`，
           现在给「居中容器 + 品牌水印 + 主次文案层级 + 新建会话动作」。动作复用壳注入的
           `controller.newSession()`（= App 三处新建入口同一唯一入口，见 desktop app-shared 注释）；
           席位拿不到帧 dispatch（右栏收起属壳侧），且新会话 tab 桶本就为空，语义等价。
           容器样式全部 Tailwind 工具类（空态非对话域，无 shell.css 依赖）。 */
        <div className="chat empty-pane">
          <div className="flex flex-col items-center gap-6 px-4 text-center" data-testid="conversation-no-session">
            {/* 水印鱼形 mark（与 EmptyState/顶栏品牌行同轮廓，纯装饰） */}
            <span className="text-foreground-subtlest" aria-hidden="true">
              <svg width={72} height={72} viewBox="0 0 24 24" fill="none" focusable="false">
                <path
                  d="M3 12c3.2-4.2 7.2-6.3 12-6.3 2.6 0 4.9.7 6 1.9-1.5.9-2.4 2.2-2.7 4.4-.3 2.2.4 3.9 2.7 4.6-1.1 1.2-3.4 1.9-6 1.9-4.8 0-8.8-2.1-12-6.5Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <div className="flex flex-col gap-1.5">
              <p className="text-ui-base text-foreground">选择左侧会话开始对话（Ctrl+K 打开命令面板）</p>
              <p className="text-ui-xs text-foreground-subtlest">没有现成会话？直接新建一个开始新任务。</p>
            </div>
            <button
              type="button"
              data-testid="conversation-no-session-new"
              className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-ui-base text-primary-foreground transition-opacity hover:opacity-90"
              onClick={() => void controller.newSession()}
            >
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
                <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
              </svg>
              新建会话
            </button>
          </div>
        </div>
      )}
      <div
        className="composer-overlay"
        ref={composerRef}
        data-testid="composer-overlay"
        // 草稿态透出给 composer 链路（卡片化视觉用 data-draft；在流内布局用 data-draft-inflow）。
        data-draft={isDraft ? 'true' : undefined}
        data-draft-inflow={isDraftInFlow ? 'true' : undefined}
      >
        {/* Z2-09b（Z-17）：队列面板 = composer 之上的按需 dock（有队列/在途提交才出现）。
            只读展示（协议无撤回 op，登记于交付报告）；ZCode 无条目像素依据，按 dock 族视觉。 */}
        {stream !== undefined && <QueuePanel entries={queueView} />}
        {/* Z-20：待审批 = 会话底部 dock，常驻在 composer **之上**（在转录滚动区之外）。
            数据源 = 本席位绑定会话的待批列表；决定仍只回传 allow/deny（语义归 core）。 */}
        {stream !== undefined && stream.approvals.length > 0 && (
          <ApprovalDock
            approvals={stream.approvals.map(toApprovalCardModel)}
            respondingOf={(requestId) => store.isApprovalResponding(requestId)}
            failureOf={(requestId) => store.approvalFailure(requestId)}
            onDecision={(requestId, decision) => void controller.respondApproval(requestId, decision)}
          />
        )}
        {/* Z-96：发送失败错误横幅 = composer 上方独立 surface（图标+单行截断+详情+复制+X）。
            数据源 submitAcks（unknown/rejected），X 按指纹去重；重发成功（最新 ack=accepted）自动消失。 */}
        {banner !== null && (
          <ChatErrorBanner
            message={banner.message}
            {...(banner.detail !== undefined ? { detail: banner.detail } : {})}
            fingerprint={banner.fingerprint}
            onDismiss={() => setDismissed((current) => withDismissedFingerprint(current, banner.fingerprint))}
          />
        )}
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
          io={ioWithErrors}
          editorRef={composerEditorRef}
          // Z3-04（Z-94）：左右簇控件（壳注入；缺省不渲染，web 壳无数据通道时如实缺省）
          {...(props.modeSwitch !== undefined ? { modeSwitch: props.modeSwitch } : {})}
          {...(props.modelSelect !== undefined ? { modelSelect: props.modelSelect } : {})}
          {...(props.thoughtLevel !== undefined ? { thoughtLevel: props.thoughtLevel } : {})}
          {...(props.contextChips !== undefined ? { contextChips: props.contextChips } : {})}
          {...(props.contextPicker !== undefined ? { contextPicker: props.contextPicker } : {})}
          {...(props.imageIO !== undefined ? { imageIO: props.imageIO } : {})}
        />
        {/* Z10-1（承 Z-18/Z-17）：草稿态（会话已加载且无任何条目、非运行中）→ composer 下方
            4 建议 chip（实测文案「周报总结/报错修复/PPT 制作/闲时任务」）。
            动作是真实的：点击 = 把该文案**预填**进 composer（insert-text，光标处追加，不覆盖已有
            草稿），由用户 Enter 经既有提交边界送出 —— 非直接发送，不摆点击无效的假 chip。
            壳可注入 `onPickSuggestion` 接管（如经 composerPrefill 通道）；缺省写本席位活草稿。 */}
        {isDraft && (
          <ConversationSuggestionChips
            onPickSuggestion={
              props.onPickSuggestion ?? ((text) => composerStore.dispatch({ type: 'insert-text', text }))
            }
          />
        )}
      </div>
    </div>
  );
}
