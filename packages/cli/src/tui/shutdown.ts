// shutdown：退出/取消的幂等控制器 + Ctrl+C 协议状态机（纯逻辑，无 ink/React 依赖，可单测）。
// 设计约束（T0）：
//  - request() 只第一次生效；并发重复调用不得重复 finish/exit。
//  - finish() 即使 reject，awaitDone() 也须以 1 收敛，且不产生 unhandled rejection。
//  - Ctrl+C：忙时取消当前 turn；空闲时首按 pending（提示），窗口内二按 confirm。

export type ExitReason = 'exit' | 'sigint' | 'eof' | 'error';

/** 退出码映射：正常退出/EOF → 0；SIGINT → 130；异常 → 1 */
const EXIT_CODE: Record<ExitReason, number> = {
  exit: 0,
  eof: 0,
  sigint: 130,
  error: 1,
};

export interface ShutdownOptions {
  /** 执行 runtime.finish + unmount；可能 reject */
  finish: () => Promise<void>;
  /** 由调用方注入（测试可捕获）；生产实现通常写 process.exitCode */
  exit: (code: number) => void;
  /** 可注入时钟（保留给调用方做超时/时间戳扩展） */
  now?: () => number;
}

export interface ShutdownController {
  /** 幂等：仅首次调用生效；后续调用为 no-op。首次返回 true。 */
  request(reason: ExitReason): boolean;
  isShuttingDown(): boolean;
  /** 当前生效的退出码（reason 映射：exit/eof→0、sigint→130、error→1） */
  readonly code: number;
  /** 在 finish() 落定（仅一次）后以最终退出码 resolve */
  awaitDone(): Promise<number>;
}

export function createShutdown(opts: ShutdownOptions): ShutdownController {
  let started = false;
  let finalCode = 0;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const run = async (): Promise<void> => {
    let code = finalCode;
    try {
      await opts.finish();
    } catch {
      code = 1; // finish 失败：以异常码收敛，避免 unhandled rejection
    }
    finalCode = code;
    try {
      opts.exit(code);
    } catch {
      // exit 钩子异常不阻塞 awaitDone 收敛
    }
    resolveDone(code);
  };

  return {
    request(reason) {
      if (started) return false;
      started = true;
      finalCode = EXIT_CODE[reason];
      void run();
      return true;
    },
    isShuttingDown: () => started,
    get code() {
      return finalCode;
    },
    awaitDone: () => done,
  };
}

export interface CtrlCGuard {
  /** busy => 'cancel'（取消 turn）；空闲首按窗口内 => 'pending'，窗口内二按 => 'confirm' */
  press(ctx: { busy: boolean }): 'cancel' | 'pending' | 'confirm';
  reset(): void;
}

const DEFAULT_CTRL_C_WINDOW_MS = 2000;

export function createCtrlCGuard(opts?: { now?: () => number; windowMs?: number }): CtrlCGuard {
  const now = opts?.now ?? (() => Date.now());
  const windowMs = opts?.windowMs ?? DEFAULT_CTRL_C_WINDOW_MS;
  let lastAt: number | null = null;

  return {
    press({ busy }) {
      if (busy) {
        lastAt = null; // 忙时取消，退出协议重新计
        return 'cancel';
      }
      const t = now();
      if (lastAt !== null && t - lastAt < windowMs) {
        lastAt = null;
        return 'confirm';
      }
      lastAt = t;
      return 'pending';
    },
    reset() {
      lastAt = null;
    },
  };
}
