// PD8（D-P2）：关窗口对话框接线自动化测试。
// main.ts 的 win.on('close') 处理器提取为 createCloseWindowHandler（依赖注入：runtime/弹窗/
// 最小化/停止请求/关闭/定时器），此处用注入桩驱动**真实处理代码**覆盖四类决策语义：
//   不 busy 直接关 / keep-running=最小化 / request-stop=先 stop-all 再关 / cancel=保持打开；
//   另覆盖：弹窗失败保守不关、stoppingForClose 防重复弹窗、弹窗文案/按钮顺序真实。
// 真实 BrowserWindow 事件与系统对话框（Electron 真窗自动化）仍属真机项——Playwright Electron
// 不在依赖集内，且启动真窗口会干扰用户同时间的真机验收（施工单 §1 影响控制）。
import { describe, expect, it, vi } from 'vitest';
import { CLOSE_DIALOG_BUTTONS, closeDialogMessage } from '../src/shared/close-window.js';
import {
  createCloseWindowHandler,
  type CloseDialogOptions,
  type CloseWindowDeps,
} from '../src/main/close-window-handler.js';

function makeDeps(busy: boolean): CloseWindowDeps & {
  respond: (response: number) => void;
  failDialog: (e: Error) => void;
  calls: {
    preventDefault: number;
    minimize: number;
    stopAll: number;
    close: number;
    dialogs: Array<CloseDialogOptions>;
  };
  flushClose: () => void;
} {
  let resolveDialog: ((r: { response: number }) => void) | undefined;
  let rejectDialog: ((e: Error) => void) | undefined;
  const calls = { preventDefault: 0, minimize: 0, stopAll: 0, close: 0, dialogs: [] as Array<CloseDialogOptions> };
  const scheduled: Array<() => void> = [];
  const deps: CloseWindowDeps = {
    runtime: () => ({ busy, runningTurns: 2, backgroundTasks: 1 }),
    showDialog: (opts) => {
      calls.dialogs.push(opts);
      return new Promise((resolve, reject) => {
        resolveDialog = resolve;
        rejectDialog = reject;
      });
    },
    minimize: () => {
      calls.minimize += 1;
    },
    requestStopAll: () => {
      calls.stopAll += 1;
    },
    close: () => {
      calls.close += 1;
    },
    scheduleClose: (fn) => {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  };
  return {
    ...deps,
    respond: (response) => resolveDialog?.({ response }),
    failDialog: (e) => rejectDialog?.(e),
    calls,
    flushClose: () => {
      for (const fn of scheduled.splice(0)) fn();
    },
  };
}

const preventDefault = (): void => undefined;

describe('createCloseWindowHandler（D4 关窗口接线，PD8 自动化）', () => {
  it('无运行中工作：直接放行（不 preventDefault、不弹窗）', () => {
    const deps = makeDeps(false);
    const handler = createCloseWindowHandler(deps);
    handler({ preventDefault });
    expect(deps.calls.preventDefault).toBe(0);
    expect(deps.calls.dialogs).toHaveLength(0);
    expect(deps.calls.close).toBe(0);
  });

  it('busy + 保持后台运行：阻止默认 → 最小化（进程/serve 继续），不 close', async () => {
    const deps = makeDeps(true);
    const handler = createCloseWindowHandler(deps);
    const ev = {
      preventDefault: () => {
        deps.calls.preventDefault += 1;
      },
    };
    handler(ev);
    expect(deps.calls.preventDefault).toBe(1);
    expect(deps.calls.dialogs).toHaveLength(1);
    deps.respond(0); // CLOSE_DIALOG_BUTTONS[0] = keep-running
    await Promise.resolve(); // 让 .then 决策链落地
    expect(deps.calls.minimize).toBe(1);
    expect(deps.calls.close).toBe(0);
    expect(deps.calls.stopAll).toBe(0); // 后台运行：不请求停止
  });

  it('busy + 请求停止并退出：阻止默认 → 先 stopAll 一次 → 定时 close', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps(true);
      const handler = createCloseWindowHandler(deps);
      handler({
        preventDefault: () => {
          deps.calls.preventDefault += 1;
        },
      });
      deps.respond(1); // CLOSE_DIALOG_BUTTONS[1] = request-stop
      await Promise.resolve(); // 让 .then 决策链落地
      expect(deps.calls.stopAll).toBe(1);
      expect(deps.calls.close).toBe(0);
      deps.flushClose(); // 400ms 宽限后（vi timers 用注入 scheduleClose 直接驱动）
      expect(deps.calls.close).toBe(1);
      expect(deps.calls.minimize).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('busy + 取消：保持打开（不关、不停、不最小化）', async () => {
    const deps = makeDeps(true);
    const handler = createCloseWindowHandler(deps);
    handler({
      preventDefault: () => {
        deps.calls.preventDefault += 1;
      },
    });
    deps.respond(2); // CLOSE_DIALOG_BUTTONS[2] = cancel
    await Promise.resolve(); // 让 .then 决策链落地
    expect(deps.calls.preventDefault).toBe(1);
    expect(deps.calls.minimize).toBe(0);
    expect(deps.calls.stopAll).toBe(0);
    expect(deps.calls.close).toBe(0);
    deps.flushClose();
    expect(deps.calls.close).toBe(0);
  });

  it('弹窗失败（reject）：保守不关闭（不静默丢弃运行中任务）', async () => {
    const deps = makeDeps(true);
    const handler = createCloseWindowHandler(deps);
    handler({
      preventDefault: () => {
        deps.calls.preventDefault += 1;
      },
    });
    deps.failDialog(new Error('dialog unavailable'));
    await Promise.resolve(); // 让 catch 落地
    deps.flushClose();
    expect(deps.calls.close).toBe(0);
    expect(deps.calls.stopAll).toBe(0);
  });

  it('防重复弹窗：stop-all 流程中再次 close 不重弹（stoppingForClose 幂等）', async () => {
    const deps = makeDeps(true);
    const handler = createCloseWindowHandler(deps);
    const ev = {
      preventDefault: () => {
        deps.calls.preventDefault += 1;
      },
    };
    handler(ev);
    deps.respond(1); // request-stop → stoppingForClose = true
    await Promise.resolve();
    handler(ev); // 400ms 宽限窗口内用户/系统再次触发 close
    expect(deps.calls.dialogs).toHaveLength(1); // 不重复弹窗
    expect(deps.calls.preventDefault).toBe(1); // 第二次放行默认关闭
    expect(deps.calls.stopAll).toBe(1); // 不重复请求停止
  });

  it('弹窗文案与按钮顺序真实（与 shared/close-window 契约一致）', () => {
    const deps = makeDeps(true);
    const handler = createCloseWindowHandler(deps);
    handler({ preventDefault: () => undefined });
    expect(deps.calls.dialogs[0]?.message).toBe(closeDialogMessage(2, 1));
    expect(deps.calls.dialogs[0]?.buttons).toEqual(CLOSE_DIALOG_BUTTONS.map((b) => b.label));
    expect(deps.calls.dialogs[0]?.cancelId).toBe(2);
    expect(deps.calls.dialogs[0]?.defaultId).toBe(0);
  });
});
