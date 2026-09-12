// PD2（D-P2）：F7 故障注入 —— 真实 serve + 真实 bridge WS，经 TCP 代理**强断**连接（不 mock 连接层）。
// 断点三态：流式文本中 / 工具执行中 / 审批等待中。断言：
//   1) 不假报停止：断线本身不把运行中 turn 标成已停；
//   2) 不永久 loading：turn 在断线窗口内跑完 → 重连权威快照必须如实落定（不再显示运行中）；
//   3) 重连恢复订阅 + 快照：WS 恢复后重发 subscribe + resume-subscription，事件流与权威状态齐活。
// 故障注入方式：代理层 sever() destroy 全部既有 TCP 连接（bridge 的 WS 异常 close → 1s 自动重连）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, startServe, type ServeHandle } from '@harness2/core';
import type { Bridge, BridgeDeps } from '../src/main/bridge.js';
import type { ConnectionStatus, Harness2Api, WsFrame } from '../src/shared/protocol.js';
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
  for (const d of dirs.splice(0)) {
    // Windows：serve 子进程/工具进程可能短暂占用目录，重试几次再放弃
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
async function waitFor(pred: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`等待超时: ${label}`);
}

/** TCP 代理：真实转发 serve 端口；sever() = destroy 全部既有连接（注入「中途断 WS」故障）。
 *  serve 有 Host 头校验（仅允许 127.0.0.1:<serve 端口>），代理对请求头做一次性 Host 改写。 */
function tcpProxy(targetPort: number): Promise<{ port: number; sever(): void; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let proxyPort = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    const drop = (): void => {
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('close', drop);
    upstream.on('close', drop);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    // 请求头（含 WS upgrade）缓冲到 \r\n\r\n，把 Host 改写为 serve 端口后放行。
    // 同时把普通请求改写为 connection: close（WS 升级除外）：keep-alive 复用连接上的
    // 后续请求不会再次经过改写，会导致 serve Host 校验拒绝 —— 索性强制一连接一请求，
    // 首个请求头之后的所有字节（请求体）原样透传。
    let head = Buffer.alloc(0);
    let headDone = false;
    client.on('data', (chunk: Buffer) => {
      if (headDone) {
        upstream.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 16384) client.destroy();
        return;
      }
      const raw = head.slice(0, end).toString('latin1');
      let rewritten = raw.replaceAll(`127.0.0.1:${proxyPort}`, `127.0.0.1:${targetPort}`);
      if (!/^connection:\s*upgrade/im.test(rewritten)) {
        rewritten = /^connection:.*/im.test(rewritten)
          ? rewritten.replace(/^connection:.*$/im, 'connection: close')
          : `${rewritten}\r\nconnection: close`;
      }
      upstream.write(rewritten + '\r\n\r\n');
      const rest = head.slice(end + 4);
      if (rest.length > 0) upstream.write(rest);
      head = Buffer.alloc(0);
      headDone = true;
    });
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  return new Promise((resolveProxy) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      proxyPort = addr.port;
      resolveProxy({
        port: addr.port,
        sever: () => {
          for (const s of [...sockets]) s.destroy();
          sockets.clear();
        },
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** 把 bridge 的 IPC 入口适配成 Harness2Api（controller 直接消费；这就是 preload 的真实形状） */
function apiFromBridge(
  bridge: Bridge,
  frameListeners: Array<(f: WsFrame) => void>,
  statusListeners: Array<(s: ConnectionStatus, d?: { error?: string }) => void>,
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
    onConnectionStatus: (listener: (s: ConnectionStatus, d?: { error?: string }) => void) => {
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
  decide?: (input: { tool: string; args: unknown }) => 'allow' | 'deny' | 'ask',
): Promise<{
  bridge: Bridge;
  frames: WsFrame[];
  api: Harness2Api;
  statuses: ConnectionStatus[];
  proxy: { port: number; sever(): void; close(): Promise<void> };
  emitConnected: () => void;
}> {
  const home = tmpDir('h2-fi-home-');
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
  const root = tmpDir('h2-fi-root-');
  const handle = await startServe({ port: 0, home, root, provider, ...(decide !== undefined ? { decide } : {}) });
  handles.push(handle);
  const proxy = await tcpProxy(handle.port);

  const frames: WsFrame[] = [];
  const statuses: ConnectionStatus[] = [];
  const frameListeners: Array<(f: WsFrame) => void> = [];
  const statusListeners: Array<(s: ConnectionStatus, d?: { error?: string }) => void> = [];
  const deps: BridgeDeps = {
    // 故障注入点：bridge 只看到代理端口；sever() 后 bridge 的 WS 异常断开 → 1s 自动重连
    serve: {
      baseUrl: `http://127.0.0.1:${proxy.port}`,
      wsUrl: `ws://127.0.0.1:${proxy.port}/ws`,
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
    sendStatus: (s, d) => {
      statuses.push(s);
      for (const l of [...statusListeners]) l(s, d);
    },
  };
  const bridge = createBridge(deps);
  bridge.connectWs();
  return {
    bridge,
    frames,
    statuses,
    proxy,
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

/** 装配真实帧管线：bridge → controller/store（与真实应用一致） */
function wire(api: Harness2Api): { store: AppStore; controller: ReturnType<typeof createController> } {
  const store = new AppStore();
  const controller = createController(store, api);
  controller.start();
  return { store, controller };
}

describe('PD2 / F7：中途强断 WS（真实 serve + 代理层故障注入）', () => {
  it('断点=流式文本中：turn 在断线窗口内跑完 → 重连快照如实落定（不永久 running），重订阅恢复', async () => {
    const { bridge, frames, api, proxy, emitConnected } = await setup(
      new MockProvider([{ textChunks: ['甲', '乙', '丙', '丁'], chunkDelayMs: 100 }]),
    );
    const cwd = tmpDir('h2-fi-text-');
    const id = await createSession(bridge, cwd);
    const { store, controller } = wire(api);
    emitConnected();
    await controller.selectSession(id);

    void controller.sendMessage(id, '流式一条');
    await waitFor(() => frames.some((f) => f.type === 'text-delta'), '首个 text-delta');
    const resumesBefore = frames.filter((f) => f.type === 'resume-snapshot').length;

    // —— 故障注入：此刻 turn 仍在服务端跑（约 300ms 后自然结束，落在断线窗口内）——
    proxy.sever();
    expect(store.peekStream(id)?.running).toBe(true); // 断线本身不假报停止

    // WS 异常断开 → 渲染端必须被告知（不再挂着「已连接」的假象）
    await waitFor(() => store.getState().status === 'reconnecting', '渲染端得知 reconnecting');
    // bridge 1s 自动重连 → WS open → 渲染端恢复 connected
    await waitFor(() => store.getState().status === 'connected', '重连后恢复 connected');
    // 重连恢复订阅 + 快照（P2-2 resync 依赖 connected 信号）：必须是**新**快照
    await waitFor(
      () => frames.filter((f) => f.type === 'resume-snapshot').length > resumesBefore,
      '重连后的 resume-snapshot',
    );

    // turn 在断线窗口内已跑完：快照无在途 attempt → 必须如实落定（修复前永久 running）
    await waitFor(() => store.peekStream(id)?.running === false, '权威快照落定 running=false');
    // 佐证：服务端确实完成了整个流（末块文本已落账；turn 收尾是投影，无独立日志事件）
    const events = (await api.events(id)) as { events: Array<{ type: string }> };
    const lastText = [...events.events].reverse().find((e) => e.type === 'assistant/message');
    expect(JSON.stringify(lastText)).toContain('丁');
    bridge.disconnectWs();
    await proxy.close();
  }, 45000);

  it('断点=工具执行中：重连后事件流恢复（turn-end 真实到达），运行中不假报停止', async () => {
    const { bridge, frames, api, proxy, emitConnected } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'c-slow', name: 'bash', arguments: JSON.stringify({ command: 'node -e "setTimeout(()=>{},2500)"' }) },
          ],
        },
        { textChunks: ['完成'] },
      ]),
      () => 'allow',
    );
    const cwd = tmpDir('h2-fi-tool-');
    const id = await createSession(bridge, cwd);
    const { store, controller } = wire(api);
    emitConnected();
    await controller.selectSession(id);

    void controller.sendMessage(id, '跑个慢命令');
    // selectSession 的 resume 已把连接升级为 v2：工具调用经落盘事件镜像到达（不再发 v1 delta kind:tool）
    await waitFor(() => frames.some((f) => f.type === 'event' && f.event.type === 'tool/call'), 'tool/call 事件镜像');

    const resumesBefore = frames.filter((f) => f.type === 'resume-snapshot').length;
    // —— 故障注入：工具还在服务端执行（2.5s）——
    proxy.sever();
    expect(store.peekStream(id)?.running).toBe(true);
    await waitFor(() => store.getState().status === 'reconnecting', 'reconnecting');
    await waitFor(() => store.getState().status === 'connected', '重连恢复 connected');
    await waitFor(
      () => frames.filter((f) => f.type === 'resume-snapshot').length > resumesBefore,
      '重连后的 resume-snapshot',
    );
    // 快照带在途 attempt → 仍如实「运行中」（不因断线假报停止）
    expect(store.peekStream(id)?.activeAttempt).toBeDefined();
    expect(store.peekStream(id)?.running).toBe(true);

    // 重连恢复事件流：工具结果 + 第二段回复 + turn-end 都能真实到达
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), '断线后 turn-end 到达');
    expect(store.peekStream(id)?.running).toBe(false);
    bridge.disconnectWs();
    await proxy.close();
    void api;
  }, 45000);

  it('断点=审批等待中：重连后权威快照补齐待批，决定仍可提交并生效（拒绝不执行）', async () => {
    const { bridge, frames, api, proxy, emitConnected } = await setup(
      new MockProvider([
        {
          toolCalls: [
            { id: 'c-ask', name: 'write', arguments: JSON.stringify({ file_path: 'never-fi.txt', content: 'x' }) },
          ],
        },
        { textChunks: ['结束'] },
      ]),
      () => 'ask',
    );
    const cwd = tmpDir('h2-fi-ask-');
    const id = await createSession(bridge, cwd);
    const { store, controller } = wire(api);
    emitConnected();
    await controller.selectSession(id);

    void controller.sendMessage(id, '写个文件');
    await waitFor(() => frames.some((f) => f.type === 'approval-request'), 'approval-request');
    const req = frames.find((f): f is Extract<WsFrame, { type: 'approval-request' }> => f.type === 'approval-request')!;

    const resumesBefore = frames.filter((f) => f.type === 'resume-snapshot').length;
    // —— 故障注入：审批正等待用户决定 ——
    proxy.sever();
    expect(store.peekStream(id)?.running).toBe(true);
    await waitFor(() => store.getState().status === 'reconnecting', 'reconnecting');
    await waitFor(() => store.getState().status === 'connected', '重连恢复 connected');
    await waitFor(
      () => frames.filter((f) => f.type === 'resume-snapshot').length > resumesBefore,
      '重连后的 resume-snapshot',
    );

    // 权威快照补齐：待批仍然在（不因断线丢失审批入口）
    const approvals = store.allApprovals();
    expect(approvals.some((a) => a.requestId === req.requestId)).toBe(true);

    // 重连后决定仍可提交并生效：拒绝 → 工具未执行、turn 收口
    await controller.respondApproval(req.requestId, 'deny');
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), '拒绝后 turn-end');
    expect(existsSync(join(cwd, 'never-fi.txt'))).toBe(false);
    bridge.disconnectWs();
    await proxy.close();
  }, 45000);
});
