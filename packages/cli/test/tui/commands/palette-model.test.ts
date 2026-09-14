// P3-A palette-model 单测（headless）：G-31/G-50~G-53 纯逻辑对齐上游
// views/modal.rs filter_palette_entries + views/picker.rs handle_picker_input。
// 覆盖：条目构建（core/shell 来源、模式限定 badge、分组）、模糊过滤（子串包含、
// 组头随组命中保留）、↑↓ 移动（跳过组头、端点钳制不回绕）、Enter（执行/组头 no-op）、
// 查询编辑、esc-machine 缝（paletteCardDepth；负向：本模块不提供 Esc 分支）。
import { describe, expect, it } from 'vitest';
import { describeCapabilities } from '@harness2/core';
import {
  buildPaletteEntries,
  filterPaletteRows,
  paletteBackspace,
  paletteBadge,
  paletteCardDepth,
  paletteClosed,
  paletteCommandLine,
  paletteEnter,
  paletteMove,
  paletteOpenState,
  paletteSetQuery,
  type PaletteEntry,
  type PaletteState,
} from '../../../src/tui/commands/palette-model.js';

/** 构造条目的便捷工厂（测试专用；modeSupport 由调用方给定） */
function entry(
  name: string,
  group: string,
  modeSupport: PaletteEntry['modeSupport'] = 'available',
  source: 'core' | 'shell' = 'core',
): PaletteEntry {
  return { name, summary: `${name} 的描述`, source, group, modeSupport };
}

const FIXTURE: readonly PaletteEntry[] = [
  entry('new', '会话'),
  entry('session-info', '会话'),
  entry('timeline', '历史', 'unavailable-fullscreen-only'),
  entry('help', '通用'),
  entry('mode', '模式'),
  entry('expand', '模式', 'unavailable-minimal-only', 'shell'),
];

describe('buildPaletteEntries（G-50 合并来源）', () => {
  it('core 条目唯一来源 describeCapabilities()，id 全集一致', () => {
    const entries = buildPaletteEntries('fullscreen', []);
    expect(entries.map((e) => e.name)).toEqual(describeCapabilities().commands.map((c) => c.id));
  });

  it('badge 派生：core 实现 → core；shellOnly（mode/minimal/fullscreen/export 等）→ shell', () => {
    const entries = buildPaletteEntries('fullscreen', []);
    expect(paletteBadge(entries.find((e) => e.name === 'new')!)).toBe('core');
    expect(paletteBadge(entries.find((e) => e.name === 'context')!)).toBe('core');
    expect(paletteBadge(entries.find((e) => e.name === 'mode')!)).toBe('shell');
    expect(paletteBadge(entries.find((e) => e.name === 'minimal')!)).toBe('shell');
    expect(paletteBadge(entries.find((e) => e.name === 'export')!)).toBe('shell');
  });

  it('模式限定经 commandSupportInMode：timeline 仅 fullscreen（G-03）', () => {
    const fs = buildPaletteEntries('fullscreen', []);
    const mn = buildPaletteEntries('minimal', []);
    expect(fs.find((e) => e.name === 'timeline')!.modeSupport).toBe('available');
    expect(mn.find((e) => e.name === 'timeline')!.modeSupport).toBe('unavailable-fullscreen-only');
    // 模式 badge 文案
    expect(paletteBadge(mn.find((e) => e.name === 'timeline')!)).toBe('仅 fullscreen');
    // 壳条目同样参与模式限定（expand 为 next 层仅 minimal 命令，经壳源注入）
    const withShell = buildPaletteEntries('fullscreen', [{ name: 'expand', summary: '重放转录' }]);
    expect(paletteBadge(withShell.find((e) => e.name === 'expand')!)).toBe('仅 minimal');
  });

  it('壳条目追加在 core 之后，缺省分组「通用」，同样参与模式限定', () => {
    // P7 加性：core catalog 新增 /search（会话全文检索）——壳 fixture 改用 /expand（仍是 next 壳命令）
    // 避免与 core id 撞名（buildPaletteEntries 会剔除 core 已有名的壳条目）。
    const entries = buildPaletteEntries('fullscreen', [
      { name: 'plan', summary: '声明 plan 模式', group: '模式' },
      { name: 'expand', summary: '重放转录' },
    ]);
    expect(entries.slice(-2).map((e) => e.name)).toEqual(['plan', 'expand']);
    expect(entries.find((e) => e.name === 'plan')!.group).toBe('模式');
    expect(entries.find((e) => e.name === 'expand')!.group).toBe('通用');
    expect(entries.find((e) => e.name === 'expand')!.source).toBe('shell');
  });
});

describe('filterPaletteRows（G-50/G-51 模糊匹配，上游 filter_palette_entries 口径）', () => {
  it('空查询 = 全部条目，组头按首遇顺序插入且不重复', () => {
    const rows = filterPaletteRows('', FIXTURE);
    expect(rows.filter((r) => r.kind === 'header').map((r) => (r as { label: string }).label)).toEqual([
      '会话',
      '历史',
      '通用',
      '模式',
    ]);
    expect(rows.filter((r) => r.kind === 'command')).toHaveLength(FIXTURE.length);
  });

  it('子串包含匹配命中命令词（/前缀形式）与摘要，大小写不敏感', () => {
    const rows = filterPaletteRows('info', FIXTURE);
    expect(rows.map((r) => (r.kind === 'command' ? r.entry.name : `#${r.label}`))).toEqual(['#会话', 'session-info']);
    // 摘要匹配（'描述' 在每条 summary 里——全部命中，组头各保留一次）
    const bySummary = filterPaletteRows('的描述', FIXTURE);
    expect(bySummary.filter((r) => r.kind === 'command')).toHaveLength(FIXTURE.length);
    const upper = filterPaletteRows('HELP', FIXTURE);
    expect(upper.some((r) => r.kind === 'command' && r.entry.name === 'help')).toBe(true);
  });

  it('组内无命中 → 组头整组省略（上游 section_has_match 语义）', () => {
    const rows = filterPaletteRows('help', FIXTURE);
    const labels = rows.map((r) => (r.kind === 'command' ? r.entry.name : `#${r.label}`));
    expect(labels).toEqual(['#通用', 'help']);
  });

  it('无命中返回空数组（/zz）', () => {
    expect(filterPaletteRows('zz', FIXTURE)).toEqual([]);
  });
});

describe('paletteMove（↑↓：跳过组头、端点钳制不回绕，上游 handle_picker_input）', () => {
  const rows = filterPaletteRows('', FIXTURE); // [#会话, new, session-info, #历史, timeline, #通用, help, #模式, mode, expand]
  function at(state: PaletteState, i: number): PaletteState {
    return { ...state, active: i };
  }

  it('开面板归一到首个可选行（跳过最前面的组头）', () => {
    const st = paletteOpenState(rows);
    expect(rows[st.active]).toMatchObject({ kind: 'command', entry: { name: 'new' } });
  });

  it('↓ 跳过组头；↑ 同理', () => {
    let st = paletteOpenState(rows);
    st = paletteMove(st, rows, 1); // new → session-info
    expect((rows[st.active] as { entry: PaletteEntry }).entry.name).toBe('session-info');
    st = paletteMove(st, rows, 1); // 跳过 #历史 → timeline
    expect((rows[st.active] as { entry: PaletteEntry }).entry.name).toBe('timeline');
    st = paletteMove(st, rows, -1); // 回到 session-info
    expect((rows[st.active] as { entry: PaletteEntry }).entry.name).toBe('session-info');
  });

  it('首/末可选行钳制：到端点后继续按不动（不回绕）', () => {
    const first = rows.findIndex((r) => r.kind === 'command');
    const lastRev = [...rows].reverse().find((r) => r.kind === 'command');
    const last = rows.lastIndexOf(lastRev!);
    let st = at(paletteClosed(), first);
    st = paletteMove(st, rows, -1);
    expect(st.active).toBe(first);
    st = at(paletteClosed(), last);
    st = paletteMove(st, rows, 1);
    expect(st.active).toBe(last);
  });

  it('无可选行（空表）移动为 no-op', () => {
    const st = paletteOpenState([]);
    expect(paletteMove(st, [], 1)).toBe(st);
  });
});

describe('paletteEnter（G-51 回车直执行；上游 SendSlashCommandPreservingDraft 语义）', () => {
  const rows = filterPaletteRows('', FIXTURE);

  it('选中命令 → 关面板 + 产出执行效果（name 不含 /）', () => {
    let st = paletteOpenState(rows);
    st = paletteMove(st, rows, 1); // session-info
    const r = paletteEnter(st, rows);
    expect(r.effect).toEqual({ kind: 'execute', name: 'session-info' });
    expect(r.state.open).toBe(false);
    expect(paletteCommandLine(r.effect!.name)).toBe('/session-info');
  });

  it('组头/空表 Enter 是 no-op（面板不关、无效果）——上游 SectionHeader=Changed', () => {
    const headerIdx = rows.findIndex((r) => r.kind === 'header');
    const onHeader = paletteEnter({ ...paletteClosed(), open: true, active: headerIdx }, rows);
    expect(onHeader.effect).toBeNull();
    expect(onHeader.state.open).toBe(true);
    const onEmpty = paletteEnter(paletteOpenState([]), []);
    expect(onEmpty.effect).toBeNull();
  });

  it('paletteCommandLine 补 / 前缀（宿主 submitCommand 入参）', () => {
    expect(paletteCommandLine('new')).toBe('/new');
  });
});

describe('查询编辑（上游 picker 逐字过滤语义）', () => {
  const entries = FIXTURE;
  it('setQuery 重置 active 到首个可选行', () => {
    const rows0 = filterPaletteRows('', entries);
    let st = paletteOpenState(rows0);
    st = paletteMove(st, rows0, 1);
    expect(st.active).toBe(2); // #会话(0) → new(1) → session-info(2)
    const rows1 = filterPaletteRows('info', entries);
    st = paletteSetQuery(st, 'info', rows1);
    expect(rows1[st.active]).toMatchObject({ kind: 'command', entry: { name: 'session-info' } });
  });

  it('backspace 按码点删除（中文整字符），空查询原样返回', () => {
    const rows = filterPaletteRows('', entries);
    let st = paletteSetQuery(paletteOpenState(rows), '模式', rows);
    st = paletteBackspace(st, rows);
    expect(st.query).toBe('模');
    st = paletteBackspace(st, rows);
    expect(st.query).toBe('');
    expect(paletteBackspace(st, rows)).toBe(st);
  });

  it('过滤到空后 active = -1，Enter no-op', () => {
    const rows0 = filterPaletteRows('', entries);
    const st = paletteSetQuery(paletteOpenState(rows0), 'zz', []);
    expect(st.active).toBe(-1);
    expect(paletteEnter(st, []).effect).toBeNull();
  });
});

describe('esc-machine 缝（Esc 不开特例）', () => {
  it('paletteCardDepth：打开 = 1 层浮层，关闭 = 0', () => {
    const rows = filterPaletteRows('', FIXTURE);
    expect(paletteCardDepth(paletteOpenState(rows))).toBe(1);
    expect(paletteCardDepth(paletteClosed())).toBe(0);
  });

  it('关闭态是唯一默认值（open=false/query 空/active=-1）', () => {
    expect(paletteClosed()).toEqual({ open: false, query: '', active: -1 });
  });
});
