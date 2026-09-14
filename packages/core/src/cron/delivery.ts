// cron 投递通道抽象（阶段 7 / H-46）：
// 「任务结果投递到任意平台」的**加性扩展点**——core 只定义目标形状 + 发件信封 + 通道注册表，
// 具体平台网关（telegram/discord/slack/email/web…）由各壳或后续 H-47 拍板后实现，本模块不实现。
//
// 设计约束：
//   - 通道 = 不透明字符串（`'cli'`/`'desktop'`/`'web'`/`'gateway:telegram'`…），core 不认识具体平台；
//   - 未注册通道 → 显式 failed（不静默丢弃），并在投递结果里给出原因；
//   - 信封文本出口过 redactSecrets（任务指令/结果可能夹带密钥，禁止原样外发）；
//   - 投递是 best-effort：失败不得影响任务熔断计数（由 scheduler 决定记账边界）。
import { redactSecrets, redactedSummary } from '../config/redact.js';

/** 任务投递目标：通道 + 通道内地址（地址语义由通道自定义） */
export interface CronDeliveryTarget {
  /** 通道标识（不透明字符串；由壳/网关注册） */
  channel: string;
  /** 通道内目标（频道/会话/收件人 id；缺省 = 通道默认目标） */
  address?: string;
}

/** 投递信封：一次任务执行完成后交给通道的最小信息集 */
export interface CronDeliveryEnvelope {
  jobId: string;
  /** 任务指令（已脱敏 + 截断） */
  instruction: string;
  ok: boolean;
  /** 本次执行的 ISO8601 时刻 */
  ts: string;
  /** 结果落盘目录（本地 history/<id>/<ts>） */
  resultPath: string;
  /** 最终文本摘要（已脱敏 + 截断；无最终文本时缺省） */
  text?: string;
  /** 失败原因（已脱敏） */
  error?: string;
}

export interface CronDeliveryResult {
  ok: boolean;
  /** 失败原因（未注册通道 / 通道抛错 / 通道显式失败均带原因） */
  error?: string;
}

/** 通道实现（由壳/网关注册；H-47 未拍板前 core 不提供任何平台实现） */
export interface CronDeliverySink {
  readonly channel: string;
  deliver(envelope: CronDeliveryEnvelope): CronDeliveryResult | Promise<CronDeliveryResult>;
}

/** 信封文本上限（防超长结果刷屏/触发平台限长） */
export const CRON_DELIVERY_TEXT_MAX = 2000;

/** 目标合法性：channel 必须非空字符串；address 若在则必须是非空字符串 */
export function validateDeliveryTarget(target: CronDeliveryTarget | undefined): string | null {
  if (target === undefined) return null;
  if (typeof target.channel !== 'string' || target.channel.trim().length === 0) {
    return '投递通道 channel 必须是非空字符串';
  }
  if (target.address !== undefined && (typeof target.address !== 'string' || target.address.trim().length === 0)) {
    return '投递地址 address 必须是非空字符串';
  }
  return null;
}

/** 组装对外信封：指令/文本/错误统一脱敏 + 截断（通道实现不负责脱敏，这是最后闸门） */
export function buildDeliveryEnvelope(input: CronDeliveryEnvelope): CronDeliveryEnvelope {
  return {
    jobId: input.jobId,
    instruction: redactedSummary(input.instruction, 300),
    ok: input.ok,
    ts: input.ts,
    resultPath: redactSecrets(input.resultPath),
    ...(input.text !== undefined ? { text: redactedSummary(input.text, CRON_DELIVERY_TEXT_MAX) } : {}),
    ...(input.error !== undefined ? { error: redactedSummary(input.error, 300) } : {}),
  };
}

/**
 * 通道注册表：channel → sink。同一通道重复注册以最后一次为准（壳热重载语义）。
 * 未注册通道投递 → { ok:false, error:'未注册投递通道: <channel>' }（不抛错，best-effort）。
 */
export class CronDeliveryDispatcher {
  private readonly sinks = new Map<string, CronDeliverySink>();

  constructor(sinks: readonly CronDeliverySink[] = []) {
    for (const sink of sinks) this.register(sink);
  }

  register(sink: CronDeliverySink): void {
    if (typeof sink.channel !== 'string' || sink.channel.trim().length === 0) {
      throw new Error('CronDeliverySink.channel 必须是非空字符串');
    }
    this.sinks.set(sink.channel, sink);
  }

  unregister(channel: string): boolean {
    return this.sinks.delete(channel);
  }

  channels(): string[] {
    return [...this.sinks.keys()].sort();
  }

  has(channel: string): boolean {
    return this.sinks.has(channel);
  }

  /** 投递（best-effort）：未注册/通道抛错都归一为 failed 结果，不外抛 */
  async deliver(target: CronDeliveryTarget, envelope: CronDeliveryEnvelope): Promise<CronDeliveryResult> {
    const invalid = validateDeliveryTarget(target);
    if (invalid !== null) return { ok: false, error: invalid };
    const sink = this.sinks.get(target.channel);
    if (sink === undefined) {
      return { ok: false, error: `未注册投递通道: ${target.channel}` };
    }
    const outbound = buildDeliveryEnvelope(envelope);
    try {
      const result = await sink.deliver(outbound);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? '通道投递失败' };
    } catch (e) {
      return { ok: false, error: redactedSummary((e as Error)?.message ?? String(e), 300) };
    }
  }
}
