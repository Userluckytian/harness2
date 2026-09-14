// G-43/G-44/G-47 渲染单测：builtin 段渲染与省略、G-44 宽度省略阈值、G-47 输出限额整形。
import { describe, expect, it } from 'vitest';
import {
  STATUS_LINE_SEPARATOR,
  applyPadding,
  cwdBasename,
  elide,
  formatCost,
  formatTurnTimer,
  renderBuiltinStatusLine,
  shapeCommandOutput,
  stripNonColorEscapes,
} from '../../../src/tui/status-line/render.js';
import { DEFAULT_STATUS_LINE_ITEMS } from '../../../src/tui/status-line/config.js';

const NOW = 1_700_000_100_000;

describe('G-43 builtin 段渲染（真实数据进、缺数据段省略——不造假）', () => {
  it('缺省三项：cwd 基名 · model · context（段序 = items 序；分隔符对齐上游示例 │）', () => {
    const r = renderBuiltinStatusLine(
      { cwd: '/home/me/harness2', model: 'GLM 5.3 Flash', usage: 0.12 },
      { nowMs: NOW },
    );
    expect(r.line).toBe(`harness2 │ GLM 5.3 Flash │ 12% ctx`);
    expect(STATUS_LINE_SEPARATOR).toBe(' │ ');
  });

  it('context 未知 → 段省略（不显示 ctx — 之类的伪数据）；cwd/model 照常', () => {
    const r = renderBuiltinStatusLine({ cwd: '/x/proj', model: 'm1' }, { nowMs: NOW });
    expect(r.line).toBe('proj │ m1');
    expect(r.line).not.toContain('ctx');
  });

  it('cost：低于 $0.005 隐藏（G-43）；正常显示两位小数；未知费用 ≠ $0.00（items 显式含 cost）', () => {
    expect(formatCost(0.004)).toBeNull();
    expect(formatCost(0.005)).toBe('$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
    const costItems = ['cwd', 'cost'];
    expect(renderBuiltinStatusLine({ cwd: '/a', costUsd: 0.001 }, { items: costItems, nowMs: NOW }).line).toBe('a');
    expect(renderBuiltinStatusLine({ cwd: '/a', costUsd: 0.25 }, { items: costItems, nowMs: NOW }).line).toBe(
      'a │ $0.25',
    );
    expect(renderBuiltinStatusLine({ cwd: '/a' }, { items: costItems, nowMs: NOW }).line).toBe('a');
  });

  it('turn-timer：从 1 秒起显示（G-43）；回合间缺席省略；MM:SS / H:MM:SS（items 显式含 turn-timer）', () => {
    expect(formatTurnTimer(0)).toBeNull();
    expect(formatTurnTimer(999)).toBeNull();
    expect(formatTurnTimer(1000)).toBe('00:01');
    expect(formatTurnTimer(65_000)).toBe('01:05');
    expect(formatTurnTimer(3_723_000)).toBe('1:02:03');
    const timerItems = ['cwd', 'turn-timer'];
    expect(
      renderBuiltinStatusLine({ cwd: '/a', turnStartedAtMs: NOW - 30_000 }, { items: timerItems, nowMs: NOW }).line,
    ).toBe('a │ 00:30');
    expect(renderBuiltinStatusLine({ cwd: '/a' }, { items: timerItems, nowMs: NOW }).line).toBe('a');
  });

  it('session-name：设置了才显示（G-43）；未设置省略（items 显式含 session-name）', () => {
    const nameItems = ['cwd', 'session-name'];
    expect(renderBuiltinStatusLine({ cwd: '/a', sessionName: 'P3-C' }, { items: nameItems, nowMs: NOW }).line).toBe(
      'a │ P3-C',
    );
    expect(renderBuiltinStatusLine({ cwd: '/a' }, { items: nameItems, nowMs: NOW }).line).toBe('a');
  });

  it('context 琥珀判定：达 auto-compact 阈值或无阈值时的 80%（contextAmber 单独返回，纯文本不上色）', () => {
    const at = renderBuiltinStatusLine({ cwd: '/a', usage: 0.85, autoCompactThresholdPercent: 85 }, { nowMs: NOW });
    expect(at.contextAmber).toBe(true);
    const default80 = renderBuiltinStatusLine({ cwd: '/a', usage: 0.8 }, { nowMs: NOW });
    expect(default80.contextAmber).toBe(true);
    const below = renderBuiltinStatusLine({ cwd: '/a', usage: 0.79 }, { nowMs: NOW });
    expect(below.contextAmber).toBe(false);
  });

  it('无任何可见段 → line null（整行省略，不渲染空壳）；items 显式空数组同理', () => {
    expect(renderBuiltinStatusLine({}, { nowMs: NOW }).line).toBeNull();
    expect(renderBuiltinStatusLine({ cwd: '/a', model: 'm' }, { items: [], nowMs: NOW }).line).toBeNull();
    expect(DEFAULT_STATUS_LINE_ITEMS).toEqual(['cwd', 'model', 'context']);
  });
});

describe('G-44 宽度省略（<40 目录/会话名省略；<30 模型名省略；条目超长 … 截断）', () => {
  it('cols < 40：cwd 与 session-name 段省略；context/cost 等保留', () => {
    const r = renderBuiltinStatusLine(
      { cwd: '/very/long/path/that/exists', model: 'm', usage: 0.5, sessionName: 's' },
      { cols: 39, nowMs: NOW },
    );
    expect(r.line).toBe('m │ 50% ctx'); // cwd（<40）与 session-name（<40）一并省略
    expect(r.line).not.toContain('exists');
  });

  it('cols = 40：cwd/session-name 恢复显示（阈值以下才省略；items 显式含 session-name）', () => {
    const r = renderBuiltinStatusLine(
      { cwd: '/a/b', sessionName: 's' },
      { cols: 40, items: ['cwd', 'session-name'], nowMs: NOW },
    );
    expect(r.line).toBe('b │ s');
  });

  it('cols < 30：model 段省略（模型名阈值更紧）；cwd 在 29 列也按 <40 省略', () => {
    const r = renderBuiltinStatusLine(
      { cwd: '/a', model: 'a-very-long-model-name', usage: 0.1 },
      { cols: 29, nowMs: NOW },
    );
    expect(r.line).not.toContain('a-very-long-model-name');
    expect(r.line).toBe('10% ctx'); // cwd（29<40）与 model（29<30）双双省略，只剩 context
  });

  it('cols = 30：model 显示；30..39 之间 model 在、cwd 省略', () => {
    expect(renderBuiltinStatusLine({ model: 'm' }, { cols: 30, nowMs: NOW }).line).toBe('m');
    expect(renderBuiltinStatusLine({ cwd: '/a', model: 'm' }, { cols: 35, nowMs: NOW }).line).toBe('m');
  });

  it('整行超预算逐段收缩（超宽的段以 … 截断收尾；段序保持；41 列避开 G-44 整段省略阈值）', () => {
    const r = renderBuiltinStatusLine(
      { cwd: '/a/bb', model: 'a-very-long-model-display-name', usage: 0.5 },
      { cols: 41, nowMs: NOW },
    );
    expect(r.line).not.toBeNull();
    expect(r.line!.length).toBeLessThanOrEqual(41);
    expect(r.line).toContain('bb'); // cwd 基名先保留（41≥40 不触发整段省略）
    expect(r.line!.endsWith('…') || r.line!.length < 41).toBe(true);
  });

  it('elide 基元：不超长原样、超长 … 占位、max<=0 空串', () => {
    expect(elide('abc', 5)).toBe('abc');
    expect(elide('abcdef', 4)).toBe('abc…');
    expect(elide('abcdef', 1)).toBe('…');
    expect(elide('abcdef', 0)).toBe('');
  });

  it('cwdBasename 基名：POSIX/Windows 分隔符、尾分隔符容错、根目录原样', () => {
    expect(cwdBasename('/home/me/proj')).toBe('proj');
    expect(cwdBasename('D:\\AI_Projects\\harness2')).toBe('harness2');
    expect(cwdBasename('/repo/')).toBe('repo');
    expect(cwdBasename('/')).toBe('');
  });
});

describe('G-47 输出限额（5 行 / 每行 1024 / 转义策略 / 空输出收行）', () => {
  it('最多 5 行，超出部分从底部丢弃（surplus from the bottom）', () => {
    const out = shapeCommandOutput('1\n2\n3\n4\n5\n6\n7\n');
    expect(out).toEqual(['1', '2', '3', '4', '5']);
  });

  it('每行截到 1024 字符（含保留的 SGR 转义计入长度）', () => {
    const long = 'x'.repeat(1100);
    expect(shapeCommandOutput(long)[0]?.length).toBe(1024);
    const colored = `\x1b[31m${'y'.repeat(1100)}\x1b[0m`;
    const shaped = shapeCommandOutput(colored)[0] ?? '';
    expect(shaped.length).toBeLessThanOrEqual(1024);
    expect(shaped).toContain('\x1b[31m'); // SGR 保留
  });

  it('非颜色转义丢弃：光标移动 CSI、回车覆盖、OSC；SGR 保留', () => {
    expect(stripNonColorEscapes('a\x1b[2Kb\x1b[1Cc')).toBe('abc'); // 转义消失，正文保留
    expect(stripNonColorEscapes('x\ry')).toBe('xy');
    expect(stripNonColorEscapes('\x1b]0;title\x07')).toBe('');
    expect(stripNonColorEscapes('\x1b[32mgreen\x1b[0m')).toBe('\x1b[32mgreen\x1b[0m');
    const shaped = shapeCommandOutput('\x1b[2Krow1\r\x1b[2Krow2');
    expect(shaped).toEqual(['row1row2']); // 回车覆盖按上游语义「转义丢弃」：单行正文保留拼接
  });

  it('空输出 → []（装配层据此收掉整行，不回退 builtin——上游明文）', () => {
    expect(shapeCommandOutput('')).toEqual([]);
    expect(shapeCommandOutput('\n\n')).toEqual([]);
  });
});

describe('G-46 padding（每侧留白；上限钳制在 config 层）', () => {
  it('applyPadding：两侧等宽留白；0 = 原样；越界值钳 0..16', () => {
    expect(applyPadding('ab', 2)).toBe('  ab  ');
    expect(applyPadding('ab', 0)).toBe('ab');
    expect(applyPadding('ab', 99)).toBe(`${' '.repeat(16)}ab${' '.repeat(16)}`);
    expect(applyPadding('ab', -3)).toBe('ab');
  });
});
