// T5 steer 输入接线（Composer 层）：忙时 Ctrl+S 把当前草稿作为 steer 提交，页脚显示提交结论；
// 草稿始终保留（unknown/stale 必须保草稿，最终 resolution 由上层 observeSteer 报告）。
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Composer } from '../../src/tui/Composer.js';
import { mountTui } from './harness.js';

const CTRL_S = '\x13';

describe('T5 Composer Ctrl+S：草稿作为 steer 提交且不丢草稿', () => {
  it('Ctrl+S 调用 onSteer(草稿)，页脚显示返回文案；草稿仍在输入框', async () => {
    const onSteer = vi.fn((text: string) => `steer 已提交（${text}；草稿保留）`);
    const t = mountTui(<Composer busy active onSend={() => undefined} onExit={() => undefined} onSteer={onSteer} />, {
      columns: 80,
    });
    try {
      t.write('调整一下');
      await t.flush();
      t.write(CTRL_S);
      await t.flush();
      expect(onSteer).toHaveBeenCalledWith('调整一下');
      expect(t.output()).toContain('steer 已提交（调整一下；草稿保留）');
      // 草稿未被清空
      expect(t.output()).toContain('调整一下');
    } finally {
      t.unmount();
    }
  });

  it('未提供 onSteer：Ctrl+S 无副作用（不崩溃、不发送）', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer busy active onSend={onSend} onExit={() => undefined} />, { columns: 80 });
    try {
      t.write('abc');
      await t.flush();
      t.write(CTRL_S);
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('abc');
    } finally {
      t.unmount();
    }
  });
});
