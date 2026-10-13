// @vitest-environment jsdom
// 代码查看器测试（Z10-7）：
//   * 纯逻辑：主题目录 10 项与高亮器装载集**同集合**（防清单漂移）、语言探测、字号钳制；
//   * CodeViewer（纯呈现）：内容/行号/字号/换行 DOM 契约 + 语法高亮（真实 shiki）+ 主题切换重高亮；
//   * CodeViewerPane（数据层）：空态/错误态/读取成功；**无读取通道 → 如实「本壳无文件读取通道」**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CodeViewer } from '../src/renderer/code/CodeViewer.js';
import { CodeViewerPane } from '../src/renderer/code/CodeViewerPane.js';
import {
  CODE_LANGUAGES,
  CODE_THEME_OPTIONS,
  clampCodeFontSize,
  codeThemeLabel,
  detectCodeLanguage,
} from '../src/renderer/code/code-theme.js';
import { LOADED_LANGUAGES, LOADED_THEMES } from '../src/renderer/code/shiki-loader.js';
import { HostBridgeProvider } from '../src/renderer/host-bridge.js';

const globals = globalThis as { harness2?: unknown };

beforeEach(() => {
  delete globals.harness2; // 保证「无通道」用例不被环境残留桥掩盖
});
afterEach(cleanup);

describe('code-theme：目录与语言探测', () => {
  it('10 个代码主题选项，id 与高亮器装载集完全一致（防两处清单漂移）', () => {
    expect(CODE_THEME_OPTIONS).toHaveLength(10);
    expect(CODE_THEME_OPTIONS.map((o) => o.id).sort()).toEqual([...LOADED_THEMES].sort());
  });

  it('支持语言集与高亮器装载集一致', () => {
    expect([...CODE_LANGUAGES].sort()).toEqual([...LOADED_LANGUAGES].sort());
  });

  it('主题标签：GitHub Light / Vitesse / Minimal / Catppuccin / One Dark Pro', () => {
    expect(codeThemeLabel('github-light')).toBe('GitHub Light');
    expect(codeThemeLabel('vitesse-light')).toBe('Vitesse');
    expect(codeThemeLabel('min-dark')).toBe('Minimal Dark');
    expect(codeThemeLabel('catppuccin-mocha')).toBe('Catppuccin Mocha');
    expect(codeThemeLabel('one-dark-pro')).toBe('One Dark Pro');
  });

  it('语言探测：按扩展名（未知/无扩展名 → null 纯文本）', () => {
    expect(detectCodeLanguage('src/a.ts')).toBe('typescript');
    expect(detectCodeLanguage('C:\\work\\b.py')).toBe('python');
    expect(detectCodeLanguage('x.jsonc')).toBe('jsonc');
    expect(detectCodeLanguage('Dockerfile')).toBeNull();
    expect(detectCodeLanguage('a.unknownext')).toBeNull();
  });

  it('字号钳制进 12–20', () => {
    expect(clampCodeFontSize(9)).toBe(12);
    expect(clampCodeFontSize(99)).toBe(20);
    expect(clampCodeFontSize(14.6)).toBe(15);
  });
});

describe('CodeViewer：只读呈现契约 + 真实高亮', () => {
  it('行号 / 字号 / 换行 DOM 契约 + 逐行渲染', () => {
    render(
      <CodeViewer
        content={'const a = 1;\nlet b = 2;'}
        language={null}
        themeId="github-light"
        lineNumbers
        wordWrap
        fontSize={16}
      />,
    );
    const body = document.querySelector('[data-code-viewer-body]') as HTMLElement;
    expect(body.getAttribute('data-code-theme')).toBe('github-light');
    expect(body.getAttribute('data-code-line-numbers')).toBe('true');
    expect(body.getAttribute('data-code-wrap')).toBe('true');
    expect(body.getAttribute('data-code-font-size')).toBe('16');
    expect(document.querySelectorAll('[data-code-line]')).toHaveLength(2);
    expect(document.querySelector('[data-code-line="2"] [data-code-gutter]')?.textContent).toBe('2');
    expect(document.querySelector('[data-code-line="1"] [data-code-line-text]')?.textContent).toContain('const a = 1;');
  });

  it('行号关闭 / 不换行时的 DOM 契约', () => {
    render(
      <CodeViewer
        content="x"
        language={null}
        themeId="github-light"
        lineNumbers={false}
        wordWrap={false}
        fontSize={13}
      />,
    );
    const body = document.querySelector('[data-code-viewer-body]') as HTMLElement;
    expect(body.getAttribute('data-code-line-numbers')).toBe('false');
    expect(body.getAttribute('data-code-wrap')).toBe('false');
    expect(document.querySelector('[data-code-gutter]')).toBeNull();
  });

  it('真实语法高亮：TS 内容渲染出带颜色的 token span（异步加载后）', async () => {
    render(
      <CodeViewer
        content={'const answer: number = 42;'}
        language="typescript"
        themeId="github-light"
        lineNumbers
        wordWrap={false}
        fontSize={13}
      />,
    );
    await waitFor(() => {
      const spans = document.querySelectorAll('[data-code-line="1"] [data-code-line-text] span');
      expect(spans.length).toBeGreaterThan(0);
      expect((spans[0] as HTMLElement).style.color).not.toBe('');
    });
  });

  it('切换主题 → data-code-theme 更新且重新高亮（token 颜色随之变化）', async () => {
    const { rerender } = render(
      <CodeViewer
        content="const x = 1;"
        language="typescript"
        themeId="github-light"
        lineNumbers={false}
        wordWrap={false}
        fontSize={13}
      />,
    );
    const firstColor = await waitFor(() => {
      const span = document.querySelector('[data-code-line-text] span') as HTMLElement | null;
      if (span === null || span.style.color === '') throw new Error('尚未高亮');
      return span.style.color;
    });
    rerender(
      <CodeViewer
        content="const x = 1;"
        language="typescript"
        themeId="github-dark"
        lineNumbers={false}
        wordWrap={false}
        fontSize={13}
      />,
    );
    expect((document.querySelector('[data-code-viewer-body]') as HTMLElement).getAttribute('data-code-theme')).toBe(
      'github-dark',
    );
    const secondColor = await waitFor(() => {
      const span = document.querySelector('[data-code-line-text] span') as HTMLElement | null;
      if (span === null || span.style.color === '' || span.style.color === firstColor)
        throw new Error('尚未按新主题重高亮');
      return span.style.color;
    });
    expect(secondColor).not.toBe(firstColor);
  });
});

describe('CodeViewerPane：数据层（读取 / 空态 / 错误态 / 无通道降级）', () => {
  it('未打开文件 → 空态（不摆假代码）', () => {
    render(<CodeViewerPane path={null} />);
    expect(document.querySelector('[data-code-viewer="empty"]')).not.toBeNull();
    expect(screen.getByText(/尚未打开文件/)).toBeTruthy();
  });

  it('注入读取通道 → 读到内容并渲染（含路径头）', async () => {
    const readFile = vi.fn(async () => ({ ok: true, content: 'hello\nworld' }));
    render(<CodeViewerPane path="src/a.ts" readFile={readFile} />);
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith('src/a.ts', '');
    expect(document.querySelector('[data-code-path="src/a.ts"]')).not.toBeNull();
  });

  it('读取失败 → 如实错误态（显示原因，不摆假代码）', async () => {
    const readFile = vi.fn(async () => ({ ok: false, error: '路径越界' }));
    render(<CodeViewerPane path="../etc/passwd" readFile={readFile} />);
    expect(await screen.findByText('路径越界')).toBeTruthy();
    expect(document.querySelector('[data-code-viewer-error]')).not.toBeNull();
  });

  it('本壳无读取通道（web）→ 明说「本壳无文件读取通道」，不假装加载中', async () => {
    render(<CodeViewerPane path="src/a.ts" />);
    const err = await screen.findByText(/本壳无文件读取通道/);
    expect(err).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('宿主能力端口（HostBridge.readFileForRef）注入 → 走端口读取', async () => {
    const readFileForRef = vi.fn(async () => ({ ok: true, content: 'via-bridge' }));
    render(
      <HostBridgeProvider value={{ readFileForRef }}>
        <CodeViewerPane path="src/b.ts" cwd="/work" />
      </HostBridgeProvider>,
    );
    expect(await screen.findByText('via-bridge')).toBeTruthy();
    expect(readFileForRef).toHaveBeenCalledWith('src/b.ts', '/work');
  });
});
