// packages/cli/src/commands/skill.ts
// B3-1 拆分产物：原 index.ts 第 415–437 行逐字搬入，零逻辑改动。
// skill 命令（阶段 10）：项目级 Skills 查看（两级扫描合并）。
// P7-A（2026-09-14）加性：经验造技能审批入口（propose / pending / approve / reject）——
// 与 `harness2 memory pending|approve|reject` 同风格；模型经 skill_author 只提案，
// 落盘一律走这里的人工审批（approve 才写 <root>/.harness2/skills/<name>/SKILL.md）。
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { SkillAuthoringStore, SkillStore, defaultSkillsRoot, projectSkillsRoot } from '@harness2/core';

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

  // —— P7-A H-22 经验造技能审批入口（对齐 memory approve <id> 风格）——

  /** 造技能商店：root = 项目级技能目录（与 skill list 同源） */
  const authoringStore = (opts: { root?: string }): SkillAuthoringStore =>
    new SkillAuthoringStore(projectSkillsRoot(opts.root));

  skillCmd
    .command('propose')
    .description('提交一份技能提案（只暂存，不落盘；approve 才写入 SKILL.md）')
    .requiredOption('--name <name>', '技能名（slug：^[a-z0-9][a-z0-9._-]{0,63}$）')
    .requiredOption('--description <text>', '一句话描述（进常驻技能索引，不含换行）')
    .option('--body <text>', 'markdown 正文（与 --body-file 二选一）')
    .option('--body-file <path>', '从文件读 markdown 正文（与 --body 二选一）')
    .option('--from <ids>', '来源会话 id（逗号分隔，记为 derivedFrom）')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .action(
      async (opts: {
        name: string;
        description: string;
        body?: string;
        bodyFile?: string;
        from?: string;
        root?: string;
      }) => {
        let body = opts.body;
        if (opts.bodyFile !== undefined) {
          if (body !== undefined) {
            console.error('error: --body 与 --body-file 只能给一个');
            process.exit(1);
          }
          try {
            body = readFileSync(opts.bodyFile, 'utf8');
          } catch (e) {
            console.error(`error: 读取 --body-file 失败: ${(e as Error).message}`);
            process.exit(1);
          }
        }
        if (body === undefined || body.trim().length === 0) {
          console.error('error: 缺少正文（--body 或 --body-file）');
          process.exit(1);
        }
        const derivedFrom = (opts.from ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const store = authoringStore(opts);
        const r = await store.propose({
          name: opts.name,
          description: opts.description,
          body,
          ...(derivedFrom.length > 0 ? { derivedFrom } : {}),
        });
        if (!r.ok || r.proposal === undefined) {
          console.error(`error: ${r.error ?? '提案未生成'}`);
          process.exit(1);
        }
        const proposal = r.proposal;
        console.log(`已提交待审批提案 ${proposal.id}（${proposal.action} ${proposal.name}）`);
        console.log(`  审批通过：harness2 skill approve ${proposal.id}`);
      },
    );

  skillCmd
    .command('pending')
    .description('列出待审批的技能提案（skill_author 暂存，先到先审）')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .action(async (opts: { root?: string }) => {
      const items = await authoringStore(opts).list();
      if (items.length === 0) {
        console.log('（无待审批技能提案）');
        return;
      }
      for (const p of items) {
        console.log(`${p.id}  ${p.createdAt}  ${p.action}  ${p.name}`);
        console.log(`  file: ${p.file}`);
      }
    });

  skillCmd
    .command('approve')
    .description('批准并原子写入一条技能提案（体积/密钥/路径围栏重新校验，失败保留暂存）')
    .argument('<id>', '待审批提案 id')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .action(async (id: string, opts: { root?: string }) => {
      const r = await authoringStore(opts).approve(id);
      if (!r.ok || r.proposal === undefined) {
        console.error(`error: ${r.error ?? '提案未生成'}`);
        process.exit(1);
      }
      console.log(`已写入 ${r.path ?? r.proposal.file}`);
    });

  skillCmd
    .command('reject')
    .description('拒绝并丢弃一条技能提案（不落盘）')
    .argument('<id>', '待审批提案 id')
    .option('--root <dir>', '项目根目录（默认当前目录）')
    .action(async (id: string, opts: { root?: string }) => {
      const ok = await authoringStore(opts).reject(id);
      if (!ok) {
        console.error(`error: 未找到待审批提案 ${id}`);
        process.exit(1);
      }
      console.log(`已丢弃 ${id}`);
    });

  program.addCommand(skillCmd);
}
