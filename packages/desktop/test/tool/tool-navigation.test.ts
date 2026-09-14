// 工具卡跳转契约测试（P6-C / D-86）：
//   ① openFile → 右栏文本预览（真实现：待打开文件状态 + 右栏消费）；
//   ② inspect → 轨迹视图（A 棒 `ui-trajectory` 注册后才放行；未装配 → 失败且**不渲染入口**）；
//   ③ 单视图口径：不存在第二个全高详情视图的状态位。
// 纯逻辑测试（node 环境，无 DOM）。
import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_CARD_SINGLE_VIEW,
  TOOL_INSPECT_TARGET,
  TOOL_OPEN_FILE_TARGET,
  TRAJECTORY_VIEW_KEY,
  createToolNavigation,
  toolJumpActions,
} from '../../src/renderer/tool/index.js';

describe('D-86 ①：openFile 路由右栏文本预览', () => {
  it('打开文件 → 目标 = 右栏，且待打开状态可被右栏消费（路径/行号/会话/调用）', () => {
    const nav = createToolNavigation();
    const seen: unknown[] = [];
    nav.subscribe(() => seen.push(nav.getSnapshot()));

    const result = nav.openFile({ path: 'src/a.ts', line: 12, sessionId: 's1', callId: 'c1' });
    expect(result).toEqual({ ok: true, target: TOOL_OPEN_FILE_TARGET });
    expect(TOOL_OPEN_FILE_TARGET).toBe('rightbar');
    expect(nav.getSnapshot().filePreview).toMatchObject({
      path: 'src/a.ts',
      line: 12,
      sessionId: 's1',
      callId: 'c1',
    });
    expect(seen.length).toBe(1); // 订阅者收到通知（右栏据此切分区/打开右栏）

    nav.clearFilePreview();
    expect(nav.getSnapshot().filePreview).toBeNull();
  });

  it('空路径 → 失败（不产生"打开了个空文件"的假状态）', () => {
    const nav = createToolNavigation();
    expect(nav.openFile({ path: '' })).toEqual({
      ok: false,
      target: TOOL_OPEN_FILE_TARGET,
      reason: 'empty-path',
    });
    expect(nav.getSnapshot().filePreview).toBeNull();
  });

  it('后一次打开覆盖前一次（右栏只有一个预览位）', () => {
    const nav = createToolNavigation();
    nav.openFile({ path: 'a.ts' });
    nav.openFile({ path: 'b.ts' });
    expect(nav.getSnapshot().filePreview?.path).toBe('b.ts');
  });
});

describe('D-86 ②：inspect 开轨迹视图', () => {
  it('轨迹视图未装配 → 失败（view-not-assembled）且动作面不给 inspect（不造假按钮）', () => {
    const nav = createToolNavigation();
    expect(nav.canInspect()).toBe(false);
    expect(nav.inspectViewKey()).toBeNull();
    expect(nav.inspect({ sessionId: 's1', callId: 'c1' })).toEqual({
      ok: false,
      target: TOOL_INSPECT_TARGET,
      reason: 'view-not-assembled',
    });
    const actions = toolJumpActions(nav);
    expect(actions.openFile).toBeTypeOf('function'); // 右栏已装配 → 有入口
    expect(actions.inspect).toBeUndefined(); // 轨迹未装配 → 无入口
  });

  it('注册轨迹视图（A 棒契约）→ inspect 投递给消费者并带会话/调用/序号；key 由消费者给出', () => {
    const nav = createToolNavigation();
    const open = vi.fn();
    const dispose = nav.registerTrajectoryView({ key: TRAJECTORY_VIEW_KEY, open });

    expect(nav.canInspect()).toBe(true);
    expect(nav.inspectViewKey()).toBe('trajectory'); // 与 A 棒 TRAJECTORY_VIEW_KEY 同 key
    expect(nav.inspect({ sessionId: 's1', callId: 'c1', seq: 42 })).toEqual({
      ok: true,
      target: TOOL_INSPECT_TARGET,
    });
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', callId: 'c1', seq: 42 });
    expect(toolJumpActions(nav).inspect).toBeTypeOf('function');

    dispose();
    dispose(); // 幂等
    expect(nav.canInspect()).toBe(false);
    expect(nav.inspectViewKey()).toBeNull();
  });

  it('缺会话上下文 → 失败（missing-session，无法定位会话视图环）', () => {
    const nav = createToolNavigation();
    nav.registerTrajectoryView({ key: TRAJECTORY_VIEW_KEY, open: () => {} });
    expect(nav.inspect({ sessionId: '' })).toEqual({
      ok: false,
      target: TOOL_INSPECT_TARGET,
      reason: 'missing-session',
    });
  });
});

describe('D-86 单视图口径', () => {
  it('工具卡只在内联视图里，没有"第二个全高详情视图"的开关位', () => {
    expect(TOOL_CARD_SINGLE_VIEW).toBe(true);
    const nav = createToolNavigation();
    // 跳转契约只暴露两条路由（右栏 / 轨迹），不存在 'tool-detail' 之类的详情面板目标
    expect(Object.keys(nav).sort()).toEqual(
      [
        'canInspect',
        'clearFilePreview',
        'getSnapshot',
        'inspect',
        'inspectViewKey',
        'openFile',
        'registerTrajectoryView',
        'subscribe',
      ].sort(),
    );
  });
});
