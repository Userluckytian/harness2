// projection.ts — W1 转录数据投影（P2 接线层，headless 纯函数，零旧壳/React）。
//
// 职责：把 transcript.ts 的 TranscriptItem[] 投影为 next 渲染库的**逻辑文本行**
// （ProjectionLine[]），供调用方批量喂给 Scrollback.appendLines（物理换行由
// scrollback.wrapLine 负责，本层不做 wrap）。每行带 lineIndex（TranscriptItem 数组
// 下标）与 kind，供后续交互（点击定位/展开态切换）反查。
//
// 视觉对齐旧壳转录区（推理块 / diff 卡）的语义，按 next 库
// 约束降级：字符网格只有前景色（无背景色/反色/边框），diff 卡用 `+ `/`- `/`@@ ` 行前缀
// 近似；每行单一前景色（旧壳版可对一行内分段着色，此处整行一色，见各规则注释）。
//
// 折叠语义（钉死）：`opts.collapsed` 是**覆盖标记集**——不在集合 = 按默认折叠规则；
// 在集合 = 与该 item 的默认态取反（toggleCollapse 翻转成员资格）。
// 默认折叠规则（对齐 TranscriptView 现状）：推理块折叠（ReasoningBlock 默认一行）、
// 工具多行输出折叠（output 仅展开态可见）、edit/write diff 折叠（仅展开态渲染）；
// 工具失败原因首行始终可见（TranscriptView：失败原因不藏进展开态）。
import { diffLines } from 'diff';
import { displayWidth } from '../input.js';
import { isSubagentTool, type ToolItem, type TranscriptItem } from '../transcript.js';
import { DARK_THEME, type Theme } from './theme.js';

/**
 * 前景色（24bit RGB；undefined = 终端默认色，与 drawScrollback 的 fg=0 缺省一致）。
 * P4-2：值改为从 dark 主题逐值引用（零变化契约——旧常量语义 = dark 主题槽位），
 * 供既有测试断言沿用；新代码请用 theme.ts 的语义槽位。
 */
export const FG = {
  green: DARK_THEME.fg.toolOk,
  red: DARK_THEME.fg.toolFailed,
  yellow: DARK_THEME.fg.toolPending,
  gray: DARK_THEME.fg.reasoning,
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
  /**
   * P11-T4：右侧对齐的弱化附属文本（消息时间戳）。**不在 text 里**——保证复制/搜索/
   * 选区只拿到正文；由 Scrollback.drawScrollback 在首物理行右端绘制。
   */
  right?: string;
  /** 右侧文本前景色（主题弱化色；undefined = 继承行 fg） */
  rightFg?: number;
}

export interface ProjectOptions {
  /** 供超宽单行摘要截断（不传 = 不截断）；物理换行仍由 Scrollback.wrapLine 负责 */
  cols?: number;
  /**
   * 折叠覆盖标记集：index ∈ 集 = 该 item 的默认折叠态取反（展开/收起）。
   * 不传或空集 = 纯默认态（推理折叠、工具多行输出折叠、diff 折叠）。
   */
  collapsed?: ReadonlySet<number>;
  /**
   * P3-D：子代理耗时表（callId → 秒）。数据由 UI 层（next-shell）在 turn 事件流上计时——
   * subagent tool/call 到 tool/result 的间隔，含审批等待/调度延迟，为**近似值**（非 core
   * runTurn 的 durationMs）。命中才显示 `完成（43s）` / `失败（43s）`（对齐 grok
   * "Subagent completed in 43s"；无命中不显示，不伪造）。
   */
  durations?: ReadonlyMap<string, number>;
  /**
   * P3-D：运行中子代理行的 spinner 指示字符（next-shell 150ms 循环传入当前帧）。
   * 不传 = 保持 `⏺` 前缀；只替换运行中（pending）子代理行的前缀，完成/失败行与普通工具行不变。
   */
  spinner?: string;
  /**
   * P4-2：主题（命名色板）。不传 = dark（= 现状默认色，零变化契约）；换主题时调用方
   * 需全量重投影（fg 烤进行对象，增量 append 不会重算旧行）。
   */
  theme?: Theme;
  /**
   * G-05 `r` 原始视图开关（folds.ts 的 rawMarkdown，P3-D 接线）。next 无 markdown 渲染层
   * （assistant 正文本就是原始 markdown 文本），故本开关的 next 层落法（映射登记）：
   * - 工具卡调用行不做摘要提炼：`⏺ tool(<args 原文>)`（有 args 时），退回 summary；
   * - 关闭超宽截断（clipLine 不生效）——原始视图不做「装饰性」加工。
   * 不传 = false（正常渲染投影，零变化契约）。
   */
  rawMarkdown?: boolean;
  /**
   * P11-T4：消息时间戳 12/24 小时制覆盖（缺省 = 系统偏好，见 formatClock）。
   * 仅测试注入确定性；生产装配不传。
   */
  hour12?: boolean;
}

// --- 小工具 ---

/** 单行化（折叠摘要用）：所有空白（含换行）压成单空格 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitLines(text: string): string[] {
  // 硬换行：'\n' / '\r\n' / '\r' 一律作行分隔（P11-T1 P0 修复：多行文本必须拆成多条
  // 逻辑行——ProjectionLine 契约是「一条逻辑行」；内嵌换行若整段下传，renderer 会把它当
  // 可打印字符写进网格单元格，presenter 逐格原样发射后终端在行中换行 → 面板错位）。
  return text.split(/\r\n|\r|\n/);
}

/**
 * P11-T4：消息时间戳文案（消息行右侧弱化显示）。
 *
 * 格式取舍（登记）：**跟随系统 12/24 小时制**——`Intl.DateTimeFormat().resolvedOptions().hour12`
 * 为 true 时用 `h:MM AM/PM`（如 `2:05 PM`），否则用 `HH:MM`（如 `14:05`）；时区取本地。
 * `hour12` 参数供测试注入确定性（缺省 = 系统偏好）。只接受能解析的 ISO 时间戳，
 * 无法解析返回 undefined（调用方不显示，绝不拿当前时间顶替）。
 */
export function formatClock(iso: string | undefined, hour12?: boolean): string | undefined {
  if (iso === undefined || iso.length === 0) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const use12 = hour12 ?? Intl.DateTimeFormat().resolvedOptions().hour12 === true;
  if (!use12) return `${String(h).padStart(2, '0')}:${m}`;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}

/** 按 cols 截断超宽行（宽字符整字取舍，留 1 列给省略号）；cols ≤ 0 不截断 */
function clipLine(text: string, cols: number | undefined): string {
  // G-05 rawMarkdown（r）：原始视图不做截断加工（映射见 ProjectOptions.rawMarkdown 注）
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
 * 旧壳版显示 summarizeArgs 的 JSON 串，宽屏下冗长）；否则退回 item.summary（reducer 已用
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

/** 子代理描述：args.description（缺省 prompt/task 首个字符串），退化用 summary（导出供接线层列表复用） */
export function subagentDescription(item: ToolItem): string {
  const args = parseJsonObject(item.args);
  const desc = firstString(args.description, args.prompt, args.task);
  if (desc !== undefined) return oneLine(desc);
  return item.summary;
}

/**
 * G-05 rawMarkdown（r）：工具调用行的原始载荷——args 原文（未解析未提炼）；
 * 无 args 退回 summary（不伪造）。映射依据见 ProjectOptions.rawMarkdown 注。
 */
function rawArgsOf(item: ToolItem): string {
  return item.args !== undefined && item.args.length > 0 ? item.args : item.summary;
}

// ── P11-T5：工具行人类化（动词注册表 + 未知/缺参回退） ──────────────────────────
//
// 目标（docs/tui-parity/matrix.md 改进清单 #5）：主行给「做了什么」（`写入 harness2-demo.txt`），
// 不再暴露 `tool({"file_path":…})`；参数 JSON 移入**展开态**（Tab 焦点 + 展开键），
// 工具名保留在展开态与原始视图（`r`）。
//
// 注册表逐条覆盖**内置工具**（core builtin 6：bash/read/write/edit/glob/grep；browser 6；
// 以及 memory/skill/skill_author/run_script/subagent_fanout）。
// **未知工具回退现状** = `工具名(摘要)`——绝不硬编码失败，也不编造能力；已知工具但
// 必需参数缺失/无法解析时同样回退现状（宁可显示原文，不显示 `写入 undefined`）。
// 新增工具只需在此表补一条；遗漏 = 自动走回退，无副作用。
// 说明：`subagent_start`/`subagent_continue` 走既有 isSub 分支（`Subagent "…" 完成`），
// 不进本表。

/** 从解析后的 args 取第一个非空字符串值（与 toolSummaryOf 同口径） */
function argOf(args: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  return firstString(...keys.map((k) => args[k]));
}

/** 工具名 → 人类动词短语构造器（无参工具返回固定短语；必填参数缺失返回 undefined 由调用方回退） */
const TOOL_ACTIONS: Readonly<Record<string, (args: Record<string, unknown>) => string | undefined>> = {
  write: (a) => {
    const f = argOf(a, 'file_path', 'path', 'file');
    return f !== undefined ? `写入 ${f}` : undefined;
  },
  edit: (a) => {
    const f = argOf(a, 'file_path', 'path', 'file');
    return f !== undefined ? `编辑 ${f}` : undefined;
  },
  read: (a) => {
    const f = argOf(a, 'file_path', 'path', 'file');
    return f !== undefined ? `读取 ${f}` : undefined;
  },
  bash: (a) => {
    const c = argOf(a, 'command', 'cmd');
    return c !== undefined ? `运行命令 ${oneLine(c)}` : undefined;
  },
  glob: (a) => {
    const p = argOf(a, 'pattern');
    return p !== undefined ? `查找文件 ${p}` : undefined;
  },
  grep: (a) => {
    const p = argOf(a, 'pattern');
    return p !== undefined ? `搜索 ${p}` : undefined;
  },
  browser_navigate: (a) => {
    const u = argOf(a, 'url');
    return u !== undefined ? `打开网页 ${u}` : undefined;
  },
  browser_click: (a) => {
    const r = argOf(a, 'ref');
    return r !== undefined ? `点击页面元素 ${r}` : '点击页面元素';
  },
  browser_type: (a) => {
    const t = argOf(a, 'text');
    return t !== undefined ? `页面输入 ${oneLine(t)}` : '在页面输入文本';
  },
  browser_snapshot: () => '读取页面快照',
  browser_screenshot: () => '页面截图',
  browser_close: () => '关闭浏览器',
  memory: (a) => {
    const op = argOf(a, 'operation');
    const target = argOf(a, 'target');
    if (op !== undefined) return `记忆操作 ${op}${target !== undefined ? `（${target}）` : ''}`;
    return '更新长期记忆';
  },
  skill: (a) => {
    const n = argOf(a, 'name');
    return n !== undefined ? `调用技能 ${n}` : '调用技能';
  },
  skill_author: (a) => {
    const n = argOf(a, 'name');
    return n !== undefined ? `编写技能 ${n}` : '编写技能';
  },
  run_script: (a) => {
    const s = argOf(a, 'script');
    return s !== undefined ? `运行脚本（${oneLine(s).length} 字符）` : '运行脚本';
  },
  subagent_fanout: () => '派发并行子任务',
};

/**
 * 工具 → 人类动词短语（P11-T5）。未知工具 / args 非 JSON / 必需参数缺失 → undefined，
 * 调用方回退到现状模板 `工具名(摘要)`（绝不抛错、绝不编造能力）。
 */
function toolActionPhrase(item: ToolItem): string | undefined {
  const build = TOOL_ACTIONS[item.tool];
  if (build === undefined) return undefined;
  return build(parseJsonObject(item.args));
}

/**
 * P3-D 耗时文案：秒 → `43s` / `1m35s`（对齐 grok "completed in 43s" 的耗时后缀）。
 * 数据为 UI 层近似计时（见 ProjectOptions.durations 注）。
 */
export function formatSubagentDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
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
  theme: Theme,
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  if (!expanded) {
    out.push({
      text: clipLine(`  ▸ 思考…(${trimmed.length} 字)`, cols),
      lineIndex,
      kind: 'reasoning',
      fg: theme.fg.reasoning,
    });
    return;
  }
  for (const line of splitLines(trimmed)) {
    out.push({ text: `  │ ${line}`, lineIndex, kind: 'reasoning', fg: theme.fg.reasoning });
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
function projectDiff(item: ToolItem, lineIndex: number, out: ProjectionLine[], theme: Theme): void {
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
  out.push({ text: `── ${filePath} ──`, lineIndex, kind: 'diff', fg: theme.fg.diffHunk });
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
      out.push({ text: `@@ -${oldLine + 1} +${newLine + 1} @@`, lineIndex, kind: 'diff', fg: theme.fg.diffHunk });
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
    if (row.kind === 'add') out.push({ text: `+ ${row.text}`, lineIndex, kind: 'diff', fg: theme.fg.diffAdd });
    else if (row.kind === 'remove') out.push({ text: `- ${row.text}`, lineIndex, kind: 'diff', fg: theme.fg.diffDel });
    else out.push({ text: row.text, lineIndex, kind: 'diff', fg: theme.fg.diffHunk });
    visible += 1;
  }
  if (rows.length > DIFF_MAX_LINES) {
    out.push({ text: `… 还有 ${rows.length - DIFF_MAX_LINES} 行`, lineIndex, kind: 'diff', fg: theme.fg.diffHunk });
  }
}

/**
 * 工具/子代理 item：调用行 + 结果行 +（展开态）diff 块与输出行。
 * 调用行整行取状态色（next 库每行单一前景色；旧壳版只着色 `> icon` 前缀，语义等价降级）。
 */
function projectTool(
  item: ToolItem,
  lineIndex: number,
  expanded: boolean,
  cols: number | undefined,
  out: ProjectionLine[],
  theme: Theme,
  opts: Pick<ProjectOptions, 'durations' | 'spinner' | 'rawMarkdown'> = {},
): void {
  const isSub = isSubagentTool(item.tool);
  // G-05 rawMarkdown（r）：调用行不做摘要提炼，直接展示 args 原文（映射见 ProjectOptions 注）
  const callSummary = opts.rawMarkdown === true ? rawArgsOf(item) : toolSummaryOf(item);
  // P11-T5：人类动词短语；rawMarkdown（r）/未知工具/缺参 = undefined → 回退现状模板
  const phrase = opts.rawMarkdown === true ? undefined : toolActionPhrase(item);
  const statusFg =
    item.status === 'pending' ? theme.fg.toolPending : item.status === 'ok' ? theme.fg.toolOk : theme.fg.toolFailed;
  if (isSub) {
    // P3-D：耗时命中才追加（UI 层近似计时，无命中不伪造）；运行中行用 spinner 前缀
    const duration = opts.durations?.get(item.callId);
    const durationSuffix = duration !== undefined ? `（${formatSubagentDuration(duration)}）` : '';
    if (item.status === 'pending') {
      out.push({
        text: clipLine(`${opts.spinner ?? '⏺'} Subagent "${subagentDescription(item)}" 运行中`, cols),
        lineIndex,
        kind: 'subagent',
        fg: statusFg,
      });
    } else {
      const state = item.status === 'ok' ? '完成' : '失败';
      out.push({
        text: clipLine(`⏺ Subagent "${subagentDescription(item)}" ${state}${durationSuffix}`, cols),
        lineIndex,
        kind: 'subagent',
        fg: statusFg,
      });
    }
  } else {
    out.push({
      text: clipLine(phrase !== undefined ? `⏺ ${phrase}` : `⏺ ${item.tool}(${callSummary})`, cols),
      lineIndex,
      kind: 'tool',
      fg: statusFg,
    });
    // P11-T5：参数 JSON 移入展开态（工具名保留；仅主行已被人类化时才需要，避免与回退行重复）
    if (expanded && phrase !== undefined) {
      out.push({
        text: clipLine(`  ⚙ ${item.tool}(${rawArgsOf(item)})`, cols),
        lineIndex,
        kind: 'tool',
        fg: theme.fg.toolResultDetail,
      });
    }
  }
  // T1：子会话只读入口提示（解析不到不显示；旧壳版还带 Ctrl+J/K 键位提示，键位归接线层）
  if (item.childSessionId !== undefined) {
    out.push({ text: `  ↳ 子会话 ${item.childSessionId}`, lineIndex, kind: 'subagent', fg: theme.fg.subagentDetail });
  }
  // 结果行：pending 无；失败原因首行始终可见
  let deferredOutput: string[] = [];
  if (item.status === 'failed') {
    const errLines = item.error !== undefined && item.error.length > 0 ? splitLines(item.error) : ['（无错误详情）'];
    out.push({ text: `  └ ✗ ${errLines[0] ?? ''}`, lineIndex, kind: 'tool-result', fg: theme.fg.toolResultFailed });
    if (expanded) {
      for (const line of errLines.slice(1)) {
        out.push({ text: `  │ ${line}`, lineIndex, kind: 'tool-result', fg: theme.fg.toolResultDetail });
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
        fg: theme.fg.toolResultOk,
      });
    } else {
      // 展开态：`  └ ✓` 头 + 输出逐行 `  │ `（输出行排在 diff 块之后，见下方 deferred 输出）
      out.push({ text: '  └ ✓', lineIndex, kind: 'tool-result', fg: theme.fg.toolResultOk });
      deferredOutput = lines;
    }
  }
  // 展开态：edit/write 的 diff 卡（DiffCard 的前缀字符近似）在结果行之后、输出之前
  if (expanded && (item.tool === 'edit' || item.tool === 'write')) {
    projectDiff(item, lineIndex, out, theme);
  }
  for (const line of deferredOutput) {
    out.push({ text: `  │ ${line}`, lineIndex, kind: 'tool-result', fg: theme.fg.toolResultDetail });
  }
}

/**
 * TranscriptItem[] → 逻辑文本行（纯函数；不做物理换行/物理裁剪，那由 Scrollback.wrapLine 负责）。
 * 每行 lineIndex 指回 items 下标，供交互定位；fg 为 24bit RGB（undefined = 默认色）。
 */
export function projectTranscript(items: readonly TranscriptItem[], opts: ProjectOptions = {}): ProjectionLine[] {
  const collapsed = opts.collapsed;
  // G-05 rawMarkdown（r）：原始视图不做超宽截断（clipLine 的 cols 输入置 undefined）
  const cols =
    opts.rawMarkdown === true
      ? undefined
      : opts.cols !== undefined && opts.cols > 0
        ? Math.floor(opts.cols)
        : undefined;
  const theme = opts.theme ?? DARK_THEME; // P4-2：缺省 dark = 现状默认色（零变化契约）
  // P11-T4：消息时间戳字段只从真实 ts 产出（formatClock 不可解析 → 空对象，不显示）
  const stamp = (ts: string | undefined): Pick<ProjectionLine, 'right' | 'rightFg'> => {
    const clock = formatClock(ts, opts.hour12);
    return clock === undefined ? {} : { right: clock, rightFg: theme.fg.system };
  };
  const out: ProjectionLine[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    // 覆盖标记：在集 = 与该 item 默认折叠态取反（默认折叠的 item 展开；默认展开的收起）
    const expanded = collapsed?.has(i) ?? false;
    switch (item.kind) {
      case 'user': {
        const lines = splitLines(item.text);
        out.push({ text: `❯ ${lines[0] ?? ''}`, lineIndex: i, kind: 'user', fg: theme.fg.user, ...stamp(item.ts) });
        for (let k = 1; k < lines.length; k += 1) {
          out.push({ text: lines[k] ?? '', lineIndex: i, kind: 'user', fg: theme.fg.user });
        }
        break;
      }
      case 'assistant': {
        const lines = splitLines(item.text);
        for (let k = 0; k < lines.length; k += 1) {
          out.push({
            text: lines[k] ?? '',
            lineIndex: i,
            kind: 'assistant',
            fg: theme.fg.assistant,
            // P11-T4：时间戳只挂首行（多行消息不在每行重复）
            ...(k === 0 ? stamp(item.ts) : {}),
          });
        }
        if (item.reasoning !== undefined) {
          projectReasoning(item.reasoning, i, expanded, cols, out, theme);
        }
        break;
      }
      case 'partial': {
        const lines = splitLines(item.text);
        for (let k = 0; k < lines.length; k += 1) {
          out.push({
            text: lines[k] ?? '',
            lineIndex: i,
            kind: 'assistant',
            fg: theme.fg.assistant,
            ...(k === 0 ? stamp(item.ts) : {}),
          });
        }
        out.push({
          text: `${EXPAND_HINT} ${reasonLine(item.stopReason, item.error)}`,
          lineIndex: i,
          kind: 'system',
          fg: theme.fg.systemWarn,
        });
        break;
      }
      case 'empty': {
        // 禁止空白气泡：无正文也必须给出 stopReason/error 的可读行
        out.push({
          text: `${EXPAND_HINT} ${reasonLine(item.stopReason, item.error)}`,
          lineIndex: i,
          kind: 'system',
          fg: theme.fg.systemError,
        });
        break;
      }
      case 'tool':
        projectTool(item, i, expanded, cols, out, theme, opts);
        break;
      case 'system':
      case 'status':
        // 逐行投影（与 user/assistant 分支同构）：多行文本（如 core /help 的 HELP_TEXT、
        // 命令输出的多行报告）必须展开为多条逻辑行，否则换行符会被当成可打印字符进网格。
        for (const line of splitLines(item.text)) {
          out.push({ text: line, lineIndex: i, kind: 'system', fg: theme.fg.system });
        }
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
