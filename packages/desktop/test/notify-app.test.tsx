// @vitest-environment jsdom
// B7 渲染端触发通知集成测试（jsdom）：
//  - turn-end + 窗口非聚焦 + 会话不可见 → api.notify
//  - 窗口聚焦 → 不弹（核心红线）
//  - 精选（notifyDetails=minimal）只带标题、正文空；完整（full）带 80 字摘要
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Harness2Api, SessionEventsPayloadShape, WsFrame } from '../src/shared/protocol.js';

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): any {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-06T00:00:00Z', type, payload, active: true };
}

function replayWithReply(sid: string, reply: string): SessionEventsPayloadShape {
  return {
    id: sid,
    dir: 'd',
    header: { sessionId: sid },
    events: [
      ev('session/header', { sessionId: sid }),
      ev('user/message', { text: '第一句', turnId: 't1' }),
      ev('assistant/message', { text: reply, reasoning: '想', model: 'mock/m', turnId: 't1' }),
      ev('assistant/message', { text: reply, reasoning: '想', model: 'mock/m', turnId: 't1' }), // 重复：验证取最后一条
    ],
    warnings: [],
    lastSeq: 3,
  };
}

function makeFakeApi(notifyDetails: 'minimal' | 'full' = 'minimal') {
  const eventListeners: Array<(f: WsFrame) => void> = [];
  const replay = replayWithReply('s1', '第一句回复');
  const api: Harness2Api & { emit: (f: WsFrame) => void } = {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
      { id: 's2', dir: 'd2', mtimeMs: 9, firstUserText: '后台会话', messageCount: 0, lastSeq: 0 },
    ]),
    createSession: vi.fn(async () => ({ id: 's3' })),
    events: vi.fn(async (id: string) => (id === 's1' ? replay : { ...replay, id, lastSeq: 0, events: [] })),
    undo: vi.fn(async () => ({ results: [] })),
    redo: vi.fn(async () => ({ results: [] })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    loadLayout: vi.fn(async () => undefined),
    saveLayout: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ status: 'connected' as const })),
    settingsGetConfig: vi.fn(async () => ({
      providers: {},
      roles: {},
      approval: { mode: 'default' },
      memory: { mode: 'off', nudgeInterval: 10 },
      browser: { enabled: true, idleDestroyMs: 300_000, maxConcurrent: 2 },
      plugins: { enabled: true, allow: [] },
      mcpServers: {},
      subagent: { maxDepth: 1, maxTurns: 25 },
      sources: { global: true, project: false },
      warnings: [],
      errors: [],
    })),
    settingsUpdateConfig: vi.fn(async () => ({ ok: true })),
    settingsGetAuthMasked: vi.fn(async () => ({ channels: [], gateways: [] })),
    settingsUpdateAuth: vi.fn(async () => ({ ok: true })),
    settingsGetPreferences: vi.fn(async () => ({ theme: 'warmPaper', notifyDetails }) as never),
    settingsSetPreferences: vi.fn(async (p: unknown) => p as never),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 as const })),
    settingsGetCrashReports: vi.fn(async () => []),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: 'x' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: 'x' })),
    listDir: vi.fn(async () => ({ ok: true as const, path: '', entries: [], truncated: false })),
    runConfig: vi.fn(async () => ({ redacted: true }) as never),
    planState: vi.fn(async () => null),
    executionViews: vi.fn(async () => []),
    changeReview: vi.fn(async () => ({ readOnly: true }) as never),
    fork: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ probedAt: '', entries: [] })),
    setBusy: vi.fn(async () => undefined),
    onStopAll: vi.fn(() => () => {}),
    notify: vi.fn(async () => undefined),
    metadataGet: vi.fn(async () => ({})),
    draftsGet: vi.fn(async () => ({})),
    draftsSet: vi.fn(async (d: Record<string, string>) => d),
    metadataSet: vi.fn(async () => ({})),
    onEvent: vi.fn((cb: (f: WsFrame) => void) => {
      eventListeners.push(cb);
      return () => {};
    }),
    onConnectionStatus: vi.fn(
      (cb: (s: 'connected' | 'connecting' | 'reconnecting' | 'offline', d?: unknown) => void) => {
        queueMicrotask(() => cb('connected'));
        return () => {};
      },
    ),
    emit: (f: WsFrame): void => {
      for (const cb of eventListeners) cb(f);
    },
  };
  return api;
}

async function bootApp(api: Harness2Api): Promise<Record<string, unknown>> {
  vi.resetModules();
  (window as unknown as { harness2: Harness2Api }).harness2 = api;
  return import('../src/renderer/App');
}

// jsdom 默认 document.hasFocus() 为 false（窗口未聚焦），贴合「非前台」。
// 每个用例用 vi.spyOn 精确控制。真实 jsdom 默认已 false，故前台用例需显式 true。
describe('B7 渲染端系统通知', () => {
  beforeEach(() => {
    cleanup();
    seq = 0;
    vi.restoreAllMocks();
  });

  it('非前台（hasFocus=false）+ 后台会话 turn-end → 弹通知', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const api = makeFakeApi('full');
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    // 选中 s1；对后台 s2 发 turn-end
    api.emit({ type: 'event', sessionId: 's2', event: ev('user/message', { text: 'hi', turnId: 't' }) });
    api.emit({
      type: 'event',
      sessionId: 's2',
      event: ev('assistant/message', { text: '后台助手回复' + '长'.repeat(200), turnId: 't' }),
    });
    api.emit({ type: 'turn-end', sessionId: 's2', stopReason: 'end_turn' });
    await waitFor(() => expect(api.notify).toHaveBeenCalledTimes(1));
    const [title, body, sid] = vi.mocked(api.notify).mock.calls[0]!;
    expect(title).toBe('后台会话'); // 覆层标题 → firstUserText
    expect(sid).toBe('s2');
    expect(body).toContain('后台助手回复'); // full 级别带摘要
    expect(body.length).toBeLessThanOrEqual(80);
  });

  it('前台聚焦（hasFocus=true）→ 不弹（核心红线）', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const api = makeFakeApi('full');
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    api.emit({ type: 'event', sessionId: 's2', event: ev('assistant/message', { text: '前台回复', turnId: 't' }) });
    api.emit({ type: 'turn-end', sessionId: 's2', stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 60));
    expect(api.notify).not.toHaveBeenCalled();
  });

  it('完整级别（full）带摘要；精选级别（minimal）只标题、正文空', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const api = makeFakeApi('minimal');
    const App = (await bootApp(api)) as { App: () => React.ReactNode };
    render(<App.App />);
    api.emit({ type: 'event', sessionId: 's2', event: ev('assistant/message', { text: '精简回复', turnId: 't' }) });
    api.emit({ type: 'turn-end', sessionId: 's2', stopReason: 'end_turn' });
    await waitFor(() => expect(api.notify).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.notify).mock.calls[0]!;
    expect(body).toBe(''); // minimal：仅标题
  });
});
