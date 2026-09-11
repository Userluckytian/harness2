// serve 安全内部件（A3-1/A3-2）：一次性 token 与 WS 帧超限记账。
// **不**经 src/index.ts 再导出（内部件；避免为纯加固改动膨胀公开导出面）——
// http.ts / ws.ts 直接引用本模块；测试走深路径 `../src/server/security.js`。
// 红线：本模块任何路径都不得把 token 写入日志、错误消息或事件流。
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** token 请求头名（非浏览器客户端首选；Authorization: Bearer 与 ?token= 亦支持） */
export const SERVE_TOKEN_HEADER = 'x-harness2-token';
/** 预置 token 环境变量（可选；未设则启动时随机生成 32 字节 base64url） */
export const SERVE_TOKEN_ENV = 'HARNESS2_SERVE_TOKEN';
/** 强制 token 鉴权（**默认开启**）：显式设 0/false/no 才关闭（仅供本地调试，启动时告警） */
export const SERVE_REQUIRE_TOKEN_ENV = 'HARNESS2_SERVE_REQUIRE_TOKEN';

/** A3-1/A3-2：serve 安全计数（只读投影，测试与诊断用；绝不含 token 明文） */
export interface ServeSecurityStats {
  /** 兼容回退：无 token 但被放行的请求数（严格模式恒为 0） */
  noTokenAllowed: number;
  /** 严格模式：缺 token 被拒数 */
  noTokenRejected: number;
  /** token 存在但错误被拒数（任何模式下都拒，绝不回退） */
  invalidTokenRejected: number;
  /** Origin/Host 白名单拒绝数 */
  trustRejected: number;
  /** A3-2：WS 帧超限断连次数 */
  wsOversizeClosed: number;
}

export function createServeSecurityStats(): ServeSecurityStats {
  return {
    noTokenAllowed: 0,
    noTokenRejected: 0,
    invalidTokenRejected: 0,
    trustRejected: 0,
    wsOversizeClosed: 0,
  };
}

/** 启动时一次性 token（32 字节随机 → base64url，无需额外编码即可安全放进 header/query） */
export function generateServeToken(): string {
  return randomBytes(32).toString('base64url');
}

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 从请求提取 token（优先级：x-harness2-token > Authorization: Bearer > ?token=）。
 * 重复头（数组）取首值，与 Origin 校验同口径。
 */
export function extractServeToken(headers: Record<string, HeaderValue>, url?: URL): string | undefined {
  const direct = firstHeader(headers[SERVE_TOKEN_HEADER]);
  if (direct !== undefined && direct.trim().length > 0) return direct.trim();
  const auth = firstHeader(headers['authorization']);
  if (auth !== undefined) {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1] !== undefined && m[1].length > 0) return m[1];
  }
  const fromQuery = url?.searchParams.get('token');
  return fromQuery !== null && fromQuery !== undefined && fromQuery.length > 0 ? fromQuery : undefined;
}

/** 常量时间比较（长度不同直接 false；不记录、不回显任何一侧明文） */
export function isServeTokenValid(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** HARNESS2_SERVE_TOKEN 预置 token（<16 字符视为无效，避免误配置把鉴权降级成猜得到的值） */
export function serveTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[SERVE_TOKEN_ENV];
  return typeof v === 'string' && v.trim().length >= 16 ? v.trim() : undefined;
}

/** HARNESS2_SERVE_REQUIRE_TOKEN：**缺省严格**（未设/空值/任意其他值 → true）；
 * 显式 0/false/no 才关闭（本地调试开关，startServe 会打一次性告警） */
export function serveRequireTokenFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[SERVE_REQUIRE_TOKEN_ENV]?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no');
}

let warnedStrictDisabled = false;

/** 严格鉴权被环境变量显式关闭时的一次性启动告警（不含任何敏感值） */
export function warnServeStrictDisabledOnce(): void {
  if (warnedStrictDisabled) return;
  warnedStrictDisabled = true;
  console.error(
    `warning: serve 严格鉴权已被环境变量显式关闭（${SERVE_REQUIRE_TOKEN_ENV}=0/false/no）——仅限本地调试，生产环境请保持严格`,
  );
}

let warnedNoToken = false;

/** 兼容回退一次性告警（进程内只打印一次；不含 token、不含请求内容） */
export function warnServeNoTokenOnce(): void {
  if (warnedNoToken) return;
  warnedNoToken = true;
  console.error(`warning: serve 收到无 token 请求（兼容回退放行；设 ${SERVE_REQUIRE_TOKEN_ENV}=1 可强制 token 鉴权）`);
}

/** A3-2：ws 库 maxPayload 超限错误的识别（RangeError + WS_ERR_UNSUPPORTED_MESSAGE_LENGTH） */
export function isWsPayloadExceededError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; message?: unknown };
  if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return true;
  return typeof err.message === 'string' && /max payload size exceeded/i.test(err.message);
}
