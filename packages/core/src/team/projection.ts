// A11 Teams 运行态投影（UI/命令面契约）：从**已落盘的** `team/event` + `team/message` 扩展事件
// 重放出团队状态。红线①「不落盘的就不显示」：本模块唯一输入是 loadSession 返回的扩展事件——
// 任何未经落盘的编排器内存态都不出现在这里。
//
// 重放语义：
//   - 按落盘顺序扫描，同 (teamId, member/taskId) 后来者覆盖（状态机单调前进）；
//   - 只认活动事件（被 rewind 遮蔽的影子事件不参与——与 opaque 投影同口径）；
//   - `team/event` 管团队/成员/任务板；`team/message` 追加消息（seq/ts 取事件信封）。
//
// 编排器（orchestrator.ts）复用本模块的 applyTeamEvent，保证「内存态 == 落盘态」。
import { TEAM_EVENT_TYPE, TEAM_MESSAGE_TYPE, type TeamEventPayload, type TeamMessagePayload } from './extension.js';
import type { LoadedExtensionEvent } from '../session/extension-events.js';
import type { TeamMemberState, TeamState, TeamTaskState } from './types.js';

function teamEventOf(event: LoadedExtensionEvent): TeamEventPayload | undefined {
  if (event.event.type !== TEAM_EVENT_TYPE) return undefined;
  return event.event.payload as unknown as TeamEventPayload;
}

function teamMessageOf(event: LoadedExtensionEvent): TeamMessagePayload | undefined {
  if (event.event.type !== TEAM_MESSAGE_TYPE) return undefined;
  return event.event.payload as unknown as TeamMessagePayload;
}

function emptyTeam(teamId: string, parentSessionId: string): TeamState {
  return {
    teamId,
    name: '',
    description: '',
    parentSessionId,
    status: 'running',
    members: [],
    tasks: [],
    messages: [],
  };
}

/**
 * 把一条 `team/event`（或 `team/message`）作用到一个 TeamState 上（就地更新并返回同一引用）。
 * 供投影重放与编排器共用——一处状态机、两处消费。
 */
export function applyTeamEvent(state: TeamState, payload: TeamEventPayload, ts?: string): TeamState {
  switch (payload.kind) {
    case 'created': {
      if (payload.name !== undefined) state.name = payload.name;
      if (payload.description !== undefined) state.description = payload.description;
      if (payload.parentSessionId !== undefined) state.parentSessionId = payload.parentSessionId;
      state.createdAt ??= ts;
      break;
    }
    case 'member': {
      if (payload.member === undefined) break;
      let member = state.members.find((m) => m.name === payload.member);
      if (member === undefined) {
        member = { name: payload.member, status: 'idle', rounds: 0, writeMode: payload.writeMode ?? 'write' };
        state.members.push(member);
      }
      if (payload.memberStatus !== undefined) member.status = payload.memberStatus;
      if (payload.writeMode !== undefined) member.writeMode = payload.writeMode;
      if (payload.model !== undefined) member.model = payload.model;
      if (payload.childSessionId !== undefined) member.childSessionId = payload.childSessionId;
      if (payload.round !== undefined) member.rounds = Math.max(member.rounds, payload.round);
      if (payload.outputPreview !== undefined) member.outputPreview = payload.outputPreview;
      if (payload.error !== undefined) member.error = payload.error;
      break;
    }
    case 'task-added': {
      if (payload.taskId === undefined) break;
      const existing = state.tasks.find((t) => t.taskId === payload.taskId);
      if (existing !== undefined) {
        if (payload.taskTitle !== undefined) existing.title = payload.taskTitle;
        if (payload.dependsOn !== undefined) existing.dependsOn = [...payload.dependsOn];
      } else {
        const task: TeamTaskState = {
          taskId: payload.taskId,
          title: payload.taskTitle ?? payload.taskId,
          status: 'todo',
          dependsOn: payload.dependsOn !== undefined ? [...payload.dependsOn] : [],
        };
        if (ts !== undefined) task.updatedAt = ts;
        state.tasks.push(task);
      }
      break;
    }
    case 'task-status': {
      if (payload.taskId === undefined) break;
      const task = state.tasks.find((t) => t.taskId === payload.taskId);
      if (task === undefined) break;
      if (payload.taskStatus !== undefined) task.status = payload.taskStatus;
      if (payload.owner !== undefined) task.owner = payload.owner;
      if (ts !== undefined) task.updatedAt = ts;
      break;
    }
    case 'stopped': {
      if (payload.status !== undefined) state.status = payload.status;
      break;
    }
  }
  state.updatedAt = ts ?? state.updatedAt;
  return state;
}

/** 把一条 `team/message` 追加到团队消息列表（就地） */
export function applyTeamMessage(state: TeamState, payload: TeamMessagePayload, ts?: string, seq?: number): TeamState {
  const message = {
    messageId: payload.messageId,
    from: payload.from,
    to: payload.to,
    kind: payload.kind,
    text: payload.text,
    ...(seq !== undefined ? { seq } : {}),
    ...(ts !== undefined ? { ts } : {}),
  };
  state.messages.push(message);
  state.updatedAt = ts ?? state.updatedAt;
  return state;
}

/**
 * 重放全部团队（按首次出现顺序）。每次调用都从零重放，无隐藏缓存——投影是纯函数。
 */
export function projectTeams(extensionEvents: readonly LoadedExtensionEvent[]): TeamState[] {
  const teams = new Map<string, TeamState>();
  for (const item of extensionEvents) {
    if (!item.active) continue;
    const ts = item.event.ts;
    const eventPayload = teamEventOf(item);
    if (eventPayload !== undefined) {
      if (typeof eventPayload.teamId !== 'string' || eventPayload.teamId.length === 0) continue;
      let state = teams.get(eventPayload.teamId);
      if (state === undefined) {
        state = emptyTeam(eventPayload.teamId, eventPayload.parentSessionId ?? '');
        teams.set(eventPayload.teamId, state);
      }
      applyTeamEvent(state, eventPayload, ts);
      continue;
    }
    const messagePayload = teamMessageOf(item);
    if (messagePayload !== undefined) {
      if (typeof messagePayload.teamId !== 'string' || messagePayload.teamId.length === 0) continue;
      let state = teams.get(messagePayload.teamId);
      if (state === undefined) {
        state = emptyTeam(messagePayload.teamId, '');
        teams.set(messagePayload.teamId, state);
      }
      applyTeamMessage(state, messagePayload, ts, item.event.seq);
    }
  }
  return [...teams.values()];
}

/** 按 teamId 取一个团队（不存在返回 undefined） */
export function findTeam(extensionEvents: readonly LoadedExtensionEvent[], teamId: string): TeamState | undefined {
  return projectTeams(extensionEvents).find((team) => team.teamId === teamId);
}

/** 最近更新的团队（按 updatedAt/createdAt 最新；空则 undefined）——命令面缺省目标 */
export function latestTeam(extensionEvents: readonly LoadedExtensionEvent[]): TeamState | undefined {
  const teams = projectTeams(extensionEvents);
  let best: TeamState | undefined;
  for (const team of teams) {
    const ts = team.updatedAt ?? team.createdAt ?? '';
    const bestTs = best?.updatedAt ?? best?.createdAt ?? '';
    if (best === undefined || ts > bestTs) best = team;
  }
  return best;
}

/** 团队运行计数（UI 只读展示用；纯函数，从已投影状态计算） */
export interface TeamRunCounts {
  members: number;
  membersRunning: number;
  membersDone: number;
  membersFailed: number;
  tasks: number;
  tasksTodo: number;
  tasksClaimed: number;
  tasksDone: number;
  messages: number;
}

export function teamRunCounts(team: TeamState): TeamRunCounts {
  return {
    members: team.members.length,
    membersRunning: team.members.filter((m) => m.status === 'running').length,
    membersDone: team.members.filter((m) => m.status === 'done').length,
    membersFailed: team.members.filter((m) => m.status === 'failed').length,
    tasks: team.tasks.length,
    tasksTodo: team.tasks.filter((t) => t.status === 'todo').length,
    tasksClaimed: team.tasks.filter((t) => t.status === 'claimed').length,
    tasksDone: team.tasks.filter((t) => t.status === 'done').length,
    messages: team.messages.length,
  };
}

/** 成员状态直读（UI 排序/标记用） */
export function memberCounts(members: readonly TeamMemberState[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of members) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}
