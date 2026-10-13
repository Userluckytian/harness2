// @vitest-environment jsdom
// Z10-6c：变更审查面板细节补齐 —— 每文件 +N/−M 计数、未暂存等价筛选、标题命名「审查」。
// 壳无关：数据源经 props 注入 AppStore；controller 用桩（本用例不触发撤销/重做）。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppStore } from '../src/renderer/store.js';
import type { Controller } from '../src/renderer/app-controller.js';
import type { ChangeSetShape } from '../src/shared/protocol.js';
import { ChangeReviewPanel, filterChangedFiles } from '../src/renderer/panels/workspace/ChangeReviewPanel.js';
import type { ChangedFileView } from '../src/renderer/features/workspace/change-review-model.js';

afterEach(cleanup);

const controller = {} as unknown as Controller;

/** 四个文件覆盖：部分改 / 全增（新增）/ 全删（删除）/ 拟议两边 null。 */
const changeSet: ChangeSetShape = {
  sourceDir: '/w/s1',
  changedFiles: 4,
  dirtyFiles: 1,
  readOnly: true,
  files: [
    {
      file: 'a.ts',
      planned: { before: 'x\nold\ny\n', after: 'x\nnew\ny\n' },
      current: 'x\nnew\ny\n',
      lastKnown: 'x\nnew\ny\n',
      dirty: false,
      matchesPlan: true,
    },
    {
      file: 'b.ts',
      planned: { before: null, after: 'a\nb\n' },
      current: 'a\nb\n',
      lastKnown: 'a\nb\n',
      dirty: false,
      matchesPlan: true,
    },
    {
      file: 'c.ts',
      planned: { before: 'p\nq\n', after: null },
      current: 'leftover',
      lastKnown: null,
      dirty: true,
      matchesPlan: false,
    },
    {
      file: 'd.ts',
      planned: { before: null, after: null },
      current: 'd',
      lastKnown: 'd',
      dirty: false,
      matchesPlan: true,
    },
  ],
};

function renderPanel(): void {
  const store = new AppStore();
  store.setChangeReview('s1', changeSet);
  render(<ChangeReviewPanel store={store} controller={controller} sessionId="s1" onOpenFile={() => {}} />);
}

describe('ChangeReviewPanel：每文件 +N/−M（Z10-6c）', () => {
  it('部分改 → +1 −1；全增 → +2 −0；全删 → +0 −2；两边 null → 不显示计数', () => {
    renderPanel();
    expect(document.querySelector('[data-change-counts="a.ts"]')?.textContent).toBe('+1−1');
    expect(document.querySelector('[data-change-counts="b.ts"]')?.textContent).toBe('+2−0');
    expect(document.querySelector('[data-change-counts="c.ts"]')?.textContent).toBe('+0−2');
    // 拟议 before/after 都为 null：不猜、不显示 +0 −0
    expect(document.querySelector('[data-change-counts="d.ts"]')).toBeNull();
  });

  it('计数用语义 token 类（add=success / del=destructive）', () => {
    renderPanel();
    const counts = document.querySelector('[data-change-counts="a.ts"]') as HTMLElement;
    expect(counts.querySelector('.change-count-add')?.textContent).toBe('+1');
    expect(counts.querySelector('.change-count-del')?.textContent).toBe('−1');
  });
});

describe('ChangeReviewPanel：未暂存等价筛选（Z10-6c）', () => {
  it('默认「全部」显示 4 行；切「有外部改动」仅 dirty；切「与拟议一致」仅 matchesPlan', () => {
    renderPanel();
    const select = screen.getByTestId('change-filter') as HTMLSelectElement;
    expect(document.querySelectorAll('[data-change-open-file]')).toHaveLength(4);

    fireEvent.change(select, { target: { value: 'dirty' } });
    let rows = [...document.querySelectorAll('[data-change-open-file]')];
    expect(rows.map((r) => r.getAttribute('data-change-open-file'))).toEqual(['c.ts']);

    fireEvent.change(select, { target: { value: 'planned' } });
    rows = [...document.querySelectorAll('[data-change-open-file]')];
    expect(rows.map((r) => r.getAttribute('data-change-open-file'))).toEqual(['a.ts', 'b.ts', 'd.ts']);

    fireEvent.change(select, { target: { value: 'all' } });
    expect(document.querySelectorAll('[data-change-open-file]')).toHaveLength(4);
  });

  it('筛选下拉选项标签如实命名（不写 git 的「未暂存」）', () => {
    renderPanel();
    const options = [...(screen.getByTestId('change-filter') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['全部', '有外部改动', '与拟议一致']);
    expect(options.join('')).not.toContain('未暂存');
  });

  it('筛选后无文件 → 如实空态（不摆空列表冒充有内容）', () => {
    const store = new AppStore();
    store.setChangeReview('s1', {
      ...changeSet,
      files: [changeSet.files[0]!], // 仅 a.ts（dirty=false）
      changedFiles: 1,
      dirtyFiles: 0,
    });
    render(<ChangeReviewPanel store={store} controller={controller} sessionId="s1" />);
    fireEvent.change(screen.getByTestId('change-filter'), { target: { value: 'dirty' } });
    expect(screen.getByText(/当前筛选下无文件/)).toBeTruthy();
  });
});

describe('ChangeReviewPanel：标题命名对齐（Z10-6c）', () => {
  it('面板标题为「审查」（与启动器卡片、tab 标签一致）', () => {
    renderPanel();
    expect(screen.getByText('审查')).toBeTruthy();
  });

  it('无变更集时标题同样为「审查」', () => {
    const store = new AppStore();
    render(<ChangeReviewPanel store={store} controller={controller} sessionId="s1" />);
    expect(screen.getByText('审查')).toBeTruthy();
  });
});

describe('filterChangedFiles（纯函数）', () => {
  const files = changeSet.files.map<ChangedFileView>((f) => ({
    file: f.file,
    plannedBefore: f.planned.before,
    plannedAfter: f.planned.after,
    current: f.current,
    lastKnown: f.lastKnown,
    dirty: f.dirty,
    matchesPlan: f.matchesPlan,
    taskIds: [],
  }));

  it('all 原样返回副本；dirty 按 dirty 字段；planned 按 matchesPlan 字段', () => {
    expect(filterChangedFiles(files, 'all').map((f) => f.file)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(filterChangedFiles(files, 'all')).not.toBe(files);
    expect(filterChangedFiles(files, 'dirty').map((f) => f.file)).toEqual(['c.ts']);
    expect(filterChangedFiles(files, 'planned').map((f) => f.file)).toEqual(['a.ts', 'b.ts', 'd.ts']);
  });
});
