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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** rmSync 遇 Windows 句柄释放延迟类错误（EBUSY/EPERM/ENOTEMPTY）时按指数退避重试后删除。
 * 依据（P0-CI 加固窗口）：CI windows 实测 afterAll/cleanup 删 h2-t5-root-* 时抛
 * 「EBUSY: resource busy or locked」（子进程/索引器短暂占句柄的清理竞争），本机不复现。
 * 最多 5 次尝试，退避 200ms 起 ×2（200/400/800/1600 → 总等待 ≤3.1s，可控）；其余错误码
 * （如 ENOENT）不重试直接抛；最终仍失败才抛最后一次的错误。异步 sleep 真让出事件循环，
 * 不忙等抢 CPU（占句柄的子进程正需要 CPU 才能退出）。
 * 注：Node rmSync 自带 maxRetries 是线性退避且默认 0，这里按约定显式做指数退避。 */
async function rmSyncWithRetry(path: string, attempts = 5): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(200 * 2 ** (attempt - 1)); // 200/400/800/1600ms
    }
  }
  throw lastErr;
}

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
      await rmSyncWithRetry(home);
      await rmSyncWithRetry(root);
    },
  };
}

/**
 * 轮询等待条件（配合 mountTui 的 flush）。
 * CI 加固（P0-CI 窗口）：2 核 runner 会被几十个 vitest worker 分摊，ink 的渲染 timer
 * （ESC 消歧 20ms / 渲染节流 ~34ms）可能被饿死，固定节奏的紧凑轮询反而加剧抢占。
 * 因此每轮 flush 之间按指数退避让出事件循环（25ms 起 ×2、封顶 200ms），给渲染 timer 让路。
 * 默认超时 8000 → 20000：CI 实测 8s 不够（overlay-position「T3 审批确认框」Esc 关闭
 * waitFor 8153ms 未满足，本机 <100ms 即过）；本包 vitest testTimeout=30s（vitest.config.mts），
 * 20s 给足余量且不触顶。超时上限只是放弃边界，不是性能断言。
 */
export async function waitFor(cond: () => boolean, flush: () => Promise<void>, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let backoffMs = 25;
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout（条件未满足）');
    await flush();
    if (cond()) return;
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 200);
  }
}
