// D4 错误/重试/运行态/能力门控测试：不永久 loading、不假报停止、无能力如实禁用并解释。
import { describe, expect, it } from 'vitest';
import {
  STALL_THRESHOLD_MS,
  cancelStateLabel,
  deriveActionGating,
  deriveRuntimeStatus,
  describeRetryBudget,
  describeTurnEnd,
} from '../src/renderer/features/runtime/runtime-status.js';
import { buildCapabilityReport } from '../src/shared/capabilities.js';
import type { CapabilityReportShape } from '../src/shared/protocol.js';

const base = {
  running: false,
  approvals: 0,
  hasActiveAttempt: false,
  connection: 'connected' as const,
};

describe('deriveRuntimeStatus（不永久 loading / 不假报停止）', () => {
  it('空闲 / 运行中', () => {
    expect(deriveRuntimeStatus(base)).toMatchObject({ state: 'idle' });
    expect(deriveRuntimeStatus({ ...base, running: true, hasActiveAttempt: true })).toMatchObject({
      state: 'running',
    });
  });

  it('有待批 → 等待审批（明确「在等你」）', () => {
    const s = deriveRuntimeStatus({ ...base, running: true, approvals: 2 });
    expect(s.state).toBe('awaiting-approval');
    expect(s.hint).toContain('审批中心');
  });

  it('重连后仍在跑（服务端在途 attempt）→ running，不因客户端重连假报停止', () => {
    expect(deriveRuntimeStatus({ ...base, running: true, hasActiveAttempt: true }).state).toBe('running');
  });

  it('在跑但长时间无帧且无在途 attempt → stalled + 可行动提示（不是一直转圈）', () => {
    const now = 1_000_000;
    const s = deriveRuntimeStatus({ ...base, running: true, lastFrameAt: now - STALL_THRESHOLD_MS - 1 }, now);
    expect(s.state).toBe('stalled');
    expect(s.hint).toContain('重订阅');
  });

  it('连接非 connected：未跑 → unknown（不假装空闲）；在跑 → stalled', () => {
    expect(deriveRuntimeStatus({ ...base, connection: 'offline' })).toMatchObject({ state: 'unknown' });
    expect(deriveRuntimeStatus({ ...base, connection: 'reconnecting', running: true }).state).toBe('stalled');
  });
});

describe('cancelStateLabel（unknown 绝不显示为已停止）', () => {
  it('三态文案区分', () => {
    expect(cancelStateLabel('stopping')).toContain('尚未确认');
    expect(cancelStateLabel('cancelled')).toContain('已取消');
    expect(cancelStateLabel('unknown')).toContain('不能当作已停止');
  });
});

describe('describeRetryBudget / describeTurnEnd', () => {
  it('无重试 → 明确说明；有预算 → 次数/等待/停因齐全', () => {
    expect(describeRetryBudget(undefined)).toContain('未发生重试');
    const text = describeRetryBudget({
      usedAttempts: 2,
      remainingAttempts: 1,
      waitMs: 12_000,
      remainingWaitMs: 108_000,
      stopReason: 'max_extra_attempts',
    });
    expect(text).toContain('已重试 2 次');
    expect(text).toContain('停因：max_extra_attempts');
  });

  it('turn 终态：partial 标注未完成、empty 无语义正文、错误拼接；异常判定', () => {
    expect(describeTurnEnd({ stopReason: 'cancelled', textOutcome: 'partial' })).toEqual({
      label: '未完成 / 已中断',
      isAbnormal: true,
    });
    expect(describeTurnEnd({ stopReason: 'error', textOutcome: 'empty', error: 'network down' })).toEqual({
      label: '无最终文本（network down）',
      isAbnormal: true,
    });
    expect(describeTurnEnd({ stopReason: 'end_turn', textOutcome: 'final' }).isAbnormal).toBe(false);
  });
});

describe('deriveActionGating（能力 × 上下文，禁用必带原因）', () => {
  const allAvailable: CapabilityReportShape = buildCapabilityReport({ serveReady: true });

  it('全部可用 + 无活动 turn：steer 禁用并说明需要活动 turn；cancel 禁用并说明无可取消对象', () => {
    const g = deriveActionGating({ report: allAvailable, hasCancellable: false, hasActiveTurn: false, hasPlan: false });
    expect(g.submitQueue.enabled).toBe(true);
    expect(g.submitSteer).toMatchObject({ enabled: false });
    expect(g.submitSteer.reason).toContain('活动中的 turn');
    expect(g.cancel).toMatchObject({ enabled: false });
    expect(g.viewPlan).toMatchObject({ enabled: false });
    expect(g.viewPlan.reason).toContain('暂无计划');
  });

  it('有活动 turn / 有可取消对象 / 有计划：相应动作放行', () => {
    const g = deriveActionGating({ report: allAvailable, hasCancellable: true, hasActiveTurn: true, hasPlan: true });
    expect(g.submitSteer.enabled).toBe(true);
    expect(g.cancel.enabled).toBe(true);
    expect(g.viewPlan.enabled).toBe(true);
    expect(g.fork.enabled).toBe(true);
    expect(g.resumeSubscription.enabled).toBe(true);
  });

  it('能力未探测（undefined）→ fail-closed 全禁用且说明等待 serve', () => {
    const g = deriveActionGating({ report: undefined, hasCancellable: true, hasActiveTurn: true, hasPlan: true });
    expect(g.submitQueue.enabled).toBe(false);
    expect(g.submitQueue.reason).toContain('尚未探测');
    expect(g.fork.enabled).toBe(false);
  });

  it('后端缺某能力（实测 404 路由缺失）→ 仅该动作禁用并带后端原因', () => {
    const report = buildCapabilityReport({ serveReady: true, unsupportedEndpoints: new Set(['steer', 'fork']) });
    const g = deriveActionGating({ report, hasCancellable: true, hasActiveTurn: true, hasPlan: true });
    expect(g.submitSteer).toMatchObject({ enabled: false });
    expect(g.submitSteer.reason).toContain('未提供该端点');
    expect(g.fork).toMatchObject({ enabled: false });
    expect(g.submitQueue.enabled).toBe(true); // 其余不受影响
  });
});
