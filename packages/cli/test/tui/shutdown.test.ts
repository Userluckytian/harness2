// T0 退出控制器单测：幂等 request、退出码映射、finish reject 收敛、Ctrl+C 协议状态机。
import { describe, expect, it, vi } from 'vitest';
import { bindShutdownSignals, createShutdown, createCtrlCGuard, type ExitReason } from '../../src/tui/shutdown.js';

describe('createShutdown（幂等退出控制器）', () => {
  it('并发两次 request：finish 只调一次、exit 只调一次', async () => {
    let finishCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exits: number[] = [];
    const c = createShutdown({
      finish: async () => {
        finishCalls += 1;
        await gate;
      },
      exit: (code) => exits.push(code),
    });

    expect(c.request('exit')).toBe(true);
    expect(c.request('sigint')).toBe(false); // 第二次被拒
    expect(c.request('error')).toBe(false);
    expect(c.isShuttingDown()).toBe(true);
    expect(finishCalls).toBe(1);
    expect(exits).toEqual([]); // finish 未落定前不 exit

    release();
    await expect(c.awaitDone()).resolves.toBe(0); // 首次 reason 生效
    expect(finishCalls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('request 首次返回 true、再次返回 false；未请求时 isShuttingDown=false', () => {
    const c = createShutdown({ finish: async () => undefined, exit: () => undefined });
    expect(c.isShuttingDown()).toBe(false);
    expect(c.request('eof')).toBe(true);
    expect(c.request('eof')).toBe(false);
  });

  it.each([
    ['exit', 0],
    ['eof', 0],
    ['sigint', 130],
    ['sigterm', 143],
    ['sighup', 129],
    ['error', 1],
  ] as const)('退出码映射：%s → %i', async (reason, code) => {
    const c = createShutdown({ finish: async () => undefined, exit: () => undefined });
    c.request(reason as ExitReason);
    await expect(c.awaitDone()).resolves.toBe(code);
    expect(c.code).toBe(code);
  });

  it('exit 恰好在 finish 落定后调用一次', async () => {
    const order: string[] = [];
    const c = createShutdown({
      finish: async () => {
        order.push('finish');
      },
      exit: () => order.push('exit'),
    });
    c.request('sigint');
    await c.awaitDone();
    expect(order).toEqual(['finish', 'exit']);
  });

  it('finish reject：awaitDone 解析为 1，且不产生 unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown): void => {
      rejections.push(r);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const exits: number[] = [];
      const c = createShutdown({
        finish: () => Promise.reject(new Error('finish boom')),
        exit: (code) => exits.push(code),
      });
      c.request('exit');
      await expect(c.awaitDone()).resolves.toBe(1);
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(exits).toEqual([1]);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('exit 钩子抛异常仍能以对应码收敛 awaitDone', async () => {
    const c = createShutdown({
      finish: async () => undefined,
      exit: () => {
        throw new Error('exit boom');
      },
    });
    c.request('exit');
    await expect(c.awaitDone()).resolves.toBe(0);
  });
});

describe('bindShutdownSignals（SIGTERM/SIGHUP 复用幂等退出路径）', () => {
  /** 记录 on/off 的假 process（不碰真实进程信号） */
  function fakeProc() {
    const on: Array<{ name: string; handler: () => void }> = [];
    const off: Array<{ name: string; handler: () => void }> = [];
    const proc = {
      on: (name: NodeJS.Signals, handler: () => void) => {
        on.push({ name, handler });
      },
      off: (name: NodeJS.Signals, handler: () => void) => {
        off.push({ name, handler });
      },
    };
    return { proc: proc as unknown as Pick<NodeJS.Process, 'on' | 'off'>, on, off };
  }

  it('挂载 SIGTERM/SIGHUP 各一次；触发即以对应 reason 走幂等 request', async () => {
    const { proc, on } = fakeProc();
    const reasons: ExitReason[] = [];
    const c = createShutdown({
      finish: async () => undefined,
      exit: () => undefined,
    });
    const detach = bindShutdownSignals((reason) => {
      reasons.push(reason);
      c.request(reason);
    }, proc);
    expect(on.map((h) => h.name)).toEqual(['SIGTERM', 'SIGHUP']);

    // 幂等：SIGTERM 触发真正收敛；随后到达的 SIGHUP 只记录、不再改变退出码
    on[0]!.handler();
    on[1]!.handler();
    expect(reasons).toEqual(['sigterm', 'sighup']);
    await expect(c.awaitDone()).resolves.toBe(143); // SIGTERM → 143（128+15）

    detach();
  });

  it('SIGTERM 请求后 awaitDone 以 143 收敛；SIGHUP 以 129 收敛（独立控制器）', async () => {
    const hup = createShutdown({ finish: async () => undefined, exit: () => undefined });
    hup.request('sighup');
    await expect(hup.awaitDone()).resolves.toBe(129);
  });

  it('detach 解绑全部信号监听（off 与 on 一一对应）', () => {
    const { proc, on, off } = fakeProc();
    const detach = bindShutdownSignals(() => undefined, proc);
    expect(off).toHaveLength(0);
    detach();
    expect(off).toHaveLength(on.length);
    expect(off.map((h) => h.name)).toEqual(['SIGTERM', 'SIGHUP']);
    // 解绑后触发不再进入 request（handler 已从假 proc 移除；直接调用旧引用也应无害——幂等）
    expect(() => on[0]!.handler()).not.toThrow();
  });

  it('默认注入真实 process：on/off 均被调用且可安全解绑', () => {
    const onSpy = vi.spyOn(process, 'on');
    const offSpy = vi.spyOn(process, 'off');
    const detach = bindShutdownSignals(() => undefined);
    expect(onSpy.mock.calls.filter(([n]) => n === 'SIGTERM' || n === 'SIGHUP')).toHaveLength(2);
    detach();
    expect(offSpy.mock.calls.filter(([n]) => n === 'SIGTERM' || n === 'SIGHUP')).toHaveLength(2);
    onSpy.mockRestore();
    offSpy.mockRestore();
  });
});

describe('createCtrlCGuard（Ctrl+C 协议状态机）', () => {
  it('忙时任意次按都返回 cancel', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: true })).toBe('cancel');
    t = 100;
    expect(g.press({ busy: true })).toBe('cancel');
  });

  it('空闲：首按 pending，窗口内二按 confirm', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: false })).toBe('pending');
    t = 1500;
    expect(g.press({ busy: false })).toBe('confirm');
  });

  it('窗口过期：再次按回到 pending', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: false })).toBe('pending');
    t = 3000;
    expect(g.press({ busy: false })).toBe('pending');
  });

  it('confirm 之后再次按重新进入 pending 协议', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: false })).toBe('pending');
    t = 100;
    expect(g.press({ busy: false })).toBe('confirm');
    t = 200;
    expect(g.press({ busy: false })).toBe('pending');
  });

  it('reset 清除窗口内状态', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: false })).toBe('pending');
    g.reset();
    t = 100;
    expect(g.press({ busy: false })).toBe('pending');
  });

  it('忙时 cancel 会重置退出协议（随后空闲首按为 pending）', () => {
    let t = 0;
    const g = createCtrlCGuard({ now: () => t, windowMs: 2000 });
    expect(g.press({ busy: false })).toBe('pending');
    t = 100;
    expect(g.press({ busy: true })).toBe('cancel');
    t = 200;
    expect(g.press({ busy: false })).toBe('pending');
  });
});
