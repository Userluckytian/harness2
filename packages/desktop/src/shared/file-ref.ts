// @file 引用协议（与终端轨道 T9 同源；B8 首次落地为纯函数共享模块）。
//
// 协议契约（T9 research doc，两端必须一致——CLI context-ref 与桌面共享同一套语义）：
//   1. 正则 /@([^\s"']+)/g 找所有 `@路径` token（@ 紧跟非空、不含引号字节才触发）。
//   2. 路径优先「相对当前 cwd」解析；文件 readFile（UTF-8），失败/不存在跳过，
//      并在本轮消息末尾追加提示 `[@x 未找到，已忽略]`（x = 原 token）。
//   3. 单文件 64KB 截断保护：超出取前 64KB 并追加截断提示。
//   4. 解析结果拼成代码块插到发给模型的 user message 最前面；UI 里回显的仍是原始输入文本。
//
// 本模块零依赖、纯同步/纯函数、可单测，main/renderer 共享。读取经注入的 readRef 回调
// （桌面端 = window.harness2.readFileForRef，走主进程 fs）。

/** @路径 token 提取正则（与 T9 一致：@ 紧跟非空白/非引号字节） */
export const FILE_REF_TOKEN_RE = /@([^\s"']+)/g;

/** 单文件内容硬上限（与主进程 bridge readFileForRef 的 CRASH_CAP 一致：64KB 字符） */
export const FILE_REF_MAX_LEN = 64 * 1024;

/** 未找到时的文案（x 由调用方替换为原始 token；两端必须一致） */
export const FILE_REF_NOT_FOUND_SUFFIX = '[@x 未找到，已忽略]';

/** 截断时的提示文案（追加在该文件代码块末尾；两端必须一致） */
export const FILE_REF_TRUNCATED_SUFFIX = '\n[… 内容过长已截断 @x]';

/** readRef 回调形状：path 传原始 token，cwd 传当前会话工作目录；返回读取结果 */
export type FileRefReader = (
  path: string,
  cwd: string,
) => Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }>;

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

export interface ResolveFileRefsResult {
  /** 最终发给模型的文本：代码块 + 原文 + （可选）未找到提示，全部插到最前/末尾 */
  finalText: string;
  /** 解析成功的代码块（`` ``` … ``` ``，按 token 出现顺序） */
  blocks: string[];
  /** 未找到/读取失败的原始 token 列表 */
  notFound: string[];
}

/**
 * 解析并拼接 @file 引用。
 * - 不含 @ → finalText = 原文（零开销，不触发任何 readRef）。
 * - cwd 为空/未知 → 不解析，按无 @ 处理（不报错、不发 IPC）。
 * - 读取失败/不存在 → 跳过，记入 notFound，并在消息末尾追加 `[@token 未找到，已忽略]`。
 * - 超 64KB → 取前 64KB 并在代码块末尾追加截断提示（截断标记由主进程 truncated 给出）。
 */
export async function resolveFileRefs(
  text: string,
  cwd: string | undefined,
  readRef: FileRefReader,
): Promise<ResolveFileRefsResult> {
  if (typeof cwd !== 'string' || cwd.length === 0 || !text.includes('@')) {
    return { finalText: text, blocks: [], notFound: [] };
  }
  const tokens = extractFileRefs(text);
  const blocks: string[] = [];
  const notFound: string[] = [];
  for (const token of tokens) {
    const res = await readRef(token, cwd);
    if (res?.ok !== true || res.content === undefined) {
      notFound.push(token);
      continue;
    }
    let content = res.content;
    if (res.truncated) {
      content = content.slice(0, FILE_REF_MAX_LEN) + FILE_REF_TRUNCATED_SUFFIX.replace('@x', token);
    }
    blocks.push(`\n\`\`\`\n${content}\n\`\`\`\n`);
  }
  let finalText = text;
  if (blocks.length > 0) {
    finalText = blocks.join('\n') + '\n' + finalText;
  }
  if (notFound.length > 0) {
    const suffix = notFound.map((t) => FILE_REF_NOT_FOUND_SUFFIX.replace('@x', t)).join('');
    finalText = finalText + suffix;
  }
  return { finalText, blocks, notFound };
}
