// A09 Hooks（Z6 批次5）运行时类型面。
// 触发源锚到我们**真实生命周期**（不照抄 ZCode 的 PascalCase 事件表）：配置键
// `hooks.entries[].event` 取五值之一——preTool / postTool / turnEnd / sessionStart /
// sessionEnd（见 config/schema.ts 的 HookEventName）。执行/输出语义对齐 ZCode 调研结论
// （见报告）：stdin 注入 JSON 上下文、exit 2 / JSON continue:false → 拦截、JSON
// additionalContext → 回注、超时/失败 fail-open。
import type { HookEventName } from '../config/schema.js';

/** 单条 hook 一次执行的结局（进 hook/invocation 扩展事件与告警日志） */
export type HookOutcome =
  | 'success' // 正常结束（exit 0；JSON 输出可选）
  | 'blocked' // preTool 拦截（exit 2 或 JSON continue:false / permissionDecision:deny）
  | 'failed' // 非零退出（非 2）
  | 'timeout' // 超时被杀
  | 'spawn_error'; // 无法启动（shell 不存在等）

/** 一次 hook 调用的可落账记录（红线段：以扩展事件落盘，不在内存旁路） */
export interface HookInvocationRecord {
  event: HookEventName;
  command: string;
  /** 声明的 matcher（preTool/postTool；缺省 = 全命中） */
  matcher?: string;
  /** 实际匹配对象（preTool/postTool = 工具名；其余事件无） */
  target?: string;
  outcome: HookOutcome;
  exitCode: number | null;
  durationMs: number;
  /** stdout 预览（已截断 + 脱敏；仅非空时有） */
  stdoutPreview?: string;
  /** stderr 预览（已截断 + 脱敏；仅非空时有） */
  stderrPreview?: string;
  /** blocked 时的人类可读原因 */
  blockReason?: string;
  /** 该 hook 回注到上下文的段数（postTool/其余附加段） */
  contextCount?: number;
}

/** 一次「事件 → 全部命中 hook」聚合结果（loop 据此改道执行/回注，并落扩展事件） */
export interface HookRunResult {
  /** preTool：阻止该工具执行（原因）；仅 preTool 生效 */
  blocked?: { reason: string };
  /** preTool：改写后的工具入参（JSON hookSpecificOutput.updatedInput / updatedInput） */
  updatedInput?: unknown;
  /** postTool 等：回注到工具结果/上下文文本的附加段 */
  additionalContexts: string[];
  /** 本事件每条 hook 的执行记录（按声明顺序；async 型不在此列，见 runner 注记） */
  invocations: HookInvocationRecord[];
}

/** 传给执行器的单次调用上下文（loop/装配层构造） */
export interface HookRunPayload {
  event: HookEventName;
  /** preTool/postTool = 工具名（matcher 的匹配对象） */
  toolName?: string;
  /** 工具入参（preTool 拦截点；JSON 注入 stdin 的 tool_input） */
  args?: unknown;
  /** 工具结果输出（postTool；JSON 注入 stdin 的 tool_response） */
  output?: string;
  /** 工具是否成功（postTool） */
  ok?: boolean;
  /** turn 结束时的停止原因（turnEnd） */
  stopReason?: string;
  /** 会话 id（sessionStart/sessionEnd；可缺省） */
  sessionId?: string;
  /** 会话目录（落 hook/invocation 扩展事件的 writer 由调用方持有，不在本结构） */
  sessionDir?: string;
  /** 本 turn 的 id（turn 内事件） */
  turnId?: string;
  /** 工作目录（hook 子进程 cwd + stdin cwd） */
  cwd: string;
}

/** 命中匹配：matcher 缺省 = 全命中；否则用 A16 matchGlob 匹配工具名（preTool/postTool） */
export interface HookRunner {
  run(payload: HookRunPayload): Promise<HookRunResult>;
}
