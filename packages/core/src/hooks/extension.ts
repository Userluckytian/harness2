// A09 hook 执行落账：以 D02「扩展事件类型」机制落一条 hook/invocation 事件（opaque 投影）。
// 走**已交付机制**（批次1 的 extensionEventTypes 注册表 + writer.appendExtension），
// 不新造通道：注册 → writer 接受（validator 校验）→ reader 解析 → 投影 opaque 通道（不进
// 模型上下文、参与 rewind 遮蔽窗口）。ZCode 的 Timeline `hookInvocation` 行对应此事件。
import type { SessionAppender } from '../session/writer.js';
import { extensionEventTypes, type LoadedExtensionEvent } from '../session/extension-events.js';
import type { HookEventName } from '../config/schema.js';
import type { HookInvocationRecord } from './types.js';

/** 扩展事件类型名（ZCode Timeline 行 kind = hookInvocation 的对应物） */
export const HOOK_INVOCATION_EVENT_TYPE = 'hook/invocation';

/** payload 预览上限（字符；写入前再做一次，防调用方绕过） */
const PREVIEW_MAX_CHARS = 2000;

/**
 * 注册 hook/invocation 扩展事件类型（幂等；进程级单例注册表的 fail-closed 前置）。
 * validator = 最低形状校验：event/command/outcome 为字符串、exitCode 为 number|null、
 * durationMs 为有限非负 number；缺任一即拒（写入口与读侧同判，避免读回即 corrupt）。
 */
export function registerHookInvocationEventType(): void {
  if (extensionEventTypes.has(HOOK_INVOCATION_EVENT_TYPE)) return;
  extensionEventTypes.register({
    type: HOOK_INVOCATION_EVENT_TYPE,
    projection: 'opaque',
    validator: (p) =>
      typeof p.event === 'string' &&
      typeof p.command === 'string' &&
      typeof p.outcome === 'string' &&
      (p.exitCode === null || typeof p.exitCode === 'number') &&
      typeof p.durationMs === 'number' &&
      Number.isFinite(p.durationMs) &&
      p.durationMs >= 0,
  });
}

/** 记录 → 扩展事件 payload（丢弃空预览；字符串字段一律截断到 PREVIEW_MAX_CHARS） */
export function hookInvocationPayload(record: HookInvocationRecord): Record<string, unknown> {
  const clip = (s: string | undefined): string | undefined =>
    s === undefined ? undefined : s.length > PREVIEW_MAX_CHARS ? s.slice(0, PREVIEW_MAX_CHARS) : s;
  const payload: Record<string, unknown> = {
    event: record.event,
    command: record.command,
    outcome: record.outcome,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
  };
  if (record.matcher !== undefined) payload.matcher = record.matcher;
  if (record.target !== undefined) payload.target = record.target;
  if (record.blockReason !== undefined) payload.blockReason = clip(record.blockReason);
  if (record.contextCount !== undefined) payload.contextCount = record.contextCount;
  const stdout = clip(record.stdoutPreview);
  if (stdout !== undefined && stdout.length > 0) payload.stdoutPreview = stdout;
  const stderr = clip(record.stderrPreview);
  if (stderr !== undefined && stderr.length > 0) payload.stderrPreview = stderr;
  return payload;
}

/**
 * 把一组调用记录落进会话日志（扩展事件）。writer 无 appendExtension（镜像/观察包裹器）
 * 时静默跳过——扩展事件是加性观测面，缺省不阻断 turn。
 */
export function appendHookInvocations(
  writer: Pick<SessionAppender, 'appendExtension'>,
  records: readonly HookInvocationRecord[],
): void {
  if (records.length === 0) return;
  if (typeof writer.appendExtension !== 'function') return;
  registerHookInvocationEventType();
  for (const record of records) {
    writer.appendExtension(HOOK_INVOCATION_EVENT_TYPE, hookInvocationPayload(record));
  }
}

/** 读侧：从已加载会话的扩展事件里取 hook/invocation 行（顺序即落盘顺序） */
export function readHookInvocations(
  extensionEvents: readonly LoadedExtensionEvent[],
): Array<{ seq: number; payload: Record<string, unknown> }> {
  const out: Array<{ seq: number; payload: Record<string, unknown> }> = [];
  for (const { event } of extensionEvents) {
    if (event.type === HOOK_INVOCATION_EVENT_TYPE) out.push({ seq: event.seq, payload: event.payload });
  }
  return out;
}

/** hook/invocation payload 的最小类型视图（读侧消费便捷；字段可选，不臆造） */
export interface HookInvocationPayloadView {
  event: HookEventName;
  command: string;
  outcome: string;
  exitCode: number | null;
  durationMs: number;
  matcher?: string;
  target?: string;
  blockReason?: string;
  contextCount?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
}
