// T4 审批：一个 turn 内两次顺序审批必须都能正确 resolve；新审批到来时旧挂起不得被静默丢弃。
// 复用 shell 的真实装配（createDialogController + OverlayHost 等价的订阅/同步 effect + ConfirmDialog）。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { createDialogController } from '../../src/tui/runInkChat.js';
import { ConfirmDialog } from '../../src/tui/ConfirmDialog.js';
import { mountTui } from './harness.js';

const ASK_CANCELLED = '\u0000ask-cancelled';

/** 与 runInkChat.InkShell 相同的 dialog → overlay 同步装配 */
function Harness({ dialog }: { dialog: ReturnType<typeof createDialogController> }): React.ReactElement {
  const [overlay, setOverlay] = React.useState<React.ReactNode>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => dialog.subscribe(() => setTick((t) => t + 1)), [dialog]);
  React.useEffect(() => {
    const req = dialog.getPending();
    if (req === null) return;
    setOverlay(
      req.render(() => {
        req.resolve();
        dialog.clear();
        setOverlay(null);
      }),
    );
  }, [dialog, tick]);
  return React.createElement(React.Fragment, null, overlay);
}

function makeAsk(dialog: ReturnType<typeof createDialogController>): (tool: string) => Promise<string> {
  return (tool: string) =>
    new Promise<string>((resolve) => {
      dialog.open({
        render: (onClose) => (
          <ConfirmDialog
            question={`允许执行 ${tool}?`}
            isActive
            onChoice={(choice) => {
              resolve(choice);
              onClose();
            }}
            onCancel={onClose}
          />
        ),
        resolve: () => resolve(ASK_CANCELLED),
      });
    });
}

describe('一个 turn 内两次顺序审批', () => {
  it('第一次 allow 后第二次 allow-always 各自正确 resolve', async () => {
    const dialog = createDialogController();
    const ask = makeAsk(dialog);
    const t = mountTui(React.createElement(Harness, { dialog }), { columns: 80, rows: 24 });
    try {
      await t.flush();
      const p1 = ask('bash-1');
      await t.flush();
      expect(t.output()).toContain('允许执行 bash-1?');
      t.write('y');
      await t.flush();
      await expect(p1).resolves.toBe('allow');

      const p2 = ask('bash-2');
      await t.flush();
      expect(t.output()).toContain('允许执行 bash-2?');
      t.write('a');
      await t.flush();
      await expect(p2).resolves.toBe('allow-always');
    } finally {
      t.unmount();
    }
  });

  it('第二次审批到来时首个未决挂起 resolve 为取消哨兵（不静默丢弃）', async () => {
    const dialog = createDialogController();
    const ask = makeAsk(dialog);
    const t = mountTui(React.createElement(Harness, { dialog }), { columns: 80, rows: 24 });
    try {
      await t.flush();
      const p1 = ask('tool-1');
      await t.flush();
      expect(t.output()).toContain('允许执行 tool-1?');
      const p2 = ask('tool-2'); // 旧挂起被 resolve（而非丢弃）
      await t.flush();
      await expect(p1).resolves.toBe(ASK_CANCELLED);
      expect(t.output()).toContain('允许执行 tool-2?');
      t.write('n');
      await t.flush();
      await expect(p2).resolves.toBe('deny');
    } finally {
      t.unmount();
    }
  });
});

// T5：审批弹窗在真实 InkShell（含 Composer）中渲染在输入框上方（复用 T3 位置规则）。
import { afterEach } from 'vitest';
import { InkShell } from '../../src/tui/runInkChat.js';
import { createTestRuntime, waitFor, type TestRuntime } from './shell-runtime.js';

const shellRuntimes: TestRuntime[] = [];
afterEach(async () => {
  while (shellRuntimes.length > 0) {
    const r = shellRuntimes.pop();
    await r?.cleanup();
  }
});

describe('T5 审批弹窗位置（InkShell 集成）', () => {
  it('ConfirmDialog 渲染在输入行上方，Esc 拒绝并关闭', async () => {
    const tr = await createTestRuntime();
    shellRuntimes.push(tr);
    const dialog = createDialogController();
    const t = mountTui(
      <InkShell runtime={tr.runtime} bootLines={['历史行 0']} dialog={dialog} onExit={() => undefined} />,
      { columns: 100, rows: 30 },
    );
    try {
      await t.flush();
      dialog.open({
        render: (onClose) => (
          <ConfirmDialog question="允许执行 bash-1?" isActive onChoice={() => onClose()} onCancel={onClose} />
        ),
        resolve: () => undefined,
      });
      await waitFor(() => t.output().lastIndexOf('需要审批') > 0, t.flush);
      const out = t.output();
      // 弹窗标题与问题都在 Composer 输入行（'> '）之前（同一最后一帧内比较）
      expect(out.lastIndexOf('需要审批')).toBeGreaterThan(out.lastIndexOf('历史行'));
      expect(out.lastIndexOf('允许执行 bash-1?')).toBeGreaterThan(out.lastIndexOf('历史行'));
      expect(out.lastIndexOf('> ')).toBeGreaterThan(out.lastIndexOf('允许执行 bash-1?'));
      expect(out.lastIndexOf('Enter 发送')).toBeGreaterThan(out.lastIndexOf('> '));
      // Esc = 拒绝并关闭（最后一帧中弹窗消失）
      t.write('\x1b');
      const before = t.output().length;
      await waitFor(() => t.output().length > before, t.flush);
      const tail = t.output().slice(t.output().lastIndexOf('历史行'));
      expect(tail).not.toContain('需要审批');
      expect(tail).toContain('Enter 发送');
    } finally {
      t.unmount();
    }
  });
});
