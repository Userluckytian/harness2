// P0-3a 自动化（cron）数据源（桌面主进程 fs 只读扫描，A08 skills-scan 同族）：
//   - cron 任务表在**本地文件** `~/.harness2/cron/jobs.json`（serve 无 cron HTTP 端点：调度只在
//     `harness2 cron` 命令进程内跑），桌面主进程用 core 的**同一 CronJobStore.list()** 读取
//     （与 CLI `cron list` 同口径、单一事实源，不重写解析）；
//   - **只读**：只 list，不增删改不启停（core CronJobStore 也没有面向壳的启停 API；改任务走 CLI）；
//   - 不抛错：任何异常转空表 + console 如实告警（core list 本身对「文件缺失/损坏 JSON」已返回空表，
//     这里兜的是权限/IO 等更外层异常——坏数据不得让右栏崩掉，也不静默吞掉）；
//   - 红线⑩：返回即真实磁盘状态，不做缓存假装实时，不摆假数据；投递目标 `deliver` 属执行细节、
//     右栏不展示 → 不入 `CronJobShape`（协议注释同口径）。
import { CronJobStore, defaultCronRoot } from './core.js';
import type { CronJobShape } from '../shared/protocol.js';

export function readCronJobs(home: string): CronJobShape[] {
  try {
    // CLI 先例（cli/src/commands/cron.ts）逐字同构：new CronJobStore(defaultCronRoot(home)).list()
    return new CronJobStore(defaultCronRoot(home)).list();
  } catch (e) {
    console.warn('[cron-list] 读取 jobs.json 失败，按空表呈现:', e);
    return [];
  }
}
