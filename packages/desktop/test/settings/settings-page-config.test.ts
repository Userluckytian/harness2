// 设置分区配置表测试（Z-89 数据驱动）：分组归属、可见性（无数据的分区不进表）、
// models 分区 id 稳定（Z3-04 直达依赖）。改归属先改这里，再改 page-config.ts。
import { describe, expect, it } from 'vitest';
import { MODELS_SECTION_ID, SETTINGS_SECTION_GROUPS } from '../../src/renderer/settings/shell/index.js';
import { SETTINGS_SECTION_META } from '../../src/renderer/settings/page-config.js';

/** 期望的分组归属表（导航显示顺序 = 组顺序 × 组内 order） */
const EXPECTED: Record<string, string> = {
  // basics
  general: 'basics',
  appearance: 'basics',
  [MODELS_SECTION_ID]: 'basics',
  browser: 'basics',
  approval: 'basics',
  shortcuts: 'basics',
  // agentCapabilities
  memory: 'agentCapabilities',
  subagent: 'agentCapabilities',
  plugins: 'agentCapabilities',
  mcp: 'agentCapabilities',
  skill: 'agentCapabilities',
  cron: 'agentCapabilities',
  credentials: 'agentCapabilities',
  // dataAndStats
  sessions: 'dataAndStats',
  diagnostics: 'dataAndStats',
  about: 'dataAndStats',
};

describe('设置分区配置表（Z-89）：分组与可见性', () => {
  it('id 全唯一，且归属与期望表完全一致（basics / agentCapabilities / dataAndStats 三组）', () => {
    const ids = SETTINGS_SECTION_META.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.fromEntries(SETTINGS_SECTION_META.map((m) => [m.id, m.group]))).toEqual(EXPECTED);
  });

  it('组清单就是 Z-89 三组（顺序 = 导航组顺序）', () => {
    expect(SETTINGS_SECTION_GROUPS.map((g) => g.id)).toEqual(['basics', 'agentCapabilities', 'dataAndStats']);
  });

  it('可见性 = 数据驱动：ZCode 有而我们无数据的分区不进表（列了就是假入口）', () => {
    const ids = new Set(SETTINGS_SECTION_META.map((m) => m.id));
    for (const fake of ['hooks', 'commands', 'computerUse', 'automations', 'workspaceFileSearch', 'usage']) {
      expect(ids.has(fake)).toBe(false);
    }
    // A07/A08（批次4）：mcp 与 skill 有真数据面进表（对齐 ZCode 归属 agentCapabilities；
    // 此前「mcp 并入 plugins 节」的差异登记作废）
    expect(ids.has('mcp')).toBe(true);
    expect(ids.has('skill')).toBe(true);
    expect(ids.has('plugins')).toBe(true);
  });

  it('A07/A08：mcp/skill 的顺序在 plugins 之后 cron 之前（对齐 ZCode plugin→mcp→skill）', () => {
    const orderOf = (id: string): number => {
      const m = SETTINGS_SECTION_META.find((s) => s.id === id);
      expect(m, `分区 ${id} 存在`).toBeTruthy();
      return m!.order;
    };
    expect(orderOf('plugins')).toBeLessThan(orderOf('mcp'));
    expect(orderOf('mcp')).toBeLessThan(orderOf('skill'));
    expect(orderOf('skill')).toBeLessThan(orderOf('cron'));
    const mcp = SETTINGS_SECTION_META.find((s) => s.id === 'mcp')!;
    expect(mcp.label).toBe('MCP 服务器');
    expect(mcp.group).toBe('agentCapabilities');
    const skill = SETTINGS_SECTION_META.find((s) => s.id === 'skill')!;
    expect(skill.label).toBe('技能');
    expect(skill.group).toBe('agentCapabilities');
  });

  it('models 分区 id 稳定为 MODELS_SECTION_ID（Z3-04「管理模型」直达的落点）', () => {
    const models = SETTINGS_SECTION_META.find((m) => m.id === MODELS_SECTION_ID);
    expect(models?.group).toBe('basics');
    expect(models?.owner).toBe('ui-settings-models');
    expect(models?.label).toBe('模型配置');
  });

  it('组内 order 严格升序；每条元数据齐备（label/en/owner/icon）', () => {
    for (const g of SETTINGS_SECTION_GROUPS) {
      const orders = SETTINGS_SECTION_META.filter((m) => m.group === g.id).map((m) => m.order);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
      expect(new Set(orders).size).toBe(orders.length);
    }
    for (const m of SETTINGS_SECTION_META) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.en.length).toBeGreaterThan(0);
      expect(m.owner.length).toBeGreaterThan(0);
      expect(m.icon).toBeTypeOf('function');
    }
  });
});
