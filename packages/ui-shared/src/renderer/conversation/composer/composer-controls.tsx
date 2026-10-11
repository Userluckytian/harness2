// composer-controls.tsx — Z3-04（Z-94）Composer 左右簇控件：模型选择（ModelConfigSelect 对齐）
// 与模式切换（V4ComposerModeSwitch 对齐）。
//
// ⚠️ 如实差异（Z-94 规格 vs 本实现，验收口径见阶段计划）：
//   * 模型与权限模式都是 **config 级**选择（写 config.json 的 roles.main / approval.mode），
//     影响「之后的会话」；运行中会话是否跟进取决于 core 读配置时机，UI 不声称「本会话已切换」；
//   * 菜单不含搜索（Z-94 有；本阶段数据面无该能力的对应字段，如实省略）；
//   * 「管理模型」仅当壳提供设置入口回调时渲染（web 壳无该通道 → 该项不渲染，不摆死入口）。
//
// 数据一律经 props 流入（壳注入），本组件不抓 IPC / 不抓全局单例；纯决策在 composer-config.ts。
import { Fragment, useRef } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { CheckIcon, FilePenLineIcon, LightbulbIcon, Settings2Icon, ShieldCheckIcon, ZapIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';
import {
  COMPOSER_APPROVAL_ITEMS,
  COMPOSER_PLAN_ITEM,
  decidePlanToggle,
  decideRadioSelect,
  isPlanMode,
  isRadioApprovalMode,
  modelTriggerLabel,
  type ComposerApprovalMode,
  type ComposerModelMenu,
  type ComposerModelRef,
  type ComposerRadioApprovalMode,
} from './composer-config.js';

// —— 模型选择（右簇；Z-94 ModelConfigSelect）——

export interface ComposerModelSelectControlProps {
  /** 菜单模型（壳经 buildModelMenu(config) 构造后传入） */
  readonly menu: ComposerModelMenu;
  /** 选择一个模型目标（含渠道；写盘由壳做） */
  readonly onSelectModel: (target: ComposerModelRef) => void;
  /** 「管理模型」入口；缺省 = 菜单不渲染该项（壳无设置通道时如实省略） */
  readonly onManageModels?: () => void;
  readonly disabled?: boolean;
}

/**
 * 空间不足时 trigger 退化为纯图标（Z-94）：`@container/composer` 容器查询（composer 外壳
 * 挂容器），≤560px 隐藏文字只留图标。断点对齐 Z-95 的任意值容器查询用法（@min-[1280px]）。
 */
export function ComposerModelSelect(props: ComposerModelSelectControlProps): ReactNode {
  const { menu } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="composer-model-select"
          disabled={props.disabled}
          aria-label={`模型：${modelTriggerLabel(menu.current)}`}
          className="rounded-lg text-foreground-subtle hover:text-foreground"
        >
          <Settings2Icon className="hidden size-4 @max-[560px]/composer:block" />
          <span className="@max-[560px]/composer:hidden">{modelTriggerLabel(menu.current)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" data-testid="composer-model-menu">
        {menu.groups.map((group) => (
          <Fragment key={group.channel}>
            <DropdownMenuLabel>{group.channel}</DropdownMenuLabel>
            {group.items.map((item) => (
              <DropdownMenuItem
                key={`${item.channel}/${item.model}`}
                data-testid="composer-model-option"
                data-selected={item.selected ? 'true' : undefined}
                onSelect={() => props.onSelectModel({ channel: item.channel, model: item.model })}
              >
                <span className="truncate">{item.model}</span>
                {item.selected && <CheckIcon className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
        {props.onManageModels !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="composer-model-manage" onSelect={() => props.onManageModels?.()}>
              <Settings2Icon className="size-4" />
              <span>管理模型</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// —— 模式切换（左簇；Z-94 V4ComposerModeSwitch）——

export interface ComposerModeSwitchControlProps {
  /** config 当前权限模式（含 'plan'；未设置 = undefined，按 core 缺省 default 展示） */
  readonly mode: string | undefined;
  /** 决策后的最终模式（写盘由壳做；Plan↔单选的映射与回落已在内部经纯函数完成） */
  readonly onModeChange: (mode: ComposerApprovalMode) => void;
  readonly disabled?: boolean;
}

/** 单选值 → 图标（plan 由灯泡承担，不进此表） */
const RADIO_ICONS: Record<ComposerRadioApprovalMode, LucideIcon> = {
  default: ShieldCheckIcon,
  acceptEdits: FilePenLineIcon,
  bypass: ZapIcon,
};

function RadioIcon({ mode, className }: { mode: ComposerRadioApprovalMode; className?: string }): ReactNode {
  const Icon = RADIO_ICONS[mode] as ComponentType<{ className?: string }>;
  return <Icon className={className} />;
}

export function ComposerModeSwitch(props: ComposerModeSwitchControlProps): ReactNode {
  const plan = isPlanMode(props.mode);
  // 单选展示值：config 是单选值时用它；plan / 未设置时按缺省 default（plan 生效时单选组不显示选中态）
  const radioDisplay: ComposerRadioApprovalMode = isRadioApprovalMode(props.mode) ? props.mode : 'default';

  // 单选记忆（仅内存，D-14：不落任何浏览器存储）：config 回到单选值时随时校准，
  // 外部（另一席位/设置页）改写 config 也能跟上；plan 期间保持勾选前的值。
  const rememberedRef = useRef<ComposerRadioApprovalMode>('default');
  if (isRadioApprovalMode(props.mode)) rememberedRef.current = props.mode;

  const selectPlan = (nextChecked: boolean): void => {
    const decision = decidePlanToggle(props.mode, rememberedRef.current, nextChecked);
    rememberedRef.current = decision.rememberedRadio;
    props.onModeChange(decision.mode);
  };
  const selectRadio = (radio: ComposerRadioApprovalMode): void => {
    const decision = decideRadioSelect(radio);
    rememberedRef.current = decision.rememberedRadio;
    props.onModeChange(decision.mode);
  };

  const triggerTitle = plan
    ? COMPOSER_PLAN_ITEM.title
    : (COMPOSER_APPROVAL_ITEMS.find((m) => m.mode === radioDisplay)?.title ?? '默认');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="composer-mode-switch"
          data-plan={plan ? 'true' : undefined}
          disabled={props.disabled}
          aria-label={`权限模式：${triggerTitle}`}
          className="rounded-lg text-foreground-subtle hover:text-foreground"
        >
          {/* Z-94：勾选 Plan 后 trigger 旁出现灯泡标记 */}
          {plan ? (
            <LightbulbIcon className="size-4" data-testid="composer-plan-marker" />
          ) : (
            <RadioIcon mode={radioDisplay} className="size-4" />
          )}
          <span>{triggerTitle}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" data-testid="composer-mode-menu">
        <DropdownMenuCheckboxItem
          checked={plan}
          onCheckedChange={(checked) => selectPlan(checked === true)}
          data-testid="composer-mode-plan"
          className="items-start py-1.5"
        >
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <LightbulbIcon className="size-4" />
              <span>{COMPOSER_PLAN_ITEM.title}</span>
            </span>
            <span className="text-ui-xs text-foreground-subtlest">{COMPOSER_PLAN_ITEM.description}</span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* plan 生效时单选组不显示选中态（生效的是 plan，显示任何单选选中都是假状态）；
            此时点单选 = 退出 plan 并落到该值 */}
        <DropdownMenuRadioGroup value={plan ? '' : radioDisplay}>
          {COMPOSER_APPROVAL_ITEMS.map((item) => (
            <DropdownMenuRadioItem
              key={item.mode}
              value={item.mode}
              data-testid={`composer-mode-${item.mode}`}
              className="items-start py-1.5"
              onSelect={() => selectRadio(item.mode)}
            >
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <RadioIcon mode={item.mode} className="size-4" />
                  <span>{item.title}</span>
                </span>
                <span className="text-ui-xs text-foreground-subtlest">{item.description}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
