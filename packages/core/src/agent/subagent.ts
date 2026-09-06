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
// v1 口径：子会话不注入记忆/压缩（短生命周期子任务，与 cron 执行同口径）；非沙箱——
// 子会话与父同进程运行，隔离边界与插件小节一致（architecture.md 如实声明）。
import { resolve, isAbsolute } from 'node:path';
import { loadSession } from '../session/reader.js';
import { SessionManager } from '../session/manager.js';
import { SessionWriter } from '../session/writer.js';
import { runTurn } from './loop.js';
import type { TurnResult, TurnStopReason } from './types.js';
import type { AnySessionEvent, SessionEvent, SessionEventType, SessionEventMap } from '../session/types.js';
import type { SessionAppender } from '../session/writer.js';
import type { ChatProvider } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolContext, ApprovalHandler } from '../tools/types.js';

/** subagent 工具名（装配层据此从子会话工具集剔除，实现深度限制） */
export const SUBAGENT_TOOL_NAMES = ['subagent_start', 'subagent_continue'] as const;

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
  approvalFactory?: (childSessionId: string, signal: AbortSignal) => ApprovalHandler;
  /** 工具执行 cwd + 子会话缺省分组目录 */
  cwd: string;
  maxDepth: number;
  maxTurns: number;
  /** 父会话 id（写入子 header.parentSession；continue 只认自己的子会话） */
  parentSessionId: string;
  /** 当前会话深度（0 = 用户主会话）：depth < maxDepth 才允许注册本工具 */
  depth: number;
  hooks?: SubagentHooks;
  /** 会话日志 fsync（测试可关） */
  fsync?: boolean;
}

/** 子会话 turn 的审批缝：工厂优先（按子会话 id 上抛），否则固定 handler，缺省 allow-all */
function approvalFor(opts: SubagentOptions, childSessionId: string, signal: AbortSignal): ApprovalHandler | undefined {
  if (opts.approvalFactory !== undefined) return opts.approvalFactory(childSessionId, signal);
  return opts.approval;
}

/**
 * 构建子会话工具集：宿主工具 − subagent 工具，再按 子深度 < maxDepth 重挂 subagent 工具
 * （重挂时血缘重绑：parentSessionId = 子会话 id、depth = options.depth + 1，供更深递归）。
 * options 描述"派发方"会话（parentSessionId = 派发方 id，depth = 派发方深度）；
 * childSessionId = 本次派发的子会话 id。
 */
export function buildSubagentChildTools(options: SubagentOptions, childSessionId: string): ToolRegistry {
  const registry = new ToolRegistry();
  const subNames = new Set<string>(SUBAGENT_TOOL_NAMES);
  for (const def of options.baseTools.list()) {
    if (subNames.has(def.name)) continue;
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
      try {
        // 取消传播：子 runTurn 消费父 turn 的 signal——父 abort → 子 abort（事件照常落盘）
        const result = await runTurn(observed, {
          provider: opts.provider,
          tools: buildSubagentChildTools(opts, childId),
          ...(approvalFor(opts, childId, ctx.signal) !== undefined
            ? { approval: approvalFor(opts, childId, ctx.signal) }
            : {}),
          cwd: childCwd,
          userText: prompt,
          signal: ctx.signal,
          maxSteps: Math.max(1, opts.maxTurns),
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
    description: '向此前派发的子会话追加一条消息并继续其任务（返回新结果）。',
    parameters: {
      type: 'object',
      properties: {
        childSessionId: { type: 'string', description: 'subagent_start 返回的子会话 id' },
        message: { type: 'string', description: '追加给子会话的消息' },
      },
      required: ['childSessionId', 'message'],
    },
    async execute(args: unknown, ctx: ToolContext) {
      const { childSessionId, message } = (args ?? {}) as { childSessionId?: unknown; message?: unknown };
      if (typeof childSessionId !== 'string' || childSessionId.trim() === '') {
        return { error: 'childSessionId 必须是非空字符串' };
      }
      if (typeof message !== 'string' || message.trim() === '') {
        return { error: 'message 必须是非空字符串' };
      }
      let dir: string;
      try {
        dir = opts.manager.locate(childSessionId);
      } catch {
        return { error: `子会话不存在: ${childSessionId}` };
      }
      // 血缘校验：只能续本会话派生的子会话（防误续/跨会话注入）
      const header = loadSession(dir).header;
      if (header?.parentSession !== opts.parentSessionId) {
        return { error: `会话 ${childSessionId} 不是本会话的子会话，拒绝续跑` };
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
        const result = await runTurn(observed, {
          provider: opts.provider,
          tools: buildSubagentChildTools(opts, childSessionId),
          ...(approvalFor(opts, childSessionId, ctx.signal) !== undefined
            ? { approval: approvalFor(opts, childSessionId, ctx.signal) }
            : {}),
          cwd: header.cwd ?? opts.cwd,
          userText: message,
          signal: ctx.signal,
          maxSteps: Math.max(1, opts.maxTurns),
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
