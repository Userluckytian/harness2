// @file 引用协议（与终端轨道 T9 同源；B8 首次落地为纯函数共享模块）。
//
// 协议契约（T9 research doc，两端必须一致——CLI context-ref 与桌面共享同一套语义）：
//   1. 正则 /@([^\s"']+)/g 找所有 `@路径` token（@ 紧跟非空、不含引号字节才触发）。
//   2. 路径优先「相对当前 cwd」解析；文件 readFile（UTF-8），失败/不存在跳过，
//      并在本轮消息末尾追加提示（x = 原 token）：文件不存在 → `[@x 未找到，已忽略]`；
//      读取通道缺失/读取失败 → `[@x 读取通道不可用，已忽略]`（P2-3：分开归因，不把「读不了」说成「不存在」）。
//   3. 单文件 64KB 截断保护：超出取前 64KB 并追加截断提示。
//   4. 解析结果拼成代码块插到发给模型的 user message 最前面；UI 里回显的仍是原始输入文本。
//
// 本模块零依赖、纯同步/纯函数、可单测，main/renderer 共享。读取经注入的 readRef 回调
// （桌面端 = window.harness2.readFileForRef，走主进程 fs）。

/** @路径 token 提取正则（与 T9 一致：@ 紧跟非空白/非引号字节） */
export const FILE_REF_TOKEN_RE = /@([^\s"']+)/g;

/** 单文件内容硬上限（与主进程 bridge readFileForRef 的 CRASH_CAP 一致：64KB 字符） */
export const FILE_REF_MAX_LEN = 64 * 1024;

/**
 * 单轮 @引用 的总字节预算（D1）：所有引用块合计不得超过，超出部分**不纳入上下文**并如实标注。
 * 口径 = UTF-8 字节数（不是字符数），防止多字节内容把上下文撑爆。
 */
export const FILE_REF_TOTAL_MAX_BYTES = 256 * 1024;

/** 二进制拒收文案（追加到消息末尾；x = 原 token） */
export const FILE_REF_BINARY_SUFFIX = '[@x 二进制文件，已忽略]';

/** 字节预算超出文案（追加到消息末尾；x = 原 token） */
export const FILE_REF_BUDGET_SUFFIX = '[@x 超出本轮引用字节预算，已忽略]';

/** 未找到时的文案（x 由调用方替换为原始 token；两端必须一致） */
export const FILE_REF_NOT_FOUND_SUFFIX = '[@x 未找到，已忽略]';

/**
 * 读取通道缺失 / 读取失败时的文案（P2-3；x 由调用方替换为原始 token）。
 * 与「未找到」分开归因：文件可能存在，只是本壳没有读取通道或这次读取失败——
 * 不能把「通道不可用」说成「文件不存在」（不可行动）。
 */
export const FILE_REF_UNAVAILABLE_SUFFIX = '[@x 读取通道不可用，已忽略]';

/** 截断时的提示文案（追加在该文件代码块末尾；两端必须一致） */
export const FILE_REF_TRUNCATED_SUFFIX = '\n[… 内容过长已截断 @x]';

/** readRef 的返回形状（P2-3：`reason` 区分「文件不存在」与「通道缺失/读取失败」） */
export interface FileRefReadOutcome {
  ok: boolean;
  content?: string;
  truncated?: boolean;
  error?: string;
  reason?: 'not-found' | 'unavailable';
}

/** readRef 回调形状：path 传原始 token，cwd 传当前会话工作目录；返回读取结果。
 *  `reason`（可选，P2-3）：'not-found' = 文件确实不存在；'unavailable' = 通道缺失/读取失败。
 *  缺省按 'not-found' 归因（旧壳实现不变）。 */
export type FileRefReader = (path: string, cwd: string) => Promise<FileRefReadOutcome>;

/** 从文本提取所有 @路径 token（去重，保持首次出现顺序；无 @ 返回空数组） */
export function extractFileRefs(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  FILE_REF_TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(FILE_REF_TOKEN_RE)) {
    const token = m[1]!;
    if (!seen.has(token) && token.length > 0) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export interface FileRefSource {
  token: string;
  /** 实际纳入上下文的字符数 */
  chars: number;
  /** 实际纳入上下文的 UTF-8 字节数 */
  bytes: number;
  /** 命中单文件 64KB 截断保护 */
  truncated: boolean;
}

/** 未纳入上下文的原因（UI 必须可见——引用来源不能让用户猜） */
export type FileRefSkipReason = 'binary' | 'budget';

export interface ResolveFileRefsResult {
  /** 最终发给模型的文本：代码块 + 原文 + （可选）未找到提示，全部插到最前/末尾 */
  finalText: string;
  /** 解析成功的代码块（`` ``` … ``` ``，按 token 出现顺序） */
  blocks: string[];
  /** 确认**不存在**的原始 token 列表（读取通道可用但文件不在） */
  notFound: string[];
  /** 读取通道缺失/不可用/读取失败的原始 token 列表（P2-3：与「未找到」分开归因） */
  unavailable: string[];
  /** 实际纳入上下文的引用来源（D1：来源可见） */
  sources: FileRefSource[];
  /** 被拒收的引用（二进制 / 超字节预算）及原因 */
  skipped: Array<{ token: string; reason: FileRefSkipReason }>;
}

/** UTF-8 字节数（渲染端无 Buffer；TextEncoder 为标准 API） */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 二进制内容判定（D1）：命中即**不得**注入模型上下文（会污染 token 且不可读）。
 * 口径（保守、可测）：
 *   - 含 NUL 字节（\u0000）→ 二进制；
 *   - 长度 ≥ 32 且不可打印控制字符（除 \t \n \r）占比 > 30% → 二进制。
 */
export function isBinaryContent(content: string): boolean {
  if (content.includes('\u0000')) return true;
  if (content.length < 32) return false;
  let control = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    const printable = (c >= 0x20 && c !== 0x7f) || c === 0x09 || c === 0x0a || c === 0x0d;
    if (!printable) control += 1;
  }
  return control / content.length > 0.3;
}

/**
 * 解析并拼接 @file 引用。
 * - 不含 @ → finalText = 原文（零开销，不触发任何 readRef）。
 * - cwd 为空/未知 → 不解析，按无 @ 处理（不报错、不发 IPC）。
 * - 读取失败/不存在 → 跳过；**分开归因**（P2-3）：文件不存在 → notFound（`[@token 未找到，已忽略]`），
 *   读取通道缺失/不可用/读取失败 → unavailable（`[@token 读取通道不可用，已忽略]`）。
 * - 超 64KB → 取前 64KB 并在代码块末尾追加截断提示（截断标记由主进程 truncated 给出）。
 * - 二进制 → 不纳入上下文，记入 skipped（附 `[@token 二进制文件，已忽略]`）。
 * - 单轮总字节预算（FILE_REF_TOTAL_MAX_BYTES）→ 超出者不纳入，记入 skipped（附预算提示）。
 */
export async function resolveFileRefs(
  text: string,
  cwd: string | undefined,
  readRef: FileRefReader,
  opts?: { maxTotalBytes?: number },
): Promise<ResolveFileRefsResult> {
  if (typeof cwd !== 'string' || cwd.length === 0 || !text.includes('@')) {
    return { finalText: text, blocks: [], notFound: [], unavailable: [], sources: [], skipped: [] };
  }
  const budget = opts?.maxTotalBytes ?? FILE_REF_TOTAL_MAX_BYTES;
  const tokens = extractFileRefs(text);
  const blocks: string[] = [];
  const notFound: string[] = [];
  const unavailable: string[] = [];
  const sources: FileRefSource[] = [];
  const skipped: Array<{ token: string; reason: FileRefSkipReason }> = [];
  const notes: string[] = [];
  let usedBytes = 0;
  for (const token of tokens) {
    const res: FileRefReadOutcome | undefined = await readRef(token, cwd);
    if (res?.ok !== true || res.content === undefined) {
      // P2-3：只在读取通道**可用**且明确报告文件不存在时才归因「未找到」；
      // 通道缺失（壳未注入 readRef）/读取失败/契约违约（无返回、或 ok:true 却无 content）
      // 一律归因「读取通道不可用」，否则会把「本壳读不了」说成「文件不存在」，用户据此去改路径 = 不可行动。
      const unavailableSinceChannel = res === undefined || res.reason === 'unavailable' || res.ok === true;
      if (unavailableSinceChannel) {
        unavailable.push(token);
        notes.push(FILE_REF_UNAVAILABLE_SUFFIX.replace('@x', token));
      } else {
        notFound.push(token);
      }
      continue;
    }
    if (isBinaryContent(res.content)) {
      skipped.push({ token, reason: 'binary' });
      notes.push(FILE_REF_BINARY_SUFFIX.replace('@x', token));
      continue;
    }
    let content = res.content;
    if (res.truncated) {
      content = content.slice(0, FILE_REF_MAX_LEN) + FILE_REF_TRUNCATED_SUFFIX.replace('@x', token);
    }
    const bytes = utf8Bytes(content);
    // 预算在**注入前**判定：不静默截断到一半（宁可整块拒收并告知）
    if (usedBytes + bytes > budget) {
      skipped.push({ token, reason: 'budget' });
      notes.push(FILE_REF_BUDGET_SUFFIX.replace('@x', token));
      continue;
    }
    usedBytes += bytes;
    blocks.push(`\n\`\`\`\n${content}\n\`\`\`\n`);
    sources.push({ token, chars: content.length, bytes, truncated: res.truncated === true });
  }
  let finalText = text;
  if (blocks.length > 0) {
    finalText = blocks.join('\n') + '\n' + finalText;
  }
  if (notFound.length > 0) {
    const suffix = notFound.map((t) => FILE_REF_NOT_FOUND_SUFFIX.replace('@x', t)).join('');
    finalText = finalText + suffix;
  }
  if (notes.length > 0) finalText = finalText + notes.join('');
  return { finalText, blocks, notFound, unavailable, sources, skipped };
}
