// Subagent 工具（阶段 8 Task 3）：把"派一个独立子会话跑子任务"暴露为普通工具。
// 核心不变量（Global Constraints 1/4）：
//   - 零新增事件类型：子会话跑完整 runTurn（天然继承事件溯源/轨迹/undo 隔离），
//     父子关联 = 子 header 血缘（parentSession/isSeeded/subagent）+ tool/result.output
//     里的 childSessionId；父日志只有 tool/call + tool/result 两行。
//   - 深度限制：子会话工具集 = 宿主工具集 − subagent 工具，再按 (depth+1) < maxDepth
//     条件重挂 subagent 工具；默认 maxDepth = 1（子内无 subagent 工具，不能再下钻）。
//   - 取消传播：子 runTurn 直接消费父 turn 的 ctx.signal——父 abort → 子 abort，
//     子会话以 cancelled 收尾且事件照常落盘（append-only）。
//   - 审批缝同源：子会话复用宿主 ApprovalHandler（ask 上抛同一审批通道；缺省按拒绝）。
// 口径统一（阶段 11 Task 2，消化 OPEN.md 留档）：子会话工具集 = 宿主集 − subagent 工具
//   − per-session 绑定类（memory/browser_*），CLI 与 serve 两端一致（统一到 architecture.md
//   既声明的 serve 语义）；skills 注入对子会话为**加性**能力——子会话 turn 传宿主同款
//   SkillStore，system 亦得「[Skills 可用]」列表（消除"继承 skill 工具但盲调"缺口）。
//   v1 口径其余不变：子会话不注入记忆/压缩（短生命周期子任务，与 cron 执行同口径）；
//   非沙箱——子会话与父同进程运行，隔离边界与插件小节一致（architecture.md 如实声明）。
import { resolve, isAbsolute } from 'node:path';
import { loadSession } from '../session/reader.js';
import { SESSION_ID_PATTERN } from '../session/manager.js';
import { SnapshotStore } from '../session/snapshots.js';
import { SessionManager } from '../session/manager.js';
import { SessionWriter } from '../session/writer.js';
import { runTurn } from './loop.js';
import type { TurnResult, TurnStopReason } from './types.js';
import type { AnySessionEvent, SessionEvent, SessionEventType, SessionEventMap } from '../session/types.js';
import type { SessionAppender } from '../session/writer.js';
import type { ChatProvider } from '../provider/types.js';
import type { SkillStore } from '../skills/store.js';
import { BROWSER_TOOL_NAMES } from '../tools/predefined/browser.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolContext, ApprovalHandler } from '../tools/types.js';
import { isTerminalTaskState } from '../interaction/types.js';
import { TaskCoordinator } from './task-coordinator.js';
import type { TaskRunResult, TaskSpec, TaskWriteMode } from './task-coordinator.js';

/** subagent 工具名（装配层据此从子会话工具集剔除，实现深度限制） */
export const SUBAGENT_TOOL_NAMES = ['subagent_start', 'subagent_continue'] as const;

/**
 * per-session 绑定类工具名（子会话不继承——阶段 11 口径统一，两端一致）：
 * memory（记忆按宿主进程绑定）与 browser_*（浏览器上下文按会话 id 绑定池键）。
 * 子会话是独立会话，继承会带来跨会话状态污染（CLI 历史上共享注册表直通导致继承，
 * serve 为换装不继承——统一剔除）。
 */
export const SUBAGENT_SESSION_BOUND_TOOL_NAMES = ['memory', ...BROWSER_TOOL_NAMES] as const;

/** 缺省深度上限（config.subagent.maxDepth 可调） */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
/** 子会话单 turn 最大 step 数（config.subagent.maxTurns 可调） */
export const DEFAULT_SUBAGENT_MAX_TURNS = 25;

/** subagent_start 输出（JSON 序列化进 tool/result.output；桌面端据此跳转子会话 traj） */
export interface SubagentStartOutput {
  childSessionId: string;
  finalText?: string;
  stopReason: TurnStopReason;
  error?: string;
}

/** 子会话事件观察缝（装配层桥接 hub 镜像/WS；缺省无观察） */
export interface SubagentHooks {
  onChildEvent?(sessionId: string, event: AnySessionEvent): void;
  onChildTurnEnd?(sessionId: string, result: TurnResult): void;
}

export interface SubagentOptions {
  manager: SessionManager;
  /** 子会话 turn 使用的 provider（装配层按 roles.subagent 派生，缺省回退主 provider） */
  provider: ChatProvider;
  /** 宿主工具集（含本地/插件/MCP/subagent 工具；子会话按深度规则重建） */
  baseTools: ToolRegistry;
  /** 审批缝（与宿主同源；缺省 allow-all） */
  approval?: ApprovalHandler;
  /**
   * 审批上抛工厂（装配层注入）：子会话 ask 走与父相同的待审批通道，但 sessionId 记为
   * 子会话 id（UI 按子会话归属展示）。与 approval 同时提供时工厂优先。
   */
  approvalFactory?: (childSessionId: string, parentSessionId: string, signal: AbortSignal) => ApprovalHandler;
  /** 工具执行 cwd + 子会话缺省分组目录 */
  cwd: string;
  maxDepth: number;
  maxTurns: number;
  /** 父会话 id（写入子 header.parentSession；continue 只认自己的子会话） */
  parentSessionId: string;
  /** 当前会话深度（0 = 用户主会话）：depth < maxDepth 才允许注册本工具 */
  depth: number;
  /**
   * 宿主 Skills 商店（加性，阶段 11 口径统一）：子会话 turn 注入「[Skills 可用]」列表，
   * 与宿主同一 store（两级目录同源）。缺省不注入——skill 工具仍可能经共享注册表被
   * 子会话继承，但列表缺席即"盲调"缺口（OPEN.md 阶段 10 并案），装配层应总是传入。
   */
  skills?: SkillStore;
  hooks?: SubagentHooks;
  /** 会话日志 fsync（测试可关） */
  fsync?: boolean;
  /** S5：后台任务协调器（装配层注入）。与 background:true 配合时 subagent_start 注册为后台任务，立返 taskId。 */
  coordinator?: TaskCoordinator;
  /** S5：Hub 级 registerTask（设置 taskSessions 归属映射 + 走协调器调度；用于 journal 录入）。
   *  缺省时退化为 coordinator.register（无 session 归属映射，journal 不落账）。 */
  registerTask?: (spec: TaskSpec) => { taskId: string };
  /** S5：subagent_start 是否注册为后台任务（仅 coordinator 注入时生效；缺省 false = 现状同步 inline）。
   *  开启后父 turn 不阻塞等子任务结果；后台走协调器只读 K=2 / 写串行。 */
  background?: boolean;
  /** S5：后台子代理任务的资源型（仅 background 时生效；缺省 'write' = 子会话可能写文件）。 */
  taskWriteMode?: TaskWriteMode;
}

/** 子会话 turn 的审批缝：工厂优先（按子会话 id 上抛），否则固定 handler，缺省 allow-all */
function approvalFor(opts: SubagentOptions, childSessionId: string, signal: AbortSignal): ApprovalHandler | undefined {
  if (opts.approvalFactory !== undefined) return opts.approvalFactory(childSessionId, opts.parentSessionId, signal);
  return opts.approval;
}

/**
 * 构建子会话工具集：宿主工具 − subagent 工具 − per-session 绑定类（memory/browser_*，
 * 阶段 11 口径统一：两端一致，不继承会话绑定状态），再按 子深度 < maxDepth 重挂
 * subagent 工具（重挂时血缘重绑：parentSessionId = 子会话 id、depth = options.depth + 1，
 * 供更深递归）。options 描述"派发方"会话（parentSessionId = 派发方 id，depth = 派发方深度）；
 * childSessionId = 本次派发的子会话 id。
 */
export function buildSubagentChildTools(options: SubagentOptions, childSessionId: string): ToolRegistry {
  const registry = new ToolRegistry();
  const subNames = new Set<string>(SUBAGENT_TOOL_NAMES);
  const sessionBound = new Set<string>(SUBAGENT_SESSION_BOUND_TOOL_NAMES);
  for (const def of options.baseTools.list()) {
    if (subNames.has(def.name) || sessionBound.has(def.name)) continue;
    registry.register(def);
  }
  const childDepth = options.depth + 1;
  if (childDepth < options.maxDepth) {
    for (const def of createSubagentTools({ ...options, parentSessionId: childSessionId, depth: childDepth })) {
      registry.register(def);
    }
  }
  return registry;
}

/**
 * 构造 subagent 工具对（subagent_start / subagent_continue）。
 * 装配层注册条件：options.depth < options.maxDepth（深度红线在装配处收口）。
 */
export function createSubagentTools(options: SubagentOptions): ToolDefinition[] {
  const opts = options;
  // S5：后台任务结果暂存（taskId → subagent_start 输出 JSON；subagent_continue 收 status/结果用）
  const taskOutcomes = new Map<string, string>();

  const startTool: ToolDefinition = {
    name: 'subagent_start',
    description:
      '派发一个独立子会话执行子任务：子会话有独立轨迹（traj 可查、独立 undo），完成后返回最终结果。' +
      '适合可整体交付的探索/批量/独立写作类任务；子会话内不能再派发子任务。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '发给子会话的完整任务指令（自包含上下文）' },
        cwd: { type: 'string', description: '可选：子会话工作目录（相对路径相对当前 cwd）' },
      },
      required: ['prompt'],
    },
    async execute(args: unknown, ctx: ToolContext) {
      const { prompt, cwd } = (args ?? {}) as { prompt?: unknown; cwd?: unknown };
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        return { error: 'prompt 必须是非空字符串' };
      }
      if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
        return { error: 'cwd 必须是非空字符串' };
      }
      const childCwd = typeof cwd === 'string' ? resolveSubPath(ctx.cwd, cwd) : opts.cwd;
      let created: ReturnType<SessionManager['create']>;
      try {
        created = opts.manager.create(childCwd, {
          parentSession: opts.parentSessionId,
          isSeeded: true,
          subagent: true,
          ...(opts.fsync !== undefined ? { fsync: opts.fsync } : {}),
        });
      } catch (e) {
        return { error: `子会话创建失败: ${(e as Error).message}` };
      }
      const childId = created.id;
      // 子会话 writer 观察包裹（先落盘、后回调）：装配层把子会话事件桥接进 hub 镜像/WS
      const observed: SessionAppender =
        opts.hooks?.onChildEvent === undefined
          ? created.writer
          : {
              dir: created.writer.dir,
              get lastSeq(): number {
                return created.writer.lastSeq;
              },
              append<T extends SessionEventType>(type: T, payload: SessionEventMap[T]): SessionEvent<T> {
                const event = created.writer.append(type, payload);
                opts.hooks!.onChildEvent!(childId, event as AnySessionEvent);
                return event;
              },
            };
      const finishOutput = (result: TurnResult): string => {
        const out: SubagentStartOutput = {
          childSessionId: childId,
          stopReason: result.stopReason,
          ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
        opts.hooks?.onChildTurnEnd?.(childId, result);
        return JSON.stringify(out);
      };
      // S5 后台模式：注册进协调器（只读 K=2 / 写串行），立返 taskId（不阻塞父 turn）。
      // 父 cancel → 协调器经其 controller signal abort 该 run → 子 runTurn 取消（父子隔离：
      // 取消只作用于该 run，不 abort 父会话本身的 turn）。
      if (opts.background && opts.coordinator !== undefined) {
        const taskId = `bg-${childId}`;
        const run = async (signal: AbortSignal): Promise<TaskRunResult> => {
          try {
            const result = await runTurn(observed, {
              provider: opts.provider,
              tools: buildSubagentChildTools(opts, childId),
              ...(approvalFor(opts, childId, signal) !== undefined
                ? { approval: approvalFor(opts, childId, signal) }
                : {}),
              // 阶段 11 口径统一（加性）：子会话注入宿主同款 skills 列表
              ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
              cwd: childCwd,
              userText: prompt,
              signal,
              maxSteps: Math.max(1, opts.maxTurns),
              snapshots: new SnapshotStore(created.dir),
            });
            const output = finishOutput(result);
            taskOutcomes.set(taskId, output);
            return { ok: result.stopReason === 'end_turn', error: result.error, output };
          } finally {
            created.writer.close();
          }
        };
        const spec: TaskSpec = {
          taskId,
          sessionId: opts.parentSessionId,
          background: true,
          writeMode: opts.taskWriteMode ?? 'write',
          prompt,
          run,
        };
        // Hub 注册缝：优先走 registerTask（设置 taskSessions 归属映射 → journal 落账），
        // 退化为 coordinator.register（无 session 归属，journal 不落账但协调器仍调度）。
        const reg = opts.registerTask ?? opts.coordinator?.register.bind(opts.coordinator);
        reg?.(spec as never);
        return { output: JSON.stringify({ taskId, childSessionId: childId, state: 'running' }) };
      }
      try {
        // 取消传播：子 runTurn 消费父 turn 的 signal——父 abort → 子 abort（事件照常落盘）
        // P1-4：子会话独立文件快照（rewind_points.jsonl 落子会话目录）——hub.undo(childId)
        // 能真实复原子会话期间 write/edit 的文件，计划红线「独立快照」在此兑现
        const result = await runTurn(observed, {
          provider: opts.provider,
          tools: buildSubagentChildTools(opts, childId),
          ...(approvalFor(opts, childId, ctx.signal) !== undefined
            ? { approval: approvalFor(opts, childId, ctx.signal) }
            : {}),
          // 阶段 11 口径统一（加性）：子会话注入宿主同款 skills 列表
          ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
          cwd: childCwd,
          userText: prompt,
          signal: ctx.signal,
          maxSteps: Math.max(1, opts.maxTurns),
          snapshots: new SnapshotStore(created.dir),
        });
        return { output: finishOutput(result) };
      } catch (e) {
        return { error: `子会话执行失败: ${(e as Error)?.message ?? String(e)}` };
      } finally {
        created.writer.close();
      }
    },
  };

  const continueTool: ToolDefinition = {
    name: 'subagent_continue',
    description:
      '向此前派发的子会话追加一条消息并继续其任务（返回新结果）；或给 background taskId 查询后台任务状态/结果。',
    parameters: {
      type: 'object',
      properties: {
        childSessionId: { type: 'string', description: 'subagent_start 返回的子会话 id' },
        message: { type: 'string', description: '追加给子会话的消息' },
        taskId: { type: 'string', description: 'S5 可选：后台任务 id；提供时返回其当前状态/最终结果（不做续跑）' },
      },
      // P1-1 修复："多选一"必填——taskId（只读查询后台任务）或 childSessionId+message（续跑）。
      // 不能用顶层 required（会经执行器误杀 taskId 查询路径）；anyOf 同时让模型看到两种用法，
      // 执行器对 anyOf/oneOf schema 不做硬拦（见 tools/executor.ts）。
      anyOf: [{ required: ['taskId'] }, { required: ['childSessionId', 'message'] }],
    },
    async execute(args: unknown, ctx: ToolContext) {
      const { childSessionId, message, taskId } = (args ?? {}) as {
        childSessionId?: unknown;
        message?: unknown;
        taskId?: unknown;
      };
      // S5 后台任务 status/结果收口：给了 taskId 就查协调器（不再做续跑；childSessionId/message 忽略）
      if (taskId !== undefined) {
        if (typeof taskId !== 'string' || taskId.trim() === '') {
          return { error: 'taskId 必须是非空字符串' };
        }
        if (opts.coordinator === undefined) return { error: '后台任务协调器未装配' };
        const st = opts.coordinator.status(taskId);
        if (st === undefined) return { error: `后台任务不存在: ${taskId}` };
        if (!isTerminalTaskState(st.state)) {
          return { output: JSON.stringify({ taskId, state: st.state }) };
        }
        const out = taskOutcomes.get(taskId);
        if (out !== undefined) return { output: out };
        // S5 跨 turn：协调器持久结果正文（fresh per-turn tools 取不到本 turn 外 taskOutcomes 时兜底）
        const stored = opts.coordinator.resultOf?.(taskId);
        if (stored?.output !== undefined) return { output: stored.output };
        return { output: JSON.stringify({ taskId, childSessionId, state: st.state }) };
      }
      if (typeof childSessionId !== 'string' || childSessionId.trim() === '') {
        return {
          error: 'childSessionId 必须是非空字符串（续跑需 childSessionId + message；仅查询后台任务请只传 taskId）',
        };
      }
      // P2-3：id 格式先于文件系统校验（与 hub SESSION_ID_PATTERN 同源）——遍历形/任意串
      // 不触达 manager.locate 的路径拼接
      if (!SESSION_ID_PATTERN.test(childSessionId)) {
        return { error: `childSessionId 格式非法: ${childSessionId}` };
      }
      if (typeof message !== 'string' || message.trim() === '') {
        return {
          error: 'message 必须是非空字符串（续跑需 childSessionId + message；仅查询后台任务请只传 taskId）',
        };
      }
      let dir: string;
      try {
        dir = opts.manager.locate(childSessionId);
      } catch {
        return { error: `子会话不存在: ${childSessionId}` };
      }
      // 血缘校验：只能续本会话派发的 subagent 子会话（防误续/跨会话注入）。
      // P2-3：分叉会话（fork）parentSession 同样指向派发方但无 subagent 标志 → 必须一并拒绝
      const header = loadSession(dir).header;
      if (header?.parentSession !== opts.parentSessionId) {
        return { error: `会话 ${childSessionId} 不是本会话的子会话，拒绝续跑` };
      }
      if (header?.subagent !== true) {
        return { error: `会话 ${childSessionId} 不是 subagent 子会话（分叉/普通会话不可续跑）` };
      }
      let writer: SessionWriter;
      try {
        writer = SessionWriter.open(dir, { ...(opts.fsync !== undefined ? { fsync: opts.fsync } : {}) });
      } catch (e) {
        // 目录锁被占（子会话正在别处续跑）等：如实失败，不拖垮父 turn
        return { error: `子会话续跑失败: ${(e as Error)?.message ?? String(e)}` };
      }
      const observed: SessionAppender =
        opts.hooks?.onChildEvent === undefined
          ? writer
          : {
              dir: writer.dir,
              get lastSeq(): number {
                return writer.lastSeq;
              },
              append<T extends SessionEventType>(type: T, payload: SessionEventMap[T]): SessionEvent<T> {
                const event = writer.append(type, payload);
                opts.hooks!.onChildEvent!(childSessionId, event as AnySessionEvent);
                return event;
              },
            };
      try {
        // P1-4：续跑同样传独立快照（与 start 同口径，undo 复原能力跨续跑保持）
        const result = await runTurn(observed, {
          provider: opts.provider,
          tools: buildSubagentChildTools(opts, childSessionId),
          ...(approvalFor(opts, childSessionId, ctx.signal) !== undefined
            ? { approval: approvalFor(opts, childSessionId, ctx.signal) }
            : {}),
          // 阶段 11 口径统一（加性）：子会话注入宿主同款 skills 列表
          ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
          cwd: header.cwd ?? opts.cwd,
          userText: message,
          signal: ctx.signal,
          maxSteps: Math.max(1, opts.maxTurns),
          snapshots: new SnapshotStore(dir),
        });
        opts.hooks?.onChildTurnEnd?.(childSessionId, result);
        const out: SubagentStartOutput = {
          childSessionId,
          stopReason: result.stopReason,
          ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
        return { output: JSON.stringify(out) };
      } catch (e) {
        return { error: `子会话续跑失败: ${(e as Error)?.message ?? String(e)}` };
      } finally {
        writer.close();
      }
    },
  };

  return [startTool, continueTool];
}

/** 相对 cwd 解析（不要求存在）；绝对路径原样归一返回 */
function resolveSubPath(baseCwd: string, sub: string): string {
  return isAbsolute(sub) ? resolve(sub) : resolve(baseCwd, sub);
}
