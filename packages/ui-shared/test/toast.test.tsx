// @vitest-environment jsdom
// Z10-8b 全局 Toast 宿主（ToastHost + toastStore）行为单测：
//   渲染 / 自动消失（默认 4s）/ 手动关闭 / 多条堆叠 / error 不自动消失 / 显式常驻 /
//   可访问性（info/success → role=status+polite；error → role=alert+assertive）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TOAST_DEFAULT_TIMEOUT_MS, ToastHost, toast, toastStore } from '../src/renderer/toast/index.js';

afterEach(() => {
  cleanup();
  toastStore.clear();
  vi.useRealTimers();
});

describe('Z10-8b ToastHost 宿主行为', () => {
  it('空态：宿主容器在、无任何卡', () => {
    render(<ToastHost />);
    expect(screen.getByTestId('toast-host')).toBeTruthy();
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('info：role=status / aria-live=polite；默认 4s 后自动消失', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      toast({ kind: 'info', message: '已保存' });
    });
    const card = screen.getByTestId('toast');
    expect(card.getAttribute('data-kind')).toBe('info');
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(card.textContent).toContain('已保存');

    act(() => {
      vi.advanceTimersByTime(TOAST_DEFAULT_TIMEOUT_MS - 1);
    });
    expect(screen.queryAllByTestId('toast')).toHaveLength(1); // 未到点仍在
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryAllByTestId('toast')).toHaveLength(0); // 到点自动消失
  });

  it('success：同样 role=status；手动关闭立即移除', () => {
    render(<ToastHost />);
    act(() => {
      toast({ kind: 'success', message: '操作成功' });
    });
    expect(screen.getByTestId('toast').getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByTestId('toast-dismiss'));
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('多条堆叠：按入队顺序渲染；关闭一条不影响其余', () => {
    render(<ToastHost />);
    act(() => {
      toast({ kind: 'success', message: '第一条' });
      toast({ kind: 'info', message: '第二条' });
    });
    const cards = screen.getAllByTestId('toast');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('第一条');
    expect(cards[1]!.textContent).toContain('第二条');

    fireEvent.click(screen.getAllByTestId('toast-dismiss')[0]!);
    const left = screen.getAllByTestId('toast');
    expect(left).toHaveLength(1);
    expect(left[0]!.getAttribute('data-kind')).toBe('info');
  });

  it('error：role=alert / aria-live=assertive，带 detail；默认**不**自动消失', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      toast({ kind: 'error', message: '写入失败', detail: '权限不足' });
    });
    const card = screen.getByTestId('toast');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.getAttribute('aria-live')).toBe('assertive');
    expect(card.textContent).toContain('权限不足');

    act(() => {
      vi.advanceTimersByTime(TOAST_DEFAULT_TIMEOUT_MS * 10);
    });
    expect(screen.queryAllByTestId('toast')).toHaveLength(1); // 常驻，等用户看到/关闭
  });

  it('显式 timeoutMs<=0：连 info 也常驻（只能手动关）', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      toast({ kind: 'info', message: '常驻', timeoutMs: 0 });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_DEFAULT_TIMEOUT_MS * 10);
    });
    expect(screen.queryAllByTestId('toast')).toHaveLength(1);
  });
});
