// T5 ink 命令委托单测：runSharedCommand 用 ChatRuntime 构建真实 CommandContext，
// 覆盖 /undo（错误路径仍触发 rewind 重投影）、/new（会话切换触发重投影）、/help、未知命令、/exit。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELP_TEXT } from '../../src/commands.js';
import { runSharedCommand, type InkCommandIo } from '../../src/tui/ink-commands.js';
import { createTestRuntime, type TestRuntime } from './shell-runtime.js';

const running: TestRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.cleanup();
});

function makeIo(): {
  io: InkCommandIo;
  lines: string[];
  reproject: ReturnType<typeof vi.fn>;
  requestExit: ReturnType<typeof vi.fn>;
} {
  const lines: string[] = [];
  const reproject = vi.fn(() => undefined);
  const requestExit = vi.fn(() => undefined);
  return {
    io: { print: (t: string) => lines.push(t), reproject, requestExit },
    lines,
    reproject,
    requestExit,
  };
}

describe('T5 runSharedCommand：委托共享 handleCommand', () => {
  it('/undo 错误路径（无可撤）仍触发重投影，且输出为共享错误文案', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { io, lines, reproject } = makeIo();
    const r = runSharedCommand({ name: '/undo', rest: '' }, tr.runtime, io);
    expect(r.reprojected).toBe(true);
    expect(reproject).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('没有可撤回的用户消息'))).toBe(true);
  });

  it('/new 切换会话 id → 触发重投影（替换而非叠加）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const before = tr.runtime.getCurrent()?.id;
    const { io, reproject } = makeIo();
    const r = runSharedCommand({ name: '/new', rest: '' }, tr.runtime, io);
    expect(tr.runtime.getCurrent()?.id).not.toBe(before);
    expect(r.reprojected).toBe(true);
    expect(reproject).toHaveBeenCalledTimes(1);
  });

  it('/help 输出与 legacy 同源 HELP_TEXT；不触发重投影', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { io, lines } = makeIo();
    const r = runSharedCommand({ name: '/help', rest: '' }, tr.runtime, io);
    expect(r.reprojected).toBe(false);
    expect(lines.join('\n')).toBe(HELP_TEXT);
    expect(lines.join('\n')).toContain('/undo');
    expect(lines.join('\n')).toContain('/redo');
  });

  it('未知命令 → 共享「未知命令」文案（不是 ink 的旧「未实现」）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { io, lines, reproject } = makeIo();
    runSharedCommand({ name: '/nope', rest: '' }, tr.runtime, io);
    expect(lines.some((l) => l.includes('未知命令 /nope'))).toBe(true);
    expect(reproject).not.toHaveBeenCalled();
  });

  it('/exit 经 requestExit 钩子（幂等退出路径由上层负责）', async () => {
    const tr = await createTestRuntime();
    running.push(tr);
    const { io, requestExit } = makeIo();
    runSharedCommand({ name: '/exit', rest: '' }, tr.runtime, io);
    expect(requestExit).toHaveBeenCalledTimes(1);
  });
});
