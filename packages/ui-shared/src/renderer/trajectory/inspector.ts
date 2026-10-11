// 检查器视图模型（D-44）：选中记录 → **局部**检查器字段（不弹新窗口/新路由）。
//
// 字段来源全部真实：token 用量 = assistant/message.usage；耗时 = tool/result.durationMs、
// step/end.durationMs 或真实时间戳差；输入 = 用户正文 / 工具 args；输出 = 助手正文 / 工具
// output/error；附件 = payload.attachments/references。**缺数据一律如实写「未记录」或「无」**。
import { MISSING_VALUE, formatClock, formatDurationMs, formatUsage, previewValue, truncate } from './format.js';
import type {
  TrajectoryAttachment,
  TrajectoryBetweenTurnEntry,
  TrajectoryRow,
  TrajectoryStep,
  TrajectoryStepRole,
  TrajectoryStepState,
  TrajectoryTiming,
} from './types.js';

export interface InspectorEntry {
  readonly label: string;
  readonly value: string;
  /** true = 该字段没有数据（UI 用弱化样式，仍显示占位文案而非留白） */
  readonly missing: boolean;
}

export interface InspectorAttachmentSummary {
  readonly images: readonly TrajectoryAttachment[];
  readonly files: readonly TrajectoryAttachment[];
  /** 摘要文案（有 = 「图片 N / 文件 M」；无 = 「无」） */
  readonly summary: string;
  readonly empty: boolean;
}

export interface TrajectoryInspectorView {
  readonly key: string;
  readonly title: string;
  readonly role: TrajectoryStepRole;
  readonly state: TrajectoryStepState;
  readonly timing: TrajectoryTiming;
  readonly entries: readonly InspectorEntry[];
  readonly attachments: InspectorAttachmentSummary;
  readonly inputText: string;
  readonly outputText: string;
}

/** 附件摘要：无数据 = 空 + 「无」（不伪造数量） */
export function summarizeAttachments(attachments: readonly TrajectoryAttachment[]): InspectorAttachmentSummary {
  const images = attachments.filter((item) => item.kind === 'image');
  const files = attachments.filter((item) => item.kind === 'file');
  const empty = images.length === 0 && files.length === 0;
  return { images, files, summary: empty ? '无' : `图片 ${images.length} / 文件 ${files.length}`, empty };
}

function timingEntries(timing: TrajectoryTiming, role: TrajectoryStepRole): InspectorEntry[] {
  const entries: InspectorEntry[] = [
    {
      label: '开始',
      value: formatClock(timing.startedAtMs) || MISSING_VALUE,
      missing: timing.startedAtMs === null,
    },
    {
      label: '结束',
      value: formatClock(timing.endedAtMs) || MISSING_VALUE,
      missing: timing.endedAtMs === null,
    },
    {
      label: '耗时',
      value: formatDurationMs(timing.durationMs) || MISSING_VALUE,
      missing: timing.durationMs === null,
    },
  ];
  if (role === 'assistant') {
    entries.push({
      label: 'TTFT（首 token）',
      value: formatDurationMs(timing.ttftMs) || MISSING_VALUE,
      missing: timing.ttftMs === null,
    });
    entries.push({
      label: '解码段',
      value: formatDurationMs(timing.decodeMs) || MISSING_VALUE,
      missing: timing.decodeMs === null,
    });
  }
  return entries;
}

/** 步骤 → 检查器字段 */
export function deriveStepInspector(step: TrajectoryStep): TrajectoryInspectorView {
  const inputText = inputOf(step);
  const outputText = outputOf(step);
  const entries: InspectorEntry[] = [
    { label: '记录', value: `#${step.stepMarker} · ${step.label}`, missing: false },
    { label: '角色', value: roleLabel(step.role, step.depth), missing: false },
    { label: '状态', value: stateLabel(step.state), missing: false },
    { label: 'token 用量', value: formatUsage(step.usage), missing: step.usage === undefined },
    ...timingEntries(step.timing, step.role),
    { label: '输入', value: inputText, missing: inputText === MISSING_VALUE },
    { label: '输出', value: outputText, missing: outputText === MISSING_VALUE },
    { label: '附件', value: summarizeAttachments(step.attachments).summary, missing: false },
  ];
  if (step.error !== undefined) entries.push({ label: '错误', value: truncate(step.error), missing: false });
  if (step.childSessionId !== undefined) {
    entries.push({ label: '子会话', value: step.childSessionId, missing: false });
  }
  return {
    key: step.key,
    title: step.label,
    role: step.role,
    state: step.state,
    timing: step.timing,
    entries,
    attachments: summarizeAttachments(step.attachments),
    inputText,
    outputText,
  };
}

/** 独立压缩请求（Between turns）→ 检查器字段 */
export function deriveBetweenTurnsInspector(entry: TrajectoryBetweenTurnEntry): TrajectoryInspectorView {
  const inputText = MISSING_VALUE;
  const outputText = truncate(entry.summary) || MISSING_VALUE;
  return {
    key: entry.key,
    title: 'Compaction request',
    role: 'between-turns',
    state: 'ok',
    timing: entry.timing,
    entries: [
      { label: '记录', value: 'Between turns', missing: false },
      { label: '角色', value: '独立压缩请求', missing: false },
      { label: '状态', value: '已完成', missing: false },
      { label: 'token 用量', value: MISSING_VALUE, missing: true },
      ...timingEntries(entry.timing, 'between-turns'),
      { label: '输入', value: inputText, missing: true },
      { label: '输出（摘要）', value: outputText, missing: false },
      { label: '覆盖至 seq', value: String(entry.coveredUpToSeq), missing: false },
      { label: '附件', value: '无', missing: false },
    ],
    attachments: summarizeAttachments([]),
    inputText,
    outputText,
  };
}

/** 行 → 检查器（分割线行不可选 → null） */
export function deriveInspectorForRow(row: TrajectoryRow): TrajectoryInspectorView | null {
  if (row.kind === 'step') return deriveStepInspector(row.step);
  if (row.kind === 'between-turns') return deriveBetweenTurnsInspector(row.entry);
  return null;
}

function inputOf(step: TrajectoryStep): string {
  if (step.role === 'user') return truncate(step.text ?? MISSING_VALUE);
  if (step.role === 'tool' || step.role === 'subtool') {
    return step.args === undefined ? MISSING_VALUE : previewValue(step.args);
  }
  // 助手行的请求正文**不在事件日志里**（日志只落产出）——如实说明，不凭想象编造
  return MISSING_VALUE;
}

function outputOf(step: TrajectoryStep): string {
  if (step.role === 'user') return MISSING_VALUE;
  if (step.role === 'tool' || step.role === 'subtool') {
    if (step.output !== undefined) return truncate(step.output);
    if (step.error !== undefined) return truncate(step.error);
    if (step.state === 'running') return MISSING_VALUE;
    return MISSING_VALUE;
  }
  if (step.text !== undefined && step.text.length > 0) return truncate(step.text);
  if (step.error !== undefined) return truncate(step.error);
  return MISSING_VALUE;
}

export function roleLabel(role: TrajectoryStepRole, depth: number): string {
  switch (role) {
    case 'user':
      return '用户';
    case 'assistant':
      return '助手';
    case 'tool':
      return '工具';
    case 'subtool':
      return `嵌套子工具（层级 ${depth}）`;
    case 'between-turns':
      return '轮次之间';
    default:
      return role;
  }
}

export function stateLabel(state: TrajectoryStepState): string {
  switch (state) {
    case 'ok':
      return '已完成';
    case 'failed':
      return '失败';
    case 'running':
      return '进行中';
    case 'cancelled':
      return '已取消';
    default:
      return state;
  }
}
