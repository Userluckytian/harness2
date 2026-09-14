// P3-F（G-34）ink 壳侧：Ctrl+R = 会话选择器（复用 /sessions 无参的同一 openSessions 浮层）。
// 真机语义：G-34「welcome 屏与会话内皆开」——ink 壳空闲态 Ctrl+R 直接拉起会话列表浮层。
// 差异登记（本文件只钉空闲分支）：ink 的 busy 期 Ctrl+R 已被 T8「推理折叠块展开/收起」占用
// （T0 起 Composer 忙时接管普通输入，推理键只能挑 Ctrl+R），故 busy 期保持推理键语义；
// 无冲突的 next 壳（G-34 主实现）两窗格皆为会话选择器，见 p3f-agent-keys.test.ts。
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { createDialogController, InkShell } from '../../src/tui/runInkChat.js';
import { mountTui } from './harness.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop();
    await r?.cleanup();
  }
});

const CTRL_R = '\x12'; // Ctrl+R

describe('P3-F ink G-34：Ctrl+R 拉起会话选择器', () => {
  it('空闲态 Ctrl+R → 渲染「会话（/sessions）」浮层（与 /sessions 无参同一实现）+ Esc 关闭', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const t = mountTui(
      <InkShell
        runtime={tr.runtime}
        bootLines={['会话: test（新建）']}
        dialog={createDialogController()}
        onExit={() => undefined}
        onTranscriptChange={() => undefined}
      />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      expect(t.output()).not.toContain('会话（/sessions）');
      t.write(CTRL_R);
      await waitFor(() => t.output().includes('会话（/sessions）'), t.flush);
      expect(t.output()).toContain('会话（/sessions）'); // 列表浮层真实出现（非空壳）
      expect(t.output()).toContain('Esc 关闭'); // 浮层提示行（复用 openSessions 的 Modal）
      // Esc 关闭：键盘交还 composer（浮层消失的实证 = 后续字符进草稿而非被浮层吞掉）
      t.write('\x1b');
      await t.flush();
      t.write('abc');
      await t.flush();
      expect(t.output()).toContain('abc'); // 字符已进草稿（浮层已关）
    } finally {
      t.unmount();
    }
  });
});
