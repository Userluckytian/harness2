// 分区正文的分组块（设置壳的内容词汇）：标题 + 可选说明 + 内容。
// 只是既有 `.settings-section` 样式的复用封装（壳的正文由各分区自己组织，本块不做任何数据访问）。
export interface SettingsSectionBlockProps {
  readonly title: string;
  readonly desc?: string;
  readonly children: React.ReactNode;
}

export function SettingsSectionBlock({ title, desc, children }: SettingsSectionBlockProps): React.ReactNode {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {desc !== undefined && <p className="settings-desc">{desc}</p>}
      {children}
    </div>
  );
}
