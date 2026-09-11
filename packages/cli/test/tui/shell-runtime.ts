// T5 测试助手（非 .test，不会被收集）：用 mock provider 建一个真实 ChatRuntime（隔离 --home/--root），
// 供 ink shell 集成测试（命令对齐 / 重投影 / 无残留）复用。无第三方依赖。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockScript } from '@harness2/core';
import { setupChatSession, type ChatRuntime } from '../../src/chat-setup.js';

export interface TestRuntime {
  runtime: ChatRuntime;
  home: string;
  root: string;
  cleanup: () => Promise<void>;
}

/** 单条纯文本回答的 mock 脚本（无工具调用，便于断言转录） */
export const SINGLE_TEXT_SCRIPT: MockScript = [{ textChunks: ['这是回答正文'] }];

export async function createTestRuntime(mockScript: MockScript = SINGLE_TEXT_SCRIPT): Promise<TestRuntime> {
  const home = mkdtempSync(join(tmpdir(), 'h2-t5-home-'));
  const root = mkdtempSync(join(tmpdir(), 'h2-t5-root-'));
  const runtime = await setupChatSession(
    { provider: 'mock', home, root, mockScript },
    {
      line: () => undefined,
      askApproval: async () => 'n',
    },
  );
  return {
    runtime,
    home,
    root,
    cleanup: async () => {
      try {
        await runtime.finish({});
      } catch {
        // 忽略收尾异常（测试清理）
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 轮询等待条件（配合 mountTui 的 flush） */
export async function waitFor(cond: () => boolean, flush: () => Promise<void>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout（条件未满足）');
    await flush();
  }
}
