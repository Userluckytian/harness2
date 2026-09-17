// P11-T4 **写入缝真装配**集成断言（P1-4）。
//
// 背景：本阶段在 `packages/cli/src/chat-setup.ts` 的 turnWriter.append 上加了观察缝，把落盘事件
// `assistant/message.payload.usage` 转成 `usage` 流事件（core 冻结零改动、不落第二份日志）。
// 既有 `p11-usage-tools-busy.test.ts` 的「chat-setup 口径」用例用的是**桩 runtime**——
// 直接 `onStream({ type: 'usage' })`，**完全绕过真实写入缝**，本阶段语义风险最高处无回归保护。
//
// 本文件走**真实 `setupChatSession` + mock provider**（`MockReply.usage`，见 core
// `provider/mock.ts`；不改 core），断言：
//   ① `onStream` 收到 `usage` 事件（真实转发，不是测试自己造的）；
//   ② 会话日志**无重复写入**：`assistant/message` 只有应有条数、`usage` 只出现一次
//      （既没有多余的独立 usage 记录，也没有第二条携带 usage 的落盘事件）。
//
// 变异验证（贴红/绿输出见提交说明）：
//   ① 把 chat-setup 的 usage 转发整块注释掉 → 用例变红（收不到 usage 事件）；
//   ② 在转发处补一次 `session.writer.append('assistant/message', payload)` 重复写入 → 用例变红
//      （assistant/message 条数变 2、`"usage"` 出现 2 次）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSession, SESSION_LOG_FILE } from '@harness2/core';
import { setupChatSession, type StreamEvent } from '../../../src/chat-setup.js';

const USAGE = { inputTokens: 15000, outputTokens: 700 };

describe('P11-T4 写入缝真装配（setupChatSession + mock provider）', () => {
  it('usage 经写入口转发为流事件，且会话日志不重复写入', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-p11-seam-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-p11-seam-root-'));
    const runtime = await setupChatSession(
      { provider: 'mock', home, root, mockScript: [{ text: '真实装配回答', usage: USAGE }] },
      { line: () => undefined, askApproval: async () => 'n' },
    );
    try {
      const events: StreamEvent[] = [];
      const result = await runtime.runUserTurn('hi', (e) => events.push(e));
      expect(result.stopReason).toBe('end_turn');
      // 真实链路跑通（非桩）：正文与工具事件都来自 core loop
      expect(events.some((e) => e.type === 'text-delta')).toBe(true);

      // —— ① onStream 收到 usage ——
      const usageEvents = events.filter((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.usage).toEqual(USAGE);
      expect(usageEvents[0]?.turnId).toBe(result.turnId); // 归属本回合（不猜 turnId）
      expect(events[events.length - 1]?.type).toBe('usage'); // usage 在 done 之前到达（step 末落盘）

      // —— ② 会话日志无重复写入 ——
      const current = runtime.getCurrent();
      if (current === null) throw new Error('装配后应有活动会话');
      const dir = current.dir;
      const loaded = loadSession(dir);
      expect(loaded.warnings).toEqual([]);
      const types = loaded.events.map(({ event }) => event.type);
      // 单步纯文本回复 → 恰 1 条 assistant/message（观察缝只读，不得再 append 一份）
      expect(types.filter((t) => t === 'assistant/message')).toHaveLength(1);
      // 事件类型表里没有独立的 usage 记录（core 契约不含该类型 → 转发不得落盘）
      expect(types).not.toContain('usage');
      // 携带 usage 的落盘事件恰 1 条（不出现第二份）
      const carriers = loaded.events.filter(({ event }) => JSON.stringify(event.payload).includes('"usage"'));
      expect(carriers).toHaveLength(1);
      // 字节级证据：原始 JSONL 里 `"usage"` 恰出现 1 次
      const raw = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8');
      expect(raw.match(/"usage"/g) ?? []).toHaveLength(1);
    } finally {
      try {
        await runtime.finish({});
      } catch {
        // 清理忽略（测试收尾）
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
