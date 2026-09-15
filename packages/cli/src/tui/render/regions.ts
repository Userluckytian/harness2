// regions.ts — G-04 fullscreen 八布局区域管理器（纯逻辑，headless 可测，零旧壳）。
//
// 八区域（refs-grok-build.md G-04）：scrollback（主区）· prompt（输入）·
// status line（可选）· shortcuts bar（焦点提示）· queue pane · todos pane ·
// tasks pane · overlay modal（命令面板/模型/会话/扩展/设置，顶层）。
//
// 每区域 = { id, min/max 高度, 可见性, render(budget), focusable }。本文件提供：
// - 区域描述符 REGION_DESCRIPTORS：八区域的契约边界（min/max/focusable/hideWhenEmpty）。
// - allocateRegions：确定性高度分配（给定终端行数 → 各区域 {top,height}，纯函数，
//   同输入恒同输出——表驱动测试钉死分配表）。
// - RegionLayoutManager：持有各区域运行时输入（可见性/数据非空标记/渲染回调）的薄壳，
//   layout() 算分配、render() 按预算调用各区域 render——回调由第三批接线注入。
//
// 布局语义（钉死，均为本阶段裁决）：
// - 垂直栈序（底→顶）：shortcutsBar → statusLine → prompt → queuePane → todosPane →
//   tasksPane，固定区簇贴屏幕底部；scrollback 占顶部剩余全部。overlay modal 不在垂直
//   流内：锚定在固定区簇之上（底部贴 promptTop-1、向上生长、钳到屏幕顶）——与
//   next/overlay.ts 的 anchorOverlay 同一语义；本层不复用它是为了保持 render/ 零反向
//   依赖（接线层可任选其一，语义一致）。
// - hideWhenEmpty（queue/todos/tasks）：数据为空（hasData=false）时**自动隐藏**——
//   P3 才接数据源，本阶段三个面板缺省 hasData=false，即缺省不渲染、不造假内容。
// - 小屏退化阶梯（预算 = scrollback 至少 1 行）：tasksPane → todosPane → queuePane →
//   statusLine → shortcutsBar → prompt 依次砍到 0；其中 prompt 先降到自己 minHeight
//   再归零。与 next/chat-screen.ts 的 columnLayout 退化序（composer 先截断、scrollback
//   可为 0）**不同**：本模型 scrollback 最低保 1 行（转录可见优先）。差异登记在案，
//   接线批二选一收敛。
// - prompt 的自然高度（草稿行 + 候选行 + 提示行）由调用方测量传入，本层按描述符
//   min/max 钳制——不内联测量逻辑。
//
// 已知近似（登记）：区域高度只有行数粒度；区域间不画分隔线/边框（CellBuffer 只有
// 前景色通道，与 next 层同一约束）。
import type { CellBuffer } from '../renderer/cell-buffer.js';

/** 八区域 id（G-04 逐项对应，命名即语义） */
export type RegionId =
  'scrollback' | 'prompt' | 'statusLine' | 'shortcutsBar' | 'queuePane' | 'todosPane' | 'tasksPane' | 'overlayModal';

/** 区域描述符：契约边界（不可变的静态属性） */
export interface RegionDescriptor {
  readonly id: RegionId;
  /** 最小高度（行）；预算允许时保证 */
  readonly minHeight: number;
  /** 最大高度（行）；调用方传入的自然高度先经 min/max 钳制 */
  readonly maxHeight: number;
  /** 可聚焦（G-08 焦点环用：prompt / scrollback / overlay 可聚焦，纯展示区不可） */
  readonly focusable: boolean;
  /** true = 数据为空自动隐藏（queue/todos/tasks 三个数据面板） */
  readonly hideWhenEmpty: boolean;
}

/**
 * 八区域描述符（G-04）。maxHeight 契约值说明：
 * - scrollback / prompt / overlayModal 上限放开（∞）：scrollback 弹性占余、prompt 高度
 *   由草稿测量决定、overlay 自然高度由内容决定，截断交给小屏退化兜底。
 * - 三个数据面板 max 6 行是**槽位占位契约**（P3 接数据源时再校准），非 grok 实测值。
 */
export const REGION_DESCRIPTORS: readonly RegionDescriptor[] = [
  { id: 'scrollback', minHeight: 1, maxHeight: Number.POSITIVE_INFINITY, focusable: true, hideWhenEmpty: false },
  { id: 'prompt', minHeight: 1, maxHeight: Number.POSITIVE_INFINITY, focusable: true, hideWhenEmpty: false },
  { id: 'statusLine', minHeight: 1, maxHeight: 1, focusable: false, hideWhenEmpty: false },
  { id: 'shortcutsBar', minHeight: 1, maxHeight: 1, focusable: false, hideWhenEmpty: false },
  { id: 'queuePane', minHeight: 1, maxHeight: 6, focusable: false, hideWhenEmpty: true },
  { id: 'todosPane', minHeight: 1, maxHeight: 6, focusable: false, hideWhenEmpty: true },
  { id: 'tasksPane', minHeight: 1, maxHeight: 6, focusable: false, hideWhenEmpty: true },
  { id: 'overlayModal', minHeight: 1, maxHeight: Number.POSITIVE_INFINITY, focusable: true, hideWhenEmpty: false },
];

/** 垂直栈序（底→顶；overlay modal 不在流内，另行锚定） */
export const REGION_STACK_ORDER: readonly RegionId[] = [
  'shortcutsBar',
  'statusLine',
  'prompt',
  'queuePane',
  'todosPane',
  'tasksPane',
];

/**
 * 小屏退化阶梯（预算不足时的砍单顺序；prompt 两段式：先降 minHeight 再归零）。
 * 数据面板最先砍（本阶段无数据源），输入 prompt 最后归零（输入是交互底线）。
 */
const DEGRADE_LADDER: readonly RegionId[] = [
  'tasksPane',
  'todosPane',
  'queuePane',
  'statusLine',
  'shortcutsBar',
  'prompt',
];

/** 单区域渲染预算：在 [top, top+height) × [0, cols) 内自绘（buf 由装配层给出） */
export interface RegionBudget {
  readonly id: RegionId;
  readonly top: number;
  readonly height: number;
  readonly cols: number;
  readonly buf: CellBuffer;
}

/** 区域渲染回调：只允许写预算矩形内（越界行为由 CellBuffer 自行钳制） */
export type RegionRenderer = (budget: RegionBudget) => void;

/** 布局输入：单区域运行时属性（可见性 / 数据 / 自然高度 / 渲染回调） */
export interface RegionInput {
  /** 期望高度（自然高度；scrollback 忽略此值——它恒拿剩余） */
  readonly naturalHeight?: number;
  /** 装配层可见性开关（缺省 true；叠加 hideWhenEmpty 的数据语义） */
  readonly visible?: boolean;
  /** 数据非空标记（hideWhenEmpty 区域为 false 时强制隐藏；缺省 false） */
  readonly hasData?: boolean;
  /** 渲染回调（未提供 = 该区域即使分配到预算也不画） */
  readonly render?: RegionRenderer;
}

/** 单区域分配结果 */
export interface RegionAllocation {
  readonly id: RegionId;
  readonly top: number;
  readonly height: number;
  /** 本帧实际是否可见（输入可见 && 数据非空（如适用） && 高度 > 0） */
  readonly visible: boolean;
}

/** 一次布局的完整结果 */
export interface RegionLayout {
  /** 全部八区域（含隐藏的：height 0 / visible false；id → 分配一一对应） */
  readonly regions: readonly RegionAllocation[];
  /** overlay modal 顶层分配（无浮层或无空间 = null——顶层不渲染就不存在） */
  readonly overlay: RegionAllocation | null;
}

function descriptorOf(id: RegionId): RegionDescriptor {
  const d = REGION_DESCRIPTORS.find((x) => x.id === id);
  if (d === undefined) throw new Error(`regions: 未登记的区域 ${id}`);
  return d;
}

/** 自然高度按描述符 min/max 钳制（负数自然高度按 minHeight 兜底） */
export function clampRegionHeight(id: RegionId, naturalHeight: number): number {
  const d = descriptorOf(id);
  const want = Math.max(0, Math.floor(naturalHeight));
  return Math.min(Math.max(want, d.minHeight), d.maxHeight);
}

/**
 * 区域在本帧是否有效可见（不做假入口的落点）：
 * - scrollback 主区缺省可见（显式 visible=false 可关）；
 * - 其余区域**必须接线**（有输入）才可见——未接线 = 装配层没提供 = 不渲染；
 * - hideWhenEmpty 区域叠加数据语义（hasData !== true 强制隐藏）；
 * - 显式 visible=false 一票否决。
 */
export function regionVisible(id: RegionId, input: RegionInput | undefined): boolean {
  if (input?.visible === false) return false;
  if (id === 'scrollback') return true;
  if (input === undefined) return false;
  const d = descriptorOf(id);
  if (d.hideWhenEmpty && input.hasData !== true) return false;
  return true;
}

/**
 * 确定性高度分配（纯函数）：给定终端行数与各区域输入 → 各区域 {top,height}。
 *
 * 算法：
 * 1. 可见的垂直流区域按描述符 min/max 钳制期望高度；scrollback 不在此列（拿剩余）。
 * 2. 预算不足（固定区簇期望和 + scrollback 最低 1 行 > rows）时按 DEGRADE_LADDER 砍：
 *    prompt 先降 minHeight 再归零，其余逐区归零，直到预算放得下。
 * 3. scrollback = rows - 固定区簇实际和（≥1；rows=0 时全 0）。
 * 4. 固定区簇贴屏幕底部、按 REGION_STACK_ORDER 自底向上落位；scrollback 占顶部。
 * 5. overlay：有输入且可见时锚定在固定区簇顶（promptTop）之上、向上生长、钳到屏幕顶；
 *    簇顶为 0（无空间）→ null。
 */
export function allocateRegions(rows: number, inputs: ReadonlyMap<RegionId, RegionInput>): RegionLayout {
  const totalRows = Math.max(0, Math.floor(rows));

  // 1) 垂直流可见区域取钳制后期望高度
  const desired = new Map<RegionId, number>();
  for (const id of REGION_STACK_ORDER) {
    if (!regionVisible(id, inputs.get(id))) continue;
    const natural = inputs.get(id)?.naturalHeight ?? descriptorOf(id).minHeight;
    desired.set(id, clampRegionHeight(id, natural));
  }

  // 2) 小屏退化：scrollback 至少 1 行，放不下按阶梯砍。
  //    多轮扫描直到预算放得下或一轮无进展——prompt 的两段式（先降 minHeight 再归零）
  //    需要阶梯扫到它两次（极端小屏如 rows=1 时）。
  const sumOf = (m: Map<RegionId, number>): number => [...m.values()].reduce((s, h) => s + h, 0);
  let progressed = true;
  while (sumOf(desired) + 1 > totalRows && progressed) {
    progressed = false;
    for (const id of DEGRADE_LADDER) {
      if (sumOf(desired) + 1 <= totalRows) break;
      if (!desired.has(id)) continue;
      const min = descriptorOf(id).minHeight;
      const cur = desired.get(id) ?? 0;
      if (id === 'prompt' && cur > min) {
        desired.set(id, min); // 第一段：降到 minHeight
      } else {
        desired.delete(id); // 第二段（或一次性）：归零
      }
      progressed = true;
    }
  }

  // 3) scrollback 拿剩余；rows=0 全零
  const fixedSum = sumOf(desired);
  const scrollbackHeight = Math.max(0, totalRows - fixedSum);

  // 4) 固定区簇贴底、按 REGION_STACK_ORDER（底→顶）自屏幕底向上落位；scrollback 占顶。
  //    零高度区域的 top = 当前游标（簇内边界哨兵，无渲染意义，仅确定性与测试比对用）。
  const regions: RegionAllocation[] = [];
  const scrollTop = descriptorOf('scrollback');
  regions.push({
    id: 'scrollback',
    top: 0,
    height: scrollbackHeight,
    visible: scrollbackHeight >= scrollTop.minHeight && regionVisible('scrollback', inputs.get('scrollback')),
  });
  let cursor = totalRows;
  for (const id of REGION_STACK_ORDER) {
    const h = desired.get(id) ?? 0;
    cursor -= h;
    regions.push({ id, top: cursor, height: h, visible: h > 0 });
  }
  const clusterTop = cursor; // 固定区簇顶（= promptTop 所在侧的簇上边界）

  // 5) overlay 顶层：底部贴固定区簇之上、向上生长、钳到屏幕顶。
  //    无固定区簇（全被小屏退化砍光）→ 无锚点 → null（grok 语义：浮层锚定输入框上方，
  //    输入框不存在就没有锚）；簇顶为 0 同理无空间。
  let overlay: RegionAllocation | null = null;
  const overlayInput = inputs.get('overlayModal');
  if (overlayInput !== undefined && regionVisible('overlayModal', overlayInput) && fixedSum > 0 && clusterTop > 0) {
    const natural = overlayInput.naturalHeight ?? descriptorOf('overlayModal').minHeight;
    const height = Math.min(clampRegionHeight('overlayModal', natural), clusterTop);
    overlay = { id: 'overlayModal', top: clusterTop - height, height, visible: height > 0 };
  }

  return { regions, overlay };
}

/**
 * 八区域布局管理器：持有各区域运行时输入（可见性 / 数据标记 / 渲染回调），
 * layout() 出确定性分配、render() 按预算驱动各区域回调。
 * 数据面板（queue/todos/tasks）缺省 hasData=false → 自动隐藏；**不提供任何假内容**，
 * 数据源由 P3 接入后经 setData 打开。
 */
export class RegionLayoutManager {
  private inputs = new Map<RegionId, RegionInput>();

  /** 设置/替换一个区域的输入（整对象替换，未提到的区域不受影响） */
  setInput(id: RegionId, input: RegionInput): void {
    this.inputs.set(id, input);
  }

  /** 数据面板数据标记（hasData；空 → 自动隐藏） */
  setData(id: RegionId, hasData: boolean): void {
    const prev = this.inputs.get(id) ?? {};
    this.inputs.set(id, { ...prev, hasData });
  }

  /** 装配层可见性开关 */
  setVisible(id: RegionId, visible: boolean): void {
    const prev = this.inputs.get(id) ?? {};
    this.inputs.set(id, { ...prev, visible });
  }

  /** 当前输入快照（测试 / 调试） */
  snapshot(): ReadonlyMap<RegionId, RegionInput> {
    return new Map(this.inputs);
  }

  /** 确定性布局（同输入恒同输出） */
  layout(rows: number): RegionLayout {
    return allocateRegions(rows, this.inputs);
  }

  /**
   * 按布局驱动渲染：只对 visible 且 height > 0 且提供了 render 的区域调用回调，
   * 预算 = { id, top, height, cols, buf }。overlay 顶层最后画（浮层压在固定区之上）。
   */
  render(buf: CellBuffer, layout: RegionLayout): void {
    const cols = buf.cols;
    for (const alloc of layout.regions) {
      if (!alloc.visible || alloc.height <= 0) continue;
      const render = this.inputs.get(alloc.id)?.render;
      if (render === undefined) continue;
      render({ id: alloc.id, top: alloc.top, height: alloc.height, cols, buf });
    }
    if (layout.overlay !== null && layout.overlay.visible && layout.overlay.height > 0) {
      const render = this.inputs.get('overlayModal')?.render;
      if (render !== undefined) {
        render({ id: 'overlayModal', top: layout.overlay.top, height: layout.overlay.height, cols, buf });
      }
    }
  }
}
