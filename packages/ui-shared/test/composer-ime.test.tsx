// @vitest-environment jsdom
// composer IME（中文组合输入）回归：草稿只接**落定帧**，组合中途的半截文本一律不回写。
//
// 缺陷（真机复现：落盘证据 = 目标串 + 递减前缀链）：`onInput` 兜底 `textContent → set-text`
// 不看 `isComposing` → 组合中途浏览器绘制的半截文本被写进 atoms；`onBeforeInput` 不拦
// `insertFromComposition` → 状态被污染后落定文本再叠一层。
//
// jsdom 口径（本包探针实测）：`el.dispatchEvent(new InputEvent('beforeinput', …))` **不会**触发
// React 合成 `onBeforeInput`，故 beforeinput 分支不在本文件花预算；`fireEvent.input` 能触发
// `onInput`，且 `InputEvent` 的 `inputType / isComposing / data` 正常透传 —— 组合期不回写、
// 落定帧经兜底接住，这两条正是缺陷的判据面，够覆盖真机语义。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/renderer/conversation/composer/Composer.js';
import type { ComposerIO } from '../src/renderer/conversation/composer/Composer.js';
import { ComposerStore, createComposerState, draftText } from '../src/renderer/conversation/composer/composer-state.js';

afterEach(cleanup);

const io: ComposerIO = {
  createClientMessageId: () => 'cm-ime',
  submit: () => undefined,
};

/** 空草稿挂载，交回渲染所使用的那个 store（草稿状态唯一真源，避免断言与实例错位） */
function mount(): ComposerStore {
  const store = new ComposerStore(createComposerState());
  render(<Composer sessionId="s1" store={store} io={io} />);
  return store;
}

/** 以既有 store 实例挂载（预置草稿 / chip 用），组件内 dispatch 与测试断言指向同一实例 */
function mountWith(store: ComposerStore): ComposerStore {
  render(<Composer sessionId="s1" store={store} io={io} />);
  return store;
}

function seeded(atomsText: string): ComposerStore {
  const store = new ComposerStore(createComposerState());
  if (atomsText.length > 0) store.dispatch({ type: 'set-text', text: atomsText });
  return store;
}

function editor(): HTMLDivElement {
  return screen.getByTestId('composer-editor') as HTMLDivElement;
}

/** 浏览器组合中途：半截文本由浏览器绘制进 DOM，此刻的 input 事件 isComposing:true */
function composingFrame(el: HTMLDivElement, partial: string): void {
  el.textContent = partial;
  fireEvent.input(el, { inputType: 'insertCompositionText', isComposing: true, data: partial });
}

/** 落定帧（compositionend 后 Chromium 的一次 input，isComposing:false，textContent 为最终文本） */
function settleFrame(el: HTMLDivElement, final: string): void {
  el.textContent = final;
  fireEvent.input(el, { inputType: 'insertFromComposition', isComposing: false, data: final });
}

describe('IME 组合期不回写草稿（核心红→绿）', () => {
  it('空草稿 + 组合中途半截文本 → atoms 保持为空（现状会把「请」写进草稿）', () => {
    const store = mount();
    const el = editor();
    const revision = store.getState().revision;

    el.textContent = '请';
    fireEvent.input(el, { inputType: 'insertCompositionText', isComposing: true, data: '请' });

    expect(draftText(store.getState())).not.toContain('请');
    expect(draftText(store.getState())).toBe('');
    expect(store.getState().revision).toBe(revision); // 连一次通知都不该发出
  });

  it('isComposing:true 但 inputType 缺省（旧宿主不透传 inputType）→ 同样不回写', () => {
    const store = mount();
    const el = editor();

    el.textContent = '请介';
    fireEvent.input(el, { isComposing: true, data: '请介' });

    expect(draftText(store.getState())).toBe('');
  });

  it('已有草稿时组合中途不覆盖用户已输入内容（现状 set-text 直接吞掉）', () => {
    const store = mountWith(seeded('你好'));
    expect(draftText(store.getState())).toBe('你好');

    const el = editor();
    composingFrame(el, '你好请');
    composingFrame(el, '你好请介');

    expect(draftText(store.getState())).toBe('你好');
  });

  it('组合中途不产生撤销噪声（history 长度不变，undo 不会退到半截文本）', () => {
    const store = mount();
    const el = editor();
    const history = store.getState().history.length;

    composingFrame(el, '请');
    composingFrame(el, '请介');
    composingFrame(el, '请介绍');

    expect(store.getState().history.length).toBe(history);
  });

  it('deleteCompositionText（组合中退格）同样不回写', () => {
    const store = mountWith(seeded('请介绍'));

    const el = editor();
    el.textContent = '请介';
    fireEvent.input(el, { inputType: 'deleteCompositionText', isComposing: true });

    expect(draftText(store.getState())).toBe('请介绍');
  });
});

describe('IME 落定帧接住（一次，不多不少）', () => {
  it('落定 input(insertFromComposition) → 草稿 = 最终文本，恰好一次', () => {
    const store = mount();
    const el = editor();

    settleFrame(el, '请介绍');

    expect(draftText(store.getState())).toBe('请介绍');
    expect(store.getState().atoms).toEqual([{ kind: 'text', text: '请介绍' }]);
  });

  it('组合 → 落定全序列：草稿 = 最终串一次，无重复前缀链', () => {
    const store = mount();
    const el = editor();

    composingFrame(el, '请');
    composingFrame(el, '请介');
    composingFrame(el, '请介绍');
    settleFrame(el, '请介绍');

    const text = draftText(store.getState());
    expect(text).toBe('请介绍');
    // 累积重复的指纹：目标串里再嵌一层递减前缀（真机落盘证据的形态）
    expect(text).not.toContain('请请');
    expect(text).not.toContain('请介绍请介');
    expect(text).not.toContain('请介绍请介绍');
  });

  it('已有草稿 + 组合 → 落定：落定文本 = DOM 全文一次（旧内容不被吞、不重复）', () => {
    const store = mountWith(seeded('你好'));
    const el = editor();

    composingFrame(el, '你好请');
    composingFrame(el, '你好请介绍');
    settleFrame(el, '你好请介绍');

    expect(draftText(store.getState())).toBe('你好请介绍');
  });
});

describe('回归护栏（既有 DOM 兜底与 chip 原子性不劣化）', () => {
  it('普通输入（无 inputType、isComposing 缺省 false）仍走 set-text 兜底', () => {
    const store = mount();
    const el = editor();

    el.textContent = 'x';
    fireEvent.input(el, { data: 'x' });

    expect(draftText(store.getState())).toBe('x');
  });

  it('有 chip 时不从 DOM 文本回写（既有行为）', () => {
    const store = new ComposerStore(createComposerState());
    store.dispatch({
      type: 'insert-chip',
      chip: {
        kind: 'chip',
        id: 'c1',
        label: '@src/a.ts',
        reference: { id: 'r1', kind: 'file', path: 'src/a.ts' },
      },
    });
    mountWith(store);
    const before = store.getState().atoms.length;

    const el = editor();
    el.textContent = '@src/a.ts手敲';
    fireEvent.input(el, { data: '手敲' });

    expect(store.getState().atoms.length).toBe(before); // 原子数不变（未整体回写覆盖 chip）
    expect(draftText(store.getState())).toBe('@src/a.ts');
  });

  it('组合期不影响既有撤销链：落定后 undo 退回落定前状态', () => {
    const store = mountWith(seeded('你好'));
    const el = editor();

    composingFrame(el, '你好请');
    settleFrame(el, '你好请介绍');
    expect(draftText(store.getState())).toBe('你好请介绍');

    store.dispatch({ type: 'undo' });
    expect(draftText(store.getState())).toBe('你好');
  });
});
