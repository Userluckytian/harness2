// 15 条命令的元数据目录（纯数据，不 import 任何实现；帮助文本与 describeCapabilities
// 都从这里读，保证「一份元数据多处消费」）。
// summary/声明顺序从 cli command-registry.ts 逐字搬平（声明顺序 = 帮助展示顺序）。
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
  { id: 'new', group: '会话', summary: '新建会话' },
  { id: 'sessions', group: '会话', summary: '列出当前目录的会话（可选关键字全文搜索）', argsSpec: '[关键字]' },
  { id: 'resume', group: '会话', summary: '恢复指定会话（/resume <id>）', argsSpec: '<id>' },
  { id: 'fork', group: '会话', summary: '从当前会话分叉新会话（/fork [seq]）', argsSpec: '[seq]' },
  {
    id: 'undo',
    group: '历史',
    summary: '撤销最近 n 个用户 turn（/undo [n] [--dry-run]）',
    argsSpec: '[n] [--dry-run]',
  },
  { id: 'redo', group: '历史', summary: '重做最近一次撤销（可连续逐层恢复）' },
  { id: 'help', group: '通用', summary: '显示本帮助', aliases: ['?'] },
  { id: 'exit', group: '通用', summary: '退出（等价：Ctrl+C 两次，或空行按 Ctrl+D）', aliases: ['quit'] },
  {
    id: 'mode',
    group: '模式',
    summary: '切换审批模式（/mode [normal|allow-approve|auto|plan]）',
    argsSpec: '[normal|allow-approve|auto|plan]',
    shellOnly: true,
  },
  { id: 'context', group: '上下文', summary: '查看当前上下文占用（状态栏常驻显示）' },
  { id: 'compact', group: '上下文', summary: '手动触发上下文压缩（/compact [说明文字]）', argsSpec: '[说明文字]' },
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
  { id: 'tasks', group: '调度', summary: '列出 cron 任务（只读）' },
];
