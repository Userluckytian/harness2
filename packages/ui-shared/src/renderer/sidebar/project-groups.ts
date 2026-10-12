// P0-3b 侧栏「项目」分组融合（纯函数，无 IO、无 React；Z-16 #6/#7/#9）：
//   显式项目列表（~/.harness2/projects.json 的 ProjectEntry 投影）+ 会话列表 → 项目组 + 游离会话。
// 规则（阶段计划 §6 / 交接任务书 §1）：
//   - 每个显式项目 = 一个组（**0 会话也成组**，渲染侧空组显示「暂无任务」）；
//   - 会话按 cwd 归入对应组；不属于任何显式项目的会话 → 游离（渲染侧进「任务」区，不是项目组）；
//   - 组排序 = addedAt 升序；组内/游离会话**保持输入顺序**（排序/筛选在 buildSidebarSections 里
//     已按偏好做好，这里不重造）；
//   - 向后兼容反向钉：projects 为空数组时不接管分组——调用方（buildSidebarSections）应走
//     既有分组逻辑，现状行为不变。
// cwd 匹配跨平台归一（Windows 不区分大小写、`\`≡`/`、忽略尾分隔符）；渲染端不做 fs 存在性判断。
// 依赖方向：本模块对 task-view 只有 **type-only import**（形状共用），运行时依赖单向
// task-view → project-groups，无环。
import type { SidebarProjectGroup } from './task-view.js';
import type { SidebarSessionItem } from './session-items.js';

/**
 * 项目名 = cwd 末段（Windows/Unix 分隔符都认，忽略尾分隔符）。
 * 定义在 P0-3b 起挪到本模块（merge 与既有分组共用同一规则）；
 * task-view 按名字再导出，既有引用面不变。
 * @param cwd - 会话/项目工作目录；缺省或为空 → 空串（调用方用「无项目」文案兜底）。
 * @returns 末段目录名。
 */
export function projectName(cwd?: string): string {
  if (cwd === undefined) return '';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return '';
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] ?? '';
}

/** 显式项目（ProjectEntry 的渲染侧投影：分组只需要路径 + 加入时刻） */
export interface ProjectGroupInput {
  cwd: string;
  addedAt: number;
}

/** mergeProjectGroups 的产物：项目组 + 游离会话（两段都不重复同一行） */
export interface MergedProjectGroups {
  /** 显式项目组（含空组），按 addedAt 升序；key = `project:${cwd}` */
  groups: SidebarProjectGroup[];
  /** 不属于任何显式项目的会话（含无 cwd 的会话）——渲染进「任务」区 */
  loose: SidebarSessionItem[];
}

/**
 * cwd 归一（只用于**比较**，不改变展示/透传值）：
 * 反斜杠→正斜杠、折叠重复分隔符、去尾部 `/`、Windows 盘符统一小写。
 * UNC `\\server\share` 折叠为 `/server/share` —— 两侧同规则即可匹配，不追求保真。
 */
function normalizeCwd(cwd: string): string {
  let s = cwd.trim().replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * 融合显式项目与会话列表（纯函数）。
 * @param input.projects - 显式项目（可为空数组 = 无项目实体；调用方据此决定是否走既有分组）。
 * @param input.items - 会话行（已完成排序/筛选；本函数只归组，不重排）。
 * @returns 项目组（addedAt 升序，空组保留）与游离会话两段。
 */
export function mergeProjectGroups(input: {
  projects: readonly ProjectGroupInput[];
  items: readonly SidebarSessionItem[];
}): MergedProjectGroups {
  // addedAt 升序（稳定：同刻按路径，保证纯函数输出确定）；重复 cwd（归一后）先到先得。
  const ordered = [...input.projects].sort((a, b) =>
    a.addedAt !== b.addedAt ? a.addedAt - b.addedAt : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0,
  );
  const groups: SidebarProjectGroup[] = [];
  const byNorm = new Map<string, SidebarProjectGroup>();
  for (const project of ordered) {
    const norm = normalizeCwd(project.cwd);
    if (byNorm.has(norm)) continue;
    const group: SidebarProjectGroup = {
      key: `project:${project.cwd}`,
      name: projectName(project.cwd),
      cwd: project.cwd,
      source: 'project',
      items: [],
    };
    byNorm.set(norm, group);
    groups.push(group);
  }
  const loose: SidebarSessionItem[] = [];
  for (const item of input.items) {
    const target = item.cwd === undefined ? undefined : byNorm.get(normalizeCwd(item.cwd));
    if (target === undefined) loose.push(item);
    else target.items.push(item);
  }
  return { groups, loose };
}
