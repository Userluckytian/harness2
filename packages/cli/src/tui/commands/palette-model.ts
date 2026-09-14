// palette-model.ts — G-31 / G-50～G-53 命令面板纯逻辑（P3-A，headless，零渲染依赖）。
//
// 规格依据：docs/refs/refs-grok-build.md G-31（Ctrl+P / ? 打开 palette）、G-50（命令来源
// 分裂——shell builtins 与 pager builtins 合并进同一个菜单，模糊匹配）、G-51（输入弹菜单、
// 模糊筛选、回车直执行）、G-53（菜单 badge 区分来源）。上游实现对照：refs/grok-build
// xai-grok-pager/src/views/modal.rs 的 default_palette_entries / filter_palette_entries 与
// views/picker.rs 的 handle_picker_input（CommandPalette 的 PickerConfig：esc_clears_query、
// section header 不可选、↑↓ 跳过 header 且端点钳制不回绕）。
//
// 与上游的对应关系（逐条）：
//   - 上游 PaletteEntry{label, shortcut, command} ↔ 本层 PaletteEntry{name, summary,
//     source/badge}：搜索口径同为「展示名或命令词包含查询串」（小写子串，非编辑距离）；
//     上游 label≈本层 summary、上游 shortcut≈本层 /name。
//   - 上游 SectionHeader（不可选、组内有命中才保留）↔ 本层 kind:'header' 行（group 分组）。
//   - 上游按 screen_mode 过滤掉不支持的命令（retain）↔ 本层按派工要求**保留并打模式
//     badge**（「仅 fullscreen」/「仅 minimal」，badge 由 commandSupportInMode 派生）——
//     差异登记：harness2 选择可见+badge（执行仍会被壳层 G-03 门控拒绝并给指向替代），
//     上游为隐藏。以派工文本为准。
//   - 上游 Enter → PaletteCommand::SlashCommand → Action::SendSlashCommandPreservingDraft
//     （关面板、草稿原样保留、命令走正常路由）↔ 本层 effect {kind:'execute', name}——
//     面板绝不改写 composer 草稿，宿主把 /{name} 交给自己的命令分发。
//   - Esc：上游 picker 内部有「先清查询再关闭」两级；harness2 按派工「Esc 走 P2
//     esc-machine 语义，不开特例」——本模块**没有 Esc 分支**（类型层面不提供），面板
//     打开时作为浮层计入 esc-machine 输入的 cardDepth（见 paletteCardDepth），Esc 经
//     reduceEsc 裁决出 'exit-card' 后由宿主关闭。上游 esc_clears_query 细节登记为差异。
//   - G-52（skill 声明 user-invocable 自动出现在菜单）：harness2 skills 不是命令，未接——
//     P7 归存；G-53 的 /plugin-name:login 冲突限定形同（无插件命令命名空间）——P7。
//
// 命令来源（G-50「合并进同一个菜单」，禁止第三份清单）：
//   - core 条目：唯一来源 describeCapabilities().commands（shellOnly → badge 'shell'，
//     其余 → badge 'core'）；
//   - 壳条目：宿主从壳自己的命令表派生传入（如 next 的 NEXT_COMMANDS），本模块只定义
//     形状（ShellPaletteEntry），不持有壳命令清单。
import { describeCapabilities } from '@harness2/core';
import type { CoreCommandMeta } from '@harness2/core';
import { commandSupportInMode, type ModeCommandSupport } from '../render/minimal.js';
import type { RenderMode } from '../render/mode.js';

/** 命令来源 badge（G-53：菜单打 badge 区分来源） */
export type PaletteSource = 'core' | 'shell';

/** 面板条目（core 与壳条目的统一形态） */
export interface PaletteEntry {
  /** 命令 id（不含 /，小写规范形） */
  readonly name: string;
  /** 一句话描述（≈上游 label；搜索匹配对象之一） */
  readonly summary: string;
  /** 来源（badge 文案由 paletteBadge 派生） */
  readonly source: PaletteSource;
  /** 参数格式说明（可省；仅展示） */
  readonly argsSpec?: string;
  /** 分组（面板组头行文案，如 '会话'/'模式'） */
  readonly group: string;
  /** 模式限定形态（P2 G-03 谓词结果；面板据此打「仅 xx」badge） */
  readonly modeSupport: ModeCommandSupport;
}

/** 壳侧补充条目形状（宿主从壳自己的命令表派生传入，本模块不持清单） */
export interface ShellPaletteEntry {
  readonly name: string;
  readonly summary: string;
  /** 分组（缺省归「通用」） */
  readonly group?: string;
}

/** 构建面板条目：core（describeCapabilities）+ 壳条目，按当前渲染模式派生模式限定形态 */
export function buildPaletteEntries(
  mode: RenderMode,
  shellEntries: ReadonlyArray<ShellPaletteEntry> = [],
): PaletteEntry[] {
  const core: PaletteEntry[] = describeCapabilities().commands.map((meta: CoreCommandMeta) => ({
    name: meta.id,
    summary: meta.summary,
    source: meta.shellOnly === true ? 'shell' : 'core',
    ...(meta.argsSpec !== undefined ? { argsSpec: meta.argsSpec } : {}),
    group: meta.group,
    modeSupport: commandSupportInMode(meta.id, mode),
  }));
  const shell: PaletteEntry[] = shellEntries.map((e) => ({
    name: e.name,
    summary: e.summary,
    source: 'shell' as const,
    group: e.group ?? '通用',
    modeSupport: commandSupportInMode(e.name, mode),
  }));
  return [...core, ...shell];
}

/** 条目 badge 文案：模式限定优先（仅 fullscreen / 仅 minimal），否则来源 core/shell */
export function paletteBadge(entry: PaletteEntry): string {
  if (entry.modeSupport === 'unavailable-fullscreen-only') return '仅 fullscreen';
  if (entry.modeSupport === 'unavailable-minimal-only') return '仅 minimal';
  return entry.source;
}

/** 面板行：组头（不可选，G-50 分组呈现）或命令条目 */
export type PaletteRow =
  { readonly kind: 'header'; readonly label: string } | { readonly kind: 'command'; readonly entry: PaletteEntry };

/** 搜索匹配（上游 filter_palette_entries 同口径：展示名或命令词的小写子串包含） */
function entryMatches(entry: PaletteEntry, queryLower: string): boolean {
  return `/${entry.name}`.toLowerCase().includes(queryLower) || entry.summary.toLowerCase().includes(queryLower);
}

/**
 * 过滤面板条目 → 渲染行（组头 + 命令行）。上游语义逐条对齐：
 * - 空查询 = 全部条目（按传入顺序分组）；
 * - 子串包含匹配（label/summary），大小写不敏感；
 * - 组头不可选，且**组内至少一条命中才保留组头**（上游 pending_header.take 语义：
 *   组头惰性发射——本组首条命中时插入，整组无命中则组头不出现）；
 * - 组头的出现顺序 = 条目首遇顺序（调用方排好 core→壳的顺序即得稳定分组）。
 */
export function filterPaletteRows(query: string, entries: ReadonlyArray<PaletteEntry>): PaletteRow[] {
  const q = query.trim().toLowerCase();
  const out: PaletteRow[] = [];
  let pendingGroup: string | null = null;
  let headerEmitted = false;
  for (const entry of entries) {
    if (entry.group !== pendingGroup) {
      pendingGroup = entry.group;
      headerEmitted = false;
    }
    if (q.length === 0 || entryMatches(entry, q)) {
      if (!headerEmitted && pendingGroup !== null) {
        out.push({ kind: 'header', label: pendingGroup });
        headerEmitted = true;
      }
      out.push({ kind: 'command', entry });
    }
  }
  return out;
}

/** 面板状态（纯数据；active 为 rows 下标，恒指向可选行，无可选行 = -1） */
export interface PaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly active: number;
}

/** 关闭态（唯一默认值） */
export function paletteClosed(): PaletteState {
  return { open: false, query: '', active: -1 };
}

function isSelectable(row: PaletteRow | undefined): boolean {
  return row !== undefined && row.kind === 'command';
}

/** 从 start 起向后找第一个可选行，找不到再向前兜底（开面板/换查询时的归一） */
function firstSelectable(rows: ReadonlyArray<PaletteRow>, start: number): number {
  const s = Math.max(0, Math.min(Math.floor(start), rows.length - 1));
  for (let i = s; i < rows.length; i += 1) {
    if (isSelectable(rows[i])) return i;
  }
  for (let i = s; i >= 0; i -= 1) {
    if (isSelectable(rows[i])) return i;
  }
  return -1;
}

/** 打开面板（空查询，active 归一到第一个可选行；组头在最前则跳过） */
export function paletteOpenState(rows: ReadonlyArray<PaletteRow>): PaletteState {
  return { open: true, query: '', active: firstSelectable(rows, 0) };
}

/** 输入查询（整体替换——中文/粘贴经输入层整串到达；active 重置到首个可选行） */
export function paletteSetQuery(state: PaletteState, query: string, rows: ReadonlyArray<PaletteRow>): PaletteState {
  return { open: true, query, active: firstSelectable(rows, 0) };
}

/** 退格：按码点删除末字符（代理对安全），查询空则原样返回 */
export function paletteBackspace(state: PaletteState, rows: ReadonlyArray<PaletteRow>): PaletteState {
  if (state.query.length === 0) return state;
  const chars = [...state.query];
  return paletteSetQuery(state, chars.slice(0, -1).join(''), rows);
}

/**
 * ↑↓ 移动（上游 handle_picker_input Down/Up 分支逐条对齐）：
 * 逐步 ±1、跳过组头、到首/末可选行**钳制不回绕**（上游 selected+1.min / saturating_sub）；
 * 当前无有效选中时按移动方向落到首/末可选行。
 */
export function paletteMove(state: PaletteState, rows: ReadonlyArray<PaletteRow>, delta: 1 | -1): PaletteState {
  if (rows.length === 0) return state;
  const cur = state.active;
  if (cur < 0 || cur >= rows.length || !isSelectable(rows[cur])) {
    return { ...state, active: firstSelectable(rows, delta === 1 ? 0 : rows.length - 1) };
  }
  let j = cur + delta;
  while (j >= 0 && j < rows.length && !isSelectable(rows[j])) j += delta;
  if (j < 0 || j >= rows.length) return state; // 端点钳制（不回绕）
  return { ...state, active: j };
}

/** Enter 产生的副作用：执行一条命令（宿主把 /{name} 交给自己的命令分发）或无动作 */
export type PaletteEffect = { readonly kind: 'execute'; readonly name: string };

export interface PaletteEnterResult {
  /** 新状态：命中命令 → 关闭（上游先 active_modal = None 再 SendSlashCommand）；否则原样 */
  readonly state: PaletteState;
  /** 命令执行效果；null = 无（组头/空表 Enter 是 no-op，面板不关——上游 Changed） */
  readonly effect: PaletteEffect | null;
}

/** Enter：选中命令 → 关面板并产出执行效果；组头/空表 → no-op（不关面板） */
export function paletteEnter(state: PaletteState, rows: ReadonlyArray<PaletteRow>): PaletteEnterResult {
  const row = rows[state.active];
  if (state.active < 0 || row === undefined || row.kind !== 'command') {
    return { state, effect: null };
  }
  return { state: paletteClosed(), effect: { kind: 'execute', name: row.entry.name } };
}

/**
 * 面板在 esc-machine 输入里的 cardDepth 贡献（打开 = 1 层浮层）。
 * 宿主把该值并入 reduceEsc 的 cardDepth：Esc → 'exit-card' → 宿主关面板（G-20 逐级
 * 退出语义自然覆盖面板，本模块没有、也不允许有 Esc 特例分支）。
 */
export function paletteCardDepth(state: PaletteState): number {
  return state.open ? 1 : 0;
}

/** 面板执行 → 提交行（宿主 submitCommand 的入参；等价用户输入 /name） */
export function paletteCommandLine(name: string): string {
  return `/${name}`;
}
