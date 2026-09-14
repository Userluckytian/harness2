// render.ts — 状态行渲染结构（G-43 builtin 段 / G-44 省略规则 / G-47 输出限额，纯逻辑）。
//
// 规格依据：refs-grok-build.md G-43/G-44/G-47 与上游 25-status-line.md：
//  - G-43：builtin items 渲染——cwd（目录**基名**）、model（显示名）、context（窗口占用
//    百分比；达到 auto-compact 阈值或无阈值时的 80% 用琥珀色标注）、cost（低于 $0.005
//    隐藏，避免误导性 $0.00）、turn-timer（运行中回合的已用时，从 1 秒起）、session-name
//    （设置了才显示）。
//  - G-44：省略规则——**40 列以下省略目录与会话名，30 列以下省略模型名**（refs 表口径：
//    按「行可用列数」判定省略，不是按条目文本长度）；条目自身超长用 … 截断（上游：
//    long ones are elided with …）。
//  - G-47：command 输出限额——最多 5 行、每行 1024 字符（转义序列计入）、stdout 超
//    64KiB 截断并停脚本（runner.ts 执行）、ANSI 颜色保留、光标移动/擦除/回车覆盖类转义
//    丢弃；空输出 = **收掉整行**而不是回退 builtin（上游明文）。
// 数据源（BuiltinStatusSource）由装配层从真实会话状态喂入；字段缺席 = 该段省略——
// **绝不显示伪造数值**（上游：Fields Grok cannot source are omitted）。

import { STATUS_LINE_MAX_LINE_CHARS, STATUS_LINE_MAX_LINES } from './config.js';

/** 段间分隔符（上游示例：`grok-shell-status-line │ Grok 4.5 │ 12% ctx`） */
export const STATUS_LINE_SEPARATOR = ' │ ';

/** context 段的琥珀标注：无 auto-compact 阈值时的缺省阈值（上游：80% when the agent reports none） */
export const CONTEXT_AMBER_DEFAULT_THRESHOLD = 80;

/** builtin 段数据源（全部可选；缺省 = 该段省略，不造假） */
export interface BuiltinStatusSource {
  /** 当前目录（渲染时取基名） */
  readonly cwd?: string;
  /** 模型显示名（= runtime provider 名，与 assistant/message.model 同标识） */
  readonly model?: string;
  /** 窗口占用 0..1（core getContextUsage；undefined = 未知 → 段省略） */
  readonly usage?: number;
  /** auto-compact 阈值 0..100（core 未报告 = undefined → 用 80 判定琥珀标注） */
  readonly autoCompactThresholdPercent?: number;
  /** 会话费用（undefined = 未知 → 段省略；绝不显示 $0.00 造值） */
  readonly costUsd?: number;
  /** 运行中回合起始时刻（Unix ms）；回合间缺席 → turn-timer 段省略 */
  readonly turnStartedAtMs?: number;
  /** 会话名（未设置 → 段省略） */
  readonly sessionName?: string;
}

export interface BuiltinRenderOptions {
  /** 行可用列数（G-44 省略判定的基准；缺省 = 不限宽） */
  readonly cols?: number;
  /** builtin 段清单（G-43；缺省 = config.ts 的 DEFAULT_STATUS_LINE_ITEMS） */
  readonly items?: readonly string[];
  /** 渲染时刻（turn-timer 用；注入时钟，测试可钉死） */
  readonly nowMs?: number;
}

/** 目录基名（G-43 cwd 段；末尾分隔符容错；根目录原样） */
export function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** 费用文案（G-43：低于 $0.005 隐藏——返回 null 表示隐藏；两位小数起，避免假精度） */
export function formatCost(costUsd: number): string | null {
  if (!(costUsd >= 0.005)) return null;
  return `$${costUsd.toFixed(2)}`;
}

/** turn 计时文案（G-43：从 1 秒起显示；不足 1 秒 = null 表示省略。格式 MM:SS / H:MM:SS） */
export function formatTurnTimer(elapsedMs: number): string | null {
  if (elapsedMs < 1000) return null;
  const totalSec = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 单段超长省略（… 占一个字符位；宽度按字符数口径——与 cell-buffer 的列宽粒度约束一致） */
export function elide(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** G-44 省略判定：目录/会话名 < 40 列省略；模型名 < 30 列省略 */
export function itemOmittedByWidth(item: string, cols: number | undefined): boolean {
  if (cols === undefined) return false;
  if (item === 'cwd' || item === 'session-name') return cols < 40;
  if (item === 'model') return cols < 30;
  return false;
}

/**
 * builtin 状态行渲染（G-43/G-44 纯函数）：
 *  - 段序 = items 顺序（上游：Items appear in the order you list them）；
 *  - 数据缺席/条件未满足的段省略（cost < $0.005、turn < 1s、未设 session-name、未知 usage）；
 *  - G-44 宽度省略（cols < 40 砍 cwd/session-name、< 30 砍 model）先于文本截断；
 *  - 剩余宽度内单段 … 截断；
 *  - 无任何可见段 → null（整行省略——不渲染空壳）。
 * 琥珀标注不进纯文本：context 段命中阈值时返回文本带统一前缀由装配层着色？
 * 不——本层输出纯文本行；命中阈值信息通过 contextAmber 单独返回，装配层按需上色。
 */
export function renderBuiltinStatusLine(
  source: BuiltinStatusSource,
  opts: BuiltinRenderOptions = {},
): { line: string | null; contextAmber: boolean } {
  const items = opts.items ?? ['cwd', 'model', 'context'];
  const cols = opts.cols;
  const nowMs = opts.nowMs ?? Date.now();
  const segments: string[] = [];
  let contextAmber = false;

  for (const item of items) {
    if (itemOmittedByWidth(item, cols)) continue; // G-44 宽度省略
    let text: string | null = null;
    switch (item) {
      case 'cwd':
        text = source.cwd !== undefined && source.cwd.length > 0 ? cwdBasename(source.cwd) : null;
        break;
      case 'model':
        text = source.model !== undefined && source.model.length > 0 ? source.model : null;
        break;
      case 'context': {
        if (source.usage === undefined || !Number.isFinite(source.usage)) break; // 未知 → 省略
        const pct = Math.min(100, Math.max(0, Math.round(source.usage * 100)));
        const threshold = source.autoCompactThresholdPercent ?? CONTEXT_AMBER_DEFAULT_THRESHOLD;
        contextAmber = pct >= threshold;
        text = `${pct}% ctx`;
        break;
      }
      case 'cost':
        if (source.costUsd === undefined) break; // 未知 ≠ 0：省略而非 $0.00
        text = formatCost(source.costUsd);
        break;
      case 'turn-timer':
        if (source.turnStartedAtMs === undefined) break; // 回合间省略
        text = formatTurnTimer(nowMs - source.turnStartedAtMs);
        break;
      case 'session-name':
        text = source.sessionName !== undefined && source.sessionName.length > 0 ? source.sessionName : null;
        break;
      default:
        break; // 未知条目不渲染（config 层已过滤）
    }
    if (text === null || text.length === 0) continue;
    segments.push(text);
  }

  if (segments.length === 0) return { line: null, contextAmber };
  // 宽度预算：段文本 + 分隔符；超预算的**末段之后**内容按 … 截断（先整行再逐段，保段序）
  let line = segments.join(STATUS_LINE_SEPARATOR);
  if (cols !== undefined && line.length > cols) {
    // 逐段收缩：放不下的段以 … 截断收尾，其后整段丢弃（仍保段序）
    const budget = Math.max(0, cols);
    const kept: string[] = [];
    let used = 0;
    const sepLen = STATUS_LINE_SEPARATOR.length;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i] ?? '';
      const cost = seg.length + (i > 0 ? sepLen : 0);
      if (used + cost > budget && kept.length > 0) {
        const remain = budget - used - sepLen - 1; // … 占 1
        if (remain > 0) kept.push(elide(seg, remain));
        break;
      }
      used += cost;
      kept.push(seg);
    }
    line = kept.join(STATUS_LINE_SEPARATOR);
  }
  return { line, contextAmber };
}

/** 每侧留白（G-46 padding；0..16 已在 config 钳制，这里只负责拼装） */
export function applyPadding(line: string, padding: number): string {
  const pad = ' '.repeat(Math.max(0, Math.min(16, padding)));
  return `${pad}${line}${pad}`;
}

// —— G-47 command 输出限额（纯文本整形；真子进程在 runner.ts）───────────────────

/**
 * 非 SGR 转义过滤（G-47：ANSI 颜色保留，其余丢弃）：
 *  - 保留 SGR（CSI … m）——颜色是状态行脚本的主用例；
 *  - 丢弃其余 CSI（光标移动 / 擦除等）、\r（回车覆盖）、OSC（终止符 BEL 或 ST）；
 *  - 精度边界（登记）：OSC 8 超链接按上游应支持 http/https/mailto，本层暂统一剥离、
 *    文本保留——超链接落地下放接线批（cell-buffer 仅有前景通道，P3-C 不扩渲染器）。
 */
export function stripNonColorEscapes(text: string): string {
  return (
    text
      // OSC：ESC ] … (BEL | ESC \) —— 先剥离，防止其中的 CSI 形状误伤
      //（ANSI 转义字节按定义就是控制字符——no-control-regex 在此为有意使用）
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI：完整序列匹配（参数字节 + 中间字节 + 终止字节），SGR（终止 m）保留
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, (seq) => (seq.endsWith('m') ? seq : ''))
      .replace(/\r/g, '')
  );
}

/**
 * command stdout → 行数组（G-47 限额，纯函数）：
 *  - 按行拆分，去掉末尾空行；每行先过 stripNonColorEscapes；
 *  - 每行截到 1024 字符（**含转义序列**——上游：counting the ANSI escapes themselves，
 *    所以先截断后过滤都会失真：先过滤非颜色转义再按字符截断，SGR 保留计入长度）；
 *  - 最多 5 行，**从底部丢弃超出部分**（上游：dropping the surplus from the bottom）；
 *  - 空输出 → lines = []（装配层据此收掉整行，不回退 builtin）。
 */
export function shapeCommandOutput(
  stdout: string,
  opts: { maxLines?: number; maxLineChars?: number } = {},
): readonly string[] {
  const maxLines = opts.maxLines ?? STATUS_LINE_MAX_LINES;
  const maxLineChars = opts.maxLineChars ?? STATUS_LINE_MAX_LINE_CHARS;
  const rawLines = stdout.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const shaped: string[] = [];
  for (const raw of rawLines) {
    if (shaped.length >= maxLines) break; // 底部多余行直接丢弃
    const cleaned = stripNonColorEscapes(raw);
    shaped.push(cleaned.length > maxLineChars ? cleaned.slice(0, maxLineChars) : cleaned);
  }
  return shaped;
}
