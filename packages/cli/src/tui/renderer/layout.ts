// layout.ts — 纵向分层布局原语（P2 T2-1）。纯函数、零依赖、可单测。
//
// columnLayout({ total, layers }) 把 total 行按层切分，返回每层的 { top, height }。
// 分配规则（确定性）：
//   1. 固定层（size）：按声明顺序分配，超出剩余预算时截断（极端小终端退化语义）；
//   2. flex 层：瓜分剩余预算；带 min 的层若按比例分得的高度 < min，则抬升到 min
//      并从公共预算中扣除（水填充）；所有 min 之和超出预算时放弃 min 约束，
//      纯按 flex 比例分配（防止布局溢出）；
//   3. 剩余余数（不能整除）归最后一个 flex 层（floor 分配后的差值）。
// 覆盖 grok 分层：scrollback(flex) / 输入框(自适应 size) / 状态行 / 快捷键条(固定)。

/** 层定义：size（固定行数）或 flex（弹性权重）二选一；min 为 flex 层最小高度 */
export interface LayerSpec {
  size?: number;
  flex?: number;
  min?: number;
}

/** 层矩形：距顶部的起始行与高度 */
export interface LayerRect {
  top: number;
  height: number;
}

export interface ColumnLayoutOptions {
  total: number;
  layers: ReadonlyArray<LayerSpec>;
}

export function columnLayout({ total, layers }: ColumnLayoutOptions): LayerRect[] {
  const n = layers.length;
  const heights = new Array<number>(n).fill(0);
  const budget = Math.max(0, total);
  let remaining = budget;
  const flexIdx: number[] = [];

  // 1) 固定层按声明顺序分配（超预算截断）；flex 层登记待分配
  for (let i = 0; i < n; i += 1) {
    const spec = layers[i] ?? {};
    if (spec.size !== undefined && spec.flex === undefined) {
      const h = Math.max(0, Math.min(spec.size, remaining));
      heights[i] = h;
      remaining -= h;
    } else {
      flexIdx.push(i);
    }
  }

  // 2) flex 层水填充：ideal < min 的层抬升到 min 并锁定
  const locked = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    const pool = flexIdx.filter((i) => !locked.has(i));
    const sumFlex = pool.reduce((s, i) => s + flexOf(layers[i]), 0);
    if (pool.length === 0 || sumFlex <= 0) break;
    const minTotal = pool.reduce((s, i) => s + (layers[i]?.min ?? 0), 0);
    if (minTotal > remaining) break; // 预算不足以满足全部 min：放弃 min，按比例分配
    for (const i of pool) {
      const spec = layers[i] ?? {};
      const ideal = (remaining * flexOf(spec)) / sumFlex;
      const min = spec.min ?? 0;
      if (ideal < min) {
        heights[i] = min;
        remaining -= min;
        locked.add(i);
        changed = true;
        break; // 预算已变，重算
      }
    }
  }

  // 3) 剩余 flex 层按比例 floor 分配，余数归尾层
  const pool = flexIdx.filter((i) => !locked.has(i));
  const sumFlex = pool.reduce((s, i) => s + flexOf(layers[i]), 0);
  if (pool.length > 0 && sumFlex > 0) {
    let allocated = 0;
    for (let k = 0; k < pool.length; k += 1) {
      const i = pool[k] ?? 0;
      const spec = layers[i] ?? {};
      if (k === pool.length - 1) {
        heights[i] = Math.max(0, remaining - allocated);
      } else {
        heights[i] = Math.floor((remaining * flexOf(spec)) / sumFlex);
        allocated += heights[i];
      }
    }
  }

  // 4) top 前缀和
  const out: LayerRect[] = [];
  let top = 0;
  for (let i = 0; i < n; i += 1) {
    out.push({ top, height: heights[i] ?? 0 });
    top += heights[i] ?? 0;
  }
  return out;
}

/** flex 权重：缺省 1 */
function flexOf(spec: LayerSpec | undefined): number {
  if (spec === undefined) return 1;
  return spec.flex !== undefined && spec.flex > 0 ? spec.flex : spec.size === undefined ? 1 : 0;
}
