/**
 * boot-timing —— ZS5-T4 启动分段计时纯逻辑（可单测，不依赖 Electron）。
 *
 * 目标：把 host 启动的 4 个里程碑打点成一行结构化文本，经 host 现有日志通道
 * （HostResponseTypes.Log → main 侧 hostLogRelay 落盘）输出：
 *
 *   [h2-boot-timing] <milestone> +<ms>ms
 *
 * 里程碑（host-entry.ts 调用处）：
 *   module_load        —— 进程模块加载（最早，InitLocal 前；日志通道不可用时降级 console）
 *   init_local         —— 收到 InitLocal
 *   database_ready     —— DatabaseStartupState ready 发布
 *   services_ready     —— ChannelServer 服务注册完成
 *
 * ms 为自 origin（模块加载时刻）起的单调毫秒；保证非负整数、时序单调。
 *
 * 设计：纯函数 + 注入缝（now/origin/emit），单测 mock 日志收集器即可验证里程碑顺序与毫秒字段，
 * 不真起 Electron。emit 抛错被吞，绝不影响 host 生命周期。
 */
export const BOOT_TIMING_PREFIX = '[h2-boot-timing]';

export interface BootTimingMilestoneRecord {
  name: string;
  ms: number;
}

export interface BootTimingOptions {
  /** 单调时钟（默认 performance.now / Date.now） */
  now?: () => number;
  /** 基线时刻（默认 now() 调用时） */
  origin?: number;
  /** 输出 sink（每打一个点调用一次，传入完整行文本） */
  emit?: (line: string) => void;
}

export interface BootTiming {
  origin: number;
  milestones: BootTimingMilestoneRecord[];
  mark(name: string): number;
  elapsed(): number;
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function formatBootTimingLine(name: string, ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  return `${BOOT_TIMING_PREFIX} ${name} +${safe}ms`;
}

export function createBootTiming(options: BootTimingOptions = {}): BootTiming {
  const now = options.now ?? defaultNow;
  const origin = typeof options.origin === 'number' ? options.origin : now();
  const emit = options.emit;
  const milestones: BootTimingMilestoneRecord[] = [];

  function mark(name: string): number {
    let ms = 0;
    try {
      ms = now() - origin;
    } catch {
      ms = 0;
    }
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    ms = Math.round(ms);
    milestones.push({ name, ms });
    const line = formatBootTimingLine(name, ms);
    if (typeof emit === 'function') {
      try {
        emit(line);
      } catch {
        // 打点失败不影响 host 生命周期
      }
    }
    return ms;
  }

  return {
    origin,
    milestones,
    mark,
    elapsed: () => {
      try {
        const v = now() - origin;
        return Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * 独立函数形式（便于不持有实例的调用方）：给定基线/当前时刻/输出 sink，打一个点。
 * 返回该点的毫秒数。
 */
export function recordBootMilestone(name: string, origin: number, now: number, emit: (line: string) => void): number {
  const ms = Number.isFinite(now - origin) ? Math.max(0, Math.round(now - origin)) : 0;
  const line = formatBootTimingLine(name, ms);
  try {
    emit(line);
  } catch {
    // ignore
  }
  return ms;
}

/**
 * 从一行日志文本中解析里程碑名与毫秒数；解析失败返回 null。
 * 供测试/读取脚本复用。
 */
export function parseBootTimingLine(line: string): { name: string; ms: number } | null {
  const m = line.match(/\[h2-boot-timing\]\s+(\S+)\s+\+(\d+)ms/);
  if (!m) return null;
  return { name: m[1], ms: Number(m[2]) };
}
