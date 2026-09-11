// 虚拟 TTY ink 挂载助手（非 .test 文件，故不会被 vitest 收集；仅测试引用）。
// 用 PassThrough 冒充 stdin/stdout，注入按键序列并回读渲染输出；无第三方依赖。
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import type React from 'react';

export function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => undefined;
  (s as unknown as { ref: () => unknown }).ref = () => s;
  (s as unknown as { unref: () => unknown }).unref = () => s;
  return s;
}

export function fakeStdout(columns = 80, rows = 24): NodeJS.WriteStream {
  const s = new PassThrough() as unknown as NodeJS.WriteStream;
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { columns: number }).columns = columns;
  (s as unknown as { rows: number }).rows = rows;
  return s;
}

export interface MountedTui {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** 注入按键序列（如 'a'、'\x1b[A'、'\x1b'、'\r'、'\x03'） */
  write: (s: string) => void;
  /** 累积的渲染输出（ANSI 原文，断言用 contains） */
  output: () => string;
  unmount: () => void;
  /** 等待 ink 完成异步重绘（两个宏任务） */
  flush: () => Promise<void>;
}

/** 挂载 node 到虚拟 TTY；返回按键注入与输出读取助手。 */
export function mountTui(node: React.ReactElement): MountedTui {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  let buf = '';
  stdout.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString();
  });
  const instance = render(node, {
    stdin,
    stdout,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: false,
  });

  return {
    stdin,
    stdout,
    write: (s: string) => {
      stdin.write(s);
    },
    output: () => buf,
    unmount: () => instance.unmount(),
    flush: async () => {
      // ink 对孤立 ESC 有 20ms 的 pending 解析定时器；渲染本身按 ~34ms 节流。
      // 先等过 pending ESC 解析，再调用 ink 的渲染落定 API（内部会 flush 节流 timer）。
      await new Promise<void>((r) => setTimeout(r, 25));
      await instance.waitUntilRenderFlush();
    },
  };
}
