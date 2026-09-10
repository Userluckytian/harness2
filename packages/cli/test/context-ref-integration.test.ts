// @file/@dir 引用集成测试（spawn 真实 CLI + OpenAI SSE stub）：
// legacy 路径发送前把引用块拼进 user message，stub 收到请求体并断言 header 进入模型输入。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SSE_HEADERS = { 'Content-Type': 'text/event-stream' };

describe('@file/@dir 引用（legacy 发送链路集成验证）', () => {
  let server: Server;
  let baseUrl = '';
  let receivedBodies: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
      });
      req.on('end', () => {
        receivedBodies.push(body);
        res.writeHead(200, SSE_HEADERS);
        const frames = [
          'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
          'data: {"choices":[{"delta":{"content":"收到你关于这个项目的问题"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ];
        for (const f of frames) res.write(f + '\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('发送给模型的 user content 含引用块 + 原始输入（不回显丢失）', async () => {
    const home = tmpDir('h2-refcli-home-');
    const work = tmpDir('h2-refcli-work-');
    mkdirSync(join(home, '.harness2'), { recursive: true });
    writeFileSync(join(work, 'README.md'), '这是项目 README 内容', 'utf8');
    writeFileSync(
      join(home, '.harness2', 'config.json'),
      JSON.stringify({
        providers: { stub: { protocol: 'openai', baseUrl } },
        roles: { main: { channel: 'stub', model: 'stub-model' } },
      }),
      'utf8',
    );
    writeFileSync(
      join(home, '.harness2', 'auth.json'),
      JSON.stringify({ channels: { stub: { apiKey: 'ref-test-key-secret' } } }),
      'utf8',
    );

    const proc = spawn('node', [cliEntry, 'chat', '--home', home, '--root', work], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr!.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (stdout.includes('会话: ') || stdout.includes('>')) {
          clearInterval(timer);
          resolve();
        }
      }, 40);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });

    proc.stdin!.write('@README.md 这是什么项目？\n');
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (stdout.includes('收到你关于这个项目的问题')) {
          clearInterval(timer);
          resolve();
        }
        if (stderr.includes('Error') || stderr.includes('error')) {
          clearInterval(timer);
          resolve();
        }
      }, 40);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 10000);
    });

    proc.stdin!.write('/exit\n');
    proc.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if ((proc.exitCode ?? proc.signalCode) !== null) {
          clearInterval(timer);
          resolve();
        }
      }, 40);
      setTimeout(() => clearInterval(timer), 5000);
    });

    expect(receivedBodies.length).toBe(1);
    const body = receivedBodies[0];
    // 模型输入最前是引用块，内容含 README 真实文本；原文保留
    expect(body).toContain('[@README.md →');
    expect(body).toContain('这是项目 README 内容');
    expect(body).toContain('这是什么项目？');
  }, 30000);
});
