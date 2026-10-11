// FontSizeInput（Z-90）测试：Enter / 失焦提交、Esc 还原、边界钳制 12–20、
// 不可解析输入还原不造值、原生步进器隐藏、px 后缀。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { FontSizeInput } from '../src/components/ui/font-size-input.js';

afterEach(cleanup);

function field(label = '界面字号'): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
}

describe('FontSizeInput（Z-90）：提交语义', () => {
  it('Enter 提交并回显；值未变化时不回调', () => {
    const onCommit = vi.fn();
    render(<FontSizeInput value={14} onCommit={onCommit} aria-label="界面字号" />);
    fireEvent.change(field(), { target: { value: '16' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(16);
    expect(field().value).toBe('16');
    // 同值重复提交（未改动）不回调
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('失焦（focusout）提交；范围外钳制进 [min, max]（11→12、25→20）', () => {
    const onCommit = vi.fn();
    const view = render(<FontSizeInput value={14} onCommit={onCommit} aria-label="界面字号" />);
    fireEvent.change(field(), { target: { value: '11' } });
    fireEvent.focusOut(field());
    expect(onCommit).toHaveBeenCalledWith(12);
    expect(field().value).toBe('12');

    view.rerender(<FontSizeInput value={12} onCommit={onCommit} aria-label="界面字号" />);
    fireEvent.change(field(), { target: { value: '25' } });
    fireEvent.focusOut(field());
    expect(onCommit).toHaveBeenCalledWith(20);
    expect(field().value).toBe('20');
  });

  it('Esc 还原草稿到已提交值，且不触发提交', () => {
    const onCommit = vi.fn();
    render(<FontSizeInput value={14} onCommit={onCommit} aria-label="界面字号" />);
    fireEvent.change(field(), { target: { value: '19' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe('14');
    // 还原后失焦不再提交（草稿 == 已提交值）
    fireEvent.focusOut(field());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('不可解析输入（空 / 非数字）：失焦还原为当前值，不提交、不造默认值', () => {
    const onCommit = vi.fn();
    render(<FontSizeInput value={14} onCommit={onCommit} aria-label="界面字号" />);
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.focusOut(field());
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe('14');

    fireEvent.change(field(), { target: { value: 'abc' } });
    fireEvent.focusOut(field());
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe('14');
  });

  it('外部受控值变化 → 草稿跟随（宿主回写场景）', () => {
    const view = render(<FontSizeInput value={14} onCommit={() => {}} aria-label="界面字号" />);
    view.rerender(<FontSizeInput value={18} onCommit={() => {}} aria-label="界面字号" />);
    expect(field().value).toBe('18');
  });

  it('px 后缀常显；数字输入隐藏原生步进器（type=number + appearance 工具类）', () => {
    render(<FontSizeInput value={14} onCommit={() => {}} aria-label="界面字号" />);
    expect(screen.getByText('px')).toBeTruthy();
    expect(field().type).toBe('number');
    const cls = field().className;
    expect(cls).toContain('[appearance:textfield]');
    expect(cls).toContain('[&::-webkit-inner-spin-button]:appearance-none');
    expect(cls).toContain('[&::-webkit-outer-spin-button]:appearance-none');
  });

  it('边界可自定义（缺省 12–20）：自定义 min/max 同样钳制', () => {
    const onCommit = vi.fn();
    render(<FontSizeInput value={5} onCommit={onCommit} min={1} max={9} aria-label="自定义范围" />);
    fireEvent.change(field('自定义范围'), { target: { value: '99' } });
    fireEvent.focusOut(field('自定义范围'));
    expect(onCommit).toHaveBeenCalledWith(9);
    expect(field('自定义范围').value).toBe('9');
  });
});
