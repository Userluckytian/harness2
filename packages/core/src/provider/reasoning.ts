// Z6-A03 推理档位：role/model 配置 → provider 请求参数的纯函数映射层。
// 设计取舍（调研结论，对齐上游 ZCode 29628c9 的 per-model reasoningLevel 思路）：
//   - 档位值域是**每模型各自声明**的（config.providers.<ch>.models.<id>.reasoning.values，
//     按强度从低到高排列），不是全局枚举——上游 values 有 ['disabled','enabled'] 与
//     ['low','medium','high','xhigh','max'] 等多套并存；
//   - 上游用「per-model map 模板 + 表达式编译器」（packages/model-option-map，约 870 行）
//     把档位换算成请求字段 JSON patch；我们不做表达式语言，改用**封闭显式映射表**
//     （本文件 REASONING_LEVEL_TO_THINKING_BUDGET）+ openai 兼容透传——小而可测，够覆盖
//     reasoning_effort（OpenAI/DeepSeek/GLM 系）与 thinking.budget_tokens（Anthropic 系）；
//   - fail-silent 但类型安全：模型未声明 reasoning / 档位未配置 → 不发参数（undefined）；
//     无效档位（不在 values 内）→ ConfigError（config 加载期已校验，这里纵深防御）。
import { ConfigError } from '../config/schema.js';

/** providers.<channel>.models.<id>.reasoning 的最小形状（与 config/schema.ts 对齐，避免 import 环） */
export interface ReasoningSpec {
  /** 档位清单（非空、去重、按强度从低到高排列） */
  values: readonly string[];
  /** 缺省档位；必须在 values 内（schema 已校验） */
  default?: string;
}

/** resolveReasoningEffort 的输入：role 侧当前档位 + 模型侧档位声明 */
export interface ReasoningResolveInput {
  /** roles.<role>.effort（未配置为 undefined） */
  roleEffort?: string;
  /** providers.<channel>.models.<model>.reasoning（未声明为 undefined） */
  reasoning?: ReasoningSpec;
}

/**
 * 解析本请求生效的推理档位：
 *   模型未声明 reasoning（或 values 为空）→ undefined（模型不支持，不发参数）；
 *   role.effort 缺省时回退 reasoning.default；两者都无 → undefined（档位未声明）；
 *   解析出的档位不在 values 内 → ConfigError（无效档位是配置错误，绝不静默降级）。
 */
export function resolveReasoningEffort(input: ReasoningResolveInput): string | undefined {
  const spec = input.reasoning;
  if (!spec || spec.values.length === 0) return undefined;
  const effort = input.roleEffort ?? spec.default;
  if (effort === undefined) return undefined;
  if (!spec.values.includes(effort)) {
    throw new ConfigError(`推理档位 "${effort}" 不在模型声明的 values 内（${spec.values.join('、')}）`);
  }
  return effort;
}

/**
 * 档位 → Anthropic extended thinking 预算的**封闭显式映射表**。
 * Anthropic API 要求 budget_tokens ≥ 1024；档位语义按强度递增，预算取 2 的幂便于核对：
 *   minimal=1024（协议下限） / low=2048 / medium=4096 / high=8192 / xhigh=16384 / max=32768。
 * 'enabled' 是「二值声明」模型（values: ['disabled','enabled']）的高档兜底，取 high 同档 8192。
 * 不在表内的档位（含 disabled/none/off 等「关」语义）→ undefined：不发 thinking 参数
 * （Anthropic 缺省即不思考，无需显式 disable；fail-silent，类型安全）。
 */
export const REASONING_LEVEL_TO_THINKING_BUDGET: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  enabled: 8192,
  xhigh: 16384,
  max: 32768,
};

/** Anthropic thinking 请求参数（wire 形态） */
export interface AnthropicThinkingParam {
  type: 'enabled';
  budget_tokens: number;
}

/**
 * 档位 → Anthropic thinking 参数。映射表未收录的档位 → undefined（不发参数）。
 * 纯函数：输入恒定输出恒定，fixture 驱动可测。
 */
export function reasoningEffortToAnthropicThinking(effort: string): AnthropicThinkingParam | undefined {
  const budget = REASONING_LEVEL_TO_THINKING_BUDGET[effort];
  return budget === undefined ? undefined : { type: 'enabled', budget_tokens: budget };
}
