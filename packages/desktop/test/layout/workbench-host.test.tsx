// @vitest-environment jsdom
// 分屏工作台组件级测试（Z2-06 / Z-19）：单格无痕迹 / 拖入生成第二格 / 去重 / 上限 / 关闭塌缩 /
// 分隔条拖动与键盘。真渲染 WorkbenchHost（内含真 ConversationSeat + 真 store/controller），
// 只有 window.harness2 是桩。拖拽走真实 DOM 事件（dragover/drop），矩形用桩测量（jsdom 无布局）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Harness2Api, SessionEventsPayloadShape } from '../../src/shared/protocol.js';
import { createController, type Controller } from '@harness2/ui-shared/renderer/app-controller.js';
import { AppStore } from '@harness2/ui-shared/renderer/store.js';
import { workbenchDrag } from '../../src/renderer/layout/workbench/drag.js';
import { WorkbenchHost } from '../../src/renderer/layout/workbench/host.js';
import { countPanes, type WorkbenchNode } from '../../src/renderer/layout/workbench/model.js';
import { WorkbenchStore } from '../../src/renderer/layout/workbench/store.js';

afterEach(() => {
  cleanup();
  workbenchDrag.end();
});

const sessionIds = ['a', 'b', 'c', 'd', 'e'];

function replayFor(id: string): SessionEventsPayloadShape {
  return {
    id,
    dir: 'd',
    header: { sessionId: id, cwd: 'D:/proj' },
    events: [
      {
        v: 1,
        seq: 1,
        ts: '2026-10-10T00:00:00Z',
        type: 'user/message',
        payload: { text: `会话 ${id}`, turnId: 't1' },
        active: true,
      },
    ],
    warnings: [],
    lastSeq: 1,
  };
}

function makeApi(): Harness2Api {
  return {
    gitBranch: vi.fn(async () => 'main'),
    settingsGetConfig: vi.fn(async () => ({ roles: { main: { model: 'mock/m' } } })),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    cancel: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
  } as unknown as Harness2Api;
}

interface Boot {
  readonly store: AppStore;
  readonly controller: Controller;
  readonly workbench: WorkbenchStore;
  readonly api: Harness2Api;
}

function boot(selected = 'a'): Boot {
  const api = makeApi();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  const store = new AppStore();
  store.applyStatus('connected');
  store.setSessions(
    sessionIds.map((id, index) => ({
      id,
      dir: 'd',
      cwd: 'D:/proj',
      mtimeMs: sessionIds.length - index,
      firstUserText: `会话 ${id}`,
      messageCount: 1,
      lastSeq: 1,
    })),
  );
  store.select(selected);
  store.applyReplay(replayFor(selected));
  const workbench = new WorkbenchStore();
  return { store, controller: createController(store, api), workbench, api };
}

function renderHost(booted: Boot): void {
  render(<WorkbenchHost store={booted.store} controller={booted.controller} workbench={booted.workbench} />);
}

function stubRect(element: HTMLElement, width = 200, height = 100): void {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function panes(): number {
  return Number(screen.getByTestId('workbench-root').getAttribute('data-panes'));
}

/** 模拟「从左侧拖入会话并落在某格边缘」：dragOver 定落点 + drop 落定。
 *  注意：jsdom 无 DragEvent（testing-library 会退回 Event，clientX 丢失）→ 这里用
 *  MouseEvent 以 'dragover'/'drop' 类型派发（React 按事件类型分发，坐标随 MouseEvent 带上）。 */
function dragSessionOnto(pane: HTMLElement, sessionId: string, x: number, y: number): void {
  workbenchDrag.begin(sessionId);
  act(() => {
    pane.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
  act(() => {
    pane.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

beforeEach(() => {
  workbenchDrag.end();
});

describe('未分屏：无任何分屏 UI 痕迹（与旧结构等价）', () => {
  it('单格：无分隔条 / 无关闭按钮 / 无落点预览；只有一格会话界面', () => {
    const booted = boot();
    renderHost(booted);
    expect(panes()).toBe(1);
    expect(screen.getAllByTestId('workbench-pane')).toHaveLength(1);
    expect(screen.queryByTestId('workbench-split')).toBeNull();
    expect(screen.queryByTestId('workbench-splitter')).toBeNull();
    expect(screen.queryByTestId('pane-close')).toBeNull();
    expect(screen.queryByTestId('pane-drop-preview')).toBeNull();
    expect(screen.queryByTestId('workbench-pane-header')).toBeNull(); // 主格用完整会话头
    // 会话内容真渲染（chat 视图）
    expect(screen.getByTestId('conversation-seat')).toBeTruthy();
    // 主格绑定当前 selectedId
    expect(booted.workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a' });
  });
});

describe('投放：拖入生成第二格', () => {
  it('拖会话 b 落在右边缘 → 生成第二格（row 分割），新格为非主格（有浮动关闭按钮）', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 196, 50); // 右边缘

    expect(panes()).toBe(2);
    expect(screen.getAllByTestId('workbench-pane')).toHaveLength(2);
    const split = screen.getByTestId('workbench-split');
    expect(split.getAttribute('data-dir')).toBe('row');
    expect(screen.getAllByTestId('workbench-splitter')).toHaveLength(1);
    expect(screen.getByTestId('workbench-splitter').getAttribute('aria-orientation')).toBe('vertical');
    // 新格（pane-1=b）非主格：关闭按钮只在它身上（主格 a 无）
    expect(screen.getAllByTestId('pane-close')).toHaveLength(1);
    expect(booted.workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a', 'pane-1': 'b' });
    expect(booted.workbench.getSnapshot().focusedId).toBe('pane-1');
    // 新格用轻量头部（避免多格重复窗控）
    expect(screen.getAllByTestId('workbench-pane-header')).toHaveLength(1);
  });

  it('落点预览：悬停右边缘时叠出半边色块（data-side=right、半宽），drop 后消失', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    workbenchDrag.begin('b');
    act(() => {
      pane.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 196, clientY: 50 }));
    });
    const preview = screen.getByTestId('pane-drop-preview');
    expect(preview.getAttribute('data-side')).toBe('right');
    expect(preview.style.width).toBe('50%');
    expect(preview.style.height).toBe('100%');
    // 中间区域不显示预览（避免误触）
    act(() => {
      pane.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 100, clientY: 50 }));
    });
    expect(screen.queryByTestId('pane-drop-preview')).toBeNull();
    // 回到边缘并落定 → 预览随 drop 清除
    act(() => {
      pane.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 196, clientY: 50 }));
    });
    expect(screen.getByTestId('pane-drop-preview')).not.toBeNull();
    act(() => {
      pane.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 196, clientY: 50 }));
    });
    expect(panes()).toBe(2);
    expect(screen.queryByTestId('pane-drop-preview')).toBeNull();
  });

  it('中间区域（非边缘）落点不分屏，给可见提示（不静默）', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 100, 50); // 正中：到四边距离均 0.5 > 0.32
    expect(panes()).toBe(1);
    expect(screen.getByTestId('workbench-hint').textContent).toContain('边缘');
  });
});

describe('去重：同会话重复拖入 → 聚焦而非新建', () => {
  it('已分屏的 b 再拖入 → 仍两格，焦点移到 b 所在格，并提示', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 196, 50);
    expect(panes()).toBe(2);
    expect(booted.workbench.getSnapshot().focusedId).toBe('pane-1');

    // 聚焦主格后再重复拖入 b
    const panesEls = screen.getAllByTestId('workbench-pane');
    const pane0 = panesEls[0] as HTMLElement;
    stubRect(pane0, 200, 100);
    act(() => {
      fireEvent.pointerDown(pane0, { button: 0 });
    });
    expect(booted.workbench.getSnapshot().focusedId).toBe('pane-0');

    dragSessionOnto(pane0, 'b', 196, 50);
    expect(panes()).toBe(2); // 不新建
    expect(booted.workbench.getSnapshot().focusedId).toBe('pane-1');
    expect(screen.getByTestId('workbench-hint').textContent).toContain('已在分屏中');
  });
});

describe('上限：第 5 格被拒', () => {
  it('已达 4 格再投放 → 拒绝并提示，树保持 4 格', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    // 直接经仓库铺满 4 格（a 主格 + b/c/d）
    act(() => {
      booted.workbench.dropSession({ sessionId: 'b', targetLeafId: 'pane-0', side: 'right' });
      booted.workbench.dropSession({ sessionId: 'c', targetLeafId: 'pane-0', side: 'down' });
      booted.workbench.dropSession({ sessionId: 'd', targetLeafId: 'pane-0', side: 'up' });
    });
    expect(panes()).toBe(4);
    expect(countPanes(booted.workbench.getSnapshot().root)).toBe(4);

    const target = screen.getAllByTestId('workbench-pane')[0] as HTMLElement;
    stubRect(target, 200, 100);
    dragSessionOnto(target, 'e', 5, 50);
    expect(panes()).toBe(4);
    expect(screen.getByTestId('workbench-hint').textContent).toContain('最多 4 格');
  });
});

describe('关闭格：塌缩 + 焦点回主格 + 会话仍在 store（不停止会话）', () => {
  it('关闭非主格 → 回单格、焦点回主格、会话 b 仍在 store、未触发 cancel', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 196, 50);
    expect(panes()).toBe(2);

    act(() => {
      fireEvent.click(screen.getByTestId('pane-close'));
    });

    expect(panes()).toBe(1);
    expect(booted.workbench.getSnapshot().root).toEqual({ t: 'leaf', id: 'pane-0' });
    expect(booted.workbench.getSnapshot().focusedId).toBe('pane-0');
    expect(booted.workbench.getSnapshot().bindings).toEqual({ 'pane-0': 'a' });
    // 关闭格 ≠ 停止会话：会话 b 仍在 store，且未调用 cancel
    expect(booted.store.getState().sessions.some((s) => s.id === 'b')).toBe(true);
    expect(booted.api.cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('workbench-hint').textContent).toContain('仍在后台运行');
  });
});

describe('分隔条：比例拖动与键盘', () => {
  function mountTwoPane(): { booted: Boot; splitter: HTMLElement; split: HTMLElement } {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 196, 50);
    const split = screen.getByTestId('workbench-split');
    stubRect(split, 400, 200);
    return { booted, splitter: screen.getByTestId('workbench-splitter'), split };
  }

  it('指针拖动只改 --ratio、松手才写状态；越界钳制到 0.75', () => {
    const { booted, splitter, split } = mountTwoPane();
    const ratioOf = (): number => {
      const node = booted.workbench.getSnapshot().root as Extract<WorkbenchNode, { t: 'split' }>;
      return node.ratio;
    };
    expect(ratioOf()).toBe(0.5);
    expect(splitter.getAttribute('aria-valuemin')).toBe('0.25');
    expect(splitter.getAttribute('aria-valuemax')).toBe('0.75');

    act(() => {
      fireEvent.pointerDown(splitter, { clientX: 200 });
      fireEvent.pointerMove(window, { clientX: 1000 }); // 远超右界
      // 拖动中：状态未变（松手才写）
      expect(ratioOf()).toBe(0.5);
      fireEvent.pointerUp(window, {});
    });
    expect(ratioOf()).toBe(0.75);
    expect(splitter.getAttribute('aria-valuenow')).toBe('0.75');
    expect(split.style.getPropertyValue('--ratio')).toBe('0.75');

    // 反向拖到左界 → 0.25
    act(() => {
      fireEvent.pointerDown(splitter, { clientX: 300 });
      fireEvent.pointerMove(window, { clientX: 0 });
      fireEvent.pointerUp(window, {});
    });
    expect(ratioOf()).toBe(0.25);
  });

  it('键盘：←/→ 步长 0.02 并钳制', () => {
    const { booted, splitter } = mountTwoPane();
    const ratioOf = (): number => (booted.workbench.getSnapshot().root as Extract<WorkbenchNode, { t: 'split' }>).ratio;
    act(() => {
      fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    });
    expect(ratioOf()).toBe(0.52);
    act(() => {
      fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
      fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    });
    expect(ratioOf()).toBe(0.5);
    // 连按到左界
    for (let i = 0; i < 40; i += 1) {
      fireEvent.keyDown(screen.getByTestId('workbench-splitter'), { key: 'ArrowLeft' });
    }
    expect(ratioOf()).toBe(0.25);
  });

  it('column 分割的分隔条是横向、aria-orientation=horizontal', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 100, 96); // 下边缘 → column
    expect(screen.getByTestId('workbench-split').getAttribute('data-dir')).toBe('column');
    expect(screen.getByTestId('workbench-splitter').getAttribute('aria-orientation')).toBe('horizontal');
  });
});

describe('焦点标识（语义 token）', () => {
  it('焦点格带 data-focused=true，其余为 false', () => {
    const booted = boot();
    renderHost(booted);
    const pane = screen.getByTestId('workbench-pane');
    stubRect(pane, 200, 100);
    dragSessionOnto(pane, 'b', 196, 50);
    const focused = screen.getAllByTestId('workbench-pane').map((el) => el.getAttribute('data-focused'));
    expect(focused).toEqual(['false', 'true']); // 新格 pane-1 聚焦
  });
});
