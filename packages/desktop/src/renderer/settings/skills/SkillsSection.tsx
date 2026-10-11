// 技能分区（A08，Z-89 的 `skill`）：扫描到的 skills 只读列表 + SKILL.md 路径 + 说明。
// 数据通道：serve 无技能列表端点 → 主进程 fs 两级扫描（settings:getSkills），与 core
// serve 用**同一 SkillStore 实现**（项目级 <root>/.harness2/skills → 全局级
// <home>/.harness2/skills，含 .agents 兜底目录），口径单一不重写（登记见分区注记）。
// 不做技能编辑：authoring 审批流在 core 面（skill_author），GUI 编辑登记后续。
import { useCallback, useEffect, useState } from 'react';
import type { SettingsSkillsShape } from '../../../shared/protocol.js';
import { SettingsSectionBlock } from '../shell/index.js';

const SOURCE_LABEL: Record<SettingsSkillsShape['skills'][number]['source'], string> = {
  project: '项目级',
  global: '全局级',
};

export function SkillsSection(): React.ReactNode {
  const [data, setData] = useState<SettingsSkillsShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((): void => {
    setError(null);
    void window.harness2
      .settingsGetSkills()
      .then((r) => setData(r))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (error !== null) {
    return (
      <SettingsSectionBlock title="技能" desc="两级扫描的项目/全局技能（只读）">
        <p className="settings-warn">技能列表读取失败：{error}</p>
      </SettingsSectionBlock>
    );
  }
  if (data === null) {
    return (
      <SettingsSectionBlock title="技能" desc="两级扫描的项目/全局技能（只读）">
        <div className="settings-desc">加载中…</div>
      </SettingsSectionBlock>
    );
  }
  return (
    <>
      <SettingsSectionBlock title="技能" desc="markdown + frontmatter（name/description），按需经 skill 工具加载">
        <div className="settings-table" data-skills-list>
          {data.skills.length === 0 && <div className="settings-desc">未扫描到技能</div>}
          {data.skills.map((s) => (
            <div key={s.file} className="settings-table-row" data-skill-row={s.name}>
              <span className="row-key">{s.name}</span>
              <span className="row-val">{s.description}</span>
              <span className="row-val">{SOURCE_LABEL[s.source]}</span>
              <span className="row-val mono" title={s.file}>
                {s.file}
              </span>
            </div>
          ))}
        </div>
        {data.warnings.length > 0 && (
          <div className="settings-warn">
            {data.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}
        <p className="settings-note">
          扫描目录（两级）：项目级 {data.roots.project} · 全局级 {data.roots.global}
          （.harness2/skills 优先，.agents/skills 兜底；同名项目级覆盖全局级；上限 50）。
        </p>
      </SettingsSectionBlock>
      <SettingsSectionBlock title="技能管理" desc="新增/修改经文件系统（只读展示，无 GUI 编辑）">
        <p className="settings-note">
          技能即 markdown 文件：在上述目录放 name/description frontmatter 的 .md（或 &lt;name&gt;/SKILL.md）即可被扫描；
          经验造技能（skill_author 审批流）在会话内使用，GUI 编辑见后续版本。
        </p>
      </SettingsSectionBlock>
    </>
  );
}
