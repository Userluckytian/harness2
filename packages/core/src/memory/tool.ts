// memory 工具（阶段 6）：模型读写长期记忆的唯一入口（unsafe，串行执行）。
// 单操作 {operation,target,text,oldText} 或 operations 批量（原子执行，全成或全不成）。
// 预算语义面向模型声明：接近上限时用"删旧加新"整合（批量原子），而不是反复失败。
import type { ToolDefinition, ToolOutput } from '../tools/types.js';
import {
  MEMORY_BUDGET_CHARS,
  USER_BUDGET_CHARS,
  memoryFileName,
  type MemoryApplyResult,
  type MemoryOp,
} from './store.js';

/**
 * 记忆写入目的地缝：MemoryStore = 直接落盘（auto / 主对话）；
 * ask 模式的复盘/主对话写入由 PendingMemorySink 等实现暂存语义（apply 结果带 stagedId）。
 */
export interface MemorySink {
  apply(ops: readonly MemoryOp[]): Promise<MemoryApplyResult & { stagedId?: string }>;
}

const OPERATION_SCHEMA = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['add', 'replace', 'remove'],
      description: 'add = append new entry; replace = oldText -> text; remove = delete oldText',
    },
    target: {
      type: 'string',
      enum: ['memory', 'user'],
      description: 'memory = your own working notes (MEMORY.md); user = durable facts about the user (USER.md)',
    },
    text: {
      type: 'string',
      description: 'add/replace: the new entry text (must not contain a line that is exactly "§")',
    },
    oldText: { type: 'string', description: 'replace/remove: the full text of the existing entry to match' },
  },
  required: ['operation', 'target'],
} as const;

export function createMemoryTool(sink: MemorySink): ToolDefinition {
  return {
    name: 'memory',
    description:
      `Persist long-term memories across sessions in two files: target='memory' (${memoryFileName('memory')}, ` +
      `your own notes about the project/task, budget ${MEMORY_BUDGET_CHARS} chars) and target='user' ` +
      `(${memoryFileName('user')}, durable facts and preferences about the user, budget ${USER_BUDGET_CHARS} chars). ` +
      'Entries are separated by a line "§" — never include such a line inside an entry. ' +
      'Operations: add (append), replace (oldText -> text), remove (oldText). ' +
      'Use "operations" for an atomic batch (all-or-nothing): when near the budget, consolidate by removing an ' +
      'outdated entry and adding a refined one in the SAME batch ("删旧加新") — the budget is checked once against ' +
      'the final state. Writes are rejected if the final state exceeds the budget; the result reports remaining space. ' +
      'Keep entries short, factual and durable; never store secrets or transient conversation details.',
    parameters: {
      type: 'object',
      properties: {
        operation: OPERATION_SCHEMA.properties.operation,
        target: OPERATION_SCHEMA.properties.target,
        text: OPERATION_SCHEMA.properties.text,
        oldText: OPERATION_SCHEMA.properties.oldText,
        operations: {
          type: 'array',
          description:
            'Atomic batch of operations (alternative to the single-operation fields); all succeed or none apply',
          items: { ...OPERATION_SCHEMA, required: OPERATION_SCHEMA.required },
        },
      },
    },
    // unsafe（默认）：不声明 concurrencySafe——记忆文件读-改-写必须串行
    execute: async (rawArgs): Promise<ToolOutput> => {
      let ops: MemoryOp[];
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (Array.isArray(args['operations'])) {
        ops = args['operations'] as MemoryOp[];
      } else if (args['operation'] !== undefined) {
        ops = [args as unknown as MemoryOp];
      } else {
        return { error: 'memory: 需要 operation（单操作）或 operations（批量数组）' };
      }
      let result: MemoryApplyResult & { stagedId?: string };
      try {
        result = await sink.apply(ops);
      } catch (e) {
        return { error: `memory: ${(e as Error)?.message ?? String(e)}` };
      }
      if (!result.ok) return { error: `memory: ${result.error ?? 'unknown error'}` };
      const lines: string[] = [];
      if (result.stagedId !== undefined) {
        lines.push(`staged as ${result.stagedId} (等待人工审批后落盘)`);
      }
      for (const f of result.files) {
        lines.push(
          `${memoryFileName(f.target)}: ${f.entries} entries, ${f.usedChars}/${f.budget} chars (${f.remainingChars} remaining)`,
        );
      }
      if (lines.length === 0) lines.push('no changes (state already matched)');
      lines.push(...result.warnings);
      return { output: `ok: ${lines.join('; ')}` };
    },
  };
}
