// H-20 记忆文件两分（等价性登记）+ H-21 主动持久化（P7-A）。
// H-20：本仓记忆落地形态 = 数据根/<memories>/ 下 MEMORY.md（事实）+ USER.md（用户模型），
//   与 hermes `<HERMES_HOME>/memories` 的两分形态等价（数据根名字不同、结构同构）；
//   条目分隔符 §、字符预算 2200/1375 与 hermes 默认值一致（预算常量在 memory.test.ts 钉死）。
// H-21：模式策略唯一出口 resolveMemoryPolicy/createMemoryToolForPolicy——三条路径
//   （auto 主动直写 / ask 暂存审批 / off 工具不可见）全部留证据。
// 红线：全部用临时目录，绝不写真实 ~/.harness2。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_FILE_NAME,
  MemoryStore,
  USER_FILE_NAME,
  assembleMemorySnapshot,
  defaultMemoriesRoot,
} from '../src/memory/store.js';
import { defaultPendingRoot, PendingMemoryStore } from '../src/memory/pending.js';
import { createMemoryToolForMode } from '../src/memory/nudge.js';
import {
  MEMORY_APPROVAL_GUIDANCE,
  MEMORY_MODE_DEFAULT,
  MEMORY_PROACTIVE_GUIDANCE,
  createMemoryToolForPolicy,
  createPendingMemorySink,
  resolveMemoryPolicy,
} from '../src/memory/mode.js';
import { PROACTIVE_TOOL_CONTRACT } from '../src/memory/tool.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/config/schema.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'h2-mem-mode-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CTX = { signal: new AbortController().signal, cwd: '.' };

describe('H-20 记忆文件两分（与 hermes 基准等价性登记）', () => {
  it('记忆目录 = 数据根/<memories>（对照 hermes <HERMES_HOME>/memories），pending 在其下', () => {
    const home = tmpRoot();
    expect(defaultMemoriesRoot(home)).toBe(join(home, '.harness2', 'memories'));
    expect(defaultPendingRoot(home)).toBe(join(home, '.harness2', 'memories', 'pending'));
  });

  it('两分固定：MEMORY.md = agent 事实笔记 / USER.md = 用户模型（同一目录两个文件）', () => {
    const store = new MemoryStore(tmpRoot());
    expect(MEMORY_FILE_NAME).toBe('MEMORY.md');
    expect(USER_FILE_NAME).toBe('USER.md');
    expect(store.fileFor('memory')).toBe(join(store.root, 'MEMORY.md'));
    expect(store.fileFor('user')).toBe(join(store.root, 'USER.md'));
  });

  it('快照两节齐备（缺一节标「（空）」）；两文件都空 → null（零注入）', () => {
    const snapshot = assembleMemorySnapshot('项目是 monorepo', '用户偏好中文回复');
    expect(snapshot).toContain(`## memory（${MEMORY_FILE_NAME}）`);
    expect(snapshot).toContain(`## user（${USER_FILE_NAME}）`);
    expect(snapshot!.indexOf('项目是 monorepo')).toBeLessThan(snapshot!.indexOf('用户偏好中文回复'));
    const onlyUser = assembleMemorySnapshot('', '用户偏好中文回复');
    expect(onlyUser).toContain('（空）');
    expect(assembleMemorySnapshot('', '')).toBeNull();
    expect(assembleMemorySnapshot('  \n', ' \n')).toBeNull();
  });
});

describe('H-21 模式策略表（off / ask / auto）', () => {
  it('默认值 = off（安全默认），且与 config DEFAULT_MEMORY_CONFIG.mode 一致', () => {
    expect(MEMORY_MODE_DEFAULT).toBe('off');
    expect(MEMORY_MODE_DEFAULT).toBe(DEFAULT_MEMORY_CONFIG.mode);
  });

  it('auto：工具可见 + 直写 + 主动持久化 + 无需审批', () => {
    const p = resolveMemoryPolicy('auto');
    expect(p).toMatchObject({
      mode: 'auto',
      toolVisible: true,
      write: 'direct',
      proactive: true,
      requiresApproval: false,
    });
    expect(p.guidance).toBe(MEMORY_PROACTIVE_GUIDANCE);
  });

  it('ask：工具可见 + 暂存 + 主动提交但需审批', () => {
    const p = resolveMemoryPolicy('ask');
    expect(p).toMatchObject({
      mode: 'ask',
      toolVisible: true,
      write: 'pending',
      proactive: true,
      requiresApproval: true,
    });
    expect(p.guidance).toBe(MEMORY_APPROVAL_GUIDANCE);
  });

  it('off：工具不可见、零写入、零注入指令', () => {
    const p = resolveMemoryPolicy('off');
    expect(p).toMatchObject({
      mode: 'off',
      toolVisible: false,
      write: 'none',
      proactive: false,
      requiresApproval: false,
    });
    expect(p.guidance).toBeNull();
  });

  it('未知模式 fail-safe 归 off（装配层笔误不得把记忆悄悄打开）', () => {
    expect(resolveMemoryPolicy('always' as 'auto').mode).toBe('off');
    expect(resolveMemoryPolicy('always' as 'auto').toolVisible).toBe(false);
  });

  it('主动持久化指令含行为要求；ask 指令点明「待审批」；两者都点明密钥红线', () => {
    expect(MEMORY_PROACTIVE_GUIDANCE).toContain('无需用户提醒');
    expect(MEMORY_PROACTIVE_GUIDANCE).toContain('删旧加新');
    expect(MEMORY_PROACTIVE_GUIDANCE).toContain('绝不记录密钥');
    expect(MEMORY_APPROVAL_GUIDANCE).toContain('待审批');
    expect(MEMORY_APPROVAL_GUIDANCE).toContain('绝不提交密钥');
  });
});

describe('H-21 三路工具面（createMemoryToolForPolicy）', () => {
  it('auto 下主动写生效：直接落盘、结果无 staged、工具描述带主动持久化契约', async () => {
    const root = tmpRoot();
    const store = new MemoryStore(root);
    const tool = createMemoryToolForPolicy(store, 'auto');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain(PROACTIVE_TOOL_CONTRACT);
    const result = await tool!.execute({ operation: 'add', target: 'memory', text: '用户项目是 monorepo' }, CTX);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('MEMORY.md: 1 entries');
    expect(result.output).not.toContain('staged');
    // 无需任何审批，磁盘已写
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toBe('用户项目是 monorepo');
  });

  it('off 下工具不可见：工厂返回 undefined（调用方无从注册）', () => {
    const store = new MemoryStore(tmpRoot());
    expect(createMemoryToolForPolicy(store, 'off')).toBeUndefined();
  });

  it('ask 下走 pending 审批：先暂存（磁盘零改动）→ approve 后落盘', async () => {
    const root = tmpRoot();
    const store = new MemoryStore(root);
    const pending = new PendingMemoryStore(defaultPendingRoot(root), store);
    const tool = createMemoryToolForPolicy(store, 'ask', { pending, sessionId: 'sess-a' });
    expect(tool).toBeDefined();
    const staged = await tool!.execute({ operation: 'add', target: 'user', text: '用户偏好中文回复' }, CTX);
    expect(staged.error).toBeUndefined();
    expect(staged.output).toContain('staged as');
    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    const items = await pending.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.sessionId).toBe('sess-a');
    const approved = await pending.approve(items[0]!.id);
    expect(approved.ok).toBe(true);
    expect(readFileSync(join(root, 'USER.md'), 'utf8')).toBe('用户偏好中文回复');
  });

  it('ask 缺 pending / sessionId → fail-fast 抛错（不静默降级成直写）', () => {
    const store = new MemoryStore(tmpRoot());
    expect(() => createMemoryToolForPolicy(store, 'ask')).toThrow(/需要 pending store/);
    const pending = new PendingMemoryStore(defaultPendingRoot(tmpRoot()), store);
    expect(() => createMemoryToolForPolicy(store, 'ask', { pending })).toThrow(/需要 sessionId/);
  });

  it('createPendingMemorySink：直接使用 sink 同样只暂存（stagedId + 零落盘），可被 approve 重放', async () => {
    const root = tmpRoot();
    const store = new MemoryStore(root);
    const pending = new PendingMemoryStore(defaultPendingRoot(root), store);
    const sink = createPendingMemorySink(pending, 'sess-b');
    await sink.apply([{ operation: 'add', target: 'memory', text: '一' }]);
    await sink.apply([{ operation: 'add', target: 'memory', text: '二' }]);
    expect(await pending.list()).toHaveLength(2);
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(false);
    const id = (await pending.list())[0]!.id;
    expect((await pending.approve(id)).ok).toBe(true);
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toBe('一');
  });
});

describe('H-21 旧入口 createMemoryToolForMode 委托同一策略（不得分叉）', () => {
  it('auto 直写 / ask 暂存，且缺 pending 的报错文案保持不变', async () => {
    const root = tmpRoot();
    const store = new MemoryStore(root);
    const auto = createMemoryToolForMode(store, 'auto', undefined, 'sess-1');
    await auto.execute({ operation: 'add', target: 'memory', text: 'auto 直写' }, CTX);
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toBe('auto 直写');

    const pending = new PendingMemoryStore(defaultPendingRoot(root), store);
    const ask = createMemoryToolForMode(store, 'ask', pending, 'sess-2');
    const staged = await ask.execute({ operation: 'add', target: 'user', text: 'ask 暂存' }, CTX);
    expect(staged.output).toContain('staged as');
    expect(existsSync(join(root, 'USER.md'))).toBe(false);

    expect(() => createMemoryToolForMode(store, 'ask', undefined, 'sess-3')).toThrow(
      'nudge: ask 模式需要 pending store',
    );
  });
});
