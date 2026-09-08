// S1：每 session 真实 cwd（session-cwd）。
// 审计基线：sessions.ts:384-394 runOne 用 this.options.cwd（hub 全局）作为工具执行 cwd；
//           456-465 buildTurnTools 传全局 cwd——A/B 两个会话的 root 会串。
// 目标语义：创建/恢复会话都从 session header 取真实 cwd，A/B 各自根目录执行工具，互不串。
// 用本地临时目录 + MockProvider（不上传用户数据）。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { loadSession } from '../src/session/reader.js';
import { registerBuiltinTools } from '../src/tools/predefined/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { SessionHub, type SessionHubHooks } from '../src/server/sessions.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-cwd-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 记录工具执行 cwd 的探针工具（output = ctx.cwd，供「确用本会话 root」断言） */
function cwdProbe(log: Array<{ callId: string; cwd: string }>): ToolDefinition {
  return {
    name: 'cwd_probe',
    description: 'test tool: echo ctx.cwd',
    parameters: { type: 'object', properties: {} },
    execute: (_args, ctx) => {
      log.push({ callId: 'probe', cwd: ctx.cwd });
      return { output: ctx.cwd };
    },
  };
}

function toolResultOutputs(dir: string): Array<{ callId: string; tool?: string; ok: boolean; output?: string; error?: string }> {
  const session = loadSession(dir);
  return session.events
    .filter(({ event }) => event.type === 'tool/result')
    .map(({ event }) => event.payload as { callId: string; tool?: string; ok: boolean; output?: string; error?: string });
}

describe('SessionHub 每会话真实 cwd（A/B 不串）', () => {
  it('新建会话：write 相对路径落在各自 session cwd（不落 hub 全局 cwd），A/B 不串', async () => {
    const root = tmpDir();
    const projectA = join(root, 'projectA');
    const projectB = join(root, 'projectB');
    mkdirSync(projectA);
    mkdirSync(projectB);
    const manager = new SessionManager(join(root, 'sessions'));
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const script: MockScript = [
      // A 的 turn：step1 调 write（A），step2 收尾文本
      { toolCalls: [{ id: 'a1', name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: 'A' }) }] },
      { text: 'A written' },
      // B 的 turn：step1 调 write（B），step2 调 read（读回自己的 note.txt），step3 收尾文本
      { toolCalls: [{ id: 'b1', name: 'write', arguments: JSON.stringify({ file_path: 'note.txt', content: 'B' }) }] },
      { toolCalls: [{ id: 'b2', name: 'read', arguments: JSON.stringify({ file_path: 'note.txt' }) }] },
      { text: 'B read' },
    ];
    const hub = new SessionHub({ manager, provider: new MockProvider(script), tools, cwd: root });
    const turnEnds: Array<{ id: string; stopReason: string }> = [];
    hub.addHooks({
      onTurnEnd: (id, result) => turnEnds.push({ id, stopReason: result.stopReason }),
    } satisfies SessionHubHooks);
    const sessionA = hub.create(projectA);
    const sessionB = hub.create(projectB);
    expect(sessionA.dir).not.toBe(sessionB.dir);

    hub.sendUserMessage(sessionA.id, '写 A');
    await waitFor(() => turnEnds.some((t) => t.id === sessionA.id && t.stopReason === 'end_turn'));
    hub.sendUserMessage(sessionB.id, '写 B 并读回');
    await waitFor(() => turnEnds.some((t) => t.id === sessionB.id && t.stopReason === 'end_turn'));
    await hub.close();

    // 各自相对路径 → 各自 session cwd（不落 hub 全局 root）
    expect(readFileSync(join(projectA, 'note.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(projectB, 'note.txt'), 'utf8')).toBe('B');
    expect(existsSync(join(root, 'note.txt'))).toBe(false);
    // B 读回自己目录的文件（不是 A 的内容）→ 读路径也按 session cwd 解析
    const bResults = toolResultOutputs(sessionB.dir);
    const readResult = bResults.find((r) => r.callId === 'b2')!;
    expect(readResult.ok).toBe(true);
    expect(readResult.output).toContain('B');
    expect(readResult.output).not.toContain('A');
  });

  it('恢复会话：从 header 读 cwd 执行（重开 hub 不落全局 cwd），cwd_probe 输出 = session 根目录', async () => {
    const root = tmpDir();
    const projectA = join(root, 'projectA');
    mkdirSync(projectA);
    const manager = new SessionManager(join(root, 'sessions'));
    const tools = new ToolRegistry();
    registerBuiltinTools(tools);
    const probeLog: Array<{ callId: string; cwd: string }> = [];
    tools.register(cwdProbe(probeLog));
    const scripts: MockScript[] = [
      [{ toolCalls: [{ id: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'seed.txt', content: 'seed' }) }] }, { text: 'seed ok' }],
      [{ toolCalls: [{ id: 'c2', name: 'cwd_probe', arguments: '{}' }] }, { text: 'probe ok' }],
    ];

    // hub1：创建会话，跑一轮（落 header cwd 与 seed.txt）
    const hub1 = new SessionHub({ manager, provider: new MockProvider(scripts[0]!), tools, cwd: root });
    const done1 = new Promise<void>((resolve) => {
      hub1.addHooks({ onTurnEnd: (id) => { if (id === created.id) resolve(); } } satisfies SessionHubHooks);
    });
    const created = hub1.create(projectA);
    hub1.sendUserMessage(created.id, 'seed');
    await done1;
    await hub1.close();
    expect(readFileSync(join(projectA, 'seed.txt'), 'utf8')).toBe('seed');

    // hub2：同 manager 恢复会话（entryFor 走 resume → header.cwd），再跑一轮
    const hub2 = new SessionHub({ manager, provider: new MockProvider(scripts[1]!), tools, cwd: root });
    const done2 = new Promise<void>((resolve) => {
      hub2.addHooks({ onTurnEnd: (id) => { if (id === created.id) resolve(); } } satisfies SessionHubHooks);
    });
    hub2.ensureOpen(created.id);
    hub2.sendUserMessage(created.id, 'probe');
    await done2;
    await hub2.close();

    // header.cwd = projectA（真值）；cwd_probe 输出 = projectA（工具用 session cwd）
    const header = loadSession(created.dir).header!;
    expect(header.cwd).toBe(projectA);
    const results = toolResultOutputs(created.dir);
    const probe = results.find((r) => r.callId === 'c2')!;
    expect(probe.ok).toBe(true);
    expect(probe.output).toBe(projectA);
    expect(probeLog.at(-1)?.cwd).toBe(projectA);
  });
});