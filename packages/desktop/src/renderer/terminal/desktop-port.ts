// Z9-3：桌面渲染端 `TerminalPort` 实现 —— 唯一数据源是 preload 暴露的 `window.harness2`
// （IPC `terminal:*` 命令 + `terminal:data`/`terminal:exit` 事件）。冻结契约 §1.3：
// 类型从 `@harness2/ui-shared/renderer/terminal/port.js` 导入（**不改 ui-shared**），
// 本文件只在桌面壳一侧实现该端口。
//
// available 语义（红线⑩）：桌面宿主恒为 true；但**构造时**若 IPC 通道缺失（jsdom 夹具 /
// 非桌面宿主）→ false，此时 UI 如实禁用、不创建 xterm、不摆假终端。缺失通道下方法
// 一律安全（write/resize no-op、close 立即 resolve、open 返回可读 reject），不抛崩调用方。
//
// 单例导出 `desktopTerminalPort`：组件要求 port 引用稳定（TerminalPanel 的 effect 依赖
// port 身份，每次新建会触发终端重建）；测试可另用 `createDesktopTerminalPort()` 造独立实例。
import type { TerminalPort } from '@harness2/ui-shared/renderer/terminal/port.js';
import type { Harness2Api, TerminalEventFrame } from '../../shared/protocol.js';

/**
 * 终端通道子集（**必填**签名；缺任一方法即视为通道不可用，与 platform.ts 的
 * 「缺 platform → null」同口径）。显式列出而非 Pick（Harness2Api 经 Partial<TerminalApi>
 * 并入，方法为可选；此处收窄成必填，供实现内部安全调用）。
 */
interface TerminalChannel {
  terminalOpen(opts: { cols: number; rows: number; cwd?: string }): Promise<{ id: string }>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalClose(id: string): Promise<void>;
  onTerminalEvent(listener: (frame: TerminalEventFrame) => void): () => void;
}

/** 取当前宿主的终端通道；非桌面 / 夹具缺通道 → null（不臆造能力） */
function resolveTerminalChannel(): TerminalChannel | null {
  if (typeof window === 'undefined') return null;
  const api = (window as { harness2?: Partial<Harness2Api> }).harness2;
  if (api === undefined) return null;
  const { terminalOpen, terminalWrite, terminalResize, terminalClose, onTerminalEvent } = api;
  if (
    typeof terminalOpen !== 'function' ||
    typeof terminalWrite !== 'function' ||
    typeof terminalResize !== 'function' ||
    typeof terminalClose !== 'function' ||
    typeof onTerminalEvent !== 'function'
  ) {
    return null;
  }
  return { terminalOpen, terminalWrite, terminalResize, terminalClose, onTerminalEvent };
}

/** 订阅工厂：把 TerminalEventFrame 分流给 data/exit 回调；卸载经返回函数退订 */
function subscribeChannel(channel: TerminalChannel, handle: (frame: TerminalEventFrame) => void): () => void {
  return channel.onTerminalEvent((frame) => {
    try {
      handle(frame);
    } catch {
      // 订阅者回调异常不反噬事件泵（与 main 侧 sendEvent 的防御同口径）
    }
  });
}

/**
 * 造一个桌面终端端口。
 * @returns 通道可用 → 转发型 TerminalPort；通道缺失 → available=false 的安全空实现。
 */
export function createDesktopTerminalPort(): TerminalPort {
  const channel = resolveTerminalChannel();
  if (channel === null) {
    return {
      available: false,
      open: () => Promise.reject(new Error('终端通道不可用（桌面 IPC 缺失）')),
      write: () => {
        // 无通道：如实 no-op，不抛（UI 不会在 available=false 时调用，此处仅兜底）
      },
      resize: () => {
        // 同上
      },
      close: () => Promise.resolve(),
      onData: () => () => {
        // 无通道：无事件可订，返回空退订
      },
      onExit: () => () => {
        // 同上
      },
    };
  }

  return {
    available: true,
    open: (opts) => channel.terminalOpen(opts),
    // fire-and-forget：IPC 结果由主进程裁决；渲染端不因写失败崩溃（PTY 已退出等竞态）
    write: (id, data) => {
      void channel.terminalWrite(id, data).catch(() => {});
    },
    resize: (id, cols, rows) => {
      void channel.terminalResize(id, cols, rows).catch(() => {});
    },
    close: (id) =>
      channel
        .terminalClose(id)
        .then(() => undefined)
        .catch(() => {
          // 关闭失败（已退出/竞态）：端口的 close 语义是「尽力回收」，不向 UI 抛
        }),
    onData: (cb) =>
      subscribeChannel(channel, (frame) => {
        if (frame.type === 'terminal:data') cb(frame.id, frame.data);
      }),
    onExit: (cb) =>
      subscribeChannel(channel, (frame) => {
        if (frame.type === 'terminal:exit') cb(frame.id, frame.exitCode);
      }),
  };
}

/** 稳定单例（组件 port 依赖；available 在模块加载时定一次，与桌面宿主能力一致） */
export const desktopTerminalPort: TerminalPort = createDesktopTerminalPort();
