// cron run 审批对齐测试（审查 P1-1）：ask（default 模式）下手工执行含 unsafe 工具的任务，
// 对应工具必须按拒绝收尾（不真正执行 bash），与 serve 调度路径同语义。
// CLI 子进程 + 本地 OpenAI SSE stub（mock provider 脚本：先调 bash，再收尾文本），零 API key。
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  servers.splice(0).forEach((s) => s.close());
});

const servers: Server[] = [];

// OpenAI-compatible SSE 帧（与 chat-cancel.test.ts 同口径）
const TOOL_CALL_FRAMES = (id: string, name: string, argsJson: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":"${argsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}}]}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
];
const TEXT_FRAMES = (text: string): string[] => [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  `data: {"choices":[{"delta":{"content":"${text}"}}]}`,
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
];

function startStubServer(scripts: string[][]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = scripts.shift() ?? TEXT_FRAMES('脚本耗尽');
      for (const f of frames) res.write(f + '\n\n');
      res.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

describe('cron run 审批对齐（审查 P1-1）', () => {
  it('ask（default 模式）下 cron run 执行含 bash 的任务：bash 按拒绝收尾，不真正执行', async () => {
    // mock provider 脚本：第一轮调 bash，第二轮纯文本收尾（turn 以 end_turn 结束）
    const baseUrl = await startStubServer([
      TOOL_CALL_FRAMES('call-p11', 'bash', JSON.stringify({ command: 'echo p11-should-not-run' })),
      TEXT_FRAMES('done'),
    ]);
    const home = tmpDir('h2-cronrun-home-');
    const root = tmpDir('h2-cronrun-root-');

    // 项目配置：provider → 本地 stub；approval default（未列工具 safe=allow / unsafe=ask）
    mkdirSync(join(root, '.harness2'), { recursive: true });
    writeFileSync(
      join(root, '.harness2', 'config.json'),
      JSON.stringify({
        providers: { stub: { protocol: 'openai', baseUrl, envKey: 'H2_CRON_RUN_TEST_KEY' } },
        roles: { main: { channel: 'stub', model: 'stub-model' } },
        approval: { mode: 'default' },
      }),
      'utf8',
    );

    // cron 任务（jobs.json 直写，绕过 add() 的 1 分钟下限）
    const cronRoot = join(home, '.harness2', 'cron');
    mkdirSync(cronRoot, { recursive: true });
    writeFileSync(
      join(cronRoot, 'jobs.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'cron-p11',
            instruction: '跑一次 bash',
            schedule: '1m',
            nextRun: new Date(Date.now() - 60_000).toISOString(),
            enabled: true,
            failCount: 0,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      'utf8',
    );

    const proc = spawn(
      'node',
      [cliEntry, 'cron', 'run', 'cron-p11', '--home', home, '--root', root],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, H2_CRON_RUN_TEST_KEY: 'test-key' } },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => proc.on('close', resolve));

    expect(code).toBe(0);
    expect(stdout).toContain('执行完成'); // bash 被拒后 turn 仍以 end_turn 收尾

    // 历史 session.v1.jsonl：bash 的 tool/result 必须是 ok:false + 审批拒绝
    const historyDir = join(cronRoot, 'history', 'cron-p11');
    const runDir = readdirSync(historyDir)[0]!;
    const events = readFileSync(join(historyDir, runDir, 'session.v1.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const bashResult = events.find((e) => e.type === 'tool/result' && e.payload['tool'] === 'bash');
    expect(bashResult).toBeDefined();
    expect(bashResult!.payload['ok']).toBe(false);
    expect(String(bashResult!.payload['error'])).toContain('denied by approval policy');
    expect(stderr).not.toContain('p11-should-not-run'); // 双保险：命令字符串未被执行输出
  }, 30_000);
});
