// T3 弹层位置：/mode、/sessions、审批确认框统一渲染在输入框上方区域。
// 规则（计划 T3）：
// - 弹层节点位于 Composer 之前（渲染顺序：状态栏 → 转录 → 弹层 → Composer 输入行贴底）
// - 弹层不与状态栏相邻（转录区在两者之间）
// - 弹层打开时转录让出等量行（被遮挡行数 = 弹层高度），输入框绝不被挤出屏幕
// - Esc 关闭后焦点回 Composer（既有互斥逻辑不变）
//
// 注意：mountTui 的输出缓冲是「逐帧拼接」的（每帧 = 完整屏幕渲染），因此
// 存在性/顺序断言一律在「最后一帧」上做（lastIndexOf('[normal]') 定位最后一帧起点）。
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { ConfirmDialog } from '../../src/tui/ConfirmDialog.js';
import { mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop();
    await r?.cleanup();
  }
});

/** 40 行历史：足以区分「转录让出弹层高度」前后可见行数 */
const boot = Array.from({ length: 40 }, (_, i) => `历史行 ${i}`);

async function mountShell(runtime: Awaited<ReturnType<typeof createTestRuntime>>) {
  const t = mountTui(
    <InkShell runtime={runtime.runtime} bootLines={boot} dialog={createDialogController()} onExit={() => undefined} />,
    { columns: 100, rows: 30 },
  );
  await t.flush();
  return t;
}

/** 最后一帧（状态栏 [normal] 所在帧的剩余部分） */
function lastFrame(output: string): string {
  const start = output.lastIndexOf('[normal]');
  return start < 0 ? output : output.slice(start);
}

function lastFrameHas(output: string, text: string): boolean {
  return lastFrame(output).includes(text);
}

/** 断言弹层位于转录之后、Composer 页脚之前；状态栏在最顶 */
function expectOverlayAboveComposer(output: string): void {
  const f = lastFrame(output);
  const statusIdx = f.indexOf('[normal]');
  const transcriptIdx = f.indexOf('历史行');
  const modalIdx = f.indexOf('切换模式（/mode）');
  const composerIdx = f.indexOf('Enter 发送');
  expect(statusIdx).toBeGreaterThanOrEqual(0);
  expect(transcriptIdx).toBeGreaterThan(statusIdx); // 转录在状态栏之下
  expect(modalIdx).toBeGreaterThan(transcriptIdx); // 弹层不与状态栏相邻（转录夹在中间）
  expect(composerIdx).toBeGreaterThan(modalIdx); // 弹层在 Composer 上方
}

/** 最后一帧中可见的历史行数（转录视口大小的代理） */
function countHistoryLines(output: string): number {
  return (lastFrame(output).match(/历史行 \d+/g) ?? []).length;
}

/** 输入斜杠命令：/mode 等（写命令文本 → flush → Enter → flush，分开投递避免 \r 被当作字面量） */
async function typeCommand(t: ReturnType<typeof mountTui>, cmd: string): Promise<void> {
  t.write(cmd);
  await t.flush();
  t.write('\r');
  await t.flush();
}

describe('T3 /mode 弹层位置', () => {
  it('打开时渲染在输入框上方：状态栏 → 转录 → 弹层 → Composer，转录让出等量行', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = await mountShell(tr);
    try {
      const before = countHistoryLines(t.output());
      expect(before).toBeGreaterThan(15); // 初始转录 ~23 行

      await typeCommand(t, '/mode');
      await waitFor(() => lastFrameHas(t.output(), '切换模式（/mode）'), t.flush);

      const out = t.output();
      expectOverlayAboveComposer(out);
      expect(lastFrame(out)).toContain('normal'); // 模式选项可见
      expect(lastFrame(out)).toContain('plan');
      // 转录让出弹层高度（约 12 行）→ 可见历史行数显著减少，但贴尾仍在
      expect(countHistoryLines(out)).toBeLessThan(before - 5);
      expect(lastFrame(out)).toContain('历史行 39');
      expect(lastFrame(out)).toContain('Enter 发送'); // 输入框未被挤出屏幕
    } finally {
      t.unmount();
    }
  });

  it('Esc 关闭弹层，转录恢复高度，焦点回 Composer（输入进草稿）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = await mountShell(tr);
    try {
      await typeCommand(t, '/mode');
      await waitFor(() => lastFrameHas(t.output(), '切换模式（/mode）'), t.flush);
      const duringOverlay = countHistoryLines(t.output());

      t.write('\x1b'); // Esc 关闭
      await waitFor(() => !lastFrameHas(t.output(), '切换模式（/mode）'), t.flush);
      await waitFor(() => countHistoryLines(t.output()) > duringOverlay, t.flush);

      // 焦点回 Composer：输入 q 进草稿（若焦点仍被弹层占用则不会出现）
      const before = t.output().length;
      t.write('q');
      await waitFor(() => t.output().length > before, t.flush);
      expect(t.output().slice(before)).toContain('q');
    } finally {
      t.unmount();
    }
  });

  it('Enter 应用选中模式并关闭弹层', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = await mountShell(tr);
    try {
      await typeCommand(t, '/mode');
      await waitFor(() => lastFrameHas(t.output(), '切换模式（/mode）'), t.flush);
      t.write('\r'); // Enter 应用当前选中（缺省 normal）
      await waitFor(() => lastFrameHas(t.output(), '已切换模式'), t.flush);
      expect(lastFrame(t.output())).not.toContain('切换模式（/mode）');
      expect(lastFrame(t.output())).toContain('Enter 发送');
    } finally {
      t.unmount();
    }
  });
});

describe('T3 /sessions 弹层位置', () => {
  it('渲染在输入框上方且含会话计数', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = await mountShell(tr);
    try {
      await typeCommand(t, '/sessions');
      await waitFor(() => lastFrameHas(t.output(), '会话（/sessions）'), t.flush);
      const f = lastFrame(t.output());
      const sessionsIdx = f.indexOf('会话（/sessions）');
      expect(sessionsIdx).toBeGreaterThan(f.indexOf('[normal]'));
      expect(f.indexOf('Enter 发送')).toBeGreaterThan(sessionsIdx);
      expect(f).toContain('共 ');
      expect(f).toContain('个会话');
    } finally {
      t.unmount();
    }
  });
});

describe('T3 审批确认框位置', () => {
  it('经 InkShell dialog 渲染在输入框上方，Esc 关闭', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const dialog = createDialogController();
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={boot} dialog={dialog} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      dialog.open({
        render: (onClose) => (
          <ConfirmDialog
            question="允许执行 bash-1?"
            isActive
            onChoice={() => onClose()}
            onCancel={onClose}
          />
        ),
        resolve: () => undefined,
      });
      await waitFor(() => lastFrameHas(t.output(), '允许执行 bash-1?'), t.flush);
      const f = lastFrame(t.output());
      const qIdx = f.indexOf('允许执行 bash-1?');
      expect(qIdx).toBeGreaterThan(f.indexOf('[normal]'));
      expect(qIdx).toBeGreaterThan(f.indexOf('历史行')); // 不与状态栏相邻
      expect(f.indexOf('Enter 发送')).toBeGreaterThan(qIdx);
      // Esc 关闭 → 弹层消失，输入框仍在
      t.write('\x1b');
      await waitFor(() => !lastFrameHas(t.output(), '允许执行 bash-1?'), t.flush);
      expect(lastFrame(t.output())).toContain('Enter 发送');
    } finally {
      t.unmount();
    }
  });
});
