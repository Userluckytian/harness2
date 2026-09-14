// H-14 会话自动标题（对标 hermes `hermes_state_titles.py` / grok `/rename --auto`）。
//
// 存取口径（append-only 红线）：标题是**会话级元数据**，不写进 session.v1.jsonl，
// 而是落在会话目录内的辅助文件 `title.json`（与 rewind_points.jsonl 同级、同为派生物）。
// 因此：写入标题零触碰事实源与「换行即提交」语义；标题可随时删除重建；
// 导出白名单（export.ts 冻结结构）不变——标题不随轨迹资产走（已在报告登记为已知边界）。
//
// 生成分两段（与 H-11 同一注入哲学，core 内不硬编模型调用）：
//   ① 启发式：首条活动 user 消息（无则首条 assistant 消息）→ 去噪 → 首句 → 截断；
//   ② 可选精炼：调用方注入 `TitleRefiner`（典型实现：roles.small 一次流式调用）。
//      未注入 / 注入方抛错 / 返回空 → **如实降级**为启发式结果并登记原因。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeProjection, loadSession, type LoadedSession } from './reader.js';

/** 标题辅助文件名（位于会话目录内；派生物，不入导出白名单） */
export const SESSION_TITLE_FILE = 'title.json';

/** 标题最大展示字符数（与 SessionSummary.firstUserText 的 60 字口径一致） */
export const TITLE_MAX_CHARS = 60;

/** 精炼输入使用的转录片段上限（字符） */
export const TITLE_TRANSCRIPT_MAX_CHARS = 2000;

/** 标题来源：启发式 / 人工（/rename）/ 注入精炼 */
export type TitleSource = 'auto' | 'manual' | 'refined';

export interface SessionTitle {
  v: 1;
  title: string;
  source: TitleSource;
  /** 标题取材的最后一条消息 seq（0 = 仅用会话 id 兜底） */
  basedOnSeq: number;
  updatedAt: string;
}

/** 注入式标题精炼函数（core 内不硬编模型调用；未注入即用启发式） */
export type TitleRefiner = (input: { candidate: string; sessionId: string; transcript: string }) => Promise<string>;

/** 成对包裹符号（去包裹用；不用正则以免与引号/反引号混合触雷） */
const WRAPPING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['‘', '’'],
  ['《', '》'],
];

/** 去掉层层成对包裹的引号/反引号/书名号 */
function stripWrapping(text: string): string {
  let out = text;
  for (;;) {
    const pair = WRAPPING_PAIRS.find(([open, close]) => out.length >= 2 && out.startsWith(open) && out.endsWith(close));
    if (pair === undefined) break;
    const inner = out.slice(1, -1).trim();
    if (inner.length === 0) break;
    out = inner;
  }
  return out;
}

/** 控制字符（含换行）压成空格：标题必须是单行可打印文本 */
function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

/** 单行化 + 去噪 + 截断（标题的唯一规范形；人工输入同样过这一关） */
export function sanitizeTitle(raw: string): string {
  let text = stripControlChars(raw).replace(/\s+/g, ' ').trim();
  text = stripWrapping(text);
  text = text.replace(/^[#>\-*+\s]+/, '').replace(/^\d+[.)]\s*/, ''); // markdown 前缀
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= TITLE_MAX_CHARS) return text;
  return `${text.slice(0, TITLE_MAX_CHARS)}…`;
}

/** 去掉消息里注入的 XML 式块（system-reminder 等）与代码围栏，保留人话 */
function stripNoise(text: string): string {
  let out = text.replace(/<([a-zA-Z][\w-]*)[^>]*>[\s\S]*?<\/\1>/g, ' ');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 取首句：CJK 句末标点（。！？）直接断句；ASCII 标点（.!?）要求后随空白或行尾
 * （避免把 `v1.2`、`3.14` 这类小数/版本号切断）。首句过短（<8 字）时改用整段
 * ——避免「好的」「是」这类无信息标题。
 */
function firstSentence(text: string): string {
  const cjk = /^(.*?[。！？])/.exec(text)?.[1];
  const ascii = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1];
  const candidates = [cjk, ascii]
    .filter((s): s is string => s !== undefined)
    .map((s) => s.trim())
    .sort((a, b) => a.length - b.length);
  const best = candidates[0];
  if (best !== undefined && best.length >= 8) return best;
  return text;
}

/**
 * 启发式标题：首条**活动** user 消息（无则首条 assistant 消息）→ 去噪 → 首句 → 截断。
 * 无任何消息时退回会话 id 形态。确定性、无模型调用。
 */
export function deriveAutoTitle(session: LoadedSession): { title: string; basedOnSeq: number } {
  computeProjection(session);
  const active = session.events.filter(({ active: isActive }) => isActive);
  let sourceText: string | undefined;
  let sourceSeq = 0;
  for (const item of active) {
    if (item.event.type !== 'user/message') continue;
    sourceText = item.event.payload.text;
    sourceSeq = item.event.seq;
    break;
  }
  if (sourceText === undefined) {
    for (const item of active) {
      if (item.event.type !== 'assistant/message') continue;
      sourceText = item.event.payload.text;
      sourceSeq = item.event.seq;
      break;
    }
  }
  if (sourceText === undefined) {
    const id = session.header?.sessionId ?? 'unknown';
    return { title: sanitizeTitle(`会话 ${id}`) || `会话 ${id}`, basedOnSeq: 0 };
  }
  const candidate = sanitizeTitle(firstSentence(stripNoise(sourceText)));
  if (candidate.length > 0) return { title: candidate, basedOnSeq: sourceSeq };
  const id = session.header?.sessionId ?? 'unknown';
  return { title: sanitizeTitle(`会话 ${id}`) || `会话 ${id}`, basedOnSeq: 0 };
}

/** 精炼输入：活动 user/assistant 消息的顺序转录（尾部优先保留，≤ TITLE_TRANSCRIPT_MAX_CHARS） */
export function buildTitleTranscript(session: LoadedSession, opts: { maxChars?: number } = {}): string {
  computeProjection(session);
  const maxChars = opts.maxChars ?? TITLE_TRANSCRIPT_MAX_CHARS;
  const lines: string[] = [];
  for (const { event, active } of session.events) {
    if (!active) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    lines.push(`${event.type === 'user/message' ? 'USER' : 'ASSISTANT'}: ${stripNoise(event.payload.text)}`);
  }
  // 尾部优先：从最新往前收集到上限（最旧端截断）
  const kept: string[] = [];
  let budget = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (budget + line.length + 1 > maxChars && kept.length > 0) break;
    kept.push(line);
    budget += line.length + 1;
  }
  kept.reverse();
  return kept.join('\n');
}

function isTitle(value: unknown): value is SessionTitle {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<SessionTitle>;
  return (
    t.v === 1 &&
    typeof t.title === 'string' &&
    t.title.length > 0 &&
    (t.source === 'auto' || t.source === 'manual' || t.source === 'refined') &&
    typeof t.basedOnSeq === 'number' &&
    typeof t.updatedAt === 'string'
  );
}

/** 读取标题（文件缺失/坏内容 → null，不抛错） */
export function readSessionTitle(dir: string): SessionTitle | null {
  const file = join(dir, SESSION_TITLE_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isTitle(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入标题（原子写：tmp + rename；空标题抛错） */
export function writeSessionTitle(
  dir: string,
  title: string,
  opts: { source?: TitleSource; basedOnSeq?: number } = {},
): SessionTitle {
  const clean = sanitizeTitle(title);
  if (clean.length === 0) throw new Error('invalid session title: empty after sanitize');
  const record: SessionTitle = {
    v: 1,
    title: clean,
    source: opts.source ?? 'manual',
    basedOnSeq: opts.basedOnSeq ?? 0,
    updatedAt: new Date().toISOString(),
  };
  const file = join(dir, SESSION_TITLE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主错误
    }
    throw e;
  }
  return record;
}

/** 删除标题文件（返回是否实际删除） */
export function clearSessionTitle(dir: string): boolean {
  const file = join(dir, SESSION_TITLE_FILE);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export interface AutoTitleOptions {
  /** 已加载会话（避免二次 loadSession）；缺省由 dir 读取 */
  session?: LoadedSession;
  /** 注入式精炼（未注入 = 纯启发式） */
  refine?: TitleRefiner;
  /** 已有标题时是否重算（缺省 false：人工标题与既有标题都不被覆盖） */
  overwrite?: boolean;
}

export interface AutoTitleResult {
  title: SessionTitle;
  /** 是否使用了注入的精炼结果 */
  refined: boolean;
  /** 精炼回退原因（注入方抛错/返回空时如实登记） */
  refineFallbackReason?: string;
  /** 是否复用了既有标题（未重算） */
  reused: boolean;
}

/**
 * 生成（并按需落盘）会话标题。
 * 已有标题且 overwrite=false → 原样复用（人工标题不会被自动标题悄悄改写）。
 * 精炼失败不改变可交付性：落启发式标题并把原因登记在返回值里。
 */
export async function autoTitleSession(dir: string, opts: AutoTitleOptions = {}): Promise<AutoTitleResult> {
  const existing = readSessionTitle(dir);
  if (existing !== null && !(opts.overwrite ?? false)) {
    return { title: existing, refined: existing.source === 'refined', reused: true };
  }
  const session = opts.session ?? loadSession(dir);
  const heuristic = deriveAutoTitle(session);
  const sessionId = session.header?.sessionId ?? 'unknown';
  if (opts.refine === undefined) {
    const title = writeSessionTitle(dir, heuristic.title, { source: 'auto', basedOnSeq: heuristic.basedOnSeq });
    return { title, refined: false, reused: false };
  }
  try {
    const refined = sanitizeTitle(
      await opts.refine({ candidate: heuristic.title, sessionId, transcript: buildTitleTranscript(session) }),
    );
    if (refined.length === 0) {
      const title = writeSessionTitle(dir, heuristic.title, { source: 'auto', basedOnSeq: heuristic.basedOnSeq });
      return { title, refined: false, reused: false, refineFallbackReason: '精炼返回空标题' };
    }
    const title = writeSessionTitle(dir, refined, { source: 'refined', basedOnSeq: heuristic.basedOnSeq });
    return { title, refined: true, reused: false };
  } catch (e) {
    const title = writeSessionTitle(dir, heuristic.title, { source: 'auto', basedOnSeq: heuristic.basedOnSeq });
    return {
      title,
      refined: false,
      reused: false,
      refineFallbackReason: (e as Error | undefined)?.message ?? String(e),
    };
  }
}
