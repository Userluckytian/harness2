// 侧栏「项目」实体持久化（主进程）：~/.harness2/projects.json 读写。
// 与 desktop-metadata.json 同目录、同「校验 + 损坏回退」模式（公共逻辑见 json-file.ts，不复制两套）。
// **壳侧概念红线**：projects.json 是桌面壳的展示层数据，不进 core（core/cli/gateway 零改动）；
// 渲染端零 Node，唯一读写口 = 本模块经 IPC（P0-3b）。normalizeProjects 同时是防脏入口。
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  addProject,
  defaultProjects,
  normalizeProjects,
  PROJECTS_FILE,
  type ProjectsDocument,
} from '@harness2/ui-shared/shared/projects.js';
import { readJsonWithDefault, writeJsonNormalized } from './json-file.js';

export function projectsFilePath(home: string): string {
  return join(home, '.harness2', PROJECTS_FILE);
}

/** 读取并规范化（缺失/损坏/形状非法 → 空文档；坏条目丢弃不抛） */
export function readProjects(home: string): ProjectsDocument {
  return readJsonWithDefault(projectsFilePath(home), normalizeProjects, defaultProjects);
}

/**
 * 幂等加入：已存在（按 cwd）→ 现表原样返回（不重复写盘、不刷新 addedAt）；
 * 否则尾部追加 {cwd, addedAt: nowMs} 并写盘，返回写后文档（写前 normalize 防脏）。
 */
export function addProjectEntry(home: string, cwd: string, nowMs: number): ProjectsDocument {
  const current = readProjects(home);
  const exists = current.projects.some((p) => p.cwd === cwd.trim());
  if (exists) return current;
  const next = addProject(current, cwd, nowMs);
  return writeJsonNormalized(projectsFilePath(home), next, normalizeProjects);
}

/** 移除：按 cwd 过滤后写盘，返回写后文档（不存在 = 幂等，仍写盘保持一致语义的现表） */
export function removeProjectEntry(home: string, cwd: string): ProjectsDocument {
  const current = readProjects(home);
  const target = cwd.trim();
  const next: ProjectsDocument = {
    version: 1,
    projects: current.projects.filter((p) => p.cwd !== target),
  };
  return writeJsonNormalized(projectsFilePath(home), next, normalizeProjects);
}

/** 默认 home（进程级；测试不依赖） */
export function defaultHome(): string {
  return homedir();
}
