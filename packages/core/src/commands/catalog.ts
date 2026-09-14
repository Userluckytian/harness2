// 命令元数据目录（纯数据，不 import 任何实现；帮助文本与 describeCapabilities
// 都从这里读，保证「一份元数据多处消费」）。
// 本文件是命令名称/summary/别名的唯一源（P1-Dev-2 起 cli command-registry.ts 反向派生，
// 不再有「从 cli 搬平」的父本）；声明顺序 = 帮助展示顺序。
// P3-A（2026-09-13）加性扩容 15→23：G-54~G-90 命令补齐（refs-grok-build）——
//   - 别名补齐：/new + 'clear'（G-54）、/undo + 'rewind'（G-61）；
//   - 新增 8 条 shellOnly 元数据（session-info/export/timeline/doctor/memory/skills/
//     plugins/mcps）：能力已在 core 其它模块（session/export.ts、doctor/、trajectory/
//     view.ts、memory/store.ts、skills/store.ts、plugins/loader.ts、config loadConfig），
//     thin 实现留壳（cli tui/commands/shell-command-impls.ts，palette 接线棒路由）——
//     registry 的 RUNS 表不动，故一律 shellOnly，core 不画饼（runCoreCommand 对
//     shellOnly 如实输出「由界面层实现」，接线棒侧才有真实现）；
//   - 声明顺序按 group 聚簇（会话→历史→通用→模式→上下文→调度）；skills/plugins/mcps
//     归「通用」（CoreCommandGroup 联合类型在 types.ts 冻结，本棒只改 catalog.ts）；
//   - 上游专有且 core 无能力的命令（model/copy/delete/rename/home/loop 等）不注册，
//     盘点表见 P3-A 报告（P7 归存清单）。
import type { CoreCommandGroup } from './types.js';

/** 命令元数据（无执行体——describeCapabilities 的 commands 条目即本形态） */
export interface CoreCommandMeta {
  /** 规范命令 id（不含 /，小写） */
  id: string;
  /** 别名（不含 /；如 help 的 '?'、exit 的 'quit'） */
  aliases?: readonly string[];
  group: CoreCommandGroup;
  /** 一句话描述 */
  summary: string;
  /** 参数格式说明（无参可省略） */
  argsSpec?: string;
  /** true = 实现留壳（mode/reasoning：壳状态/呈现语义，core 只注册元数据） */
  shellOnly?: boolean;
}

export const CORE_COMMAND_META: readonly CoreCommandMeta[] = [
  { id: 'new', group: '会话', summary: '新建会话', aliases: ['clear'] },
  { id: 'sessions', group: '会话', summary: '列出当前目录的会话（可选关键字全文搜索）', argsSpec: '[关键字]' },
  { id: 'resume', group: '会话', summary: '恢复指定会话（/resume <id>）', argsSpec: '<id>' },
  {
    id: 'session-info',
    group: '会话',
    summary: '查看当前会话详情（id/事件与消息统计；别名 /status /info）',
    aliases: ['status', 'info'],
    shellOnly: true,
  },
  { id: 'fork', group: '会话', summary: '从当前会话分叉新会话（/fork [seq]）', argsSpec: '[seq]' },
  {
    id: 'export',
    group: '会话',
    summary: '导出当前会话轨迹为 ZIP（只读打包，含子代理会话）',
    argsSpec: '[输出路径]',
    shellOnly: true,
  },
  // —— P7-B 会话能力（H-11～H-14）加性注册（2026-09-14）：实现已在 core
  //    （session/capabilities.ts 的 runSessionCapability，registry.ts 的 RUNS 表接线），
  //    三壳共用命令面直接可执行——一律非 shellOnly（无「由界面层实现」假入口）。——
  {
    id: 'search',
    group: '会话',
    summary: '索引化全文检索会话（分词命中，默认全部命中）',
    argsSpec: '<查询> [--or] [--limit N]',
  },
  { id: 'reindex', group: '会话', summary: '重建会话检索索引（派生物，可随时重建）' },
  {
    id: 'import',
    group: '会话',
    summary: '导入会话导出包（zip，含子会话；版本迁移与坏行容错）',
    argsSpec: '<zip 路径> [--overwrite] [--dry-run]',
  },
  {
    id: 'title',
    group: '会话',
    summary: '查看/设置/自动生成会话标题（/title [<标题>|--auto]）',
    argsSpec: '[<标题>|--auto]',
  },
  {
    id: 'undo',
    group: '历史',
    summary: '撤销最近 n 个用户 turn（/undo [n] [--dry-run]）',
    argsSpec: '[n] [--dry-run]',
    aliases: ['rewind'],
  },
  { id: 'redo', group: '历史', summary: '重做最近一次撤销（可连续逐层恢复）' },
  { id: 'timeline', group: '历史', summary: '只读输出当前会话轨迹时间线（仅 fullscreen 模式）', shellOnly: true },
  { id: 'help', group: '通用', summary: '显示本帮助', aliases: ['?'] },
  { id: 'exit', group: '通用', summary: '退出（等价：Ctrl+C 两次，或空行按 Ctrl+D）', aliases: ['quit'] },
  {
    id: 'doctor',
    group: '通用',
    summary: '环境自检分节报告（node/config/目录/MCP 配置/会话库/skills）',
    aliases: ['terminal-setup', 'terminal-check', 'terminal-info'],
    shellOnly: true,
  },
  // skills/plugins/mcps 归入「通用」组（CoreCommandGroup 联合类型在 types.ts 冻结，
  // 本棒只许改 catalog.ts——palette 分组按 group 字符串呈现，扩展模态化登记 P7）
  { id: 'skills', group: '通用', summary: '列出可用 skills（两级扫描合并，只读）', shellOnly: true },
  { id: 'plugins', group: '通用', summary: '列出插件目录与装载审批状态（只读）', shellOnly: true },
  { id: 'mcps', group: '通用', summary: '列出配置的 MCP 服务器（只读配置，不探测连接）', shellOnly: true },
  // P7-C H-31 工具面命令（实现 = tools/manage.ts 的 runToolsCommand，RUNS 表接线）
  {
    id: 'tools',
    group: '通用',
    summary: '查看/切换工具面（工具清单、工具集 list/show/select）',
    argsSpec: '<list|show|select> [参数]',
  },
  {
    id: 'mode',
    group: '模式',
    summary: '切换审批模式（/mode [normal|allow-approve|auto|plan]）',
    argsSpec: '[normal|allow-approve|auto|plan]',
    shellOnly: true,
  },
  {
    id: 'reasoning',
    group: '模式',
    summary: '查看/切换推理过程展示（on|off，默认 off）',
    argsSpec: '[on|off]',
    shellOnly: true,
  },
  {
    id: 'minimal',
    group: '模式',
    summary: '切换 minimal 渲染模式（终端原生滚动，不接管屏幕）',
    shellOnly: true,
  },
  {
    id: 'fullscreen',
    group: '模式',
    summary: '切换 fullscreen 渲染模式（接管屏幕；缩写 /full）',
    aliases: ['full'],
    shellOnly: true,
  },
  { id: 'context', group: '上下文', summary: '查看当前上下文占用（状态栏常驻显示）' },
  { id: 'compact', group: '上下文', summary: '手动触发上下文压缩（/compact [说明文字]）', argsSpec: '[说明文字]' },
  {
    id: 'compact-layers',
    group: '上下文',
    summary: '按分层压缩（turn → session）执行一次压缩并展示分层产物',
    argsSpec: '[turn|session]',
  },
  { id: 'memory', group: '上下文', summary: '查看长期记忆条目与用量（MEMORY.md/USER.md，只读）', shellOnly: true },
  { id: 'tasks', group: '调度', summary: '列出 cron 任务（只读）' },
];
