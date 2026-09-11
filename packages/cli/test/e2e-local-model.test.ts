// T5 验收 10：真实本地模型端到端往返（非 fixture）。
//
// 环境闸门：仅当 H2_E2E_LOCAL=1 时启用（CI/无本地服务时 describe.skip，不是 --passWithNoTests）。
// 端点：baseUrl http://127.0.0.1:40080/v1、协议 openai（请求打到 {baseUrl}/chat/completions，
// 故 baseUrl 必须含 /v1）、模型 big-pickle。
// 隔离：--home <tmp>，config.json / auth.json 只写该临时目录；key 一律取自 env LOCAL_UNIFIED_KEY，
// **不设源码兜底字面量**（审查 P2）：闸门开启但未提供 key 时显式失败并提示，key 串绝不进仓库。
// 真实请求 + 真实模型回复断言（正文非空、stopReason=end_turn）；端点不可达则失败，不做任何 stub。
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.H2_E2E_LOCAL === '1';
const describeE2E = ENABLED ? describe : describe.skip;

const LOCAL_BASE_URL = process.env.LOCAL_UNIFIED_BASE_URL ?? 'http://127.0.0.1:40080/v1';
const LOCAL_MODEL = process.env.LOCAL_UNIFIED_MODEL ?? 'big-pickle';
const LOCAL_KEY: string | undefined = process.env.LOCAL_UNIFIED_KEY; // 仅环境注入（无源码兜底字面量）

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/** 去掉 banner / 提示符 / 工具行后剩余的模型正文 */
function assistantText(stdout: string): string {
  const beforeSummary = stdout.split(/\[(?:end_turn|tool_failures|error|max_steps|cancelled)\b/)[0] ?? '';
  const kept: string[] = [];
  for (const raw of beforeSummary.split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (raw.startsWith('harness2 chat') || raw.startsWith('输入 /help') || raw.startsWith('会话: ')) continue;
    if (/^> [a-z0-9_]+ \(/.test(raw)) continue; // 工具调用行：> tool (args)
    if (/^< (ok|FAILED) \[/.test(raw)) continue; // 工具结果行：< ok [callId]
    const text = raw.replace(/^> ?/, ''); // 去 readline 提示符（正文与提示符同行的情形）
    if (text.trim().length > 0) kept.push(text);
  }
  return kept.join('\n').trim();
}

describeE2E('T5 真实本地模型 E2E（H2_E2E_LOCAL=1）', () => {
  it('真实往返：piped legacy chat 对本地 big-pickle 发一轮，得到非空模型正文并干净退出', async () => {
    // key 只经环境注入：闸门开启但未提供时在此显式失败（不静默跳过、不退回源码字面量）
    expect(LOCAL_KEY, 'H2_E2E_LOCAL=1 需同时提供 LOCAL_UNIFIED_KEY（key 仅经环境注入，不进 git）').toBeTruthy();
    const home = mkdtempSync(join(tmpdir(), 'h2-e2e-home-'));
    const root = mkdtempSync(join(tmpdir(), 'h2-e2e-root-'));
    mkdirSync(join(home, '.harness2'), { recursive: true });
    const config = {
      providers: {
        'local-oai': {
          protocol: 'openai',
          baseUrl: LOCAL_BASE_URL,
          models: { [LOCAL_MODEL]: { contextWindow: 200000, maxOutputTokens: 4096 } },
        },
      },
      roles: {
        main: { channel: 'local-oai', model: LOCAL_MODEL },
        small: { channel: 'local-oai', model: LOCAL_MODEL },
      },
      approval: { mode: 'bypass' },
    };
    writeFileSync(join(home, '.harness2', 'config.json'), JSON.stringify(config), 'utf8');
    // key 只写隔离 home 的 auth.json；测试运行期生成，不入库
    writeFileSync(
      join(home, '.harness2', 'auth.json'),
      JSON.stringify({ channels: { 'local-oai': { apiKey: LOCAL_KEY as string } } }),
      'utf8',
    );

    let stdout = '';
    let stderr = '';
    const proc = spawn('node', [cliEntry, 'chat', '--home', home, '--root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const closed = new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? -1)));
    try {
      const waitFor = async (cond: () => boolean, timeoutMs = 60000): Promise<void> => {
        const start = Date.now();
        while (!cond()) {
          if (Date.now() - start > timeoutMs) {
            throw new Error(
              `E2E 超时（端点不可达或模型无响应）：${LOCAL_BASE_URL}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            );
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await waitFor(() => stdout.includes('输入 /help 查看命令'));
      proc.stdin.write('Reply with one short sentence about testing.\n');
      await waitFor(() => /\[(?:end_turn|error|max_steps|cancelled)\b/.test(stdout));
      const text = assistantText(stdout);
      console.log(`[T5 E2E] model=${LOCAL_MODEL} baseUrl=${LOCAL_BASE_URL} assistantText=${JSON.stringify(text)}`);
      expect(stdout).toContain('[end_turn'); // 真实模型正常收尾（非 error/未达端点）
      expect(text.length).toBeGreaterThan(0); // 真实非空模型正文
      expect(stdout).not.toContain('error:');
      proc.stdin.write('/exit\n');
      const code = await closed;
      expect(code).toBe(0);
      expect(proc.exitCode).toBe(0);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// 未启用时明确说明原因（避免误以为“已通过”）
if (!ENABLED) {
  describe('T5 真实本地模型 E2E（未启用）', () => {
    it.skip('需要 H2_E2E_LOCAL=1 且本地模型服务可用（验收时必跑；CI 默认跳过）', () => undefined);
  });
}
