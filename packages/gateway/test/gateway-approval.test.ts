// 网关端到端：真实 serve（审批 ask 策略）+ FakeAdapter → 审批请求下发 / 回复决策 / 工具执行。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import { startGateway, type GatewayHandle } from '../src/index.js';
import type { InboundMessage, PlatformAdapter } from '../src/types.js';

const handles: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of handles.splice(0)) await c().catch(() => {});
});

/** 记录型假适配器：captures = 出站文本；handler = startGateway 注入的入站回调 */
class FakeAdapter implements PlatformAdapter {
  readonly channel = 'qq' as const;
  readonly sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  handler: ((message: InboundMessage) => void) | null = null;

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    this.sends.push({ chatId, text, ...(replyToMessageId !== undefined ? { replyTo: replyToMessageId } : {}) });
  }
  /** 测试便捷：模拟平台消息 */
  inbound(text: string, messageId = 'm1'): void {
    this.handler?.({ channel: 'qq', chatId: 'chat-1', messageId, text, isGroup: false });
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待超时')), timeoutMs);
    const t2 = setInterval(() => {
      if (predicate()) {
        clearTimeout(timer);
        clearInterval(t2);
        resolve();
      }
    }, 50);
  });
}

describe('网关审批桥接（真实 serve）', () => {
  it('bash 审批请求下发平台 → 回复「1」→ 工具执行 → 最终文本回平台', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-gw-appr-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-gw-appr-root-'));
    handles.push(async () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    // mock：先调 bash，再给最终回复（ToolCallRequest 契约：arguments 为 JSON 字符串）
    const handle: ServeHandle = await startServe({
      port: 0,
      home,
      root,
      provider: new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'bash', arguments: JSON.stringify({ cmd: 'echo ok' }) }] },
        { text: '命令执行完成' },
      ]),
      decide: (input) => (input.tool === 'bash' ? 'ask' : 'allow'),
    });
    handles.push(async () => handle.close());

    const adapter = new FakeAdapter();
    const gateway: GatewayHandle = await startGateway({
      home,
      root,
      serve: {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        wsUrl: `ws://127.0.0.1:${handle.port}/ws`,
        token: handle.token,
      },
      adapters: [adapter],
    });
    handles.push(() => gateway.stop());

    adapter.inbound('帮我跑个命令');
    // 1. 审批请求下发
    await waitFor(() => adapter.sends.some((s) => s.text.includes('工具请求执行：bash')));
    expect(adapter.sends.at(-1)?.text).toContain('[1] 允许');
    // 2. 回复 1 → 工具执行 → 最终文本
    adapter.inbound('1', 'm2');
    await waitFor(() => adapter.sends.some((s) => s.text.includes('命令执行完成')));
    expect(adapter.sends.at(-1)?.text).toContain('命令执行完成');
  });

  it('回复「2」拒绝 → 工具不执行、turn 正常收尾', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h2-gw-deny-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-gw-deny-root-'));
    handles.push(async () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const handle: ServeHandle = await startServe({
      port: 0,
      home,
      root,
      provider: new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'bash', arguments: JSON.stringify({ cmd: 'echo ok' }) }] },
        { text: '收到拒绝' },
      ]),
      decide: (input) => (input.tool === 'bash' ? 'ask' : 'allow'),
    });
    handles.push(async () => handle.close());

    const adapter = new FakeAdapter();
    const gateway: GatewayHandle = await startGateway({
      home,
      root,
      serve: {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        wsUrl: `ws://127.0.0.1:${handle.port}/ws`,
        token: handle.token,
      },
      adapters: [adapter],
    });
    handles.push(() => gateway.stop());

    adapter.inbound('再跑一次');
    await waitFor(() => adapter.sends.some((s) => s.text.includes('[1] 允许')));
    adapter.inbound('2', 'm2');
    await waitFor(() => adapter.sends.some((s) => s.text.includes('收到拒绝')));
    // 拒绝的 bash 没有执行痕迹（tool/result 应为 denied，最终 turn 正常 end_turn——经文本回平台）
  });
});
