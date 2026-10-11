// 审批策略配置化：从 config.approval 构造 Ph2 的 ApprovalHandler 审批缝。
// 优先级：per-tool 规则链 > mode 推导；mode 四态：
//   default     —— safe=allow / 其余 ask
//   acceptEdits —— write/edit=allow，其余同 default
//   bypass      —— 全 allow
//   plan        —— safe=allow / 其余 deny（per-tool 仍可覆盖）
//
// Z6-A16 规则 DSL（approval.tools 的键）：
//   - 单段键 = 工具名模式：精确名（`bash`）或 glob（`*`/`?`，如 `mcp__*` 前缀）；
//   - 两段键 `工具模式:主体模式`（首个 `:` 分隔，如 `bash:git *` 命令级）：主体来自工具
//     参数的可匹配字段（见 APPROVAL_SUBJECT_FIELDS，bash → args.command）；调用无主体
//     时两段键不命中（fail-closed：无法核对的规则不放宽）；
//   - 解析 = 显式确定性优先级链（resolveRuleDecision）：
//       字面字符多者更特异（两段字面数求和）→ 无通配精确键 > 含通配键 →
//       两段（带主体）> 单段 → deny > ask > allow（同特异性取更严）→ 键名字典序（全序）；
//   - 兼容：既有 exact-name 键是「无通配单段键」的特例，老 config 不迁移即可用。
// 未命中任何规则 → resolveUnmatchedDecision（显式 fail-closed 口径：未命中且工具不在
// safe 集 → ask；plan 态未命中且不在 safe 集 → deny）。
// T6 增强：mode 可经第三参运行时传入（CLI /mode 切换、不落盘），缺省取 cfg.mode。
import { hasGlobChars, literalChars, matchGlob } from './glob.js';
import type { ApprovalConfig, ApprovalMode, ApprovalToolRule } from '../config/schema.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalInput } from '../tools/types.js';

/** 缺省安全集：只读工具（对齐 tools/predefined 的 read/glob/grep） */
export const DEFAULT_SAFE_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep']);

/** acceptEdits 模式下放行的文件编辑类工具 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/**
 * 工具 → 参数中可作两段规则「主体」的字段（A16；bash 的命令级规则 `bash:git *`）。
 * 其余工具无主体：两段键对它们永不命中（fail-closed）。加新工具 = 这里加一行。
 */
export const APPROVAL_SUBJECT_FIELDS: Readonly<Record<string, string>> = {
  bash: 'command',
};

/**
 * 提取一次工具调用的规则主体（A16 两段键的匹配对象）：
 * bash → args.command（非空字符串）；其余工具 / 参数形状不符 → undefined。
 */
export function extractApprovalSubject(tool: string, args: unknown): string | undefined {
  const field = APPROVAL_SUBJECT_FIELDS[tool];
  if (field === undefined) return undefined;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const raw = (args as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * 未命中规则时的显式 fail-closed 口径（A16-3）：mode 推导的唯一实现。
 *   bypass → allow；plan → safe=allow / 其余 deny；
 *   acceptEdits → edit=allow，其余 safe=allow / ask；default → safe=allow / ask。
 * 即：未命中且工具不在 safe 集 → ask（plan 态 → deny）。
 */
export function resolveUnmatchedDecision(
  mode: ApprovalMode,
  tool: string,
  safeTools: ReadonlySet<string> = DEFAULT_SAFE_TOOLS,
): ApprovalDecision {
  if (mode === 'bypass') return 'allow';
  if (mode === 'plan') return safeTools.has(tool) ? 'allow' : 'deny';
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return 'allow';
  return safeTools.has(tool) ? 'allow' : 'ask';
}

/** 一条已解析规则（键拆分 + 决策）；internal，测试经 createApprovalPolicy 的 decide 覆盖 */
interface RuleEntry {
  key: string;
  decision: ApprovalToolRule;
  /** 键首段（工具名模式，可含 glob；不含 `:`） */
  toolPart: string;
  /** 键第二段（主体模式）；单段键为 undefined */
  subjectPart?: string;
}

/** 拆分规则键（首个 `:` 分隔两段式；主体可含 `:`——如 `npm run build:prod` 的规则） */
function parseRuleKey(key: string, decision: ApprovalToolRule): RuleEntry {
  const sep = key.indexOf(':');
  if (sep <= 0) return { key, decision, toolPart: key };
  return { key, decision, toolPart: key.slice(0, sep), subjectPart: key.slice(sep + 1) };
}

function ruleMatches(entry: RuleEntry, tool: string, subject: string | undefined): boolean {
  if (!matchGlob(entry.toolPart, tool)) return false;
  if (entry.subjectPart === undefined) return true;
  // 两段键：调用必须带可核对的主体才可能命中（fail-closed）
  return subject !== undefined && matchGlob(entry.subjectPart, subject);
}

/** 特异性比较：>0 = a 更特异（a 胜出）。口径见文件头；终点键名字典序保证全序可复现 */
function compareSpecificity(a: RuleEntry, b: RuleEntry): number {
  const aSubject = a.subjectPart;
  const bSubject = b.subjectPart;
  // 1) 字面字符总和多者更特异（`*`/`?` 不计）
  const aLiterals = literalChars(a.toolPart) + (aSubject !== undefined ? literalChars(aSubject) : 0);
  const bLiterals = literalChars(b.toolPart) + (bSubject !== undefined ? literalChars(bSubject) : 0);
  if (aLiterals !== bLiterals) return aLiterals - bLiterals;
  // 2) 无通配精确键 > 含通配键
  const aExact = hasGlobChars(a.toolPart) || (aSubject !== undefined && hasGlobChars(aSubject)) ? 0 : 1;
  const bExact = hasGlobChars(b.toolPart) || (bSubject !== undefined && hasGlobChars(bSubject)) ? 0 : 1;
  if (aExact !== bExact) return aExact - bExact;
  // 3) 两段（带主体维度）> 单段
  if ((aSubject !== undefined) !== (bSubject !== undefined)) return aSubject !== undefined ? 1 : -1;
  // 4) 同特异性取更严：deny > ask > allow（fail-closed）
  const severity: Record<ApprovalToolRule, number> = { deny: 3, ask: 2, allow: 1 };
  if (a.decision !== b.decision) return severity[a.decision] - severity[b.decision];
  // 5) 全序兜底：键名字典序（同特异性同决策的键必不同名，保证可复现）
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** 策略决策是同步纯函数：在 ApprovalHandler 基础上收窄 decide 的返回类型 */
export interface ConfiguredApprovalHandler extends ApprovalHandler {
  decide(input: ApprovalInput): ApprovalDecision;
}

export function createApprovalPolicy(
  cfg: ApprovalConfig | undefined,
  safeTools: ReadonlySet<string> = DEFAULT_SAFE_TOOLS,
  modeOverride?: ApprovalMode,
): ConfiguredApprovalHandler {
  const mode: ApprovalMode = modeOverride ?? cfg?.mode ?? 'default';
  const entries = Object.entries(cfg?.tools ?? {}).map(([key, decision]) => parseRuleKey(key, decision));
  return {
    decide(input: ApprovalInput): ApprovalDecision {
      const subject = extractApprovalSubject(input.tool, input.args);
      let best: RuleEntry | undefined;
      for (const entry of entries) {
        if (!ruleMatches(entry, input.tool, subject)) continue;
        if (best === undefined || compareSpecificity(entry, best) > 0) best = entry;
      }
      if (best !== undefined) return best.decision; // 规则链最高特异性胜出
      return resolveUnmatchedDecision(mode, input.tool, safeTools); // 未命中 → 显式 fail-closed 口径
    },
  };
}
