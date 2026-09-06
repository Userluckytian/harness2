// 上下文压缩（阶段 7 Task 1）：长会话可用性。
// 触发：turn 开始时活动消息估算 token（字符/4）> contextWindow × 0.75 →
//   以摘要 provider（roles.small，缺省主 provider）对覆盖区做文本折叠摘要，
//   成功后 append 一条 compaction/applied 事件（摘要落盘可重建，Model-visible ⟺ logged
//   延伸到压缩）；失败 → 不落事件、本轮跳过（下轮重试），turn 不中断。
// 尾部保护：最近 COMPACTION_TAIL_KEEP 条 user/assistant 消息原文永不进摘要区
//   （coveredUpToSeq = 保留区之前那条消息的 seq，见 computeCoveredUpToSeq）。
// 消费：buildChatMessages（loop.ts）取最新一条 compaction/applied，把覆盖区替换为摘要消息。
// 本文件只放纯函数与摘要调用；触发编排（估算 → 摘要 → 落事件）在 loop.ts，
// 避免 compaction ↔ loop 循环依赖。
import type { ChatProvider, ChatMessage } from '../provider/types.js';
import type { HarnessConfig } from '../config/schema.js';
import { computeProjection, type LoadedSession } from '../session/reader.js';

/** 触发阈值：估算 token > contextWindow × COMPACTION_TRIGGER_RATIO */
export const COMPACTION_TRIGGER_RATIO = 0.75;

/** 尾部保护条数：最近 N 条 user/assistant 消息原文保留，不进摘要区 */
export const COMPACTION_TAIL_KEEP = 6;

/** contextWindow 缺省（roles.main 模型未声明容量元数据时） */
export const DEFAULT_CONTEXT_WINDOW = 128 * 1024;

/** 摘要最大字符数（摘要输出与 compaction/applied.summary 的上限） */
export const COMPACTION_MAX_SUMMARY_CHARS = 2000;

/** 摘要输入折叠限额：单条消息 ≤ 此字符 */
export const COMPACTION_DIGEST_MESSAGE_MAX_CHARS = 500;
/** 摘要输入折叠限额：总量 ≤ 此字符（超出停止折叠，先到先得） */
export const COMPACTION_DIGEST_TOTAL_MAX_CHARS = 24000;

/** 摘要消息的可见前缀（buildChatMessages 替换覆盖区时使用） */
export const COMPACTION_SUMMARY_PREFIX = '[对话摘要]';

/** 摘要调用的系统提示（一次性，无工具、无记忆注入） */
export const COMPACTION_SUMMARY_SYSTEM =
  '你是对话摘要助手。把给定的对话历史压缩成一份摘要，供后续对话作为唯一的前文背景使用。' +
  '必须保留：用户的请求与目标、已完成的操作及其结果、重要决定、未决问题与下一步。' +
  `输出纯文本摘要，不超过 ${COMPACTION_MAX_SUMMARY_CHARS} 字符，不要添加评论。`;

/**
 * 估算请求上下文规模（token 量级）：Σ(消息字符 + 工具调用参数 JSON)/4。
 * 输入是 buildChatMessages 的输出（已应用最新压缩替换）——压缩后估算回落，
 * 不会因旧消息仍在日志而反复触发。
 */
export function estimateContextTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls !== undefined) {
      for (const c of m.toolCalls) chars += c.arguments.length + c.name.length + c.id.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * 覆盖区上界：保留区（最近 COMPACTION_TAIL_KEEP 条活动 user/assistant 消息）之前
 * 那条消息的 seq——buildChatMessages 把 seq <= coveredUpToSeq 的活动消息替换为摘要。
 * 活动消息不足 COMPACTION_TAIL_KEEP + 1 条时返回 null（没有可安全折叠的区域，跳过压缩）。
 * 注意与计划的偏差裁定：计划写「coveredUpToSeq = 倒数第 6 条」，而尾部保护口径为
 * 「近 6 条消息原文」（行为与风险表两处）；取保护条数优先——上界取倒数第 7 条，
 * 保证替换后原文保留 6 条。
 */
export function computeCoveredUpToSeq(session: LoadedSession): number | null {
  computeProjection(session);
  const msgs = session.events.filter(
    ({ event, active }) =>
      active && (event.type === 'user/message' || event.type === 'assistant/message'),
  );
  if (msgs.length <= COMPACTION_TAIL_KEEP) return null;
  const boundary = msgs[msgs.length - COMPACTION_TAIL_KEEP - 1];
  return boundary?.event.seq ?? null;
}

/**
 * 覆盖区文本折叠（摘要模型输入）：seq <= coveredUpToSeq 的活动 user/assistant 消息，
 * `USER: ` / `ASSISTANT: ` 行；单条裁到 COMPACTION_DIGEST_MESSAGE_MAX_CHARS，
 * 总量超过 COMPACTION_DIGEST_TOTAL_MAX_CHARS 停止（先到先得）。
 */
export function buildCompactionDigest(session: LoadedSession, coveredUpToSeq: number): string {
  computeProjection(session);
  const lines: string[] = [];
  let total = 0;
  for (const { event, active } of session.events) {
    if (!active) continue;
    if (event.seq > coveredUpToSeq) break; // 日志有序：之后全是保留区
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const text = event.payload.text.replace(/\s+/g, ' ').trim();
    const clipped =
      text.length <= COMPACTION_DIGEST_MESSAGE_MAX_CHARS
        ? text
        : `${text.slice(0, COMPACTION_DIGEST_MESSAGE_MAX_CHARS)}…`;
    const line = `${event.type === 'user/message' ? 'USER' : 'ASSISTANT'}: ${clipped}`;
    total += line.length;
    if (total > COMPACTION_DIGEST_TOTAL_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 调摘要 provider 生成覆盖区摘要：流式收集 text-delta，超长截断。
 * 输出为空或 provider 抛错 → 抛出（调用方跳过本轮压缩，不落事件）。
 */
export async function requestCompactionSummary(
  summarizer: ChatProvider,
  digest: string,
  opts: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? COMPACTION_MAX_SUMMARY_CHARS;
  let text = '';
  for await (const chunk of summarizer.streamChat(
    { system: COMPACTION_SUMMARY_SYSTEM, messages: [{ role: 'user', content: digest }] },
    { ...(opts.signal !== undefined ? { signal: opts.signal } : {}) },
  )) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  const summary = text.trim();
  if (summary.length === 0) throw new Error('summarizer 返回空摘要');
  return summary.length <= maxChars ? summary : summary.slice(0, maxChars);
}

/**
 * 从配置推导压缩选项（CLI chat / serve 装配层用）：
 * contextWindow 取 roles.main 模型声明的容量（缺省 DEFAULT_CONTEXT_WINDOW，由消费方兜底）；
 * summarizer 取 roles.small 的 provider（roles.small 未配置/创建失败时调用方传 undefined，
 * 摘要回落主 provider）。
 */
export function resolveCompactionOptions(
  config: HarnessConfig,
  providerFor: (role: string) => ChatProvider | undefined,
): { contextWindow?: number; summarizer?: ChatProvider } {
  const mainRole = config.roles['main'];
  const channel = mainRole !== undefined ? config.providers[mainRole.channel] : undefined;
  const model = mainRole !== undefined && channel !== undefined ? channel.models?.[mainRole.model] : undefined;
  const small = providerFor('small');
  return {
    ...(model?.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(small !== undefined ? { summarizer: small } : {}),
  };
}
