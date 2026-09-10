// packages/cli/src/commands/skill.ts
// B3-1 拆分产物：原 index.ts 第 415–437 行逐字搬入，零逻辑改动。
// skill 命令（阶段 10）：项目级 Skills 查看（两级扫描合并）。
import { Command } from 'commander';
import { SkillStore, defaultSkillsRoot, projectSkillsRoot } from '@harness2/core';

export function registerSkillCommand(program: Command): void {
  /** skill 命令（阶段 10）：项目级 Skills 查看。skill 全文按需经模型侧 skill 工具加载。 */
  const skillCmd = new Command('skill').description('项目级 Skills 管理（.harness2/skills/ 与 ~/.harness2/skills/）');

  skillCmd
    .command('list')
    .description('列出两级扫描合并后的 skills（名称/来源/描述；同名项目覆盖全局）')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((opts: { root?: string; home?: string }) => {
      const store = new SkillStore(projectSkillsRoot(opts.root), defaultSkillsRoot(opts.home));
      const scan = store.scan();
      if (scan.skills.length === 0) {
        console.log('（无 skill——把带 frontmatter 的 .md 放进 .harness2/skills/ 或 ~/.harness2/skills/）');
        return;
      }
      for (const s of scan.skills) {
        console.log(`${s.name}  [${s.source}]  ${s.description}`);
      }
      for (const w of scan.warnings) console.error(`warning: ${w}`);
    });

  program.addCommand(skillCmd);
}
