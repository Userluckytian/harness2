// 审批策略配置化：从 config.approval 构造 Ph2 的 ApprovalHandler 审批缝。
// 优先级：per-tool 规则 > mode 推导；mode 三态：
//   default     —— safe=allow / 其余 ask
//   acceptEdits —— write/edit=allow，其余同 default
//   bypass      —— 全 allow
// per-tool 规则（allow|ask|deny）可覆盖任何 mode（含 bypass 下的 ask/deny）。
// 未列出的工具按 safe=allow / unsafe=ask 处理（安全集 = 只读工具，可注入覆盖）。
import type { ApprovalConfig, ApprovalToolRule } from '../config/schema.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalInput } from '../tools/types.js';

/** 缺省安全集：只读工具（对齐 tools/predefined 的 read/glob/grep） */
export const DEFAULT_SAFE_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep']);

/** acceptEdits 模式下放行的文件编辑类工具 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/** 策略决策是同步纯函数：在 ApprovalHandler 基础上收窄 decide 的返回类型 */
export interface ConfiguredApprovalHandler extends ApprovalHandler {
  decide(input: ApprovalInput): ApprovalDecision;
}

export function createApprovalPolicy(
  cfg: ApprovalConfig | undefined,
  safeTools: ReadonlySet<string> = DEFAULT_SAFE_TOOLS,
): ConfiguredApprovalHandler {
  const mode = cfg?.mode ?? 'default';
  const rules: Record<string, ApprovalToolRule> = cfg?.tools ?? {};
  return {
    decide(input: ApprovalInput): ApprovalDecision {
      const rule = rules[input.tool];
      if (rule !== undefined) return rule; // per-tool 最高优先级
      if (mode === 'bypass') return 'allow';
      if (mode === 'acceptEdits' && EDIT_TOOLS.has(input.tool)) return 'allow';
      return safeTools.has(input.tool) ? 'allow' : 'ask';
    },
  };
}
