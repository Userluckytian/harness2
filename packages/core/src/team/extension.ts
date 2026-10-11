// A11 Teams 落账：以 D02「扩展事件类型」机制落 `team/event`（团队/成员/任务板生命周期）与
// `team/message`（成员→板 / 成员↔成员消息），两条都走 opaque 投影——不进消息投影、不进模型上下文、
// 参与 rewind 遮蔽窗口。走**已交付机制**（extensionEventTypes 注册表 + writer.appendExtension），
// 不新造通道。红线①「不落盘的就不显示」：UI/命令面只读这两条已落盘通道；红线② append-only
// 单写者：写入仍经唯一 SessionWriter。
//
// 消息正文落盘前**截断 + 脱敏**（对齐工作流 outputPreview 口径）：成员间消息可能夹带密钥/长文，
// 落一条脱敏预览即可支撑「可重放」，完整正文归成员自己的轨迹。
import { redactSecrets } from '../config/redact.js';
import type { SessionAppender } from '../session/writer.js';
import { extensionEventTypes, type LoadedExtensionEvent } from '../session/extension-events.js';
import {
  TEAM_MAX_MESSAGE_CHARS,
  TEAM_MEMBER_STATUSES,
  TEAM_STATUSES,
  TEAM_TASK_STATUSES,
  type TeamMemberStatus,
  type TeamMemberWriteMode,
  type TeamStatus,
  type TeamTaskStatus,
} from './types.js';

/** 扩展事件类型名：团队/成员/任务板生命周期 */
export const TEAM_EVENT_TYPE = 'team/event';
/** 扩展事件类型名：成员间消息（成员→板 / 成员↔成员） */
export const TEAM_MESSAGE_TYPE = 'team/message';

/** `team/event` 的事件种类 */
export const TEAM_EVENT_KINDS = ['created', 'member', 'task-added', 'task-status', 'stopped'] as const;
export type TeamEventKind = (typeof TEAM_EVENT_KINDS)[number];

/** `team/event` payload 形状（字段按 kind 取舍；validator 逐 kind 收口） */
export interface TeamEventPayload {
  teamId: string;
  kind: TeamEventKind;
  /** kind='created'：团队名 */
  name?: string;
  /** kind='created'：团队描述（可缺省） */
  description?: string;
  /** kind='created'：派发方会话 id */
  parentSessionId?: string;
  /** kind='member'：成员名 */
  member?: string;
  /** kind='member'：成员相位 */
  memberStatus?: TeamMemberStatus;
  /** kind='member'：成员资源型 */
  writeMode?: TeamMemberWriteMode;
  /** kind='member'：成员模型串 */
  model?: string;
  /** kind='member'：成员子会话 id */
  childSessionId?: string;
  /** kind='member'：成员已跑轮次 */
  round?: number;
  /** kind='member'：结局摘要（截断 + 脱敏） */
  outputPreview?: string;
  /** kind='member'：错误文案 */
  error?: string;
  /** kind='task-added'：任务 id */
  taskId?: string;
  /** kind='task-added'：任务标题 */
  taskTitle?: string;
  /** kind='task-added'：依赖任务 id 列表 */
  dependsOn?: readonly string[];
  /** kind='task-status'：任务状态 */
  taskStatus?: TeamTaskStatus;
  /** kind='task-status'：任务归属成员 */
  owner?: string;
  /** kind='stopped'：团队终态 */
  status?: TeamStatus;
}

/** `team/message` payload 形状 */
export interface TeamMessagePayload {
  teamId: string;
  messageId: string;
  /** 发送方（成员名或 'board'） */
  from: string;
  /** 接收方（成员名或 'board'） */
  to: string;
  kind: 'board' | 'direct';
  text: string;
}

const TEAM_EVENT_KIND_SET: ReadonlySet<string> = new Set(TEAM_EVENT_KINDS);
const MEMBER_STATUS_SET: ReadonlySet<string> = new Set(TEAM_MEMBER_STATUSES);
const TEAM_STATUS_SET: ReadonlySet<string> = new Set(TEAM_STATUSES);
const TASK_STATUS_SET: ReadonlySet<string> = new Set(TEAM_TASK_STATUSES);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 注册 `team/event` 与 `team/message` 扩展事件类型（幂等；进程级单例注册表的 fail-closed 前置）。
 * validator = 最低形状校验（逐 kind 收口必填字段；可选字段若在场须为对应类型）。
 */
export function registerTeamEventTypes(): void {
  if (!extensionEventTypes.has(TEAM_EVENT_TYPE)) {
    extensionEventTypes.register({
      type: TEAM_EVENT_TYPE,
      projection: 'opaque',
      validator: (p) => {
        if (!nonEmptyString(p.teamId) || typeof p.kind !== 'string' || !TEAM_EVENT_KIND_SET.has(p.kind)) {
          return false;
        }
        const kind = p.kind as TeamEventKind;
        if (kind === 'created') {
          return (
            nonEmptyString(p.name) &&
            (p.description === undefined || typeof p.description === 'string') &&
            (p.parentSessionId === undefined || typeof p.parentSessionId === 'string')
          );
        }
        if (kind === 'member') {
          return (
            nonEmptyString(p.member) &&
            typeof p.memberStatus === 'string' &&
            MEMBER_STATUS_SET.has(p.memberStatus) &&
            (p.writeMode === undefined || p.writeMode === 'readonly' || p.writeMode === 'write') &&
            (p.model === undefined || typeof p.model === 'string') &&
            (p.childSessionId === undefined || typeof p.childSessionId === 'string') &&
            (p.round === undefined || (typeof p.round === 'number' && Number.isInteger(p.round) && p.round >= 0)) &&
            (p.outputPreview === undefined || typeof p.outputPreview === 'string') &&
            (p.error === undefined || typeof p.error === 'string')
          );
        }
        if (kind === 'task-added') {
          return (
            nonEmptyString(p.taskId) &&
            nonEmptyString(p.taskTitle) &&
            (p.dependsOn === undefined || (Array.isArray(p.dependsOn) && p.dependsOn.every((d) => nonEmptyString(d))))
          );
        }
        if (kind === 'task-status') {
          return (
            nonEmptyString(p.taskId) &&
            typeof p.taskStatus === 'string' &&
            TASK_STATUS_SET.has(p.taskStatus) &&
            (p.owner === undefined || typeof p.owner === 'string')
          );
        }
        // kind === 'stopped'
        return typeof p.status === 'string' && TEAM_STATUS_SET.has(p.status);
      },
    });
  }
  if (!extensionEventTypes.has(TEAM_MESSAGE_TYPE)) {
    extensionEventTypes.register({
      type: TEAM_MESSAGE_TYPE,
      projection: 'opaque',
      validator: (p) =>
        nonEmptyString(p.teamId) &&
        nonEmptyString(p.messageId) &&
        nonEmptyString(p.from) &&
        nonEmptyString(p.to) &&
        (p.kind === 'board' || p.kind === 'direct') &&
        typeof p.text === 'string' &&
        p.text.length <= TEAM_MAX_MESSAGE_CHARS,
    });
  }
}

/** 消息正文归一：脱敏后截断（空串 → 空串，仍落盘该条消息——消息条数语义与正文无关） */
export function teamMessageText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const clipped = trimmed.length > TEAM_MAX_MESSAGE_CHARS ? trimmed.slice(0, TEAM_MAX_MESSAGE_CHARS) : trimmed;
  return redactSecrets(clipped);
}

/** 结局摘要归一：脱敏后截断（空 → undefined，省略该字段） */
export function teamPreview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const clipped = trimmed.length > TEAM_MAX_MESSAGE_CHARS ? trimmed.slice(0, TEAM_MAX_MESSAGE_CHARS) : trimmed;
  return redactSecrets(clipped);
}

/** `team/event` payload → 落账形状（丢掉 undefined；dependsOn 复制数组） */
export function teamEventPayload(payload: TeamEventPayload): Record<string, unknown> {
  const out: Record<string, unknown> = { teamId: payload.teamId, kind: payload.kind };
  const put = (key: keyof TeamEventPayload): void => {
    const value = payload[key];
    if (value === undefined) return;
    out[key] = Array.isArray(value) ? [...value] : value;
  };
  put('name');
  put('description');
  put('parentSessionId');
  put('member');
  put('memberStatus');
  put('writeMode');
  put('model');
  put('childSessionId');
  put('round');
  const preview = teamPreview(payload.outputPreview);
  if (preview !== undefined) out.outputPreview = preview;
  put('error');
  put('taskId');
  put('taskTitle');
  put('dependsOn');
  put('taskStatus');
  put('owner');
  put('status');
  return out;
}

/** `team/message` payload → 落账形状（正文脱敏 + 截断） */
export function teamMessageEventPayload(payload: TeamMessagePayload): Record<string, unknown> {
  return {
    teamId: payload.teamId,
    messageId: payload.messageId,
    from: payload.from,
    to: payload.to,
    kind: payload.kind,
    text: teamMessageText(payload.text),
  };
}

/**
 * 落一条 `team/event`。writer 无 appendExtension（镜像/观察包裹器）时静默跳过——
 * 扩展事件是观测面，缺省不阻断运行（与 hooks/工作流落账同口径）。
 */
export function appendTeamEvent(
  writer: Pick<SessionAppender, 'appendExtension'> | undefined,
  payload: TeamEventPayload,
): void {
  if (writer === undefined || typeof writer.appendExtension !== 'function') return;
  registerTeamEventTypes();
  writer.appendExtension(TEAM_EVENT_TYPE, teamEventPayload(payload));
}

/** 落一条 `team/message`（同 appendTeamEvent 的缺省不阻断口径） */
export function appendTeamMessage(
  writer: Pick<SessionAppender, 'appendExtension'> | undefined,
  payload: TeamMessagePayload,
): void {
  if (writer === undefined || typeof writer.appendExtension !== 'function') return;
  registerTeamEventTypes();
  writer.appendExtension(TEAM_MESSAGE_TYPE, teamMessageEventPayload(payload));
}

/** 读侧：从已加载会话的扩展事件里取 `team/event` 行（顺序即落盘顺序） */
export function readTeamEvents(
  extensionEvents: readonly LoadedExtensionEvent[],
): Array<{ seq: number; ts: string; payload: TeamEventPayload }> {
  const out: Array<{ seq: number; ts: string; payload: TeamEventPayload }> = [];
  for (const { event } of extensionEvents) {
    if (event.type !== TEAM_EVENT_TYPE) continue;
    out.push({ seq: event.seq, ts: event.ts, payload: event.payload as unknown as TeamEventPayload });
  }
  return out;
}

/** 读侧：从已加载会话的扩展事件里取 `team/message` 行（顺序即落盘顺序） */
export function readTeamMessages(
  extensionEvents: readonly LoadedExtensionEvent[],
): Array<{ seq: number; ts: string; payload: TeamMessagePayload }> {
  const out: Array<{ seq: number; ts: string; payload: TeamMessagePayload }> = [];
  for (const { event } of extensionEvents) {
    if (event.type !== TEAM_MESSAGE_TYPE) continue;
    out.push({ seq: event.seq, ts: event.ts, payload: event.payload as unknown as TeamMessagePayload });
  }
  return out;
}
