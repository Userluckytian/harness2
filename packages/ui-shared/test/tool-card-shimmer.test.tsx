// Z-97（T4c）工具行运行态「去旋转 spinner → 文案扫光」的 DOM 类名断言。
//   jsdom 测不了真实动画（keyframes/background-position），断言口径 = 类名与结构：
//   running 态：无 .animate-spin（全行任何位置）+ 标题行挂 .tool-running-shimmer + 图标静态；
//   completed 态：扫光类摘除、状态转 text-success；rerender 边沿（running→completed）同样收敛。
//   规格出处：docs/refs/refs-zcode.md Z-97（ZCode ToolLayout.tsx:138-147 原注即规格）。
//   样式声明侧的权威证据在 tool-running-shimmer-css.test.ts（node 环境读 CSS 文本）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { ToolCard, resetToolOpenMemoryForTests } from '../src/renderer/tool/ToolCard.js';

afterEach(() => {
  cleanup();
  // 展开态记忆是模块级内存（Z-93），跨用例共享 —— 清空保证确定性初态
  resetToolOpenMemoryForTests();
});

describe('Z-97（T4c）ToolCard 运行态扫光（不用旋转 spinner）', () => {
  it('running：全卡无 .animate-spin，标题行挂 .tool-running-shimmer，图标保持静态', () => {
    const { container } = render(<ToolCard card={{ tool: 'bash', args: { command: 'ls' }, callId: 'c1' }} />);
    expect(container.querySelector('[data-tool-status="running"]')).not.toBeNull();
    // Z-97 核心断言：运行态工具行不出现任何旋转 spinner
    expect(container.querySelector('.animate-spin')).toBeNull();
    // 标题行（> bash (ls)）挂扫光类（动画只动 background-position，见 styles.css）
    const title = screen.getByTestId('tool-title-line');
    expect(title.classList.contains('tool-running-shimmer')).toBe(true);
    expect(title.textContent).toContain('> bash');
    // 图标（ToolGlyph 的 lucide svg）仍在且不带任何动画类 —— 刻意保持静态
    const glyph = container.querySelector('.tool-row > svg');
    expect(glyph).not.toBeNull();
    expect(glyph?.classList.contains('animate-spin')).toBe(false);
    // 状态文字仍在（Z-97「运行态由文案扫光和状态文字表达」）
    expect(screen.getByTestId('tool-status-label').textContent).toBe('运行中…');
  });

  it('completed：标题行无扫光类、状态 text-success，且无 .animate-spin（恢复静态）', () => {
    const { container } = render(
      <ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true }, callId: 'c1' }} />,
    );
    expect(screen.getByTestId('tool-title-line').classList.contains('tool-running-shimmer')).toBe(false);
    expect(container.querySelector('.text-success')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('failed：状态节点为失败文案（虚线下划线 tooltip 路径），同样无 spinner、无扫光', () => {
    const { container } = render(
      <ToolCard
        card={{ tool: 'bash', args: { command: 'ls' }, result: { ok: false, error: 'exit 1' }, callId: 'c1' }}
      />,
    );
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByTestId('tool-title-line').classList.contains('tool-running-shimmer')).toBe(false);
    expect(screen.getByTestId('tool-error')).not.toBeNull();
  });

  it('running→completed 边沿（rerender）：扫光类消失、状态转 text-success、无 spinner', () => {
    const { container, rerender } = render(<ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, callId: 'c1' }} />);
    expect(screen.getByTestId('tool-title-line').classList.contains('tool-running-shimmer')).toBe(true);
    rerender(<ToolCard card={{ tool: 'read', args: { path: 'a.ts' }, result: { ok: true }, callId: 'c1' }} />);
    expect(screen.getByTestId('tool-title-line').classList.contains('tool-running-shimmer')).toBe(false);
    expect(container.querySelector('.text-success')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
