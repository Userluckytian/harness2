// A14 工作流编排（Z6 批次6）——类型面与失控保护常量。
//
// 立场（对齐 ZCode 调研结论 + 我们的数据面裁剪，详见报告「调研」一节）：
//   - ZCode 有两套工作流：核心 `workflow/`（expert 长任务：phase + 依赖图 scheduler，
//     运行快照 + graph 记录 + 事件三路落盘，resume 时 active→pending 重置）与
//     脚本工作流（`.zcode/workflows/*`，agent 调用 + 缓存 + activity 记录）。
//     两者都远超我们当前数据面：没有 phase/artifact/graph planner，也不执行用户脚本。
//   - 本模块只做**步进编排子集**：有序步骤 + 显式依赖（并发）+ 四类步骤 + 三档失败策略 +
//     有界重试 + 断点续跑。落账只走一条通道：会话台账的扩展事件 `workflow/run`
//     （红线①「不落盘的就不显示」；红线② append-only 单写者由 SessionWriter 保证）。
//   - 不新造审批：审批闸步骤直接消费既有 ApprovalHandler（tools/types.ts）。
//   - 并发闸复用既有 agent/task-coordinator 的只读并行闸（有界、排队、不超限），
//     引擎内建一个新的 TaskCoordinator 实例承载，不另起无界并行机制。
//
// 失控保护（全部有常量 + 测试）：步数上限、单步超时、并发上限、重试上限、递归深度。

/** 工作流定义的步骤上限（解析期 fail-closed；超出即拒，不截断） */
export const WORKFLOW_MAX_STEPS = 128;

/** 单步超时缺省值（毫秒） */
export const WORKFLOW_DEFAULT_STEP_TIMEOUT_MS = 120_000;

/** 单步超时上限（毫秒；定义里超过即拒，fail-closed） */
export const WORKFLOW_MAX_STEP_TIMEOUT_MS = 600_000;

/** 并发上限缺省值（同时执行中的步骤数） */
export const WORKFLOW_DEFAULT_MAX_CONCURRENCY = 4;

/** 并发上限天花板（定义里 maxConcurrency 超过即拒；与子代理扇出上限 8 对齐） */
export const WORKFLOW_MAX_CONCURRENCY_CEILING = 8;

/** 重试次数上限（failurePolicy='retry' 时单步最多额外重试次数；超过即拒） */
export const WORKFLOW_MAX_RETRIES = 5;

/** failurePolicy='retry' 且未声明 maxRetries 时的缺省额外重试次数 */
export const WORKFLOW_DEFAULT_RETRIES = 1;

/**
 * 递归深度上限。当前**不提供 workflow 步骤类型**（不做工作流嵌套，见报告裁剪清单），
 * 因此「工作流里起工作流」在引擎入口被直接拒绝：depth 只能为 0，任何 depth>0 的启动
 * （宿主试图在工作流内再起工作流）即 fail-closed 抛错。保留该常量与断言，供未来若加
 * 「嵌套工作流」步骤时按限深口径放开。
 */
export const WORKFLOW_MAX_DEPTH = 0;

/** 落账输出预览字符上限（截断 + 脱敏后再进 payload） */
export const WORKFLOW_OUTPUT_PREVIEW_CHARS = 500;

/** 步骤类型（我们数据面支撑得起的四类；ZCode 的 phase/planner/critic 已裁剪） */
export const WORKFLOW_STEP_TYPES = ['prompt', 'tool', 'subagent', 'approval'] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/** 步骤状态机：pending → running →（ok | failed | skipped | blocked）；running 可多次（重试） */
export const WORKFLOW_STEP_STATUSES = ['pending', 'running', 'ok', 'failed', 'skipped', 'blocked'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

/** 运行状态机：pending → running →（ok | failed | cancelled） */
export const WORKFLOW_RUN_STATUSES = ['pending', 'running', 'ok', 'failed', 'cancelled'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** 失败策略（ZCode 裁剪：不采纳 recoveryActions/retry_with_current_model） */
export const WORKFLOW_FAILURE_POLICIES = ['stop', 'continue', 'retry'] as const;
export type WorkflowFailurePolicy = (typeof WORKFLOW_FAILURE_POLICIES)[number];

/** 步骤是否需要占用工作区写锁（并发闸的只读/写分派；缺省 readonly） */
export type WorkflowStepWriteMode = 'readonly' | 'write';

/** 一个步骤定义（解析后可执行形态，缺省值已归一） */
export interface WorkflowStepDefinition {
  /** 步骤 id（步骤内唯一；`[A-Za-z0-9_-]`，不得含空白） */
  id: string;
  type: WorkflowStepType;
  /** 展示标题（缺省用 id） */
  title: string;
  /** prompt/subagent 步骤的指令；approval 步骤的人类可读门禁说明（可缺省） */
  prompt?: string;
  /** prompt/subagent 步骤的模型串（`provider/model`；缺省由宿主决定） */
  model?: string;
  /** tool 步骤的工具名；approval 步骤的可核对目标工具名（缺省 'workflow'） */
  tool?: string;
  /** tool 步骤的参数；approval 步骤的规则主体参数 */
  args?: unknown;
  /**
   * 依赖的步骤 id 列表。
   *   - 缺席 = 依赖**声明顺序上的前一步**（线性链，确定性）；
   *   - 显式空数组 = 无依赖（可与之并发）；
   *   - 非空 = 全部依赖成功（ok）后本步才 ready。
   */
  dependsOn: readonly string[];
  /** 单步超时（毫秒；缺省 WORKFLOW_DEFAULT_STEP_TIMEOUT_MS） */
  timeoutMs: number;
  /** 并发闸的资源型（缺省 readonly） */
  writeMode: WorkflowStepWriteMode;
  /** 本步重试次数（覆盖定义级 maxRetries；缺省取定义值） */
  maxRetries?: number;
}

/** 一个工作流定义（解析后可执行形态） */
export interface WorkflowDefinition {
  /** 定义 id（`[a-z0-9][a-z0-9-]*`；也是命令面 `/workflow start <name>` 的键） */
  name: string;
  description: string;
  /** 定义版本（自由字符串；缺省 '1'） */
  version: string;
  failurePolicy: WorkflowFailurePolicy;
  /** 同时执行中的步骤上限（1..WORKFLOW_MAX_CONCURRENCY_CEILING） */
  maxConcurrency: number;
  /** 定义级重试次数（解析后必在场；非 retry 策略下不使用） */
  maxRetries: number;
  steps: readonly WorkflowStepDefinition[];
}

/** 定义来源层级（对齐 ZCode 的 builtin/explicit/project/user 裁剪为两层） */
export type WorkflowDefinitionScope = 'project' | 'user';

/** 发现到的一个定义（含来源路径，供 UI/命令面展示） */
export interface DiscoveredWorkflowDefinition {
  definition: WorkflowDefinition;
  /** 定义文件绝对路径 */
  path: string;
  scope: WorkflowDefinitionScope;
}

/** 定义发现时被拒的文件（fail-closed：非法定义不进可运行集，如实登记原因） */
export interface WorkflowDefinitionError {
  path: string;
  scope: WorkflowDefinitionScope;
  message: string;
}

/** 步骤一次执行的结局（步骤执行器返回值；blocked 仅审批闸产生） */
export interface WorkflowStepOutcome {
  ok: boolean;
  output?: string;
  error?: string;
  /** 审批未通过（不被重试；直接落 blocked） */
  blocked?: boolean;
}

/** 步骤执行器入参（宿主注入；测试用 fake，不真起模型/进程） */
export interface WorkflowStepRunInput {
  runId: string;
  cwd: string;
  step: WorkflowStepDefinition;
  /** 组合了引擎取消信号、并发闸信号与本步超时的信号 */
  signal: AbortSignal;
}

/** 步骤执行器缝：类型为 prompt/tool/subagent 的步骤各自有入口 */
export interface WorkflowStepRunners {
  /** 跑模型 prompt（宿主接 agent loop；缺省 = 该步失败并提示未装配） */
  prompt?: (input: WorkflowStepRunInput) => Promise<WorkflowStepOutcome>;
  /** 调工具（宿主接 ToolRegistry 执行器） */
  tool?: (input: WorkflowStepRunInput) => Promise<WorkflowStepOutcome>;
  /** 起子代理（宿主接 subagent/fanout 装配） */
  subagent?: (input: WorkflowStepRunInput) => Promise<WorkflowStepOutcome>;
}

/** 步骤运行态（投影与引擎内建状态共用同一形状，保证「落盘态 == 内存态」） */
export interface WorkflowStepState {
  stepId: string;
  type: WorkflowStepType;
  /** 展示标题（投影时从定义补，缺失则等于 stepId） */
  title: string;
  status: WorkflowStepStatus;
  /** 已尝试次数（running 事件计数；pending 为 0） */
  attempts: number;
  outputPreview?: string;
  error?: string;
}

/** 一次运行的完整可查询状态（UI 契约：右栏 tab / 状态面板 Workflow 子块消费） */
export interface WorkflowRunState {
  runId: string;
  workflow: string;
  status: WorkflowRunStatus;
  steps: WorkflowStepState[];
  startedAt?: string;
  updatedAt?: string;
}
