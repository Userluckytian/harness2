// config.ts — `[ui.status_line]` 配置解析与常量（G-42 / G-43 / G-46，headless 纯逻辑）。
//
// 规格依据：refs-grok-build.md G-42～G-49 与上游 25-status-line.md：
//  - G-42：type = builtin | command | disabled，缺省 disabled；off / none / hidden 是
//    disabled 的同义拼写（core schema 已归一，这里对绕过 schema 的调用方兜底再归一一次）。
//  - G-43：builtin items 缺省 [cwd, model, context]；可选 cost / turn-timer / session-name。
//  - G-46：padding 上限 16（钳制语义）；refresh_interval 1–86400 秒、仅 command 型有意义
//    （「refresh_interval under builtin schedules nothing」）；防抖 300ms / 紧急 100ms。
//  - G-45/G-47：超时 10s、最多 5 行、每行 1024 字符、stdout 64KiB——常量也集中在这里，
//    供 contract/governor/runner 引用（单一定义点）。
// core schema（packages/core/src/config/schema.ts）已加性落地 ui.status_line 段并做致命
// 校验；本模块是消费端语义层：默认值补全、~/ 展开、tolerant 再校验（防御绕过 schema 的
// 调用方，非法值回退缺省 + 告警，不做致命拦截）。
import { homedir } from 'node:os';
import type { StatusLineType } from '@harness2/core';
import { STATUS_LINE_BUILTIN_ITEMS, STATUS_LINE_DISABLED_SYNONYMS, STATUS_LINE_TYPES } from '@harness2/core';

/** 配置路径（与 refs-grok-build.md G-42 记法一致） */
export const STATUS_LINE_CONFIG_PATH = 'ui.status_line';

// —— 契约常量（G-45～G-47 数值的单一定义点）────────────────────────────────────

/** 防抖窗口（G-46：事件驱动 + 300ms 防抖） */
export const STATUS_LINE_DEBOUNCE_MS = 300;
/** 紧急变更防抖（G-46：resize / 新快照 / 切换 agent 等 100ms） */
export const STATUS_LINE_URGENT_DEBOUNCE_MS = 100;
/** 刷新间隔下界（G-46：refresh_interval 1 秒起） */
export const STATUS_LINE_REFRESH_MIN_SEC = 1;
/** 刷新间隔上界（G-46：refresh_interval 86,400 秒 = 24h） */
export const STATUS_LINE_REFRESH_MAX_SEC = 86_400;
/** padding 每侧上限（G-46：capped at 16） */
export const STATUS_LINE_PADDING_MAX = 16;
/** 子进程超时（G-47：10s 后显示 [status line: timed out]） */
export const STATUS_LINE_TIMEOUT_MS = 10_000;
/** 输出最多行数（G-47） */
export const STATUS_LINE_MAX_LINES = 5;
/** 每行最多字符数（G-47；按上游口径把 ANSI 转义也算在内） */
export const STATUS_LINE_MAX_LINE_CHARS = 1024;
/** stdout 截断阈值（G-47：超 64KiB 截断并停脚本） */
export const STATUS_LINE_MAX_STDOUT_BYTES = 64 * 1024;
/** 超时占位文案（G-47 上游原文，逐字复刻） */
export const STATUS_LINE_TIMEOUT_TEXT = '[status line: timed out]';

/** builtin 条目（G-43）：类型为壳层联合（core 未导出命名联合），取值域单一来源 = core */
export type BuiltinStatusItem = 'cwd' | 'model' | 'context' | 'cost' | 'turn-timer' | 'session-name';

/** builtin 条目全集（P2-3：直接来自 core schema STATUS_LINE_BUILTIN_ITEMS，不另持一份清单） */
export const BUILTIN_STATUS_ITEMS: readonly BuiltinStatusItem[] =
  STATUS_LINE_BUILTIN_ITEMS as readonly BuiltinStatusItem[];

/** builtin items 缺省（G-43：[cwd, model, context]） */
export const DEFAULT_STATUS_LINE_ITEMS: readonly BuiltinStatusItem[] = ['cwd', 'model', 'context'];

/** 解析后的状态行设置（缺省补全后的运行时形态；type 缺省 disabled） */
export interface ResolvedStatusLineSettings {
  readonly type: StatusLineType;
  readonly items: readonly BuiltinStatusItem[];
  /** command 型脚本命令（已做 ~/ 展开；builtin/disabled 恒 undefined） */
  readonly command: string | undefined;
  /** 每侧留白 0..16（G-46） */
  readonly padding: number;
  /** 定时刷新秒数（仅 command 型；未配置 = undefined = 纯事件驱动） */
  readonly refreshIntervalSec: number | undefined;
}

/** 缺省设置：type=disabled（G-42 默认关闭，整行不渲染） */
export function defaultStatusLineSettings(): ResolvedStatusLineSettings {
  return {
    type: 'disabled',
    items: DEFAULT_STATUS_LINE_ITEMS,
    command: undefined,
    padding: 0,
    refreshIntervalSec: undefined,
  };
}

/** `~/` 前缀展开为 home（G-45/上游 Set up 节：「A ~/ prefix expands to your home directory」） */
export function expandTildePrefix(command: string, home: string): string {
  if (!command.startsWith('~/')) return command;
  const rest = command.slice(2);
  const base = home.length > 0 ? home : homedir();
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${rest}` : `${base}/${rest}`;
}

/** 消费端 tolerant 解析结果 */
export interface StatusLineParseResult {
  readonly settings: ResolvedStatusLineSettings;
  /** 非致命告警（非法值回退缺省时给一行；风格对齐 mode.ts / queue.ts） */
  readonly warnings: readonly string[];
}

/** type 同义归一（G-42：off/none/hidden → disabled）；非法返回 null */
export function normalizeStatusLineType(raw: unknown): StatusLineType | null {
  if (typeof raw !== 'string') return null;
  if ((STATUS_LINE_TYPES as readonly string[]).includes(raw)) return raw as StatusLineType;
  if (STATUS_LINE_DISABLED_SYNONYMS.includes(raw)) return 'disabled';
  return null;
}

/** config 段的形状（core schema 落地 ui.status_line 后的消费端视图；字段原样 unknown） */
export interface UiStatusLineSection {
  // 值为 unknown：本函数是**防御性消费端解析**（对绕过 core schema 的调用方兜底），
  // 测试也借它喂非法原始值——形状校验全在本函数运行时完成（口径同 mode.ts 的 UiScreenModeSection）。
  ui?: { status_line?: unknown };
}

/**
 * 解析 [ui.status_line] 段（消费端语义层）：
 *  - type：同义拼写归一；非法 → disabled + 告警；
 *  - items：只收合法条目，未知条目丢弃 + 告警（不做致命拦截——core schema 已先行报错）；
 *  - command：~/ 展开；type=command 且缺 command → 回退 disabled + 告警（无命令的命令行
 *    不做假入口）；
 *  - padding：钳到 [0, 16]（G-46 钳制语义）；
 *  - refresh_interval：1..86400 之外的整数丢弃 + 告警；**仅 command 型保留**（G-46：
 *    builtin 下 refresh_interval 不调度任何东西）。
 */
export function parseStatusLineSettings(section: UiStatusLineSection | undefined): StatusLineParseResult {
  const warnings: string[] = [];
  const rawValue = section?.ui?.status_line;
  if (rawValue === undefined) return { settings: defaultStatusLineSettings(), warnings };
  if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
    warnings.push(`config.${STATUS_LINE_CONFIG_PATH}: 必须是对象，回退缺省（disabled）`);
    return { settings: defaultStatusLineSettings(), warnings };
  }
  const raw = rawValue as Record<string, unknown>;

  let type: StatusLineType = 'disabled';
  if (raw.type !== undefined) {
    const normalized = normalizeStatusLineType(raw.type);
    if (normalized === null) {
      warnings.push(`config.${STATUS_LINE_CONFIG_PATH}.type: 未知值 ${JSON.stringify(raw.type)}，回退 disabled`);
    } else {
      type = normalized;
    }
  }

  let items: readonly BuiltinStatusItem[] = DEFAULT_STATUS_LINE_ITEMS;
  if (raw.items !== undefined) {
    if (Array.isArray(raw.items) && raw.items.every((x) => typeof x === 'string')) {
      const valid: BuiltinStatusItem[] = [];
      for (const name of raw.items as string[]) {
        if ((BUILTIN_STATUS_ITEMS as readonly string[]).includes(name)) {
          valid.push(name as BuiltinStatusItem);
        } else {
          warnings.push(`config.${STATUS_LINE_CONFIG_PATH}.items: 未知条目 ${JSON.stringify(name)} 已忽略`);
        }
      }
      items = valid;
    } else {
      warnings.push(
        `config.${STATUS_LINE_CONFIG_PATH}.items: 必须是字符串数组，回退缺省 ${DEFAULT_STATUS_LINE_ITEMS.join('/')}`,
      );
    }
  }

  let command: string | undefined;
  if (raw.command !== undefined) {
    if (typeof raw.command === 'string' && raw.command.trim().length > 0) {
      command = expandTildePrefix(raw.command, homedir());
    } else {
      warnings.push(`config.${STATUS_LINE_CONFIG_PATH}.command: 必须是非空字符串，已忽略`);
    }
  }
  if (type === 'command' && command === undefined) {
    warnings.push(`config.${STATUS_LINE_CONFIG_PATH}: type 为 command 但未提供 command，回退 disabled`);
    type = 'disabled';
  }

  let padding = 0;
  if (raw.padding !== undefined) {
    if (typeof raw.padding === 'number' && Number.isInteger(raw.padding) && raw.padding >= 0) {
      padding = Math.min(raw.padding, STATUS_LINE_PADDING_MAX); // G-46：上限 16 = 钳制
    } else {
      warnings.push(`config.${STATUS_LINE_CONFIG_PATH}.padding: 必须是 >= 0 的整数，回退 0`);
    }
  }

  let refreshIntervalSec: number | undefined;
  if (raw.refresh_interval !== undefined) {
    if (typeof raw.refresh_interval === 'number' && Number.isInteger(raw.refresh_interval)) {
      if (raw.refresh_interval >= STATUS_LINE_REFRESH_MIN_SEC && raw.refresh_interval <= STATUS_LINE_REFRESH_MAX_SEC) {
        refreshIntervalSec = type === 'command' ? raw.refresh_interval : undefined;
        if (type !== 'command') {
          warnings.push(
            `config.${STATUS_LINE_CONFIG_PATH}.refresh_interval: 仅 command 型生效（builtin/disabled 不调度）`,
          );
        }
      } else {
        warnings.push(
          `config.${STATUS_LINE_CONFIG_PATH}.refresh_interval: 必须是 ${STATUS_LINE_REFRESH_MIN_SEC}..${STATUS_LINE_REFRESH_MAX_SEC} 的整数，已忽略`,
        );
      }
    } else {
      warnings.push(`config.${STATUS_LINE_CONFIG_PATH}.refresh_interval: 必须是整数（秒），已忽略`);
    }
  }

  return { settings: { type, items, command, padding, refreshIntervalSec }, warnings };
}
