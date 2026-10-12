// 侧栏「项目」实体 schema（P0-3b，main/renderer 共享）：~/.harness2/projects.json。
// ZCode 项目组头可「添加项目」（目录选择）→ 项目可无会话（显示「暂无任务」）。
// **壳侧概念，不进 core**（core/cli/gateway 零改动）；持久化落盘在主进程（D-14：渲染端不落盘），
// 本文件只描述形状 + normalize 纯校验（仿 shared/metadata.ts：坏条目丢弃不抛，去重、宽松绝对路径判定）。
export const PROJECTS_FILE = 'projects.json';

/** 单个项目条目：cwd = 项目绝对路径；addedAt = 加入侧栏的时刻（epoch ms，用于显式项目排序） */
export interface ProjectEntry {
  cwd: string;
  addedAt: number;
}

/** projects.json 文档形状 */
export interface ProjectsDocument {
  version: 1;
  projects: ProjectEntry[];
}

/** 空文档（无显式项目） */
export function defaultProjects(): ProjectsDocument {
  return { version: 1, projects: [] };
}

/**
 * 宽松绝对路径判定（跨平台）：Unix `/x`、Windows 盘符 `C:\` 或 `C:/`、UNC `\\host\share`。
 * 只做「看起来是绝对路径」的粗筛——真正的存在性由主进程 fs 侧保证，这里不 stat（纯函数）。
 */
export function looksAbsolutePath(cwd: string): boolean {
  if (cwd.length === 0) return false;
  // 盘符：X: / X:\ / X:/
  if (/^[A-Za-z]:[\\/]/.test(cwd)) return true;
  // UNC：\\server\share
  if (cwd.startsWith('\\\\')) return true;
  // Unix 根：/
  return cwd.startsWith('/');
}

/** normalize 单条目：形状合法 → 干净 entry；否则 null（丢弃） */
function normalizeEntry(raw: unknown): ProjectEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const cwd = e['cwd'];
  if (typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (trimmed.length === 0 || !looksAbsolutePath(trimmed)) return null;
  const addedAtRaw = e['addedAt'];
  const addedAt = typeof addedAtRaw === 'number' && Number.isFinite(addedAtRaw) ? addedAtRaw : 0;
  return { cwd: trimmed, addedAt };
}

/**
 * 校验未知来源的 projects 文档（磁盘文件 / IPC 注入）：
 * 顶层非对象 / projects 非数组 → 空文档；单条非对象 / cwd 非法（空 / 非绝对）→ 丢弃；
 * 按 cwd 去重（后出现的被前面吞掉）；不改动 addedAt 的缺失（回落 0）。
 * 不排序——排序在展示侧（mergeProjectGroups）做，持久化保持写入序。
 */
export function normalizeProjects(raw: unknown): ProjectsDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultProjects();
  const projectsRaw = (raw as Record<string, unknown>)['projects'];
  if (!Array.isArray(projectsRaw)) return defaultProjects();
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const item of projectsRaw) {
    const entry = normalizeEntry(item);
    if (entry === null) continue;
    if (seen.has(entry.cwd)) continue;
    seen.add(entry.cwd);
    out.push(entry);
  }
  return { version: 1, projects: out };
}

/** 幂等加入：已存在（按 cwd）→ 原样返回；否则尾部追加（addedAt 由调用方给，通常 Date.now()） */
export function addProject(doc: ProjectsDocument, cwd: string, addedAt: number): ProjectsDocument {
  const trimmed = cwd.trim();
  if (trimmed.length === 0 || !looksAbsolutePath(trimmed)) return doc;
  if (doc.projects.some((p) => p.cwd === trimmed)) return doc;
  return { version: 1, projects: [...doc.projects, { cwd: trimmed, addedAt }] };
}

/** 移除：按 cwd 精确匹配剔除 */
export function removeProject(doc: ProjectsDocument, cwd: string): ProjectsDocument {
  const trimmed = cwd.trim();
  return { version: 1, projects: doc.projects.filter((p) => p.cwd !== trimmed) };
}
