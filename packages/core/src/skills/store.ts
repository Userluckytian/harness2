// Skills 商店（阶段 10 Task 2，对照 dsh/hermes 的按需注入 skill 思想最小子集）：
//   - 只做文本指令型 skill：markdown + YAML 简表 frontmatter（name/description 必填），
//     无可执行脚本（Global Constraints 边界）；
//   - 两级目录：项目级 <cwd>/.harness2/skills/ 优先于全局 ~/.harness2/skills/
//     （同名项目覆盖 + 告警）；上限 50；坏文件跳过 + 告警；
//   - 列表每 turn 从磁盘重读（项目文件可中途新增/修改），注入侧只取名称+描述；
//     全文经 skill 工具按需加载（load 同样现读磁盘）。
// 隐私边界：skill 内容是用户自己放进仓库/主目录的指令文本，不脱敏、不上传。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 项目/全局 skills 目录名（.harness2/skills） */
export const SKILLS_DIR_NAME = 'skills';

/** skill 数量上限（Global Constraints：超过按名称排序截断 + 告警） */
export const SKILLS_MAX = 50;

/** 项目级 skills 目录（相对 cwd；.harness2/skills） */
export function projectSkillsRoot(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.harness2', SKILLS_DIR_NAME);
}

/** 全局 skills 目录（~/.harness2/skills） */
export function defaultSkillsRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', SKILLS_DIR_NAME);
}

export interface SkillEntry {
  name: string;
  description: string;
  /** 全文原文（含 frontmatter；skill 工具按需加载的就是它） */
  content: string;
  /** 来源文件绝对路径 */
  file: string;
  /** 来源层级（同名时 project 覆盖 global） */
  source: 'project' | 'global';
}

export interface SkillScanResult {
  /** 合并后的 skill 列表（名称排序，≤ SKILLS_MAX） */
  skills: SkillEntry[];
  /** 坏文件/覆盖/超限告警（不阻塞，如实上报注入层） */
  warnings: string[];
}

/**
 * 解析 markdown frontmatter（YAML 简表）：首行 `---` 起、独立 `---` 行止，
 * 逐行 `key: value`（value 去引号）；缺 name/description、name 含空白 → null（坏文件）。
 * 未知键忽略；正文原样保留。
 */
export function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) return null; // frontmatter 未闭合
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closeIndex)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue; // 非 key: value 行忽略
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && !fields.has(key)) fields.set(key, value);
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (name.length === 0 || /\s/.test(name)) return null;
  if (description.length === 0) return null;
  return { name, description };
}

/** 单个 skill 文件 → SkillEntry；解析失败返回 null（调用方记告警） */
function parseSkillFile(file: string, source: 'project' | 'global'): SkillEntry | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(raw);
  if (fm === null) return null;
  return { name: fm.name, description: fm.description, content: raw, file, source };
}

/** 扫描单层目录内的 *.md 文件（目录不存在/未配置 = 空；坏文件跳过并告警） */
function scanLevel(dir: string | undefined, source: 'project' | 'global', warnings: string[]): SkillEntry[] {
  if (dir === undefined || !existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort(); // 排序保证扫描顺序确定
  } catch (e) {
    warnings.push(`skills: ${source} 目录不可读，已跳过: ${(e as Error).message}`);
    return [];
  }
  const entries: SkillEntry[] = [];
  for (const name of files) {
    const file = join(dir, name);
    const entry = parseSkillFile(file, source);
    if (entry === null) {
      warnings.push(`skills: 跳过无效文件 ${file}（需要 markdown frontmatter：name 与 description 必填）`);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Skills 商店：scan()/load() 每次从磁盘重读（不缓存——列表每 turn 刷新的语义在此收口）。
 * projectDir/globalDir 传 undefined 表示跳过该层级（测试可只扫一级）。
 */
export class SkillStore {
  constructor(
    private readonly projectDir?: string,
    private readonly globalDir?: string,
  ) {}

  /** 两级扫描 + 合并（project 同名覆盖 global + 告警）+ 上限截断；不抛错（错误转告警） */
  scan(): SkillScanResult {
    const warnings: string[] = [];
    const global = scanLevel(this.globalDir, 'global', warnings);
    const project = scanLevel(this.projectDir, 'project', warnings);
    const byName = new Map<string, SkillEntry>();
    for (const entry of global) byName.set(entry.name, entry);
    for (const entry of project) {
      if (byName.has(entry.name)) {
        warnings.push(`skills: 项目级 "${entry.name}" 覆盖全局同名（${entry.file}）`);
      }
      byName.set(entry.name, entry);
    }
    const merged = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (merged.length > SKILLS_MAX) {
      const dropped = merged.slice(SKILLS_MAX).map((s) => s.name);
      warnings.push(`skills: 超出上限 ${SKILLS_MAX}，已忽略: ${dropped.join(', ')}`);
      return { skills: merged.slice(0, SKILLS_MAX), warnings };
    }
    return { skills: merged, warnings };
  }

  /** 按名加载全文（现读磁盘）；未知名返回 undefined（工具层转 error） */
  load(name: string): SkillEntry | undefined {
    if (typeof name !== 'string' || name.length === 0) return undefined;
    return this.scan().skills.find((s) => s.name === name);
  }
}

/**
 * 组装进 system 的 Skills 列表区块（仅名称+描述，计划冻结格式；换行分隔）。
 * 空 skills → null（零注入）。
 */
export function assembleSkillsSystemBlock(skills: readonly SkillEntry[]): string | null {
  if (skills.length === 0) return null;
  return ['[Skills 可用]', ...skills.map((s) => `- ${s.name}: ${s.description}`)].join('\n');
}
