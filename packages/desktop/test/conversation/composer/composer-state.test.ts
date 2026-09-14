// D-33 / D-34 草稿状态机测试：chip 原子性、同事务乐观提交、pendingSubmissions 保序、失败还原。
import { describe, expect, it, vi } from 'vitest';
import {
  backspace,
  canAutoRestoreDraft,
  clearDraft,
  clearFailedDrafts,
  commitDraft,
  ComposerStore,
  createComposerState,
  createFailedDraftLedger,
  createSubmissionQueue,
  draftText,
  enqueueSubmission,
  FAILED_DRAFT_SEPARATOR,
  insertChip,
  insertText,
  isCaretValid,
  isDraftEmpty,
  isSlashCommand,
  isSubmissionQueueEmpty,
  markRestoreRev,
  mergeFailedDrafts,
  normalizeCaret,
  reduceComposer,
  removeSubmission,
  restoreDraftText,
  serializeDraft,
  setDraftText,
  settleFailedSubmission,
  submissionOrder,
  undo,
  type ComposerChip,
  type FailedDraftRecord,
  type PendingSubmission,
} from '../../../src/renderer/conversation/composer/composer-state.js';
import type { ComposerAttachment } from '../../../src/renderer/conversation/composer/attachments.js';

function chip(id: string, label: string): ComposerChip {
  return { kind: 'chip', id, label, reference: { id: `ref-${id}`, kind: 'file', path: label.replace(/^@/, '') } };
}

function attachment(id: string): ComposerAttachment {
  return { id, kind: 'file', name: `${id}.txt`, mimeType: 'text/plain', bytes: 3, state: 'ready', token: `tok-${id}` };
}

/** 打字辅助：在末尾追加文本 */
function typeInto(state = createComposerState(), text: string) {
  const next = insertText(state, text);
  return next;
}

describe('D-33 草稿模型与 chip 原子性', () => {
  it('文本投影与序列化：chip 以标签参与 rawText，reference 按出现顺序收集', () => {
    let state = createComposerState();
    state = insertText(state, '见 ');
    state = insertChip(state, chip('c1', '@a.ts'));
    state = insertText(state, ' 与 ');
    state = insertChip(state, chip('c2', '@b.ts'));
    expect(draftText(state)).toBe('见 @a.ts 与 @b.ts');
    const serialized = serializeDraft(state);
    expect(serialized.rawText).toBe('见 @a.ts 与 @b.ts');
    expect(serialized.references.map((r) => r.id)).toEqual(['ref-c1', 'ref-c2']);
    expect(isDraftEmpty(state)).toBe(false);
  });

  it('退格紧贴 chip 之后：**整体删除 chip**（绝不删一半）', () => {
    let state = createComposerState();
    state = insertText(state, '见');
    state = insertChip(state, chip('c1', '@a.ts'));
    state = insertText(state, '了');
    // 把光标放回 chip 之后（= 「了」之前的下标 2）
    state = reduceComposer(state, { type: 'set-caret', caret: { node: 2, offset: 0 } }).state;
    expect(state.atoms.map((a) => a.kind)).toEqual(['text', 'chip', 'text']);
    expect(state.caret).toEqual({ node: 2, offset: 0 });
    const after = backspace(state);
    expect(after.atoms.some((a) => a.kind === 'chip')).toBe(false);
    expect(after.atoms.map((a) => (a.kind === 'text' ? a.text : 'CHIP'))).toEqual(['见', '了']);
  });

  it('chip 中间不是合法插入点：插入文本 / 插入 chip 一律拒绝（状态原样返回）', () => {
    const state = createComposerState({
      atoms: [{ kind: 'text', text: 'a' }, chip('c1', '@a.ts')],
      caret: { node: 1, offset: 1 }, // chip 内部位
    });
    expect(isCaretValid(state.atoms, state.caret)).toBe(false);
    const afterText = insertText(state, 'x');
    expect(afterText).toBe(state);
    const afterChip = insertChip(state, chip('c2', '@b.ts'));
    expect(afterChip).toBe(state);
    // 退格也拒绝（不猜半边 chip 的删除）
    expect(backspace(state)).toBe(state);
  });

  it('文本节点中间插入 chip：切成两段夹住它，光标落在 chip 之后', () => {
    const state = createComposerState({ atoms: [{ kind: 'text', text: 'abcdef' }], caret: { node: 0, offset: 3 } });
    const after = insertChip(state, chip('c1', '@a.ts'));
    expect(after.atoms.map((a) => (a.kind === 'text' ? a.text : '@a.ts'))).toEqual(['abc', '@a.ts', 'def']);
    expect(after.caret).toEqual({ node: 2, offset: 0 });
  });

  it('normalizeCaret：chip 内部位夹到 chip 之前（光标注入不破坏原子性）', () => {
    const atoms = [{ kind: 'text', text: 'a' } as const, chip('c1', '@a.ts')];
    expect(normalizeCaret(atoms, { node: 1, offset: 5 })).toEqual({ node: 1, offset: 0 });
    expect(normalizeCaret(atoms, { node: 0, offset: 99 })).toEqual({ node: 0, offset: 1 });
    expect(normalizeCaret(atoms, { node: 9, offset: 0 })).toEqual({ node: 2, offset: 0 });
  });

  it('退格在文本内删一个码点（含 emoji 代理对整体删除）', () => {
    const state = createComposerState({ atoms: [{ kind: 'text', text: 'a😀' }], caret: { node: 0, offset: 3 } });
    const after = backspace(state);
    expect(draftText(after)).toBe('a');
  });

  it('斜杠命令：行首 `/`（D-33 行首样式文本）', () => {
    let state = createComposerState();
    state = insertText(state, '/plan');
    expect(isSlashCommand(state)).toBe(true);
    expect(isSlashCommand(typeInto(createComposerState(), 'hi /plan'))).toBe(false);
  });

  it('撤销 / 重做：提交前的编辑可回退', () => {
    let state = createComposerState();
    state = insertText(state, 'a');
    state = backspace(state);
    expect(draftText(state)).toBe('');
    const restored = undo(state);
    expect(draftText(restored)).toBe('a');
    expect(draftText(clearDraft(restored))).toBe('');
  });

  it('set-text / clear：整体替换与可撤销清空（空改动返回原引用）', () => {
    const state = createComposerState();
    const typed = setDraftText(state, 'abc');
    expect(draftText(typed)).toBe('abc');
    expect(setDraftText(typed, 'abc')).toBe(typed);
    const cleared = clearDraft(typed);
    expect(isDraftEmpty(cleared)).toBe(true);
    expect(clearDraft(cleared)).toBe(cleared);
    expect(undo(cleared).atoms).toEqual(typed.atoms);
  });
});

describe('D-34 乐观提交：同一事务清草稿 + occurrence + 撤销历史', () => {
  const commitOptions = {
    sessionId: 's1',
    intent: 'queue' as const,
    placement: 'transcript' as const,
    clientMessageId: 'cm-1',
  };

  it('commitDraft 一次返回：草稿空 + 历史空 + revision 只 +1，载荷冻结为 detached', () => {
    let state = createComposerState();
    state = insertText(state, '你好');
    state = insertChip(state, chip('c1', '@a.ts'));
    state = insertText(state, '世界');
    const beforeRevision = state.revision;
    const { state: next, submission } = commitDraft(state, commitOptions);
    expect(next.atoms).toHaveLength(0);
    expect(next.history).toHaveLength(0);
    expect(next.redo).toHaveLength(0);
    expect(next.revision).toBe(beforeRevision + 1); // 草稿 + occurrence + 历史 = 同一事务（一次 +1）
    expect(isDraftEmpty(next)).toBe(true);
    expect(submission.rawText).toBe('你好@a.ts世界');
    expect(submission.references.map((r) => r.id)).toEqual(['ref-c1']);
    expect(submission.detached).toBe(true);
    expect(Object.isFrozen(submission)).toBe(true);
  });

  it('ComposerStore.dispatch(submit)：订阅者只收到一次通知（单一批次），历史已清空', () => {
    const store = new ComposerStore();
    store.dispatch({ type: 'insert-text', text: '你好' });
    store.dispatch({ type: 'insert-chip', chip: chip('c1', '@a.ts') });
    store.dispatch({ type: 'insert-text', text: '世界' });
    const batchesBefore = store.batches;
    const revisionBefore = store.getState().revision;
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const result = store.dispatch({ type: 'submit', commit: commitOptions });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.batches).toBe(batchesBefore + 1);
    expect(store.getState().revision).toBe(revisionBefore + 1);
    expect(isDraftEmpty(store.getState())).toBe(true);
    expect(store.getState().history).toHaveLength(0);
    expect(result.submission?.clientMessageId).toBe('cm-1');
    unsubscribe();
  });

  it('提交后撤销不能恢复已发送文本（撤销历史同事务清空）', () => {
    const store = new ComposerStore();
    store.dispatch({ type: 'insert-text', text: '一次性的' });
    store.dispatch({ type: 'submit', commit: commitOptions });
    const result = store.dispatch({ type: 'undo' });
    expect(result.changed).toBe(false);
    expect(isDraftEmpty(store.getState())).toBe(true);
  });

  it('detached：提交后再编辑草稿，载荷 rawText 不变', () => {
    let state = createComposerState();
    state = insertText(state, '原文');
    const { state: next, submission } = commitDraft(state, commitOptions);
    const edited = insertText(next, '后来的输入');
    expect(draftText(edited)).toBe('后来的输入');
    expect(submission.rawText).toBe('原文');
  });

  it('附件按选择顺序进入载荷（D-34 保序）', () => {
    let state = createComposerState();
    state = insertText(state, '带附件');
    const { submission } = commitDraft(state, {
      ...commitOptions,
      attachments: [attachment('a1'), attachment('a2')],
    });
    expect(submission.attachments.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('失败还原：草稿回到提交文本，附件一条不丢（含 failed 态）', () => {
    const failed: ComposerAttachment = {
      id: 'f1',
      kind: 'file',
      name: 'a.bin',
      mimeType: 'application/octet-stream',
      bytes: 9,
      state: 'failed',
      error: '通道断',
    };
    let state = createComposerState();
    state = insertText(state, '重提我');
    const { state: afterCommit, submission } = commitDraft(state, { ...commitOptions, attachments: [failed] });
    const outcome = settleFailedSubmission(afterCommit, createFailedDraftLedger(), {
      seq: 1,
      rawText: submission.rawText,
      attachments: submission.attachments,
    });
    expect(outcome.restored).toBe(true);
    expect(outcome.restoreText).toBe('重提我');
    expect(outcome.attachments.map((a) => a.id)).toEqual(['f1']);
    expect(outcome.attachments[0]?.state).toBe('failed');
    // 还原动作：revision 必 +1（判据锚点靠它），历史清空
    const restored = restoreDraftText(afterCommit, outcome.restoreText ?? '');
    expect(draftText(restored)).toBe('重提我');
    expect(restored.history).toHaveLength(0);
    expect(restored.revision).toBe(afterCommit.revision + 1);
  });
});

// —— P0-2：失败还原不得覆盖用户新输入 / 并发失败按提交顺序合并 ——

describe('P0-2 失败还原（上游 facade.ts:793-868 语义）', () => {
  const record = (seq: number, rawText: string, attachments: ComposerAttachment[] = []): FailedDraftRecord => ({
    seq,
    rawText,
    attachments,
  });
  const fileAttachment = (id: string): ComposerAttachment => ({
    id,
    kind: 'file',
    name: `${id}.bin`,
    mimeType: 'application/octet-stream',
    bytes: 1,
    state: 'failed',
    error: '通道断',
  });

  it('用户已输入新内容（revision 已前进）→ **不覆盖**，失败只进台账（B 不丢）', () => {
    const state = insertText(createComposerState(), 'B'); // 用户在失败前/后输入的内容
    const outcome = settleFailedSubmission(state, createFailedDraftLedger(), record(1, 'A'));
    expect(outcome.restored).toBe(false);
    expect(outcome.restoreText).toBeUndefined();
    expect(draftText(state)).toBe('B'); // 调用方未收到还原指令 → 草稿原样
    expect(outcome.ledger.records.map((r) => r.rawText)).toEqual(['A']);
    // 附件仍然还给用户（上游 restoreAttachments 与草稿覆盖判据无关）
    expect(outcome.attachments).toEqual([]);
  });

  it("草稿为空 → 还原（上游 `clipboardText === ''` 分支）", () => {
    const outcome = settleFailedSubmission(createComposerState(), createFailedDraftLedger(), record(1, 'A'));
    expect(outcome.restored).toBe(true);
    expect(outcome.restoreText).toBe('A');
  });

  it('自上次自动还原以来未编辑（restoreRev === revision）→ 合并还原，不互相覆盖', () => {
    const state = createComposerState();
    const first = settleFailedSubmission(state, createFailedDraftLedger(), record(1, 'A'));
    const afterFirst = restoreDraftText(state, first.restoreText ?? '');
    let ledger = markRestoreRev(first.ledger, afterFirst.revision);
    expect(canAutoRestoreDraft(afterFirst, ledger)).toBe(true); // 用户没编辑 → 判据成立

    const second = settleFailedSubmission(afterFirst, ledger, record(2, 'B'));
    expect(second.restored).toBe(true);
    expect(second.restoreText).toBe(`A${FAILED_DRAFT_SEPARATOR}B`); // 提交顺序合并

    const merged = restoreDraftText(afterFirst, second.restoreText ?? '');
    ledger = markRestoreRev(second.ledger, merged.revision);
    // 用户在合并还原后又输入 → 判据失效（restoreRev !== revision）
    const edited = insertText(merged, '用户新输入');
    expect(canAutoRestoreDraft(edited, ledger)).toBe(false);
  });

  it('用户还原后又编辑 → 后续失败不再覆盖（上游 `failedRestoreRev === rev` 的反例）', () => {
    const state = createComposerState();
    const first = settleFailedSubmission(state, createFailedDraftLedger(), record(1, 'A'));
    const afterFirst = restoreDraftText(state, first.restoreText ?? '');
    const ledger = markRestoreRev(first.ledger, afterFirst.revision);
    const edited = insertText(afterFirst, ' 我插一句');
    const second = settleFailedSubmission(edited, ledger, record(2, 'B'));
    expect(second.restored).toBe(false);
    expect(second.ledger.records.map((r) => r.rawText)).toEqual(['A', 'B']); // 两条都在台账
  });

  it('并发失败乱序落定：合并顺序 = 提交顺序（seq），与落定顺序无关', () => {
    // seq=2 先落定（网络慢的先回），seq=1 后落定
    const later = settleFailedSubmission(createComposerState(), createFailedDraftLedger(), record(2, '第二条'));
    const earlier = settleFailedSubmission(createComposerState(), later.ledger, record(1, '第一条'));
    expect(later.restoreText).toBe('第二条');
    expect(earlier.restoreText).toBe(`第一条${FAILED_DRAFT_SEPARATOR}第二条`);
  });

  it('附件按提交顺序合并、去重、不丢（同一附件在多条失败里只还原一次）', () => {
    const merged = mergeFailedDrafts([
      record(2, 'B', [fileAttachment('f2'), fileAttachment('f1')]),
      record(1, 'A', [fileAttachment('f1')]),
    ]);
    expect(merged.rawText).toBe(`A${FAILED_DRAFT_SEPARATOR}B`);
    expect(merged.attachments.map((a) => a.id)).toEqual(['f1', 'f2']); // 提交顺序 + 去重
  });

  it('提交边界：上次还原未被编辑 → 清台账（上游 facade.ts:731-734，防重提内容重复合并）', () => {
    const state = createComposerState();
    const first = settleFailedSubmission(state, createFailedDraftLedger(), record(1, 'A'));
    const afterFirst = restoreDraftText(state, first.restoreText ?? '');
    const ledger = markRestoreRev(first.ledger, afterFirst.revision);
    // 还原后用户没编辑 → 提交边界清台账（这次提交的文本里已含还原内容）
    expect(clearFailedDrafts(ledger, afterFirst).records).toEqual([]);

    // 用户编辑过（revision 前进）→ 提交边界不清（否则会丢掉还没还原的失败内容）
    const edited = insertText(afterFirst, 'x');
    expect(clearFailedDrafts(ledger, edited)).toBe(ledger);
    expect(clearFailedDrafts(ledger, edited).records.map((r) => r.rawText)).toEqual(['A']);
  });
});

describe('pendingSubmissions 保序（FIFO 纯 reducer）', () => {
  const submission = (id: string): PendingSubmission =>
    Object.freeze({
      clientMessageId: id,
      sessionId: 's1',
      rawText: id,
      intent: 'queue' as const,
      placement: 'transcript' as const,
      references: Object.freeze([]),
      attachments: Object.freeze([]),
      detached: true as const,
      ts: 0,
    });

  it('追加顺序 = 提交顺序（与并发落定无关）', () => {
    let queue = createSubmissionQueue();
    queue = enqueueSubmission(queue, submission('cm-a'));
    queue = enqueueSubmission(queue, submission('cm-b'));
    queue = enqueueSubmission(queue, submission('cm-c'));
    expect(submissionOrder(queue)).toEqual(['cm-a', 'cm-b', 'cm-c']);
  });

  it('按 id 移除后其余保序；缺 id 返回原引用', () => {
    let queue = createSubmissionQueue();
    queue = enqueueSubmission(queue, submission('cm-a'));
    queue = enqueueSubmission(queue, submission('cm-b'));
    queue = enqueueSubmission(queue, submission('cm-c'));
    const { queue: after, removed } = removeSubmission(queue, 'cm-b');
    expect(removed?.clientMessageId).toBe('cm-b');
    expect(submissionOrder(after)).toEqual(['cm-a', 'cm-c']);
    const missing = removeSubmission(after, 'nope');
    expect(missing.queue).toBe(after);
    expect(missing.removed).toBeUndefined();
    expect(isSubmissionQueueEmpty(createSubmissionQueue())).toBe(true);
  });

  it('reduceComposer 的 submit 动作同时带出新状态与载荷（单次派发入口）', () => {
    const state = insertText(createComposerState(), 'x');
    const result = reduceComposer(state, {
      type: 'submit',
      commit: { sessionId: 's1', intent: 'steer', placement: 'pending-steering', clientMessageId: 'cm-x' },
    });
    expect(result.changed).toBe(true);
    expect(result.submission?.intent).toBe('steer');
    expect(result.submission?.placement).toBe('pending-steering');
    expect(result.state.atoms).toHaveLength(0);
  });
});
