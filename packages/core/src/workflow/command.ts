// A14 工作流命令面：把 `/workflow`（列表/启动/查看状态/取消）注册进 core 命令表。
//
// 走**既有能力面**（D02 命令注册开放化）：`registerCoreCommand` 注册为 source='extension' 的
// 扩展命令，随即进入 findCoreCommand / runCoreCommand 分发面与 describeCapabilities().commands
// ——CLI 与桌面经同一份能力面即可看到（GUI 渲染留后续批次）。
// 之所以不用内建目录（catalog.ts）：内建命令是各壳测试钉死的固定集合（29 条），新增内建会
// 牵动 CLI/桌面测试；扩展命令是 core 既有的加性注册缝，语义与「宿主装配后可见」正相符。
// 宿主（CLI/桌面）在装配时调用 `registerWorkflowCommand(runtime)`，返回的 disposer 用于卸载。
import { registerCoreCommand, unregisterCoreCommand } from '../commands/registry.js';
import type { CoreCommandContext } from '../commands/types.js';
import type { DiscoveredWorkflowDefinition, WorkflowRunState, WorkflowStepState } from './types.js';

/** 命令名（`/workflow`） */
export const WORKFLOW_COMMAND_ID = 'workflow';

/** 命令面运行时缝（宿主装配提供；core 不内置真实执行/落盘以外的能力） */
export interface WorkflowCommandRuntime {
  /** 列出已发现的工作流定义（项目 + 用户，项目覆盖同名） */
  listDefinitions(): readonly DiscoveredWorkflowDefinition[];
  /** 启动一个工作流；返回 runId。未知定义应抛错（命令面转成 error 行） */
  start(name: string): Promise<{ runId: string }>;
  /** 查看运行状态；缺省取最近一次运行 */
  status(runId?: string): WorkflowRunState | undefined;
  /** 取消运行；返回是否命中（不存在/false） */
  cancel(runId: string): boolean;
}

/** 步骤状态的可读标记（纯展示，不影响状态机） */
function stepMark(status: WorkflowStepState['status']): string {
  switch (status) {
    case 'pending':
      return '[ ]';
    case 'running':
      return '[>]';
    case 'ok':
      return '[✓]';
    case 'failed':
      return '[✗]';
    case 'skipped':
      return '[-]';
    case 'blocked':
      return '[!]';
  }
}

/** 运行态 → 文本行（纯函数；供命令面与后续 GUI 状态子块复用同一口径） */
export function formatWorkflowRun(state: WorkflowRunState | undefined): string[] {
  if (state === undefined) return ['（无运行记录）'];
  const lines = [`运行 ${state.runId}（${state.workflow}）状态：${state.status}`];
  for (const step of state.steps) {
    const attempt = step.attempts > 1 ? ` ×${step.attempts}` : '';
    const detail = step.error ?? step.outputPreview ?? '';
    lines.push(`  ${stepMark(step.status)} ${step.title}${attempt}${detail.length > 0 ? ` — ${detail}` : ''}`);
  }
  return lines;
}

/** 定义 → 文本行（纯函数） */
export function formatWorkflowDefinitions(definitions: readonly DiscoveredWorkflowDefinition[]): string[] {
  if (definitions.length === 0) return ['（未发现工作流定义；在 .harness2/workflows/ 放 *.json）'];
  return definitions.map((d) => `  ${d.definition.name}（${d.scope}）— ${d.definition.description}`);
}

const USAGE = '用法：/workflow <list|start <名称>|status [runId]|cancel <runId>>';

/**
 * 执行 `/workflow` 子命令（纯文本输出，错误行以 'error: ' 开头）。
 * 导出便于宿主自行分发时复用同一文案；`registerWorkflowCommand` 内部亦调用它。
 */
export async function runWorkflowCommand(
  ctx: Pick<CoreCommandContext, 'print'>,
  args: { rest: string },
  runtime: WorkflowCommandRuntime,
): Promise<void> {
  const words = args.rest
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const sub = words[0] ?? 'list';

  if (sub === 'list') {
    for (const line of formatWorkflowDefinitions(runtime.listDefinitions())) ctx.print(line);
    return;
  }

  if (sub === 'start') {
    const name = words[1];
    if (name === undefined) {
      ctx.print(`error: ${USAGE}`);
      return;
    }
    try {
      const { runId } = await runtime.start(name);
      ctx.print(`已启动工作流 ${name}：runId=${runId}`);
    } catch (e) {
      ctx.print(`error: 启动失败：${(e as Error)?.message ?? String(e)}`);
    }
    return;
  }

  if (sub === 'status') {
    for (const line of formatWorkflowRun(runtime.status(words[1]))) ctx.print(line);
    return;
  }

  if (sub === 'cancel') {
    const runId = words[1];
    if (runId === undefined) {
      ctx.print(`error: ${USAGE}`);
      return;
    }
    ctx.print(runtime.cancel(runId) ? `已请求取消 ${runId}` : `error: 未找到运行 ${runId}`);
    return;
  }

  ctx.print(`error: 未知子命令 ${sub}。${USAGE}`);
}

/**
 * 注册 `/workflow` 扩展命令（source='extension'），返回卸载 disposer。
 * 重复注册同名命令由命令注册表 fail-closed 抛错（不静默覆盖）。
 */
export function registerWorkflowCommand(runtime: WorkflowCommandRuntime): () => void {
  registerCoreCommand({
    id: WORKFLOW_COMMAND_ID,
    group: '调度',
    summary: '工作流编排（列出/启动/查看状态/取消）',
    argsSpec: '<list|start <名称>|status [runId]|cancel <runId>>',
    run: (ctx, args) => runWorkflowCommand(ctx, args, runtime),
  });
  return () => {
    unregisterCoreCommand(WORKFLOW_COMMAND_ID);
  };
}
