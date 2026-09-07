// 只读上下文占用（T6 唯一新增 core 导出）：
//   getContextUsage(dir) —— 估算当前活动上下文 token / contextWindow，返回 0..1。
// 数据源与压缩触发完全一致：loadSession → buildChatMessages（已应用压缩替换）
// → estimateContextTokens。CLI StatusBar、legacy /context、桌面 B4 水条三处
// 共用本函数（禁止三套算法）。目录约定与 loop.ts runTurn 的 session 参数一致
// （调用方用 SessionManager.locate(id) 或 writer.dir 传入），contextWindow 缺省
// 与压缩兜底一致（DEFAULT_CONTEXT_WINDOW），有容量声明时由调用方经 opts 传入。
// 本函数只读、缩容安全：任何异常（日志缺失/格式损坏）返回 0，不抛错。
import { loadSession } from '../session/reader.js';
import { buildChatMessages } from './loop.js';
import { estimateContextTokens, DEFAULT_CONTEXT_WINDOW } from './compaction.js';

export interface ContextUsageOptions {
  /** roles.main 模型声明的 contextWindow；缺省 DEFAULT_CONTEXT_WINDOW（与压缩兜底一致） */
  contextWindow?: number;
}

/**
 * 返回上下文占用比例（0..1）。undefined 结果表示该目录不是有效会话（无日志），
 * UI 侧应显示「—」而不是 0%（0% 会误导为「空」）。
 */
export function getContextUsage(dir: string, opts: ContextUsageOptions = {}): number | undefined {
  const window = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (window <= 0) return undefined;
  try {
    const session = loadSession(dir);
    const tokens = estimateContextTokens(buildChatMessages(session));
    return Math.max(0, Math.min(1, tokens / window));
  } catch {
    return undefined; // 目录缺失/日志损坏 → 未知，非 0
  }
}