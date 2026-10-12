// P0-3a 自动化（cron）右栏 tab 的**纯逻辑**（浏览器壳零 Node，故不 import @harness2/core）：
//   - 形状 `CronJobShape` 来自跨壳线协议 `shared/protocol.js`（与 core `cron/jobs.ts CronJob` 同形，
//     桌面主进程读本地 jobs.json 后投影、经 IPC `cron:list` 送出；投递目标 `deliver` 不展示故不入形状）；
//   - `describeScheduleDisplay`：调度表达式的**展示专用**中文回显（镜像 core `describeSchedule` 的三条
//     正则与文案，但**绝不抛错**——非法表达式原样返回，坏数据不得让整列崩掉，红线⑩如实展示）；
//   - `automationStatusOf`：状态徽标的色调/文案（连续失败 ≥3 且已停用 → 「已熔断」如实，对齐 core
//     熔断语义 `failCount>=3 → enabled=false`）；
//   - `nextRunDisplay`：nextRun（ISO）相对当前时刻的人话（未来「N 分/时/天后」、过去「N 分/时/天前」、
//     无法解析 → 原样，不猜）。
// 边界：本模块纯函数、无 React、无计时、无浏览器 API；`nowMs` 由调用方注入便于单测钉边界。

/** cron 形状的唯一事实源在跨壳线协议里；这里再导出，令面板只依赖 side-pane 模块。 */
export type { CronJobShape } from '../../shared/protocol.js';
import type { CronJobShape } from '../../shared/protocol.js';

// —— 调度展示正则（与 core `cron/jobs.ts` 的解析口径逐字同构，仅用于回显，不做校验） ——
const INTERVAL_PATTERN = /^(\d+)([mhd])$/;
const DAILY_PATTERN = /^daily (\d{1,2}):(\d{2})$/;
const WEEKLY_PATTERN = /^weekly ([0-6](?:,[0-6])*) (\d{1,2}):(\d{2})$/;
const ZH_WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 调度表达式的用户可读中文回显（展示专用，绝不抛错）。
 * 与 core `describeSchedule` 同文案；差异仅在于本函数对**非法表达式**原样返回（core 会抛 CronError）——
 * 右栏列表只负责如实展示磁盘上真实存在的 schedule 串，坏数据不得让整列崩掉。
 */
export function describeScheduleDisplay(spec: string): string {
  const trimmed = spec.trim();
  const interval = INTERVAL_PATTERN.exec(trimmed);
  if (interval !== null) {
    const n = Number(interval[1] ?? '');
    const unit = interval[2];
    const minutes = unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440;
    if (minutes > 0 && minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
    if (minutes > 0 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
    return `每 ${minutes} 分钟`;
  }
  const daily = DAILY_PATTERN.exec(trimmed);
  if (daily !== null) {
    const hour = Number(daily[1] ?? '');
    const minute = Number(daily[2] ?? '');
    if (hour > 23 || minute > 59) return spec; // 越界：core 会抛，此处如实原样
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return `每天 ${hhmm}`;
  }
  const weekly = WEEKLY_PATTERN.exec(trimmed);
  if (weekly !== null) {
    const days = (weekly[1] ?? '').split(',').map(Number);
    const hour = Number(weekly[2] ?? '');
    const minute = Number(weekly[3] ?? '');
    if (hour > 23 || minute > 59) return spec;
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const names = days.map((d) => ZH_WEEKDAY[d] ?? String(d)).join('、');
    return `每周${names} ${hhmm}`;
  }
  return spec; // 未知格式：原样，不猜不编
}

/** 状态徽标色调（模型层只出色调，类名集中在 pane） */
export type AutomationStatusTone = 'active' | 'fused' | 'disabled' | 'failing';

export interface AutomationStatus {
  readonly tone: AutomationStatusTone;
  readonly label: string;
}

/**
 * 任务状态徽标（连续失败 ≥3 且已停用 → 「已熔断」如实；对齐 core 熔断语义）。
 * 优先级：熔断 > 失败中（仍启用但 failCount>0）> 已停用（人工停用，failCount<3）> 启用中。
 */
export function automationStatusOf(job: CronJobShape): AutomationStatus {
  if (!job.enabled && job.failCount >= 3) return { tone: 'fused', label: '已熔断' };
  if (job.enabled && job.failCount > 0) return { tone: 'failing', label: `连续失败 ${job.failCount}` };
  if (!job.enabled) return { tone: 'disabled', label: '已停用' };
  return { tone: 'active', label: '启用中' };
}

/**
 * nextRun（ISO）相对 `nowMs` 的人话。无法解析的日期串原样返回（不猜）。
 * 未来 → 「N 分/时/天后」；过去 → 「N 分/时/天前」（已逾期如实以过去时呈现）；不足 1 分钟 → 「即将」。
 */
export function nextRunDisplay(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const deltaMs = at - nowMs;
  const abs = Math.abs(deltaMs);
  const minutes = Math.floor(abs / 60_000);
  const suffix = deltaMs >= 0 ? '后' : '前';
  if (minutes < 1) return deltaMs >= 0 ? '即将' : '1分钟内';
  if (minutes < 60) return `${minutes} 分钟${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days} 天${suffix}`;
}
