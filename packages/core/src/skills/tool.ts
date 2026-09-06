// skill 工具（阶段 10 Task 2）：模型按需加载 skill 全文的唯一入口（safe，只读）。
// system 里只注入「名称+描述」列表；全文（含 frontmatter）经本工具现读磁盘返回——
// 项目文件中途修改后，下一次调用即取到新内容（与列表每 turn 重扫同语义）。
// 边界：只读文本，无执行语义（Global Constraints：无可执行 skill）。
import type { ToolDefinition, ToolOutput } from '../tools/types.js';
import { type SkillStore } from './store.js';

export const SKILL_TOOL_NAME = 'skill';

export function createSkillTool(store: SkillStore): ToolDefinition {
  return {
    name: SKILL_TOOL_NAME,
    description:
      'Load the full instruction text of an available skill by name (the list of available skills ' +
      "and their descriptions is in the system message under '[Skills 可用]'). " +
      'Returns the markdown file verbatim (frontmatter included). Use this before following a skill ' +
      'whose description matches the current task; do not guess its contents from the description alone.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名称（见 system 的 [Skills 可用] 列表）' },
      },
      required: ['name'],
    },
    // safe：只读加载，可与其它调用并行
    concurrencySafe: true,
    async execute(rawArgs): Promise<ToolOutput> {
      const name = (rawArgs as Record<string, unknown> | null)?.['name'];
      if (typeof name !== 'string' || name.trim() === '') {
        return { error: 'skill: name 必须是非空字符串' };
      }
      const entry = store.load(name);
      if (entry === undefined) {
        return { error: `skill: 未找到 "${name}"（可用列表见 system 的 [Skills 可用] 区块）` };
      }
      return { output: entry.content };
    },
  };
}
