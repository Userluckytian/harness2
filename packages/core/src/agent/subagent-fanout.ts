// H-42 并行扇出（P7-C）：一次派多个子代理**并行**执行，并把最近 10 次 fan-out 缓存下来
// 供 `/replay` 查看。
//
// 与 subagent_start 的关系：
//   - 复用同一套隔离与血缘机制（独立子会话、独立上下文、独立轨迹/快照、父子审批上抛、
//     取消传播），差别只在一个工具调用里同时创建并运行 N 个子会话；
//   - 子会话工具集 = buildSubagentChildTools（剔 subagent_*/fanout/per-session 绑定类），
//     因此扇出的子代理不会再次扇出（防指数放大）；
//   - 血缘：每个子会话 header.parentSession = 派发方 id、subagent=true、depth = 派发方 + 1。
//
// 并行隔离（用例断言的口径）：
//   - 每个子会话有自己的 SessionWriter / SnapshotStore / 工具注册表；互不共享可变状态；
//   - 父会话日志只有 subagent_fanout 的 tool/call + tool/result 两行，子代理的中间消息
//     一条都不会进父日志（也就不会进父的模型上下文）；
//   - 失败隔离：单个子会话失败（provider 报错/超时）不影响其它子会话，结果按 index 汇总。
//
// 历史缓存：SpawnHistoryStore 定长 10（缺省），FIFO 淘汰；记录是可序列化的纯数据，
// `/replay` 用 formatSpawnReplay 渲染，测试断言顺序与可重放性。
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { SnapshotStore } from '../session/snapshots.js';
import type { SessionAppender } from '../session/writer.js';
import type { ChatProvider } from '../provider/types.js';
import type { AnySessionEvent, SessionEvent, SessionEventType, SessionEventMap } from '../session/types.js';
import { buildSubagentChildTools, type SubagentOptions } from './subagent.js';
import { runTurn } from './loop.js';
import type { ToolDefinition, ToolContext } from '../tools/types.js';
import type { TurnResult, TurnStopReason } from './types.js';

/** 扇出工具名（与 subagent.ts 的 FANOUT_TOOL_NAMES 同源，此处再导出便于装配层使用） */
export const FANOUT_TOOL_NAME = 'subagent_fanout';

/** 历史缓存条数上限（H-42：最近 10 次 fan-out） */
export const SPAWN_HISTORY_LIMIT = 10;

/** 单次扇出的子代理数上限（护栏：防一次调用打爆并发/配额） */
export const FANOUT_MAX_CHILDREN = 8;

/** 单个子代理在扇出记录里的结果条目 */
export interface SpawnChildRecord {
  index: number;
  prompt: string;
  childSessionId: string;
  ok: boolean;
  stopReason: TurnStopReason;
  finalText?: string;
  error?: string;
  durationMs: number;
}

/** 一次 fan-out 的完整记录（纯数据，可 JSON 序列化 → 可持久化/可重放） */
export interface SpawnRecord {
  /** 扇出 id（每次调用唯一；也是输出里的 fanoutId） */
  id: string;
  parentSessionId: string;
  /** ISO 时间戳 */
  startedAt: string;
  finishedAt: string;
  children: SpawnChildRecord[];
}

/**
 * 最近 N 次 fan-out 的环形缓存（缺省 10）。FIFO：超限丢最旧的一条。
 * 顺序语义：`list()` = 插入顺序（旧 → 新），`latest(n)` = 新 → 旧（`/replay` 展示用）。
 */
export class SpawnHistoryStore {
  private records: SpawnRecord[] = [];

  constructor(private readonly limit: number = SPAWN_HISTORY_LIMIT) {}

  /** 记录一次 fan-out（超限丢弃最旧） */
  record(record: SpawnRecord): void {
    this.records.push(record);
    while (this.records.length > this.limit) this.records.shift();
  }

  /** 插入顺序（旧 → 新）；返回副本，外部改动不影响缓存 */
  list(): readonly SpawnRecord[] {
    return [...this.records];
  }

  /** 最近 n 条（新 → 旧；n 缺省 = 全部） */
  latest(n?: number): readonly SpawnRecord[] {
    const reversed = [...this.records].reverse();
    return n === undefined ? reversed : reversed.slice(0, Math.max(0, n));
  }

  /** 按 id 取（重放单次 fan-out） */
  get(id: string): SpawnRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  get size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records = [];
  }
}

/** `/replay` 的人类可读渲染（只读；不含子会话正文，正文在各自轨迹里） */
export function formatSpawnReplay(record: SpawnRecord): string {
  const lines = [
    `fan-out ${record.id}（父会话 ${record.parentSessionId}）`,
    `  时间: ${record.startedAt} → ${record.finishedAt}`,
    `  子代理 ${record.children.length} 个:`,
  ];
  for (const c of record.children) {
    lines.push(
      `    [${c.index}] ${c.ok ? 'ok' : 'fail'} ${c.stopReason} ${c.durationMs}ms ` +
        `child=${c.childSessionId} prompt=${c.prompt.length > 40 ? `${c.prompt.slice(0, 40)}…` : c.prompt}`,
    );
  }
  return lines.join('\n');
}

/** 扇出装配选项 = 子代理装配选项 + 历史缓存 + 每子 provider + 并发上限 */
export interface FanoutOptions extends SubagentOptions {
  /** 历史缓存（装配层注入同一实例供 `/replay` 读；缺省 = 不记录） */
  history?: SpawnHistoryStore;
  /**
   * 每个子会话的 provider（按 index）。
   * 缺省回退 options.provider —— 注意：**同一个 provider 实例被多个子会话并发消费**时，
   * 脚本式 provider（MockProvider）的游标会交错；真实 provider 无此问题，测试请注入每子独立实例。
   */
  providerFor?: (index: number) => ChatProvider;
  /** 子代理数上限（缺省 FANOUT_MAX_CHILDREN） */
  maxChildren?: number;
}

/** 解析相对 cwd（与 subagent.ts 的 resolveSubPath 同口径） */
function resolveSubPath(baseCwd: string, sub: string): string {
  return isAbsolute(sub) ? resolve(sub) : resolve(baseCwd, sub);
}

/** 把子会话 writer 包成观察者（先落盘、后回调；与 subagent_start 同口径） */
function observeChild(options: SubagentOptions, childId: string, writer: SessionAppender): SessionAppender {
  const onChildEvent = options.hooks?.onChildEvent;
  if (onChildEvent === undefined) return writer;
  return {
    dir: writer.dir,
    get lastSeq(): number {
      return writer.lastSeq;
    },
    append<T extends SessionEventType>(type: T, payload: SessionEventMap[T]): SessionEvent<T> {
      const event = writer.append(type, payload);
      onChildEvent(childId, event as AnySessionEvent);
      return event;
    },
  };
}

/** 子会话审批缝（工厂优先；与 subagent.ts 同口径） */
function approvalFor(options: SubagentOptions, childId: string, signal: AbortSignal) {
  if (options.approvalFactory !== undefined) return options.approvalFactory(childId, options.parentSessionId, signal);
  return options.approval;
}

/**
 * 构造 subagent_fanout 工具。
 * 装配层注册条件与 subagent_start 相同（options.depth < options.maxDepth 时才有意义，
 * 但本工具在子会话工具集中被无条件剔除——见 subagent.ts buildSubagentChildTools）。
 */
export function createFanoutTools(options: FanoutOptions): ToolDefinition[] {
  const maxChildren = options.maxChildren ?? FANOUT_MAX_CHILDREN;
  const tool: ToolDefinition = {
    name: FANOUT_TOOL_NAME,
    description:
      'Fan out up to N independent child sessions **in parallel** and collect their results. Each child runs ' +
      'with its own isolated context and trajectory (same isolation as subagent_start). Use it when several ' +
      'independent subtasks can run at once (e.g. research 3 topics, review 3 files). Returns one JSON object ' +
      'with per-child { childSessionId, ok, stopReason, finalText, error, durationMs }; failures of one child ' +
      'do not affect the others.',
    parameters: {
      type: 'object',
      properties: {
        prompts: {
          type: 'array',
          items: { type: 'string' },
          description: `并行子任务指令数组（1..${maxChildren} 条；每条须自包含上下文）`,
        },
        cwd: { type: 'string', description: '可选：子会话统一工作目录（相对路径相对当前 cwd）' },
      },
      required: ['prompts'],
    },
    // 扇出会创建多个写型子会话 + 并发，按 unsafe 处理（独占执行，避免与其它写操作交错）
    concurrencySafe: false,
    async execute(args: unknown, ctx: ToolContext) {
      const { prompts, cwd } = (args ?? {}) as { prompts?: unknown; cwd?: unknown };
      if (!Array.isArray(prompts) || prompts.length === 0) {
        return { error: 'prompts 必须是非空字符串数组' };
      }
      if (!prompts.every((p): p is string => typeof p === 'string' && p.trim() !== '')) {
        return { error: 'prompts 的每一项都必须是非空字符串' };
      }
      if (prompts.length > maxChildren) {
        return { error: `一次扇出最多 ${maxChildren} 个子代理（收到 ${prompts.length}）` };
      }
      if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
        return { error: 'cwd 必须是非空字符串' };
      }
      const childCwd = typeof cwd === 'string' ? resolveSubPath(ctx.cwd, cwd) : options.cwd;
      const fanoutId = randomUUID();
      const startedAt = new Date().toISOString();

      // 先同步创建全部子会话（拿到 id 才能在并行体里各自运行；create 不做 IO 等待之外的并发）
      const children: Array<{
        index: number;
        prompt: string;
        id: string;
        writer: SessionAppender;
        dir: string;
        close: () => void;
      }> = [];
      try {
        for (const [index, prompt] of prompts.entries()) {
          const created = options.manager.create(childCwd, {
            parentSession: options.parentSessionId,
            isSeeded: true,
            subagent: true,
            ...(options.fsync !== undefined ? { fsync: options.fsync } : {}),
          });
          children.push({
            index,
            prompt,
            id: created.id,
            writer: observeChild(options, created.id, created.writer),
            dir: created.dir,
            close: () => created.writer.close(),
          });
        }
      } catch (e) {
        // P2-2 清理：创建中途失败时把**已建**子会话的 writer 关掉——否则句柄与目录锁泄漏，
        // 且磁盘上留下没人跑过的空子会话（父会话则会以为它们存在）。关闭失败不掩盖原始错误。
        for (const child of children) {
          try {
            child.close();
          } catch {
            // 关闭失败：原始错误优先，如实返回创建失败
          }
        }
        return { error: `子会话创建失败（第 ${children.length} 个）: ${(e as Error)?.message ?? String(e)}` };
      }

      // 并行执行：每个子会话独立 provider / 工具集 / 快照；单子失败不影响其它子
      const results = await Promise.all(
        children.map(async (child): Promise<SpawnChildRecord> => {
          const startedChildAt = performance.now();
          const provider = options.providerFor?.(child.index) ?? options.provider;
          const approval = approvalFor(options, child.id, ctx.signal);
          try {
            const result: TurnResult = await runTurn(child.writer, {
              provider,
              tools: buildSubagentChildTools(options, child.id),
              ...(approval !== undefined ? { approval } : {}),
              ...(options.skills !== undefined ? { skills: options.skills } : {}),
              cwd: childCwd,
              userText: child.prompt,
              signal: ctx.signal,
              maxSteps: Math.max(1, options.maxTurns),
              snapshots: new SnapshotStore(child.dir),
            });
            options.hooks?.onChildTurnEnd?.(child.id, result);
            return {
              index: child.index,
              prompt: child.prompt,
              childSessionId: child.id,
              ok: result.stopReason === 'end_turn',
              stopReason: result.stopReason,
              ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
              durationMs: Math.round(performance.now() - startedChildAt),
            };
          } catch (e) {
            return {
              index: child.index,
              prompt: child.prompt,
              childSessionId: child.id,
              ok: false,
              stopReason: 'error',
              error: (e as Error)?.message ?? String(e),
              durationMs: Math.round(performance.now() - startedChildAt),
            };
          } finally {
            child.close();
          }
        }),
      );

      const record: SpawnRecord = {
        id: fanoutId,
        parentSessionId: options.parentSessionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        children: results.sort((a, b) => a.index - b.index),
      };
      options.history?.record(record);
      return { output: JSON.stringify(record) };
    },
  };
  return [tool];
}
