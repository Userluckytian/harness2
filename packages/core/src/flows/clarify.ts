// H-67 澄清 flow（阶段 7）：向用户提问并等答；数字选项 + Other 自由文本（对应 grok G-21）。
//
// 与 hermes 对齐的语义：
//   - 提供 choices 时：用户可回数字（1 起始，逗号/空格分隔，多选用）、精确标签（忽略大小写与
//     "(Recommended)" 后缀）或 Other（转自由文本）。**选项题下的自由散文 → 明确拒绝**
//     （rejected_prose，提示重选），避免误把闲聊当答案。
//   - 开放式（无 choices）：任何非空文本即答案。
//   - 超时：`<=0` 不自动跳过（unlimited），`0` 立即返回，`>0` 有界等待。
import type { ClarifyFlowQuestion } from './types.js';

/** 澄清默认等待上限（毫秒；hermes 历史默认 300s） */
export const CLARIFY_DEFAULT_TIMEOUT_MS = 300_000;

export const CLARIFY_OTHER_TOKENS: readonly string[] = ['other', 'other...', '其他', '其它', '以上都不是', '都不是'];

/** 去掉选项里的 "(Recommended)"/"（推荐）" 后缀（解析匹配用） */
export function stripRecommended(label: string): string {
  return label.replace(/\s*[（(]\s*(recommended|推荐)\s*[)）]\s*$/i, '').trim();
}

export function isOtherToken(text: string): boolean {
  const t = text.trim().toLowerCase();
  return CLARIFY_OTHER_TOKENS.some((token) => token === t);
}

export type ClarifyReplyOutcome =
  | {
      status: 'resolved';
      /** 归一后的答案标签（数字已换成标签文本；开放式 = 用户原文） */
      answers: string[];
      /** 经 Other 自由文本得到（若有） */
      other?: string;
    }
  /** 用户选了 Other：壳应转入自由文本收集（下一次输入按开放式解析） */
  | { status: 'other' }
  /** 空输入 */
  | { status: 'empty'; reason: string }
  /** 选项题收到自由散文：拒绝，提示用数字或 Other */
  | { status: 'rejected_prose'; reason: string }
  /** 数字越界 / 多选语义不符 */
  | { status: 'rejected_selection'; reason: string };

const NUMERIC_LIST = /^\s*\d+\s*(?:[,，、;；/\s]\s*\d+\s*)*$/;
const SELECT_ALL = /^(all|全部|全选|\*)$/i;

function matchChoice(text: string, choices: readonly string[]): string | null {
  const wanted = stripRecommended(text).toLowerCase();
  for (const choice of choices) {
    if (stripRecommended(String(choice)).toLowerCase() === wanted) return String(choice);
  }
  return null;
}

/**
 * 解析单题应答（纯函数）。
 * 调用方在 options=null（开放式）时直接把文本当答案；在选项题里按数字/标签/Other 解析。
 */
export function parseClarifyReply(text: string, question: ClarifyFlowQuestion): ClarifyReplyOutcome {
  const raw = text.trim();
  const choices = question.choices;
  if (choices === undefined || choices.length === 0) {
    if (raw.length === 0) return { status: 'empty', reason: '输入为空' };
    return { status: 'resolved', answers: [raw] };
  }
  if (raw.length === 0) return { status: 'empty', reason: '输入为空' };
  if (isOtherToken(raw)) return { status: 'other' };
  if (SELECT_ALL.test(raw)) {
    if (question.multiSelect !== true) {
      return { status: 'rejected_selection', reason: '该题为单选，不能全选' };
    }
    return { status: 'resolved', answers: choices.map(String) };
  }
  if (NUMERIC_LIST.test(raw)) {
    const indices = raw
      .split(/[,，、;；/\s]+/)
      .filter((s) => s.length > 0)
      .map((s) => Number(s));
    for (const idx of indices) {
      if (!Number.isInteger(idx) || idx < 1 || idx > choices.length) {
        return {
          status: 'rejected_selection',
          reason: `选项 ${idx} 越界（有效范围 1-${choices.length}）`,
        };
      }
    }
    if (question.multiSelect !== true && indices.length > 1) {
      return { status: 'rejected_selection', reason: '该题为单选，只能选一个' };
    }
    const picked = [...new Set(indices)].map((i) => String(choices[i - 1]!));
    return { status: 'resolved', answers: picked };
  }
  const label = matchChoice(raw, choices);
  if (label !== null) return { status: 'resolved', answers: [label] };
  return {
    status: 'rejected_prose',
    reason: `请输入选项编号（1-${choices.length}）或选择 Other 自行填写`,
  };
}

/** 开放式题目（Other 转自由文本后）解析 */
export function parseOpenClarifyReply(text: string): ClarifyReplyOutcome {
  const raw = text.trim();
  if (raw.length === 0) return { status: 'empty', reason: '输入为空' };
  return { status: 'resolved', answers: [raw], other: raw };
}

export type ClarifyWaitMode = 'unlimited' | 'immediate' | 'bounded';

export interface ClarifyWait {
  mode: ClarifyWaitMode;
  /** mode=bounded 时的毫秒数 */
  ms?: number;
}

/** 超时语义归一：`<=0` unlimited / `0` immediate / `>0` bounded；缺省取 300s 有界 */
export function computeClarifyWait(timeoutMs: number | undefined): ClarifyWait {
  if (timeoutMs === undefined) return { mode: 'bounded', ms: CLARIFY_DEFAULT_TIMEOUT_MS };
  if (timeoutMs < 0) return { mode: 'unlimited' };
  if (timeoutMs === 0) return { mode: 'immediate' };
  return { mode: 'bounded', ms: timeoutMs };
}

/** 澄清等待的 deadline（ISO8601）；unlimited → undefined 由调用方决定 */
export function clarifyDeadline(timeoutMs: number | undefined, now: Date = new Date()): string | undefined {
  const wait = computeClarifyWait(timeoutMs);
  if (wait.mode !== 'bounded' || wait.ms === undefined) return undefined;
  return new Date(now.getTime() + wait.ms).toISOString();
}

/** 供审计的答案摘要（只记题数与选中项数，不落答案原文——答案可能含个人信息） */
export function summarizeClarifyAnswers(answers: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [qid, values] of Object.entries(answers)) out[qid] = values.length;
  return out;
}
