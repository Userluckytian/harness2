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
//   Z3-04（Z-94）：左右簇控件 —— 左簇模式切换、右簇模型选择 + 发送/停止（图标钮 + tooltip）。
//        数据经 props 注入（`modelSelect` / `modeSwitch`）；缺省不渲染对应控件（web 壳无数据
//        通道时传 undefined，控件整体不出现 —— 绝不渲染假状态）。
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
} from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Spinner } from '../../../components/ui/spinner.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { ComposerModeSwitch, ComposerModelSelect, ComposerThoughtLevel } from './composer-controls.js';
import { ComposerContextChipRow, type ComposerContextChipsProps } from './context-chips.js';
import { ComposerContextMenu, type ComposerContextPickerOptions } from './composer-context-menu.js';
import type { ComposerApprovalMode, ComposerModelMenu, ComposerModelRef } from './composer-config.js';
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

/** Z10-2 上下文 chip 数据面类型（定义在 context-chips.tsx；此处 re-export 便于壳从单一入口取型）。 */
export type { ComposerContextChip, ComposerContextChipsProps } from './context-chips.js';

/**
 * Z3-04 右簇「模型选择」数据面（壳注入；undefined = 该壳无数据通道，控件整体不渲染）。
 * ⚠️ 如实差异：这是 **config 级**选择（写 `roles.main`），影响之后的会话；运行中会话是否
 * 跟进取决于 core 读配置时机 —— 本组件只呈现 config 当前值，不声称「本会话已切换」。
 */
export interface ComposerModelSelectProps {
  /** 菜单模型（壳经 buildModelMenu 构造；roles.main 缺失时壳不传 = 控件不渲染） */
  readonly menu: ComposerModelMenu;
  readonly onSelectModel: (target: ComposerModelRef) => void;
  /** 「管理模型」入口；缺省 = 菜单无该项（壳无设置通道时如实省略，不摆死入口） */
  readonly onManageModels?: () => void;
}

/**
 * Z3-04 左簇「模式切换」数据面（壳注入）。`mode` = config `approval.mode` 原值（未设置 =
 * undefined，按 core 缺省 default 展示）；回调收到**决策后的最终模式**（Plan↔单选映射与
 * 回落已在控件内经 composer-config 纯函数完成）。
 * ⚠️ 如实差异：同为 config 级（写 `approval.mode`），语义同上。
 */
export interface ComposerModeSwitchProps {
  readonly mode: string | undefined;
  readonly onModeChange: (mode: ComposerApprovalMode) => void;
}

/**
 * Z10-2b 右簇「思考档位」数据面（壳注入；undefined = 该壳无通道或模型未声明档位 → 控件不渲染）。
 * 档位集合来自 core `providers.<c>.models.<m>.reasoning.values`（每模型自声明，非全局枚举）；
 * 当前值 = config `roles.<role>.effort`（未设置时按 core 语义取模型缺省档位）。
 * ⚠️ 如实差异：同为 **config 级**选择，影响之后的会话；UI 只呈现 config 当前值。
 */
export interface ComposerThoughtLevelProps {
  readonly current: string;
  readonly values: readonly string[];
  readonly onSelectLevel: (level: string) => void;
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
  /** Z3-04 右簇模型选择（壳注入；undefined = 不渲染该控件） */
  readonly modelSelect?: ComposerModelSelectProps;
  /** Z3-04 左簇模式切换（壳注入；undefined = 不渲染该控件） */
  readonly modeSwitch?: ComposerModeSwitchProps;
  /** Z10-2b 右簇思考档位（壳注入；undefined = 不渲染该控件） */
  readonly thoughtLevel?: ComposerThoughtLevelProps;
  /**
   * Z10-2 composer 上方「项目」「Git 分支」上下文 chip（壳注入；undefined = 整行不渲染）。
   * 缺省不渲染；无切换通道的壳把 chip 渲染为只读（disabled + title）—— 见 `context-chips.tsx`。
   */
  readonly contextChips?: ComposerContextChipsProps;
  /**
   * P0「添加上下文」选择器数据面（壳注入）。
   * 与左右簇控件不同：**按钮恒渲染**（ZCode composer 常驻项）；`contextPicker` 只携带数据源，
   * 缺省（web）= 无目录通道 → 面板文件清单区如实显示「web 无目录通道」，不摆假文件树。
   */
  readonly contextPicker?: ComposerContextPickerOptions;
  readonly io: ComposerIO;
  /** 注入 store（测试/装配层持久草稿用）；缺省内部自建 */
  readonly store?: ComposerStore;
  readonly chain?: ComposerChain;
  /** 图片读取缝（缺省 = 浏览器 FileReader） */
  readonly imageIO?: ImageReadIO;
  readonly placeholder?: string;
  /**
   * 编辑器元素的外部引用（Z4-02/Z4-03 预填后聚焦用）：与内部 ref 合并，元素挂载 / 卸载
   * 都会同步。缺省不传 = 行为与旧版完全一致。
   */
  readonly editorRef?: Ref<HTMLDivElement>;
}

/** 内建会话草稿的默认提示（无会话时提示选择会话） */
const PLACEHOLDER_WITH_SESSION = '向 harness2 提问，使用 @ 添加上下文，使用 / 选择命令或能力';
const PLACEHOLDER_NO_SESSION = '选择会话后开始输入';

/** 提交结果提示（P1-2 展示面 / P2-1 `placement` 的真实落点）；seq = 提交序号（落定时只清自己那条） */
type SubmitStatus = { readonly kind: 'placement' | 'error'; readonly text: string; readonly seq?: number };

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
  /** 在途提交计数（Z-94：pending 时发送钮显示 Spinner；乐观提交的 await 窗口，如实反映） */
  const [inFlightSubmits, setInFlightSubmits] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // 外部编辑器 ref 合并（Z4-02/Z4-03）：宿主（seat）用它做预填后聚焦；卸载时清外部引用
  const setEditorRef = useCallback(
    (el: HTMLDivElement | null): void => {
      editorRef.current = el;
      const external = props.editorRef;
      if (external === undefined || external === null) return;
      if (typeof external === 'function') external(el);
      else (external as { current: HTMLDivElement | null }).current = el;
    },
    [props.editorRef],
  );
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
    submitSeqRef.current += 1;
    const seq = submitSeqRef.current;
    // P2-1：`placement` 的真实落点 = 主指针旁的状态行（不再是「看起来有用其实没用」的字段）
    setSubmitStatus({ kind: 'placement', text: placementNotice(submission.placement), seq });
    setInFlightSubmits((n) => n + 1);
    Promise.resolve(props.io.submit(submission))
      .then(
        () => {
          // D2：ack 落定（accepted / unknown）即清除落点提示，避免「已发送（transcript），
          // 等待服务端确认…」永久常驻。只清自己那条（并发提交不互相覆盖）。
          setSubmitStatus((cur) => (cur !== null && cur.kind === 'placement' && cur.seq === seq ? null : cur));
        },
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
      )
      .finally(() => {
        setInFlightSubmits((n) => Math.max(0, n - 1));
      });
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

  /**
   * P0 文件清单选中回填：把 `@相对路径` 插到光标处（沿用既有 @ 提及语义 —— 与「引用」钮同一
   * insert-text 派发；提交边界由 assembly 的 `@path` 解析落成 references）。末尾补空格，
   * 便于用户继续输入；焦点交回编辑器。
   */
  const onInsertContextPath = useCallback(
    (relativePath: string): void => {
      store.dispatch({ type: 'insert-text', text: `@${relativePath} ` });
      editorRef.current?.focus();
    },
    [store],
  );

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

  /**
   * `beforeinput` 拦截层：常规文本 / 换行转成显式的状态派发，并 preventDefault 阻止浏览器
   * 默认写入（React 状态是唯一真源）。
   * IME 语义（组合期为何不接 DOM，与 `onInput` 的契约配套）：
   *   - 组合中间帧（`insertCompositionText`）**不拦**——组合文本由浏览器在 contentEditable
   *     里绘制（下划线态），不是用户的最终内容，状态一律不接（由 `onInput` 的组合期闸门兜住）；
   *   - 落定帧（`insertFromComposition`，Chromium 在 compositionend 时发的最后一帧）在这里拦下，
   *     一次性 dispatch 落定文本 —— 若放任默认行为，半截组合文本已污染状态时落定文本会再叠一层
   *     （真机缺陷：草稿逐字累积重复，落盘证据 = 目标串 + 递减前缀链）。
   */
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
      return;
    }
    if (native.inputType === 'insertFromComposition') {
      if (typeof native.data === 'string' && native.data.length > 0) {
        // 落定只此一次：preventDefault 阻止浏览器再往 DOM 里落，文本经派发进 atoms
        e.preventDefault();
        store.dispatch({ type: 'insert-text', text: native.data });
      }
      // data=null 的落定帧不拦：让后续 input(insertFromComposition，isComposing:false) 走
      // onInput 的 textContent 兜底 —— set-text 取 DOM 全文，比凭空补一个空串稳
      // （reducer 对 '' 本就是 no-op，但显式跳过意图更清楚）。
    }
  };

  /**
   * 兜底回写通道（无 beforeinput 的宿主，或未被上面拦截的原生操作）。
   * 为什么组合期不接 DOM（IME 契约）：组合中途的半截文本由浏览器自行绘制进 contentEditable
   * （下划线态），不是最终内容；状态只接**落定帧**。若中途帧也回写，`set-text` 会用半截
   * textContent 覆盖草稿，浏览器组合继续往后追加 → 草稿逐字累积重复（真机已复现：落盘证据
   * = 目标串 + 递减前缀链）。
   */
  const onInput = (e: FormEvent<HTMLDivElement>): void => {
    const native = e.nativeEvent as InputEvent;
    // 组合中间帧闸门：isComposing 是权威信号；inputType 兜底旧宿主不透传 isComposing 的情况
    const composingFrame =
      native.isComposing === true ||
      native.inputType === 'insertCompositionText' ||
      native.inputType === 'deleteCompositionText';
    if (composingFrame) return;
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
  /** 占位符显隐判据：草稿为空（无文本、无 chip）—— 与 ZCode LexicalChatInput 的 isEmpty 等价 */
  const draftIsEmpty = state.atoms.length === 0;

  return (
    <div className="composer-slot" data-testid="composer-slot">
      {takeover !== null && (
        <div className="composer-takeover" data-testid="composer-takeover">
          {renderComposerTakeover(takeover, chainProps)}
        </div>
      )}
      {/* D-38：takeover 生效时默认 composer **保持挂载**（hidden），不卸载。
          `@container/composer`：Z-94 外壳容器查询锚点（模型 trigger 空间不足时退化为图标） */}
      <div className="composer-default" data-testid="composer-default" hidden={takeover !== null}>
        <div className="composer @container/composer">
          {/* Z10-2：「项目」「Git 分支」上下文 chip 行 —— 位于编辑器之上（ZCode 实测 y=348 < 394）。
              无数据（无 cwd / gitBranch null / web 无通道）→ 整行不渲染（不摆空 chip）。 */}
          <ComposerContextChipRow chips={props.contextChips} />
          {/* P0-1 占位符（ZCode LexicalChatInput 口径）：**空草稿时可见的占位文案**。
              contentEditable div 无原生 placeholder，故用兄弟层 `<span>` 叠在编辑器上
              （pointer-events:none，不污染 editor.textContent —— 既有断言 textContent 的
              用例不受影响）。有文本/chip 后自动消失。只做占位符视觉，不实现 @ / 弹层（另批）。 */}
          <div className="composer-editor-wrap">
            <div
              className="composer-editor"
              data-testid="composer-editor"
              ref={setEditorRef}
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
            {/* 占位层：草稿为空（无文本无 chip）时显示占位文案；有内容即消失。
                锁定（无会话）时空草稿仍显示「选择会话后开始输入」提示（与 placeholder 取值一致）。
                aria-hidden：可访问名已由编辑器的 aria-label 承担，占位层不重复播报。 */}
            {draftIsEmpty && (
              <span className="composer-placeholder" data-testid="composer-placeholder" aria-hidden="true">
                {placeholder}
              </span>
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
            {/* 左簇（Z-94）：添加上下文（P0，最左常驻）→ 引用 / 附件（既有入口）+ 模式切换（数据注入才渲染） */}
            <div className="composer-actions-left">
              <ComposerContextMenu
                disabled={locked}
                onInsertPath={onInsertContextPath}
                // 附件通道 = composer 自身的 `<input type="file">`（浏览器 File 通道，真实可用）
                attachmentsAvailable
                onPickAttachment={() => fileInputRef.current?.click()}
                {...(props.contextPicker?.listDir !== undefined ? { listDir: props.contextPicker.listDir } : {})}
              />
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
              {props.modeSwitch !== undefined && (
                <ComposerModeSwitch mode={props.modeSwitch.mode} onModeChange={props.modeSwitch.onModeChange} />
              )}
            </div>
            {/* 右簇（Z-94）：模型选择 + 思考档位 + 发送/停止 */}
            <div className="composer-actions-right">
              {props.modelSelect !== undefined && (
                <ComposerModelSelect
                  menu={props.modelSelect.menu}
                  onSelectModel={props.modelSelect.onSelectModel}
                  {...(props.modelSelect.onManageModels !== undefined
                    ? { onManageModels: props.modelSelect.onManageModels }
                    : {})}
                />
              )}
              {props.thoughtLevel !== undefined && (
                <ComposerThoughtLevel
                  current={props.thoughtLevel.current}
                  values={props.thoughtLevel.values}
                  onSelectLevel={props.thoughtLevel.onSelectLevel}
                />
              )}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-md"
                      className="rounded-lg bg-brand text-primary-foreground"
                      data-testid="composer-primary"
                      data-kind={main.kind}
                      data-label-kind={main.labelKind}
                      disabled={main.disabled}
                      aria-label={main.label}
                      onClick={onPrimary}
                    >
                      {main.kind === 'stop' ? (
                        <SquareIcon className="size-4" />
                      ) : inFlightSubmits > 0 ? (
                        // Z-94：pending 时显示 Spinner（乐观提交的 await 窗口，如实反映）
                        <Spinner className="size-4" />
                      ) : (
                        <ArrowUpIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  {/* Z-94：停止钮 tooltip 标 Esc；发送钮 tooltip 跟随主指针标签 */}
                  <TooltipContent>{main.kind === 'stop' ? 'Esc' : main.label}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
