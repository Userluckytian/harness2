// packages/cli/src/commands/cron.ts
// B3-1 拆分产物：原 index.ts 第 499–633 行逐字搬入，零逻辑改动。
// cron 命令（阶段 7）：定时任务的增删查/手工执行/历史。数据在 ~/.harness2/cron（用户数据，不入 git）。
import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  CronJobStore,
  CronScheduler,
  createApprovalPolicy,
  createProvider,
  defaultConfigPaths,
  defaultCronRoot,
  loadConfig,
  registerBuiltinTools,
  ToolRegistry,
  type ChatProvider,
} from '@harness2/core';

export function registerCronCommand(program: Command): void {
  /** cron 命令（阶段 7）：定时任务的增删查/手工执行/历史。数据在 ~/.harness2/cron（用户数据，不入 git）。 */
  const cronCmd = new Command('cron').description('定时任务管理（serve 运行期间到点自动执行）');

  interface CronHomeOptions {
    home?: string;
  }

  cronCmd
    .command('list')
    .description('列出全部任务（id/调度/下次执行/启用/连续失败）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((opts: CronHomeOptions) => {
      const jobs = new CronJobStore(defaultCronRoot(opts.home)).list();
      if (jobs.length === 0) {
        console.log('（无任务）');
        return;
      }
      for (const j of jobs) {
        const instruction = j.instruction.replace(/\s+/g, ' ').slice(0, 60);
        console.log(
          `${j.id}  ${j.schedule}  next=${j.nextRun}${j.enabled ? '' : ' [已熔断/disabled]'}  fail=${j.failCount}`,
        );
        console.log(`  ${instruction}`);
      }
    });

  cronCmd
    .command('add')
    .description('新增任务：harness2 cron add "指令" --every 5m | --at "daily 09:00"')
    .argument('<instruction>', '发给模型的指令')
    .option('--every <spec>', '间隔调度："5m"/"2h"/"1d"（最小 1 分钟）')
    .option('--at <spec>', '每日调度："daily HH:MM"（本地时区）')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((instruction: string, opts: CronHomeOptions & { every?: string; at?: string }) => {
      if (Boolean(opts.every) === Boolean(opts.at)) {
        console.error('error: --every 与 --at 必须二选一');
        process.exit(1);
      }
      const schedule = opts.every ?? opts.at!;
      try {
        const job = new CronJobStore(defaultCronRoot(opts.home)).add(instruction, schedule);
        console.log(`已添加 ${job.id}  ${job.schedule}  首次执行 ${job.nextRun}`);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cronCmd
    .command('remove')
    .description('删除任务')
    .argument('<id>', '任务 id')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((id: string, opts: CronHomeOptions) => {
      if (!new CronJobStore(defaultCronRoot(opts.home)).remove(id)) {
        console.error(`error: 未找到任务 ${id}`);
        process.exit(1);
      }
      console.log(`已删除 ${id}`);
    });

  cronCmd
    .command('run')
    .description('立即执行一次（不动 nextRun/熔断计数；结果写 history）')
    .argument('<id>', '任务 id')
    .option('--home <dir>', '覆盖用户数据根（配置 + cron 存储）')
    .option('--root <dir>', '工具执行 cwd（默认当前目录）')
    .action(async (id: string, opts: CronHomeOptions & { root?: string }) => {
      const root = opts.root ?? process.cwd();
      const loaded = loadConfig({ root, ...(opts.home !== undefined ? { home: opts.home } : {}) });
      if (loaded.config === null) {
        console.error(`error: ${loaded.errors[0] ?? 'config 未加载成功'}`);
        process.exit(1);
      }
      let provider: ChatProvider;
      try {
        const paths = defaultConfigPaths(root, opts.home);
        provider = createProvider(loaded.config, 'main', { authPath: paths.globalAuth });
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
      const tools = new ToolRegistry();
      registerBuiltinTools(tools);
      const scheduler = new CronScheduler({
        root: defaultCronRoot(opts.home),
        cwd: root,
        provider,
        toolsForSession: () => tools,
        // P1-1（阶段 7 审查）：与 serve 调度路径同语义——手工执行同样走审批策略，
        // unsafe 工具不再 allow-all；ask 无人工通道 → 执行器按拒绝处理
        decide: createApprovalPolicy(loaded.config.approval).decide,
        fsync: false,
      });
      const outcome = await scheduler.runOnce(id);
      if (outcome === null) {
        console.error(`error: 未找到任务 ${id}`);
        process.exit(1);
      }
      console.log(
        outcome.ok ? `执行完成：${outcome.dir}` : `执行失败：${outcome.error ?? outcome.stopReason}（${outcome.dir}）`,
      );
      process.exitCode = outcome.ok ? 0 : 1;
    });

  cronCmd
    .command('history')
    .description('查看任务执行历史（最近 20 次；含 result.md 摘要）')
    .argument('<id>', '任务 id')
    .option('--home <dir>', '覆盖用户数据根（测试/多环境用）')
    .action((id: string, opts: CronHomeOptions) => {
      const historyDir = join(defaultCronRoot(opts.home), 'history', id);
      if (!existsSync(historyDir)) {
        console.log('（无历史）');
        return;
      }
      const runs = readdirSync(historyDir).sort().reverse().slice(0, 20);
      if (runs.length === 0) {
        console.log('（无历史）');
        return;
      }
      for (const run of runs) {
        let summary = '(result.md 缺失)';
        try {
          const text = readFileSync(join(historyDir, run, 'result.md'), 'utf8');
          summary = text.split('\n').find((l) => l.startsWith('- stopReason') || l.startsWith('- error')) ?? summary;
        } catch {
          // result.md 缺失照实展示
        }
        console.log(`${run}${sep}  ${summary}`);
      }
    });

  program.addCommand(cronCmd);
}
