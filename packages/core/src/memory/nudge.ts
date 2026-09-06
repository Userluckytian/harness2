// nudge 后台复盘（阶段 6，对照 hermes agent/background_review.py 实证方案）：
// 每 N 个用户 turn（模型期间调过 memory 工具即重置计数，由调用方 SessionHub 维护）触发一次
// 复盘 turn：roles.small 模型、独立系统提示（快照进一次性临时会话）、只挂 memory 工具、
// 不落主会话日志——复盘产出 = 记忆写入（auto）或 pending 暂存（ask）。
// 写入 gate：mode=auto → store 直接写；mode=ask → PendingMemoryStore 暂存待审批。
// 复盘在 turn-end 回调后异步执行，不阻塞主对话；异常静默收口（onFinished.error），主对话无感。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../agent/loop.js';
import type { TurnResult } from '../agent/types.js';
import type { ChatProvider } from '../provider/types.js';
import { computeProjection, loadSession } from '../session/reader.js';
import { SessionWriter } from '../session/writer.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/types.js';
import { assembleMemorySnapshot, type MemoryStore } from './store.js';
import { createMemoryTool } from './tool.js';
import { PendingMemoryStore } from './pending.js';

/** 复盘 turn 的独立系统提示（经 memory/snapshot 事件冻结进临时会话，与主对话提示互不影响） */
export const NUDGE_REVIEW_SYSTEM =
  '你是记忆管理助手。回顾给定的对话记录，判断是否有值得长期记住的用户偏好、事实或项目约定：' +
  '有则调用 memory 工具记录（target=user 记用户画像，target=memory 记项目笔记；接近预算上限时用 operations 批量"删旧加新"整合）；' +
  '没有值得记录的内容就直接回复"无需记忆"。绝不记录密钥、令牌或一次性任务细节。';

/** 复盘对话摘要的长度约束（确定性截断，防止超长对话撑爆复盘上下文） */
export const DIGEST_MAX_MESSAGES = 40;
export const DIGEST_MESSAGE_MAX_CHARS = 400;
export const DIGEST_TOTAL_MAX_CHARS = 12000;

export type NudgeMode = 'ask' | 'auto';

export interface NudgeResult {
  sessionId: string;
  stopReason: TurnResult['stopReason'];
  toolCalls: number;
  /** ask 模式下本次复盘新增暂存的待审批条数（不含此前遗留的未审批项） */
  staged: number;
  error?: string;
}

export interface NudgeOptions {
  /** 复盘用的 provider（装配层传 roles.small） */
  provider: ChatProvider;
  /** 主记忆 store（auto 直接写；ask 的 approve 重放目标） */
  store: MemoryStore;
  mode: NudgeMode;
  /** 触发复盘的来源会话（取对话内容 + pending 归因） */
  sessionId: string;
  sessionDir: string;
  cwd: string;
  /** ask 模式的暂存区；缺省用默认根 */
  pending?: PendingMemoryStore;
  signal?: AbortSignal;
  onStarted?(sessionId: string): void;
  onFinished?(result: NudgeResult): void;
}

/**
 * 从主会话活动投影构建复盘对话摘要（确定性截断：最后 40 条、单条 ≤400 字符、总量 ≤12000）。
 * 只取 user/assistant 消息——工具调用细节不进复盘（模型看得到 memory 写入结果即可）。
 */
export function buildConversationDigest(sessionDir: string): string {
  const session = loadSession(sessionDir);
  const { messages } = computeProjection(session);
  const recent = messages.slice(-DIGEST_MAX_MESSAGES);
  const lines: string[] = [];
  let total = 0;
  for (const m of recent) {
    const text = m.text.replace(/\s+/g, ' ').trim();
    const clipped = text.length <= DIGEST_MESSAGE_MAX_CHARS ? text : `${text.slice(0, DIGEST_MESSAGE_MAX_CHARS)}…`;
    const line = `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clipped}`;
    total += line.length;
    if (total > DIGEST_TOTAL_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.length > 0 ? lines.join('\n') : '（对话为空）';
}

/**
 * 运行一次后台复盘 turn：
 *   1. 一次性临时会话（os.tmpdir）预置 memory/snapshot = 复盘系统提示（跑完即删，主日志零污染）；
 *   2. 工具注册表只挂 memory 工具——auto = 直写 store；ask = 暂存 pending；
 *   3. userText = 主会话对话摘要；
 *   4. 结束清理临时目录；store/审批异常不外抛（结果经 NudgeResult.error 返回）。
 */
export async function runNudgeReview(options: NudgeOptions): Promise<NudgeResult> {
  options.onStarted?.(options.sessionId);
  const reviewDir = mkdtempSync(join(tmpdir(), 'h2-nudge-'));
  try {
    // 预置复盘系统提示：走 memory/snapshot 冻结缝（runTurn 检测到快照即复用，不读 store）
    const snapshot = assembleMemorySnapshot(NUDGE_REVIEW_SYSTEM, '');
    if (snapshot === null) throw new Error('nudge: 复盘系统提示组装失败');
    const writer = SessionWriter.create(reviewDir, { sessionId: `nudge-${options.sessionId}` }, { fsync: false });
    writer.append('memory/snapshot', { content: snapshot });
    writer.close();

    const registry = new ToolRegistry();
    const pending =
      options.mode === 'ask'
        ? (options.pending ?? new PendingMemoryStore(join(options.store.root, 'pending'), options.store))
        : undefined;
    registry.register(createMemoryToolForMode(options.store, options.mode, pending, options.sessionId));

    // 审查 P2-2：staged 只统计本次复盘新增的暂存（diff），不含此前遗留的未审批项
    const beforeIds = new Set(pending !== undefined ? (await pending.list()).map((p) => p.id) : []);

    const digest = buildConversationDigest(options.sessionDir);
    const result = await runTurn(reviewDir, {
      provider: options.provider,
      tools: registry,
      cwd: options.cwd,
      userText: `以下是需要回顾的最近对话：\n\n${digest}`,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      maxSteps: 10, // 复盘最多 10 次模型调用，防止失控
      // 审查 P1-2：注入记忆 store——临时会话预置的 NUDGE_REVIEW_SYSTEM 快照才会被
      // runTurn 复用为 system（缺此前复盘裸跑，预置提示永不生效）
      memory: options.store,
    });
    let staged = 0;
    if (pending !== undefined) {
      staged = (await pending.list()).filter((p) => !beforeIds.has(p.id)).length;
    }
    const nudgeResult: NudgeResult = {
      sessionId: options.sessionId,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      staged,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    options.onFinished?.(nudgeResult);
    return nudgeResult;
  } catch (e) {
    // 复盘异常静默收口：主对话无感，但结果如实带 error 回调
    const nudgeResult: NudgeResult = {
      sessionId: options.sessionId,
      stopReason: 'error',
      toolCalls: 0,
      staged: 0,
      error: (e as Error)?.message ?? String(e),
    };
    options.onFinished?.(nudgeResult);
    return nudgeResult;
  } finally {
    rmSync(reviewDir, { recursive: true, force: true });
  }
}

/** 按模式构造 memory 工具：auto = 直写；ask = 暂存（工具名保持 memory，模型无感差异） */
export function createMemoryToolForMode(
  store: MemoryStore,
  mode: NudgeMode,
  pending: PendingMemoryStore | undefined,
  sessionId: string,
): ToolDefinition {
  if (mode === 'ask') {
    if (pending === undefined) throw new Error('nudge: ask 模式需要 pending store');
    return createMemoryTool({
      apply: async (ops) => {
        const stagedItem = await pending.stage(sessionId, ops);
        return {
          ok: true,
          warnings: [],
          files: [],
          stagedId: stagedItem.id,
        };
      },
    });
  }
  return createMemoryTool(store);
}
