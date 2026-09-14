// Composer.tsx — 桌面对话页常驻 composer（D-33～D-38 的组合层；装配留给接线棒）。
//
// 组合内容：
//   D-33 常驻挂载：组件自身不因「无会话」卸载——无会话时编辑器保持挂载但 inert（contentEditable
//        关闭、主按钮禁用）；引用 chip 以 `contentEditable={false}` 的行内原子节点渲染；斜杠命令
//        保持行首文本样式（不做语法高亮，形似即可）。
//   D-34 乐观提交：Enter → `store.dispatch({type:'submit'})` 同一事务清草稿 + occurrence + 撤销
//        历史；提交载荷冻结为 detached attempt 交 IO 发送；失败时按原顺序恢复草稿与附件。
//   D-35 Enter 投递：空闲 transcript / 繁忙 Queue（queue-dock）/ 繁忙 Steer（pending-steering）。
//   D-36 主按钮：单一主指针位置，在 Stop 与 Send 之间切换；标签跟随策略纯函数。
//   D-37 附件：图片（image/*）走 FileReader data URL；文件走 FIFO 上传队列（并发缺省 2）。
//   D-38 链：`ComposerChain` takeover 选举；takeover 生效时**默认 composer 保持挂载**（hidden）。
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  browserImageReadIO,
  FileUploadQueue,
  IMAGE_TRANSPORT_MISSING,
  readImageAsDataUrl,
  restoreAttachments,
  type ComposerAttachment,
  type ImageReadIO,
  type UploadTransport,
} from './attachments.js';
import {
  clearFailedDrafts,
  ComposerStore,
  createFailedDraftLedger,
  draftText,
  hasChip,
  isDraftEmpty,
  isSlashCommand,
  markRestoreRev,
  settleFailedSubmission,
  type FailedDraftLedger,
  type PendingSubmission,
  type SubmissionPlacement,
} from './composer-state.js';
import {
  renderComposerTakeover,
  type ComposerChain,
  type ComposerChainProps,
  type ComposerSessionSnapshot,
  type PendingInteraction,
} from './composer-chain.js';
import {
  canSubmit,
  placementNotice,
  resolveEnterPolicy,
  resolveMainButton,
  type BusyEnterBehavior,
  type ComposerSubmitGesture,
  type SubmitPolicyInput,
} from './submit-policy.js';
import { isImeComposing } from '../../features/composer/composer-model.js';
import type { SubmitIntentShape } from '../../../shared/protocol.js';

/** 选中文件的注入形状（真机 = File；测试 = 同形字面量） */
export interface SelectedFileLike {
  readonly name: string;
  readonly type?: string;
  readonly size: number;
}

/** composer 的外部 IO 缝（接线棒注入真实实现；测试注入假实现） */
export interface ComposerIO {
  readonly createClientMessageId: () => string;
  /** 发送 detached attempt（channel 失败应 reject → 组件恢复草稿，不自动重发） */
  readonly submit: (submission: PendingSubmission) => Promise<unknown> | unknown;
  readonly stop?: () => void;
  /** 文件上传通道（缺省 = 无通道：文件附件标失败并说明，不静默丢弃） */
  readonly transport?: UploadTransport;
  readonly maxConcurrentFileUploads?: number;
  readonly now?: () => number;
  /** 提交失败上报（不自动重发；默认无声，由装配层接通知） */
  readonly onSubmitError?: (submission: PendingSubmission, error: unknown) => void;
}

export interface ComposerProps {
  /** 当前会话；undefined = 无会话（常驻挂载但 inert） */
  readonly sessionId: string | undefined;
  readonly session?: ComposerSessionSnapshot;
  /**
   * 等待用户的业务交互（owner currency 的 `pendingInteraction` 位）。
   * **登记（P2-2）**：桌面侧当前**没有**数据来源 —— store 的 `approvals` 已在转录里
   * 由审批条渲染（`ChatView`），未映射进本字段；因此装配层不传（恒 undefined）。
   * 待审批中心（P6/P7）需要 takeover 时，在此接上真实来源，不要假传。
   */
  readonly pendingInteraction?: PendingInteraction;
  readonly running?: boolean;
  /** 繁忙态 Enter 偏好（D-35 设置二选） */
  readonly busyEnter?: BusyEnterBehavior;
  /**
   * 本会话传输层是否支持 steer。
   * **登记（P2-3）**：桌面侧**无法**由 store/会话模式推导 —— `SessionMeta` 没有
   * 「可继续子代理 / one-shot 子代理」字段（上游据此禁用 steer 与附件入口），
   * 因此装配层不传，缺省 `true`（普通会话的 steer 语义由 core 判定；
   * 无 expectedTurnId 的 steer 会被 core 直接 rejected，见 P1-2 的还原与展示）。
   */
  readonly steeringAvailable?: boolean;
  readonly locked?: boolean;
  readonly stopAvailable?: boolean;
  readonly io: ComposerIO;
  /** 注入 store（测试/装配层持久草稿用）；缺省内部自建 */
  readonly store?: ComposerStore;
  readonly chain?: ComposerChain;
  /** 图片读取缝（缺省 = 浏览器 FileReader） */
  readonly imageIO?: ImageReadIO;
  readonly placeholder?: string;
}

/** 内建会话草稿的默认提示（无会话时提示选择会话） */
const PLACEHOLDER_WITH_SESSION = '输入消息（Enter 发送，Shift+Enter 换行，Ctrl/⌘+Enter 用另一投递模式）';
const PLACEHOLDER_NO_SESSION = '选择会话后开始输入';

/** 提交结果提示（P1-2 展示面 / P2-1 `placement` 的真实落点） */
type SubmitStatus = { readonly kind: 'placement' | 'error'; readonly text: string };

/** 空 subscribe / 空版本快照（无链注入时的稳定引用，避免每次渲染换新函数） */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const NO_CHAIN_VERSION = (): number => 0;

export function Composer(props: ComposerProps): ReactNode {
  const fallbackStore = useMemo(() => new ComposerStore(), []);
  const store = props.store ?? fallbackStore;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // P2-2：订阅 `conversation.composer` 链 —— 新注册/卸载的 takeover 立即生效。
  // 此前只在渲染期 `chain.select(...)`，不订阅链变化 → 运行中注册的接管要等下次无关渲染才出现。
  useSyncExternalStore(
    props.chain === undefined ? NOOP_SUBSCRIBE : props.chain.subscribe,
    props.chain === undefined ? NO_CHAIN_VERSION : props.chain.getVersion,
  );

  const imageIO = props.imageIO ?? browserImageReadIO;
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  /** 提交序号（失败台账按它排「提交顺序」，与并发落定顺序无关） */
  const submitSeqRef = useRef(0);
  /** 失败台账（P0-2；上游 `failedDetached`）：不进渲染，只在提交边界与失败落定时读写 */
  const failedLedgerRef = useRef<FailedDraftLedger>(createFailedDraftLedger());
  const uploadsRef = useRef<{ transport: UploadTransport; queue: FileUploadQueue } | null>(null);

  const upsertAttachment = useCallback((next: ComposerAttachment): void => {
    setAttachments((list) => {
      const index = list.findIndex((a) => a.id === next.id);
      if (index < 0) return [...list, next];
      const copy = [...list];
      copy[index] = next;
      return copy;
    });
  }, []);

  const nextAttachmentId = (): string => {
    idRef.current += 1;
    return `att-${props.sessionId ?? 'draft'}-${idRef.current}`;
  };

  /** 取/建文件上传队列（transport 身份变化时重建；并发上限可配，缺省 2） */
  const uploadsFor = (transport: UploadTransport | undefined): FileUploadQueue | null => {
    if (transport === undefined) return null;
    if (uploadsRef.current === null || uploadsRef.current.transport !== transport) {
      const maxConcurrent = props.io.maxConcurrentFileUploads;
      uploadsRef.current = {
        transport,
        queue: new FileUploadQueue({
          transport,
          ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
          onUpdate: upsertAttachment,
        }),
      };
    }
    return uploadsRef.current.queue;
  };

  const attachFiles = async (files: readonly SelectedFileLike[]): Promise<void> => {
    const queue = uploadsFor(props.io.transport);
    for (const file of files) {
      const id = nextAttachmentId();
      const mimeType = file.type !== undefined && file.type.length > 0 ? file.type : 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        const placeholder: ComposerAttachment = {
          id,
          kind: 'image',
          name: file.name,
          mimeType,
          bytes: file.size,
          state: 'queued',
        };
        upsertAttachment(placeholder);
        try {
          const read = await readImageAsDataUrl(file, { name: file.name, mimeType }, imageIO);
          // P1-3 诚实降级：data URL 读取是真的（本地缩略图），但**提交协议没有图片字节通道**
          // （SubmitMessagePayloadShape 只有 references；MessageReferenceShape 也无图片语义）→
          // 图片如实标 failed 且**不进 references**（旧实现伪造成 kind:'clipboard'+文件名 = 骗用户）。
          upsertAttachment({
            ...placeholder,
            state: 'failed',
            dataUrl: read.dataUrl,
            mimeType: read.mimeType,
            error: IMAGE_TRANSPORT_MISSING,
          });
        } catch (e) {
          upsertAttachment({ ...placeholder, state: 'failed', error: e instanceof Error ? e.message : String(e) });
        }
        continue;
      }
      if (queue === null) {
        upsertAttachment({
          id,
          kind: 'file',
          name: file.name,
          mimeType,
          bytes: file.size,
          state: 'failed',
          error: '未配置文件上传通道',
        });
        continue;
      }
      // 逐条入队：保持「选择顺序 = 附件顺序」（D-34 的保序落实到选文件那一刻）
      queue.enqueue([{ id, name: file.name, mimeType, bytes: file.size, file }]);
    }
  };

  const locked = props.locked === true || props.sessionId === undefined;
  const running = props.running === true;
  const busyEnter = props.busyEnter ?? 'queue';
  const steeringAvailable = props.steeringAvailable ?? true;
  const stopAvailable = props.stopAvailable ?? true;
  const uploadsPending = attachments.some((a) => a.state === 'queued' || a.state === 'uploading');

  const policyInput: SubmitPolicyInput = {
    running,
    busyEnter,
    steeringAvailable,
    submittable: !isDraftEmpty(state) || attachments.length > 0,
    slashCommand: isSlashCommand(state),
    uploadsPending,
    locked,
    stopAvailable,
  };
  const main = resolveMainButton(policyInput);

  const submitWith = (intent: SubmitIntentShape, placement: SubmissionPlacement): void => {
    if (!canSubmit(policyInput)) return;
    // 提交边界（上游 facade.ts:731-734）：上一批失败还原后用户没再编辑 → 清空失败台账，
    // 否则这次重提的内容会在下次失败时被重复合并（同一文本出现两遍）。
    // 判据用**提交前**的 revision：`submit` 动作本身会 +1（清草稿同事务）。
    const ledgerAfterBoundary = clearFailedDrafts(failedLedgerRef.current, store.getState());
    const clientMessageId = props.io.createClientMessageId();
    const reduction = store.dispatch({
      type: 'submit',
      commit: {
        sessionId: props.sessionId ?? '',
        intent,
        placement,
        clientMessageId,
        ...(props.session?.activeTurnId !== undefined ? { expectedTurnId: props.session.activeTurnId } : {}),
        attachments: [...attachments],
        ...(props.io.now !== undefined ? { now: props.io.now() } : {}),
      },
    });
    const submission = reduction.submission;
    if (submission === undefined) return;
    failedLedgerRef.current = ledgerAfterBoundary;
    // 草稿与附件同批清空（浏览器一次 act/渲染批次内落定；提交历史已由 store 同步清空）
    setAttachments([]);
    // P2-1：`placement` 的真实落点 = 主指针旁的状态行（不再是「看起来有用其实没用」的字段）
    setSubmitStatus({ kind: 'placement', text: placementNotice(submission.placement) });
    submitSeqRef.current += 1;
    const seq = submitSeqRef.current;
    Promise.resolve(props.io.submit(submission)).then(
      () => undefined,
      (error: unknown) => {
        // 失败还原（P0-2；上游 facade.ts:793-868）：
        //   - 只在「用户尚未编辑还原内容」时覆盖草稿（草稿为空 或 自上次自动还原以来未编辑）；
        //   - 多个并发失败按**提交顺序**用 '\n\n' 合并，绝不互相覆盖；
        //   - 附件总是按提交顺序去重还给用户（且不覆盖用户期间新加的附件）。
        const message = error instanceof Error ? error.message : String(error);
        const outcome = settleFailedSubmission(store.getState(), failedLedgerRef.current, {
          seq,
          // 台账存**未 trim** 的草稿原文（trim 只作用于发出去的载荷）
          rawText: submission.rawText,
          attachments: [...submission.attachments],
        });
        failedLedgerRef.current = outcome.ledger;
        if (outcome.restored && outcome.restoreText !== undefined) {
          store.dispatch({ type: 'restore-draft', rawText: outcome.restoreText });
          failedLedgerRef.current = markRestoreRev(failedLedgerRef.current, store.getState().revision);
        }
        setAttachments((current) => [...restoreAttachments(outcome.attachments, current)]);
        // 不静默：失败原因 + 是否覆盖草稿，逐字告知（P1-2/P0-2 的展示面）
        setSubmitStatus({
          kind: 'error',
          text: outcome.restored
            ? `提交未生效：${message}（草稿与附件已还原）`
            : `提交未生效：${message}（你之后输入的内容未被覆盖，失败内容在台账中等待合并还原）`,
        });
        props.io.onSubmitError?.(submission, error);
      },
    );
  };

  const onEnterGesture = (gesture: ComposerSubmitGesture): void => {
    const policy = resolveEnterPolicy(policyInput, gesture);
    submitWith(policy.intent, policy.placement);
  };

  const onPrimary = (): void => {
    if (main.kind === 'stop') {
      props.io.stop?.();
      return;
    }
    if (main.disabled) return;
    const policy = resolveEnterPolicy(policyInput, 'enter');
    submitWith(policy.intent, policy.placement);
  };

  /**
   * 引用入口（P1-1：「不准静默丢能力」）：在光标处插入 `@` 起始符并把焦点交回编辑器。
   * 引用链路的真实效果在**提交边界**（assembly 的 `@path` 解析 → references + 引用来源报告）：
   * 本按钮给了鼠标可达的入口，不伪造路径、不伪造 kind。
   */
  const onInsertReferencePrefix = (): void => {
    store.dispatch({ type: 'insert-text', text: '@' });
    editorRef.current?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const accel = e.ctrlKey || e.metaKey;
    // IME 组合中绝不提交（React 合成事件不自带 isComposing → 取原生事件，叠加旧式 keyCode 229 兜底）
    const imeComposing = isImeComposing({
      key: e.key,
      isComposing: e.nativeEvent.isComposing === true,
      keyCode: e.keyCode,
    });
    // 换行：Shift+Enter 由 `beforeinput`（insertLineBreak）落到草稿 —— jsdom 无该合成路径，
    // 属**真机清单项**（P2-5 登记：Playwright/Electron 真机验证，不造假测试）。
    if (e.key === 'Enter' && !imeComposing && (accel || !e.shiftKey)) {
      e.preventDefault();
      // **登记 P6（P2-4）**：上游 `skeleton/InputBar.tsx:294-299` 在「草稿为空 + 加速手势」
      // 时把动作改为「steer 整个队列」（`keyboard.steerQueue()`），桌面侧暂未实现该组合键。
      onEnterGesture(accel ? 'accelerated' : 'enter');
      return;
    }
    if (e.key === 'Backspace' && !accel) {
      if (state.atoms.length > 0) {
        e.preventDefault();
        store.dispatch({ type: 'backspace' }); // chip 原子性：整体删除，不删一半
      }
      return;
    }
    if ((e.key === 'z' || e.key === 'Z') && accel) {
      e.preventDefault();
      store.dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
    }
  };

  const onBeforeInput = (e: FormEvent<HTMLDivElement>): void => {
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === 'insertText' && typeof native.data === 'string') {
      e.preventDefault();
      store.dispatch({ type: 'insert-text', text: native.data });
      return;
    }
    if (native.inputType === 'insertParagraph' || native.inputType === 'insertLineBreak') {
      e.preventDefault();
      store.dispatch({ type: 'insert-text', text: '\n' });
    }
  };

  const onInput = (e: FormEvent<HTMLDivElement>): void => {
    // 兜底（无 beforeinput 的宿主）：有 chip 时不从 DOM 文本回写，避免吞掉原子节点
    if (hasChip(state.atoms)) return;
    const text = e.currentTarget.textContent ?? '';
    if (text !== draftText(state)) store.dispatch({ type: 'set-text', text });
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    const text = e.clipboardData.getData('text/plain');
    if (text.length === 0) return;
    e.preventDefault();
    store.dispatch({ type: 'insert-text', text });
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files: SelectedFileLike[] = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    void attachFiles(files);
  };

  const chainProps: ComposerChainProps = {
    sessionId: props.sessionId,
    session: props.session,
    pendingInteraction: props.pendingInteraction,
  };
  const takeover = props.chain !== undefined ? props.chain.select(chainProps) : null;

  const placeholder = props.placeholder ?? (locked ? PLACEHOLDER_NO_SESSION : PLACEHOLDER_WITH_SESSION);

  return (
    <div className="composer-slot" data-testid="composer-slot">
      {takeover !== null && (
        <div className="composer-takeover" data-testid="composer-takeover">
          {renderComposerTakeover(takeover, chainProps)}
        </div>
      )}
      {/* D-38：takeover 生效时默认 composer **保持挂载**（hidden），不卸载 */}
      <div className="composer-default" data-testid="composer-default" hidden={takeover !== null}>
        <div className="composer">
          <div
            className="composer-editor"
            data-testid="composer-editor"
            ref={editorRef}
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder}
            aria-disabled={locked ? true : undefined}
            contentEditable={!locked}
            suppressContentEditableWarning
            onKeyDown={onKeyDown}
            onBeforeInput={onBeforeInput}
            onInput={onInput}
            onPaste={onPaste}
          >
            {state.atoms.map((atom, index) =>
              atom.kind === 'text' ? (
                <span key={`text-${index}`} data-atom="text">
                  {atom.text}
                </span>
              ) : (
                <span
                  key={atom.id}
                  className="composer-chip"
                  data-atom="chip"
                  data-chip-id={atom.id}
                  contentEditable={false}
                  title={atom.label}
                >
                  {atom.label}
                </span>
              ),
            )}
          </div>
          {attachments.length > 0 && (
            <div className="composer-attachments" data-testid="composer-attachments" aria-label="附件">
              {attachments.map((a) => (
                <span key={a.id} className={`composer-attachment att-${a.state}`} data-attachment-id={a.id}>
                  {a.dataUrl !== undefined && (
                    <img className="composer-attachment-thumb" src={a.dataUrl} alt={a.name} />
                  )}
                  {a.kind === 'image' ? '图' : '文件'} {a.name}
                  {a.state === 'uploading' || a.state === 'queued' ? '（上传中…）' : ''}
                  {a.state === 'failed' ? `（失败：${a.error ?? '未知原因'}）` : ''}
                </span>
              ))}
            </div>
          )}
          {/* 提交结果提示（P1-2 拒绝可见 / P2-1 placement 落点）：不静默 */}
          {submitStatus !== null && (
            <div className="composer-status" data-testid="composer-status" data-kind={submitStatus.kind} role="status">
              {submitStatus.text}
            </div>
          )}
          <div className="composer-actions">
            <button
              type="button"
              className="btn-reference"
              data-testid="composer-reference"
              disabled={locked}
              title="引用文件（在光标处插入 @，随后输入路径）"
              onClick={onInsertReferencePrefix}
            >
              引用
            </button>
            <button
              type="button"
              className="btn-attach"
              data-testid="composer-attach"
              disabled={locked}
              title="附加图片或文件"
              onClick={() => fileInputRef.current?.click()}
            >
              附件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={onFileChange}
            />
            <button
              type="button"
              className={main.kind === 'stop' ? 'btn-stop' : 'btn-send'}
              data-testid="composer-primary"
              data-kind={main.kind}
              data-label-kind={main.labelKind}
              disabled={main.disabled}
              title={main.label}
              aria-label={main.label}
              onClick={onPrimary}
            >
              {main.kind === 'stop' ? '■ 停止' : main.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
