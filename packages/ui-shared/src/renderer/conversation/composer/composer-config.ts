// composer-config.ts — Z3-04（Z-94）Composer 控件纯逻辑：模型选择菜单构造 + 权限模式映射。
//
// 规格依据：docs/refs/refs-zcode.md Z-94（Composer 左簇 V4ComposerModeSwitch / 右簇
// ModelConfigSelect）。数据面（编排者已核实）：
//   * 模型是 **config 级**（core `server/http.ts` 读 `config.roles['main']`），没有会话级覆盖；
//   * 权限模式 `approval.mode` ∈ 'default' | 'acceptEdits' | 'bypass' | 'plan'，
//     被 core 审批服务真实消费（`approval/policy.ts`：bypass=allow 全部、plan=仅 safeTools、
//     acceptEdits=编辑类 allow、default=逐工具审批）。
//
// ⚠️ 如实差异（写给每个改动者）：两项选择都经 `settings:updateConfig` 写 config.json ——
// 影响的是**之后的会话**；运行中会话是否跟进取决于 core 读配置的时机。UI 一律**不声称**
// 「本会话已切换」，只如实反映 config 的当前值。
//
// 本模块只做决策：零 DOM / 零 React / 零 Node，全部可单测（风格同 composer-state.ts）。

/** 模型引用（= config `roles.<role>` 的 {channel, model}；channel 即 providers 键 = provider id） */
export interface ComposerModelRef {
  readonly channel: string;
  readonly model: string;
}

/** 角色条目快照：{channel, model} + 可选推理档位（core `roles.<role>.effort`） */
export interface ComposerRoleSnapshot {
  readonly channel: string;
  readonly model: string;
  /** 当前推理档位（Z6-A03；未配置 = 用模型声明的缺省档位） */
  readonly effort?: string;
}

/** 模型声明的推理档位（core `providers.<c>.models.<m>.reasoning`；顺序 = 强度从低到高，非全局枚举） */
export interface ComposerReasoningSpec {
  readonly values: readonly string[];
  readonly default?: string;
}

/**
 * 结构最小面：与桌面 `SettingsConfigShape` 的 providers/roles/approval 结构兼容
 * （壳直接传 config 视图即可，不要求整份形状）。
 * 模型条目可携带 `reasoning`（档位来源）；壳视图未透出该字段时，档位控件如实不渲染。
 */
export interface ComposerConfigSnapshot {
  readonly roles?: Readonly<Record<string, ComposerRoleSnapshot>>;
  readonly providers?: Readonly<
    Record<string, { readonly models?: Readonly<Record<string, { readonly reasoning?: ComposerReasoningSpec }>> }>
  >;
  readonly approval?: { readonly mode?: string };
}

/** 模型选择作用的角色（core serve 读 `config.roles['main']`，写也写它） */
export const COMPOSER_MAIN_ROLE = 'main';

// —— 模型菜单（Z-94 ModelConfigSelect：当前渠道可选模型 + 其他 provider 的模型 + 管理入口）——

export interface ComposerModelMenuItem {
  readonly channel: string;
  readonly model: string;
  /** 选中态只来自 config 当前值（不是本地臆造） */
  readonly selected: boolean;
}

export interface ComposerModelMenuGroup {
  /** 分组标题 = provider id（config 无 displayName；显示名由设置页的覆层承载，composer 用 id） */
  readonly channel: string;
  readonly items: readonly ComposerModelMenuItem[];
}

export interface ComposerModelMenu {
  readonly current: ComposerModelRef;
  /** 第一组恒为当前渠道；其余渠道按名称排序跟在后面 */
  readonly groups: readonly ComposerModelMenuGroup[];
}

/**
 * 构造模型菜单：
 *   - `current` = roles.main，缺失时由调用方传 fallback（3b：回落 providers 列表首项）；
 *     两者都拿不到 → undefined（无从选择，控件不渲染）；
 *   - 当前渠道组：目录声明了 models 就列全量（键名字典序）；当前值不在目录中时把它**如实**
 *     补进组首并标选中（数据来自 config，不是伪造条目）；
 *   - 其他渠道组：仅列**声明了 models** 的渠道（没目录的渠道无从选择，不列空组），
 *     选中态恒 false——「选中」只属于当前生效配置。
 */
export function buildModelMenu(
  config: ComposerConfigSnapshot,
  fallbackCurrent?: ComposerModelRef | undefined,
): ComposerModelMenu | undefined {
  const current = config.roles?.[COMPOSER_MAIN_ROLE] ?? fallbackCurrent;
  if (current === undefined) return undefined;
  const providers = config.providers ?? {};
  const groups: ComposerModelMenuGroup[] = [];

  const declaredCurrent = Object.keys(providers[current.channel]?.models ?? {}).sort();
  const currentItems: ComposerModelMenuItem[] = [];
  if (!declaredCurrent.includes(current.model)) {
    currentItems.push({ channel: current.channel, model: current.model, selected: true });
  }
  for (const model of declaredCurrent) {
    currentItems.push({ channel: current.channel, model, selected: model === current.model });
  }
  groups.push({ channel: current.channel, items: currentItems });

  const otherChannels = Object.keys(providers)
    .filter((channel) => channel !== current.channel && Object.keys(providers[channel]?.models ?? {}).length > 0)
    .sort();
  for (const channel of otherChannels) {
    const models = Object.keys(providers[channel]?.models ?? {}).sort();
    groups.push({
      channel,
      items: models.map((model) => ({ channel, model, selected: false })),
    });
  }
  return { current, groups };
}

/** Z-94 trigger：provider 前缀 + 模型名（如 `zai · glm-5.3`） */
export function modelTriggerLabel(ref: ComposerModelRef): string {
  return `${ref.channel} · ${ref.model}`;
}

/**
 * 3b 回落：`roles.main` 缺失时，模型选择器初值取 **providers 列表首项**（渠道名升序 →
 * 该渠道模型名升序，与 buildModelMenu 的排序口径一致），而不是隐藏选择器。
 * 无任何 provider/models 声明 → undefined（无从选择，控件仍不渲染，红线⑩）。
 * 注：这**不改变实际生效模型**（core 按角色取模型，roles.main 缺失时 serve 直接启动失败）——
 * 只是让 UI 有可解释的初值与切换入口，用户一旦点选即写 roles.main（真值随之落盘）。
 */
export function firstAvailableModel(config: ComposerConfigSnapshot): ComposerModelRef | undefined {
  const providers = config.providers ?? {};
  for (const channel of Object.keys(providers).sort()) {
    const models = Object.keys(providers[channel]?.models ?? {}).sort();
    const model = models[0];
    if (model !== undefined) return { channel, model };
  }
  return undefined;
}

/**
 * 切换模型的 config patch（同渠道只写 model；跨渠道把 channel 一并写）。
 * 深合并语义（desktop `config-file.ts`）保证未写的 channel 字段不丢。
 */
export function modelSelectionPatch(
  current: ComposerModelRef,
  target: ComposerModelRef,
): { roles: { main: ComposerModelRef } } {
  const role: ComposerModelRef =
    target.channel === current.channel
      ? { channel: current.channel, model: target.model }
      : { channel: target.channel, model: target.model };
  return { roles: { main: role } };
}

// —— 权限模式（Z-94 V4ComposerModeSwitch：Plan 复选框 + 权限单选组）——

/** core `ApprovalMode` 的 UI 侧同形（不 import core：UI 包不依赖 core 运行时） */
export type ComposerApprovalMode = 'default' | 'acceptEdits' | 'bypass' | 'plan';
/** 单选组的三态（plan 由首项复选框承担，不进单选组） */
export type ComposerRadioApprovalMode = Exclude<ComposerApprovalMode, 'plan'>;

export function isRadioApprovalMode(value: string | undefined): value is ComposerRadioApprovalMode {
  return value === 'default' || value === 'acceptEdits' || value === 'bypass';
}

export function isPlanMode(value: string | undefined): boolean {
  return value === 'plan';
}

/** UI 展示用的当前模式：config 未设置时按 core 缺省 default（不臆造其他值） */
export function displayApprovalMode(value: string | undefined): ComposerApprovalMode {
  if (value === 'plan' || isRadioApprovalMode(value)) return value;
  return 'default';
}

export function approvalModePatch(mode: ComposerApprovalMode): { approval: { mode: ComposerApprovalMode } } {
  return { approval: { mode } };
}

/** 一次模式决策：最终写盘值 + 单选记忆值（记忆只存 UI 内存，不落盘——D-14） */
export interface ComposerApprovalModeDecision {
  readonly mode: ComposerApprovalMode;
  readonly rememberedRadio: ComposerRadioApprovalMode;
}

/**
 * Plan 复选框切换（与单选值双向联动）：
 *   - 勾上 → 写 'plan'，并记住「当下生效的单选值」（config 当前值优先，其次记忆，兜底 default）；
 *   - 取消 → 回落到记住的单选值（记忆缺失时按 config 当前值/缺省 default 推导）。
 */
export function decidePlanToggle(
  currentMode: string | undefined,
  rememberedRadio: ComposerRadioApprovalMode | undefined,
  nextChecked: boolean,
): ComposerApprovalModeDecision {
  if (nextChecked) {
    const remembered = isRadioApprovalMode(currentMode) ? currentMode : (rememberedRadio ?? 'default');
    return { mode: 'plan', rememberedRadio: remembered };
  }
  const mode = rememberedRadio ?? (isRadioApprovalMode(currentMode) ? currentMode : 'default');
  return { mode, rememberedRadio: mode };
}

/** 单选组选择：写该单选值（若此前在 plan 中，即等于退出 plan），并校准记忆 */
export function decideRadioSelect(radio: ComposerRadioApprovalMode): ComposerApprovalModeDecision {
  return { mode: radio, rememberedRadio: radio };
}

/** 菜单项元数据（标题/描述用 core 审批服务的真实语义；图标在组件层映射，本模块不带 React） */
export interface ComposerPlanMenuItem {
  readonly mode: 'plan';
  readonly title: string;
  readonly description: string;
}

/** 权限单选组的菜单项（mode 收窄到三单选值——plan 由 Plan 复选框承担） */
export interface ComposerApprovalMenuItem {
  readonly mode: ComposerRadioApprovalMode;
  readonly title: string;
  readonly description: string;
}

/** 首项：Plan 复选框（plan=仅放行只读安全工具，见 core approval/policy.ts） */
export const COMPOSER_PLAN_ITEM: ComposerPlanMenuItem = {
  mode: 'plan',
  title: '计划模式',
  description: '先制定计划再执行；执行阶段仅放行只读安全工具',
};

/** 权限单选组（顺序 = 菜单呈现顺序） */
export const COMPOSER_APPROVAL_ITEMS: readonly ComposerApprovalMenuItem[] = [
  { mode: 'default', title: '默认', description: '每次工具调用都逐个请求批准' },
  { mode: 'acceptEdits', title: '自动接受编辑', description: '自动放行编辑类工具，其余仍逐个审批' },
  { mode: 'bypass', title: '全部放行', description: '不再请求批准，所有工具直接执行' },
];

/** 模式循环顺序（Z-94 cycleSessionMode；含 Plan —— 它也是一种会话模式，首项复选框与它同源） */
export const COMPOSER_APPROVAL_CYCLE: readonly ComposerApprovalMode[] = ['default', 'acceptEdits', 'bypass', 'plan'];

/** 模式循环：默认 → 自动接受编辑 → 全部放行 → 计划 → 默认（回绕） */
export function nextApprovalMode(current: string | undefined): ComposerApprovalMode {
  const i = COMPOSER_APPROVAL_CYCLE.indexOf(displayApprovalMode(current));
  return COMPOSER_APPROVAL_CYCLE[(i + 1) % COMPOSER_APPROVAL_CYCLE.length] ?? 'default';
}

// —— 思考档位（Z-94 ThoughtLevelCycleControl；数据面 = core `roles.<role>.effort` + 模型 reasoning.values）——

/** 档位值 → 展示标签（ZCode 的通用档位名 → 中文；表外值原样显示 provider 自己的档位名，不臆造） */
const THOUGHT_LEVEL_LABELS: Record<string, string> = {
  off: '关闭',
  disabled: '关闭',
  none: '关闭',
  no: '关闭',
  nothink: '关闭',
  enable: '开启',
  enabled: '开启',
  on: '开启',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  'extra-high': '极高',
  xhigh: '极高',
  max: '最高',
  ultra: '最高',
};

/** 档位展示标签：已知名映射为中文，未知值原样返回（不把 provider 私有档位名硬编码进枚举） */
export function thoughtLevelLabel(value: string): string {
  return THOUGHT_LEVEL_LABELS[value.trim().toLowerCase()] ?? value;
}

/** 当前思考档位（壳据此渲染与循环） */
export interface ComposerThoughtLevel {
  /** 当前档位值：config 显式设置优先，否则模型缺省档位，再否则 values[0] */
  readonly current: string;
  /** 可选档位（顺序即菜单/循环顺序，来自模型声明，非自造枚举） */
  readonly values: readonly string[];
  /** current 是否来自 config 的显式 `roles.<role>.effort`（false = 用模型缺省档位展示） */
  readonly explicit: boolean;
}

/**
 * 由 config 视图构造思考档位数据面。
 *   - 角色缺失 / 所引模型缺失 / 模型未声明 `reasoning.values` → undefined（无档位可选，控件不渲染）；
 *   - 当前值取 `roles.<role>.effort`（须在 values 内）；未设置时按 core 语义用模型 `reasoning.default`
 *     （旧宿主视图可能未透出该字段，则回落 values[0]），此时 `explicit=false`。
 */
export function buildThoughtLevel(
  config: ComposerConfigSnapshot,
  role: string = COMPOSER_MAIN_ROLE,
): ComposerThoughtLevel | undefined {
  const ref = config.roles?.[role];
  if (ref === undefined) return undefined;
  const reasoning = config.providers?.[ref.channel]?.models?.[ref.model]?.reasoning;
  const values = reasoning?.values;
  if (reasoning === undefined || values === undefined || values.length === 0) return undefined;
  const effort = ref.effort;
  if (effort !== undefined && values.includes(effort)) {
    return { current: effort, values: [...values], explicit: true };
  }
  const fallback =
    reasoning.default !== undefined && values.includes(reasoning.default) ? reasoning.default : values[0]!;
  return { current: fallback, values: [...values], explicit: false };
}

/** 档位循环：values 顺序向后一格回绕；不足两档返回 undefined（ZCode 同判据：无可循环） */
export function nextThoughtLevel(current: string, values: readonly string[]): string | undefined {
  if (values.length < 2) return undefined;
  const i = values.indexOf(current);
  return values[i < 0 ? 0 : (i + 1) % values.length];
}

/** 切换档位的 config patch（带 channel/model，深合并保证其余角色字段不丢） */
export function thoughtLevelPatch(
  role: string,
  ref: ComposerModelRef,
  effort: string,
): { roles: Record<string, ComposerModelRef & { effort: string }> } {
  return { roles: { [role]: { channel: ref.channel, model: ref.model, effort } } };
}
