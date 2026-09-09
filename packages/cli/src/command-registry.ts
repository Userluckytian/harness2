// command-registry：两路径共享的命令注册表（名字+一句话描述）。
// 来源：legacy commands.ts 的实现命令 + T6/T7 新增（/mode /context /compact /reasoning /tasks）。
// ink Composer 的候选下拉与 legacy readline 的 completer 都从这里读，禁止各维护一份。
export interface CommandMeta {
  name: string;
  description: string;
}

/** 全部命令注册表（按名字排序输出；REGISTRY 保留声明顺序，展示时用 COMMAND_ORDER） */
export const COMMAND_REGISTRY: readonly CommandMeta[] = [
  { name: 'new', description: '新建会话' },
  { name: 'sessions', description: '列出当前目录的会话（可选关键字全文搜索）' },
  { name: 'resume', description: '恢复指定会话（/resume <id>）' },
  { name: 'fork', description: '从当前会话分叉新会话（/fork [seq]）' },
  { name: 'undo', description: '撤销最近 n 个用户 turn（/undo [n] [--dry-run]）' },
  { name: 'redo', description: '重做最近一次撤销（可连续逐层恢复）' },
  { name: 'help', description: '显示本帮助' },
  { name: 'exit', description: '退出（等价：Ctrl+C 两次，或空行按 Ctrl+D）' },
  { name: 'mode', description: '切换审批模式（/mode [normal|allow-approve|auto|plan]）' },
  { name: 'context', description: '查看当前上下文占用（状态栏常驻显示）' },
  { name: 'compact', description: '手动触发上下文压缩（/compact [说明文字]）' },
  { name: 'reasoning', description: '查看/切换推理过程展示（on|off，默认 off）' },
  { name: 'tasks', description: '列出 cron 任务（只读）' },
];

/** 排序后的展示顺序（/mode 等新命令按注册表顺序） */
export const COMMAND_ORDER: readonly string[] = COMMAND_REGISTRY.map((c) => c.name);

/** 带 / 前缀的命令展示名（候选这些渲染） */
export function commandNameWithSlash(name: string): string {
  return `/${name}`;
}

/** 模糊匹配候选：输入命令名（无 / 前缀）→ 匹配前缀的完整命令名列表 */
export function matchCommands(inputName: string): string[] {
  const prefix = inputName.replace(/^\/+/, '').toLowerCase();
  if (prefix.length === 0) return COMMAND_ORDER.map(commandNameWithSlash);
  return COMMAND_ORDER.filter((name) => name.startsWith(prefix)).map(commandNameWithSlash);
}

/** 单条描述（legacy 帮助用；无则 '（无描述）'） */
export function describeCommand(name: string): string {
  const meta = COMMAND_REGISTRY.find((c) => c.name === name);
  return meta !== undefined ? meta.description : '（无描述）';
}
