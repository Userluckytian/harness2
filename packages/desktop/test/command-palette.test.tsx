// B6 命令面板测试：过滤/导航纯函数（filterCommands / filterSessions / stepSelection）+
// 组件键盘导航（↑↓ 移动、Enter 执行 run、Esc 关闭）、会话跳转模式 + App 集成（Ctrl+K 唤出
// 且命令列表包含计划要求的全部命令）。
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  CommandPalette,
  filterCommands,
  filterSessions,
  JUMP_TO_SESSION_ID,
  stepSelection,
  type PaletteCommand,
  type PaletteSession,
} from '../src/renderer/components/CommandPalette.js';
import { cycleTheme, moveSession } from '../src/renderer/App.js';

/* —— 过滤纯函数 —— */

const CMD: PaletteCommand[] = [
  { id: 'newSession', label: '新建会话', hint: 'Ctrl+N', run: () => {} },
  { id: 'openSettings', label: '打开设置', hint: 'Ctrl+,', run: () => {} },
  { id: 'setPanes2', label: '切换为双栏（2 栏）', run: () => {} },
];

describe('filterCommands', () => {
  it('空查询 → 全量（不改变顺序）', () => {
    expect(filterCommands(CMD, '')).toEqual(CMD);
    expect(filterCommands(CMD, '   ')).toEqual(CMD);
  });

  it('按 label 大小写不敏感子串过滤', () => {
    expect(filterCommands(CMD, '新建').map((c) => c.id)).toEqual(['newSession']);
    expect(filterCommands(CMD, '设置').map((c) => c.id)).toEqual(['openSettings']);
  });

  it('仅命中 hint 的也返回，且排在 label 命中之后', () => {
    const res = filterCommands(CMD, 'ctrl');
    expect(res.map((c) => c.id)).toEqual(['newSession', 'openSettings']); // label 命中在前
    const hintOnly = filterCommands(CMD, '2 栏');
    expect(hintOnly.map((c) => c.id)).toEqual(['setPanes2']);
  });

  it('无匹配 → 空数组', () => {
    expect(filterCommands(CMD, '不存在')).toEqual([]);
  });
});

describe('filterSessions', () => {
  const S: PaletteSession[] = [
    { id: 's1', label: '第一句' },
    { id: 's2', label: '重构' },
  ];
  it('空查询 → 全量', () => {
    expect(filterSessions(S, '')).toEqual(S);
  });
  it('按标题过滤', () => {
    expect(filterSessions(S, '重构').map((s) => s.id)).toEqual(['s2']);
  });
  it('无匹配 → 空数组', () => {
    expect(filterSessions(S, 'xyz')).toEqual([]);
  });
});

describe('stepSelection', () => {
  it('上下移动回绕', () => {
    expect(stepSelection(0, 1, 3)).toBe(1);
    expect(stepSelection(2, 1, 3)).toBe(0); // 到底回开头
    expect(stepSelection(0, -1, 3)).toBe(2); // 到顶回末尾
  });
  it('空/单条边界', () => {
    expect(stepSelection(0, 1, 0)).toBe(-1);
    expect(stepSelection(0, 1, 1)).toBe(0);
  });
});

/* —— App 层纯辅助：主题循环 / 会话移动 —— */

describe('cycleTheme', () => {
  it('warmPaper → dark → system → warmPaper', () => {
    expect(cycleTheme('warmPaper')).toBe('dark');
    expect(cycleTheme('dark')).toBe('system');
    expect(cycleTheme('system')).toBe('warmPaper');
  });
});

describe('moveSession', () => {
  it('空会话列表 → null', () => {
    const state = {
      sessions: [],
      metadata: {},
      selectedId: null,
    } as unknown as Parameters<typeof moveSession>[0];
    expect(moveSession(state, 1)).toBeNull();
  });

  it('从首会话向后移动取到下一会话（按 mtime 降序）', () => {
    const state = {
      sessions: [
        { id: 'a', mtimeMs: 3 },
        { id: 'b', mtimeMs: 2 },
        { id: 'c', mtimeMs: 1 },
      ],
      metadata: {},
      selectedId: 'a',
    } as unknown as Parameters<typeof moveSession>[0];
    expect(moveSession(state, 1)).toBe('b');
    expect(moveSession(state, -1)).toBe('c'); // 首会话前移回绕到末尾
  });

  it('跳过已归档会话', () => {
    const state = {
      sessions: [
        { id: 'a', mtimeMs: 3, firstUserText: 'a' },
        { id: 'b', mtimeMs: 2, firstUserText: 'b' },
      ],
      metadata: { b: { archived: true } },
      selectedId: 'a',
    } as unknown as Parameters<typeof moveSession>[0];
    expect(moveSession(state, 1)).toBe('a'); // 无其它可选，回绕到自身
  });
});

/* —— 组件：键盘导航 / Esc / Enter / 遮罩点击 —— */

const MOCK_CMDS: PaletteCommand[] = [
  { id: 'newSession', label: '新建会话', run: vi.fn() },
  { id: 'openSettings', label: '打开设置', run: vi.fn() },
  { id: 'setPanes2', label: '切换为双栏（2 栏）', run: vi.fn() },
];
const MOCK_SESSIONS: PaletteSession[] = [
  { id: 's1', label: '第一句' },
  { id: 's2', label: '重构' },
];

function renderPalette(overrides?: { open?: boolean; onClose?: () => void; onSelectSession?: (id: string) => void }) {
  const onClose = vi.fn();
  const onSelectSession = vi.fn();
  const utils = render(
    <CommandPalette
      open={overrides?.open ?? true}
      onClose={overrides?.onClose ?? onClose}
      commands={MOCK_CMDS}
      sessions={MOCK_SESSIONS}
      onSelectSession={overrides?.onSelectSession ?? onSelectSession}
    />,
  );
  return { onClose, onSelectSession, ...utils };
}

describe('CommandPalette 组件', () => {
  beforeEach(() => {
    cleanup();
  });

  it('open=false 时不渲染', () => {
    const { container } = renderPalette({ open: false });
    expect(container.querySelector('.command-palette')).toBeNull();
  });

  it('open=true 渲染命令列表；↑↓ 移动高亮（回绕）；Enter 执行当前命令 run 并 onClose', () => {
    const { onClose } = renderPalette();
    const input = screen.getByPlaceholderText('输入命令…');
    const items = () => screen.getAllByRole('option');

    // 默认选中第 0 项
    expect(items()[0]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 移到第 1 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[1]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 再移回绕到第 2 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[2]!.getAttribute('aria-selected')).toBe('true');

    // ↑ 移到第 1 项（非回绕）
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(items()[1]!.getAttribute('aria-selected')).toBe('true');

    // ↓ 回绕：第 2 项再 ↓ → 回到第 0 项
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[2]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items()[0]!.getAttribute('aria-selected')).toBe('true');

    // Enter 执行第 0 项 run + onClose
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(MOCK_CMDS[0]!.run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭（onClose 触发）', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击关闭（点面板内部不关闭）', () => {
    const { onClose } = renderPalette();
    const overlay = document.querySelector('.command-palette-overlay')!;
    fireEvent.mouseDown(overlay); // e.target === currentTarget → onClose
    expect(onClose).toHaveBeenCalledTimes(1);

    const panel = document.querySelector('.command-palette')!;
    fireEvent.mouseDown(panel); // stopPropagation → 不关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('输入过滤实时生效；无匹配显示空态', () => {
    renderPalette();
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '设置' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('打开设置');

    fireEvent.change(input, { target: { value: '根本不存在的命令' } });
    expect(screen.getByText('无匹配项')).toBeTruthy();
  });

  it('跳转会话：选中该命令 Enter → 会话态按标题过滤；再 Enter 触发 onSelectSession 并 onClose', () => {
    const cmds: PaletteCommand[] = [
      { id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: vi.fn() },
      { id: 'newSession', label: '新建会话', run: vi.fn() },
    ];
    const onClose = vi.fn();
    const onSelectSession = vi.fn();
    render(
      <CommandPalette
        open
        commands={cmds}
        sessions={MOCK_SESSIONS}
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;

    // 选中跳转命令并执行 → 进入会话态
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByPlaceholderText('搜索会话…')).toBeTruthy();

    // 会话态过滤
    fireEvent.change(input, { target: { value: '重构' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('重构');

    // Enter 选中该会话
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectSession).toHaveBeenCalledWith('s2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('会话态按 Esc 先回命令态，再按一次才关闭', () => {
    const cmds: PaletteCommand[] = [{ id: JUMP_TO_SESSION_ID, label: '跳转到会话…', run: vi.fn() }];
    const onClose = vi.fn();
    render(
      <CommandPalette open commands={cmds} sessions={MOCK_SESSIONS} onClose={onClose} onSelectSession={vi.fn()} />,
    );
    const input = screen.getByPlaceholderText('输入命令…') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' }); // 进入会话态
    expect(screen.getByPlaceholderText('搜索会话…')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' }); // 回命令态
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('输入命令…')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' }); // 关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/* —— App 集成：Ctrl+K 唤出 + 命令清单完整性 —— */

// 复用 app.test.tsx 的假 api 搭建最小 App（保证命令一次性渲染足够多）
let seq = 0;
function ev(type: string, payload: Record<string, unknown>): any {
  seq += 1;
  return { v: 1, seq, ts: '2026-09-06T00:00:00Z', type, payload, active: true };
}

function makeFakeApi(): any {
  const replay = {
    id: 's1',
    dir: 'd',
    header: { sessionId: 's1' },
    events: [
      ev('session/header', { sessionId: 's1' }),
      ev('user/message', { text: '第一句', turnId: 't1' }),
      ev('assistant/message', { text: '回复', model: 'mock/m', turnId: 't1' }),
    ],
    warnings: [],
    lastSeq: 3,
  };
  return {
    listSessions: vi.fn(async () => [
      { id: 's1', dir: 'd', mtimeMs: 10, firstUserText: '第一句', messageCount: 2, lastSeq: 3 },
      { id: 's2', dir: 'd', mtimeMs: 5, firstUserText: '重构', messageCount: 1, lastSeq: 1 },
    ]),
    createSession: vi.fn(async () => ({ id: 's3' })),
    events: vi.fn(async (id: string) => ({ ...replay, id, lastSeq: 0, events: [] })),
    undo: vi.fn(async () => ({ results: [] })),
    redo: vi.fn(async () => ({ results: [] })),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    respondApproval: vi.fn(async () => undefined),
    loadLayout: vi.fn(async () => undefined),
    saveLayout: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ status: 'connected' })),
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
    settingsGetPreferences: vi.fn(async () => ({
      theme: 'warmPaper',
      defaultPaneCount: 1,
      showWelcome: true,
      notifyDetails: 'minimal',
    })),
    settingsSetPreferences: vi.fn(async (p: unknown) => p),
    settingsGetDoctorReport: vi.fn(async () => ({ checks: [], exitCode: 0 })),
    settingsGetCrashReports: vi.fn(async () => []),
    gitBranch: vi.fn(async () => 'main'),
    getContextUsage: vi.fn(async () => ({ usage: 0.5, label: '50%' })),
    getSnapshotForCall: vi.fn(async () => ({ ok: false, error: '未找到对应快照' })),
    readFileForRef: vi.fn(async () => ({ ok: false, error: '未找到' })),
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
    onEvent: vi.fn(() => () => {}),
    onConnectionStatus: vi.fn((cb: (s: string) => void) => {
      queueMicrotask(() => cb('connected'));
      return () => {};
    }),
  };
}

async function bootApp(api: any): Promise<{ App: () => React.ReactNode }> {
  vi.resetModules();
  (window as unknown as { harness2: unknown }).harness2 = api;
  return import('../src/renderer/App');
}

describe('App 集成：Ctrl+K 命令面板 + 命令清单完整性', () => {
  beforeEach(() => {
    cleanup();
    seq = 0;
  });

  it('Ctrl+K 唤出命令面板；命令清单包含计划要求的命令', async () => {
    const App = await bootApp(makeFakeApi());
    render(<App.App />);

    // Ctrl+K 唤出
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByPlaceholderText('输入命令…')).toBeTruthy();

    // 命令清单完整性（计划 Task 6 的 4 条 + 委派扩展命令）
    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((t) => t.includes('新建会话'))).toBe(true);
    expect(labels.some((t) => t.includes('打开设置'))).toBe(true);
    expect(labels.some((t) => t.includes('跳转到会话'))).toBe(true);
    // 分栏数 1/2/3
    expect(labels.some((t) => t.includes('单栏'))).toBe(true);
    expect(labels.some((t) => t.includes('双栏'))).toBe(true);
    expect(labels.some((t) => t.includes('三栏'))).toBe(true);
    // 上下会话 / 归档 / 主题 / 搜索 / 帮助
    expect(labels.some((t) => t.includes('下一个会话'))).toBe(true);
    expect(labels.some((t) => t.includes('上一个会话'))).toBe(true);
    expect(labels.some((t) => t.includes('归档当前会话'))).toBe(true);
    expect(labels.some((t) => t.includes('切换主题'))).toBe(true);
    expect(labels.some((t) => t.includes('搜索会话'))).toBe(true);
    expect(labels.some((t) => t.includes('帮助 / 快捷键'))).toBe(true);

    // Esc 关闭
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令…'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText('输入命令…')).toBeNull());
  });
});
