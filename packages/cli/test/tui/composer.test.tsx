// T0 Composer 虚拟 TTY 集成测试：忙时仍可编辑/发送/取消；空闲 Ctrl+C 提示不污染 draft；退出协议。
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Composer } from '../../src/tui/Composer.js';
import { mountTui } from './harness.js';

describe('Composer（T0 忙时草稿/取消/退出）', () => {
  it('(a) 忙时输入仍编辑草稿：渲染输出出现所输入文本', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer busy active onSend={onSend} onExit={() => undefined} />);
    try {
      t.write('hello');
      await t.flush();
      expect(t.output()).toContain('hello');
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      t.unmount();
    }
  });

  it('(b) 忙时 Esc 调用 onAbort', async () => {
    const onAbort = vi.fn();
    const t = mountTui(<Composer busy active onSend={() => undefined} onExit={() => undefined} onAbort={onAbort} />);
    try {
      t.write('\x1b');
      await t.flush();
      expect(onAbort).toHaveBeenCalledTimes(1);
    } finally {
      t.unmount();
    }
  });

  it('(c) 忙时 Enter 以草稿内容调用 onSend（排队/执行由上层决定）', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer busy active onSend={onSend} onExit={() => undefined} />);
    try {
      t.write('hi');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('hi');
    } finally {
      t.unmount();
    }
  });

  it('(d) 空闲首次 Ctrl+C 只提示、不污染 draft：随后输入 x 回车，onSend 收到恰好 x', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer active onSend={onSend} onExit={() => undefined} />);
    try {
      t.write('\x03');
      await t.flush();
      expect(t.output()).toContain('再按一次 Ctrl+C 退出');
      t.write('x');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('x');
    } finally {
      t.unmount();
    }
  });

  it('(e) 空闲窗口内两次 Ctrl+C 调用 onExit（sigint）', async () => {
    const onExit = vi.fn();
    const t = mountTui(<Composer active onSend={() => undefined} onExit={onExit} />);
    try {
      t.write('\x03');
      await t.flush();
      t.write('\x03');
      await t.flush();
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith('sigint');
    } finally {
      t.unmount();
    }
  });

  it('忙时页脚提示展示取消/排队文案与队列长度', async () => {
    const t = mountTui(<Composer busy active queuedCount={2} onSend={() => undefined} onExit={() => undefined} />);
    try {
      await t.flush();
      expect(t.output()).toContain('Esc 停止当前 turn');
      expect(t.output()).toContain('Enter 排队');
      expect(t.output()).toContain('已排队 2 条');
    } finally {
      t.unmount();
    }
  });

  it('空闲 Esc 仍清空草稿（不触发 onAbort）', async () => {
    const onAbort = vi.fn();
    const onSend = vi.fn();
    const t = mountTui(<Composer active onSend={onSend} onExit={() => undefined} onAbort={onAbort} />);
    try {
      t.write('abc');
      await t.flush();
      t.write('\x1b');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onAbort).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled(); // draft 已清空，回车无内容
    } finally {
      t.unmount();
    }
  });

  it('行尾反斜杠续行不发送', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer active onSend={onSend} onExit={() => undefined} />);
    try {
      t.write('a\\');
      await t.flush();
      t.write('\r');
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('a¶');
    } finally {
      t.unmount();
    }
  });

  it('Shift+Enter（kitty CSI-u）插入换行而不发送', async () => {
    const onSend = vi.fn();
    const t = mountTui(<Composer active onSend={onSend} onExit={() => undefined} />);
    try {
      t.write('a');
      await t.flush();
      t.write('\x1b[13;2u');
      await t.flush();
      t.write('b');
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('a¶');
    } finally {
      t.unmount();
    }
  });

  it('空草稿 Ctrl+D 调用 onExit（eof）', async () => {
    const onExit = vi.fn();
    const t = mountTui(<Composer active onSend={() => undefined} onExit={onExit} />);
    try {
      t.write('\x04');
      await t.flush();
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith('eof');
    } finally {
      t.unmount();
    }
  });
});
