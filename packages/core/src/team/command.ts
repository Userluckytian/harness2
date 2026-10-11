// A11 Teams 命令面：把 `/team`（列出/查看/发消息/停止）注册进 core 命令表。
//
// 走**既有能力面**（D02 命令注册开放化）：`registerCoreCommand` 注册为 source='extension' 的
// 扩展命令，随即进入 findCoreCommand / runCoreCommand 分发面与 describeCapabilities().commands
// ——CLI 与桌面经同一份能力面即可看到（GUI 渲染留后续批次）。与 A14 `/workflow` 同一缝。
// 不用内建目录（catalog.ts）：内建命令是各壳测试钉死的固定集合，新增内建会牵动 CLI/桌面测试；
// 扩展命令是 core 既有的加性注册缝，语义与「宿主装配后可见」正相符。
import { registerCoreCommand, unregisterCoreCommand } from '../commands/registry.js';
import type { CoreCommandContext } from '../commands/types.js';
import { teamRunCounts } from './projection.js';
import { TEAM_BOARD_TARGET, type TeamState } from './types.js';

/** 命令名（`/team`） */
export const TEAM_COMMAND_ID = 'team';

/** 命令面运行时缝（宿主装配提供；core 不内置真实执行以外语义） */
export interface TeamCommandRuntime {
  /** 列出全部团队 */
  list(): readonly TeamState[];
  /** 取一个团队（不存在 → undefined） */
  get(teamId: string): TeamState | undefined;
  /** 发消息：to === 'board' 走团队板留痕，否则成员↔成员定向 */
  post(teamId: string, from: string, to: string, text: string): Promise<void>;
  /** 停止团队；返回是否命中 */
  stop(teamId: string): boolean;
}

/** 团队状态的可读标记（纯展示，不影响状态机） */
function taskMark(status: TeamState['tasks'][number]['status']): string {
  switch (status) {
    case 'todo':
      return '[ ]';
    case 'claimed':
      return '[>]';
    case 'done':
      return '[✓]';
    case 'failed':
      return '[✗]';
    case 'blocked':
      return '[!]';
  }
}

/** 团队→文本行（纯函数；供命令面与后续 GUI 状态子块复用同一口径） */
export function formatTeam(team: TeamState): string[] {
  const counts = teamRunCounts(team);
  const lines = [
    `${team.name}（${team.teamId}）状态：${team.status}｜成员 ${counts.members}（运行 ${counts.membersRunning}/完成 ${counts.membersDone}/失败 ${counts.membersFailed}）｜任务 ${counts.tasks}｜消息 ${counts.messages}`,
  ];
  for (const m of team.members) {
    const rounds = m.rounds > 0 ? ` ×${m.rounds}` : '';
    const child = m.childSessionId !== undefined ? ` child=${m.childSessionId}` : '';
    const detail = m.error ?? m.outputPreview ?? '';
    lines.push(
      `  成员 ${m.name}（${m.writeMode}）${m.status}${rounds}${child}${detail.length > 0 ? ` — ${detail}` : ''}`,
    );
  }
  for (const t of team.tasks) {
    const owner = t.owner !== undefined ? ` @${t.owner}` : '';
    const deps = t.dependsOn.length > 0 ? ` deps=${t.dependsOn.join(',')}` : '';
    lines.push(`  ${taskMark(t.status)} ${t.taskId} ${t.title}${owner}${deps}`);
  }
  return lines;
}

/** 团队列表→文本行（纯函数） */
export function formatTeams(teams: readonly TeamState[]): string[] {
  if (teams.length === 0) return ['（无团队）'];
  return teams.map((t) => {
    const counts = teamRunCounts(t);
    return `  ${t.name}（${t.teamId}）${t.status} — 成员 ${counts.members}，任务 ${counts.tasks}，消息 ${counts.messages}`;
  });
}

const USAGE = '用法：/team <list|show [teamId]|msg <teamId> <from> <to> <文本>|stop <teamId>>';

/**
 * 执行 `/team` 子命令（纯文本输出，错误行以 'error: ' 开头）。
 * 导出便于宿主自行分发时复用同一文案；`registerTeamCommand` 内部亦调用它。
 */
export async function runTeamCommand(
  ctx: Pick<CoreCommandContext, 'print'>,
  args: { rest: string },
  runtime: TeamCommandRuntime,
): Promise<void> {
  const words = args.rest
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const sub = words[0] ?? 'list';

  if (sub === 'list') {
    for (const line of formatTeams(runtime.list())) ctx.print(line);
    return;
  }

  if (sub === 'show') {
    const teamId = words[1];
    const team = teamId !== undefined ? runtime.get(teamId) : runtime.list()[0];
    if (team === undefined) {
      ctx.print(teamId !== undefined ? `error: 团队不存在：${teamId}` : '（无团队）');
      return;
    }
    for (const line of formatTeam(team)) ctx.print(line);
    return;
  }

  if (sub === 'msg') {
    const [, teamId, from, to] = words;
    const text = words.slice(4).join(' ');
    if (teamId === undefined || from === undefined || to === undefined || text.length === 0) {
      ctx.print(`error: ${USAGE}`);
      return;
    }
    try {
      await runtime.post(teamId, from, to, text);
      ctx.print(`已投递消息：${from} → ${to === TEAM_BOARD_TARGET ? '团队板' : to}（${teamId}）`);
    } catch (e) {
      ctx.print(`error: 发消息失败：${(e as Error)?.message ?? String(e)}`);
    }
    return;
  }

  if (sub === 'stop') {
    const teamId = words[1];
    if (teamId === undefined) {
      ctx.print(`error: ${USAGE}`);
      return;
    }
    ctx.print(runtime.stop(teamId) ? `已停止团队 ${teamId}` : `error: 未找到团队 ${teamId}`);
    return;
  }

  ctx.print(`error: 未知子命令 ${sub}。${USAGE}`);
}

/**
 * 注册 `/team` 扩展命令（source='extension'），返回卸载 disposer。
 * 重复注册同名命令由命令注册表 fail-closed 抛错（不静默覆盖）。
 */
export function registerTeamCommand(runtime: TeamCommandRuntime): () => void {
  registerCoreCommand({
    id: TEAM_COMMAND_ID,
    group: '调度',
    summary: 'Agent Teams 编排（列出/查看/发消息/停止）',
    argsSpec: '<list|show [teamId]|msg <teamId> <from> <to> <文本>|stop <teamId>>',
    run: (ctx, args) => runTeamCommand(ctx, args, runtime),
  });
  return () => {
    unregisterCoreCommand(TEAM_COMMAND_ID);
  };
}
