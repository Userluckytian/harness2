// P0：自动化（cron）**新增**任务（桌面主进程写路径，cron-list.ts 的写侧先例）。
//   - 复用 core 的同一 CronJobStore（与 CLI `harness2 cron add` 同口径、单一事实源，不重写解析）；
//   - `CronJobStore.add(instruction, schedule)` 内部会校验 instruction 非空与 schedule 合法性
//     （非法抛 CronError）、并执行任务上限（CRON_MAX_JOBS）；本模块**吞掉异常**是错的——非法输入必须
//     如实回给渲染端（IPC reject），由调用方决定提示，故这里直接透传异常（不静默、不假装成功）；
//   - 返回新建任务（与 core 同形 CronJob，投递目标 deliver 不入形状，与 cron-list 同口径）。
import { CronJobStore, defaultCronRoot } from './core.js';
import type { CronJobShape } from '../shared/protocol.js';

/** 新增定时任务：instruction + schedule（调度非法/超上限/instruction 为空 → 抛错，如实回传）。 */
export function addCronJob(home: string, instruction: string, schedule: string): CronJobShape {
  return new CronJobStore(defaultCronRoot(home)).add(instruction, schedule);
}
