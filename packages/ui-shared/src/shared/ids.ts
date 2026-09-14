// 客户端幂等键生成（submit 的 clientMessageId / cancel 的 requestId）。
// 纯函数 + 可注入随机源（单测可断言形状）；不依赖 crypto（渲染端/主进程通用）。
let counter = 0;

/** 生成幂等键：`<prefix>-<时间基36>-<序号36>-<随机36>`（同进程单调不重复） */
export function newRequestId(prefix: string, now: number = Date.now(), rand: () => number = Math.random): string {
  counter = (counter + 1) % 0xffffff;
  const r = Math.floor(rand() * 0xffffffff).toString(36);
  return `${prefix}-${now.toString(36)}-${counter.toString(36)}-${r}`;
}

/** submit 的幂等键 */
export function newClientMessageId(now?: number, rand?: () => number): string {
  return newRequestId('cm', now, rand);
}

/** cancel 的幂等键 */
export function newCancelRequestId(now?: number, rand?: () => number): string {
  return newRequestId('cx', now, rand);
}
