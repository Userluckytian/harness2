// H-46 自然语言定时任务解析（阶段 7）：
//   自然语言（中英）→ 调度规格（packages/core/src/cron/jobs.ts 的 parseSchedule 规格）。
//   可注入 provider（有模型时用模型）+ 确定性规则兜底（无模型/模型失败/模型输出非法时）。
//
// 红线：
//   1) **不静默落盘**——解析只产出 draft + 回显文案，必须经调用方（壳）向用户确认后
//      由 confirmCronDraft/addCronJobFromNatural(confirmed=true) 才写盘；
//   2) 模型输出**不可信**：provider 返回的 schedule 必须过 parseSchedule 校验，非法即丢弃并回落规则；
//   3) 模糊输入明确拒绝并给可用形态提示（宁可拒绝，不可猜错）。
import {
  computeNextRun,
  CronError,
  describeSchedule,
  parseSchedule,
  type CronJob,
  type CronJobStore,
  type ParsedSchedule,
} from './jobs.js';
import type { CronDeliveryTarget } from './delivery.js';

// —— provider 缝 ——

export interface NaturalScheduleCandidate {
  /** 候选调度规格（必须是 parseSchedule 认识的形态） */
  schedule: string;
  /** 可选：provider 自报置信度（low 仍可用，但壳应更醒目地回显确认） */
  confidence?: 'high' | 'low';
  /** 可选：provider 的解释（仅回显用，不进规格） */
  note?: string;
}

export interface NaturalScheduleParseRequest {
  text: string;
  now: Date;
}

/** 「自然语言 → 调度规格」的模型 provider 缝：有模型时注入，无模型时走规则兜底 */
export interface CronNaturalParseProvider {
  readonly name: string;
  parse(
    request: NaturalScheduleParseRequest,
  ): NaturalScheduleCandidate | null | undefined | Promise<NaturalScheduleCandidate | null | undefined>;
}

export type CronScheduleSource = 'provider' | 'rules';

export interface CronScheduleInterpretation {
  ok: true;
  /** 原始输入 */
  text: string;
  /** 规范化调度规格（落盘用） */
  schedule: string;
  /** 用户可读回显（中文） */
  display: string;
  source: CronScheduleSource;
  providerName?: string;
  /** 按 now 预演的下次执行（ISO8601 UTC） */
  nextRun: string;
}

export interface CronScheduleFailure {
  ok: false;
  text: string;
  /** 拒绝原因 */
  reason: string;
  /** 可用形态提示（壳原样展示） */
  hint: string;
}

export type CronScheduleInterpretationResult = CronScheduleInterpretation | CronScheduleFailure;

/** 规则兜底支持的形态说明（失败提示与文档共用） */
export const CRON_NATURAL_HINT =
  '可用形态示例：每 5 分钟 / 每 2 小时 / 每 1 天（英文 every 5 minutes）/ 每天 09:00 或 每天上午9点 / ' +
  '工作日 09:00（workdays at 9am）/ 每周一、周三 09:00（every monday and wednesday at 9am）/' +
  '或直接给规格 "5m"、"daily 09:00"、"weekly 1,3 09:00"。';

export interface CronNaturalOptions {
  /** 模型 provider（有模型时优先；失败/非法自动回落规则） */
  provider?: CronNaturalParseProvider;
  /** 时间基准（测试注入） */
  now?: Date;
}

// —— 文本规范化 ——

const FULL_WIDTH_DIGITS = /[０-９]/g;
const ZH_PUNCT: Record<string, string> = {
  '，': ',',
  '。': '.',
  '；': ';',
  '、': ',',
  '！': '!',
  '？': '?',
  '：': ':',
};

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(FULL_WIDTH_DIGITS, (c) => String(c.charCodeAt(0) - 0xff10))
    .replace(/[，。；、！？：]/g, (c) => ZH_PUNCT[c] ?? c)
    .replace(/[（(]\s*推荐\s*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// —— 中小时刻 ——

interface Clock {
  hour: number;
  minute: number;
}

const ZH_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 阿拉伯数字或中文数字（支持 十/十五/二十/二十三/三十）→ number；无法解析返回 null */
export function parseZhNumber(raw: string): number | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [tensRaw = '', onesRaw = ''] = s.split('十');
    const tens = tensRaw === '' ? 1 : (ZH_DIGIT[tensRaw] ?? NaN);
    const ones = onesRaw === '' ? 0 : (ZH_DIGIT[onesRaw] ?? NaN);
    if (Number.isNaN(tens) || Number.isNaN(ones)) return null;
    return tens * 10 + ones;
  }
  if (s.length === 1) return ZH_DIGIT[s] ?? null;
  return null;
}

const EN_TIME_AMPM = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/;
const EN_TIME_24 = /\b(\d{1,2}):(\d{2})\b/;
const EN_TIME_WORD = /\b(noon|midday|midnight)\b/;
const ZH_MERIDIEM = '凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜晚';
const ZH_TIME = new RegExp(
  `(?:${ZH_MERIDIEM})?\\s*([0-9零一二两三四五六七八九十]{1,3})\\s*[点时]\\s*(半|[0-9零一二两三四五六七八九十]{1,3}\\s*分?)?`,
);

function isValidClock(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59;
}

/** 从文本中抽取时刻（英/中）；找不到返回 null */
export function extractClock(text: string): Clock | null {
  const ampm = EN_TIME_AMPM.exec(text);
  if (ampm) {
    const hour12 = Number(ampm[1]);
    const minute = ampm[2] === undefined ? 0 : Number(ampm[2]);
    const meridiem = ampm[3];
    if (hour12 >= 1 && hour12 <= 12) {
      const hour = (hour12 % 12) + (meridiem === 'pm' ? 12 : 0);
      if (isValidClock(hour, minute)) return { hour, minute };
    }
  }
  const word = EN_TIME_WORD.exec(text);
  if (word) {
    if (word[1] === 'midnight') return { hour: 0, minute: 0 };
    return { hour: 12, minute: 0 };
  }
  const time24 = EN_TIME_24.exec(text);
  if (time24) {
    const hour = Number(time24[1]);
    const minute = Number(time24[2]);
    if (isValidClock(hour, minute)) return { hour, minute };
  }
  const zh = ZH_TIME.exec(text);
  if (zh) {
    const hourRaw = parseZhNumber(zh[1]!);
    if (hourRaw !== null) {
      const minutePart = zh[2];
      const minute =
        minutePart === undefined || minutePart.trim().length === 0
          ? 0
          : minutePart.trim() === '半'
            ? 30
            : (parseZhNumber(minutePart.replace(/分/g, '')) ?? 0);
      const meridiem = zh[0].match(new RegExp(`^(${ZH_MERIDIEM})`))?.[1];
      let hour = hourRaw;
      if (meridiem === '凌晨' || meridiem === '清晨') {
        hour = hourRaw % 12;
      } else if (meridiem === '早上' || meridiem === '早晨' || meridiem === '上午') {
        hour = hourRaw === 12 ? 0 : hourRaw;
      } else if (meridiem === '中午') {
        hour = hourRaw === 12 ? 12 : hourRaw + 12;
      } else if (meridiem !== undefined) {
        hour = hourRaw === 12 ? 12 : hourRaw < 12 ? hourRaw + 12 : hourRaw;
      }
      if (isValidClock(hour, minute)) return { hour, minute };
    }
  }
  return null;
}

// —— 星期解析 ——

const EN_WEEKDAY: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};
const EN_WEEKDAY_RE = new RegExp(`\\b(${Object.keys(EN_WEEKDAY).join('|')})\\b`, 'g');

const ZH_WEEKDAY_CHAR: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

interface DaySpec {
  kind: 'daily' | 'days';
  days?: readonly number[];
}

/** 抽取「哪几天」：每天 / 工作日 / 周末 / 具名星期；找不到返回 null */
export function extractDaySpec(text: string): DaySpec | null {
  if (/(每天|每日|天天|every\s+day|each\s+day|\bdaily\b)/.test(text)) return { kind: 'daily' };
  if (/(每个工作日|工作日|周一至周五|周一到周五|星期一至星期五|星期一至周五|weekdays?)/.test(text)) {
    return { kind: 'days', days: [1, 2, 3, 4, 5] };
  }
  if (/(每个周末|周末|双休|weekends?)/.test(text)) return { kind: 'days', days: [0, 6] };
  const days = new Set<number>();
  for (const m of text.matchAll(EN_WEEKDAY_RE)) {
    const day = EN_WEEKDAY[m[1]!];
    if (day !== undefined) days.add(day);
  }
  for (const m of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])/g)) {
    const day = ZH_WEEKDAY_CHAR[m[1]!];
    if (day !== undefined) days.add(day);
  }
  if (days.size === 0) return null;
  return { kind: 'days', days: [...days].sort((a, b) => a - b) };
}

// —— 间隔解析 ——

interface IntervalSpec {
  minutes: number;
}

const ZH_INTERVAL = /^(每隔|每)(?:隔)?\s*([0-9零一二两三四五六七八九十半]{1,3})?\s*(分钟|分|小时|钟头|天|日)/;
const EN_INTERVAL = /^every\s+(?:(\d+)\s+)?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/;
const EN_HALF_HOUR = /\bhalf\s+an?\s+hour\b/;

function intervalFromUnit(unit: string, count: number): IntervalSpec | null {
  if (count <= 0) return null;
  if (/^(分钟|分|m|min|mins|minute|minutes)$/.test(unit)) return { minutes: count };
  if (/^(小时|钟头|h|hr|hrs|hour|hours)$/.test(unit)) return { minutes: count * 60 };
  if (/^(天|日|d|day|days)$/.test(unit)) return { minutes: count * 1440 };
  return null;
}

/**
 * 间隔抽取（每 N 分钟/小时/天、every N minutes/hours/days、half an hour、每小时…）。
 * 「每隔N天」语义有歧义（间隔 N 天 vs 跨 N+1 天）→ 明确返回 null 让上层拒绝，不猜。
 */
export function extractInterval(text: string): IntervalSpec | null {
  if (EN_HALF_HOUR.test(text) || /每半小时|半个?小时(?!钟)/.test(text)) return { minutes: 30 };
  const en = EN_INTERVAL.exec(text);
  if (en) {
    const count = en[1] === undefined ? 1 : Number(en[1]);
    const spec = intervalFromUnit(en[2]!, count);
    if (spec !== null) return spec;
  }
  const zh = ZH_INTERVAL.exec(text);
  if (zh) {
    const prefix = zh[1]!;
    const raw = zh[2];
    const unit = zh[3]!;
    // 「每隔N天」歧义 → 拒绝
    if (prefix === '每隔' && /^(天|日)$/.test(unit)) return null;
    const count = raw === undefined || raw === '' ? 1 : (parseZhNumber(raw) ?? NaN);
    if (!Number.isNaN(count)) {
      const spec = intervalFromUnit(unit, count);
      if (spec !== null && spec.minutes * 60_000 >= 60_000) return spec;
    }
  }
  return null;
}

// —— 规格构建 ——

function canonicalSchedule(parsed: ParsedSchedule): string {
  if (parsed.kind === 'interval') {
    const minutes = parsed.intervalMs / 60_000;
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  const time = `${parsed.hour}:${String(parsed.minute).padStart(2, '0')}`;
  if (parsed.kind === 'daily') return `daily ${time}`;
  return `weekly ${parsed.days.join(',')} ${time}`;
}

function fromInterval(spec: IntervalSpec): ParsedSchedule {
  return { kind: 'interval', intervalMs: spec.minutes * 60_000 };
}

function fromDayAndClock(spec: DaySpec, clock: Clock): ParsedSchedule {
  if (spec.kind === 'daily') return { kind: 'daily', hour: clock.hour, minute: clock.minute };
  return { kind: 'weekly', days: spec.days ?? [1, 2, 3, 4, 5], hour: clock.hour, minute: clock.minute };
}

// —— 确定性规则兜底 ——

/** 规则解析：成功返回调度规格，失败返回拒绝原因（纯函数，可离线测） */
export function parseCronTextByRules(
  text: string,
): { ok: true; parsed: ParsedSchedule } | { ok: false; reason: string } {
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, reason: '输入为空' };
  // 1) 直接给的规格（"5m"/"daily 09:00"/"weekly 1,3 09:00"）原样接受
  try {
    return { ok: true, parsed: parseSchedule(raw) };
  } catch {
    // 落到自然语言规则
  }
  const normalized = normalizeText(raw);
  const clock = extractClock(normalized);
  const daySpec = extractDaySpec(normalized);
  const interval = extractInterval(normalized);

  // 2) 明确数字间隔 + 单位（不涉及具体时刻）→ 周期
  if (interval !== null && daySpec !== null && daySpec.kind === 'days') {
    return { ok: false, reason: '同时出现「周期」与「星期」两种语义，无法确定' };
  }

  // 3) 「每天/工作日/每周X」+ 时刻 → daily / weekly；「每天/每日」无时刻 → 1 天周期
  if (daySpec !== null) {
    if (clock !== null) return { ok: true, parsed: fromDayAndClock(daySpec, clock) };
    if (daySpec.kind === 'daily' && interval !== null) return { ok: true, parsed: fromInterval(interval) };
    return { ok: false, reason: '只识别出日期范围，缺少具体时间' };
  }

  // 4) 纯周期（每 N 分钟/小时/天、every N minutes…）
  if (interval !== null) return { ok: true, parsed: fromInterval(interval) };

  // 5) 只有时刻 + 「每」前缀（如 "every 9am"）→ 每天
  if (clock !== null && /^(every|每|daily|每天|每日)/.test(normalized)) {
    return { ok: true, parsed: { kind: 'daily', hour: clock.hour, minute: clock.minute } };
  }

  return { ok: false, reason: '未能从文本中识别出调度规格' };
}

function rulesInterpretation(text: string, now: Date): CronScheduleInterpretationResult {
  const result = parseCronTextByRules(text);
  if (!result.ok) {
    return { ok: false, text, reason: result.reason, hint: CRON_NATURAL_HINT };
  }
  const schedule = canonicalSchedule(result.parsed);
  // 二次校验：规范化结果必须能被 parseSchedule 接受（防规则构建出错）
  try {
    parseSchedule(schedule);
  } catch (e) {
    return { ok: false, text, reason: (e as Error).message, hint: CRON_NATURAL_HINT };
  }
  return {
    ok: true,
    text,
    schedule,
    display: describeSchedule(schedule),
    source: 'rules',
    nextRun: computeNextRun(schedule, now),
  };
}

// —— 统一入口（provider 优先，规则兜底） ——

/**
 * 自然语言 → 调度规格。
 * provider（若有）先试；provider 抛错 / 返回空 / 返回非法规格 → 静默回落确定性规则。
 */
export async function interpretCronSchedule(
  text: string,
  opts: CronNaturalOptions = {},
): Promise<CronScheduleInterpretationResult> {
  const now = opts.now ?? new Date();
  const provider = opts.provider;
  if (provider !== undefined) {
    let candidate: NaturalScheduleCandidate | null | undefined;
    try {
      candidate = await provider.parse({ text, now });
    } catch {
      candidate = null;
    }
    const schedule = candidate?.schedule?.trim();
    if (schedule !== undefined && schedule.length > 0) {
      try {
        parseSchedule(schedule);
        return {
          ok: true,
          text,
          schedule,
          display: describeSchedule(schedule),
          source: 'provider',
          providerName: provider.name,
          nextRun: computeNextRun(schedule, now),
        };
      } catch {
        // 模型输出非法：丢弃，回落规则兜底
      }
    }
  }
  return rulesInterpretation(text, now);
}

// —— draft / 确认落盘 ——

export interface CronNaturalDraft {
  instruction: string;
  /** 用户原话（自然语言） */
  text: string;
  /** 规范化调度规格（落盘用） */
  schedule: string;
  /** 用户可读回显 */
  display: string;
  source: CronScheduleSource;
  providerName?: string;
  /** 预演下次执行（确认落盘时按实际时刻重算） */
  previewNextRun: string;
  /** 投递目标（缺省 = 只落本地 history） */
  deliver?: CronDeliveryTarget;
}

export type CronDraftResult = { ok: true; draft: CronNaturalDraft } | CronScheduleFailure;

export interface CronNaturalAddInput {
  /** 发给模型的指令（必填非空） */
  instruction: string;
  /** 自然语言调度描述 */
  text: string;
  /** 投递目标（H-46 通道抽象；缺省只落本地 history） */
  deliver?: CronDeliveryTarget;
}

/** 回显文案（壳必须原样展示给用户确认后才可落盘） */
export function renderCronDraftEcho(draft: CronNaturalDraft): string {
  const source =
    draft.source === 'provider' ? `模型解析${draft.providerName ? `（${draft.providerName}）` : ''}` : '规则解析';
  return [
    '将创建定时任务（确认后才会落盘）：',
    `  指令：${draft.instruction}`,
    `  调度：${draft.display}（${draft.schedule}，${source}）`,
    `  首次执行：${draft.previewNextRun}`,
    ...(draft.deliver !== undefined ? [`  投递：${draft.deliver.channel}`] : []),
  ].join('\n');
}

/** 解析自然语言 → draft（**不落盘**）；失败返回可展示的拒绝原因 */
export async function draftCronJob(
  input: CronNaturalAddInput,
  opts: CronNaturalOptions = {},
): Promise<CronDraftResult> {
  const instruction = input.instruction.trim();
  if (instruction.length === 0) {
    return {
      ok: false,
      text: input.text,
      reason: '指令不能为空',
      hint: '示例：harness2 cron add "汇总今日 CI 状态" --every 5m',
    };
  }
  const interpreted = await interpretCronSchedule(input.text, opts);
  if (!interpreted.ok) return interpreted;
  return {
    ok: true,
    draft: {
      instruction,
      text: input.text,
      schedule: interpreted.schedule,
      display: interpreted.display,
      source: interpreted.source,
      ...(interpreted.providerName !== undefined ? { providerName: interpreted.providerName } : {}),
      previewNextRun: interpreted.nextRun,
      ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
    },
  };
}

/**
 * 确认落盘：draft → CronJob。
 * 落盘前**重新校验**规格（draft 可能被持有方篡改），并重算 nextRun。
 */
export function confirmCronDraft(store: CronJobStore, draft: CronNaturalDraft): CronJob {
  parseSchedule(draft.schedule); // 重新校验（fail-closed）
  return store.add(draft.instruction, draft.schedule, draft.deliver !== undefined ? { deliver: draft.deliver } : {});
}

export interface CronNaturalAddResult {
  /** 解析得到的 draft（失败时为 null） */
  draft: CronNaturalDraft | null;
  /** 解析失败详情 */
  failure?: CronScheduleFailure;
  /**
   * true = 仅返回 draft，**未落盘**（需用户确认后再次调用并置 confirmed=true）；
   * false = 已落盘（job 存在）。
   */
  needsConfirmation: boolean;
  job?: CronJob;
  /** 回显文案（needsConfirmation=true 时必须展示给用户） */
  echo?: string;
}

/**
 * 自然语言新增任务的**两段式**入口：
 *   confirmed=false → 只回显 draft（不落盘）；
 *   confirmed=true  → 解析并落盘，返回 job。
 * 拒绝静默创建：任何未经 confirmed=true 的调用都不会写盘。
 */
export async function addCronJobFromNatural(
  store: CronJobStore,
  input: CronNaturalAddInput & { confirmed?: boolean },
  opts: CronNaturalOptions = {},
): Promise<CronNaturalAddResult> {
  const drafted = await draftCronJob(input, opts);
  if (!drafted.ok) return { draft: null, failure: drafted, needsConfirmation: false };
  if (input.confirmed !== true) {
    return {
      draft: drafted.draft,
      needsConfirmation: true,
      echo: renderCronDraftEcho(drafted.draft),
    };
  }
  return { draft: drafted.draft, needsConfirmation: false, job: confirmCronDraft(store, drafted.draft) };
}

/** 便捷：抛错版的自然语言新增（CLI 等已有 error 出口的调用方用） */
export async function addCronJobFromNaturalOrThrow(
  store: CronJobStore,
  input: CronNaturalAddInput,
  opts: CronNaturalOptions = {},
): Promise<CronJob> {
  const result = await addCronJobFromNatural(store, { ...input, confirmed: true }, opts);
  if (result.job === undefined) {
    const failure = result.failure;
    throw new CronError(failure !== undefined ? `${failure.reason}。${failure.hint}` : '自然语言解析失败');
  }
  return result.job;
}
