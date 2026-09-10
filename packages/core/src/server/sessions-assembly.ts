// SessionHub 装配与只读视图（A4 拆分自 sessions.ts，纯搬运）：会话生命周期、注册表恢复、
// S7 四契约只读投影、steer 入口。
import { type ChangeSet, reviewChangeSet } from '../interaction/change-review.js';
import {
  type ToolExecutionTrace,
  type ToolExecutionView,
  buildToolExecutionView,
} from '../interaction/execution-view.js';
import { type PlanState, loadPlanState } from '../interaction/plan-state.js';
import {
  type EffectiveRunConfig,
  type EffectiveRunConfigInput,
  buildEffectiveRunConfig,
} from '../interaction/run-config.js';
import { readEntries } from '../interaction/runtime-journal.js';
import { SessionSteerSink } from '../interaction/steer-sink.js';
import type { SteerRequest, SteerResult, TaskId } from '../interaction/types.js';
import { SessionManager } from '../session/manager.js';
import { computeProjection, loadSession } from '../session/reader.js';
import { SnapshotStore } from '../session/snapshots.js';
import type { AnySessionEvent } from '../session/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ApprovalHandler } from '../tools/types.js';
import {
  EventMirrorWriter,
  type ExecTraceRecord,
  type HubEntry,
  SessionHubCore,
  detectShell,
  headerCwdOr,
} from './sessions-core.js';
import { HubError, type SessionEventsPayload, type SessionHubProviderMeta } from './sessions-types.js';
import { resolve } from 'node:path';

export abstract class SessionHubAssembly extends SessionHubCore {
  /** S6 会话级 steer sink：按会话惰性创建，跨 turn 持久（去重/排队/回帧观察都在 sink） */
  protected steerSinkFor(id: string): SessionSteerSink {
    const existing = this.steerSinks.get(id);
    if (existing !== undefined) return existing;
    const sink = new SessionSteerSink((result) => this.emitSteerResult(id, result));
    this.steerSinks.set(id, sink);
    return sink;
  }

  /** S6 会话级 steer 回帧历史（诊断/测试；与 hooks.onSteerResult 同源） */
  steerHistory(id: string): SteerResult[] {
    this.assertValidSessionId(id);
    return this.steerSinks.get(id)?.history() ?? [];
  }

  /** S6：外部提交一条 steer 进会话级 sink（跨 turn 去重/排队）；true = 新 id 已入队 */
  submitSteer(sessionId: string, req: SteerRequest): boolean {
    this.assertValidSessionId(sessionId);
    this.ensureOpen(sessionId);
    return this.steerSinkFor(sessionId).push(req);
  }

  /** 全量工具注册表（按会话绑定 memory/browser 变体）——cron 调度执行复用同一装配 */
  toolsForSession(sessionId: string): ToolRegistry {
    return this.buildTurnTools(sessionId);
  }

  // —— 会话生命周期 ——

  /** 新建会话并保持 writer 打开（服务持有，close 时统一释放） */
  create(cwd: string): { id: string; dir: string } {
    this.assertNonEmpty(cwd, 'cwd');
    const created = this.options.manager.create(cwd);
    // entry.cwd = header 真值（manager.create 落盘 resolve(cwd)）——工具执行与快照解析都用它
    const entry: HubEntry = {
      id: created.id,
      dir: created.dir,
      cwd: resolve(cwd),
      writer: new EventMirrorWriter(created.writer, (event) => {
        this.noteTurnEvent(created.id, event);
        this.emitEvent(created.id, event);
      }),
    };
    this.entries.set(created.id, entry);
    return { id: created.id, dir: created.dir };
  }

  /** 会话摘要列表（manager.list 同源；cwd 缺省 = 全库） */
  list(cwd?: string): ReturnType<SessionManager['list']> {
    return this.options.manager.list(cwd);
  }

  /** 只读定位会话目录（不取锁；与持锁写者并存） */
  locate(id: string, cwd?: string): string {
    this.assertValidSessionId(id);
    try {
      return this.options.manager.locate(id, cwd !== undefined ? { cwd } : {});
    } catch {
      throw new HubError('not_found', `session not found: ${id}`);
    }
  }

  /** 恢复会话到注册表（幂等：已在册直接返回）；锁被占（如 CLI chat 同时打开）→ HubError('locked') */
  ensureOpen(id: string): { id: string; dir: string } {
    this.assertValidSessionId(id);
    const entry = this.entryFor(id);
    return { id: entry.id, dir: entry.dir };
  }

  /** 注册表条目（内部）：不存在则从磁盘恢复；锁冲突 → HubError('locked')，未知 id → HubError('not_found') */
  protected entryFor(id: string): HubEntry {
    const existing = this.entries.get(id);
    if (existing) return existing;
    let resumed: ReturnType<SessionManager['resume']>;
    try {
      resumed = this.options.manager.resume(id);
    } catch (e) {
      if ((e as Error).name === 'SessionLockedError') {
        throw new HubError('locked', `会话被其他进程占用（${(e as Error).message}）`);
      }
      throw new HubError('not_found', (e as Error).message);
    }
    const entry: HubEntry = {
      id,
      dir: resumed.dir,
      // S1：每会话真实 cwd 从 header 读（旧日志缺 header.cwd 时回退 hub 全局 cwd）
      cwd: headerCwdOr(resumed.header?.cwd, this.options.cwd),
      writer: new EventMirrorWriter(resumed.writer, (event) => {
        this.noteTurnEvent(id, event);
        this.emitEvent(id, event);
      }),
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** S1：会话执行 cwd（entries 内存值；未注册回退 hub 全局 cwd） */
  protected sessionCwd(id: string): string {
    return this.entries.get(id)?.cwd ?? this.options.cwd;
  }

  /** 全量事件（含 active 标记）：切换会话时的重放来源；只读、不取锁 */
  events(id: string): SessionEventsPayload {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    const session = loadSession(dir);
    computeProjection(session); // 就地标记每个事件的活动性（影子事件 false）
    return {
      id,
      dir,
      header: session.header,
      events: session.events.map(({ event, active }) => ({ ...event, active })),
      warnings: session.warnings,
      lastSeq: session.events.at(-1)?.event.seq ?? 0,
    };
  }

  // —— S7 四契约只读查询（桌面接线；全部只读投影，不触发执行/写/审批） ——

  /** run-config：有效运行配置只读视图（脱敏 + 深度冻结）。装配来源 = hub 真实状态
   *  （provider 元数据/审批策略/工具集/每会话 cwd/容量），不建第二套配置存储。 */
  runConfigView(id: string): EffectiveRunConfig {
    this.assertValidSessionId(id);
    this.locate(id); // 404 校验会话存在（只读定位，不取锁）；未注册会话回退全局 cwd
    const root = this.options.cwd;
    const cwd = this.sessionCwd(id);
    const now = new Date().toISOString();
    const input: EffectiveRunConfigInput = {
      session: { sessionId: id, root, cwd, cwdFromHeader: cwd !== root },
      provider: this.options.providerMeta ?? this.fallbackProviderMeta(),
      ...(this.options.approvalConfig !== undefined ? { approval: this.options.approvalConfig } : {}),
      memoryMode: this.options.memory?.mode ?? 'off',
      tools: this.toolsForSession(id)
        .list()
        .map((d) => d.name),
      ...(this.options.skills !== undefined
        ? { skills: this.options.skills.scan().skills.map((s) => ({ name: s.name, source: s.source })) }
        : {}),
      ...(this.options.contextWindow !== undefined ? { contextWindow: this.options.contextWindow } : {}),
      ...(this.options.maxOutputTokens !== undefined ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      snapshot: { revision: this.configRevisions.get(id) ?? 0, capturedAt: now, effectiveAt: now },
      ...(this.lastRetryBudgets.get(id) !== undefined ? { retryBudget: this.lastRetryBudgets.get(id) } : {}),
    };
    return buildEffectiveRunConfig(input);
  }

  /** plan-state：从磁盘账本/会话日志重建计划状态（只读；无 task/transition 账本 → null） */
  planStateView(id: string): PlanState | null {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    return loadPlanState(dir);
  }

  /** execution-view：命令执行只读视图（真实 shell/exitCode 归属）。来源 = 会话日志 tool/call
   *  （plannedArgs/turnId）+ hub 生命周期观察记录（startedAt/终态）+ env（cwd/shell）。
   *  纯投影：不执行、不写盘。 */
  executionViews(id: string): ToolExecutionView[] {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    const cwd = this.sessionCwd(id);
    const shell = detectShell();
    const session = loadSession(dir);
    computeProjection(session); // 只取当前投影内的活动 tool/call（影子事件不展示）
    const perCall = this.execTraces.get(id) ?? new Map<string, ExecTraceRecord>();
    // taskId 归属：journal call/started 账本（S3a 单写；只读扫描）
    const taskOfCall = new Map<string, string>();
    for (const e of readEntries(dir).entries) {
      if (e.kind === 'call/started' && e.taskId !== undefined) taskOfCall.set(e.callId, e.taskId);
    }
    const views: ToolExecutionView[] = [];
    for (const { event, active } of session.events) {
      if (!active || event.type !== 'tool/call') continue;
      const call = event.payload;
      const rec = perCall.get(call.callId);
      const trace: ToolExecutionTrace = {
        callId: call.callId,
        ...(taskOfCall.get(call.callId) !== undefined ? { taskId: taskOfCall.get(call.callId) } : {}),
        ...(call.turnId !== undefined ? { turnId: call.turnId } : {}),
        tool: call.tool,
        plannedArgs: call.args,
        cwd,
        ...(shell !== undefined ? { shell } : {}),
        ...(rec?.startedAt !== undefined ? { executedArgs: rec.executedArgs, startedAt: rec.startedAt } : {}),
        ...(rec?.endedAt !== undefined
          ? { endedAt: rec.endedAt, ok: rec.ok, output: rec.output, error: rec.error, durationMs: rec.durationMs }
          : {}),
      };
      views.push(buildToolExecutionView(trace));
    }
    return views;
  }

  /** change-review：变更审查只读报告（拟议 vs 真实 diff / 外部修改标 dirty；不触发恢复/写盘） */
  changeReviewView(id: string): ChangeSet {
    this.assertValidSessionId(id);
    const dir = this.locate(id);
    return reviewChangeSet(new SnapshotStore(dir));
  }

  /** 注入 provider 而无装配元数据时的诚实回退：从 ChatProvider.name 推导（channel/model）；protocol 缺省按 openai（桌面配置路径恒走真实元数据） */
  protected fallbackProviderMeta(): SessionHubProviderMeta {
    const name = this.options.provider.name;
    const [channel, model] = name.split('/');
    return {
      role: 'main',
      channel: channel ?? name,
      model: model ?? name,
      protocol: 'openai',
      name,
    };
  }

  // —— 后续模块实现的抽象缝（跨文件调用；实现见 sessions-turn / sessions-approval） ——
  protected abstract noteTurnEvent(sessionId: string, event: AnySessionEvent): void;
  protected abstract buildTurnTools(sessionId: string): ToolRegistry;
  protected abstract makeApprovalHandler(
    sessionId: string,
    signal: AbortSignal,
    taskMeta?: { taskId?: TaskId; parentTaskId?: TaskId },
  ): ApprovalHandler;
}
