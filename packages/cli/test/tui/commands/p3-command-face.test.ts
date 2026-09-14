// P3-② 命令面补口（只加测试文件，零 src 改动）：G-31 / G-50~G-53 / G-54~G-90 的
// 「注册 / 可见 / 执行 / 门控」四态里，P3 五棒已落但**接线级证据**不足的部分：
//
//  1. 8 条 P3-A shellOnly 新命令（session-info/export/timeline/doctor/memory/skills/
//     plugins/mcps）逐条：在 palette 里可见 + 经面板 Enter 真分发链执行 + 有**真实输出**
//     （真实会话日志 / 临时 home+root 夹具），export 另证临时目录真实产物。
//  2. palette **全项执行枚举**（34 = core 29 + 壳 5）：逐项在全新 harness 里走
//     Ctrl+P → 逐行 → Enter 的完整面板路径，断言不落三类断线兜底
//     （「未知命令」/「由界面层实现」/「error:」），并如实登记唯一合法 `error:` 输出
//     （/resume 裸命令的用法提示——用法错误 ≠ 兜底）。
//  3. G-03 模式门控接线级：minimal 基座下 fullscreen 专属命令（/timeline /theme）被拒且
//     文案含指向替代（/fullscreen）；/expand 在 minimal 可用（正向）。
//
// 说明：本文件用 process.chdir 把 cwd 指到临时目录——/export 经面板 Enter（无参）走
// core `defaultExportPath`（= process.cwd()/<sessionId>.zip），chdir 保证产物落临时目录、
// 不脏仓库工作树。vitest 默认 pool=forks（每测试文件独立子进程），chdir 不外溢。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWriter } from '@harness2/core';
import type { SteerResult, TurnResult } from '@harness2/core';
import type { ChatRuntime, ChatSession } from '../../../src/chat-setup.js';
import {
  createApprovalGate,
  createNextChatHarness,
  type ApprovalGate,
  type NextChatHarness,
} from '../../../src/tui/next/next-shell.js';
import { paletteBadge } from '../../../src/tui/commands/palette-model.js';
import type { RenderMode } from '../../../src/tui/render/mode.js';

const CTRL_P = '\x10';
const ENTER = '\r';
const ARROW_DOWN = '\x1b[B';

/** P3-A 批次新命令（catalog shellOnly；即本文件逐条覆盖对象） */
const NEW_SHELL_COMMANDS = [
  'session-info',
  'export',
  'timeline',
  'doctor',
  'memory',
  'skills',
  'plugins',
  'mcps',
] as const;

class FakeOut {
  buffer = '';
  columns = 100;
  rows = 30;
  write(s: string): unknown {
    this.buffer += s;
    return s.length;
  }
}

function result(finalText: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: 0,
    durationMs: 1,
    turnId: 't1',
    textOutcome: 'final',
    finalText,
    ...overrides,
  };
}

// —— 临时资源（会话 fixture / 工作目录 / home / root），afterAll 统一回收 ——

const tempDirs: string[] = [];
const writers: SessionWriter[] = [];
const originalCwd = process.cwd();
let workCwd = '';
let workRoot = '';
let workHome = '';

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSession(
  sessionId = 'p3e-gaps-sess',
  opts: { undoMarker?: boolean } = {},
): { dir: string; writer: SessionWriter; session: ChatSession } {
  const dir = tempDir('hx-p3-cmd-sess-');
  const writer = SessionWriter.create(dir, { sessionId }, { fsync: false });
  writers.push(writer);
  writer.append('user/message', { text: '第一轮问题', turnId: 't1' });
  writer.append('assistant/message', { text: '第一轮回答', model: 'mock', turnId: 't1' });
  if (opts.undoMarker === true) writer.append('rewind/marker', { rewindToSeq: 1, reason: 'undo' });
  return { dir, writer, session: { id: sessionId, dir, writer } };
}

beforeAll(() => {
  workCwd = tempDir('hx-p3-cmd-cwd-');
  process.chdir(workCwd); // /export 无参默认路径锚点（见文件头）
  workRoot = tempDir('hx-p3-cmd-root-');
  workHome = tempDir('hx-p3-cmd-home-');
  // 真实 skill（项目级两层扫描命中）
  mkdirSync(join(workRoot, '.harness2', 'skills'), { recursive: true });
  writeFileSync(
    join(workRoot, '.harness2', 'skills', 'demo.md'),
    '---\nname: demo\ndescription: 演示技能\n---\n正文\n',
    'utf8',
  );
  // 真实 mcpServers（项目 config）；providers/roles 为 schema 必填（与 loadConfig 校验对齐）
  writeFileSync(
    join(workRoot, '.harness2', 'config.json'),
    JSON.stringify({
      providers: { a: { protocol: 'openai', baseUrl: 'https://example.invalid/v1', models: { m: {} } } },
      roles: { main: { channel: 'a', model: 'm' } },
      mcpServers: { demo: { command: 'node', args: ['x.js'] } },
    }),
    'utf8',
  );
  // 真实插件目录（全局根）
  mkdirSync(join(workHome, '.harness2', 'plugins', 'demo'), { recursive: true });
  writeFileSync(
    join(workHome, '.harness2', 'plugins', 'demo', 'manifest.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'utf8',
  );
  // 真实长期记忆（全局根）
  mkdirSync(join(workHome, '.harness2', 'memories'), { recursive: true });
  writeFileSync(join(workHome, '.harness2', 'memories', 'MEMORY.md'), '- 测试记忆条目一\n', 'utf8');
});

afterAll(() => {
  try {
    process.chdir(originalCwd);
  } catch {
    // 原 cwd 不存在（异常）不阻塞收尾
  }
  for (const w of writers) {
    try {
      w.close();
    } catch {
      // 已关闭/句柄异常不阻塞清理
    }
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放延迟（EBUSY 等）不阻塞测试收尾
    }
  }
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// —— harness 装配（真实会话 + 注入 root/home；与 p3e-wiring 同口径） ——

interface Fixture {
  h: NextChatHarness;
  out: FakeOut;
  gate: ApprovalGate;
  runtime: ChatRuntime;
}

function makeRuntime(session: ChatSession | null): ChatRuntime {
  const steerObservers = new Set<(r: SteerResult) => void>();
  const runtime: ChatRuntime = {
    provider: { name: 'mock' } as ChatRuntime['provider'],
    approval: undefined,
    tools: {} as ChatRuntime['tools'],
    skillsStore: {} as ChatRuntime['skillsStore'],
    sessionManager: {
      list: () => [],
      locate: () => undefined,
      search: () => [],
      // P7 加性：palette 全项枚举执行 /reindex /title（core 会话能力命令）——stub 提供最小实现
      reindex: () => ({ sessions: 0, indexed: 0, messages: 0, failures: [] }),
      searchIndexed: () => [],
      titleOf: () => null,
    } as unknown as ChatRuntime['sessionManager'],
    root: workRoot,
    getCurrent: () => session,
    switchSession: () => undefined,
    fork: () => undefined,
    runUserTurn: async (text: string) => result(`收到：${text}`),
    abortTurn: () => undefined,
    closeCurrent: () => undefined,
    clearAlwaysAllowed: () => undefined,
    mode: () => 'default',
    setMode: (m) => m,
    reasoning: () => false,
    setReasoning: (on) => on,
    noteCrash: () => undefined,
    submitSteer: () => ({ state: 'unknown', reason: '测试 stub', draftKept: true, message: 'stub' }),
    currentTurnId: () => undefined,
    observeSteer: (fn) => {
      steerObservers.add(fn);
      return () => {
        steerObservers.delete(fn);
      };
    },
    finish: async () => undefined,
  };
  return runtime;
}

function makeHarness(session: ChatSession | null, opts: { initialRenderMode?: RenderMode } = {}): Fixture {
  const out = new FakeOut();
  const gate = createApprovalGate();
  const runtime = makeRuntime(session);
  const h = createNextChatHarness(runtime, {
    out,
    bootLines: [],
    env: {},
    gate,
    home: workHome,
    ...(opts.initialRenderMode !== undefined ? { initialRenderMode: opts.initialRenderMode } : {}),
    exit: () => undefined,
  });
  return { h, out, gate, runtime };
}

async function settle(h: NextChatHarness, ms = 80): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  h.flushUi();
}

function paletteNames(h: NextChatHarness): string[] {
  return (h.state.palette?.rows ?? []).flatMap((r) => (r.kind === 'command' ? [r.entry.name] : []));
}

/** 打开面板 → 逐行导航到目标 → Enter（面板完整路径；返回执行后的逻辑行快照） */
async function runViaPalette(h: NextChatHarness, name: string): Promise<string[]> {
  h.feed(CTRL_P);
  const rows = h.state.palette?.rows ?? [];
  const idx = rows.findIndex((r) => r.kind === 'command' && r.entry.name === name);
  expect(idx, `面板缺条目 /${name}`).toBeGreaterThanOrEqual(0);
  const pos = rows.slice(0, idx + 1).filter((r) => r.kind === 'command').length - 1;
  for (let i = 0; i < pos; i += 1) h.feed(ARROW_DOWN);
  h.feed(ENTER);
  await settle(h);
  return h.logicalLines();
}

/** 单条命令：真实会话 + 面板执行 → 返回转录文本 */
async function outputsOf(name: string, sessionOpts: { undoMarker?: boolean } = {}): Promise<string> {
  const { session } = makeSession('p3e-gaps-sess', sessionOpts);
  const { h } = makeHarness(session);
  const lines = await runViaPalette(h, name);
  h.dispose();
  return lines.join('\n');
}

// ─── 1. 新命令逐条：palette 可见 + 执行有真实输出 ────────────────────────────

describe('P3-A 新命令（shellOnly 八条）经 palette 执行有真实输出', () => {
  it('可见性：八条全部在 palette 条目里（core describeCapabilities 单源）', () => {
    const { session } = makeSession();
    const { h } = makeHarness(session);
    h.feed(CTRL_P);
    const names = paletteNames(h);
    for (const name of NEW_SHELL_COMMANDS) expect(names).toContain(name);
    h.dispose();
  });

  it('/session-info（G-59）：读真实会话日志输出 id/事件/消息统计', async () => {
    const all = await outputsOf('session-info');
    expect(all).toContain('会话 ID: p3e-gaps-sess');
    expect(all).toContain('事件: 3 条（活动 3，遮蔽 0）');
    expect(all).toContain('消息: 2 条');
  });

  it('/export（G-63）：palette Enter 无参 → 落 process.cwd()/<sessionId>.zip 真实产物', async () => {
    const { session } = makeSession('p3e-gaps-sess');
    const { h } = makeHarness(session);
    const zipPath = join(workCwd, 'p3e-gaps-sess.zip');
    rmSync(zipPath, { force: true });
    const lines = await runViaPalette(h, 'export');
    const all = lines.join('\n');
    expect(all).toContain('已导出 p3e-gaps-sess →');
    expect(existsSync(zipPath)).toBe(true);
    expect(statSync(zipPath).size).toBeGreaterThan(0);
    h.dispose();
    rmSync(zipPath, { force: true });
  });

  it('/timeline（G-03 仅 fullscreen）：读真实会话输出轨迹时间线', async () => {
    const all = await outputsOf('timeline');
    expect(all).toContain('# session p3e-gaps-sess');
    expect(all).toContain('── turn t1');
    expect(all).toContain('[USER] 第一轮问题');
    expect(all).toContain('[ASSISTANT] [mock] 第一轮回答');
  });

  it('/doctor（G-85）：环境自检分节报告', async () => {
    const all = await outputsOf('doctor');
    expect(all).toContain('harness2 doctor（');
    expect(all).toMatch(/\[(OK|WARN|FAIL)\]/);
    expect(all).toContain('结果：');
  });

  it('/memory（G-77）：读真实 MEMORY.md 条目与用量', async () => {
    const all = await outputsOf('memory');
    expect(all).toContain('MEMORY.md（1 条');
    expect(all).toContain('测试记忆条目一');
  });

  it('/skills（G-78）：两级扫描命中真实项目级 skill', async () => {
    const all = await outputsOf('skills');
    expect(all).toContain('demo  [project]  演示技能');
  });

  it('/plugins（G-78）：扫描真实插件目录并给装载审批状态', async () => {
    const all = await outputsOf('plugins');
    expect(all).toContain('demo  v1.0.0');
    expect(all).toContain('未批准');
  });

  it('/mcps（G-88）：读真实 mcpServers 配置（只读，不探测）', async () => {
    const all = await outputsOf('mcps');
    expect(all).toContain('demo  [stdio] node x.js');
  });
});

// ─── 2. palette 全项执行枚举（34 项） ────────────────────────────────────────

describe('P3-A palette 全项执行枚举（无断线兜底）', () => {
  it('34 = core 29 + 壳 5；逐项全新 harness 走完整面板路径，无「未知命令」/「由界面层实现」/「error:」兜底', async () => {
    // 先取条目清单（不执行）——顺序 = core catalog 序 + 壳条目序
    const probe = makeHarness(makeSession().session);
    probe.h.feed(CTRL_P);
    const names = paletteNames(probe.h);
    probe.h.dispose();
    expect(names).toHaveLength(34);
    expect(names).toEqual(
      expect.arrayContaining([...NEW_SHELL_COMMANDS, 'plan', 'auto', 'always-approve', 'theme', 'search', 'expand']),
    );

    const fallbackHits: string[] = [];
    for (const name of names) {
      // redo 需要日志里已有一条 undo 标记才能重做（否则 core 如实报「没有可重做的撤销」）
      const { session } = makeSession('p3e-gaps-sess', { undoMarker: name === 'redo' });
      const { h } = makeHarness(session);
      const all = (await runViaPalette(h, name)).join('\n');
      // 分发证据：常规命令 = 面板 Enter 经 handleUserText 的回显行；/undo /redo 执行后
      // 走 rewind 语义**重投影**（转录整体从磁盘重建，回显行被替换掉）——以真实命令输出
      // （已撤回/已重做）作为分发链证据。
      const dispatched =
        all.includes(`> /${name}`) ||
        (name === 'undo' && all.includes('已撤回')) ||
        (name === 'redo' && all.includes('已重做'));
      expect(dispatched, `/${name} 未经面板分发链（无回显亦无命令输出）`).toBe(true);
      if (all.includes('未知命令')) fallbackHits.push(`${name}: 未知命令`);
      if (all.includes('由界面层实现')) fallbackHits.push(`${name}: 由界面层实现`);
      const errorLines = all
        .split('\n')
        .filter((l) => l.trimStart().startsWith('error:'))
        .join(' | ');
      if (errorLines.length > 0) {
        if (name === 'resume') {
          // /resume 裸命令（面板 Enter 不带参数）= 用法错误，属**合法**输出，不是兜底
          expect(errorLines).toContain('用法 /resume <id>');
        } else if (name === 'import') {
          // P7 /import 裸命令（面板 Enter 不带 zip 参数）= 用法错误，属**合法**输出，不是兜底
          expect(errorLines).toContain('用法 /import <zip 路径>');
        } else {
          fallbackHits.push(`${name}: ${errorLines}`);
        }
      }
      // G-03 门控（fullscreen 下 /expand）是设计内拒绝，不是兜底——显式钉住其文案
      if (name === 'expand') {
        expect(all).toContain('不可用：/expand（仅 minimal 模式提供；运行 /minimal 切换本会话）');
      }
      h.dispose();
    }
    expect(fallbackHits, `发现兜底：\n${fallbackHits.join('\n')}`).toEqual([]);
  });
});

// ─── 3. G-03 模式门控（minimal 基座）接线级 ──────────────────────────────────

describe('G-03 模式门控接线级（minimal 基座）', () => {
  it('minimal 下 fullscreen 专属命令打「仅 fullscreen」badge；执行被拒且文案指向 /fullscreen', async () => {
    const { session } = makeSession();
    const { h } = makeHarness(session, { initialRenderMode: 'minimal' });
    h.feed(CTRL_P);
    const rows = h.state.palette?.rows ?? [];
    for (const name of ['timeline', 'theme']) {
      const row = rows.find((r) => r.kind === 'command' && r.entry.name === name);
      expect(row, `面板缺条目 /${name}`).toBeDefined();
      if (row?.kind === 'command') expect(paletteBadge(row.entry)).toBe('仅 fullscreen');
    }
    h.dispose();

    for (const name of ['timeline', 'theme']) {
      const { session: s2 } = makeSession();
      const { h: h2 } = makeHarness(s2, { initialRenderMode: 'minimal' });
      const all = (await runViaPalette(h2, name)).join('\n');
      expect(all, `/${name} 未按 minimal 门控拒绝`).toContain(
        `当前渲染模式（minimal）下不可用：/${name}（仅 fullscreen 模式提供；运行 /fullscreen 切换本会话）`,
      );
      h2.dispose();
    }
  });

  it('minimal 下 /expand 可用（正向）：执行真实动作并回显', async () => {
    const { session } = makeSession();
    const { h } = makeHarness(session, { initialRenderMode: 'minimal' });
    const all = (await runViaPalette(h, 'expand')).join('\n');
    expect(all).toContain('已重新输出完整转录到原生滚动区（/expand）');
    expect(all).not.toContain('不可用');
    h.dispose();
  });
});
