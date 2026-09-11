// D6：F1–F8 桌面端**真实**工作流证据（真实 startServe + 真实工具执行 + 桌面 bridge/controller/store）。
// 反「只接 mock 冒充端到端」：本用例经真实 HTTP/WS 往返，断言的是后端真实产物（cwd/退出码/审批/变更）。
//
// 覆盖（桌面侧口径）：
//   F1 项目与会话：两会话各自 cwd 不串；草稿隔离
//   F3 修改并测试：真实 bash 退出码/失败/取消状态归属
//   F4 审批与拒绝：approval-request 带 scope/expiresAt；拒绝 → 工具未执行
//   F5 变更与撤销：真实写入 → changeReview；外部改动 → dirty 且 undo 守卫拦截
//   F7 断流与队列：submit 幂等 ack 真实回传（unknown ≠ rejected 语义由 store 用例覆盖）
//   F8 配置与上下文：有效配置来自 hub 装配（模型/工具/上下文窗口/指令来源）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import type { Bridge, BridgeDeps } from '../src/main/bridge.js';
import type { Harness2Api, EffectiveRunConfigShape, WsFrame } from '../src/shared/protocol.js';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';

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
async function waitFor(pred: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等待超时: ${label}`);
}

/** 按 type 取帧（保留收窄类型，避免在断言里来回 cast） */
function findFrame<T extends WsFrame['type']>(
  frames: readonly WsFrame[],
  type: T,
): Extract<WsFrame, { type: T }> | undefined {
  return frames.find((f): f is Extract<WsFrame, { type: T }> => f.type === type);
}

/** 把 bridge 的 IPC 入口适配成 Harness2Api（controller 直接消费；这就是 preload 的真实形状） */
function apiFromBridge(bridge: Bridge): Harness2Api {
  const inv = <T>(req: Record<string, unknown>): Promise<T> => bridge.handleInvoke({} as never, req) as Promise<T>;
  return {
    listSessions: (cwd?: string) => inv({ cmd: 'listSessions', ...(cwd !== undefined ? { cwd } : {}) }),
    createSession: (cwd?: string) => inv({ cmd: 'createSession', ...(cwd !== undefined ? { cwd } : {}) }),
    events: (sessionId: string) => inv({ cmd: 'events', sessionId }),
    undo: (sessionId: string, opts?: { n?: number; dryRun?: boolean }) => inv({ cmd: 'undo', sessionId, ...opts }),
    redo: (sessionId: string) => inv({ cmd: 'redo', sessionId }),
    subscribe: (sessionId: string) => inv({ cmd: 'subscribe', sessionId }),
    unsubscribe: (sessionId: string) => inv({ cmd: 'unsubscribe', sessionId }),
    sendMessage: (sessionId: string, text: string) => inv({ cmd: 'sendMessage', sessionId, text }),
    submit: (op: {
      clientMessageId: string;
      sessionId: string;
      rawText: string;
      intent: 'queue' | 'steer';
      references?: unknown[];
      expectedTurnId?: string;
    }) => inv({ cmd: 'submit', ...op }),
    cancel: (op: {
      requestId: string;
      target: { kind: 'turn' | 'task'; id: string };
      expectedId?: string;
      expectedTurnGeneration?: number;
    }) => inv({ cmd: 'cancel', ...op }),
    fork: (sessionId: string, atSeq?: number) =>
      inv({ cmd: 'fork', sessionId, ...(atSeq !== undefined ? { atSeq } : {}) }),
    runConfig: (sessionId: string) => inv({ cmd: 'runConfig', sessionId }),
    planState: (sessionId: string) => inv({ cmd: 'planState', sessionId }),
    executionViews: (sessionId: string) => inv({ cmd: 'executionViews', sessionId }),
    changeReview: (sessionId: string) => inv({ cmd: 'changeReview', sessionId }),
    resumeSubscription: (sessionId: string, lastSeq: number, epoch: number) =>
      inv({ cmd: 'resumeSubscription', sessionId, lastSeq, epoch }),
    capabilities: (sessionId?: string) =>
      inv({ cmd: 'capabilities', ...(sessionId !== undefined ? { sessionId } : {}) }),
    getStatus: () => inv({ cmd: 'getStatus' }),
    onEvent: () => () => {},
    onConnectionStatus: () => () => {},
  } as unknown as Harness2Api;
}

function writeConfigHome(home: string): void {
  const cfgDir = join(home, '.harness2');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      providers: {
        'local-oai': {
          protocol: 'openai',
          baseUrl: 'https://api.test/v1',
          envKey: 'LOCAL_UNIFIED_KEY',
          models: { 'big-pickle': { contextWindow: 200000, maxOutputTokens: 8192 } },
        },
      },
      roles: { main: { channel: 'local-oai', model: 'big-pickle' } },
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
    }),
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'auth.json'),
    JSON.stringify({ channels: { 'local-oai': { apiKey: 'sk-unified-local' } } }),
    'utf8',
  );
}

async function setup(
  provider: MockProvider,
  decide?: (input: { tool: string; args: unknown }) => 'allow' | 'deny' | 'ask',
): Promise<{ bridge: Bridge; frames: WsFrame[]; api: Harness2Api; handle: ServeHandle; root: string }> {
  const home = tmpDir('h2-wf-home-');
  writeConfigHome(home);
  const root = tmpDir('h2-wf-root-');
  const handle = await startServe({
    port: 0,
    home,
    root,
    provider,
    ...(decide !== undefined ? { decide } : {}),
  });
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
  const bridge = createBridge(deps);
  bridge.connectWs();
  return { bridge, frames, api: apiFromBridge(bridge), handle, root };
}

async function createAndSubscribe(bridge: Bridge, cwd: string, timeoutMs = 5000): Promise<string> {
  const created = (await bridge.handleInvoke({} as never, { cmd: 'createSession', cwd })) as { id: string };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await bridge.handleInvoke({} as never, { cmd: 'subscribe', sessionId: created.id });
      return created.id;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(50);
    }
  }
}

describe('F1 + F8：项目/会话隔离与有效配置真实来源', () => {
  it('两会话 cwd 各自归属（不串）；run-config 展示真实模型/工具/上下文窗口；能力盘点可用', async () => {
    const { bridge, api } = await setup(new MockProvider([{ textChunks: ['ok'] }]));
    const cwdA = tmpDir('h2-wf-cwdA-');
    const cwdB = tmpDir('h2-wf-cwdB-');
    const store = new AppStore();
    const controller = createController(store, api);

    const idA = await createAndSubscribe(bridge, cwdA);
    const idB = await createAndSubscribe(bridge, cwdB);

    await controller.refreshRunConfig(idA);
    await controller.refreshRunConfig(idB);
    const rcA = store.peekViews(idA)!.runConfig!;
    const rcB = store.peekViews(idB)!.runConfig!;
    expect(rcA.session.cwd).toBe(resolve(cwdA)); // F1：各在自己的目录
    expect(rcB.session.cwd).toBe(resolve(cwdB));
    expect(rcA.session.cwd).not.toBe(rcB.session.cwd);

    // F8：配置来自 hub 装配（脱敏 + 工具集 + 模型身份非空——本 serve 用 MockProvider，
    // 故不在此断言配置里的模型名；配置来源断言见下一条用例的「无 provider 注入」serve）
    expect(rcA.provider.model.length).toBeGreaterThan(0);
    expect(rcA.provider.channel.length).toBeGreaterThan(0);
    expect(rcA.tools).toContain('bash');
    expect(rcA.tools).toContain('write');
    expect(rcA.redacted).toBe(true);
    expect(JSON.stringify(rcA)).not.toContain('sk-unified-local');

    // 草稿按会话隔离（F1：A/B 不串）
    store.setDraft(idA, 'A 项目的草稿');
    store.setDraft(idB, 'B 项目的草稿');
    expect(store.draftFor(idA)).toBe('A 项目的草稿');
    expect(store.draftFor(idB)).toBe('B 项目的草稿');

    // 能力盘点（F8：真实探测）
    await controller.refreshCapabilities(idA);
    const caps = store.getState().capabilities!;
    expect(caps.entries.every((e) => e.status === 'available')).toBe(true);
    bridge.disconnectWs();
  }, 30000);
});

describe('F8：有效配置真实来自 config.json 装配（不注入 provider）', () => {
  it('渠道/模型/上下文窗口/角色 = 配置文件真值；脱敏；工具集来自装配', async () => {
    const home = tmpDir('h2-wf-cfg-home-');
    writeConfigHome(home);
    const root = tmpDir('h2-wf-cfg-root-');
    const cwd = tmpDir('h2-wf-cfg-cwd-');
    const handle = await startServe({ port: 0, home, root }); // 无 provider 注入 → 配置派生
    handles.push(handle);
    const frames: WsFrame[] = [];
    const bridge = createBridge({
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
    });
    const api = apiFromBridge(bridge);
    bridge.connectWs();
    const id = await createAndSubscribe(bridge, cwd);
    const rc = (await api.runConfig(id)) as EffectiveRunConfigShape;
    expect(rc.provider).toMatchObject({ role: 'main', channel: 'local-oai', model: 'big-pickle', protocol: 'openai' });
    expect(rc.context.contextWindow).toBe(200000);
    expect(rc.context.maxOutputTokens).toBe(8192);
    expect(rc.session.cwd).toBe(resolve(cwd));
    expect(rc.session.perSessionCwd).toBe(true);
    expect(rc.redacted).toBe(true);
    expect(rc.connection.status).toBe('unknown'); // 不臆造 connected
    expect(JSON.stringify(rc)).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
    bridge.disconnectWs();
  }, 30000);
});

describe('F3 + F5：真实命令归属与变更审查（外部改动拦截）', () => {
  it('bash 真实退出码/失败归属；写文件后 changeReview 干净 → 外部改动 dirty → undo 守卫拦截', async () => {
    const { bridge, frames, api } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'c-w', name: 'write', arguments: JSON.stringify({ file_path: 'hello.txt', content: 'v2' }) },
          ],
        },
        {
          toolCalls: [{ id: 'c-b', name: 'bash', arguments: JSON.stringify({ command: 'node -e "process.exit(3)"' }) }],
        },
        { textChunks: ['完成'] },
      ]),
      () => 'allow',
    );
    const cwd = tmpDir('h2-wf-f3-');
    const id = await createAndSubscribe(bridge, cwd);
    await bridge.handleInvoke({} as never, { cmd: 'sendMessage', sessionId: id, text: '改文件并跑命令' });
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), 'turn-end');

    // F3：真实 shell / cwd / 退出码归属
    const views = (await api.executionViews(id)) as unknown as Array<Record<string, unknown>>;
    const bash = views.find((v) => v.callId === 'c-b')!;
    expect(bash.commandSource).toBe('executed');
    expect(bash.cwd).toBe(resolve(cwd));
    expect(bash.exitCode).toBe(3);
    expect(bash.exitCodeSource).toBe('bash-error');
    expect(bash.status).toBe('failed');
    expect(typeof bash.shell).toBe('string');

    // F5：真实落盘 → 干净态
    const file = join(cwd, 'hello.txt');
    expect(readFileSync(file, 'utf8')).toBe('v2');
    const clean = (await api.changeReview(id)) as { dirtyFiles: number; changedFiles: number };
    expect(clean.changedFiles).toBeGreaterThanOrEqual(1);
    expect(clean.dirtyFiles).toBe(0);

    // F5：外部改动 → dirty，undo 守卫必须拦截（不静默覆盖）
    writeFileSync(file, 'human-edit', 'utf8');
    const store = new AppStore();
    const controller = createController(store, api);
    const guard = await controller.undoWithGuard(id);
    expect(guard?.blocked).toBe(true);
    expect(guard?.externallyModified).toBeGreaterThanOrEqual(1);
    // 外部内容原样保留（未覆盖）
    expect(readFileSync(file, 'utf8')).toBe('human-edit');

    const dirty = (await api.changeReview(id)) as { dirtyFiles: number };
    expect(dirty.dirtyFiles).toBe(1);
    bridge.disconnectWs();
  }, 40000);
});

describe('F4 + F7：审批拒绝不执行 + submit 幂等 ack 真实回传', () => {
  it('ask 模式下 write 挂起（带 scope/expiresAt），拒绝后文件不存在；submit 收到 accepted ack', async () => {
    const { bridge, frames, api } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'c-w2', name: 'write', arguments: JSON.stringify({ file_path: 'never.txt', content: 'x' }) },
          ],
        },
        { textChunks: ['结束'] },
      ]),
      () => 'ask',
    );
    const cwd = tmpDir('h2-wf-f4-');
    const id = await createAndSubscribe(bridge, cwd);

    // F7：submit（幂等 id + queue 语义）→ 真实 submit-ack
    await api.submit({
      clientMessageId: 'cm-wf-1',
      sessionId: id,
      rawText: '请写一个文件',
      intent: 'queue',
    });
    await waitFor(() => frames.some((f) => f.type === 'submit-ack' && f.clientMessageId === 'cm-wf-1'), 'submit-ack');
    const ack = frames.find((f) => f.type === 'submit-ack' && f.clientMessageId === 'cm-wf-1')!;
    expect(ack.type === 'submit-ack' && ack.state).toBe('accepted');

    // F4：approval-request 带 scope/expiresAt；拒绝 → 工具未执行
    await waitFor(() => frames.some((f) => f.type === 'approval-request'), 'approval-request');
    const req = findFrame(frames, 'approval-request')!;
    expect(req.tool).toBe('write');
    expect(req.scope?.mode).toBe('once');
    expect(typeof req.expiresAt).toBe('string');
    await bridge.handleInvoke({} as never, {
      cmd: 'respondApproval',
      requestId: req.requestId,
      decision: 'deny',
    });
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), 'turn-end after deny');
    expect(existsSync(join(cwd, 'never.txt'))).toBe(false); // 拒绝项未执行
    bridge.disconnectWs();
  }, 40000);
});
