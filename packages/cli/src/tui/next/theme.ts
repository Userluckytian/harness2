// theme.ts — P4-2 主题系统（命名色板 + 注册表；headless 纯数据，零依赖）。
//
// 职责：把 next 渲染层的逐行/逐格前景色从散落常量（projection.FG、scrollback.SELECTION_FG、
// composer.DEFAULT_*_FG）收敛为**命名主题**。cell-buffer 只有 fg 通道（无 bg/反色位），
// 主题只产出 24bit RGB 前景色；背景适配口径由 Theme.dark 登记（dark=深底浅字、light=浅底深字，
// bg 不进数据面——如实登记，非全真 light 渲染）。
//
// 零变化契约（钉死）：`dark` 主题逐值对齐 2026-09-13 前的既有常量——切换主题往返 dark 必须
// 视觉零变化（既有快照/fg 断言不破）。`light` 为深字浅底自定合理值（GitHub-light 色系变体；
// 非 grok GrokDay 抄本，grok 手册只列槽位不给值，如实登记）。
//
// 与 grok 的差异（如实登记）：grok 5 主题 + auto（系统外观跟随）+ config.toml 持久化 +
// `/theme` 交互式 picker（实时预览）；本层 2 主题、会话内存级不持久化、`/theme` 命令行式。

/** 语义前景色槽位（24bit RGB；undefined = 终端默认色）。状态变体槽（toolPending 等）
 *  是现状「状态色」的显式化——projection 按工具状态从这些槽位取值，dark 逐值等于旧 FG。 */
export interface ThemeFg {
  /** 用户消息行（dark = 终端默认色） */
  user?: number;
  /** 助手正文行（dark = 终端默认色） */
  assistant?: number;
  /** 工具/子代理调用行 pending（运行中） */
  toolPending: number;
  /** 工具/子代理调用行 ok */
  toolOk: number;
  /** 工具/子代理调用行 failed */
  toolFailed: number;
  /** 工具结果行 `└ ✓` */
  toolResultOk: number;
  /** 工具结果行 `└ ✗`（失败原因首行） */
  toolResultFailed: number;
  /** 工具结果续行/输出行 `│` */
  toolResultDetail: number;
  /** 推理块（▸ 思考… / │ 续行） */
  reasoning: number;
  /** 子代理入口行 `↳ 子会话 …` */
  subagentDetail: number;
  /** 常规 system/status 行 */
  system: number;
  /** partial 中断提示行 */
  systemWarn: number;
  /** empty/异常行 */
  systemError: number;
  /** diff 增行 `+` */
  diffAdd: number;
  /** diff 删行 `-` */
  diffDel: number;
  /** diff 文件头/@@ hunk/context 行 */
  diffHunk: number;
  /** 文本选中高亮（fg 换色方案，P4-1） */
  selection: number;
  /** composer 光标格高亮（diff-presenter 无反色位的近似） */
  cursor: number;
  /** active 候选/浮层高亮 */
  active: number;
  /** spinner 前景（预留槽：状态行/composer 为单 fg 行绘制，暂未逐段接线，如实登记） */
  spinner?: number;
  /** /search 命中行高亮（P4-2 新增） */
  searchHit: number;
}

export interface Theme {
  /** 主题名（注册表键，小写） */
  readonly name: string;
  /** 背景适配口径：true = 深底（默认终端假定）、false = 浅底适配（bg 不进数据面，仅登记） */
  readonly dark: boolean;
  readonly fg: ThemeFg;
}

/** dark 主题 = 现状默认色逐值对齐（零变化契约，见文件头） */
export const DARK_THEME: Theme = {
  name: 'dark',
  dark: true,
  fg: {
    user: undefined,
    assistant: undefined,
    toolPending: 0xd29922,
    toolOk: 0x3fb950,
    toolFailed: 0xf85149,
    toolResultOk: 0x3fb950,
    toolResultFailed: 0xf85149,
    toolResultDetail: 0x8b949e,
    reasoning: 0x8b949e,
    subagentDetail: 0x8b949e,
    system: 0x8b949e,
    systemWarn: 0xd29922,
    systemError: 0xf85149,
    diffAdd: 0x3fb950,
    diffDel: 0xf85149,
    diffHunk: 0x8b949e,
    selection: 0x22d3ee,
    cursor: 0x00ff87,
    active: 0x00ff87,
    spinner: undefined,
    searchHit: 0xe3b341, // 亮金黄：深底下对默认/灰色正文醒目（自定值，新槽无现状对象）
  },
};

/** light 主题 = 深字浅底适配（自定合理值，GitHub-light 色系变体；bg 假定浅色，仅登记口径） */
export const LIGHT_THEME: Theme = {
  name: 'light',
  dark: false,
  fg: {
    user: undefined,
    assistant: undefined,
    toolPending: 0x9a6700,
    toolOk: 0x1a7f37,
    toolFailed: 0xcf222e,
    toolResultOk: 0x1a7f37,
    toolResultFailed: 0xcf222e,
    toolResultDetail: 0x57606a,
    reasoning: 0x57606a,
    subagentDetail: 0x57606a,
    system: 0x57606a,
    systemWarn: 0x9a6700,
    systemError: 0xcf222e,
    diffAdd: 0x1a7f37,
    diffDel: 0xcf222e,
    diffHunk: 0x57606a,
    selection: 0x0969da,
    cursor: 0x8250df,
    active: 0x0969da,
    spinner: undefined,
    searchHit: 0xbc4c00,
  },
};

/** 注册表（键 = 主题名小写） */
export const THEMES: Readonly<Record<string, Theme>> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
};

/** 缺省主题（= dark = 现状视觉，零变化契约）；绘制层 `state.theme ?? DEFAULT_THEME` 的兜底值 */
export const DEFAULT_THEME: Theme = DARK_THEME;

/** 缺省主题名 */
export const DEFAULT_THEME_NAME = 'dark';

/** 按名取主题：大小写不敏感（grok 同语义）；未知名/空名返回 undefined */
export function getTheme(name: string): Theme | undefined {
  return THEMES[name.trim().toLowerCase()];
}

/** 可用主题名（注册表键序） */
export function themeNames(): string[] {
  return Object.keys(THEMES);
}
