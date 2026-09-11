// T2 粘贴集成测试（虚拟 TTY）：注入 bracketed paste（\x1b[200~ ... \x1b[201~），
// 断言：分片/多行粘贴是一次原子插入（不触发多次提交）、内嵌换行不当作提交键、
// Enter 提交时 onSend 收到归一后的完整原文（不是 chip 占位/截断值）、
// 内容为 /exit 的粘贴不会自动执行命令。
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Composer } from '../../src/tui/Composer.js';
import { mountTui } from './harness.js';

/** 包成 bracketed paste 序列（ink usePaste 自动开启 bracketed paste 后按此投递） */
function bracketedPaste(content: string): string {
  return `\x1b[200~${content}\x1b[201~`;
}

function mountComposer() {
  const onSend = vi.fn();
  const t = mountTui(<Composer active onSend={onSend} onExit={() => undefined} />);
  return { t, onSend };
}

describe('Composer T2 粘贴：原子插入与 chip', () => {
  it('多行 CRLF 粘贴 → 单个 chip，不自动提交；Enter 后 onSend 收到完整归一原文', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('line1\r\nline2'));
      await t.flush();
      // 内嵌换行没有触发提交
      expect(onSend).not.toHaveBeenCalled();
      // 渲染为 chip 占位标签（draft 不展示大段正文）
      expect(t.output()).toContain('[粘贴 #1');
      expect(t.output()).not.toContain('line1');
      // 显式 Enter 才提交，且是完整原文（CRLF 已归一为 LF，未截断）
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('line1\nline2');
    } finally {
      t.unmount();
    }
  });

  it('短单行粘贴原子插入，不在粘贴时提交；Enter 后原样发送', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('hello world'));
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('hello world');
      t.write('\r');
      await t.flush();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('hello world');
    } finally {
      t.unmount();
    }
  });

  it('粘贴内容为 /exit 时不自动执行命令（onSend 未被调用）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('/exit'));
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('/exit');
    } finally {
      t.unmount();
    }
  });

  it('含换行的 /exit 粘贴同样不触发命令（成为 chip）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('/exit\r\n'));
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('[粘贴 #1');
    } finally {
      t.unmount();
    }
  });

  it('连续两次粘贴得到两个不同 chip 标签（#1 / #2）', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('a\r\nb'));
      await t.flush();
      t.write(bracketedPaste('c\r\nd'));
      await t.flush();
      expect(t.output()).toContain('[粘贴 #1');
      expect(t.output()).toContain('[粘贴 #2');
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      t.unmount();
    }
  });

  it('超过 1MB 的粘贴被拒绝：不插入、页脚给出可读提示、回车也不发送', async () => {
    const { t, onSend } = mountComposer();
    try {
      t.write(bracketedPaste('a'.repeat(1024 * 1024 + 1)));
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
      expect(t.output()).toContain('粘贴被拒绝');
      expect(t.output()).toContain('1MB');
      t.write('\r');
      await t.flush();
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      t.unmount();
    }
  });
});
