// A11 Teams 编排器（core）：团队/成员 + 共享任务板 + 成员间消息，全部经扩展事件落盘。
//
// 设计要点（对齐 ZCode 调研结论，见交付报告）：
//   - 成员即子会话：本编排器不造进程模型，成员的真正执行由**注入的 runner** 承担
//     （装配层接既有 subagent 起子会话 + runTurn；测试注入 fake runner，不真起模型）。
//   - 硬闸：并发上限**必须**走既有 TaskCoordinator 的资源锁——每个成员一次运行注册为一个
//     background 任务（writeMode 取成员规格，缺省 write），写型全局串行、只读 K=2 受限。
//     不另起并行机制，不自造信号量。
//   - 落盘：每次状态迁移经 appendTeamEvent / appendTeamMessage 落扩展事件（opaque 投影），
//     内存态用同一份 applyTeamEvent 就地更新 —— 保证「内存态 == 落盘态」（红线①）。
//   - 深度：团队不能再起团队，assertTeamDepth 在构造期收口（对齐 A14 WORKFLOW_MAX_DEPTH=0）。
//   - 消息：成员→团队板留痕（postBoard）与成员↔成员定向（sendDirect，经注入 deliverDirect
//     复用 subagent 续跑机制投递）。投递为 best-effort：消息先落盘，投递失败不回滚（取舍见报告）。
import { randomUUID } from 'node:crypto';
import { TaskCoordinator } from '../agent/task-coordinator.js';
import type { SessionAppender } from '../session/writer.js';
import { appendTeamEvent, appendTeamMessage, teamMessageText, teamPreview } from './extension.js';
import type { TeamEventPayload } from './extension.js';
import { applyTeamEvent, applyTeamMessage } from './projection.js';
import {
  TEAM_BOARD_TARGET,
  TEAM_MAX_DEPTH,
  TEAM_MAX_MESSAGES,
  TEAM_MAX_TASK_TITLE_CHARS,
  TEAM_MAX_TASKS,
  TEAM_MAX_ROUNDS,
  TeamValidationError,
  canTeamTaskTransition,
  parseTeamDefinition,
  type TeamDefinition,
  type TeamDefinitionInput,
  type TeamMemberSpec,
  type TeamMemberState,
  type TeamMessageState,
  type TeamState,
  type TeamTaskInput,
  type TeamTaskState,
} from './types.js';

/** 递归深度断言：depth > TEAM_MAX_DEPTH 即拒（「团队里起团队」当前一律拒绝，对齐 A14） */
export function assertTeamDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new TeamValidationError(`team depth 必须是非负整数：${String(depth)}`);
  }
  if (depth > TEAM_MAX_DEPTH) {
    throw new TeamValidationError(`团队递归被拒：depth ${depth} 超过上限 ${TEAM_MAX_DEPTH}（团队内不得再起团队）`);
  }
}

/** 成员一次运行的结局（runner 注入返回；与 task-coordinator 的收敛口径一致） */
export interface TeamMemberRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  /** 装配层创建的子会话 id（供成员状态回填 childSessionId） */
  childSessionId?: string;
}

/** 成员运行器入参（宿主注入；测试用 fake，不真起模型/进程） */
export interface TeamMemberRunInput {
  teamId: string;
  member: TeamMemberSpec;
  /** 第几轮（1 起） */
  round: number;
  /** 该成员当前领取的任务（若有） */
  task?: TeamTaskState;
  cwd: string;
  signal: AbortSignal;
}

/** 成员运行器缝：装配层接既有 subagent 起子会话 + runTurn */
export type TeamMemberRunner = (input: TeamMemberRunInput) => Promise<TeamMemberRunResult>;

/** 定向消息投递缝：装配层接 subagent_continue 续跑目标成员子会话；缺省只落盘不投递 */
export type TeamMessageDeliverer = (message: {
  teamId: string;
  from: string;
  to: string;
  text: string;
}) => Promise<void> | void;

export interface TeamOrchestratorOptions {
  /** 派发方会话 id（写入 team/created 事件；TaskSpec.sessionId 亦用它） */
  parentSessionId: string;
  /** 成员运行 cwd */
  cwd: string;
  /** 并发闸：注入进程级共享协调器即全局串行；缺省自建一个（仍是既有 TaskCoordinator） */
  coordinator?: TaskCoordinator;
  /** 成员运行器缝（缺省 = 每个成员失败并提示未装配，不静默假装跑过） */
  runner?: TeamMemberRunner;
  /** 落账 sink（SessionWriter 或观察包裹器；缺省 = 不落盘，只返回内存态并登记为「不显示」） */
  writer?: Pick<SessionAppender, 'appendExtension'>;
  /** 定向消息投递缝（缺省不投递，只落盘） */
  deliverDirect?: TeamMessageDeliverer;
  /** 递归深度（缺省 0；> TEAM_MAX_DEPTH 构造即抛） */
  depth?: number;
  /** 时钟（测试可注入确定性时间） */
  now?: () => string;
}

interface TeamRuntime {
  definition: TeamDefinition;
  state: TeamState;
  /** 本团队在协调器里注册过的 taskId（stopTeam 取消用） */
  taskIds: Set<string>;
}
/** 一次 runTeam 的轮次覆盖 */
export interface TeamRunOptions {
  /** 每成员轮次（夹到 [1, min(team.maxRounds, TEAM_MAX_ROUNDS)]；缺省取 team.maxRounds） */
  rounds?: number;
}

export class TeamOrchestrator {
  private readonly parentSessionId: string;
  private readonly cwd: string;
  private readonly coordinator: TaskCoordinator;
  private readonly runner: TeamMemberRunner | undefined;
  private readonly writer: Pick<SessionAppender, 'appendExtension'> | undefined;
  private readonly deliverDirect: TeamMessageDeliverer | undefined;
  private readonly now: () => string;
  private readonly teams = new Map<string, TeamRuntime>();
  private readonly runningTeams = new Set<string>();

  constructor(options: TeamOrchestratorOptions) {
    assertTeamDepth(options.depth ?? 0);
    if (typeof options.parentSessionId !== 'string' || options.parentSessionId.length === 0) {
      throw new TeamValidationError('parentSessionId 必须是非空字符串');
    }
    this.parentSessionId = options.parentSessionId;
    this.cwd = options.cwd;
    this.coordinator = options.coordinator ?? new TaskCoordinator();
    this.runner = options.runner;
    this.writer = options.writer;
    this.deliverDirect = options.deliverDirect;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 列出全部团队（内存态副本；UI/命令面用 projectTeams 读落盘态为准） */
  list(): readonly TeamState[] {
    return [...this.teams.values()].map((rt) => cloneState(rt.state));
  }

  /** 取一个团队（不存在 → undefined） */
  get(teamId: string): TeamState | undefined {
    const rt = this.teams.get(teamId);
    return rt === undefined ? undefined : cloneState(rt.state);
  }

  /** 创建团队：解析定义（fail-closed）→ 落 created + 每成员 idle → 建内存态 */
  createTeam(input: TeamDefinitionInput): TeamState {
    const definition = parseTeamDefinition(input);
    const teamId = `team-${randomUUID()}`;
    const state: TeamState = {
      teamId,
      name: definition.name,
      description: definition.description,
      parentSessionId: this.parentSessionId,
      status: 'running',
      members: definition.members.map((m): TeamMemberState => ({
        name: m.name,
        status: 'idle',
        rounds: 0,
        writeMode: m.writeMode,
        ...(m.model !== undefined ? { model: m.model } : {}),
      })),
      tasks: [],
      messages: [],
    };
    this.teams.set(teamId, { definition, state, taskIds: new Set() });
    // 落 created（parentSessionId 一并落盘，重放可还原归属）
    this.emit(state, {
      teamId,
      kind: 'created',
      name: definition.name,
      description: definition.description,
      parentSessionId: this.parentSessionId,
    });
    for (const member of definition.members) {
      this.emit(state, {
        teamId,
        kind: 'member',
        member: member.name,
        memberStatus: 'idle',
        writeMode: member.writeMode,
        ...(member.model !== undefined ? { model: member.model } : {}),
      });
    }
    return cloneState(state);
  }

  /** 新增任务板条目（fail-closed：团队存在、未超条数、标题合法、依赖已知且不自引用） */
  addTask(teamId: string, input: TeamTaskInput): TeamTaskState {
    const rt = this.requireTeam(teamId);
    if (rt.state.tasks.length >= TEAM_MAX_TASKS) {
      throw new TeamValidationError(`任务板条目超过上限 ${TEAM_MAX_TASKS}`);
    }
    if (typeof input?.title !== 'string' || input.title.trim().length === 0) {
      throw new TeamValidationError('任务标题必须是非空字符串');
    }
    if (input.title.length > TEAM_MAX_TASK_TITLE_CHARS) {
      throw new TeamValidationError(`任务标题超过上限 ${TEAM_MAX_TASK_TITLE_CHARS} 字符`);
    }
    const taskId = input.taskId ?? `t-${randomUUID()}`;
    if (rt.state.tasks.some((t) => t.taskId === taskId)) {
      throw new TeamValidationError(`任务 id 重复：${taskId}`);
    }
    const dependsOn = [...(input.dependsOn ?? [])];
    for (const dep of dependsOn) {
      if (dep === taskId) throw new TeamValidationError(`任务不能依赖自身：${taskId}`);
      if (!rt.state.tasks.some((t) => t.taskId === dep)) {
        throw new TeamValidationError(`依赖的任务不存在：${dep}`);
      }
    }
    this.emit(rt.state, { teamId, kind: 'task-added', taskId, taskTitle: input.title, dependsOn });
    return cloneTask(rt.state.tasks.find((t) => t.taskId === taskId)!);
  }

  /** 成员领取任务：任务须 todo、成员须存在、全部依赖须 done */
  claimTask(teamId: string, taskId: string, member: string): TeamTaskState {
    const rt = this.requireTeam(teamId);
    const task = this.requireTask(rt.state, taskId);
    if (task.status !== 'todo') {
      throw new TeamValidationError(`任务 ${taskId} 当前状态 ${task.status}，不可领取`);
    }
    this.requireMember(rt.state, member);
    const pendingDep = task.dependsOn.find((dep) => rt.state.tasks.find((t) => t.taskId === dep)?.status !== 'done');
    if (pendingDep !== undefined) {
      throw new TeamValidationError(`任务 ${taskId} 依赖未完成：${pendingDep}`);
    }
    this.emit(rt.state, { teamId, kind: 'task-status', taskId, taskStatus: 'claimed', owner: member });
    return cloneTask(this.requireTask(rt.state, taskId));
  }

  /** 成员完成任务（ok=true → done；ok=false → failed）。须处于 claimed。 */
  completeTask(teamId: string, taskId: string, ok = true): TeamTaskState {
    const rt = this.requireTeam(teamId);
    const task = this.requireTask(rt.state, taskId);
    const to = ok ? 'done' : 'failed';
    if (!canTeamTaskTransition(task.status, to)) {
      throw new TeamValidationError(`任务 ${taskId} 不能从 ${task.status} 迁移到 ${to}`);
    }
    this.emit(rt.state, { teamId, kind: 'task-status', taskId, taskStatus: to });
    return cloneTask(this.requireTask(rt.state, taskId));
  }

  /** 成员→团队板留痕（消息落盘；不触发投递） */
  async postBoard(teamId: string, from: string, text: string): Promise<TeamMessageState> {
    const rt = this.requireTeam(teamId);
    this.requireMember(rt.state, from);
    return this.appendMessage(rt, { from, to: TEAM_BOARD_TARGET, kind: 'board', text });
  }

  /** 成员↔成员定向消息：先落盘，再经注入的 deliverDirect best-effort 投递（失败不回滚） */
  async sendDirect(teamId: string, from: string, to: string, text: string): Promise<TeamMessageState> {
    const rt = this.requireTeam(teamId);
    this.requireMember(rt.state, from);
    this.requireMember(rt.state, to);
    const message = this.appendMessage(rt, { from, to, kind: 'direct', text });
    if (this.deliverDirect !== undefined) {
      try {
        await this.deliverDirect({ teamId, from, to, text: message.text });
      } catch {
        // best-effort：消息已落盘，投递失败不抛（取舍见报告）
      }
    }
    return message;
  }

  /**
   * 运行团队：每个成员注册一个后台任务（writeMode 取成员规格）到既有 TaskCoordinator，
   * 等待全部终态。并发由协调器资源锁决定（写串行、只读 K=2），本编排器不另设并行上限。
   */
  async runTeam(teamId: string, options: TeamRunOptions = {}): Promise<TeamState> {
    const rt = this.requireTeam(teamId);
    if (rt.state.status !== 'running') {
      throw new TeamValidationError(`团队 ${teamId} 当前状态 ${rt.state.status}，不可运行`);
    }
    if (this.runningTeams.has(teamId)) {
      throw new TeamValidationError(`团队 ${teamId} 已在运行中`);
    }
    const maxRounds = rt.definition.maxRounds;
    const roundsRaw = options.rounds ?? maxRounds;
    if (!Number.isInteger(roundsRaw) || roundsRaw < 1) {
      throw new TeamValidationError('rounds 必须是正整数');
    }
    const rounds = Math.min(roundsRaw, maxRounds, TEAM_MAX_ROUNDS);

    this.runningTeams.add(teamId);
    try {
      const waits: Array<Promise<unknown>> = [];
      for (const member of rt.definition.members) {
        const taskId = `${teamId}:${member.name}`;
        if (rt.taskIds.has(taskId)) {
          throw new TeamValidationError(`成员 ${member.name} 已有在册任务 ${taskId}（同一成员不得重复注册）`);
        }
        rt.taskIds.add(taskId);
        const contract = this.coordinator.register({
          taskId,
          sessionId: this.parentSessionId,
          background: true,
          writeMode: member.writeMode,
          prompt: member.prompt ?? member.name,
          run: (signal) => this.runMember(rt, member, rounds, signal),
        });
        waits.push(this.coordinator.wait(contract.taskId));
      }
      await Promise.all(waits);
      return cloneState(rt.state);
    } finally {
      this.runningTeams.delete(teamId);
    }
  }

  /** 停止团队：取消在册任务 + 非终态成员落 stopped + 团队落 stopped */
  stopTeam(teamId: string): boolean {
    const rt = this.teams.get(teamId);
    if (rt === undefined) return false;
    if (rt.state.status !== 'running') return true;
    for (const taskId of rt.taskIds) this.coordinator.cancel(taskId);
    rt.taskIds.clear();
    for (const member of rt.state.members) {
      if (member.status === 'idle' || member.status === 'running') {
        this.emit(rt.state, { teamId, kind: 'member', member: member.name, memberStatus: 'stopped' });
      }
    }
    this.emit(rt.state, { teamId, kind: 'stopped', status: 'stopped' });
    return true;
  }

  // —— 内部 ——

  private async runMember(
    rt: TeamRuntime,
    member: TeamMemberSpec,
    rounds: number,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; output?: string }> {
    this.emit(rt.state, { teamId: rt.state.teamId, kind: 'member', member: member.name, memberStatus: 'running' });
    if (this.runner === undefined) {
      const error = `成员运行器未装配：${member.name}（宿主未注入 runner）`;
      this.emit(rt.state, {
        teamId: rt.state.teamId,
        kind: 'member',
        member: member.name,
        memberStatus: 'failed',
        round: 0,
        error,
      });
      return { ok: false, error };
    }
    let completed = 0;
    let lastOutput: string | undefined;
    let childSessionId: string | undefined;
    for (let round = 1; round <= rounds; round += 1) {
      if (signal.aborted) break;
      const claimedTask = rt.state.tasks.find((t) => t.owner === member.name && t.status === 'claimed');
      let result: TeamMemberRunResult;
      try {
        result = await this.runner({
          teamId: rt.state.teamId,
          member,
          round,
          ...(claimedTask !== undefined ? { task: cloneTask(claimedTask) } : {}),
          cwd: this.cwd,
          signal,
        });
      } catch (e) {
        result = { ok: false, error: (e as Error)?.message ?? String(e) };
      }
      if (result.childSessionId !== undefined) childSessionId = result.childSessionId;
      if (result.output !== undefined) lastOutput = result.output;
      completed += 1;
      if (!result.ok) {
        this.emit(rt.state, {
          teamId: rt.state.teamId,
          kind: 'member',
          member: member.name,
          memberStatus: 'failed',
          round: completed,
          ...(childSessionId !== undefined ? { childSessionId } : {}),
          ...(lastOutput !== undefined ? { outputPreview: lastOutput } : {}),
          error: result.error ?? '成员运行失败',
        });
        return { ok: false, ...(lastOutput !== undefined ? { output: lastOutput } : {}), error: result.error };
      }
    }
    if (signal.aborted) {
      this.emit(rt.state, { teamId: rt.state.teamId, kind: 'member', member: member.name, memberStatus: 'stopped' });
      return { ok: false, error: '已取消' };
    }
    this.emit(rt.state, {
      teamId: rt.state.teamId,
      kind: 'member',
      member: member.name,
      memberStatus: 'done',
      round: completed,
      ...(childSessionId !== undefined ? { childSessionId } : {}),
      ...(lastOutput !== undefined ? { outputPreview: lastOutput } : {}),
    });
    return { ok: true, ...(lastOutput !== undefined ? { output: lastOutput } : {}) };
  }

  private appendMessage(
    rt: TeamRuntime,
    input: { from: string; to: string; kind: 'board' | 'direct'; text: string },
  ): TeamMessageState {
    if (rt.state.messages.length >= TEAM_MAX_MESSAGES) {
      throw new TeamValidationError(`消息条数超过上限 ${TEAM_MAX_MESSAGES}`);
    }
    const messageId = `m-${randomUUID()}`;
    const text = teamMessageText(input.text);
    const payload = {
      teamId: rt.state.teamId,
      messageId,
      from: input.from,
      to: input.to,
      kind: input.kind,
      text,
    };
    appendTeamMessage(this.writer, payload);
    applyTeamMessage(rt.state, payload, this.now());
    const appended = rt.state.messages[rt.state.messages.length - 1];
    return { ...appended! };
  }

  /** 落一条 team/event 并就地应用到内存态（内存态与落盘态用同一 applyTeamEvent） */
  private emit(state: TeamState, payload: TeamEventPayload): void {
    const normalized: TeamEventPayload =
      payload.outputPreview !== undefined ? { ...payload, outputPreview: teamPreview(payload.outputPreview) } : payload;
    appendTeamEvent(this.writer, normalized);
    applyTeamEvent(state, normalized, this.now());
  }

  private requireTeam(teamId: string): TeamRuntime {
    const rt = this.teams.get(teamId);
    if (rt === undefined) throw new TeamValidationError(`团队不存在：${teamId}`);
    return rt;
  }

  private requireTask(state: TeamState, taskId: string): TeamTaskState {
    const task = state.tasks.find((t) => t.taskId === taskId);
    if (task === undefined) throw new TeamValidationError(`任务不存在：${taskId}`);
    return task;
  }

  private requireMember(state: TeamState, member: string): TeamMemberState {
    const found = state.members.find((m) => m.name === member);
    if (found === undefined) throw new TeamValidationError(`成员不存在：${member}`);
    return found;
  }
}

function cloneTask(task: TeamTaskState): TeamTaskState {
  return { ...task, dependsOn: [...task.dependsOn] };
}

function cloneState(state: TeamState): TeamState {
  return {
    ...state,
    members: state.members.map((m) => ({ ...m })),
    tasks: state.tasks.map(cloneTask),
    messages: state.messages.map((m) => ({ ...m })),
  };
}
