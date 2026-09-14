// 右栏文件预览测试（P6-C / D-86 ①的消费端）：按路径读文本并如实显示；
// 越界/截断/失败都显式可见（不假装成功）；无待预览时给明确空态。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ToolFilePreviewPanel } from '@harness2/ui-shared/renderer/tool/index.js';
import type { ToolFilePreview } from '@harness2/ui-shared/renderer/tool/index.js';

afterEach(cleanup);

function preview(over: Partial<ToolFilePreview> = {}): ToolFilePreview {
  return { path: 'src/a.ts', openedAt: 1, ...over };
}

describe('右栏文件预览（openFile 的消费端）', () => {
  it('无待打开文件 → 明确空态（不摆假内容）', () => {
    const { container } = render(<ToolFilePreviewPanel preview={null} />);
    expect(container.querySelector('[data-file-preview="empty"]')).not.toBeNull();
    expect(screen.getByText(/尚未打开文件/)).toBeTruthy();
  });

  it('按路径读文本并渲染（含行号）；读取通道用注入实现', async () => {
    const readFile = vi.fn(async () => ({ ok: true, content: 'line1\nline2' }));
    const { container } = render(<ToolFilePreviewPanel preview={preview()} cwd="D:/proj" readFile={readFile} />);
    await waitFor(() => expect(container.querySelector('.file-preview-body')).not.toBeNull());
    expect(readFile).toHaveBeenCalledWith('src/a.ts', 'D:/proj');
    expect(screen.getByText('line1')).toBeTruthy();
    expect(container.querySelectorAll('[data-line]').length).toBe(2);
    expect(container.querySelector('[data-file-path="src/a.ts"]')).not.toBeNull();
  });

  it('line 锚点：命中行高亮（D-76 的 { line } 1 起算口径）', async () => {
    const readFile = vi.fn(async () => ({ ok: true, content: 'a\nb\nc' }));
    const { container } = render(<ToolFilePreviewPanel preview={preview({ line: 2 })} readFile={readFile} />);
    await waitFor(() => expect(container.querySelector('.file-preview-row-hit')).not.toBeNull());
    expect(container.querySelector('.file-preview-row-hit')?.getAttribute('data-line')).toBe('2');
    expect(screen.getByText('第 2 行')).toBeTruthy();
  });

  it('截断如实标注（64KB 上限）；读取失败如实显示原因', async () => {
    const readFile = vi.fn(async () => ({ ok: true, content: 'x', truncated: true }));
    const { container, rerender } = render(<ToolFilePreviewPanel preview={preview()} readFile={readFile} />);
    await waitFor(() => expect(screen.getByText(/已截断（64KB 上限）/)).toBeTruthy());

    const failing = vi.fn(async () => ({ ok: false, error: '路径超出当前工作目录' }));
    rerender(<ToolFilePreviewPanel preview={preview({ path: '../outside.ts' })} readFile={failing} />);
    expect(await screen.findByText('路径超出当前工作目录')).toBeTruthy();
    expect(container.querySelector('.file-preview-body')).toBeNull();
  });

  it('切换路径重读（旧内容不残留）；清空入口回调宿主', async () => {
    const readFile = vi.fn(async (p: string) => ({ ok: true, content: `内容:${p}` }));
    const onClear = vi.fn();
    const { container, rerender } = render(
      <ToolFilePreviewPanel preview={preview({ path: 'a.ts' })} readFile={readFile} onClear={onClear} />,
    );
    await waitFor(() => expect(screen.getByText('内容:a.ts')).toBeTruthy());
    rerender(<ToolFilePreviewPanel preview={preview({ path: 'b.ts' })} readFile={readFile} onClear={onClear} />);
    await waitFor(() => expect(screen.getByText('内容:b.ts')).toBeTruthy());
    expect(screen.queryByText('内容:a.ts')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-file-preview="open"]')).not.toBeNull();
  });
});
