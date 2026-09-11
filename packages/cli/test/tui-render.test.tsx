// TUI 渲染单测（ink renderToString，无 TTY）：DiffCard 红绿变更 + ReasoningBlock 折叠/展开标题。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'ink';
import { DiffCard } from '../src/tui/DiffCard.js';
import { ReasoningBlock } from '../src/tui/ReasoningBlock.js';

describe('DiffCard（diff 行级红绿变更）', () => {
  it('edit 变更：删行带 -、增行带 +、未变行显灰色', () => {
    const out = renderToString(
      <DiffCard title="edit 变更" before={'第一行\n旧内容\n第三行'} after={'第一行\n新内容\n第三行'} maxLines={20} />,
    );
    expect(out).toContain('edit 变更');
    expect(out).toContain('- 旧内容');
    expect(out).toContain('+ 新内容');
    expect(out).toContain('第一行');
    expect(out).toContain('第三行');
  });

  it('write 内容（before 为空）：全部为新增行', () => {
    const out = renderToString(<DiffCard title="write 内容" before="" after={'行一\n行二'} maxLines={20} />);
    expect(out).toContain('write 内容');
    expect(out).toContain('+ 行一');
    expect(out).toContain('+ 行二');
  });

  it('超出默认最大行数：显示省略提示', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i}`);
    const out = renderToString(<DiffCard title="大文件" before="" after={lines.join('\n')} />);
    expect(out).toContain('… 还有 5 行');
  });
});

describe('ReasoningBlock（当前 turn 推理折叠块）', () => {
  it('折叠态：单行灰色标题 + 前 72 字符预览', () => {
    const long = '推理内容 '.repeat(30);
    const out = renderToString(<ReasoningBlock text={long} expanded={false} />);
    expect(out).toContain('[reasoning · 按 Ctrl+R 展开]');
    expect(out).not.toContain(
      '推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容 推理内容',
    ); // 完整长文本不出现在折叠行
  });

  it('展开态：完整推理文本可见', () => {
    const out = renderToString(<ReasoningBlock text={'先想想\n再动手'} expanded />);
    expect(out).toContain('先想想');
    expect(out).toContain('再动手');
    expect(out).not.toContain('[reasoning · 按 Ctrl+R 展开]');
  });

  it('空文本：不渲染', () => {
    expect(renderToString(<ReasoningBlock text={'  '} expanded={false} />)).toBe('');
  });
});
