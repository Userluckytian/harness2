// F12/D6：**真实本地模型**往返（不是 mock）。
//
// 门槛：本地统一网关在线 + 环境变量 `LOCAL_UNIFIED_KEY` 提供 key（key 不进 git）。
// 未提供 key 时整组跳过（CI 默认不跑；无 key 也能全绿）。
// 运行方式（示例）：
//   LOCAL_UNIFIED_KEY=<本地 key> pnpm --filter @harness2/desktop test test/desktop-real-model.test.ts
//
// 断言的是真实往返产物：助手正文非空、run-config 显示本地模型、事件流里不出现密钥明文。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeHandle } from '@harness2/core';
import type { Bridge, BridgeDeps } from '../src/main/bridge.js';
import type { EffectiveRunConfigShape, WsFrame } from '../src/shared/protocol.js';

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

const KEY = process.env['LOCAL_UNIFIED_KEY'];
const BASE_URL = process.env['H2_LOCAL_BASE_URL'] ?? 'http://127.0.0.1:40080/v1';
const MODEL = process.env['H2_LOCAL_MODEL'] ?? 'big-pickle';

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

/** 本地网关配置（envKey 指向 LOCAL_UNIFIED_KEY；key 明文不落盘、不进 git） */
function writeLocalModelConfig(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        'local-oai': {
          protocol: 'openai', // openai → 实打 {baseUrl}/chat/completions，故 baseUrl 带 /v1
          baseUrl: BASE_URL,
          envKey: 'LOCAL_UNIFIED_KEY',
          models: { [MODEL]: { contextWindow: 200000, maxOutputTokens: 2048 } },
        },
      },
      roles: { main: { channel: 'local-oai', model: MODEL } },
      approval: { mode: 'bypass' }, // 纯文本往返，免审批噪音
      memory: { mode: 'off', nudgeInterval: 10 },
    }),
    'utf8',
  );
}

describe.skipIf(KEY === undefined)('F12：真实本地模型往返（big-pickle）', () => {
  it('真实 serve + 真实模型：助手正文非空、run-config 显示本地模型、事件流无密钥明文', async () => {
    const home = tmpDir('h2-real-home-');
    writeLocalModelConfig(home);
    const root = tmpDir('h2-real-root-');
    const cwd = tmpDir('h2-real-cwd-');
    // 不注入 provider：走 config 装配 → 真实本地网关
    const handle = await startServe({ port: 0, home, root });
    handles.push(handle);

    const frames: WsFrame[] = [];
    const deps: BridgeDeps = {
      serve: {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        wsUrl: `ws://127.0.0.1:${handle.port}/ws`,
        authToken: handle.token,
        status: 'connected',
        getStatus: () => ({ status: 'connected' }),
      } as never,
      root,
      home,
      sendEvent: (f) => frames.push(f),
      sendStatus: () => {},
    };
    const bridge: Bridge = createBridge(deps);
    bridge.connectWs();

    const created = (await bridge.handleInvoke({} as never, { cmd: 'createSession', cwd })) as { id: string };
    for (let i = 0; i < 60; i++) {
      try {
        await bridge.handleInvoke({} as never, { cmd: 'subscribe', sessionId: created.id });
        break;
      } catch {
        await sleep(50);
      }
    }

    // 真实模型往返（给足冷启动时间）
    await bridge.handleInvoke({} as never, {
      cmd: 'sendMessage',
      sessionId: created.id,
      text: '只回答一个数字，不要解释：1+1 等于几？',
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !frames.some((f) => f.type === 'turn-end')) await sleep(100);

    const turnEnd = frames.find((f) => f.type === 'turn-end');
    expect(turnEnd, '真实模型未在 120s 内收尾（网关/模型不可用？）').toBeTruthy();
    expect(turnEnd!.stopReason).toBe('end_turn');

    // 真实助手正文非空（不是 mock 的固定串）
    const assistant = frames.find(
      (f) =>
        f.type === 'event' && f.event.type === 'assistant/message' && String(f.event.payload['text'] ?? '').length > 0,
    );
    expect(assistant, '真实模型未产出助手正文').toBeTruthy();
    const text = String((assistant as Extract<WsFrame, { type: 'event' }>).event.payload['text']);
    expect(text.trim().length).toBeGreaterThan(0);

    // 本轮回实际生效配置 = 本地网关模型（F8/F12 交叉验证）
    const rc = (await bridge.handleInvoke({} as never, {
      cmd: 'runConfig',
      sessionId: created.id,
    })) as EffectiveRunConfigShape;
    expect(rc.provider.channel).toBe('local-oai');
    expect(rc.provider.model).toBe(MODEL);
    expect(rc.approval.mode).toBe('bypass');

    // 密钥不出现在任何回传帧/配置视图里
    expect(JSON.stringify(frames)).not.toContain(KEY!);
    expect(JSON.stringify(rc)).not.toContain(KEY!);
    bridge.disconnectWs();
  }, 180_000);
});

describe.skipIf(KEY !== undefined)('F12（未提供 key 时）', () => {
  it('跳过真实模型往返：需要 LOCAL_UNIFIED_KEY（key 不进 git）', () => {
    expect(KEY).toBeUndefined();
  });
});
