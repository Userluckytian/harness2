// @vitest-environment jsdom
// U2 批E（E-d）：MarkdownBlock 渲染契约测试（ZCode 基线四要点各钉一条）。
//
// 覆盖：
//   ① 粗体/行内代码 → 真 `<strong>`（streamdown 默认是 span，components 覆盖归正语义）
//      + `code.md-inline-code`（= 规格 rounded bg-muted px-1 font-mono，皮在 shell.css）；
//   ② GFM 表格 → `<table>`/`<th>`/`<td>`；
//   ③ ErrorBoundary 降级：streamdown 渲染抛错 → 纯文本 `<pre class=md-raw>`（原文不吞）；
//   ④ 流式未闭合 `**bold` → 不崩（parseIncompleteMarkdown 补全路径），无降级 pre；
//   ⑤（追加）围栏代码块 → 走 harness2 CodeViewer（[data-code-viewer-body]），
//      不吃 streamdown 内置 shiki renderer（E-a 规格第 4 条）；
//   ⑥（追加）toCodeLanguage 纯函数：别名/大小写/白名单/未知语言。
//
// streamdown 经 vi.mock 包一层「可开关抛错」的同名转发（memo 组件不可直调，走 createElement），
// 其余渲染路径保持真实（不 mock 解析器本身 —— 测的就是真实渲染契约）。
import { createElement, type ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MarkdownBlock, toCodeLanguage } from '../src/renderer/components/MarkdownBlock.js';

const boom = vi.hoisted(() => ({ on: false }));

vi.mock('streamdown', async (importOriginal) => {
  const orig = (await importOriginal()) as { Streamdown: ComponentType<Record<string, unknown>> };
  return {
    ...(orig as object),
    Streamdown: (props: Record<string, unknown>) => {
      if (boom.on) throw new Error('markdown-block 测试注入：streamdown 渲染崩溃');
      return createElement(orig.Streamdown, props);
    },
  };
});

afterEach(() => {
  cleanup();
  boom.on = false;
});

describe('U2-E① 粗体与行内代码', () => {
  it('**粗** 渲染出真 <strong>；`code` 渲染出 code.md-inline-code', async () => {
    const { container } = render(<MarkdownBlock text={'**粗体** 与 `inline_code`'} />);
    await screen.findByText('粗体', undefined, { timeout: 8000 });
    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('粗体');
    const code = container.querySelector('code.md-inline-code');
    expect(code?.textContent).toBe('inline_code');
    // 根类名挂载（样式作用域依据）
    expect(container.querySelector('.markdown-body')).not.toBeNull();
  });
});

describe('U2-E② GFM 表格', () => {
  it('管道表渲染出 table/thead/tbody/th/td', async () => {
    const md = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |';
    const { container } = render(<MarkdownBlock text={md} />);
    await screen.findByText('列A', undefined, { timeout: 8000 });
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
  });
});

describe('U2-E③ ErrorBoundary 降级', () => {
  it('渲染抛错 → 纯文本 <pre class=md-raw data-md-fallback>，原文保真（坏消息不拖垮转录）', async () => {
    // 注意与 Suspense 加载态区分：加载 fallback 挂 data-md-loading，降级态挂 data-md-fallback。
    // 抛错发生在 lazy chunk 解析后的渲染期 —— 先渲染，再等降级出现。
    boom.on = true;
    const { container } = render(<MarkdownBlock text="坏消息 **原文** 必须可见" />);
    await waitFor(
      () => {
        expect(container.querySelector('pre.md-raw[data-md-fallback="true"]')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const pre = container.querySelector('pre.md-raw');
    expect(pre?.textContent).toBe('坏消息 **原文** 必须可见');
    expect(container.querySelector('[data-md-loading="true"]')).toBeNull();
  });
});

describe('U2-E④ 流式未闭合语法', () => {
  it('streaming 模式 `**bold` 未闭合 → 不崩、无降级 pre（parseIncompleteMarkdown 补全）', async () => {
    const { container } = render(<MarkdownBlock text="**bold 还没闭合" streaming />);
    await screen.findByText(/bold/, undefined, { timeout: 8000 });
    expect(container.querySelector('pre.md-raw')).toBeNull();
    expect(container.querySelector('[data-md-fallback]')).toBeNull();
    expect(container.textContent).toContain('bold 还没闭合');
  });

  it('未闭合围栏 ``` 流式中 → 同样不崩（ZCode #185 防线：完成态/历史一律 static 由接线保证）', async () => {
    const { container } = render(<MarkdownBlock text={'```ts\nconst a = 1;'} streaming />);
    await waitFor(
      () => {
        expect(container.querySelector('.markdown-body')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    expect(container.querySelector('[data-md-fallback]')).toBeNull();
    expect(container.textContent).toContain('const a = 1;');
  });
});

describe('U2-E⑤ 代码块走 CodeViewer（不吃 streamdown 内置 shiki renderer）', () => {
  it('```ts 围栏 → .md-code-block 内挂 CodeViewer（[data-code-viewer-body]），内容原文可见', async () => {
    const { container } = render(<MarkdownBlock text={'```ts\nconst a = 1;\n```'} />);
    const line = await screen.findByText(/const a = 1;/, undefined, { timeout: 8000 });
    const fence = container.querySelector('.md-code-block');
    expect(fence).not.toBeNull();
    // CodeViewer 真身（行号槽 + 等宽行）；高亮异步到达前后 [data-code-line-text] 恒存在
    expect(fence?.querySelector('[data-code-viewer-body]')).not.toBeNull();
    expect(line.getAttribute('data-code-line-text')).not.toBeNull();
    expect(line.textContent).toContain('const a = 1;');
  });
});

describe('U2-E⑥ toCodeLanguage 纯函数（白名单 + 别名 + 大小写）', () => {
  it('别名/大小写归一；未知语言 null（CodeViewer 纯文本回落，不假装高亮）', () => {
    expect(toCodeLanguage('ts')).toBe('typescript');
    expect(toCodeLanguage('TS')).toBe('typescript');
    expect(toCodeLanguage('typescript')).toBe('typescript');
    expect(toCodeLanguage('sh')).toBe('bash');
    expect(toCodeLanguage('py')).toBe('python');
    expect(toCodeLanguage('h')).toBe('c');
    expect(toCodeLanguage('kotlin')).toBeNull();
    expect(toCodeLanguage('')).toBeNull();
  });
});
