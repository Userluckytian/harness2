// 发现模型可搜索选择器的纯逻辑（D-55/D-56）：
//   - 搜索同时匹配 id 与显示名（大小写不敏感）
//   - 勾选状态属于「全集」，过滤只改可见列表——不清除隐藏项勾选
//   - 全选仅加可见结果；取消全选清空全部（与「保留隐藏项」相反的重置语义，二者刻意不对称）
//   - 「添加所选」合并时已有行保留用户调过的值（不覆盖、不重置）
import type { ModelsDiscoveryModelShape, ModelsModelRowShape } from '../../../shared/protocol.js';

/** 搜索匹配：id 或显示名命中即保留（保序） */
export function filterDiscovery(
  models: readonly ModelsDiscoveryModelShape[],
  query: string,
): ModelsDiscoveryModelShape[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q));
}

/** 勾选/取消：作用于全集（隐藏项勾选不受过滤影响） */
export function toggleDiscoverySelection(selected: ReadonlySet<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(selected);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/** 全选仅加可见结果（其他未可见项保持原勾选状态） */
export function selectAllVisible(selected: ReadonlySet<string>, visible: readonly { id: string }[]): Set<string> {
  const next = new Set(selected);
  for (const m of visible) next.add(m.id);
  return next;
}

/** 取消全选：清空全部勾选（含被搜索隐藏的项） */
export function deselectAll(): Set<string> {
  return new Set<string>();
}

/**
 * 添加所选：合并进模型目录。
 * - 已有行（同 id）原样保留（用户调过的 contextWindow/maxOutputTokens 不被覆盖）
 * - 仅追加勾选且尚不存在的行，容量留空（未知就不填，不臆造）
 */
export function mergeDiscoveredModels(
  existing: readonly ModelsModelRowShape[],
  discovered: readonly ModelsDiscoveryModelShape[],
  selected: ReadonlySet<string>,
): ModelsModelRowShape[] {
  const out: ModelsModelRowShape[] = existing.map((m) => ({ ...m }));
  const known = new Set(out.map((m) => m.id.trim()));
  for (const m of discovered) {
    if (!selected.has(m.id)) continue;
    if (known.has(m.id)) continue;
    out.push({ id: m.id });
    known.add(m.id);
  }
  return out;
}

/** 勾选中尚未在目录里的条数（按钮计数展示：只报真实可新增数） */
export function newSelectedCount(existing: readonly ModelsModelRowShape[], selected: ReadonlySet<string>): number {
  const known = new Set(existing.map((m) => m.id.trim()));
  let n = 0;
  for (const id of selected) if (!known.has(id)) n += 1;
  return n;
}
