// quote-block.ts — 引用块构造（Z4-02 文件行内评论 / Z4-03 转录划词「询问」共用）。
//
// 语义参照（docs/refs/refs-zcode.md Z-94 / refs-zcode-layout.md Z-14）：ZCode 的代码评论与
// 划词「Ask in side chat」本质相同 —— 把引用（代码行 / 选区文本）作为上下文发给 agent。
// 我们没有独立 side-chat 通道（刻意差异，见实现计划登记），等价物 = 把引用块预填进主
// composer 草稿。本模块只负责**构造**引用块的 markdown 文本；预填通道见
// `renderer/conversation/composer/prefill.ts`（seat 消费）。
//
// 格式（Z4-02 交付口径）：
//   `相对路径:起-止行`
//   > 选中文本（多行则逐行 > 前缀；空行以裸 `>` 保持块连续）
// 转录划词同构，定位头换成来源行类型（用户消息 / 助手消息）。
//
// 纯函数、零 DOM / 零 React（node 可测）。边界如实处理：越界行号夹取、整段越界 / 空白
// 文本 → null（调用方据此不渲染入口、不预填 —— 「无可引用内容就不显示入口」，红线⑩）。

/** 引用块构造的最小输入：定位头 + 被引用文本 */
export interface QuoteBlockInput {
  /** 定位头（如 `src/a.ts:3-5` 或 `对话选区（用户消息）`；两端的反引号由本模块补） */
  readonly source: string;
  /** 被引用文本（`\n` 分行；`\r` 剥离；结尾空行丢弃） */
  readonly text: string;
}

/**
 * 构造引用块（两处共用的底层纯函数）。
 * 返回 null 的情形：定位头为空白、被引用文本为空白（全部行都空白）。
 */
export function buildQuoteBlock(input: QuoteBlockInput): string | null {
  const source = input.source.trim();
  if (source.length === 0) return null;
  const lines = quoteLines(input.text);
  if (lines === null) return null;
  return `${inlineCode(source)}\n${lines.map((line) => (line.length === 0 ? '>' : `> ${line}`)).join('\n')}`;
}

/** 文件行引用（Z4-02）：路径 + 1 起算行号 + 文件全部行 → 引用块。 */
export interface FileQuoteInput {
  /** 文件路径（预览面板的 preview.path；相对 / 绝对、含反斜杠都原样进定位头） */
  readonly path: string;
  /** 文件全部行（下标 0 = 第 1 行；与预览渲染同一份 split('\n') 结果） */
  readonly lines: readonly string[];
  /** 起（1 起算） */
  readonly startLine: number;
  /** 止（1 起算；缺省 = 单行） */
  readonly endLine?: number;
}

/**
 * 文件行引用块。行号边界如实处理：
 *   - 非有限整数（NaN/Infinity/小数）→ null；
 *   - start/end 先按大小归一，再夹取到 [1, 实际行数]；夹取后为空区间（整段越界，如
 *     请求第 5 行但文件只有 3 行）→ null，**不伪造**「最近的行」；
 *   - 部分越界（如 end 超过末行）夹到末行（能引多少引多少）。
 * 定位头：单行 `path:N`；跨行 `path:N-M`（夹取后的真实范围）。
 */
export function buildFileQuote(input: FileQuoteInput): string | null {
  const path = input.path.trim();
  if (path.length === 0) return null;
  const { startLine, endLine } = input;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine ?? startLine)) return null;
  const requestedLo = Math.min(startLine, endLine ?? startLine);
  const requestedHi = Math.max(startLine, endLine ?? startLine);
  const total = input.lines.length;
  // 夹取到实际行数（1 起算）；整段越界 = 引用不到任何真实内容 → null
  const lo = Math.max(1, requestedLo);
  const hi = Math.min(total, requestedHi);
  if (lo > hi) return null;
  const source = lo === hi ? `${path}:${lo}` : `${path}:${lo}-${hi}`;
  return buildQuoteBlock({ source, text: input.lines.slice(lo - 1, hi).join('\n') });
}

/** 转录划词的来源行类型（Z4-03） */
export type TranscriptQuoteOrigin = 'user' | 'assistant';

/** 转录划词引用块：定位头 = 来源行类型（无路径无行号 —— 转录没有稳定可寻址坐标，如实如此） */
export function buildTranscriptQuote(input: {
  readonly origin: TranscriptQuoteOrigin;
  readonly text: string;
}): string | null {
  const source = input.origin === 'user' ? '对话选区（用户消息）' : '对话选区（助手消息）';
  return buildQuoteBlock({ source, text: input.text });
}

// —— 内部 ——

/** 规整被引用文本：剥行尾 \r → 丢弃结尾空行；全空白 → null（无可引用内容） */
function quoteLines(text: string): readonly string[] | null {
  const raw = text.split('\n').map((line) => line.replace(/\r$/, ''));
  while (raw.length > 0 && raw[raw.length - 1]?.trim().length === 0) raw.pop();
  if (raw.every((line) => line.trim().length === 0)) return null;
  return raw;
}

/**
 * CommonMark 行内代码：选比内容里最长反引号串更长的定界符；
 * 内容以反引号开头 / 结尾时两侧各补一个空格（CommonMark code span 规则）。
 * 路径里的反斜杠等字符在 code span 内无需转义。
 */
function inlineCode(text: string): string {
  let level = 1;
  for (const match of text.matchAll(/`+/g)) level = Math.max(level, match[0].length + 1);
  const fence = '`'.repeat(level);
  const padded = text.startsWith('`') || text.endsWith('`');
  return padded ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
