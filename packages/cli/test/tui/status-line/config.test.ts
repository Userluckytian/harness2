// G-42/G-43/G-46 状态行配置解析单测：type 同义归一、缺省 items、padding 钳制、
// refresh_interval 范围与「仅 command 型生效」、~/ 展开、不造假（缺命令不建假入口）。
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STATUS_ITEMS,
  DEFAULT_STATUS_LINE_ITEMS,
  STATUS_LINE_CONFIG_PATH,
  STATUS_LINE_MAX_LINE_CHARS,
  STATUS_LINE_MAX_LINES,
  STATUS_LINE_MAX_STDOUT_BYTES,
  STATUS_LINE_PADDING_MAX,
  STATUS_LINE_REFRESH_MAX_SEC,
  STATUS_LINE_TIMEOUT_MS,
  defaultStatusLineSettings,
  expandTildePrefix,
  parseStatusLineSettings,
} from '../../../src/tui/status-line/config.js';

describe('G-42 三种类型与缺省（disabled 默认整行不渲染）', () => {
  it('未配置 → 缺省设置：type=disabled、items=[cwd,model,context]、无 command、padding 0', () => {
    expect(parseStatusLineSettings(undefined)).toEqual({ settings: defaultStatusLineSettings(), warnings: [] });
    const s = parseStatusLineSettings({}).settings;
    expect(s.type).toBe('disabled');
    expect(s.items).toEqual(['cwd', 'model', 'context']);
    expect(s.padding).toBe(0);
    expect(s.refreshIntervalSec).toBeUndefined();
  });

  it('同义拼写 off / none / hidden 一律归一为 disabled（G-42）', () => {
    for (const spelling of ['off', 'none', 'hidden']) {
      const r = parseStatusLineSettings({ ui: { status_line: { type: spelling } } });
      expect(r.settings.type).toBe('disabled');
      expect(r.warnings).toEqual([]);
    }
  });

  it('builtin / command 合法接受；未知值回退 disabled + 告警（消费端兜底，不致命）', () => {
    expect(parseStatusLineSettings({ ui: { status_line: { type: 'builtin' } } }).settings.type).toBe('builtin');
    expect(parseStatusLineSettings({ ui: { status_line: { type: 42 } } }).warnings[0]).toContain(
      STATUS_LINE_CONFIG_PATH,
    );
    expect(parseStatusLineSettings({ ui: { status_line: { type: 'neon' } } }).settings.type).toBe('disabled');
  });
});

describe('G-43 builtin items（默认三项；全集六条；未知条目丢弃+告警）', () => {
  it('items 显式给出按序生效（上游：Items appear in the order you list them）', () => {
    const r = parseStatusLineSettings({
      ui: { status_line: { type: 'builtin', items: ['cost', 'session-name', 'turn-timer', 'context'] } },
    });
    expect(r.settings.items).toEqual(['cost', 'session-name', 'turn-timer', 'context']);
    expect(r.warnings).toEqual([]);
  });

  it('未知条目丢弃并告警，合法条目保留（core schema 已致命拦截，这里是防御兜底）', () => {
    const r = parseStatusLineSettings({
      ui: { status_line: { type: 'builtin', items: ['cwd', 'weather', 'model'] } },
    });
    expect(r.settings.items).toEqual(['cwd', 'model']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('weather');
  });

  it('全集恰好六条（G-43 可选项：cost / turn-timer / session-name）', () => {
    expect(BUILTIN_STATUS_ITEMS).toEqual(['cwd', 'model', 'context', 'cost', 'turn-timer', 'session-name']);
    expect(DEFAULT_STATUS_LINE_ITEMS).toEqual(['cwd', 'model', 'context']);
  });
});

describe('G-45 command 型（~/ 展开；缺命令不建假入口）', () => {
  it('command 保留原文（非 ~/ 前缀不展开）；~/ 前缀展开为指定 home', () => {
    const raw = parseStatusLineSettings({ ui: { status_line: { type: 'command', command: 'node status.js' } } });
    expect(raw.settings.command).toBe('node status.js');
    expect(expandTildePrefix('~/bin/statusline.sh', '/home/me')).toBe('/home/me/bin/statusline.sh');
    expect(expandTildePrefix('C:\\tools\\sl.cmd', '/home/me')).toBe('C:\\tools\\sl.cmd');
    expect(expandTildePrefix('~/x', '')).toContain('/'); // home 缺省回落 homedir()
  });

  it('type=command 但缺 command → 回退 disabled + 告警（不做「点了没反应」的假命令行）', () => {
    const r = parseStatusLineSettings({ ui: { status_line: { type: 'command' } } });
    expect(r.settings.type).toBe('disabled');
    expect(r.warnings.join('\n')).toContain('回退 disabled');
  });
});

describe('G-46 数值约束（padding 钳 0..16；refresh_interval 1..86400 且仅 command 型）', () => {
  it('padding 钳制语义：>16 钳到上限（不报错）、负数回退 0 + 告警', () => {
    expect(STATUS_LINE_PADDING_MAX).toBe(16);
    expect(parseStatusLineSettings({ ui: { status_line: { padding: 99 } } }).settings.padding).toBe(16);
    expect(parseStatusLineSettings({ ui: { status_line: { padding: 5 } } }).settings.padding).toBe(5);
    const neg = parseStatusLineSettings({ ui: { status_line: { padding: -1 } } });
    expect(neg.settings.padding).toBe(0);
    expect(neg.warnings).toHaveLength(1);
  });

  it('refresh_interval：合法值仅 command 型保留；builtin 下不调度（undefined + 告警）', () => {
    const ok = parseStatusLineSettings({
      ui: { status_line: { type: 'command', command: 'x', refresh_interval: 300 } },
    });
    expect(ok.settings.refreshIntervalSec).toBe(300);
    const builtin = parseStatusLineSettings({
      ui: { status_line: { type: 'builtin', refresh_interval: 300 } },
    });
    expect(builtin.settings.refreshIntervalSec).toBeUndefined();
    expect(builtin.warnings.join('\n')).toContain('仅 command 型');
  });

  it('refresh_interval 越界丢弃 + 告警；上界常量 = 86400（G-46）', () => {
    expect(STATUS_LINE_REFRESH_MAX_SEC).toBe(86_400);
    const big = parseStatusLineSettings({
      ui: { status_line: { type: 'command', command: 'x', refresh_interval: 86_401 } },
    });
    expect(big.settings.refreshIntervalSec).toBeUndefined();
    expect(big.warnings.join('\n')).toContain('1..86400');
    const zero = parseStatusLineSettings({
      ui: { status_line: { type: 'command', command: 'x', refresh_interval: 0 } },
    });
    expect(zero.settings.refreshIntervalSec).toBeUndefined();
  });

  it('G-47 常量单一定义点：超时 10s / 5 行 / 1024 字符 / 64KiB', () => {
    expect(STATUS_LINE_TIMEOUT_MS).toBe(10_000);
    expect(STATUS_LINE_MAX_LINES).toBe(5);
    expect(STATUS_LINE_MAX_LINE_CHARS).toBe(1024);
    expect(STATUS_LINE_MAX_STDOUT_BYTES).toBe(64 * 1024);
  });
});
