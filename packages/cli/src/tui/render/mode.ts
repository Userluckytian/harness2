// mode.ts — G-01/G-02 渲染模式状态机（fullscreen / minimal，进程内切换不重启）。
//
// 职责（本层只做纯逻辑，零旧壳 / 零终端 IO；接线在第三批）：
// - RenderMode 两态：fullscreen（默认，接管屏幕 / alt-screen）与 minimal（终端原生
//   scrollback，不接管屏幕）——两态各自的完整 UI 形态见 minimal.ts 的契约与本目录
//   regions.ts 的八区域模型（G-04）。
// - 进程内切换：switchRenderMode 是纯 reducer——同一进程内改状态、发 mode-switched
//   事件，事件上 restartRequired 恒为 false（G-02「当场切换不重启」的类型化钉死；
//   测试断言事件流里不存在任何重启语义）。切换不重建 scrollback / 会话等运行时状态，
//   那是装配层（第三批）按事件去换壳的事，本层不持有它们。
// - 配置 [ui] screen_mode：parseScreenModeConfig / resolveInitialRenderMode 读
//   { ui: { screen_mode: 'fullscreen' | 'minimal' } } 形状的已合并配置对象。
//   core schema（packages/core/src/config/schema.ts）已加性落地 ui 顶层段（P2-C：
//   KNOWN_TOP_KEYS 含 ui；screen_mode 只认 fullscreen | minimal，与本模块 RENDER_MODES
//   同域）——本模块钉死的形状与校验即 schema 对齐后的消费端，零改动接入。
// - GROK_SCREEN_MODE_SWITCH=exec：识别为「重执行」变体（切换时退出当前进程、以目标
//   模式重新 exec 自身）。本阶段只做识别与语义登记，真正的重执行实现【显式下放 P3】
//   ——Windows ConPTY 下进程重执行涉及控制台句柄交接，风险真实，不冒险。识别结果
//   通过 ScreenModeSwitchStrategy 暴露给装配层，装配层见到 'exec' 时应停用进程内
//   切换路径（当前没有任何调用方，见 P3 登记）。
//
// 斜杠命令映射（G-02 / G-75）：/minimal → minimal；/fullscreen 与缩写 /full → fullscreen。
/** 渲染模式：fullscreen（默认，接管屏幕）| minimal（原生 scrollback，不接管）——G-01 */
export type RenderMode = 'fullscreen' | 'minimal';

/** 缺省渲染模式（G-01：fullscreen 默认接管屏幕） */
export const DEFAULT_RENDER_MODE: RenderMode = 'fullscreen';

/** 合法模式值（配置校验用） */
export const RENDER_MODES: readonly RenderMode[] = ['fullscreen', 'minimal'];

/** 配置路径（与 refs-grok-build.md G-02 的 TOML 记法一致） */
export const SCREEN_MODE_CONFIG_PATH = 'ui.screen_mode';

/** 切换策略环境变量名（G-02） */
export const SCREEN_MODE_SWITCH_ENV = 'GROK_SCREEN_MODE_SWITCH';

/**
 * 切换策略：inprocess = 进程内切（默认，G-02 主语义）；exec = 重执行变体
 * （GROK_SCREEN_MODE_SWITCH=exec；实现下放 P3，见文件头登记）。
 */
export type ScreenModeSwitchStrategy = 'inprocess' | 'exec';

/**
 * 读取切换策略：仅 'exec'（大小写不敏感、首尾空白容忍）识别为重执行变体；
 * 其余（未设 / 'inprocess' / 未知值）一律 inprocess——未知值不报错（环境变量是
 * 面向调试者的开关，宽松降级比硬失败友好；语义登记在注释而非运行时告警）。
 */
export function parseScreenModeSwitchEnv(raw: string | undefined): ScreenModeSwitchStrategy {
  return raw !== undefined && raw.trim().toLowerCase() === 'exec' ? 'exec' : 'inprocess';
}

/** 切换原因：斜杠命令（/minimal /fullscreen /full）或配置初值应用 */
export type RenderModeSwitchReason = 'slash-command' | 'config';

/**
 * 模式切换事件（append-only 事件流的单元）。
 * restartRequired 类型层钉死 false：G-02 的「不重启」不是约定俗成而是类型契约——
 * 任何人想在事件里塞重启语义，编译期就过不去。exec 重执行变体不走本状态机
 * （装配层见到 'exec' 策略时应整体改道，P3 落地）。
 */
export interface RenderModeSwitchedEvent {
  readonly type: 'mode-switched';
  readonly from: RenderMode;
  readonly to: RenderMode;
  readonly reason: RenderModeSwitchReason;
  readonly restartRequired: false;
}

/** 渲染模式状态（纯数据；events 为 append-only 事件日志，切换序号单调递增） */
export interface RenderModeState {
  readonly mode: RenderMode;
  /** 自启动以来发生的模式切换次数（同模式重复切换不计，见 switchRenderMode） */
  readonly switchCount: number;
  readonly events: readonly RenderModeSwitchedEvent[];
}

/** 初始状态（缺省 fullscreen；配置显式给了 minimal 由调用方传入） */
export function createRenderModeState(mode: RenderMode = DEFAULT_RENDER_MODE): RenderModeState {
  return { mode, switchCount: 0, events: [] };
}

export interface RenderModeSwitchResult {
  /** 新状态；同模式空切换时返回原引用（幂等，调用方可 === 判定跳过重渲染） */
  readonly state: RenderModeState;
  /** 实际发生的切换事件；同模式空切换为 null */
  readonly event: RenderModeSwitchedEvent | null;
}

/**
 * 切换到目标模式（纯 reducer，不触碰任何进程级资源）。
 * 同模式切换是空操作（/full 在 fullscreen 下重复执行不应产生事件/触发重绘）；
 * 异模式切换追加事件并递增 switchCount。
 */
export function switchRenderMode(
  state: RenderModeState,
  to: RenderMode,
  reason: RenderModeSwitchReason,
): RenderModeSwitchResult {
  if (to === state.mode) return { state, event: null };
  const event: RenderModeSwitchedEvent = {
    type: 'mode-switched',
    from: state.mode,
    to,
    reason,
    restartRequired: false,
  };
  return {
    state: { mode: to, switchCount: state.switchCount + 1, events: [...state.events, event] },
    event,
  };
}

/**
 * 斜杠命令名 → 目标模式（G-02/G-75）。只认 'minimal' / 'fullscreen' / 'full'
 * （'full' 是 grok 的常用缩写，与全称等价）；前导 '/' 容忍，其余（含未知命令）返回
 * null——模式映射不负责判定命令是否存在，那是命令分发层的职责。
 */
export function renderModeForCommand(name: string): RenderMode | null {
  const bare = name.startsWith('/') ? name.slice(1) : name;
  if (bare === 'minimal') return 'minimal';
  if (bare === 'fullscreen' || bare === 'full') return 'fullscreen';
  return null;
}

export interface ScreenModeConfigResult {
  /** 配置里的合法模式；未配置或非法值均为 null（非法值看 warning） */
  readonly mode: RenderMode | null;
  /** 非法值时的一行告警（风格对齐 core parseConfig 的 warnings）；合法/未配置为 null */
  readonly warning: string | null;
}

/**
 * 校验 [ui] screen_mode 的**原始值**（已合并配置对象里 ui.screen_mode 的取值）。
 * 只接受 'fullscreen' | 'minimal' 字符串；undefined = 未配置（无告警）；
 * 其余类型/值 → warning（回退 fullscreen 由 resolveInitialRenderMode 兜底）。
 */
export function parseScreenModeConfig(raw: unknown): ScreenModeConfigResult {
  if (raw === undefined) return { mode: null, warning: null };
  if (typeof raw === 'string' && (RENDER_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as RenderMode, warning: null };
  }
  const shown = typeof raw === 'string' ? `"${raw}"` : String(raw);
  return { mode: null, warning: `config.${SCREEN_MODE_CONFIG_PATH}: 未知值 ${shown}，回退 fullscreen` };
}

/** 配置对象里读取 screen_mode 的形状（core 落地 ui 段时的目标形状，见文件头登记） */
export interface UiScreenModeSection {
  ui?: { screen_mode?: unknown };
}

/**
 * 从已合并配置对象解析初始模式：合法值生效；未配置 → fullscreen；
 * 非法值 → fullscreen + 告警。返回 warning 供装配层走既有告警通道。
 */
export function resolveInitialRenderMode(config: UiScreenModeSection | undefined): {
  mode: RenderMode;
  warning: string | null;
} {
  const raw = config?.ui?.screen_mode;
  const parsed = parseScreenModeConfig(raw);
  return { mode: parsed.mode ?? DEFAULT_RENDER_MODE, warning: parsed.warning };
}
