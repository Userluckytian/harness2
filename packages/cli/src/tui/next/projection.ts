// projection.ts — W1 转录数据投影（P2 接线层，headless 纯函数，零 ink/react）。
//
// 职责：把 transcript.ts 的 TranscriptItem[] 投影为 next 渲染库的**逻辑文本行**
// （ProjectionLine[]），供调用方批量喂给 Scrollback.appendLines（物理换行由
// scrollback.wrapLine 负责，本层不做 wrap）。每行带 lineIndex（TranscriptItem 数组
// 下标）与 kind，供后续交互（点击定位/展开态切换）反查。
//
// 视觉对齐 TranscriptView.tsx / ReasoningBlock.tsx / DiffCard.tsx 的语义，按 next 库
// 约束降级：字符网格只有前景色（无背景色/反色/边框），diff 卡用 `+ `/`- `/`@@ ` 行前缀
// 近似；每行单一前景色（Ink 版可对一行内分段着色，此处整行一色，见各规则注释）。
//
// 折叠语义（钉死）：`opts.collapsed` 是**覆盖标记集**——不在集合 = 按默认折叠规则；
// 在集合 = 与该 item 的默认态取反（toggleCollapse 翻转成员资格）。
// 默认折叠规则（对齐 TranscriptView 现状）：推理块折叠（ReasoningBlock 默认一行）、
// 工具多行输出折叠（output 仅展开态可见）、edit/write diff 折叠（仅展开态渲染）；
// 工具失败原因首行始终可见（TranscriptView：失败原因不藏进展开态）。
import { diffLines } from 'diff';
import { displayWidth } from '../input.js';
import { isSubagentTool, type ToolItem, type TranscriptItem } from '../transcript.js';

/** 前景色（24bit RGB；undefined = 终端默认色，与 drawScrollback 的 fg=0 缺省一致） */
export const FG = {
  green: 0x3fb950,
  red: 0xf85149,
  yellow: 0xd29922,
  gray: 0x8b949e,
} as const;

export type ProjectionLineKind =
  'user' | 'assistant' | 'tool' | 'tool-result' | 'reasoning' | 'subagent' | 'system' | 'diff';

/** 一条逻辑行：text 原样（可含宽字符，不裁剪不换行）；lineIndex = 所属 TranscriptItem 下标 */
export interface ProjectionLine {
  text: string;
  /** 24bit RGB 前景色；undefined = 默认色 */
  fg?: number;
  lineIndex: number;
  kind: ProjectionLineKind;
}

export interface ProjectOptions {
  /** 供超宽单行摘要截断（不传 = 不截断）；物理换行仍由 Scrollback.wrapLine 负责 */
  cols?: number;
  /**
   * 折叠覆盖标记集：index ∈ 集 = 该 item 的默认折叠态取反（展开/收起）。
   * 不传或空集 = 纯默认态（推理折叠、工具多行输出折叠、diff 折叠）。
   */
  collapsed?: ReadonlySet<number>;
}

// --- 小工具 ---

/** 单行化（折叠摘要用）：所有空白（含换行）压成单空格 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** 按 cols 截断超宽行（宽字符整字取舍，留 1 列给省略号）；cols ≤ 0 不截断 */
function clipLine(text: string, cols: number | undefined): string {
  if (cols === undefined || cols < 1 || displayWidth(text) <= cols) return text;
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > cols - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * 工具摘要：args 可解析且含已知键（文件路径/命令等）时优先提炼紧凑摘要（next 层改进：
 * Ink 版显示 summarizeArgs 的 JSON 串，宽屏下冗长）；否则退回 item.summary（reducer 已用
 * summarizeArgs 兜底），再退回 args 首个标量值。
 */
function toolSummaryOf(item: ToolItem): string {
  const args = parseJsonObject(item.args);
  const derived = firstString(args.file_path, args.path, args.file, args.command, args.url);
  if (derived !== undefined) return derived;
  if (item.summary.length > 0) return item.summary;
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return oneLine(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

/** 子代理描述：args.description（缺省 prompt/task 首个字符串），退化用 summary */
function subagentDescription(item: ToolItem): string {
  const args = parseJsonObject(item.args);
  const desc = firstString(args.description, args.prompt, args.task);
  if (desc !== undefined) return oneLine(desc);
  return item.summary;
}

/** partial/empty 的原因行（对齐 TranscriptView 的 reasonLine） */
function reasonLine(stopReason: string | undefined, error: string | undefined): string {
  const parts: string[] = [];
  if (stopReason !== undefined && stopReason.length > 0) parts.push(`stopReason=${stopReason}`);
  if (error !== undefined && error.length > 0) parts.push(error);
  return parts.length > 0 ? parts.join(' · ') : '（无错误详情）';
}

const EXPAND_HINT = '[未完成 / 已中断]';
const DIFF_MAX_LINES = 20; // 与 DiffCard DEFAULT_MAX_LINES 一致

// --- 投影主体 ---

/** 推理块：折叠一行摘要 / 展开逐行 `  │ `（对齐 ReasoningBlock：默认折叠、灰色） */
function projectReasoning(
  text: string,
  lineIndex: number,
  expanded: boolean,
  cols: number | undefined,
  out: ProjectionLine[],
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (!expanded) {
    out.push({
      text: clipLine(`  ▸ 思考…(${trimmed.length} 字)`, cols),
      lineIndex,
      kind: 'reasoning',
      fg: FG.gray,
    });
    return;
  }
  for (const line of splitLines(trimmed)) {
    out.push({ text: `  │ ${line}`, lineIndex, kind: 'reasoning', fg: FG.gray });
  }
}

interface DiffRow {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

/** before→after 行级差异（与 DiffCard 同用 diff 包；另产出 @@ hunk 头近似 unified diff） */
function computeDiffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const kind: DiffRow['kind'] = part.added ? 'add' : part.removed ? 'remove' : 'context';
    for (const line of lines) rows.push({ kind, text: line });
  }
  return rows;
}

/** diff 块（展开态）：`── 文件 ──` 头 + `+/-/@@` 前缀行 + 截断提示（前缀近似 DiffCard 颜色语义） */
function projectDiff(item: ToolItem, lineIndex: number, out: ProjectionLine[]): void {
  const args = parseJsonObject(item.args);
  const filePath = firstString(args.file_path, args.path, args.file) ?? item.tool;
  const before = item.tool === 'edit' ? (typeof args.old_text === 'string' ? args.old_text : '') : '';
  const after =
    item.tool === 'edit'
      ? typeof args.new_text === 'string'
        ? args.new_text
        : ''
      : typeof args.content === 'string'
        ? args.content
        : '';
  const rows = computeDiffRows(before, after);
  out.push({ text: `── ${filePath} ──`, lineIndex, kind: 'diff', fg: FG.gray });
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let visible = 0;
  let atDiffStart = true;
  for (const row of rows) {
    // @@ hunk 头：变更块起点（1-based 行号，取自变更前计数）。紧贴文件头（diff 首行即变更）
    // 的第一个块省略头——`── 文件 ──` 已充当分隔，避免 write 新文件类纯增量 diff 的噪音行。
    const hunkStart = row.kind !== 'context' && !inHunk;
    if (hunkStart && !atDiffStart && visible < DIFF_MAX_LINES) {
      out.push({ text: `@@ -${oldLine + 1} +${newLine + 1} @@`, lineIndex, kind: 'diff', fg: FG.gray });
    }
    if (row.kind === 'add') newLine += 1;
    else if (row.kind === 'remove') oldLine += 1;
    else {
      oldLine += 1;
      newLine += 1;
    }
    inHunk = row.kind !== 'context';
    atDiffStart = false;
    if (visible >= DIFF_MAX_LINES) continue; // 行号计数继续走，行不再产出
    if (row.kind === 'add') out.push({ text: `+ ${row.text}`, lineIndex, kind: 'diff', fg: FG.green });
    else if (row.kind === 'remove') out.push({ text: `- ${row.text}`, lineIndex, kind: 'diff', fg: FG.red });
    else out.push({ text: row.text, lineIndex, kind: 'diff', fg: FG.gray });
    visible += 1;
  }
  if (rows.length > DIFF_MAX_LINES) {
    out.push({ text: `… 还有 ${rows.length - DIFF_MAX_LINES} 行`, lineIndex, kind: 'diff', fg: FG.gray });
  }
}

/**
 * 工具/子代理 item：调用行 + 结果行 +（展开态）diff 块与输出行。
 * 调用行整行取状态色（next 库每行单一前景色；Ink 版只着色 `> icon` 前缀，语义等价降级）。
 */
function projectTool(
  item: ToolItem,
  lineIndex: number,
  expanded: boolean,
  cols: number | undefined,
  out: ProjectionLine[],
): void {
  const isSub = isSubagentTool(item.tool);
  const statusFg = item.status === 'pending' ? FG.yellow : item.status === 'ok' ? FG.green : FG.red;
  if (isSub) {
    const state = item.status === 'pending' ? '运行中' : item.status === 'ok' ? '完成' : '失败';
    out.push({
      text: clipLine(`⏺ Subagent "${subagentDescription(item)}" ${state}`, cols),
      lineIndex,
      kind: 'subagent',
      fg: statusFg,
    });
  } else {
    out.push({
      text: clipLine(`⏺ ${item.tool}(${toolSummaryOf(item)})`, cols),
      lineIndex,
      kind: 'tool',
      fg: statusFg,
    });
  }
  // T1：子会话只读入口提示（解析不到不显示；Ink 版还带 Ctrl+J/K 键位提示，键位归接线层）
  if (item.childSessionId !== undefined) {
    out.push({ text: `  ↳ 子会话 ${item.childSessionId}`, lineIndex, kind: 'subagent', fg: FG.gray });
  }
  // 结果行：pending 无；失败原因首行始终可见
  let deferredOutput: string[] = [];
  if (item.status === 'failed') {
    const errLines = item.error !== undefined && item.error.length > 0 ? splitLines(item.error) : ['（无错误详情）'];
    out.push({ text: `  └ ✗ ${errLines[0] ?? ''}`, lineIndex, kind: 'tool-result', fg: FG.red });
    if (expanded) {
      for (const line of errLines.slice(1)) {
        out.push({ text: `  │ ${line}`, lineIndex, kind: 'tool-result', fg: FG.gray });
      }
    }
    const output = item.output ?? '';
    if (expanded && output.length > 0) deferredOutput = splitLines(output);
  } else if (item.status === 'ok' && !isSub) {
    // 子代理 ok 的结果状态已由「完成」状态行表达，且其 output 是 childSessionId JSON（内部
    // 协议载荷，非人读文本），不再产出 `  └ ✓` 行；普通工具照常产出。
    const output = item.output ?? '';
    const lines = output.length > 0 ? splitLines(output) : [];
    if (!expanded) {
      // 折叠态：摘要内联在 └ 行；多行带「共 N 行」提示（整体截断到 cols）
      const first = lines.length > 0 ? oneLine(lines[0] ?? '') : '';
      const suffix = lines.length > 1 ? `（共 ${lines.length} 行）` : '';
      const summary = first.length > 0 || suffix.length === 0 ? `${first}${suffix}` : suffix;
      out.push({
        text: clipLine(`  └ ✓ ${summary}`.trimEnd(), cols),
        lineIndex,
        kind: 'tool-result',
        fg: FG.green,
      });
    } else {
      // 展开态：`  └ ✓` 头 + 输出逐行 `  │ `（输出行排在 diff 块之后，见下方 deferred 输出）
      out.push({ text: '  └ ✓', lineIndex, kind: 'tool-result', fg: FG.green });
      deferredOutput = lines;
    }
  }
  // 展开态：edit/write 的 diff 卡（DiffCard 的前缀字符近似）在结果行之后、输出之前
  if (expanded && (item.tool === 'edit' || item.tool === 'write')) {
    projectDiff(item, lineIndex, out);
  }
  for (const line of deferredOutput) {
    out.push({ text: `  │ ${line}`, lineIndex, kind: 'tool-result', fg: FG.gray });
  }
}

/**
 * TranscriptItem[] → 逻辑文本行（纯函数；不做物理换行/物理裁剪，那由 Scrollback.wrapLine 负责）。
 * 每行 lineIndex 指回 items 下标，供交互定位；fg 为 24bit RGB（undefined = 默认色）。
 */
export function projectTranscript(items: readonly TranscriptItem[], opts: ProjectOptions = {}): ProjectionLine[] {
  const collapsed = opts.collapsed;
  const cols = opts.cols !== undefined && opts.cols > 0 ? Math.floor(opts.cols) : undefined;
  const out: ProjectionLine[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    // 覆盖标记：在集 = 与默认折叠态取反（默认折叠的 item 展开；默认展开的收起）
    const expanded = collapsed?.has(i) ?? false;
    switch (item.kind) {
      case 'user': {
        const lines = splitLines(item.text);
        out.push({ text: `❯ ${lines[0] ?? ''}`, lineIndex: i, kind: 'user' });
        for (let k = 1; k < lines.length; k += 1) {
          out.push({ text: lines[k] ?? '', lineIndex: i, kind: 'user' });
        }
        break;
      }
      case 'assistant': {
        for (const line of splitLines(item.text)) {
          out.push({ text: line, lineIndex: i, kind: 'assistant' });
        }
        if (item.reasoning !== undefined) {
          projectReasoning(item.reasoning, i, expanded, cols, out);
        }
        break;
      }
      case 'partial': {
        for (const line of splitLines(item.text)) {
          out.push({ text: line, lineIndex: i, kind: 'assistant' });
        }
        out.push({
          text: `${EXPAND_HINT} ${reasonLine(item.stopReason, item.error)}`,
          lineIndex: i,
          kind: 'system',
          fg: FG.yellow,
        });
        break;
      }
      case 'empty': {
        // 禁止空白气泡：无正文也必须给出 stopReason/error 的可读行
        out.push({
          text: `${EXPAND_HINT} ${reasonLine(item.stopReason, item.error)}`,
          lineIndex: i,
          kind: 'system',
          fg: FG.red,
        });
        break;
      }
      case 'tool':
        projectTool(item, i, expanded, cols, out);
        break;
      case 'system':
      case 'status':
        out.push({ text: item.text, lineIndex: i, kind: 'system', fg: FG.gray });
        break;
    }
  }
  return out;
}

/**
 * 折叠切换（纯函数）：翻转 itemIndex 在覆盖标记集中的成员资格，返回新 Set（不改传入集）。
 * 语义见 ProjectOptions.collapsed：在集 = 与该 item 默认折叠态取反。
 */
export function toggleCollapse(itemIndex: number, collapsed: ReadonlySet<number>): Set<number> {
  const next = new Set(collapsed);
  if (next.has(itemIndex)) next.delete(itemIndex);
  else next.add(itemIndex);
  return next;
}
