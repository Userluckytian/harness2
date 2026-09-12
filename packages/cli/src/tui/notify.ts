// notify.ts — 回合结束提醒（T4）。
// 策略（HARNESS2_NOTIFY）：always=总是发 / unfocused（缺省）=仅终端失焦时发 / never=不发。
// 方法（HARNESS2_NOTIFY_METHOD）：bel（缺省，\x07 终端响铃）/ osc9（\x1b]9;…\x07 终端通知）。
// - 写 stderr 且仅 TTY 时写（生产 sink）：BEL/OSC 不混入 ink 帧、不污染管道；
// - 焦点状态来自 T2 的 DECSET 1004 桥（不支持焦点事件的终端按「未失焦」保守处理 → unfocused 不响）；
// - Ctrl+C 取消回合（cancelled）不发提醒。
// 纯逻辑可单测：策略/方法解析、shouldNotify、emitNotify、onTurnComplete 均为纯函数/注入 sink。

export type NotifyPolicy = 'always' | 'unfocused' | 'never';
export type NotifyMethod = 'bel' | 'osc9';

const POLICIES: ReadonlySet<string> = new Set(['always', 'unfocused', 'never']);
const METHODS: ReadonlySet<string> = new Set(['bel', 'osc9']);

/** 解析 HARNESS2_NOTIFY；缺省/非法值 → unfocused（不抛错） */
export function resolveNotifyPolicy(env: Record<string, string | undefined>): NotifyPolicy {
  const v = env.HARNESS2_NOTIFY;
  return v !== undefined && POLICIES.has(v) ? (v as NotifyPolicy) : 'unfocused';
}

/** 解析 HARNESS2_NOTIFY_METHOD；缺省/非法值 → bel */
export function resolveNotifyMethod(env: Record<string, string | undefined>): NotifyMethod {
  const v = env.HARNESS2_NOTIFY_METHOD;
  return v !== undefined && METHODS.has(v) ? (v as NotifyMethod) : 'bel';
}

/** 策略判定：unfocused 仅在终端失焦时发；always 总是发；never 不发 */
export function shouldNotify(policy: NotifyPolicy, focused: boolean): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return !focused; // unfocused
}

/** 写提醒序列（sink 由调用方注入；生产 sink = stderr 且仅 TTY） */
export function emitNotify(method: NotifyMethod, write: (s: string) => void): void {
  if (method === 'bel') {
    write('\x07');
  } else {
    // osc9：终端通知（OSC 9;… 加 BEL 作字符串终止）
    write('\x1b]9;harness2: 回合完成\x07');
  }
}

/** 生产 sink：只写 stderr、且 stderr 为 TTY（非 TTY / 管道不发，避免污染输出） */
export function stderrSink(): (s: string) => void {
  return (s: string): void => {
    if (process.stderr.isTTY === true) process.stderr.write(s);
  };
}

export interface Notifier {
  /** turn 收尾后调用；cancelled = Ctrl+C 取消的回合（不发提醒） */
  onTurnComplete(opts: { focused: boolean; cancelled: boolean }): void;
}

/** 按环境变量构造提醒器（sink 注入便于测试） */
export function createNotifier(env: Record<string, string | undefined>, write: (s: string) => void): Notifier {
  const policy = resolveNotifyPolicy(env);
  const method = resolveNotifyMethod(env);
  return {
    onTurnComplete: ({ focused, cancelled }) => {
      if (cancelled) return;
      if (!shouldNotify(policy, focused)) return;
      emitNotify(method, write);
    },
  };
}
