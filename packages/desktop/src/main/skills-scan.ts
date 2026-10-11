// A08 技能分区数据源（桌面主进程 fs 只读扫描）：
//   - serve 无技能列表 HTTP 端点（技能只注入 system block + skill 工具按需加载），
//     桌面主进程用 core 的 **同一 SkillStore 实现** 两级扫描（与 serve 装配同构：
//     new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(home))），口径单一不重写；
//   - **只读**：只扫描 + 读 frontmatter，不写、不删、不暴露通用 fs；
//   - 不抛错：扫描失败/目录缺失一律转空列表 + 告警（SkillStore 自身语义）；
//   - 红线⑩：扫描结果即真实磁盘状态，不做缓存假装实时，不摆假数据。
import { SkillStore, defaultSkillsRoot, projectSkillsRoot } from './core.js';
import type { SettingsSkillsShape } from '../shared/protocol.js';

/** .agents 兜底目录注入（透传 SkillStoreOptions；缺省 = serve 同款自动推导，生产不传） */
export interface SkillsScanOptions {
  agentsProjectDir?: string;
  agentsGlobalDir?: string;
}

export function readSkillsSummary(home: string, root: string, options: SkillsScanOptions = {}): SettingsSkillsShape {
  // 与 core server/http.ts 的缺省装配逐字同构（两级派生兜底目录由 SkillStore 自动推导；
  // options 仅测试注入用——显式传入不存在的路径即可隔离真实的 ~/.agents/skills）
  const store = new SkillStore(projectSkillsRoot(root), defaultSkillsRoot(home), options);
  const result = store.scan();
  return {
    skills: result.skills.map((s) => ({ name: s.name, description: s.description, file: s.file, source: s.source })),
    warnings: result.warnings,
    roots: { project: projectSkillsRoot(root), global: defaultSkillsRoot(home) },
  };
}
