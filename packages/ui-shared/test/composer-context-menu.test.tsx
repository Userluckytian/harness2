// composer-context-menu 语义（P0 添加上下文）：按钮 aria-label（ZCode 逐字「添加上下文」）；
// 菜单打开显示组标题与三项；附件/目标无通道时 disabled + data-placeholder + title；
// 文件清单（真数据源）列出并可选中把路径交回；web 无数据源的如实降级。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/renderer/conversation/composer/Composer.js';
import {
  ComposerContextMenu,
  type ContextListResult,
} from '../src/renderer/conversation/composer/composer-context-menu.js';
import { ComposerStore, createComposerState } from '../src/renderer/conversation/composer/composer-state.js';

afterEach(cleanup);

const io = {
  createClientMessageId: () => 'cm-test',
  submit: () => undefined,
};

function renderComposer(listDir?: (p: string) => Promise<ContextListResult>): void {
  render(
    <Composer
      sessionId="s1"
      store={new ComposerStore(createComposerState())}
      io={io}
      {...(listDir !== undefined ? { contextPicker: { listDir } } : {})}
    />,
  );
}

function openMenu(): void {
  // Radix DropdownMenu trigger：Enter 打开（jsdom 无指针事件依赖）
  fireEvent.keyDown(screen.getByTestId('composer-context-trigger'), { key: 'Enter' });
}

const ROOT: ContextListResult = {
  ok: true,
  path: '',
  entries: [
    { name: 'src', kind: 'dir' },
    { name: '.gitattributes', kind: 'file' },
    { name: 'README.md', kind: 'file' },
  ],
  truncated: false,
};

describe('按钮（ZCode：composer 底部行最左，aria-label 逐字）', () => {
  it('无数据源（web）也渲染 28×28 图标钮，aria-label = 添加上下文', () => {
    renderComposer();
    const trigger = screen.getByTestId('composer-context-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('添加上下文');
    // 最左：位于 composer-actions-left 的第一个子元素
    expect(screen.getByTestId('composer-reference').closest('.composer-actions-left')?.firstElementChild).toBe(trigger);
  });
});

describe('菜单结构（组标题 + 三项）', () => {
  it('打开后显示「添加上下文」标题、附件、目标、文件清单', () => {
    renderComposer();
    openMenu();
    expect(screen.getByTestId('composer-context-title').textContent).toBe('添加上下文');
    expect(screen.getByTestId('composer-context-attach')).toBeTruthy();
    expect(screen.getByTestId('composer-context-goal')).toBeTruthy();
    expect(screen.getByTestId('composer-context-files-unavailable')).toBeTruthy();
  });

  it('目标无通道：disabled + data-placeholder + title「目标通道未接入」', () => {
    renderComposer();
    openMenu();
    const goal = screen.getByTestId('composer-context-goal');
    expect(goal.getAttribute('data-disabled')).not.toBeNull();
    expect(goal.getAttribute('data-placeholder')).toBe('');
    expect(goal.getAttribute('title')).toBe('目标通道未接入');
  });

  it('附件在 Composer 内接真（既有 File 入口）：不 disabled、无 placeholder', () => {
    renderComposer();
    openMenu();
    const attach = screen.getByTestId('composer-context-attach');
    expect(attach.getAttribute('data-disabled')).toBeNull();
    expect(attach.getAttribute('data-placeholder')).toBeNull();
  });
});

describe('附件/目标无通道时 disabled + data-placeholder（独立组件口径）', () => {
  it('两者都不传通道 → 都 disabled 且带占位标记与 title', () => {
    render(<ComposerContextMenu onInsertPath={vi.fn()} />);
    openMenu();
    const attach = screen.getByTestId('composer-context-attach');
    const goal = screen.getByTestId('composer-context-goal');
    expect(attach.getAttribute('data-disabled')).not.toBeNull();
    expect(attach.getAttribute('data-placeholder')).toBe('');
    expect(attach.getAttribute('title')).toBe('附件通道未接入');
    expect(goal.getAttribute('data-disabled')).not.toBeNull();
    expect(goal.getAttribute('data-placeholder')).toBe('');
  });
});

describe('文件清单（真通道：listDir 数据源）', () => {
  it('列出目录/文件；选中文件把 @ 相对路径交回 composer 草稿', async () => {
    const listDir = vi.fn(async () => ROOT);
    renderComposer(listDir);
    openMenu();
    const entries = await screen.findAllByTestId('composer-context-entry');
    expect(entries.map((e) => e.getAttribute('data-path'))).toEqual(['src', '.gitattributes', 'README.md']);
    expect(listDir).toHaveBeenCalledWith('');

    fireEvent.click(screen.getByText('README.md'));
    const editor = screen.getByTestId('composer-editor');
    expect(editor.textContent).toContain('@README.md');
  });

  it('输入过滤按名称收敛；点击目录进入子目录（带 `/` 前缀再列举）', async () => {
    const listDir = vi.fn(async (p: string) =>
      p === ''
        ? ROOT
        : ({
            ok: true,
            path: p,
            entries: [{ name: 'a.ts', kind: 'file' }],
            truncated: false,
          } satisfies ContextListResult),
    );
    renderComposer(listDir);
    openMenu();
    await screen.findAllByTestId('composer-context-entry');

    fireEvent.change(screen.getByTestId('composer-context-search'), { target: { value: 'readme' } });
    const filtered = screen.getAllByTestId('composer-context-entry');
    expect(filtered.map((e) => e.getAttribute('data-path'))).toEqual(['README.md']);

    fireEvent.change(screen.getByTestId('composer-context-search'), { target: { value: '' } });
    fireEvent.click(screen.getByText('src'));
    const child = await screen.findByText('a.ts');
    expect(child.closest('[data-testid="composer-context-entry"]')?.getAttribute('data-path')).toBe('src/a.ts');
    expect(listDir).toHaveBeenCalledWith('src/');
  });

  it('目录读取失败 → 如实显示「无法读取目录」，不摆假数据', async () => {
    renderComposer(async () => ({ ok: false, error: '工作区根不存在' }));
    openMenu();
    const err = await screen.findByTestId('composer-context-error');
    expect(err.textContent).toContain('无法读取目录');
    expect(err.textContent).toContain('工作区根不存在');
    expect(screen.queryByTestId('composer-context-entry')).toBeNull();
  });

  it('独立组件：选中回调收到相对路径', async () => {
    const onInsertPath = vi.fn();
    render(<ComposerContextMenu onInsertPath={onInsertPath} listDir={async () => ROOT} />);
    openMenu();
    await screen.findAllByTestId('composer-context-entry');
    fireEvent.click(screen.getByText('.gitattributes'));
    expect(onInsertPath).toHaveBeenCalledWith('.gitattributes');
  });
});

describe('web 无目录通道（如实降级）', () => {
  it('不传 listDir → 显示「web 无目录通道」，无文件区、无假文件树', () => {
    render(<ComposerContextMenu onInsertPath={vi.fn()} />);
    openMenu();
    expect(screen.getByTestId('composer-context-files-unavailable').textContent).toBe('web 无目录通道');
    expect(screen.queryByTestId('composer-context-files')).toBeNull();
    expect(screen.queryByTestId('composer-context-entry')).toBeNull();
  });
});
