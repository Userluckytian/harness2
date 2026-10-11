// A09 hook matcher：复用 A16 权限 DSL 的 glob（approval/glob.ts 的 matchGlob）。
// 语义（唯一表述，config/schema 注释与测试与此对齐）：
//   - matcher 缺省（undefined/空串）= 全命中（无过滤）；
//   - preTool/postTool：matcher 匹配**工具名**（`*`/`?` glob，全串锚定）；
//   - 其余事件（sessionStart/sessionEnd/turnEnd）不接受 matcher（config 校验层拒绝——
//     无匹配对象时给 matcher 是笔误，fail-closed 直接拦下，见 schema）。
// 与 ZCode 的差异：ZCode matcher 支持 `a|b` 精确择一与正则；我们**只认仓库既有 glob**
// （不自造第二套匹配语义，报告登记该差异）。`bash`/`mcp__*` 等常规用法等价可配。
import { matchGlob } from '../approval/glob.js';

/** 该事件下 matcher 是否有意义（= 有工具名匹配对象） */
export function eventSupportsMatcher(event: string): boolean {
  return event === 'preTool' || event === 'postTool';
}

/**
 * 单条 hook 是否命中本次事件：
 *   - matcher 空 → true（全命中）；
 *   - 有 matcher 但本次无目标值（target undefined）→ false（fail-closed：无从核对不放行）；
 *   - 否则 matchGlob(matcher, target)。
 */
export function matchHookMatcher(matcher: string | undefined, target: string | undefined): boolean {
  if (matcher === undefined || matcher.length === 0) return true;
  if (target === undefined) return false;
  return matchGlob(matcher, target);
}
