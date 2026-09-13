// G-01/G-02 渲染模式状态机单测（headless，纯逻辑）：
// - 默认 fullscreen；进程内切换事件流（from/to/reason/restartRequired=false 类型钉死）
// - 同模式切换幂等（空操作、原引用返回）；事件日志 append-only
// - 斜杠命令映射（/minimal /fullscreen /full）
// - 配置 [ui] screen_mode 解析（未配置/合法/非法回退 + 告警文案）
// - GROK_SCREEN_MODE_SWITCH=exec 识别（重执行变体，实现下放 P3——只测识别本身）
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDER_MODE,
  RENDER_MODES,
  SCREEN_MODE_CONFIG_PATH,
  SCREEN_MODE_SWITCH_ENV,
  createRenderModeState,
  parseScreenModeConfig,
  parseScreenModeSwitchEnv,
  renderModeForCommand,
  resolveInitialRenderMode,
  switchRenderMode,
} from '../../../src/tui/render/mode.js';

describe('初始状态（G-01）', () => {
  it('缺省为 fullscreen，无切换历史', () => {
    const s = createRenderModeState();
    expect(s.mode).toBe('fullscreen');
    expect(s.switchCount).toBe(0);
    expect(s.events).toEqual([]);
  });

  it('DEFAULT_RENDER_MODE 常量即 fullscreen；合法模式全集两个', () => {
    expect(DEFAULT_RENDER_MODE).toBe('fullscreen');
    expect(RENDER_MODES).toEqual(['fullscreen', 'minimal']);
  });

  it('可显式以 minimal 启动（配置初值由调用方传入）', () => {
    expect(createRenderModeState('minimal').mode).toBe('minimal');
  });
});

describe('进程内切换（G-02 不重启语义）', () => {
  it('fullscreen → minimal：产生 mode-switched 事件，restartRequired 恒 false', () => {
    const s = createRenderModeState();
    const r = switchRenderMode(s, 'minimal', 'slash-command');
    expect(r.event).toEqual({
      type: 'mode-switched',
      from: 'fullscreen',
      to: 'minimal',
      reason: 'slash-command',
      restartRequired: false,
    });
    expect(r.state.mode).toBe('minimal');
    expect(r.state.switchCount).toBe(1);
  });

  it('来回连续切换：事件日志 append-only、序号单调递增、lineage 不断', () => {
    let s = createRenderModeState();
    const r1 = switchRenderMode(s, 'minimal', 'slash-command');
    s = r1.state;
    const r2 = switchRenderMode(s, 'fullscreen', 'slash-command');
    s = r2.state;
    const r3 = switchRenderMode(s, 'minimal', 'config');
    s = r3.state;
    expect(s.switchCount).toBe(3);
    expect(s.events.map((e) => [e.from, e.to, e.reason])).toEqual([
      ['fullscreen', 'minimal', 'slash-command'],
      ['minimal', 'fullscreen', 'slash-command'],
      ['fullscreen', 'minimal', 'config'],
    ]);
    // 同一条状态链上逐步切换——没有任何环节产生「新进程」语义
    expect(s.events.every((e) => e.restartRequired === false)).toBe(true);
  });

  it('同模式切换幂等：原引用返回、无事件、计数不变', () => {
    const s = createRenderModeState();
    const r = switchRenderMode(s, 'fullscreen', 'slash-command');
    expect(r.event).toBeNull();
    expect(r.state).toBe(s); // === 判定：调用方可据此跳过重渲染
    expect(r.state.switchCount).toBe(0);
  });

  it('reducer 纯度：切换不改写原状态（原状态事件数不变）', () => {
    const s = createRenderModeState();
    switchRenderMode(s, 'minimal', 'slash-command');
    expect(s.mode).toBe('fullscreen');
    expect(s.events).toHaveLength(0);
  });

  it('事件键白名单（P2-② 补）：mode-switched 事件恰好五键——不存在可藏「重启/重建」语义的字段', () => {
    const r = switchRenderMode(createRenderModeState(), 'minimal', 'slash-command');
    expect(r.event).not.toBeNull();
    expect(Object.keys(r.event!)).toEqual(['type', 'from', 'to', 'reason', 'restartRequired']);
    expect(Object.values(r.event!).some((v) => typeof v === 'object' && v !== null)).toBe(false);
  });

  it('状态全量形状（P2-② 补）：只有 mode/switchCount/events 三键——状态机不持有会话/草稿等运行时句柄（切模式不丢运行时状态的结构性依据）', () => {
    const r = switchRenderMode(createRenderModeState(), 'minimal', 'config');
    expect(Object.keys(r.state)).toEqual(['mode', 'switchCount', 'events']);
    expect(r.state).toEqual({ mode: 'minimal', switchCount: 1, events: [r.event] });
  });
});

describe('斜杠命令映射（G-02/G-75）', () => {
  it('/minimal → minimal（前导斜杠容忍）', () => {
    expect(renderModeForCommand('/minimal')).toBe('minimal');
    expect(renderModeForCommand('minimal')).toBe('minimal');
  });

  it('/fullscreen 与缩写 /full 等价 → fullscreen', () => {
    expect(renderModeForCommand('/fullscreen')).toBe('fullscreen');
    expect(renderModeForCommand('/full')).toBe('fullscreen');
    expect(renderModeForCommand('full')).toBe('fullscreen');
  });

  it('其余命令（含模式无关命令）返回 null，不做越权判定', () => {
    expect(renderModeForCommand('/theme')).toBeNull();
    expect(renderModeForCommand('/unknown')).toBeNull();
    expect(renderModeForCommand('')).toBeNull();
  });
});

describe('配置 [ui] screen_mode 解析', () => {
  it('未配置（undefined）：无模式、无告警', () => {
    expect(parseScreenModeConfig(undefined)).toEqual({ mode: null, warning: null });
  });

  it('合法值 fullscreen / minimal 原样生效', () => {
    expect(parseScreenModeConfig('fullscreen')).toEqual({ mode: 'fullscreen', warning: null });
    expect(parseScreenModeConfig('minimal')).toEqual({ mode: 'minimal', warning: null });
  });

  it('非法字符串：null + 一行告警（回退 fullscreen 文案）', () => {
    const r = parseScreenModeConfig('tiny');
    expect(r.mode).toBeNull();
    expect(r.warning).toContain('config.ui.screen_mode');
    expect(r.warning).toContain('"tiny"');
    expect(r.warning).toContain('回退 fullscreen');
  });

  it('非字符串类型同样告警不抛错', () => {
    expect(parseScreenModeConfig(42).mode).toBeNull();
    expect(parseScreenModeConfig(42).warning).toContain('42');
    expect(parseScreenModeConfig(null).mode).toBeNull();
  });
});

describe('resolveInitialRenderMode（配置对象 → 初始模式）', () => {
  it('无配置 → fullscreen、无告警', () => {
    expect(resolveInitialRenderMode(undefined)).toEqual({ mode: 'fullscreen', warning: null });
    expect(resolveInitialRenderMode({})).toEqual({ mode: 'fullscreen', warning: null });
  });

  it('[ui] screen_mode = minimal → minimal 生效', () => {
    expect(resolveInitialRenderMode({ ui: { screen_mode: 'minimal' } }).mode).toBe('minimal');
  });

  it('非法值回退 fullscreen 并带告警', () => {
    const r = resolveInitialRenderMode({ ui: { screen_mode: 'bogus' } });
    expect(r.mode).toBe('fullscreen');
    expect(r.warning).not.toBeNull();
  });
});

describe('GROK_SCREEN_MODE_SWITCH 识别（G-02；重执行实现下放 P3）', () => {
  it("环境变量名常量 = 'GROK_SCREEN_MODE_SWITCH'；配置路径常量 = 'ui.screen_mode'", () => {
    expect(SCREEN_MODE_SWITCH_ENV).toBe('GROK_SCREEN_MODE_SWITCH');
    expect(SCREEN_MODE_CONFIG_PATH).toBe('ui.screen_mode');
  });

  it("'exec' 识别为重执行变体（大小写不敏感、首尾空白容忍）", () => {
    expect(parseScreenModeSwitchEnv('exec')).toBe('exec');
    expect(parseScreenModeSwitchEnv('EXEC')).toBe('exec');
    expect(parseScreenModeSwitchEnv(' exec ')).toBe('exec');
  });

  it('未设 / 显式 inprocess / 未知值一律 inprocess（宽松降级）', () => {
    expect(parseScreenModeSwitchEnv(undefined)).toBe('inprocess');
    expect(parseScreenModeSwitchEnv('')).toBe('inprocess');
    expect(parseScreenModeSwitchEnv('inprocess')).toBe('inprocess');
    expect(parseScreenModeSwitchEnv('restart')).toBe('inprocess');
  });
});
