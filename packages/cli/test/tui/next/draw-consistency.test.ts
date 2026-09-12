// T2-7 接口缺口收敛回归：draw 级 API 与 render 级薄壳的渲染结果一致性。
// - drawScrollback(buf) vs renderScrollback(screen)：同输入（等价 Scrollback 实例）+
//   同 opts → 同一网格（chars/widths/fg 三平行数组逐格相等）。
// - drawComposer(buf) vs renderComposer(screen)：同输入（ComposerState）+ 同 opts → 同一网格。
// 防止两实现再次漂移（整帧装配 chat-screen 依赖 draw 级 API 与薄壳语义一致）。
import { describe, expect, it } from 'vitest';
import {
  drawComposer,
  renderComposer,
  type ComposerRenderOptions,
  type ComposerState,
} from '../../../src/tui/next/composer.js';
import {
  drawScrollback,
  renderScrollback,
  Scrollback,
  type ScrollbackRenderOptions,
} from '../../../src/tui/next/scrollback.js';
import { CellBuffer } from '../../../src/tui/renderer/cell-buffer.js';
import { Screen } from '../../../src/tui/renderer/screen.js';

class MemOut {
  private chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
}

function makeScreen(cols: number, rows: number): Screen {
  const screen = new Screen(new MemOut(), cols, rows);
  screen.start({ mouse: false });
  return screen;
}

/** 逐格断言两个 buffer 的 chars/widths/fg 三平行数组完全相等（含续列格） */
function expectBuffersEqual(a: CellBuffer, b: CellBuffer): void {
  expect(a.cols).toBe(b.cols);
  expect(a.rows).toBe(b.rows);
  expect(a.chars).toEqual(b.chars);
  expect(Array.from(a.widths)).toEqual(Array.from(b.widths));
  expect(Array.from(a.fg)).toEqual(Array.from(b.fg));
}

describe('drawScrollback 与 renderScrollback 渲染一致性', () => {
  it('同输入同网格：贴底 + 滚动条（缺省 opts）', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `msg-${i} 中文行`);
    const screen = makeScreen(80, 24);
    renderScrollback(screen, new Scrollback(lines, 79), {});
    const buf = new CellBuffer(80, 24);
    drawScrollback(buf, new Scrollback(lines, 79), {});
    expectBuffersEqual(screen.buffer, buf);
  });

  it('同输入同网格：anchor 中部滚动 + 局部区域 + 自定义颜色/字符', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const opts: ScrollbackRenderOptions = {
      top: 2,
      height: 12,
      width: 40,
      fg: 0xaaaaaa,
      trackChar: '┊',
      thumbChar: '▪',
      scrollbarFg: 0x00ff00,
    };
    const screen = makeScreen(48, 20);
    const sbA = new Scrollback(lines, 39);
    sbA.scrollBy(-17); // 两侧实例做同一状态变更，保持等价
    renderScrollback(screen, sbA, opts);
    const buf = new CellBuffer(48, 20);
    const sbB = new Scrollback(lines, 39);
    sbB.scrollBy(-17);
    drawScrollback(buf, sbB, opts);
    expectBuffersEqual(screen.buffer, buf);
    expect(sbB.scrollTopRow).toBe(sbA.scrollTopRow);
  });

  it('同输入同网格：scrollbar:false + 内容不足一屏（空行填充）', () => {
    const lines = ['alpha', 'beta 中文', 'gamma'];
    const opts: ScrollbackRenderOptions = { top: 1, height: 6, scrollbar: false, fg: 0x123456 };
    const screen = makeScreen(30, 10);
    renderScrollback(screen, new Scrollback(lines, 30), opts);
    const buf = new CellBuffer(30, 10);
    drawScrollback(buf, new Scrollback(lines, 30), opts);
    expectBuffersEqual(screen.buffer, buf);
  });
});

describe('drawComposer 与 renderComposer 渲染一致性', () => {
  it('同输入同网格：多行草稿 + 行中光标 + 自定义前景色', () => {
    const state: ComposerState = { draft: 'hello 世界\nsecond line here', cursor: 8 };
    const opts: ComposerRenderOptions = { top: 4, height: 4, fg: 0xdddddd, cursorFg: 0xff0000 };
    const screen = makeScreen(30, 10);
    renderComposer(screen, { ...state }, opts);
    const buf = new CellBuffer(30, 10);
    drawComposer(buf, { ...state }, opts);
    expectBuffersEqual(screen.buffer, buf);
  });

  it('同输入同网格：候选滚动窗口 + 超宽指示器截断 + 草稿共存', () => {
    const state: ComposerState = { draft: '> deploy --prod', cursor: 3 };
    const opts: ComposerRenderOptions = {
      top: 7,
      candidates: {
        items: ['plan', 'auto-edit', 'read-only', 'full-access', 'safe', 'yolo', 'custom'],
        activeIndex: 5,
      },
      maxCandidates: 4,
      candidateFg: 0x888888,
      candidateActiveFg: 0xffffff,
      indicators: ['plan', 'claude-x', 'context 88%'],
      indicatorFg: 0x00ff00,
    };
    const screen = makeScreen(40, 12);
    renderComposer(screen, { ...state }, opts);
    const buf = new CellBuffer(40, 12);
    drawComposer(buf, { ...state }, opts);
    expectBuffersEqual(screen.buffer, buf);
  });

  it('同输入同网格：缺省贴底 1 行 + CJK 光标续列钳制', () => {
    const state: ComposerState = { draft: '中文草稿', cursor: 5 }; // 光标落在宽字符续列
    const screen = makeScreen(20, 6);
    renderComposer(screen, { ...state }, {});
    const buf = new CellBuffer(20, 6);
    drawComposer(buf, { ...state }, {});
    expectBuffersEqual(screen.buffer, buf);
  });
});
