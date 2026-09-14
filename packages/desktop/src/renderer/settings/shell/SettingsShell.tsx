// 设置壳（D-6x `ui-settings-general` 对应物：壳容器 + 分区导航 + 内容槽）。
//
// 职责边界：
//   壳 —— 居中覆层、分区导航、内容槽、激活分区状态（**只内存**，D-14：重挂载即回默认分区）；
//   分区内容 —— 由宿主传入的 `sections` 决定（本文件不 import 任何 IPC/能力模块）。
// 只有激活分区会被渲染（按需挂载）→ 未激活分区不产生副作用，也不会渲染「占位的假控件」。
import { useCallback, useState } from 'react';
import { sortSections, type SettingsSectionDefinition } from './section-model.js';

/** 壳契约错误（分区 id 重复 = 两套并存守门） */
export class SettingsShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsShellError';
  }
}

export interface SettingsShellProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 分区声明（宿主装配；壳只负责排序、导航与内容槽） */
  readonly sections: readonly SettingsSectionDefinition[];
  /** 弹窗标题（缺省「设置」） */
  readonly title?: string;
  /** 初始分区 id（缺省取排序后第一个） */
  readonly defaultSectionId?: string;
}

/** 折叠宿主给的分区（拒重复 id）+ 追加已注册的能力模块贡献（同 id 覆盖内建 = 接管） */
export function resolveSections(sections: readonly SettingsSectionDefinition[]): readonly SettingsSectionDefinition[] {
  const byId = new Map<string, SettingsSectionDefinition>();
  for (const s of sections) {
    if (byId.has(s.id)) throw new SettingsShellError(`分区 id 重复: ${s.id}`);
    byId.set(s.id, s);
  }
  return sortSections([...byId.values()]);
}

/** 设置壳容器（分区导航 + 内容槽） */
export function SettingsShell({
  open,
  onClose,
  sections,
  title = '设置',
  defaultSectionId,
}: SettingsShellProps): React.ReactNode {
  const resolved = resolveSections(sections);
  const fallbackId = resolved[0]?.id ?? '';
  const initialId = defaultSectionId ?? fallbackId;
  const [activeState, setActive] = useState(initialId);
  // 宿主分区表变化后，旧激活 id 可能已不存在 → 回落到第一个分区（不渲染空内容槽）
  const active = resolved.some((s) => s.id === activeState) ? activeState : fallbackId;
  const current = resolved.find((s) => s.id === active);
  const select = useCallback((id: string) => setActive(id), []);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav" data-section-count={resolved.length}>
          <div className="settings-nav-title">{title}</div>
          {resolved.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${active === s.id ? ' on' : ''}`}
              data-section-nav={s.id}
              data-section-owner={s.owner}
              aria-current={active === s.id ? 'page' : undefined}
              onClick={() => select(s.id)}
            >
              <span className="nav-cn">{s.label}</span>
              <span className="nav-en">{s.en}</span>
            </button>
          ))}
        </div>
        <div className="settings-content">
          <div className="settings-content-head">
            <span className="settings-head-title">{current?.label ?? title}</span>
            <button type="button" className="btn-close" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
          {/* 内容槽：只渲染当前分区的正文（按需挂载） */}
          <div className="settings-body" data-section={current?.id} data-section-owner={current?.owner}>
            {current?.render()}
          </div>
        </div>
      </div>
    </div>
  );
}
