// G-01 minimal 契约 + G-03 模式限定命令清单单测（数据化断言）：
// - minimal 契约：无 alt-screen、固定区域只有 prompt + 可选 status line、系统行直写
// - G-03 两份清单即数据：仅 fullscreen 六命令、仅 minimal 一命令、/workflow minimal 降级
// - 谓词矩阵：commandSupportInMode / isCommandAvailableInMode 全组合表驱动
import { describe, expect, it } from 'vitest';
import {
  FULLSCREEN_ONLY_COMMANDS,
  MINIMAL_CONTRACT,
  MINIMAL_DEGRADED_TEXT_COMMANDS,
  MINIMAL_ONLY_COMMANDS,
  MINIMAL_STATUS_LINE_DEFAULT,
  commandSupportInMode,
  isCommandAvailableInMode,
  type ModeCommandSupport,
} from '../../../src/tui/render/minimal.js';
import { renderModeForCommand, type RenderMode } from '../../../src/tui/render/mode.js';

describe('minimal 模式契约（G-01）', () => {
  it('不接管屏幕：altScreen 类型层钉死 false', () => {
    expect(MINIMAL_CONTRACT.altScreen).toBe(false);
  });

  it('屏上固定区域只有 prompt + statusLine（顺序固定：status line 画在 prompt 上方）', () => {
    expect(MINIMAL_CONTRACT.managedRegions).toEqual(['prompt', 'statusLine']);
  });

  it('系统行直写终端滚动区（write-through：不重绘不擦除）', () => {
    expect(MINIMAL_CONTRACT.systemLinePolicy).toBe('write-through');
  });

  it('status line 为可选层且缺省关闭（对齐 legacy readline 最素形态）', () => {
    expect(MINIMAL_STATUS_LINE_DEFAULT).toBe(false);
  });
});

describe('G-03 命令清单即数据', () => {
  it('仅 fullscreen 清单恰好六命令：find/jump/timeline/theme/tutorial/dashboard', () => {
    expect(FULLSCREEN_ONLY_COMMANDS).toEqual(['find', 'jump', 'timeline', 'theme', 'tutorial', 'dashboard']);
  });

  it('仅 minimal 清单恰好一命令：expand（全屏下无原生 scrollback 可展开）', () => {
    expect(MINIMAL_ONLY_COMMANDS).toEqual(['expand']);
  });

  it('minimal 降级清单：workflow（/workflow runs 纯文本输出）', () => {
    expect(MINIMAL_DEGRADED_TEXT_COMMANDS).toEqual(['workflow']);
  });

  it('清单互不相交（一个命令不得同时属于两份限定清单）', () => {
    for (const c of FULLSCREEN_ONLY_COMMANDS) {
      expect(MINIMAL_ONLY_COMMANDS).not.toContain(c);
      expect(MINIMAL_DEGRADED_TEXT_COMMANDS).not.toContain(c);
    }
    for (const c of MINIMAL_ONLY_COMMANDS) expect(MINIMAL_DEGRADED_TEXT_COMMANDS).not.toContain(c);
  });
});

describe('commandSupportInMode 谓词矩阵（G-03）', () => {
  it('表驱动：每条限定命令在两个模式下的支持形态', () => {
    type Row = [cmd: string, mode: RenderMode, expected: ModeCommandSupport];
    const cases: ReadonlyArray<Row> = [
      ...FULLSCREEN_ONLY_COMMANDS.flatMap((c): Row[] => [
        [c, 'fullscreen', 'available'],
        [c, 'minimal', 'unavailable-fullscreen-only'],
      ]),
      ['expand', 'minimal', 'available'],
      ['expand', 'fullscreen', 'unavailable-minimal-only'],
      ['workflow', 'fullscreen', 'available'],
      ['workflow', 'minimal', 'degraded-text'],
      ['new', 'fullscreen', 'available'],
      ['new', 'minimal', 'available'],
      ['exit', 'minimal', 'available'],
    ];
    for (const [cmd, mode, expected] of cases) {
      expect(commandSupportInMode(cmd, mode), `${cmd} @ ${mode}`).toBe(expected);
    }
  });

  it('命令名规范化：前导斜杠与大小写不敏感（/Find 与 find 同判）', () => {
    expect(commandSupportInMode('/FIND', 'minimal')).toBe('unavailable-fullscreen-only');
    expect(commandSupportInMode('/Expand', 'minimal')).toBe('available');
  });

  it('降级是可执行不是拒绝：degraded-text 在可用谓词下为 true', () => {
    expect(isCommandAvailableInMode('workflow', 'minimal')).toBe(true);
    expect(isCommandAvailableInMode('workflow', 'fullscreen')).toBe(true);
  });

  it('可用谓词矩阵：限定命令在错误模式下被拒，其余一律可用', () => {
    for (const c of FULLSCREEN_ONLY_COMMANDS) {
      expect(isCommandAvailableInMode(c, 'fullscreen')).toBe(true);
      expect(isCommandAvailableInMode(c, 'minimal')).toBe(false);
    }
    expect(isCommandAvailableInMode('expand', 'minimal')).toBe(true);
    expect(isCommandAvailableInMode('expand', 'fullscreen')).toBe(false);
    expect(isCommandAvailableInMode('resume', 'minimal')).toBe(true);
    expect(isCommandAvailableInMode('resume', 'fullscreen')).toBe(true);
  });
});

describe('与 G-02 命令映射的一致性', () => {
  it('/minimal /fullscreen /full 都能映射到合法模式（切换命令本身不受模式限定）', () => {
    for (const cmd of ['/minimal', '/fullscreen', '/full']) {
      const target = renderModeForCommand(cmd);
      expect(target === 'fullscreen' || target === 'minimal').toBe(true);
    }
  });

  it('切换命令不在任何限定清单里（两种模式下都可用）', () => {
    for (const cmd of ['minimal', 'fullscreen', 'full']) {
      expect(commandSupportInMode(cmd, 'fullscreen')).toBe('available');
      expect(commandSupportInMode(cmd, 'minimal')).toBe('available');
    }
  });
});
