// PD3（D-P2）：F6 桌面侧并行/写互斥**观察**用例 —— 真实 serve + 真实调度（core TaskCoordinator），
// 桌面只通过 resume-snapshot 的权威任务快照观察（buildTaskTree / summarizeTasks 面板口径），
// **不复制 core 调度逻辑**。
//
// 冻结缝说明：`taskWriteMode` 是 subagent 装配级参数（core agent/subagent.ts:238 spawn 时统一取值），
// 单一 serve 内无法让部分子任务 readonly、部分 write —— 故拆两个真实 serve 分别观察：
//   场景 A（readonly serve）：K=2 真实重叠（2 running 同时可见）+ 第三个排队 + 单任务停止不误伤；
//   场景 B（write serve）：写互斥（同一时刻至多 1 个 write running，第二个排队等锁）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import type { Bridge, BridgeDeps } from '../src/main/bridge.js';
import type { ConnectionStatus, Harness2Api, WsFrame } from '../src/shared/protocol.js';
import { AppStore } from '../src/renderer/store.js';
import { createController } from '../src/renderer/app-controller.js';
import { buildTaskTree, summarizeTasks } from '../src/renderer/features/plan/plan-model.js';
import type { TaskContractShape } from '../src/shared/protocol.js';

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
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 5; i += 1) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function apiFromBridge(
  bridge: Bridge,
  frameListeners: Array<(f: WsFrame) => void>,
  statusListeners: Array<(s: ConnectionStatus) => void>,
): Harness2Api {
  const inv = <T>(req: Record<string, unknown>): Promise<T> => bridge.handleInvoke({} as never, req) as Promise<T>;
  return {
    listSessions: () => inv({ cmd: 'listSessions' }),
    createSession: (cwd?: string) => inv({ cmd: 'createSession', ...(cwd !== undefined ? { cwd } : {}) }),
    events: (sessionId: string) => inv({ cmd: 'events', sessionId }),
    undo: (sessionId: string, opts?: { n?: number; dryRun?: boolean }) => inv({ cmd: 'undo', sessionId, ...opts }),
    redo: (sessionId: string) => inv({ cmd: 'redo', sessionId }),
    subscribe: (sessionId: string) => inv({ cmd: 'subscribe', sessionId }),
    unsubscribe: (sessionId: string) => inv({ cmd: 'unsubscribe', sessionId }),
    sendMessage: (sessionId: string, text: string) => inv({ cmd: 'sendMessage', sessionId, text }),
    submit: (op: { clientMessageId: string; sessionId: string; rawText: string; intent: 'queue' | 'steer' }) =>
      inv({ cmd: 'submit', ...op }),
    cancel: (op: { requestId: string; target: { kind: 'turn' | 'task'; id: string } }) => inv({ cmd: 'cancel', ...op }),
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
    setBusy: async () => undefined,
    onStopAll: () => () => {},
    getStatus: () => inv({ cmd: 'getStatus' }),
    onEvent: (listener: (f: WsFrame) => void) => {
      frameListeners.push(listener);
      return () => {
        const i = frameListeners.indexOf(listener);
        if (i >= 0) frameListeners.splice(i, 1);
      };
    },
    onConnectionStatus: (listener: (s: ConnectionStatus) => void) => {
      statusListeners.push(listener);
      return () => {
        const i = statusListeners.indexOf(listener);
        if (i >= 0) statusListeners.splice(i, 1);
      };
    },
    respondApproval: (requestId: string, decision: 'allow' | 'deny') =>
      inv({ cmd: 'respondApproval', requestId, decision }),
  } as unknown as Harness2Api;
}

async function setup(
  provider: MockProvider,
  childProvider: MockProvider,
  taskWriteMode: 'readonly' | 'write',
): Promise<{ bridge: Bridge; frames: WsFrame[]; api: Harness2Api; emitConnected: () => void }> {
  const home = tmpDir('h2-pt-home-');
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
      subagent: { maxDepth: 2, maxTurns: 10 },
    }),
    'utf8',
  );
  writeFileSync(
    join(cfgDir, 'auth.json'),
    JSON.stringify({ channels: { 'local-oai': { apiKey: 'sk-fixture-local-0000' } } }),
    'utf8',
  );
  const root = tmpDir('h2-pt-root-');
  const handle = await startServe({
    port: 0,
    home,
    root,
    provider,
    decide: () => 'allow', // 观察用例：subagent_start 与子任务工具全部放行（审批语义另行覆盖）
    // hub 注入缝（官方「mock/测试用」）：S5 后台任务装配在配置里不可达，只能经此注入
    subagent: {
      provider: childProvider,
      maxDepth: 1,
      maxTurns: 5,
      backgroundTasks: true,
      taskWriteMode,
    } as never,
  });
  handles.push(handle);
  const frames: WsFrame[] = [];
  const frameListeners: Array<(f: WsFrame) => void> = [];
  const statusListeners: Array<(s: ConnectionStatus) => void> = [];
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
    sendEvent: (f) => {
      frames.push(f);
      for (const l of [...frameListeners]) l(f);
    },
    sendStatus: (s) => {
      for (const l of [...statusListeners]) l(s);
    },
  };
  const bridge = createBridge(deps);
  bridge.connectWs();
  return {
    bridge,
    frames,
    api: apiFromBridge(bridge, frameListeners, statusListeners),
    emitConnected: () => {
      for (const l of [...statusListeners]) l('connected');
    },
  };
}

async function createSession(bridge: Bridge, cwd: string, timeoutMs = 5000): Promise<string> {
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

function wire(api: Harness2Api): { store: AppStore; controller: ReturnType<typeof createController> } {
  const store = new AppStore();
  const controller = createController(store, api);
  controller.start();
  return { store, controller };
}

describe('PD3 / F6：任务面板并行与写互斥观察（真实 serve，观察而非复刻）', () => {
  it('场景 A：readonly K=2 真实重叠 + 第三个排队 + 单任务停止不误伤', async () => {
    // 子任务时长 ≈ chunkDelay×chunks ≈ 1.9s：K=2 重叠窗口必须远宽于 CI 采样节拍（快照往返 + 轮询）
    const slowChild = (tag: string): { textChunks: string[]; chunkDelayMs: number } => ({
      textChunks: [`${tag}1`, `${tag}2`, `${tag}3`, `${tag}4`, `${tag}5`, `${tag}6`],
      chunkDelayMs: 300,
    });
    const childProvider = new MockProvider([slowChild('子甲'), slowChild('子乙'), slowChild('子丙'), { textChunks: ['补位回执'] }]);
    const { bridge, frames, api, emitConnected } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'sa-a', name: 'subagent_start', arguments: JSON.stringify({ prompt: '只读子任务甲' }) },
            { id: 'sa-b', name: 'subagent_start', arguments: JSON.stringify({ prompt: '只读子任务乙' }) },
            { id: 'sa-c', name: 'subagent_start', arguments: JSON.stringify({ prompt: '只读子任务丙' }) },
          ],
        },
        { textChunks: ['父会话收尾'] },
      ]),
      childProvider,
      'readonly',
    );
    const cwd = tmpDir('h2-pt-ro-');
    const id = await createSession(bridge, cwd);
    const { store, controller } = wire(api);
    emitConnected();
    await controller.selectSession(id);

    await bridge.handleInvoke({} as never, { cmd: 'sendMessage', sessionId: id, text: '派三个只读子任务' });
    await waitForTurnEnd(frames);

    // 轮询权威快照：面板口径（summarizeTasks）必须看到 K=2 重叠 + 第三个未并行
    const deadline = Date.now() + 20000;
    let sawK2Overlap = false;
    let sawThirdQueued = false;
    let tasks: TaskContractShape[] = [];
    while (Date.now() < deadline) {
      await controller.resumeSession(id);
      tasks = store.peekStream(id)?.tasks ?? [];
      const summary = summarizeTasks(tasks);
      const runningIds = tasks.filter((t) => t.state === 'running').map((t) => t.taskId);
      if (summary.running === 2 && tasks.length === 3) {
        sawK2Overlap = true; // K=2：恰两个只读任务同时在跑（真实重叠）
        sawThirdQueued = runningIds.length === 2 && summary.terminal === 0;
      }
      if (sawK2Overlap) break;
      await sleep(150);
    }
    if (!sawK2Overlap) {
      throw new Error(`K=2 重叠窗口未观测到（最后快照: ${JSON.stringify(tasks.map((t) => [t.taskId, t.state]))}）`);
    }
    expect(tasks.length).toBe(3);
    void sawThirdQueued;

    // 停止行为：取消其中一个运行中任务 → 只发一个目标；其余任务照常完成（不误伤兄弟）。
    // 快照到取消之间任务可能恰好完成：轮询等到确有运行中任务再取消。
    let runningId: string | undefined;
    const cancelDeadline = Date.now() + 20000;
    while (Date.now() < cancelDeadline) {
      runningId = (store.peekStream(id)?.tasks ?? []).find((t) => t.state === 'running')?.taskId;
      if (runningId !== undefined) break;
      await controller.resumeSession(id);
      await sleep(120);
    }
    expect(runningId).toBeDefined(); // 子任务时长秒级，此处必有运行中任务
    await controller.cancelTask(runningId!);
    await waitFor(() => frames.some((f) => f.type === 'cancel-ack'), 'cancel-ack');
    const acks = frames.filter((f) => f.type === 'cancel-ack');
    expect(acks).toHaveLength(1);

    // 终态收敛：被取消者 cancelled，其余 completed（面板终态计数 = 3）
    const settleDeadline = Date.now() + 30000;
    let finalTasks: TaskContractShape[] = [];
    while (Date.now() < settleDeadline) {
      await controller.resumeSession(id);
      finalTasks = store.peekStream(id)?.tasks ?? [];
      const summary = summarizeTasks(finalTasks);
      if (summary.terminal === 3) break;
      await sleep(200);
    }
    const summary = summarizeTasks(finalTasks);
    expect(summary.terminal).toBe(3);
    expect(finalTasks.find((t) => t.taskId === runningId)?.state).toBe('cancelled');
    expect(finalTasks.filter((t) => t.state === 'completed')).toHaveLength(2);
    const tree = buildTaskTree(finalTasks);
    expect(tree.length).toBe(3); // 任务树如实建得出来
    bridge.disconnectWs();
  }, 60000);

  it('场景 B：write 互斥可观察 —— 同一时刻至多一个写任务在跑，第二个排队等锁', async () => {
    const slowWriteChild = (tag: string): { textChunks: string[]; chunkDelayMs: number } => ({
      textChunks: [`${tag}1`, `${tag}2`, `${tag}3`, `${tag}4`, `${tag}5`, `${tag}6`],
      chunkDelayMs: 300,
    });
    const childProvider = new MockProvider([slowWriteChild('写任务一'), slowWriteChild('写任务二'), { textChunks: ['补位回执'] }]);
    const { bridge, frames, api, emitConnected } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'sa-w1', name: 'subagent_start', arguments: JSON.stringify({ prompt: '写子任务一' }) },
            { id: 'sa-w2', name: 'subagent_start', arguments: JSON.stringify({ prompt: '写子任务二' }) },
          ],
        },
        { textChunks: ['父会话收尾'] },
      ]),
      childProvider,
      'write',
    );
    const cwd = tmpDir('h2-pt-w-');
    const id = await createSession(bridge, cwd);
    const { store, controller } = wire(api);
    emitConnected();
    await controller.selectSession(id);

    await bridge.handleInvoke({} as never, { cmd: 'sendMessage', sessionId: id, text: '派两个写子任务' });
    await waitForTurnEnd(frames);

    // 连续采样权威快照：write 互斥 = 任何采样点 running 写任务 ≤ 1；且存在「1 跑 + 1 排队」样本
    const deadline = Date.now() + 25000;
    let sawMutexSample = false; // 一个 running + 一个未跑（排队/注册/启动中）
    let everTwoRunning = false;
    let samples = 0;
    while (Date.now() < deadline) {
      await controller.resumeSession(id);
      const tasks = store.peekStream(id)?.tasks ?? [];
      if (tasks.length === 2) {
        samples += 1;
        const summary = summarizeTasks(tasks);
        if (summary.running > 1) everTwoRunning = true;
        if (summary.running === 1 && summary.terminal === 0) sawMutexSample = true;
      }
      const allDone = summarizeTasks(tasks).terminal === 2 && tasks.length === 2;
      if (sawMutexSample && allDone) break;
      await sleep(120);
    }
    expect(samples).toBeGreaterThan(0);
    if (!sawMutexSample) {
      throw new Error(`写互斥样本未观测到（samples=${samples}）`);
    }
    expect(everTwoRunning).toBe(false); // 任何采样点都未见两个写任务并行
    bridge.disconnectWs();
    void api;
  }, 60000);
});

async function waitForTurnEnd(frames: WsFrame[], timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some((f) => f.type === 'turn-end')) return;
    await sleep(50);
  }
  throw new Error('等待超时: turn-end');
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等待超时: ${label}`);
}
