// B5 diff 卡片测试：buildDiffRows 纯函数（diffLines 标记 → 逐行渲染行）+ DiffCard 组件
// （mock window.harness2.getSnapshotForCall）+ 无快照/读失败时的降级展示。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { buildDiffRows, DEFAULT_VISIBLE_LINES, DiffCard } from '../src/renderer/components/DiffCard.js';
import type { SnapshotForCallShape } from '../src/shared/protocol.js';

/* —— buildDiffRows 纯函数 —— */

describe('buildDiffRows', () => {
  it('空内容 → 空数组', () => {
    expect(buildDiffRows(null, null)).toEqual([]);
    expect(buildDiffRows('', '')).toEqual([]);
  });

  it('无变化时不产生差异行（全 ctx）', () => {
    const rows = buildDiffRows('a\nb\n', 'a\nb\n');
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'ctx', text: 'b' },
    ]);
  });

  it('新增行标记 add（尾部换行不产生多余空行）', () => {
    const rows = buildDiffRows('a\n', 'a\nb\n');
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('删除行标记 del', () => {
    const rows = buildDiffRows('a\nb\n', 'a\n');
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
    ]);
  });

  it('替换（删 + 增）相邻出现', () => {
    const rows = buildDiffRows('x\nold\ny\n', 'x\nnew\ny\n');
    expect(rows).toEqual([
      { type: 'ctx', text: 'x' },
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'ctx', text: 'y' },
    ]);
  });

  it('文件不存在（null before）→ 全新增', () => {
    const rows = buildDiffRows(null, 'hello\n');
    expect(rows).toEqual([{ type: 'add', text: 'hello' }]);
  });

  it('文件被删除（null after）→ 全删除', () => {
    const rows = buildDiffRows('hello\n', null);
    expect(rows).toEqual([{ type: 'del', text: 'hello' }]);
  });
});

/* —— DiffCard 组件 —— */

function mockSnapshot(res: SnapshotForCallShape): void {
  const api = {
    getSnapshotForCall: vi.fn(async () => res),
  };
  (window as unknown as { harness2: { getSnapshotForCall: () => Promise<SnapshotForCallShape> } }).harness2 = api;
}

describe('DiffCard 组件', () => {
  beforeEach(() => {
    cleanup();
  });

  it('命中快照：渲染红绿行（del 行 danger-soft / add 行 ok-soft）+ 撤销按钮', async () => {
    mockSnapshot({ ok: true, entry: { file: 'C:/p/a.txt', before: 'line1\nold\n', after: 'line1\nnew\n' } });
    const onUndo = vi.fn();
    render(<DiffCard sessionId="s1" seq={42} file="a.txt" onUndo={onUndo} />);

    // 标题显示条目 file（命中时以条目为准）
    expect(await screen.findByText('C:/p/a.txt')).toBeTruthy();
    const undoBtn = await screen.findByRole('button', { name: '撤销此次修改' });
    undoBtn.click();
    expect(onUndo).toHaveBeenCalledTimes(1);

    // 差异行（class 在行容器 .diff-line 上；文本 span 是其子元素）
    const delLine = await screen.findByText('old');
    const addLine = await screen.findByText('new');
    const ctxLine = await screen.findByText('line1');
    expect(delLine.closest('.diff-line')?.className).toContain('diff-del');
    expect(addLine.closest('.diff-line')?.className).toContain('diff-add');
    expect(ctxLine.closest('.diff-line')?.className).toContain('diff-ctx');
  });

  it('无快照（ok=false / entry 缺失）→ 降级卡片：显示兜底文件 + 错误文案，不渲染 diff 行', async () => {
    mockSnapshot({ ok: false, error: '未找到对应快照' });
    render(<DiffCard sessionId="s1" seq={7} file="b.txt" onUndo={() => {}} />);

    expect(await screen.findByText('b.txt')).toBeTruthy();
    // 错误文案展示，且没有 diff 行（无 + / - 标记）
    expect(await screen.findByText('未找到对应快照')).toBeTruthy();
    expect(document.querySelector('.diff-line')).toBeNull();
  });

  it('IPC 读失败（reject）→ 降级错误文案', async () => {
    const api = {
      getSnapshotForCall: vi.fn(async () => {
        throw new Error('ipc broken');
      }),
    };
    (window as unknown as { harness2: { getSnapshotForCall: () => Promise<SnapshotForCallShape> } }).harness2 = api;
    render(<DiffCard sessionId="s1" seq={7} file="b.txt" onUndo={() => {}} />);

    expect(await screen.findByText('快照读取失败')).toBeTruthy();
  });

  it('缺少 seq → 不调用 IPC，显示缺键降级', async () => {
    const api = {
      getSnapshotForCall: vi.fn(async () => ({ ok: true }) as SnapshotForCallShape),
    };
    (window as unknown as { harness2: { getSnapshotForCall: () => Promise<SnapshotForCallShape> } }).harness2 = api;
    render(<DiffCard sessionId="s1" file="c.txt" onUndo={() => {}} />);

    expect(await screen.findByText('缺少事件序号，无法读取快照')).toBeTruthy();
    expect(api.getSnapshotForCall).not.toHaveBeenCalled();
  });

  it('行数 > 默认上限：折叠 + 展开全部/收起切换', async () => {
    const before = Array.from({ length: DEFAULT_VISIBLE_LINES + 6 }, (_, i) => `old line ${i}`).join('\n') + '\n';
    const after = Array.from({ length: DEFAULT_VISIBLE_LINES + 6 }, (_, i) => `new line ${i}`).join('\n') + '\n';
    const totalRows = buildDiffRows(before, after).length; // 全替换 → 以上下限动态计算，不耦合 diff 分组细节
    expect(totalRows).toBeGreaterThan(DEFAULT_VISIBLE_LINES);
    mockSnapshot({ ok: true, entry: { file: 'C:/p/big.txt', before, after } });

    render(<DiffCard sessionId="s1" seq={3} file="big.txt" onUndo={() => {}} />);
    // 默认只显示前 20 行
    await waitFor(() => expect(document.querySelectorAll('.diff-line').length).toBe(DEFAULT_VISIBLE_LINES));
    // 展开全部按钮出现；点击后显示全部行
    const toggle = await screen.findByRole('button', { name: /展开全部/ });
    toggle.click();
    await waitFor(() => expect(document.querySelectorAll('.diff-line').length).toBe(totalRows));
    // 收起按钮
    const collapse = await screen.findByRole('button', { name: /收起/ });
    collapse.click();
    await waitFor(() => expect(document.querySelectorAll('.diff-line').length).toBe(DEFAULT_VISIBLE_LINES));
  });
});
