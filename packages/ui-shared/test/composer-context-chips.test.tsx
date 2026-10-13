// Z10-2 composer 上方「项目」「Git 分支」上下文 chip（ui-shared 组件级）。
// 覆盖：缺省不渲染 / 两项渲染与顺序 / 只读态（disabled + title + data-placeholder）/ 真动作可点，
// 以及纯函数 projectNameFromCwd / branchShortName / buildContextChips 的口径。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/renderer/conversation/composer/Composer.js';
import type { ComposerContextChipsProps } from '../src/renderer/conversation/composer/Composer.js';
import {
  branchShortName,
  buildContextChips,
  CONTEXT_CHIP_BRANCH_READONLY_HINT,
  CONTEXT_CHIP_PROJECT_READONLY_HINT,
  projectNameFromCwd,
} from '../src/renderer/conversation/composer/context-chips.js';
import { ComposerStore, createComposerState } from '../src/renderer/conversation/composer/composer-state.js';

afterEach(cleanup);

const io = {
  createClientMessageId: () => 'cm-test',
  submit: () => undefined,
};

function renderComposer(contextChips?: ComposerContextChipsProps): void {
  render(
    <Composer
      sessionId="s1"
      store={new ComposerStore(createComposerState())}
      io={io}
      {...(contextChips !== undefined ? { contextChips } : {})}
    />,
  );
}

describe('contextChips 缺省不渲染（红线⑩：不摆空 chip / 假 chip）', () => {
  it('未注入 contextChips → 整行与两 chip 都不渲染；既有按钮不受影响', () => {
    renderComposer();
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();
    expect(screen.queryByTestId('composer-context-chip-project')).toBeNull();
    expect(screen.queryByTestId('composer-context-chip-branch')).toBeNull();
    expect(screen.getByTestId('composer-editor')).toBeTruthy();
    expect(screen.getByTestId('composer-primary')).toBeTruthy();
  });

  it('空对象 / 两项都缺 → 整行不渲染（不摆空行）', () => {
    renderComposer({});
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();
    cleanup();
    renderComposer({ project: undefined, branch: undefined });
    expect(screen.queryByTestId('composer-context-chips')).toBeNull();
  });
});

describe('两 chip 渲染（只读态：本仓无切换通道）', () => {
  it('项目 + 分支都渲染，顺序为 项目 → 分支；只读 = disabled + title + data-placeholder', () => {
    renderComposer({
      project: { label: 'harness2', disabledHint: CONTEXT_CHIP_PROJECT_READONLY_HINT },
      branch: { label: 'main', disabledHint: CONTEXT_CHIP_BRANCH_READONLY_HINT },
    });
    const row = screen.getByTestId('composer-context-chips');
    expect(row).toBeTruthy();
    const project = screen.getByTestId('composer-context-chip-project') as HTMLButtonElement;
    const branch = screen.getByTestId('composer-context-chip-branch') as HTMLButtonElement;
    expect(project.textContent).toBe('harness2');
    expect(branch.textContent).toBe('main');
    // 顺序：项目在分支之前
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'composer-context-chip-project',
      'composer-context-chip-branch',
    ]);
    // 只读态：不可点 + title 说明 + data-placeholder 可辨
    expect(project.disabled).toBe(true);
    expect(branch.disabled).toBe(true);
    expect(project.getAttribute('title')).toBe(CONTEXT_CHIP_PROJECT_READONLY_HINT);
    expect(branch.getAttribute('title')).toBe(CONTEXT_CHIP_BRANCH_READONLY_HINT);
    expect(project.getAttribute('data-placeholder')).toBe('true');
    expect(branch.getAttribute('data-placeholder')).toBe('true');
  });

  it('缺省 disabledHint → title 回落非空缺省文案（绝不空 title）', () => {
    renderComposer({ project: { label: 'p' } });
    const project = screen.getByTestId('composer-context-chip-project') as HTMLButtonElement;
    expect(project.disabled).toBe(true);
    expect(project.getAttribute('title')).toBeTruthy();
  });

  it('只给分支 → 只渲染分支 chip（缺项不出项，不摆空 chip）', () => {
    renderComposer({ branch: { label: 'main' } });
    expect(screen.queryByTestId('composer-context-chip-project')).toBeNull();
    expect(screen.getByTestId('composer-context-chip-branch').textContent).toBe('main');
  });

  it('chip 行位于编辑器之上（DOM 顺序先于 composer-editor-wrap）', () => {
    renderComposer({ project: { label: 'p' } });
    const composer = screen.getByTestId('composer-default').querySelector('.composer')!;
    const row = screen.getByTestId('composer-context-chips');
    const wrap = composer.querySelector('.composer-editor-wrap')!;
    // Node.DOCUMENT_POSITION_FOLLOWING = 4：wrap 在 row 之后
    expect(row.compareDocumentPosition(wrap) & 4).toBe(4);
  });

  it('提供 onPick = 真动作：chip 可点且点击触发回调（title = label，无 data-placeholder）', () => {
    const onPick = vi.fn();
    renderComposer({ branch: { label: 'main', onPick } });
    const branch = screen.getByTestId('composer-context-chip-branch') as HTMLButtonElement;
    expect(branch.disabled).toBe(false);
    expect(branch.getAttribute('data-placeholder')).toBeNull();
    fireEvent.click(branch);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe('纯函数口径', () => {
  it('projectNameFromCwd：识别正反斜杠、忽略尾部斜杠、空/无末段 → undefined', () => {
    expect(projectNameFromCwd('D:/AI_Projects/harness2')).toBe('harness2');
    expect(projectNameFromCwd('D:\\AI_Projects\\harness2')).toBe('harness2');
    expect(projectNameFromCwd('D:/AI_Projects/harness2/')).toBe('harness2');
    expect(projectNameFromCwd('server')).toBe('server');
    expect(projectNameFromCwd(undefined)).toBeUndefined();
    expect(projectNameFromCwd('')).toBeUndefined();
    expect(projectNameFromCwd('/')).toBeUndefined();
  });

  it('branchShortName：去 heads/ 前缀（与桌面会话头同口径）', () => {
    expect(branchShortName('main')).toBe('main');
    expect(branchShortName('heads/feat/x')).toBe('feat/x');
  });

  it('buildContextChips：项目名 + 分支名；branch 缺省 → 无分支 chip（web 无通道口径）', () => {
    expect(buildContextChips('D:/x/harness2', 'main')).toEqual({
      project: { label: 'harness2', disabledHint: CONTEXT_CHIP_PROJECT_READONLY_HINT },
      branch: { label: 'main', disabledHint: CONTEXT_CHIP_BRANCH_READONLY_HINT },
    });
    // web：branch 传 undefined → 只有项目 chip
    expect(buildContextChips('D:/x/harness2', undefined)).toEqual({
      project: { label: 'harness2', disabledHint: CONTEXT_CHIP_PROJECT_READONLY_HINT },
    });
    // 空分支名 = 无分支
    expect(buildContextChips('D:/x/harness2', '')?.branch).toBeUndefined();
    // 两者都无 → undefined（整行不渲染）
    expect(buildContextChips(undefined, undefined)).toBeUndefined();
  });

  it('buildContextChips：注入 onPick 时该项为真动作（不再 disabled 语义）', () => {
    const onPick = vi.fn();
    const chips = buildContextChips('D:/x/harness2', 'heads/feat/x', { projectOnPick: onPick });
    expect(chips?.project?.onPick).toBe(onPick);
    expect(chips?.branch?.label).toBe('feat/x');
    expect(chips?.branch?.onPick).toBeUndefined();
  });
});
