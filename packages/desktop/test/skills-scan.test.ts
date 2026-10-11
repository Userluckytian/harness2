// A08 主进程技能扫描测试：readSkillsSummary 与 core serve 装配同一 SkillStore 实现——
// 两级扫描（项目覆盖全局 + .agents 兜底）、坏文件转告警、目录缺失转空表（不抛错）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillsSummary } from '../src/main/skills-scan.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-skills-scan-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
/** 隔离真实的 ~/.agents/skills 兜底目录（SkillStore 对标准布局自动推导）：注入不存在的路径 = 兜底关闭 */
function isolatedAgents(): { agentsProjectDir: string; agentsGlobalDir: string } {
  const off = join(tmpDir('h2-skills-noagents-'), 'none');
  return { agentsProjectDir: off, agentsGlobalDir: off };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSkill(dir: string, rel: string, name: string, description: string): void {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nbody`, 'utf8');
}

describe('readSkillsSummary（A08 数据通道）', () => {
  it('两级扫描 + 项目级覆盖全局级 + 路径与层级如实上报', () => {
    const root = tmpDir();
    const home = tmpDir();
    // 项目级 skills 根 = <root>/.harness2/skills；全局级 = <home>/.harness2/skills
    writeSkill(join(root, '.harness2', 'skills'), 'shared.md', 'shared', 'project wins');
    writeSkill(join(root, '.harness2', 'skills'), 'proj-only.md', 'proj-only', '项目专属');
    writeSkill(join(home, '.harness2', 'skills'), 'shared.md', 'shared', 'global loses');
    writeSkill(join(home, '.harness2', 'skills'), 'deploy', 'deploy', '发布流程'); /* 目录型：见下 */
    // 目录型（<name>/SKILL.md）：上面的 writeSkill 写的是 deploy 文件（无扩展名，会被忽略），补正：
    rmSync(join(home, '.harness2', 'skills', 'deploy'), { force: true });
    writeSkill(join(home, '.harness2', 'skills'), join('deploy', 'SKILL.md'), 'deploy', '发布流程');

    const r = readSkillsSummary(home, root, isolatedAgents());
    expect(r.skills.map((s) => s.name).sort()).toEqual(['deploy', 'proj-only', 'shared']);
    const shared = r.skills.find((s) => s.name === 'shared')!;
    expect(shared.source).toBe('project'); // 项目级覆盖全局级（与 core SkillStore 同口径）
    expect(shared.file).toBe(join(root, '.harness2', 'skills', 'shared.md'));
    expect(shared.description).toBe('project wins');
    const deploy = r.skills.find((s) => s.name === 'deploy')!;
    expect(deploy.source).toBe('global');
    expect(deploy.file).toBe(join(home, '.harness2', 'skills', 'deploy', 'SKILL.md'));
    expect(r.roots.project).toBe(join(root, '.harness2', 'skills'));
    expect(r.roots.global).toBe(join(home, '.harness2', 'skills'));
    // 跨级覆盖告警文案由 core SkillStore 唯一产出（与 core/test/skills.test.ts 同口径：断言子串，
    // 括号内是获胜的项目级文件路径），此处只验证告警确实透传，不重复 core 的路径细节
    expect(r.warnings.some((w) => w.includes('项目级 "shared" 覆盖全局同名'))).toBe(true);
  });

  it('目录缺失/坏文件 → 空表或转告警，不抛错', () => {
    const root = tmpDir();
    const home = tmpDir();
    // 两级目录都不存在（兜底目录也隔离）→ 空列表（不抛）
    const empty = readSkillsSummary(home, root, isolatedAgents());
    expect(empty.skills).toEqual([]);
    expect(empty.warnings).toEqual([]);
    // 坏文件（缺 description frontmatter）→ 跳过 + 告警
    writeSkill(join(root, '.harness2', 'skills'), 'bad.md', 'bad', '');
    rmSync(join(root, '.harness2', 'skills', 'bad.md'));
    writeFileSync(join(root, '.harness2', 'skills', 'bad.md'), 'no frontmatter', 'utf8');
    const r = readSkillsSummary(home, root, isolatedAgents());
    expect(r.skills).toEqual([]);
    expect(r.warnings.join('\n')).toContain('跳过无效文件');
  });
});
