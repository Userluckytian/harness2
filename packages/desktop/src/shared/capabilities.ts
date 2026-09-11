// 能力盘点纯逻辑（D0）：把「后端真实具备什么」投影为可行动的能力表。
//
// 红线（Global Constraints #4）：不摆可点击假入口——无后端能力如实 unavailable 并解释。
// 本模块只做纯决策（可注入探测结果单测）；真实探测在 main/bridge.ts（HTTP 只读端点 + serve 状态）。
import type { CapabilityEntryShape, CapabilityIdShape, CapabilityReportShape } from './protocol.js';

/** 能力全集（顺序 = UI 展示顺序） */
export const CAPABILITY_IDS: readonly CapabilityIdShape[] = [
  'serve',
  'run-config',
  'plan-state',
  'execution-view',
  'change-review',
  'queue',
  'steer',
  'cancel',
  'fork',
  'resume-subscription',
];

/** 能力的人类可读名（UI 展示；不可用时的解释以「<名称>：<原因>」呈现） */
export const CAPABILITY_LABELS: Record<CapabilityIdShape, string> = {
  serve: '本地服务',
  'run-config': '有效运行配置',
  'plan-state': '计划状态',
  'execution-view': '命令执行视图',
  'change-review': '变更审查',
  queue: '可靠排队（queue）',
  steer: '中途引导（steer）',
  cancel: '取消 turn / 任务',
  fork: '会话分叉（fork）',
  'resume-subscription': '重订阅恢复',
};

/** 探测输入：serve 状态 + 实测「路由缺失」的只读端点集合（不含「数据缺失」，那是数据条件非能力） */
export interface CapabilityProbe {
  /** serve 是否已连接（端口就绪 + 健康检查 2xx） */
  serveReady: boolean;
  /** 探测中返回「路由不存在」的端点（旧 serve 不提供）；缺省空集 = 全部具备 */
  unsupportedEndpoints?: ReadonlySet<CapabilityIdShape>;
}

export const SERVE_NOT_READY_REASON = '本地 serve 未就绪（等待连接）';

/**
 * 构建能力报告：serve 未就绪时全表 unavailable（原因统一为等待连接）；
 * 否则除实测缺失的端点外全部 available。缺省可用（冻结契约保证），
 * 缺失必须由**实测**得出——不臆造、也不因为「担心」而误报不可用。
 */
export function buildCapabilityReport(
  probe: CapabilityProbe,
  now: string = new Date().toISOString(),
): CapabilityReportShape {
  const unsupported = probe.unsupportedEndpoints ?? new Set<CapabilityIdShape>();
  const entries: CapabilityEntryShape[] = CAPABILITY_IDS.map((id) => {
    if (!probe.serveReady) {
      return id === 'serve'
        ? { id, status: 'unavailable', reason: SERVE_NOT_READY_REASON }
        : { id, status: 'unavailable', reason: SERVE_NOT_READY_REASON };
    }
    if (unsupported.has(id)) {
      return { id, status: 'unavailable', reason: '当前 serve 未提供该端点（可能为旧版本）' };
    }
    return { id, status: 'available' };
  });
  return { probedAt: now, entries };
}

/** 能力是否可用（未知 id 视为不可用——fail-closed，不默认放行） */
export function capabilityEnabled(report: CapabilityReportShape | null | undefined, id: CapabilityIdShape): boolean {
  if (report === null || report === undefined) return false;
  return report.entries.find((e) => e.id === id)?.status === 'available';
}

/** 不可用原因（可用/未知 → undefined） */
export function capabilityReason(
  report: CapabilityReportShape | null | undefined,
  id: CapabilityIdShape,
): string | undefined {
  if (report === null || report === undefined) return undefined;
  return report.entries.find((e) => e.id === id)?.reason;
}

/**
 * serve 只读端点探测结果 → 不支持集合。
 * 判定口径（与 core http.ts 一致）：
 *   - 404 且 error 以 `not found:` 开头 → 路由缺失（旧 serve）→ 该端点记 unsupported；
 *   - 404 且 error 为「会话暂无计划数据」等业务语义 → 路由存在（数据缺失）→ 仍 available；
 *   - 2xx → available；其余错误（401/500/网络）→ 不臆断缺失（保持 available，由调用方按需报错）。
 */
export function classifyProbeResponse(endpoint: CapabilityIdShape, status: number, error?: string): boolean {
  if (status !== 404) return false;
  const msg = typeof error === 'string' ? error : '';
  if (msg.startsWith('not found:')) return true;
  void endpoint;
  return false;
}
