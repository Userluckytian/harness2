// chat 审批等待可取消（审查 P2-2）进程内集成测试：REPL 直跑 runChat + 本地 OpenAI SSE stub。
// SIGINT 经 terminal 模式 readline 的 \x03 注入（piped spawn 无法发信号；Node 22 对
// terminal:true 的接口按按键解析 \x03 → 'SIGINT'）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChat } from '../src/chat.js';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// OpenAI-compatible SSE 帧（每帧由 stub server 以 "\n\n" 分隔写出，与 chat.test.ts 一致）
const TOOL_CALL_FRAMES = (id: string, argsJson: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"read","arguments":"${argsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}}]}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
];
const TEXT_FRAMES = (text: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

/** 轮询等待输出包含目标（超时抛出并附输出尾部） */
async function waitOut(out: () => string, test: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!out().includes(test)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitOut timeout: ${test}\n--- output tail ---\n${out().slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('chat 审批等待可取消（P2-2：ask 与 turn 取消信号竞速）', () => {
  let server: Server;
  let baseUrl = '';
  const scripts: string[][] = [];

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = scripts.shift() ?? TEXT_FRAMES('脚本耗尽');
      for (const f of frames) res.write(f + '\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ask 等待中 Ctrl+C（SIGINT）→ 审批按拒绝处理、turn cancelled；取消后的行不再被当答案吞掉', async () => {
    const home = tmpDir('h2-cancel-home-');
    const work = tmpDir('h2-cancel-work-');
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(
      join(home, '.harness2', 'config.json'),
      JSON.stringify({
        providers: { stub: { protocol: 'openai', baseUrl } },
        roles: { main: { channel: 'stub', model: 'stub-model' } },
        approval: { tools: { read: 'ask' } },
      }),
      'utf8',
    );
    writeFileSync(join(home, '.harness2', 'auth.json'), JSON.stringify({ channels: { stub: { apiKey: 'cancel-test-key-secret' } } }), 'utf8');
    writeFileSync(join(work, 'approved.txt'), 'approved 内容', 'utf8');

    // 第 1 次请求：read 工具调用（触发 ask）；第 2 次请求：取消后新 turn 的纯文本回复
    scripts.push(
      TOOL_CALL_FRAMES('call-1', '{"file_path":"approved.txt"}'),
      TEXT_FRAMES('第二轮读取完成'),
    );

    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true; // 让 chat 走 terminal 模式（SIGINT 可注入）
    let out = '';
    const output = new Writable({ write(c, _enc, cb) { out += c.toString('utf8'); cb(); } });

    const chatDone = runChat({ home, root: work, stdin: input, stdout: output });
    try {
      await waitOut(() => out, '会话: ');
      input.write('读一下 approved.txt\n');
      await waitOut(() => out, '允许执行 read?');
      expect(out.match(/允许执行 read\?/g)).toHaveLength(1);

      input.write('\x03'); // SIGINT：取消审批等待（修复前：ask promise 悬挂，无法取消）
      await waitOut(() => out, '审批等待被取消');
      await waitOut(() => out, '< FAILED [call-1]'); // 工具按拒绝处理（denied）
      await waitOut(() => out, '[cancelled'); // turn 以 cancelled 收尾，不悬挂

      // 取消后的输入行不被当答案吞掉：作为新消息发起第二个 turn
      input.write('再读一次\n');
      await waitOut(() => out, '第二轮读取完成');
      expect(out.indexOf('审批等待被取消')).toBeLessThan(out.indexOf('第二轮读取完成'));
      expect(out.match(/允许执行 read\?/g)).toHaveLength(1); // 第二个 turn 无工具调用，不再提示
    } finally {
      input.write('/exit\n');
      await Promise.race([
        chatDone,
        new Promise((_, reject) => setTimeout(() => reject(new Error('runChat 未退出（ask 等待悬挂？）')), 10000)),
      ]);
    }
  }, 30000);
});

afterAll(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
