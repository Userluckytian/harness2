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

/**
 * 结构最小面：与桌面 `SettingsConfigShape` 的 providers/roles/approval 结构兼容
 * （壳直接传 config 视图即可，不要求整份形状）。
 */
export interface ComposerConfigSnapshot {
  readonly roles?: Readonly<Record<string, ComposerModelRef>>;
  readonly providers?: Readonly<Record<string, { readonly models?: Readonly<Record<string, unknown>> }>>;
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
 *   - `roles.main` 缺失 → undefined（没有「当前模型」可如实展示，控件整体不渲染）；
 *   - 当前渠道组：目录声明了 models 就列全量（键名字典序）；当前值不在目录中时把它**如实**
 *     补进组首并标选中（数据来自 config，不是伪造条目）；
 *   - 其他渠道组：仅列**声明了 models** 的渠道（没目录的渠道无从选择，不列空组），
 *     选中态恒 false——「选中」只属于当前生效配置。
 */
export function buildModelMenu(config: ComposerConfigSnapshot): ComposerModelMenu | undefined {
  const current = config.roles?.[COMPOSER_MAIN_ROLE];
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
