// Z9-5：web 壳 `TerminalPort` 实现 —— 唯一数据源是 serve 的 WS 通道（`terminal/*` 八帧）。
//
// 契约：`@harness2/ui-shared/renderer/terminal/port.js`（冻结接口，不改 ui-shared）。
// 传输：沿用既有 `serve-client` 的发送/订阅形态（`sendTerminalOp` 复用 `send`；`onTerminalFrame`
// 复用同一 `frameListeners` 泵）。客户端帧判别字段是 **`op`**、服务端帧是 **`type`**（§1.2 实施修正）。
//
// available 语义（红线⑩）：只有当 WS 连上 serve（`status() === 'connected'`）才为 true；
// 未连接 / serve 不可达 → false，UI 如实禁用、不创建 xterm、不摆假终端。`available` 是 getter，
// 反映**实时**连接状态（席位内容会随状态重渲染后重新读取）。
//
// 错误如实（§1.2）：`terminal/error` 带 requestId（open 失败）→ open 的 Promise 如实 reject；
// 带 id（input/resize/close 未知或跨连接）→ 无 UI 落点，本端口如实忽略（不伪装成功，
// 也不把错误画成正正常输出）。
import type { ConnectionStatus } from '@harness2/ui-shared/shared/protocol.js';
import type { TerminalPort } from '@harness2/ui-shared/renderer/terminal/port.js';
import type { TerminalClientOp, TerminalServerFrame } from '../serve-client.js';

/**
 * 端口依赖的最小 WS 面（真实现 = `ServeClient`；测试注入轻量替身，无需实现整个 HarnessClient）。
 */
export interface WebTerminalChannel {
  status(): ConnectionStatus;
  sendTerminalOp(op: TerminalClientOp): void;
  onTerminalFrame(listener: (frame: TerminalServerFrame) => void): () => void;
}

/** 无通道（未接入 serve WS / 测试未注入）→ available=false 的安全空实现（红线⑩） */
export const UNAVAILABLE_WEB_TERMINAL_PORT: TerminalPort = {
  available: false,
  open: () => Promise.reject(new Error('终端通道不可用（web 未接入 serve WS）')),
  write: () => {
    // 无通道：如实 no-op（UI 不会在 available=false 时调用）
  },
  resize: () => {
    // 同上
  },
  close: () => Promise.resolve(),
  onData: () => () => {
    // 无通道：无事件可订
  },
  onExit: () => () => {
    // 同上
  },
};

/**
 * 造一个 web 终端端口（基于 serve 的 WS 通道）。
 * @param channel - WS 发送/订阅面（真实现 = ServeClient）。
 * @returns 通道可用时转发型 TerminalPort；`available` 随连接状态实时变化。
 */
export function createWebTerminalPort(channel: WebTerminalChannel): TerminalPort {
  let nextRequestId = 1;
  const pending = new Map<string, { resolve: (v: { id: string }) => void; reject: (e: Error) => void }>();
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, exitCode: number | undefined) => void>();

  // 单订阅分发：opened 结算 open、data/exit 广播给订阅者；error 按 requestId 如实 reject。
  channel.onTerminalFrame((frame) => {
    switch (frame.type) {
      case 'terminal/opened': {
        const waiter = pending.get(frame.requestId);
        if (waiter !== undefined) {
          pending.delete(frame.requestId);
          waiter.resolve({ id: frame.id });
        }
        break;
      }
      case 'terminal/data': {
        for (const cb of [...dataListeners]) cb(frame.id, frame.data);
        break;
      }
      case 'terminal/exit': {
        for (const cb of [...exitListeners]) cb(frame.id, frame.exitCode);
        break;
      }
      case 'terminal/error': {
        if (frame.requestId !== undefined) {
          const waiter = pending.get(frame.requestId);
          if (waiter !== undefined) {
            pending.delete(frame.requestId);
            waiter.reject(new Error(frame.error));
          }
        }
        // 带 id 的 error（input/resize/close 未知/跨连接）：无 UI 落点，如实忽略，不伪装成功。
        break;
      }
    }
  });

  return {
    get available(): boolean {
      return channel.status() === 'connected';
    },
    open: (opts) =>
      new Promise<{ id: string }>((resolve, reject) => {
        const requestId = String(nextRequestId);
        nextRequestId += 1;
        pending.set(requestId, { resolve, reject });
        try {
          channel.sendTerminalOp({
            op: 'terminal/open',
            requestId,
            cols: opts.cols,
            rows: opts.rows,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          });
        } catch (e) {
          // WS 未连接：立即如实失败（不留悬挂 pending）
          pending.delete(requestId);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }),
    // fire-and-forget：与服务端裁决解耦（终端已退出等竞态不反噬 UI）；未连接时如实 no-op
    write: (id, data) => {
      try {
        channel.sendTerminalOp({ op: 'terminal/input', id, data });
      } catch {
        // 未连接：如实丢弃（UI 仅在 available 时调用）
      }
    },
    resize: (id, cols, rows) => {
      try {
        channel.sendTerminalOp({ op: 'terminal/resize', id, cols, rows });
      } catch {
        // 同上
      }
    },
    // close 语义 = 尽力回收：无 ack，发送后立即 resolve（WS 未连接 → 直接 resolve）
    close: (id) => {
      try {
        channel.sendTerminalOp({ op: 'terminal/close', id });
      } catch {
        // 未连接：无需回收
      }
      return Promise.resolve();
    },
    onData: (cb) => {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
  };
}
