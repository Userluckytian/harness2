// 能力描述（describeCapabilities）：向壳/外部展示 core 的命令面、审批模式、工具表与审批策略摘要。
// 只读聚合、不重复造枚举：modes 读 config 的 APPROVAL_MODES，safeTools 读 approval/policy 的
// DEFAULT_SAFE_TOOLS，tools 读 tools/predefined 的 builtinTools（注册顺序）。
import { DEFAULT_SAFE_TOOLS } from '../approval/policy.js';
import { APPROVAL_MODES, type ApprovalMode } from '../config/schema.js';
import { builtinTools } from '../tools/predefined/index.js';
import { CORE_COMMAND_META, type CoreCommandMeta } from './catalog.js';

/** 审批模式能力条目（内核值；壳负责展示别名映射，如 normal↔default） */
export interface ApprovalModeCapability {
  mode: ApprovalMode;
  /** 一句话说明（与 approval/policy.ts 的模式语义注释同口径） */
  description: string;
}

/** 工具能力条目（只暴露名称与说明，不暴露执行体） */
export interface ToolCapability {
  name: string;
  description: string;
}

/** 审批策略摘要 */
export interface ApprovalPolicyCapability {
  /** 决策优先级说明 */
  rule: string;
  /** 未命中 per-tool 规则时的兜底说明 */
  fallback: string;
  /** 缺省安全集（只读工具；调用方可注入覆盖） */
  safeTools: readonly string[];
}

/** core 能力描述（shellOnly 命令含在内，供壳标注「由界面层实现」） */
export interface CoreCapabilities {
  /** 全部注册命令（13 条元数据，声明顺序 = 帮助展示顺序） */
  commands: readonly CoreCommandMeta[];
  /** 审批模式与说明（来自 approval policy，非重复枚举） */
  modes: readonly ApprovalModeCapability[];
  /** core 内置工具表 */
  tools: readonly ToolCapability[];
  /** 审批策略摘要 */
  approvalPolicy: ApprovalPolicyCapability;
}

/** 模式说明（源：approval/policy.ts 文件头四态语义） */
const MODE_DESCRIPTIONS: Readonly<Record<ApprovalMode, string>> = {
  default: 'safe=allow，其余 ask',
  acceptEdits: 'write/edit 自动放行，其余同 default',
  bypass: '全部自动放行',
  plan: 'safe=allow，其余 deny（per-tool 规则仍可覆盖）',
};

/** 描述 core 当前能力面（命令/模式/工具/审批策略），供壳与外部展示消费 */
export function describeCapabilities(): CoreCapabilities {
  return {
    commands: CORE_COMMAND_META,
    modes: APPROVAL_MODES.map((mode) => ({ mode, description: MODE_DESCRIPTIONS[mode] })),
    tools: builtinTools.map((t) => ({ name: t.name, description: t.description })),
    approvalPolicy: {
      rule: 'per-tool 规则（allow|ask|deny）优先于 mode 推导',
      fallback: '未列出的工具按 safe=allow / unsafe=ask 处理（安全集可注入覆盖）',
      safeTools: [...DEFAULT_SAFE_TOOLS],
    },
  };
}
