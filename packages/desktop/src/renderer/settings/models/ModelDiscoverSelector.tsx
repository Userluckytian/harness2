// D-55/D-56：发现模型的可搜索选择器（不是直写）。
// 「获取可用模型」成功后打开；点「添加所选」才写入模型目录；搜索/全选语义见 discover.ts。
import { useMemo, useState } from 'react';
import type { ModelsDiscoveryModelShape, ModelsModelRowShape } from '../../../shared/protocol.js';
import {
  deselectAll,
  filterDiscovery,
  mergeDiscoveredModels,
  newSelectedCount,
  selectAllVisible,
  toggleDiscoverySelection,
} from './discover.js';

export interface ModelDiscoverSelectorProps {
  models: readonly ModelsDiscoveryModelShape[];
  existing: readonly ModelsModelRowShape[];
  /** 标题（提供方名，便于确认在给谁加模型） */
  providerLabel: string;
  onApply(merged: ModelsModelRowShape[]): void;
  onCancel(): void;
}

export function ModelDiscoverSelector({
  models,
  existing,
  providerLabel,
  onApply,
  onCancel,
}: ModelDiscoverSelectorProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  const visible = useMemo(() => filterDiscovery(models, query), [models, query]);
  const addCount = newSelectedCount(existing, selected);
  const allVisibleSelected = visible.length > 0 && visible.every((m) => selected.has(m.id));

  return (
    <div className="models-discover" role="group" aria-label={`可添加的模型（${providerLabel}）`}>
      <div className="models-discover-head">
        <input
          className="models-input models-discover-search"
          type="search"
          value={query}
          aria-label="搜索模型（id 或显示名）"
          placeholder="搜索模型 id 或显示名"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="models-checkbox">
          <input
            type="checkbox"
            aria-label="全选可见结果"
            checked={allVisibleSelected}
            onChange={(e) => setSelected(e.target.checked ? selectAllVisible(selected, visible) : deselectAll())}
          />
          全选可见
        </label>
        <button type="button" className="models-btn" onClick={() => setSelected(deselectAll())}>
          取消全选
        </button>
      </div>
      <ul className="models-discover-list" role="list">
        {visible.map((m) => (
          <li key={m.id} className="models-discover-item">
            <label className="models-checkbox">
              <input
                type="checkbox"
                aria-label={`选择模型 ${m.id}`}
                checked={selected.has(m.id)}
                onChange={(e) => setSelected(toggleDiscoverySelection(selected, m.id, e.target.checked))}
              />
              <span className="models-discover-id">{m.id}</span>
              {m.displayName !== m.id && <span className="models-discover-name">{m.displayName}</span>}
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="models-empty-line">无匹配模型</li>}
      </ul>
      <div className="models-discover-actions">
        <span className="models-hint">
          已选 {selected.size} 项，其中 {addCount} 项将新增（已有行保留你调过的值）
        </span>
        <button
          type="button"
          className="models-btn models-btn-primary"
          onClick={() => onApply(mergeDiscoveredModels(existing, models, selected))}
        >
          添加所选
        </button>
        <button type="button" className="models-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
