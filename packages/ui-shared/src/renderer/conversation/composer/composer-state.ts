// composer-state.ts — 桌面对话页 composer 草稿状态机（D-33 常驻 composer / D-34 乐观提交同事务）。
//
// 规格依据：docs/refs/refs-deepseek-harness.md D-33～D-34（参考级：形似即可，不引 Lexical，
// 用受控等价物）与上游 `packages/client/ui-conversation/README.zh.md`「输入状态」节：
//   D-33 常驻挂载（挂载由装配层保证；本模块不因「无会话」自毁）、引用 chip = **原子节点**
//        （不可在 chip 中间插入字符，退格整体删除）、斜杠命令为行首样式文本；
//   D-34 乐观提交：Enter 在**同一事务**内清空草稿 + occurrence + 撤销历史；发送为 detached
//        attempt；`pendingSubmissions` 保序。
//
// 本模块是**纯 reducer + 一个最小事务化 store**：零 DOM / 零 React / 零 Node，全部可单测。
// 「同一事务」的机制落点：`ComposerStore.dispatch()` 一次派发至多通知一次（batches +1），
// `commitDraft()` 在一次返回里同时给出「清空后的草稿」与「冻结的提交载荷」——测试据此断言
// 「提交后 history 为空 && draft 为空 && 只有一个状态变更批次」。
import type { MessageReferenceShape, SubmitIntentShape } from '../../../shared/protocol.js';
import type { ComposerAttachment } from './attachments.js';

/** 草稿内联原子：文本段或引用 chip。chip 是**原子节点**——不能中间插入、退格整体删除。 */
export type ComposerAtom =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'chip';
      /** 原子自身 id（与 reference.id 分开：同一引用可被多次插入） */
      readonly id: string;
      /** 行内展示 / 序列化用的标签（如 @src/a.ts） */
      readonly label: string;
      /** 引用来源（与 shared/file-ref、D-1 @引用 同一形状） */
      readonly reference: MessageReferenceShape;
    };

/** 引用 chip 原子（D-33） */
export type ComposerChip = Extract<ComposerAtom, { kind: 'chip' }>;

/**
 * 光标：atoms 下标 + 节点内偏移（UTF-16 码元，与 DOM 一致）。
 * 合法节点下标区间 0..atoms.length（= 末尾位置）；文本节点偏移 0..len；
 * **chip 节点只有偏移 0（chip 之前）一个合法位**，「chip 之后」= 下一个下标——
 * 因此 chip 内部（offset>0）不是合法插入点，`insertText`/`insertChip`/`backspace` 一律拒绝。
 */
export interface ComposerCaret {
  readonly node: number;
  readonly offset: number;
}

/** 可撤销快照（atoms + 光标；历史栈元素） */
export interface ComposerSnapshot {
  readonly atoms: readonly ComposerAtom[];
  readonly caret: ComposerCaret;
}

export const COMPOSER_HISTORY_LIMIT = 100;
export const COMPOSER_CARET_ORIGIN: ComposerCaret = Object.freeze({ node: 0, offset: 0 });
const EMPTY_ATOMS: readonly ComposerAtom[] = Object.freeze([]);

export interface ComposerState {
  readonly atoms: readonly ComposerAtom[];
  readonly caret: ComposerCaret;
  /** 撤销历史（栈顶 = 最近一步）；提交时**同一事务内**清空（D-34） */
  readonly history: readonly ComposerSnapshot[];
  readonly redo: readonly ComposerSnapshot[];
  /** 单调版本号：每次状态变更 +1；同一事务提交只 +1（测试据此断言单批次） */
  readonly revision: number;
}

export function createComposerState(init: Partial<Pick<ComposerState, 'atoms' | 'caret'>> = {}): ComposerState {
  const atoms = init.atoms ?? EMPTY_ATOMS;
  const caret = init.caret ?? COMPOSER_CARET_ORIGIN;
  return { atoms, caret, history: [], redo: [], revision: 0 };
}

// —— 光标合法性（chip 原子性的守卫）——

export function isCaretValid(atoms: readonly ComposerAtom[], caret: ComposerCaret): boolean {
  if (!Number.isInteger(caret.node) || !Number.isInteger(caret.offset)) return false;
  if (caret.node < 0 || caret.node > atoms.length) return false;
  if (caret.node === atoms.length) return caret.offset === 0;
  const atom = atoms[caret.node];
  if (atom === undefined) return false;
  if (atom.kind === 'text') return caret.offset >= 0 && caret.offset <= atom.text.length;
  // chip：内部位不是合法插入点（不许在 chip 中间插字符）
  return caret.offset === 0;
}

/** 夹取到最近的合法位（外部注入光标时用；不改变 chip 原子性） */
export function normalizeCaret(atoms: readonly ComposerAtom[], caret: ComposerCaret): ComposerCaret {
  const node = Math.max(0, Math.min(Math.trunc(caret.node), atoms.length));
  if (node >= atoms.length) return { node: atoms.length, offset: 0 };
  const atom = atoms[node];
  if (atom === undefined || atom.kind === 'chip') return { node, offset: 0 };
  return { node, offset: Math.max(0, Math.min(Math.trunc(caret.offset), atom.text.length)) };
}

// —— 文本投影 / 序列化 ——

export function hasChip(atoms: readonly ComposerAtom[]): boolean {
  return atoms.some((a) => a.kind === 'chip');
}

/** 草稿的行内纯文本（chip 以标签参与投影；不展开 reference） */
export function draftText(state: ComposerState): string {
  let out = '';
  for (const a of state.atoms) out += a.kind === 'text' ? a.text : a.label;
  return out;
}

export interface SerializedDraft {
  readonly rawText: string;
  /** 所有 chip 引用的**出现顺序**（提交时随 rawText 一起交给服务端核验） */
  readonly references: readonly MessageReferenceShape[];
}

export function serializeDraft(state: ComposerState): SerializedDraft {
  let rawText = '';
  const references: MessageReferenceShape[] = [];
  for (const a of state.atoms) {
    if (a.kind === 'text') {
      rawText += a.text;
      continue;
    }
    rawText += a.label;
    references.push(a.reference);
  }
  return { rawText, references };
}

/** 草稿是否为空（纯空白 = 空；因此「空草稿 + 附件」由附件单独判定，见 submit-policy） */
export function isDraftEmpty(state: ComposerState): boolean {
  return serializeDraft(state).rawText.trim().length === 0;
}

/** 斜杠命令行（行首 `/`，D-33 行首样式文本）：点击/回车走命令裁定而非普通消息投递 */
export function isSlashCommand(state: ComposerState): boolean {
  return draftText(state).trimStart().startsWith('/');
}

// —— 编辑原语（纯函数：同输入恒同输出，永不修改入参）——

function commitEdit(state: ComposerState, atoms: readonly ComposerAtom[], caret: ComposerCaret): ComposerState {
  return {
    atoms,
    caret,
    history: [{ atoms: state.atoms, caret: state.caret }, ...state.history].slice(0, COMPOSER_HISTORY_LIMIT),
    redo: [],
    revision: state.revision + 1,
  };
}

/** 在光标处插入文本（chip 内部 / 越界光标一律拒绝——原子性守卫） */
export function insertText(state: ComposerState, text: string): ComposerState {
  if (text.length === 0) return state;
  if (!isCaretValid(state.atoms, state.caret)) return state;
  const { node, offset } = state.caret;
  const atoms = [...state.atoms];
  if (node === atoms.length) {
    atoms.push({ kind: 'text', text });
    return commitEdit(state, atoms, { node: node + 1, offset: 0 });
  }
  const atom = atoms[node];
  if (atom === undefined) return state;
  if (atom.kind === 'text') {
    atoms[node] = { kind: 'text', text: atom.text.slice(0, offset) + text + atom.text.slice(offset) };
    return commitEdit(state, atoms, { node, offset: offset + text.length });
  }
  // 光标在 chip 之前：在两者之间落一个新文本段（不切 chip）
  atoms.splice(node, 0, { kind: 'text', text });
  return commitEdit(state, atoms, { node, offset: text.length });
}

/** 在光标处插入引用 chip（文本节点中间插入时切成两段夹住 chip） */
export function insertChip(state: ComposerState, chip: ComposerChip): ComposerState {
  if (!isCaretValid(state.atoms, state.caret)) return state;
  const { node, offset } = state.caret;
  const atoms = [...state.atoms];
  if (node === atoms.length) {
    atoms.push(chip);
    return commitEdit(state, atoms, { node: atoms.length, offset: 0 });
  }
  const atom = atoms[node];
  if (atom === undefined) return state;
  if (atom.kind === 'chip') {
    atoms.splice(node, 0, chip);
    return commitEdit(state, atoms, { node: node + 1, offset: 0 });
  }
  const head = atom.text.slice(0, offset);
  const tail = atom.text.slice(offset);
  const replacement: ComposerAtom[] = [];
  if (head.length > 0) replacement.push({ kind: 'text', text: head });
  replacement.push(chip);
  if (tail.length > 0) replacement.push({ kind: 'text', text: tail });
  atoms.splice(node, 1, ...replacement);
  const chipIndex = node + (head.length > 0 ? 1 : 0);
  return commitEdit(state, atoms, { node: chipIndex + 1, offset: 0 });
}

/**
 * 退格（chip 原子性的正面用例）：
 *   - 光标之前在文本内 → 删一个码点；
 *   - 光标紧贴 chip 之后（prev = chip）→ **整体删除 chip**（绝不删一半）；
 *   - 光标在文本段起点且前一段是文本 → 删前一段最后一个码点（空段移除）。
 */
export function backspace(state: ComposerState): ComposerState {
  if (!isCaretValid(state.atoms, state.caret)) return state;
  const { node, offset } = state.caret;
  const atoms = [...state.atoms];
  if (node === atoms.length) {
    const prev = atoms[node - 1];
    if (prev === undefined) return state;
    if (prev.kind === 'chip') {
      atoms.pop();
      return commitEdit(state, atoms, { node: node - 1, offset: 0 });
    }
    const nextText = dropLastCodePoint(prev.text);
    if (nextText.length === 0) {
      atoms.pop();
      return commitEdit(state, atoms, { node: node - 1, offset: 0 });
    }
    atoms[node - 1] = { kind: 'text', text: nextText };
    return commitEdit(state, atoms, { node: node - 1, offset: nextText.length });
  }
  const atom = atoms[node];
  if (atom === undefined) return state;
  if (atom.kind === 'text' && offset > 0) {
    const head = dropLastCodePoint(atom.text.slice(0, offset));
    atoms[node] = { kind: 'text', text: head + atom.text.slice(offset) };
    return commitEdit(state, atoms, { node, offset: head.length });
  }
  // offset === 0：往前吞
  if (node === 0) return state;
  const prev = atoms[node - 1];
  if (prev === undefined) return state;
  if (prev.kind === 'chip') {
    atoms.splice(node - 1, 1);
    return commitEdit(state, atoms, { node: node - 1, offset: 0 });
  }
  const nextText = dropLastCodePoint(prev.text);
  if (nextText.length === 0) {
    atoms.splice(node - 1, 1);
    return commitEdit(state, atoms, { node: node - 1, offset: 0 });
  }
  atoms[node - 1] = { kind: 'text', text: nextText };
  return commitEdit(state, atoms, { node: node - 1, offset: nextText.length });
}

function dropLastCodePoint(text: string): string {
  const chars = Array.from(text);
  chars.pop();
  return chars.join('');
}

/** 整体替换文本（受控 textarea 等价物的 onChange；有 chip 时由调用方先决定是否清 chip） */
export function setDraftText(state: ComposerState, text: string): ComposerState {
  const same = !hasChip(state.atoms) && draftText(state) === text;
  if (same) return state;
  if (text.length === 0) return commitEdit(state, EMPTY_ATOMS, COMPOSER_CARET_ORIGIN);
  const atoms: readonly ComposerAtom[] = [{ kind: 'text', text }];
  return commitEdit(state, atoms, { node: 1, offset: 0 });
}

/** 清空草稿（可撤销；提交请用 commitDraft——它同时清历史） */
export function clearDraft(state: ComposerState): ComposerState {
  if (state.atoms.length === 0) return state;
  return commitEdit(state, EMPTY_ATOMS, COMPOSER_CARET_ORIGIN);
}

export function undo(state: ComposerState): ComposerState {
  const top = state.history[0];
  if (top === undefined) return state;
  return {
    atoms: top.atoms,
    caret: top.caret,
    history: state.history.slice(1),
    redo: [{ atoms: state.atoms, caret: state.caret }, ...state.redo].slice(0, COMPOSER_HISTORY_LIMIT),
    revision: state.revision + 1,
  };
}

export function redo(state: ComposerState): ComposerState {
  const top = state.redo[0];
  if (top === undefined) return state;
  return {
    atoms: top.atoms,
    caret: top.caret,
    history: [{ atoms: state.atoms, caret: state.caret }, ...state.history].slice(0, COMPOSER_HISTORY_LIMIT),
    redo: state.redo.slice(1),
    revision: state.revision + 1,
  };
}

// —— 乐观提交（D-34）——

/** 投递落点（D-35）：空闲进 transcript；繁忙 Queue 进 QueueDock；繁忙 Steer 进 pending-steering */
export type SubmissionPlacement = 'transcript' | 'queue-dock' | 'pending-steering';

/**
 * 一次提交的载荷（detached attempt）：与编辑器状态解耦——冻结后不再随草稿变化，
 * 附件按**选择顺序**原样带走（D-34）。
 */
export interface PendingSubmission {
  readonly clientMessageId: string;
  readonly sessionId: string;
  readonly rawText: string;
  readonly intent: SubmitIntentShape;
  readonly placement: SubmissionPlacement;
  readonly references: readonly MessageReferenceShape[];
  readonly attachments: readonly ComposerAttachment[];
  readonly expectedTurnId?: string;
  /** detached attempt 标记：提交载荷不持有可变草稿引用 */
  readonly detached: true;
  readonly ts: number;
}

export interface CommitDraftOptions {
  readonly sessionId: string;
  readonly intent: SubmitIntentShape;
  readonly placement: SubmissionPlacement;
  readonly clientMessageId: string;
  readonly expectedTurnId?: string;
  readonly attachments?: readonly ComposerAttachment[];
  readonly now?: number;
}

export interface CommitDraftResult {
  readonly state: ComposerState;
  readonly submission: PendingSubmission;
}

/**
 * 乐观提交（D-34 硬语义）：**一次返回**里给出「清空后的草稿」（draft + occurrence + 撤销历史
 * 同时归零，revision 只 +1）与「冻结的 detached 提交载荷」。调用方（ComposerStore.dispatch）
 * 只做一次通知，因此全链路只有一个状态变更批次。
 */
export function commitDraft(state: ComposerState, opts: CommitDraftOptions): CommitDraftResult {
  const { rawText, references } = serializeDraft(state);
  const submission: PendingSubmission = Object.freeze({
    clientMessageId: opts.clientMessageId,
    sessionId: opts.sessionId,
    rawText,
    intent: opts.intent,
    placement: opts.placement,
    references: Object.freeze([...references]),
    attachments: Object.freeze([...(opts.attachments ?? [])]),
    ...(opts.expectedTurnId !== undefined ? { expectedTurnId: opts.expectedTurnId } : {}),
    detached: true,
    ts: opts.now ?? 0,
  });
  return {
    state: {
      atoms: EMPTY_ATOMS,
      caret: COMPOSER_CARET_ORIGIN,
      history: [],
      redo: [],
      revision: state.revision + 1,
    },
    submission,
  };
}

/**
 * 失败还原（P0-2）：按上游语义实现，**不再无条件覆盖用户新输入**。
 *
 * 上游依据（`packages/client/ui-conversation/src/client/input/facade.ts`）：
 *   - `settleDetachedFailure`（:793-803）：失败记录进 `failedDetached`；**只有**
 *     `projection.clipboardText === '' || failedRestoreRev === rev` 时才回写草稿
 *     （即「用户尚未编辑还原内容」）；
 *   - `restoreFailedDrafts`（:806-819）：多个并发失败按 **seq（提交顺序）升序** 合并，
 *     段间用 `'\n\n'` 分隔，绝不互相覆盖；
 *   - `restoreAttachments`（:861-868）：附件按提交顺序**去重后插回草稿头部**，
 *     用户期间新加的附件保持不动；
 *   - `sinkSerialized`（:731-734）：若上次自动还原后用户没编辑（`failedRestoreRev === rev`），
 *     新提交时先清空失败台账（否则重提的内容会在下次失败时被重复合并）。
 *
 * 与上游的一处**如实差异**（记录在案）：上游按 occurrence 重建引用 chip 节点，
 * 桌面侧还原为**纯文本**（text atom）。原因：chip 的标签本就参与 `rawText`
 * （`serializeDraft` 把 label 计入 rawText），再把 references 重建为 chip 会重复表达；
 * 且提交边界会重新解析 `@path`（见 assembly 的引用解析），重提时引用可复原。
 */
export interface FailedDraftRecord {
  /** 提交顺序（单调递增；并发失败按它合并，不互相覆盖） */
  readonly seq: number;
  /** 提交时的草稿文本（**未 trim**：trim 只作用于发出去的载荷，还原要还用户原文） */
  readonly rawText: string;
  /** 提交时的附件（含 failed 态，原样还给用户供重提） */
  readonly attachments: readonly ComposerAttachment[];
}

export interface FailedDraftLedger {
  /** 失败记录（提交顺序由 seq 编码，可能乱序到达） */
  readonly records: readonly FailedDraftRecord[];
  /** 最近一次自动还原落定后的 revision；用户再编辑（revision 变化）即失效 */
  readonly restoreRev?: number;
}

/** 多个失败草稿合并时的分隔符（上游 facade.ts:809 同值） */
export const FAILED_DRAFT_SEPARATOR = '\n\n';

export function createFailedDraftLedger(): FailedDraftLedger {
  return { records: [] };
}

/** 记入一次失败（同 seq 幂等替换）；不改 revision——失败还原不是用户编辑 */
export function noteFailedDraft(ledger: FailedDraftLedger, record: FailedDraftRecord): FailedDraftLedger {
  const records = ledger.records.filter((r) => r.seq !== record.seq);
  records.push(record);
  records.sort((a, b) => a.seq - b.seq);
  return { records, ...(ledger.restoreRev !== undefined ? { restoreRev: ledger.restoreRev } : {}) };
}

/**
 * 提交边界清台账（上游 `facade.ts:731-734`）：**仅当**上次自动还原后用户没再编辑
 * （`restoreRev === state.revision`）时清空 —— 此时这次提交的内容里就含着刚还原的文本，
 * 若不清，下次失败会把同一文本重复合并一遍。用户已编辑则原样返回（失败内容不能丢）。
 */
export function clearFailedDrafts(ledger: FailedDraftLedger, state: ComposerState): FailedDraftLedger {
  if (ledger.restoreRev !== state.revision) return ledger;
  if (ledger.records.length === 0) return ledger;
  return { records: [] };
}

/** 还原判据（上游 facade.ts:799）：草稿为空 **或** 自上次自动还原以来用户没编辑过 */
export function canAutoRestoreDraft(state: ComposerState, ledger: FailedDraftLedger): boolean {
  return draftText(state).length === 0 || ledger.restoreRev === state.revision;
}

export interface MergedFailedDrafts {
  readonly rawText: string;
  readonly attachments: readonly ComposerAttachment[];
}

/** 合并失败草稿（上游 restoreFailedDrafts 的文本部分 + restoreAttachments 的去重口径） */
export function mergeFailedDrafts(records: readonly FailedDraftRecord[]): MergedFailedDrafts {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  let rawText = '';
  const attachments: ComposerAttachment[] = [];
  const seen = new Set<string>();
  for (const record of ordered) {
    if (rawText !== '') rawText += FAILED_DRAFT_SEPARATOR;
    rawText += record.rawText;
    for (const attachment of record.attachments) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      attachments.push(attachment);
    }
  }
  return { rawText, attachments };
}

export interface FailedRestoreOutcome {
  readonly ledger: FailedDraftLedger;
  /** 需要还原进草稿的合并文本；undefined = 用户已编辑新内容，**不覆盖** */
  readonly restoreText?: string;
  /** 失败附件（跨失败合并、提交顺序、去重）——总是还给用户，与是否覆盖草稿无关 */
  readonly attachments: readonly ComposerAttachment[];
  readonly restored: boolean;
}

/**
 * 一次失败落定：记台账 → 合并附件 → **仅在用户未编辑还原内容时**把合并文本还原进草稿。
 * 返回的 `restoreText` 由调用方经 `restore-draft` 动作落进 store；落定后用
 * `markRestoreRev(ledger, store.getState().revision)` 校准判据锚点。
 */
export function settleFailedSubmission(
  state: ComposerState,
  ledger: FailedDraftLedger,
  record: FailedDraftRecord,
): FailedRestoreOutcome {
  const nextLedger = noteFailedDraft(ledger, record);
  const merged = mergeFailedDrafts(nextLedger.records);
  if (!canAutoRestoreDraft(state, ledger)) {
    // 用户已经输入了新内容：不覆盖（B 不丢），失败记录留在台账里，提示由调用方给
    return { ledger: nextLedger, attachments: merged.attachments, restored: false };
  }
  return {
    ledger: nextLedger,
    restoreText: merged.rawText,
    attachments: merged.attachments,
    restored: true,
  };
}

/** 还原落定后校准判据锚点（revision = 还原后的真实 revision；用户再编辑即使其失效） */
export function markRestoreRev(ledger: FailedDraftLedger, revision: number): FailedDraftLedger {
  return { records: ledger.records, restoreRev: revision };
}

/**
 * 把文本还原进草稿（单文本原子；清历史，revision **必 +1**）。
 * revision 必增是有意的：`FailedDraftLedger.restoreRev` 靠它判定「用户之后有没有再编辑」，
 * 因此即使文本与当前草稿相同也视为一次新还原（上游 restoreFailedDrafts 每次重建后 `failedRestoreRev = rev`）。
 */
export function restoreDraftText(state: ComposerState, rawText: string): ComposerState {
  const atoms: readonly ComposerAtom[] = rawText.length > 0 ? [{ kind: 'text', text: rawText }] : EMPTY_ATOMS;
  return {
    atoms,
    caret: { node: atoms.length, offset: 0 },
    history: [],
    redo: [],
    revision: state.revision + 1,
  };
}

// —— pendingSubmissions 保序队列（纯 reducer：FIFO 由追加顺序编码）——

export interface SubmissionQueueState {
  readonly entries: readonly PendingSubmission[];
}

export function createSubmissionQueue(): SubmissionQueueState {
  return { entries: [] };
}

/** 追加一条在途提交（保序：entries 顺序 = 提交顺序） */
export function enqueueSubmission(queue: SubmissionQueueState, submission: PendingSubmission): SubmissionQueueState {
  return { entries: [...queue.entries, submission] };
}

/** FIFO 顺序的 clientMessageId 列表（诊断/测试断言保序用） */
export function submissionOrder(queue: SubmissionQueueState): readonly string[] {
  return queue.entries.map((e) => e.clientMessageId);
}

export function removeSubmission(
  queue: SubmissionQueueState,
  clientMessageId: string,
): { readonly queue: SubmissionQueueState; readonly removed: PendingSubmission | undefined } {
  const index = queue.entries.findIndex((e) => e.clientMessageId === clientMessageId);
  if (index < 0) return { queue, removed: undefined };
  const entries = [...queue.entries];
  const [removed] = entries.splice(index, 1);
  return { queue: { entries }, removed };
}

export function isSubmissionQueueEmpty(queue: SubmissionQueueState): boolean {
  return queue.entries.length === 0;
}

// —— 动作 / reducer / 事务化 store ——

export type ComposerAction =
  | { readonly type: 'set-text'; readonly text: string }
  | { readonly type: 'insert-text'; readonly text: string }
  | { readonly type: 'insert-chip'; readonly chip: ComposerChip }
  | { readonly type: 'set-caret'; readonly caret: ComposerCaret }
  | { readonly type: 'backspace' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'clear' }
  | { readonly type: 'submit'; readonly commit: CommitDraftOptions }
  /** 提交失败还原（P0-2）：文本由 settleFailedSubmission 合并后给出，**不无条件覆盖** */
  | { readonly type: 'restore-draft'; readonly rawText: string };

export interface ComposerReduction {
  readonly state: ComposerState;
  /** 仅 type='submit' 时带出（detached 提交载荷） */
  readonly submission?: PendingSubmission;
  /** 本动作是否真的产生了新状态（false = 原引用返回，store 不通知） */
  readonly changed: boolean;
}

function wrap(prev: ComposerState, next: ComposerState): ComposerReduction {
  return next === prev ? { state: prev, changed: false } : { state: next, changed: true };
}

export function reduceComposer(state: ComposerState, action: ComposerAction): ComposerReduction {
  switch (action.type) {
    case 'set-text':
      return wrap(state, setDraftText(state, action.text));
    case 'insert-text':
      return wrap(state, insertText(state, action.text));
    case 'insert-chip':
      return wrap(state, insertChip(state, action.chip));
    case 'set-caret': {
      const caret = normalizeCaret(state.atoms, action.caret);
      if (caret.node === state.caret.node && caret.offset === state.caret.offset) {
        return { state, changed: false };
      }
      // 光标移动不改内容：不记历史、不增 revision（避免撤销被光标噪声淹没）
      return { state: { ...state, caret }, changed: true };
    }
    case 'backspace':
      return wrap(state, backspace(state));
    case 'undo':
      return wrap(state, undo(state));
    case 'redo':
      return wrap(state, redo(state));
    case 'clear':
      return wrap(state, clearDraft(state));
    case 'submit': {
      const { state: next, submission } = commitDraft(state, action.commit);
      return { state: next, submission, changed: true };
    }
    case 'restore-draft':
      return wrap(state, restoreDraftText(state, action.rawText));
  }
}

/**
 * 事务化草稿 store：`dispatch` 一次派发**至多通知一次**（batches +1）。
 * D-34 的「同一事务」由它兜底：submit 动作里草稿 + 撤销历史 + occurrence 同批落定，
 * 订阅者只看到一次变化后的状态。
 */
export class ComposerStore {
  private state: ComposerState;
  private readonly listeners = new Set<() => void>();
  private batchCount = 0;

  constructor(initial: ComposerState = createComposerState()) {
    this.state = initial;
  }

  readonly getState = (): ComposerState => this.state;

  /** 状态变更批次计数（同事务提交 = 1 批） */
  get batches(): number {
    return this.batchCount;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch(action: ComposerAction): ComposerReduction {
    const result = reduceComposer(this.state, action);
    if (!result.changed) return result;
    this.state = result.state;
    this.batchCount += 1;
    for (const listener of [...this.listeners]) listener();
    return result;
  }
}
