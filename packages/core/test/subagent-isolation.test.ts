// H-41 隐离子代理（P7-C）：委派给独立上下文的子代理，主会话不被污染。
//
// 本文件把「隔离」拆成可断言的四条：
//   ① 主会话日志：只有 subagent_start 的 tool/call + tool/result 两行，没有任何子会话中间事件；
//   ② 主会话上下文：只有子会话的**最终交付文本**（tool/result.output 里的 finalText），
//      子会话的中间 assistant 文本与中间工具结果都不进父的模型上下文；
//   ③ 子会话上下文：只有自己的 prompt，父的原始口令/其它会话内容不泄漏进来；
//   ④ 血缘与深度：parentSession 指向派发方、subagent=true；深度靠「子会话工具集是否含
//      subagent 工具」表达（maxDepth=2 时子可再派发、孙不可）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, buildChatMessages } from '../src/agent/loop.js';
import { MockProvider, type MockScript } from '../src/provider/mock.js';
import { SessionManager } from '../src/session/manager.js';
import { loadSession } from '../src/session/reader.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { createSubagentTools, type SubagentOptions } from '../src/agent/subagent.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-subagent-iso-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHILD_TOOL_OUTPUT = 'CHILD-MARKER-TOOL-RESULT';
const CHILD_STEP_TEXT = 'CHILD-MARKER-STEP1-TEXT';
const CHILD_FINAL_TEXT = 'CHILD-MARKER-FINAL';
const PARENT_USER_TEXT = '父会话原始口令-不应出现在子会话';

/** 子会话里的工具：输出带标记，便于在父上下文里搜索是否泄漏 */
const childTool: ToolDefinition = {
  name: 'child_probe',
  description: '子会话探测工具',
  parameters: { type: 'object', properties: {} },
  execute: () => ({ output: CHILD_TOOL_OUTPUT }),
};

describe('H-41 隐离子代理：主会话不被污染', () => {
  /** 父 provider 与子 provider 分开注入（隔离性更清晰，也避免脚本游标交错） */
  function makeHarness(script: { parent: MockScript; child: MockScript }, maxDepth = 1) {
    const root = tmpDir();
    const manager = new SessionManager(join(root, 'sessions'));
    const parentProvider = new MockProvider(script.parent);
    const childProvider = new MockProvider(script.child);
    const base = new ToolRegistry();
    base.register(childTool);
    const parent = manager.create(root, { fsync: false });
    const childEvents: Array<{ sessionId: string; type: string }> = [];
    const options: SubagentOptions = {
      manager,
      provider: childProvider,
      baseTools: base,
      cwd: root,
      maxDepth,
      maxTurns: 10,
      parentSessionId: parent.id,
      depth: 0,
      hooks: { onChildEvent: (sessionId, event) => childEvents.push({ sessionId, type: event.type }) },
      fsync: false,
    };
    for (const def of createSubagentTools(options)) base.register(def);
    return { root, manager, parentProvider, childProvider, base, parent, childEvents };
  }

  it('主会话日志零污染：只有 tool/call + tool/result；中间事件一条都不落父日志', async () => {
    const h = makeHarness({
      parent: [
        { toolCalls: [{ id: 'p1', name: 'subagent_start', arguments: '{"prompt":"子任务"}' }] },
        { text: '父会话收尾' },
      ],
      child: [
        { text: CHILD_STEP_TEXT, toolCalls: [{ id: 'c1', name: 'child_probe', arguments: '{}' }] },
        { toolCalls: [{ id: 'c2', name: 'child_probe', arguments: '{}' }] },
        { text: CHILD_FINAL_TEXT },
      ],
    });
    const result = await runTurn(h.parent.writer, {
      provider: h.parentProvider,
      tools: h.base,
      cwd: h.root,
      userText: PARENT_USER_TEXT,
      maxSteps: 5,
    });
    h.parent.writer.close();
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('父会话收尾');

    // ① 父日志事件面：user/message + assistant/message×2 + 1 tool/call + 1 tool/result + step 骨架
    const parentLog = loadSession(h.parent.dir);
    const calls = parentLog.events.filter((e) => e.event.type === 'tool/call');
    const results = parentLog.events.filter((e) => e.event.type === 'tool/result');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.event.payload).toMatchObject({ tool: 'subagent_start' });
    expect(results).toHaveLength(1);
    expect(results[0]!.event.payload).toMatchObject({ tool: 'subagent_start' });
    // 子会话的中间痕迹不在父日志里（连字符串都不该出现）
    const parentLogDump = JSON.stringify(parentLog.events);
    expect(parentLogDump).not.toContain(CHILD_STEP_TEXT);
    expect(parentLogDump).not.toContain(CHILD_TOOL_OUTPUT);
    // 只允许出现最终交付文本
    expect(parentLogDump).toContain(CHILD_FINAL_TEXT);
    // 子会话确实跑了 3 步（不是没跑）
    expect(h.childProvider.requests).toHaveLength(3);

    // ② 父的模型上下文投影：中间文本/中间工具结果都不在，只有最终交付
    const parentMessages = buildChatMessages(loadSession(h.parent.dir));
    const dump = JSON.stringify(parentMessages);
    expect(dump).toContain(CHILD_FINAL_TEXT);
    expect(dump).not.toContain(CHILD_STEP_TEXT);
    expect(dump).not.toContain(CHILD_TOOL_OUTPUT);
    // 父模型看到的 tool 消息只有一条（subagent_start 的结果）
    expect(parentMessages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('子会话上下文隔离：只有自己的 prompt；父原始口令不泄漏；子请求工具集无 subagent 工具', async () => {
    const h = makeHarness({
      parent: [
        { toolCalls: [{ id: 'p1', name: 'subagent_start', arguments: '{"prompt":"只给子会话的指令"}' }] },
        { text: '父收尾' },
      ],
      child: [{ text: CHILD_FINAL_TEXT }],
    });
    await runTurn(h.parent.writer, {
      provider: h.parentProvider,
      tools: h.base,
      cwd: h.root,
      userText: PARENT_USER_TEXT,
      maxSteps: 5,
    });
    h.parent.writer.close();
    // maxDepth=1：子请求工具集 = 宿主 − subagent_* − per-session 绑定类
    const childReq = h.childProvider.requests[0]!;
    const names = (childReq.tools ?? []).map((t) => t.name);
    expect(names).toContain('child_probe');
    expect(names).not.toContain('subagent_start');
    expect(names).not.toContain('subagent_continue');
    expect(names).not.toContain('subagent_fanout');
    // 子上下文：只有自己的 prompt（父的 user 文本一个字都不出现）
    const dump = JSON.stringify(childReq.messages);
    expect(dump).toContain('只给子会话的指令');
    expect(dump).not.toContain(PARENT_USER_TEXT);
    expect(childReq.messages).toHaveLength(1);
  });

  it('血缘与深度：parentSession 指向派发方；maxDepth=2 时子可再派发、孙不可', async () => {
    const h = makeHarness(
      {
        parent: [
          { toolCalls: [{ id: 'p1', name: 'subagent_start', arguments: '{"prompt":"level-1"}' }] },
          { text: '父收尾' },
        ],
        // 同一 provider 贯穿子/孙（脚本按消费顺序：子的派发 → 孙的正文 → 子的收尾）
        child: [
          { toolCalls: [{ id: 'c1', name: 'subagent_start', arguments: '{"prompt":"level-2"}' }] },
          { text: 'level-2 完成' },
          { text: 'level-1 完成' },
        ],
      },
      2,
    );
    await runTurn(h.parent.writer, {
      provider: h.parentProvider,
      tools: h.base,
      cwd: h.root,
      userText: '父任务',
      maxSteps: 8,
    });
    h.parent.writer.close();

    // 请求序：0 = 父（有 subagent 工具）；1 = 子（深度 1 < 2，仍有）；2 = 孙（深度 2，没有）
    const parentReq = h.parentProvider.requests[0]!;
    const childReq = h.childProvider.requests[0]!;
    const grandReq = h.childProvider.requests[1]!;
    expect((parentReq.tools ?? []).map((t) => t.name)).toContain('subagent_start');
    expect((childReq.tools ?? []).map((t) => t.name)).toContain('subagent_start');
    expect((grandReq.tools ?? []).map((t) => t.name)).not.toContain('subagent_start');
    expect((grandReq.tools ?? []).map((t) => t.name)).not.toContain('subagent_fanout');
    expect(grandReq.messages[0]).toEqual({ role: 'user', content: 'level-2' });

    // 血缘链：父 → 子 → 孙；孙的 parentSession = 子会话（重绑，不是顶父）
    const children = h.manager.list().filter((s) => loadSession(s.dir).header?.parentSession === h.parent.id);
    expect(children).toHaveLength(1);
    const childHeader = loadSession(children[0]!.dir).header!;
    expect(childHeader.subagent).toBe(true);
    expect(childHeader.isSeeded).toBe(true);
    expect(childHeader.parentSession).toBe(h.parent.id);
    const grand = h.manager.list().filter((s) => loadSession(s.dir).header?.parentSession === childHeader.sessionId);
    expect(grand).toHaveLength(1);
    expect(loadSession(grand[0]!.dir).header!.subagent).toBe(true);
  });

  it('子会话事件按 sessionId 归属流出（hub 镜像依据），父会话 id 不会收到子事件', async () => {
    const h = makeHarness({
      parent: [{ toolCalls: [{ id: 'p1', name: 'subagent_start', arguments: '{"prompt":"p"}' }] }, { text: 'done' }],
      child: [{ text: 'child' }],
    });
    await runTurn(h.parent.writer, {
      provider: h.parentProvider,
      tools: h.base,
      cwd: h.root,
      userText: 'go',
      maxSteps: 5,
    });
    h.parent.writer.close();
    const childId = h.manager.list().find((s) => loadSession(s.dir).header?.parentSession === h.parent.id)?.dir;
    expect(childId).toBeTruthy();
    const childSessionId = loadSession(childId!).header!.sessionId;
    expect(h.childEvents.length).toBeGreaterThan(0);
    // 所有子事件都归属子会话 id（父 id 一次都不出现）
    for (const e of h.childEvents) expect(e.sessionId).not.toBe(h.parent.id);
    expect(h.childEvents.some((e) => e.sessionId === childSessionId && e.type === 'user/message')).toBe(true);
  });
});
