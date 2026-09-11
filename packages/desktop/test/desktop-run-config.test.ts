// D0 桌面适配层真接线测试：bridge 经真实 startServe（127.0.0.1 随机端口 + 严格 token）消费
// S7 只读契约与能力盘点。断言的是**真实 HTTP 往返**，不是 mock：
//   GET .../run-config / plan-state / execution-view / change-review（经 IPC bridge）
//   capabilities 实测端点缺失 → unavailable（不假装可用）
// 另含能力盘点的纯逻辑用例（serve 未就绪 / 路由缺失）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import {
  buildCapabilityReport,
  capabilityEnabled,
  capabilityReason,
  classifyProbeResponse,
} from '../src/shared/capabilities.js';
import type { Bridge, BridgeDeps } from '../src/main/bridge.js';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {} },
}));

import { createBridge } from '../src/main/bridge.js';

const dirs: string[] = [];
const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function writeConfigHome(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        ds: {
          protocol: 'openai',
          baseUrl: 'https://api.test/v1',
          envKey: 'DS_KEY',
          models: { 'm-1': { contextWindow: 128000, maxOutputTokens: 4096 } },
        },
      },
      roles: { main: { channel: 'ds', model: 'm-1' } },
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
    }),
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'auth.json'),
    JSON.stringify({ channels: { ds: { apiKey: 'sk-plain-secret-987654' } } }),
    'utf8',
  );
}

function makeDeps(baseUrl: string, wsUrl: string, authToken: string | null, onFrame: (f: unknown) => void): BridgeDeps {
  return {
    serve: {
      baseUrl,
      wsUrl,
      authToken,
      status: 'connected',
      getStatus: () => ({ status: 'connected' }),
    } as never,
    root: 'C:\\work',
    home: 'C:\\Users\\test\\.harness2',
    sendEvent: onFrame,
    sendStatus: () => {},
  };
}

async function invokeWhenReady(bridge: Bridge, req: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await bridge.handleInvoke({} as never, req);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(50);
    }
  }
}

describe('D0 bridge × 真实 serve：S7 只读契约全链', () => {
  it('run-config / execution-view / change-review 真实命中；plan-state 无账本 → null；能力盘点如实', async () => {
    const home = tmpDir('h2-d0-home-');
    writeConfigHome(home);
    const root = tmpDir('h2-d0-root-');
    const cwd = tmpDir('h2-d0-cwd-');
    const handle = await startServe({
      port: 0,
      home,
      root,
      provider: new MockProvider([
        {
          toolCalls: [
            { id: 'call-w', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: 'v2' }) },
          ],
        },
        {
          toolCalls: [
            { id: 'call-bash', name: 'bash', arguments: JSON.stringify({ command: 'node -e "process.exit(0)"' }) },
          ],
        },
        { textChunks: ['完成'] },
      ]),
      decide: () => 'allow',
    });
    handles.push(handle);

    const frames: Array<{ type?: string }> = [];
    const bridge = createBridge(
      makeDeps(`http://127.0.0.1:${handle.port}`, `ws://127.0.0.1:${handle.port}/ws`, handle.token, (f) =>
        frames.push(f as { type?: string }),
      ),
    );
    bridge.connectWs();
    const created = (await bridge.handleInvoke({} as never, { cmd: 'createSession', cwd })) as { id: string };
    await invokeWhenReady(bridge, { cmd: 'subscribe', sessionId: created.id });
    await invokeWhenReady(bridge, { cmd: 'sendMessage', sessionId: created.id, text: '写文件并跑一次命令' });
    for (let i = 0; i < 300 && !frames.some((f) => f.type === 'turn-end'); i++) await sleep(20);
    expect(frames.some((f) => f.type === 'turn-end')).toBe(true);

    // —— run-config：真实装配 + 脱敏 ——
    const rc = (await bridge.handleInvoke({} as never, { cmd: 'runConfig', sessionId: created.id })) as any;
    expect(rc.redacted).toBe(true);
    expect(rc.session.sessionId).toBe(created.id);
    expect(rc.session.cwd).toBe(resolve(cwd)); // per-session cwd 真值（不串 root）
    expect(typeof rc.provider.model).toBe('string');
    expect(rc.approval.mode).toBe('default');
    expect(rc.tools).toContain('bash');
    expect(rc.tools).toContain('write');
    expect(JSON.stringify(rc)).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);

    // —— execution-view：真实命令归属（executed + cwd + 非虚构退出码来源） ——
    const views = (await bridge.handleInvoke({} as never, { cmd: 'executionViews', sessionId: created.id })) as any[];
    const bash = views.find((v) => v.callId === 'call-bash');
    expect(bash).toBeTruthy();
    expect(bash.commandSource).toBe('executed');
    expect(bash.cwd).toBe(resolve(cwd)); // cwd 归属该会话（realpath 归一）
    expect(['bash-error', 'bash-ok', 'none']).toContain(bash.exitCodeSource);
    expect(bash.readOnly).toBe(true);

    // —— change-review：真实写入 → 干净态（dirty=false） ——
    const review = (await bridge.handleInvoke({} as never, { cmd: 'changeReview', sessionId: created.id })) as any;
    expect(review.readOnly).toBe(true);
    expect(review.changedFiles).toBeGreaterThanOrEqual(1);
    expect(review.files.some((f: any) => f.file.endsWith('hello.txt'))).toBe(true);
    expect(review.dirtyFiles).toBe(0);

    // —— plan-state：无 task 账本 → 404 → bridge 归 null（不臆造计划） ——
    const plan = await bridge.handleInvoke({} as never, { cmd: 'planState', sessionId: created.id });
    expect(plan).toBeNull();

    // —— 能力盘点：serve 就绪 + 端点真实存在 → available；plan-state 的 404 是「数据缺失」非能力缺失 ——
    const caps = (await bridge.handleInvoke({} as never, { cmd: 'capabilities', sessionId: created.id })) as any;
    expect(capabilityEnabled(caps, 'serve')).toBe(true);
    expect(capabilityEnabled(caps, 'run-config')).toBe(true);
    expect(capabilityEnabled(caps, 'plan-state')).toBe(true);
    expect(capabilityEnabled(caps, 'execution-view')).toBe(true);
    expect(capabilityEnabled(caps, 'change-review')).toBe(true);
    expect(capabilityEnabled(caps, 'queue')).toBe(true);

    // —— 缺 sessionId：明确报错（不静默打空路径） ——
    await expect(bridge.handleInvoke({} as never, { cmd: 'runConfig' })).rejects.toThrow('缺少 sessionId');
    bridge.disconnectWs();
  }, 30000);
});

describe('能力盘点纯逻辑（不摆假入口）', () => {
  it('serve 未就绪 → 全表 unavailable（含 serve 自身），原因是等待连接', () => {
    const report = buildCapabilityReport({ serveReady: false });
    expect(capabilityEnabled(report, 'serve')).toBe(false);
    expect(capabilityEnabled(report, 'run-config')).toBe(false);
    expect(capabilityReason(report, 'run-config')).toContain('未就绪');
  });

  it('serve 就绪 + 实测路由缺失 → 仅该端点 unavailable（其余 available）', () => {
    const report = buildCapabilityReport({ serveReady: true, unsupportedEndpoints: new Set(['plan-state']) });
    expect(capabilityEnabled(report, 'plan-state')).toBe(false);
    expect(capabilityReason(report, 'plan-state')).toContain('未提供该端点');
    expect(capabilityEnabled(report, 'run-config')).toBe(true);
    expect(capabilityEnabled(report, 'change-review')).toBe(true);
  });

  it('classifyProbeResponse：404 + `not found:` = 路由缺失；业务 404（暂无计划数据）= 路由存在', () => {
    expect(classifyProbeResponse('plan-state', 404, 'not found: GET /api/sessions/x/plan-state')).toBe(true);
    expect(classifyProbeResponse('plan-state', 404, '会话暂无计划数据（无 task/transition 账本）')).toBe(false);
    expect(classifyProbeResponse('plan-state', 200, undefined)).toBe(false);
    expect(classifyProbeResponse('plan-state', 401, '缺少 serve token')).toBe(false);
  });
});
