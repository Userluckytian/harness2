// /reasoning 展示开关（两路径共享 reasoning 状态，默认关）进程内集成测试：
// setupChatSession + mock 脚本带 reasoningChunks，验证状态机与推理增量转发口径。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupChatSession, type ChatRuntime, type TurnStreamHandler } from '../src/chat-setup.js';
import type { MockScript } from '@harness2/core';

const rootDir = dirname(fileURLToPath(import.meta.url));

const REASONING_SCRIPT: MockScript = [
  { reasoningChunks: ['先想想', '再动手'], text: '思考完毕，开始干活' },
  { text: '第二轮纯文本' },
];

const HOMES: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-reasoning-'));
  HOMES.push(d);
  return d;
}
afterEach(() => {
  for (const d of HOMES.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function makeRuntime(home: string): Promise<ChatRuntime> {
  return setupChatSession(
    { provider: 'mock', mockScript: REASONING_SCRIPT, home, root: rootDir },
    { line: () => undefined, askApproval: async () => 'n' },
  );
}

/** 收集 onStream 收到的 reasoning-delta 文本 */
function reasoningCollector(): { events: string[]; handler: TurnStreamHandler } {
  const events: string[] = [];
  return {
    events,
    handler: (event) => {
      if (event.type === 'reasoning-delta') events.push(event.text);
    },
  };
}

describe('/reasoning 展示开关（两路径共享状态，默认关）', () => {
  let home: string;
  let runtime: ChatRuntime;

  beforeEach(async () => {
    home = tmpHome();
    runtime = await makeRuntime(home);
  });

  it('默认关闭：runUserTurn 不转发 reasoning-delta；文本照常流式', async () => {
    const c = reasoningCollector();
    const result = await runtime.runUserTurn('开始', c.handler);
    expect(c.events).toEqual([]); // 默认 off：推理增量被过滤
    expect(result.stopReason).toBe('end_turn');
  });

  it('开启后：reasoning-delta 逐片转发（两路径同一 onStream）；关闭后再次过滤', async () => {
    runtime.setReasoning(true);
    const on = reasoningCollector();
    await runtime.runUserTurn('思考一下', on.handler);
    expect(on.events).toEqual(['先想想', '再动手']); // 逐片转发，与 mock 脚本一致

    runtime.setReasoning(false);
    const off = reasoningCollector();
    await runtime.runUserTurn('再来一轮', off.handler);
    expect(off.events).toEqual([]); // 关闭后不再转发
  });

  it('状态查询：setReasoning 返回新值，reasoning() 反映当前开关', async () => {
    expect(runtime.reasoning()).toBe(false);
    expect(runtime.setReasoning(true)).toBe(true);
    expect(runtime.reasoning()).toBe(true);
    expect(runtime.setReasoning(false)).toBe(false);
    expect(runtime.reasoning()).toBe(false);
  });
});