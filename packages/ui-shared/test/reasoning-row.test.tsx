// ReasoningRow（Z-92）思考块一等行：默认折叠、展开/收起 + 300ms 延迟卸载、
// 流式「正在思考」扫光 + 最后一行摘要、流式→完成的唯一自动折叠（不覆盖手动开合）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { lastNonEmptyLine, ReasoningRow } from '../src/renderer/components/ReasoningRow.js';

afterEach(cleanup);

describe('lastNonEmptyLine（流式摘要行数据源）', () => {
  it('取最后一行非空内容；全空 → 空串', () => {
    expect(lastNonEmptyLine('第一行\n第二行\n第三行')).toBe('第三行');
    expect(lastNonEmptyLine('第一行\n\n  \n第二行\n\n')).toBe('第二行');
    expect(lastNonEmptyLine('')).toBe('');
    expect(lastNonEmptyLine('\n \n')).toBe('');
  });
});

describe('ReasoningRow：折叠与内容区', () => {
  it('完成态默认折叠：触发行「思考」，内容不在 DOM（不预渲染长思考）', () => {
    render(<ReasoningRow text="一段很长的思考" />);
    expect(screen.getByTestId('reasoning-row').getAttribute('data-state')).toBe('complete');
    expect(screen.getByTestId('reasoning-row').getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('reasoning-toggle').textContent).toBe('思考');
    expect(screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('reasoning-content')).toBeNull();
  });

  it('展开显示纯文本内容（不解析 Markdown）；收起后 ~300ms 延迟卸载', async () => {
    const { container } = render(<ReasoningRow text={'**不是加粗**\n第二行'} />);
    fireEvent.click(screen.getByTestId('reasoning-toggle'));
    const content = screen.getByTestId('reasoning-content');
    expect(content.textContent).toBe('**不是加粗**\n第二行'); // 原样文本，无 Markdown 结构
    expect(container.querySelector('strong')).toBeNull();

    fireEvent.click(screen.getByTestId('reasoning-toggle'));
    expect(screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByTestId('reasoning-content')).toBeNull(), { timeout: 1000 });
  });

  it('内容区限高可滚（max-h + overflow-y-auto）+ 左侧导线（border-l）', () => {
    render(<ReasoningRow text="内容" />);
    fireEvent.click(screen.getByTestId('reasoning-toggle'));
    const content = screen.getByTestId('reasoning-content');
    expect(content.className).toContain('max-h-60');
    expect(content.className).toContain('overflow-y-auto');
    expect(content.className).toContain('border-l');
  });
});

describe('ReasoningRow：流式态', () => {
  it('data-state=streaming，触发行「正在思考」带渐变扫光类，最后一行摘要可见且 aria-hidden', () => {
    render(<ReasoningRow text={'思考第一段\n最新一行还在写'} streaming />);
    expect(screen.getByTestId('reasoning-row').getAttribute('data-state')).toBe('streaming');
    const toggle = screen.getByTestId('reasoning-toggle');
    expect(toggle.textContent).toBe('正在思考');
    expect(toggle.querySelector('.reasoning-shimmer-text')).not.toBeNull();
    const tail = screen.getByTestId('reasoning-tail');
    expect(tail.textContent).toBe('最新一行还在写');
    expect(tail.className).toContain('reasoning-tail-mask'); // 两端渐隐 mask
  });

  it('流式 + 展开：内容随文本贴底滚动（scrollTop = scrollHeight）', () => {
    const { rerender } = render(<ReasoningRow text="第一段" streaming />);
    fireEvent.click(screen.getByTestId('reasoning-toggle'));
    const content = screen.getByTestId('reasoning-content') as HTMLElement;
    // jsdom 不布局：scrollTop 赋值即生效，断言被推到底
    rerender(<ReasoningRow text={'第一段\n更多内容'} streaming />);
    expect(content.scrollTop).toBe(content.scrollHeight);
  });

  it('流式→完成：自动折叠一次（唯一自动收起；未手动开合时生效）', () => {
    const { rerender } = render(<ReasoningRow text="思考中" streaming />);
    fireEvent.click(screen.getByTestId('reasoning-toggle')); // 流式中手动展开
    expect(screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')).toBe('true');
    // 用户已手动开合 → 转完成时尊重用户选择，不再自动折叠
    rerender(<ReasoningRow text="思考中" />);
    expect(screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')).toBe('true');

    // 未手动开合的流式行：转完成自动折叠（默认折叠态）
    render(<ReasoningRow text="另一段思考" streaming />);
    expect(screen.getAllByTestId('reasoning-row')[1]!.getAttribute('data-open')).toBe('false');
  });

  it('手动收起后再转完成：不产生第二次自动行为（open 保持 false）', () => {
    const { rerender } = render(<ReasoningRow text="思考中" streaming />);
    fireEvent.click(screen.getByTestId('reasoning-toggle')); // 展开
    fireEvent.click(screen.getByTestId('reasoning-toggle')); // 手动收起
    rerender(<ReasoningRow text="思考中" />);
    expect(screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('reasoning-row').getAttribute('data-state')).toBe('complete');
  });
});

describe('ReasoningRow：时长数据源缺失的如实呈现（Z3-02 交付口径）', () => {
  it('完成态触发行不含「持续了 N 秒」（协议无 reasoning 时长字段，不臆造）', () => {
    render(<ReasoningRow text="思考" />);
    expect(screen.getByTestId('reasoning-toggle').textContent).not.toContain('持续');
    expect(screen.getByTestId('reasoning-toggle').textContent).toBe('思考');
  });

  it('无「显示思考过程」设置开关（本仓无该设置项，不摆假设置）', () => {
    const { container } = render(<ReasoningRow text="思考" />);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });
});

describe('ReasoningRow：稳定性', () => {
  it('重复渲染不抖动：快速开合后按最后一次状态落定（重开清掉关闭计时器，不被误卸载）', async () => {
    render(<ReasoningRow text="思考" />);
    const toggle = () => screen.getByTestId('reasoning-toggle');
    fireEvent.click(toggle()); // 开
    fireEvent.click(toggle()); // 关（延迟卸载计时器起）
    fireEvent.click(toggle()); // 开（应清掉关闭计时器）
    await new Promise((r) => setTimeout(r, 400)); // 越过 300ms 卸载窗口
    expect(screen.getByTestId('reasoning-content')).not.toBeNull(); // 未被误卸载
    fireEvent.click(toggle()); // 关
    await waitFor(() => expect(screen.queryByTestId('reasoning-content')).toBeNull(), { timeout: 1000 });
  });
});
