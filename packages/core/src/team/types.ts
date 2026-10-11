// A11 Agent Teams 编排层（Z6 批次6-B）——类型面与失控保护常量。
//
// 立场（对齐 ZCode 调研结论 + 我们的数据面裁剪，详见交付报告「调研」一节）：
//   - ZCode 没有独立命名的「Teams」编排器；最接近的是**工作流运行中的子代理花名册**
//     （actor = siteId@ordinal + name + 相位态 idle/executing/waiting/parked/done/failed/unfinished，
//     带 maxConcurrentLoops 并发上限与 slot/backoff 等待）以及 **session mailbox**（会话间定向消息）。
//   - 本模块把「团队 = 具名成员集合 + 团队级共享任务板 + 成员间消息」建成 core 编排层：
//     成员即子会话（复用既有 subagent 机制，不另造进程模型）；任务板与消息经**扩展事件**
//     `team/event` / `team/message` 落盘（opaque 投影，红线①「不落盘的就不显示」）；
//     并发上限**必须**走既有 agent/task-coordinator 资源锁（写全局串行、只读 K=2），不另起并行机制。
//   - 边界：Teams 是「长期挂着的成员 + 共享任务板 + 成员间消息」的协作面；A14 工作流是
//     「一次性、有依赖图的步骤串」。二者都复用 subagent 与 TaskCoordinator，但 Teams 不做
//     步骤依赖图执行，工作流不做成员间消息与任务板领取。
//
// 失控保护（全部有常量 + 测试）：团队规模、成员轮次、任务条数、消息条数与字符上限、递归深度。

/** 团队名约束（与工作流定义同名风格：小写字母数字起头，仅小写字母/数字/连字符） */
export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 成员角色名约束（大小写字母/数字起头，允许下划线与连字符；团队内唯一） */
export const TEAM_MEMBER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 一个团队的成员数上限（与子代理扇出上限 8 对齐：防一次组队打爆并发/配额） */
export const TEAM_MAX_MEMBERS = 8;

/** 一个团队的任务板条目上限（解析/新增期 fail-closed；超出即拒，不截断） */
export const TEAM_MAX_TASKS = 64;

/** 单个成员单次 runTeam 的轮次缺省值 */
export const TEAM_DEFAULT_MAX_ROUNDS = 1;

/** 单个成员单次 runTeam 的轮次上限（定义里 / 调用时超过即拒，fail-closed） */
export const TEAM_MAX_ROUNDS = 5;

/** 单个团队累计消息条数上限（成员→板 + 成员↔成员 合计；超出即拒） */
export const TEAM_MAX_MESSAGES = 200;

/** 单条消息字符上限（截断 + 脱敏后再落盘） */
export const TEAM_MAX_MESSAGE_CHARS = 2000;

/** 任务标题字符上限（fail-closed：超出即拒） */
export const TEAM_MAX_TASK_TITLE_CHARS = 200;

/** 团队成员可声明的工具名条数上限（fail-closed） */
export const TEAM_MAX_MEMBER_TOOLS = 32;

/**
 * 递归深度上限。与 A14 工作流同口径（WORKFLOW_MAX_DEPTH=0）：**团队不能再起团队**——
 * 团队编排器构造时任何 depth>0 即 fail-closed 抛错。保留常量与断言，供未来若放开嵌套时按限深口径改。
 */
export const TEAM_MAX_DEPTH = 0;

/** 共享任务板的广播收件人名（成员→团队板留痕的 `to`） */
export const TEAM_BOARD_TARGET = 'board';

/** 成员占用的资源型（并发闸分派依据；缺省 write = 成员可能写文件，保守串行） */
export type TeamMemberWriteMode = 'readonly' | 'write';

/** 成员状态的相位词（对齐 ZCode 花名册：idle/executing/done/failed；stopped 为取消态） */
export const TEAM_MEMBER_STATUSES = ['idle', 'running', 'done', 'failed', 'stopped'] as const;
export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUSES)[number];

/** 团队整体状态：running → stopped | failed */
export const TEAM_STATUSES = ['running', 'stopped', 'failed'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/**
 * 任务板状态机：todo → claimed →（done | failed）；claimed 可退回 todo（释放）；
 * todo 可直接 blocked（依赖不可满足）或 failed。终态 = done / failed / blocked。
 */
export const TEAM_TASK_STATUSES = ['todo', 'claimed', 'done', 'failed', 'blocked'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** 任务状态迁移表（唯一状态机口径；终态无出边） */
export const TEAM_TASK_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  todo: ['claimed', 'failed', 'blocked'],
  claimed: ['done', 'failed', 'todo'],
  done: [],
  failed: [],
  blocked: [],
};

/** 是否任务终态（无出边） */
export function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return TEAM_TASK_TRANSITIONS[status].length === 0;
}

/** 任务状态迁移是否合法（fail-closed：未列出的迁移一律拒绝） */
export function canTeamTaskTransition(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  if (from === to) return true;
  return TEAM_TASK_TRANSITIONS[from].includes(to);
}

/** 成员规格（解析后归一形态） */
export interface TeamMemberSpec {
  /** 角色名（团队内唯一；`[A-Za-z0-9][A-Za-z0-9_-]*`） */
  name: string;
  /** 成员的初始任务/角色提示（不落盘，只在 runner 入参里出现） */
  prompt?: string;
  /** 成员使用的模型串（`provider/model`；缺省由宿主决定） */
  model?: string;
  /** 成员可用的工具名/工具集名（缺省由宿主决定） */
  tools?: readonly string[];
  /** 并发闸资源型（缺省 'write'） */
  writeMode: TeamMemberWriteMode;
}

/** 成员规格输入（可选字段的宽松形态） */
export interface TeamMemberSpecInput {
  name: string;
  prompt?: string;
  model?: string;
  tools?: readonly string[];
  writeMode?: TeamMemberWriteMode;
}

/** 团队定义（解析后可执行形态） */
export interface TeamDefinition {
  name: string;
  description: string;
  members: readonly TeamMemberSpec[];
  /** 单成员单次 runTeam 的轮次上限（1..TEAM_MAX_ROUNDS） */
  maxRounds: number;
}

/** 团队定义输入 */
export interface TeamDefinitionInput {
  name: string;
  description?: string;
  members: readonly TeamMemberSpecInput[];
  maxRounds?: number;
}

/** 共享任务板条目输入 */
export interface TeamTaskInput {
  /** 任务 id（缺省自动生成；`[A-Za-z0-9_-]+`） */
  taskId?: string;
  title: string;
  /** 依赖的任务 id（全部 done 后本任务才可领取） */
  dependsOn?: readonly string[];
}

/** 共享任务板条目状态（投影与编排器内建状态共用同一形状，保证「落盘态 == 内存态」） */
export interface TeamTaskState {
  taskId: string;
  title: string;
  status: TeamTaskStatus;
  /** 当前领取该任务的成员名（todo 时缺席） */
  owner?: string;
  dependsOn: string[];
  updatedAt?: string;
}

/** 成员运行态（投影与编排器内建状态共用同一形状） */
export interface TeamMemberState {
  name: string;
  status: TeamMemberStatus;
  /** 已完成的轮次（runTeam 逐轮累加；未跑为 0） */
  rounds: number;
  writeMode: TeamMemberWriteMode;
  model?: string;
  /** 成员子会话 id（装配层 runner 创建子会话后回填；缺席 = 尚未起会话） */
  childSessionId?: string;
  /** 最近一次运行的结局摘要（截断 + 脱敏；仅非空时有） */
  outputPreview?: string;
  error?: string;
}

/** 成员间消息（成员→团队板 或 成员↔成员定向；从已落盘 `team/message` 重放） */
export interface TeamMessageState {
  messageId: string;
  /** 发送方（成员名；或 'board' 表示团队板/编排者） */
  from: string;
  /** 接收方（成员名；或 'board' 表示团队板留痕） */
  to: string;
  kind: 'board' | 'direct';
  text: string;
  /** 落盘序号（读侧回填；内存态可为空） */
  seq?: number;
  ts?: string;
}

/** 一个团队的完整可查询状态（UI 契约：命令面 / 桌面只读视图消费） */
export interface TeamState {
  teamId: string;
  name: string;
  description: string;
  parentSessionId: string;
  status: TeamStatus;
  members: TeamMemberState[];
  tasks: TeamTaskState[];
  messages: TeamMessageState[];
  createdAt?: string;
  updatedAt?: string;
}

/** 校验失败一律抛此错误（fail-closed；命令面转成 error 行） */
export class TeamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamValidationError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 解析团队定义（fail-closed）：
 *   - name 非空且匹配 TEAM_NAME_PATTERN；
 *   - members 为 1..TEAM_MAX_MEMBERS 的数组；每项 name 匹配 + 团队内唯一；
 *   - prompt/model 若在场须为非空字符串；tools 若在场须为字符串数组（≤ TEAM_MAX_MEMBER_TOOLS）；
 *   - writeMode 若在场须为 'readonly'|'write'（缺省 'write'）；
 *   - maxRounds 若在场须为 [1, TEAM_MAX_ROUNDS] 的整数（缺省 TEAM_DEFAULT_MAX_ROUNDS）。
 */
export function parseTeamDefinition(input: TeamDefinitionInput): TeamDefinition {
  if (input === null || typeof input !== 'object') {
    throw new TeamValidationError('团队定义必须是对象');
  }
  if (!isNonEmptyString(input.name) || !TEAM_NAME_PATTERN.test(input.name)) {
    throw new TeamValidationError(`团队名非法：${String(input.name)}（需匹配 ${TEAM_NAME_PATTERN}）`);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new TeamValidationError('团队 description 必须是字符串');
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new TeamValidationError('团队至少需要一个成员');
  }
  if (input.members.length > TEAM_MAX_MEMBERS) {
    throw new TeamValidationError(`团队成员数超过上限 ${TEAM_MAX_MEMBERS}（收到 ${input.members.length}）`);
  }
  const seen = new Set<string>();
  const members: TeamMemberSpec[] = input.members.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') {
      throw new TeamValidationError(`第 ${index} 个成员必须是对象`);
    }
    if (!isNonEmptyString(raw.name) || !TEAM_MEMBER_NAME_PATTERN.test(raw.name)) {
      throw new TeamValidationError(`成员名非法：${String(raw.name)}（需匹配 ${TEAM_MEMBER_NAME_PATTERN}）`);
    }
    if (seen.has(raw.name)) {
      throw new TeamValidationError(`成员名重复：${raw.name}`);
    }
    seen.add(raw.name);
    if (raw.prompt !== undefined && !isNonEmptyString(raw.prompt)) {
      throw new TeamValidationError(`成员 ${raw.name} 的 prompt 必须是非空字符串`);
    }
    if (raw.model !== undefined && !isNonEmptyString(raw.model)) {
      throw new TeamValidationError(`成员 ${raw.name} 的 model 必须是非空字符串`);
    }
    if (raw.tools !== undefined) {
      if (
        !Array.isArray(raw.tools) ||
        !raw.tools.every((t: unknown): t is string => typeof t === 'string' && t.length > 0)
      ) {
        throw new TeamValidationError(`成员 ${raw.name} 的 tools 必须是字符串数组`);
      }
      if (raw.tools.length > TEAM_MAX_MEMBER_TOOLS) {
        throw new TeamValidationError(`成员 ${raw.name} 的 tools 超过上限 ${TEAM_MAX_MEMBER_TOOLS}`);
      }
    }
    if (raw.writeMode !== undefined && raw.writeMode !== 'readonly' && raw.writeMode !== 'write') {
      throw new TeamValidationError(`成员 ${raw.name} 的 writeMode 必须是 readonly|write`);
    }
    const spec: TeamMemberSpec = {
      name: raw.name,
      writeMode: raw.writeMode ?? 'write',
    };
    if (raw.prompt !== undefined) spec.prompt = raw.prompt;
    if (raw.model !== undefined) spec.model = raw.model;
    if (raw.tools !== undefined) spec.tools = [...raw.tools];
    return spec;
  });

  let maxRounds = TEAM_DEFAULT_MAX_ROUNDS;
  if (input.maxRounds !== undefined) {
    if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > TEAM_MAX_ROUNDS) {
      throw new TeamValidationError(`maxRounds 必须是 [1, ${TEAM_MAX_ROUNDS}] 的整数`);
    }
    maxRounds = input.maxRounds;
  }

  return {
    name: input.name,
    description: input.description ?? '',
    members,
    maxRounds,
  };
}
