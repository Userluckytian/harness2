// 记忆模式策略（P7-A / H-21，对照 hermes agent/prompt_builder.py 的 build_memory_guidance
// 与用户点名的三态 off|ask|auto）：
//   - off  = 模型看不到 memory 工具、零注入、零写入（**安全默认**，尊重隐私）；
//   - ask  = 工具可见、写入进 pending 暂存、人工审批后才落盘（requiresApproval = true）；
//   - auto = 工具可见、直接落盘，且要求模型**主动持久化**（无需提醒、也不必征求许可）。
// 本模块是「模式 → 工具可见性 + 写入语义 + 主动持久化指令」的**唯一策略出口**：三壳装配只调
// createMemoryToolForPolicy，不各自复制 if/else（H-70 两层分层的记忆侧落点；此前 CLI 的
// chat-setup 与 core server 的 sessions-turn 各写一份、容易分叉）。
// H-21 的「无需提醒即自行写入」由两条通道落地：
//   ① auto 的工具描述带主动持久化契约（模型每次请求都看得到，见 tool.ts）；
//   ② MEMORY_PROACTIVE_GUIDANCE 文本供装配层注入 system（需要提示词级引导时使用）。
// 语义冻结项（不得因本模块改动）：memory/snapshot 仍是 ChatRequest.system 里记忆内容的唯一来源。
import type { MemoryMode } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import type { MemoryOp, MemoryStore } from './store.js';
import type { PendingMemoryStore } from './pending.js';
import { createMemoryTool, type MemorySink } from './tool.js';

/**
 * 默认记忆模式 = off（安全默认：宁可零注入，也不默认把用户私有数据写进磁盘/提示词）。
 * 与 config 的 DEFAULT_MEMORY_CONFIG.mode 必须一致（有交叉断言用例）。
 */
export const MEMORY_MODE_DEFAULT: MemoryMode = 'off';

/**
 * 主动持久化指令（auto 模式）：对照 hermes build_memory_guidance 的正向姿态 +
 * 声明式事实/「接近上限删旧加新」/绝不记密钥三条纪律。仅在 auto 下注入。
 */
export const MEMORY_PROACTIVE_GUIDANCE =
  '你拥有跨会话的长期记忆，每个新会话开始时自动加载（memory 工具的 schema 定义了记什么）。' +
  '发现值得长期记住的事实时，**无需用户提醒、也不必征求许可**，直接调用 memory 工具写入：' +
  'target=user 记用户画像（身份、稳定偏好、纠正），target=memory 记你自己的项目笔记与约定。' +
  '条目写成陈述性事实（"用户偏好中文回复" ✓），不要写成对自己的命令（"总是用中文回复" ✗）——' +
  '后者在后续会话里会被重新读成硬指令，覆盖用户当下的要求。' +
  '接近字符上限时用 operations 批量"删旧加新"整合，而不是放弃本次记录。' +
  '只记跨会话仍然成立的事实；一次性任务细节留在会话历史里。绝不记录密钥、令牌等敏感值。';

/**
 * 主动持久化指令（ask 模式）：照常主动提交写入，但向用户说明「已提交待审批」——
 * 审批只改变落盘时机，不改变「该记就记、不等提醒」的行为要求。
 */
export const MEMORY_APPROVAL_GUIDANCE =
  '你拥有长期记忆（MEMORY.md 项目笔记 / USER.md 用户画像），但当前是 ask 模式：memory 工具的写入' +
  '只进入待审批暂存区，由用户批准后才落盘。发现值得长期记住的事实仍然要**主动提交**（不要因为要审批' +
  '就放弃记录），并在回复里简要说明已提交待审批的内容。绝不提交密钥、令牌等敏感值。';

/** 模式 → 写入语义 */
export type MemoryWriteBehavior = 'direct' | 'pending' | 'none';

export interface MemoryPolicy {
  /** 生效模式（未知值已归一为 off） */
  mode: MemoryMode;
  /** 是否把 memory 工具注册给模型（off = 不可见） */
  toolVisible: boolean;
  /** 写入落点语义：direct = 直接落盘；pending = 暂存待审批；none = 无写入 */
  write: MemoryWriteBehavior;
  /** 模型是否应主动持久化（无需提醒、不征求许可） */
  proactive: boolean;
  /** 写入是否需人工审批后才落盘 */
  requiresApproval: boolean;
  /** 供装配层注入 system 的主动持久化指令（off → null） */
  guidance: string | null;
}

/**
 * 解析模式策略。未知模式字符串按 off 处理（fail-safe：策略表读不出就当作关闭，
 * 绝不因装配层笔误而把记忆悄悄打开）。
 */
export function resolveMemoryPolicy(mode: MemoryMode): MemoryPolicy {
  if (mode === 'auto') {
    return {
      mode: 'auto',
      toolVisible: true,
      write: 'direct',
      proactive: true,
      requiresApproval: false,
      guidance: MEMORY_PROACTIVE_GUIDANCE,
    };
  }
  if (mode === 'ask') {
    return {
      mode: 'ask',
      toolVisible: true,
      write: 'pending',
      proactive: true,
      requiresApproval: true,
      guidance: MEMORY_APPROVAL_GUIDANCE,
    };
  }
  return { mode: 'off', toolVisible: false, write: 'none', proactive: false, requiresApproval: false, guidance: null };
}

/**
 * pending 暂存 sink（ask 模式）：写记忆只进暂存区、绝不落盘；
 * 与 MemoryStore 同语义的 MemorySink 接口，工具层对模型无感（结果里带 stagedId）。
 */
export function createPendingMemorySink(pending: PendingMemoryStore, sessionId: string): MemorySink {
  return {
    apply: async (ops: readonly MemoryOp[]) => {
      const staged = await pending.stage(sessionId, ops);
      return { ok: true, warnings: [], files: [], stagedId: staged.id };
    },
  };
}

export interface MemoryToolPolicyOptions {
  /** ask 模式的暂存区（requiresApproval 时必填） */
  pending?: PendingMemoryStore;
  /** 暂存归因的来源会话 id（ask 必填） */
  sessionId?: string;
}

/**
 * 按模式装配 memory 工具：**三壳唯一入口**。
 * off → undefined（调用方不注册 = 工具对模型不可见）；ask → 暂存 sink；auto → 直写 store。
 * ask 缺 pending/sessionId 时 fail-fast 抛错（装配错误必须立刻暴露，不能静默降级成直写）。
 */
export function createMemoryToolForPolicy(
  store: MemoryStore,
  mode: MemoryMode,
  options: MemoryToolPolicyOptions = {},
): ToolDefinition | undefined {
  const policy = resolveMemoryPolicy(mode);
  if (!policy.toolVisible) return undefined;
  if (policy.requiresApproval) {
    const { pending, sessionId } = options;
    if (pending === undefined) throw new Error('memory: ask 模式需要 pending store（装配缺失）');
    if (sessionId === undefined) throw new Error('memory: ask 模式需要 sessionId（暂存归因）');
    return createMemoryTool(createPendingMemorySink(pending, sessionId), { proactive: policy.proactive });
  }
  return createMemoryTool(store, { proactive: policy.proactive });
}
