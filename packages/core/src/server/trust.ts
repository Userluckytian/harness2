// 信任域校验（阶段 7 Task 4，M2 发布前加固项落地）：
//   - Origin：存在 Origin 头且非 file:// / http://localhost:* / http://127.0.0.1:* → 拒绝
//     （无 Origin 的非浏览器客户端放行——curl/CLI/Node 客户端不带 Origin）；
//   - Host：必须为 127.0.0.1:<port>（无 Host 的非浏览器客户端放行）——阻断 DNS rebinding
//     与「网站探针」直接以域名访问本地端口；
//   - HTTP 与 WS upgrade 同一规则（均经本模块判定）。
// loopback token 认证评估后留档不实现（桌面 --port 0 随机端口已缓解，见 OPEN.md）。
export const TRUSTED_ORIGIN_PATTERN =
  /^(?:file:\/\/|http:\/\/localhost(?::\d+)?|http:\/\/127\.0\.0\.1(?::\d+)?)$/i;

/** Origin 是否在信任域（undefined = 客户端未携带，放行） */
export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return TRUSTED_ORIGIN_PATTERN.test(origin.trim());
}

/**
 * Origin 头规范化（P2-5 阶段 7 审查）：重复 Origin 头可能被解析为 string[]
 * （而非 typeof 'string' 可命中的标量）——取首值校验，杜绝数组形态绕过信任域检查。
 */
export function normalizeOriginHeader(origin: string | string[] | undefined): string | undefined {
  if (Array.isArray(origin)) return origin[0];
  return origin;
}

/** Host 是否为 127.0.0.1:<port>（undefined = 客户端未携带 Host，放行） */
export function isTrustedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return true;
  return host.toLowerCase() === `127.0.0.1:${port}`;
}

/** WS 帧大小上限（与 HTTP 请求体 1MiB 对齐） */
export const WS_MAX_PAYLOAD = 1024 * 1024;
