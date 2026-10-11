// A11 Agent Teams 编排层测试（Z6 批次6-B）。
// 覆盖：
//   - 团队创建 / 成员规格校验 fail-closed（名字、条数、轮次、写型、工具）；
//   - 共享任务板状态机（deps 门控、领取/完成/非法迁移）+ 落盘重放（红线①）；
//   - 成员间消息（成员→板 / 成员↔成员定向 + 投递缝）+ 落盘可重放；
//   - 硬闸：并发上限走既有 TaskCoordinator（写全局串行 / 只读 K=2，fake runner，不真起模型）；
//   - 常量上限（成员数/任务数/轮次/消息条数/标题）+ 深度防护（团队不能再起团队）；
//   - `/team` 命令面（扩展命令注册 + 文案）；
//   - 扩展事件 validator fail-closed + opaque 投影。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_EVENT_TYPES,
  SessionWriter,
  TEAM_EVENT_TYPE,
  TEAM_MAX_MEMBERS,
  TEAM_MAX_MESSAGES,
  TEAM_MAX_ROUNDS,
  TEAM_MAX_TASKS,
  TEAM_MESSAGE_TYPE,
  TeamOrchestrator,
  TeamValidationError,
  assertTeamDepth,
  canTeamTaskTransition,
  extensionEventTypes,
  findTeam,
  formatTeam,
  loadSession,
  listExtensionCoreCommands,
  parseExtensionEventLine,
  parseTeamDefinition,
  projectTeams,
  readTeamEvents,
  readTeamMessages,
  registerTeamCommand,
  registerTeamEventTypes,
  runTeamCommand,
  teamRunCounts,
  type CoreCommandContext,
  type LoadedExtensionEvent,
  type TeamMemberRunner,
  type TeamMemberSpecInput,
  type TeamState,
} from '../src/index.js';
import { TaskCoordinator } from '../src/agent/task-coordinator.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-team-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000, step = 5): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

/** 简单成员规格（测试可刻意传入非法值验证 fail-closed，故以断言过桥） */
function member(name: string, over: Record<string, unknown> = {}): TeamMemberSpecInput {
  return { name, ...over } as TeamMemberSpecInput;
}

describe('团队创建与成员规格校验（fail-closed）', () => {
  it('合法定义归一：writeMode 缺省 write、maxRounds 缺省 1', () => {
    const def = parseTeamDefinition({
      name: 'squad',
      members: [member('alice'), member('bob', { writeMode: 'readonly' })],
    });
    expect(def.name).toBe('squad');
    expect(def.maxRounds).toBe(1);
    expect(def.members.map((m) => [m.name, m.writeMode])).toEqual([
      ['alice', 'write'],
      ['bob', 'readonly'],
    ]);
  });

  it('团队名 / 成员名 / 重复成员 / 空成员列表 一律拒', () => {
    expect(() => parseTeamDefinition({ name: 'Bad Name', members: [member('a')] })).toThrow(TeamValidationError);
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('bad name')] })).toThrow(TeamValidationError);
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('a'), member('a')] })).toThrow(/重复/);
    expect(() => parseTeamDefinition({ name: 'ok', members: [] })).toThrow(TeamValidationError);
  });

  it('成员数 / 轮次 / 写型 / 工具 超限或非法一律拒', () => {
    const tooMany = Array.from({ length: TEAM_MAX_MEMBERS + 1 }, (_, i) => member(`m${i}`));
    expect(() => parseTeamDefinition({ name: 'ok', members: tooMany })).toThrow(/上限/);
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('a')], maxRounds: TEAM_MAX_ROUNDS + 1 })).toThrow(
      /maxRounds/,
    );
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('a')], maxRounds: 0 })).toThrow(/maxRounds/);
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('a', { writeMode: 'rw' })] })).toThrow(/writeMode/);
    expect(() => parseTeamDefinition({ name: 'ok', members: [member('a', { tools: ['read', ''] })] })).toThrow(/tools/);
  });

  it('编排器 depth=1 构造即抛（团队不能再起团队）；assertTeamDepth(0) 放行', () => {
    expect(() => assertTeamDepth(0)).not.toThrow();
    expect(() => assertTeamDepth(1)).toThrow(/递归被拒/);
    expect(
      () => new TeamOrchestrator({ parentSessionId: 's1', cwd: '.', depth: 1, runner: async () => ({ ok: true }) }),
    ).toThrow(/递归被拒/);
  });
});

describe('共享任务板状态机', () => {
  function orch(): TeamOrchestrator {
    return new TeamOrchestrator({ parentSessionId: 's1', cwd: '.', runner: async () => ({ ok: true }) });
  }

  it('deps 门控：依赖未 done 不可领取；非法迁移被拒', () => {
    const o = orch();
    const team = o.createTeam({ name: 'board', members: [member('alice')] });
    const a = o.addTask(team.teamId, { taskId: 'a', title: '先做' });
    const b = o.addTask(team.teamId, { taskId: 'b', title: '后做', dependsOn: ['a'] });
    expect(a.status).toBe('todo');
    expect(b.dependsOn).toEqual(['a']);
    // 依赖 a 未完成 → 领取 b 被拒
    expect(() => o.claimTask(team.teamId, 'b', 'alice')).toThrow(/依赖未完成/);
    // 未知成员 / 未知任务被拒
    expect(() => o.claimTask(team.teamId, 'a', 'ghost')).toThrow(/成员不存在/);
    expect(() => o.claimTask(team.teamId, 'zzz', 'alice')).toThrow(/任务不存在/);
    // 依赖完成 → 可领取 → 完成
    o.claimTask(team.teamId, 'a', 'alice');
    o.completeTask(team.teamId, 'a', true);
    const claimed = o.claimTask(team.teamId, 'b', 'alice');
    expect(claimed.status).toBe('claimed');
    expect(claimed.owner).toBe('alice');
    // claimed → done
    expect(o.completeTask(team.teamId, 'b', true).status).toBe('done');
    // done 无出边：再迁移被拒（fail-closed）
    expect(() => o.completeTask(team.teamId, 'b', false)).toThrow(/不能从 done/);
  });

  it('新增任务的非法输入被拒：空标题 / 超长标题 / 自依赖 / 未知依赖 / id 重复', () => {
    const o = orch();
    const team = o.createTeam({ name: 'board', members: [member('alice')] });
    expect(() => o.addTask(team.teamId, { title: '  ' })).toThrow(/标题/);
    expect(() => o.addTask(team.teamId, { title: 'x'.repeat(201) })).toThrow(/上限/);
    o.addTask(team.teamId, { taskId: 'a', title: 'a' });
    expect(() => o.addTask(team.teamId, { taskId: 'a', title: 'dup' })).toThrow(/重复/);
    expect(() => o.addTask(team.teamId, { taskId: 'b', title: 'b', dependsOn: ['b'] })).toThrow(/自身/);
    expect(() => o.addTask(team.teamId, { taskId: 'c', title: 'c', dependsOn: ['nope'] })).toThrow(/不存在/);
  });

  it('任务条数常量上限：超过 TEAM_MAX_TASKS 即拒', () => {
    const o = orch();
    const team = o.createTeam({ name: 'board', members: [member('alice')] });
    for (let i = 0; i < TEAM_MAX_TASKS; i += 1) o.addTask(team.teamId, { taskId: `t${i}`, title: `t${i}` });
    expect(() => o.addTask(team.teamId, { taskId: 'overflow', title: 'x' })).toThrow(/上限/);
  });

  it('任务状态机口径：canTeamTaskTransition 对终态无出边', () => {
    expect(canTeamTaskTransition('todo', 'claimed')).toBe(true);
    expect(canTeamTaskTransition('claimed', 'done')).toBe(true);
    expect(canTeamTaskTransition('claimed', 'todo')).toBe(true);
    expect(canTeamTaskTransition('done', 'claimed')).toBe(false);
    expect(canTeamTaskTransition('failed', 'todo')).toBe(false);
  });
});

describe('成员间消息（成员→板 / 成员↔成员定向）', () => {
  it('postBoard 留痕 + sendDirect 命中投递缝；消息条数上限 fail-closed', async () => {
    const delivered: Array<{ from: string; to: string; text: string }> = [];
    const o = new TeamOrchestrator({
      parentSessionId: 's1',
      cwd: '.',
      runner: async () => ({ ok: true }),
      deliverDirect: (m) => {
        delivered.push({ from: m.from, to: m.to, text: m.text });
      },
    });
    const team = o.createTeam({ name: 'msg', members: [member('alice'), member('bob')] });
    const board = await o.postBoard(team.teamId, 'alice', '板上的进度');
    expect(board.kind).toBe('board');
    expect(board.to).toBe('board');
    const direct = await o.sendDirect(team.teamId, 'alice', 'bob', '帮我看下 B');
    expect(direct.kind).toBe('direct');
    expect(delivered).toEqual([{ from: 'alice', to: 'bob', text: '帮我看下 B' }]);
    // 非成员发送 / 未知收件人被拒
    await expect(o.postBoard(team.teamId, 'ghost', 'x')).rejects.toThrow(/成员不存在/);
    await expect(o.sendDirect(team.teamId, 'alice', 'ghost', 'x')).rejects.toThrow(/成员不存在/);
    // 条数上限
    const many = new TeamOrchestrator({ parentSessionId: 's1', cwd: '.', runner: async () => ({ ok: true }) });
    const t2 = many.createTeam({ name: 'msg2', members: [member('a')] });
    for (let i = 0; i < TEAM_MAX_MESSAGES; i += 1) await many.postBoard(t2.teamId, 'a', `m${i}`);
    await expect(many.postBoard(t2.teamId, 'a', 'overflow')).rejects.toThrow(/上限/);
  });

  it('投递缝抛错不回滚（消息已落盘 best-effort）', async () => {
    const o = new TeamOrchestrator({
      parentSessionId: 's1',
      cwd: '.',
      runner: async () => ({ ok: true }),
      deliverDirect: () => {
        throw new Error('delivery down');
      },
    });
    const team = o.createTeam({ name: 'msg3', members: [member('a'), member('b')] });
    await expect(o.sendDirect(team.teamId, 'a', 'b', 'hi')).resolves.toMatchObject({ text: 'hi' });
    expect(o.get(team.teamId)!.messages).toHaveLength(1);
  });
});

describe('硬闸：并发上限走既有 TaskCoordinator 资源锁', () => {
  it('write 成员全局串行（同刻至多一个在跑）', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const runner: TeamMemberRunner = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active -= 1;
      return { ok: true };
    };
    const o = new TeamOrchestrator({
      parentSessionId: 's1',
      cwd: '.',
      runner,
      coordinator: new TaskCoordinator({ maxReadonlyConcurrency: 2 }),
    });
    const team = o.createTeam({
      name: 'writes',
      members: [member('a'), member('b'), member('c')],
    });
    const p = o.runTeam(team.teamId);
    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => releases.length > i);
      releases[i]!();
    }
    await p;
    expect(peak).toBe(1);
    expect(o.get(team.teamId)!.members.every((m) => m.status === 'done')).toBe(true);
  });

  it('readonly 成员 K=2 受限（同刻至多两个在跑）', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const runner: TeamMemberRunner = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active -= 1;
      return { ok: true };
    };
    const o = new TeamOrchestrator({
      parentSessionId: 's1',
      cwd: '.',
      runner,
      coordinator: new TaskCoordinator({ maxReadonlyConcurrency: 2 }),
    });
    const team = o.createTeam({
      name: 'reads',
      members: [
        member('a', { writeMode: 'readonly' }),
        member('b', { writeMode: 'readonly' }),
        member('c', { writeMode: 'readonly' }),
      ],
    });
    const p = o.runTeam(team.teamId);
    await waitFor(() => releases.length === 2);
    expect(peak).toBe(2);
    releases[0]!();
    releases[1]!();
    await waitFor(() => releases.length === 3);
    expect(peak).toBe(2);
    releases[2]!();
    await p;
    expect(peak).toBe(2);
  });

  it('runner 未装配 → 成员 fail-closed 失败（不静默假装跑过）', async () => {
    const o = new TeamOrchestrator({ parentSessionId: 's1', cwd: '.' });
    const team = o.createTeam({ name: 'norun', members: [member('a')] });
    await o.runTeam(team.teamId);
    const state = o.get(team.teamId)!;
    expect(state.members[0]!.status).toBe('failed');
    expect(state.members[0]!.error).toMatch(/未装配/);
  });
});

describe('成员轮次与子会话回填', () => {
  it('rounds 夹到 team.maxRounds；runner 拿到 round 递增；childSessionId 回填落盘', async () => {
    const seen: number[] = [];
    const writer = SessionWriter.create(tmpDir(), { sessionId: 's1' }, { fsync: false });
    try {
      const o = new TeamOrchestrator({
        parentSessionId: 's1',
        cwd: '.',
        writer,
        runner: async (input) => {
          seen.push(input.round);
          return { ok: true, childSessionId: `child-${input.member.name}`, output: 'done' };
        },
      });
      const team = o.createTeam({ name: 'rounds', members: [member('a')], maxRounds: 2 });
      // 请求 5 轮 → 夹到定义上限 2
      const state = await o.runTeam(team.teamId, { rounds: TEAM_MAX_ROUNDS });
      expect(seen).toEqual([1, 2]);
      expect(state.members[0]!.rounds).toBe(2);
      expect(state.members[0]!.childSessionId).toBe('child-a');
      expect(state.members[0]!.status).toBe('done');
    } finally {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
  });
});

describe('扩展事件落盘与重放（红线①：不落盘的就不显示）', () => {
  it('SessionWriter 落盘 → loadSession → projectTeams 与编排器内存态一致', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    let memory: TeamState;
    try {
      const o = new TeamOrchestrator({
        parentSessionId: 's1',
        cwd: '.',
        writer,
        runner: async () => ({ ok: true, output: 'ok' }),
        deliverDirect: () => undefined,
      });
      const team = o.createTeam({ name: 'replay', members: [member('a'), member('b', { writeMode: 'readonly' })] });
      o.addTask(team.teamId, { taskId: 't1', title: '任务一' });
      o.claimTask(team.teamId, 't1', 'a');
      o.completeTask(team.teamId, 't1', true);
      await o.postBoard(team.teamId, 'a', '板留痕');
      await o.sendDirect(team.teamId, 'a', 'b', '定向');
      memory = await o.runTeam(team.teamId);
      writer.close();
      const session = loadSession(dir);
      expect(readTeamEvents(session.extensionEvents).length).toBeGreaterThan(0);
      expect(readTeamMessages(session.extensionEvents)).toHaveLength(2);
      const projected = findTeam(session.extensionEvents, team.teamId)!;
      expect(projected.name).toBe('replay');
      expect(projected.status).toBe(memory.status);
      expect(projected.members.map((m) => [m.name, m.status])).toEqual(memory.members.map((m) => [m.name, m.status]));
      expect(projected.tasks.map((t) => [t.taskId, t.status, t.owner])).toEqual(
        memory.tasks.map((t) => [t.taskId, t.status, t.owner]),
      );
      expect(projected.messages.map((m) => [m.from, m.to, m.kind])).toEqual([
        ['a', 'board', 'board'],
        ['a', 'b', 'direct'],
      ]);
      expect(teamRunCounts(projected).tasksDone).toBe(1);
    } finally {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
  });

  it('消息正文脱敏 + 截断后落盘', async () => {
    const dir = tmpDir();
    const writer = SessionWriter.create(dir, { sessionId: 's1' }, { fsync: false });
    try {
      const o = new TeamOrchestrator({ parentSessionId: 's1', cwd: '.', writer, runner: async () => ({ ok: true }) });
      const team = o.createTeam({ name: 'secret', members: [member('a')] });
      const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
      await o.postBoard(team.teamId, 'a', `${secret} ${'x'.repeat(3000)}`);
      writer.close();
      const session = loadSession(dir);
      const projected = findTeam(session.extensionEvents, team.teamId)!;
      expect(projected.messages[0]!.text).not.toContain(secret);
      expect(projected.messages[0]!.text.length).toBeLessThanOrEqual(2000);
    } finally {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
    }
  });

  it('validator fail-closed：缺字段/非法枚举的 team/event 与 team/message 被拒', () => {
    registerTeamEventTypes();
    const ev = extensionEventTypes.get(TEAM_EVENT_TYPE)!.validator;
    expect(ev({})).toBe(false);
    expect(ev({ teamId: 't', kind: 'created', name: 'x' })).toBe(true);
    expect(ev({ teamId: 't', kind: 'created' })).toBe(false); // 缺 name
    expect(ev({ teamId: 't', kind: 'member', member: 'a', memberStatus: 'nope' })).toBe(false);
    expect(ev({ teamId: 't', kind: 'member', member: 'a', memberStatus: 'running' })).toBe(true);
    expect(ev({ teamId: 't', kind: 'task-status', taskId: 'x', taskStatus: 'done' })).toBe(true);
    expect(ev({ teamId: 't', kind: 'task-added', taskId: 'x' })).toBe(false); // 缺 taskTitle
    const msg = extensionEventTypes.get(TEAM_MESSAGE_TYPE)!.validator;
    expect(msg({ teamId: 't', messageId: 'm', from: 'a', to: 'b', kind: 'direct', text: 'x' })).toBe(true);
    expect(msg({ teamId: 't', messageId: 'm', from: 'a', to: 'b', kind: 'nope', text: 'x' })).toBe(false);
    expect(msg({ teamId: 't', messageId: 'm', from: 'a', to: 'b', kind: 'direct', text: 'x'.repeat(2001) })).toBe(
      false,
    );
    // 读侧非法行返回 null
    const bad = JSON.stringify({ v: 1, seq: 1, ts: new Date().toISOString(), type: TEAM_EVENT_TYPE, payload: {} });
    expect(parseExtensionEventLine(bad)).toBeNull();
  });

  it('opaque 投影：team/event 不在内建白名单；被 rewind 遮蔽的影子事件不参与投影', () => {
    expect(KNOWN_EVENT_TYPES as readonly string[]).not.toContain(TEAM_EVENT_TYPE);
    registerTeamEventTypes();
    expect(extensionEventTypes.get(TEAM_EVENT_TYPE)!.projection).toBe('opaque');
    const active: LoadedExtensionEvent = {
      active: true,
      event: {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        type: TEAM_EVENT_TYPE,
        payload: { teamId: 't', kind: 'created', name: 'x' },
      },
    };
    const shadow: LoadedExtensionEvent = {
      active: false,
      event: {
        v: 1,
        seq: 2,
        ts: new Date().toISOString(),
        type: TEAM_EVENT_TYPE,
        payload: { teamId: 'hidden', kind: 'created', name: 'y' },
      },
    };
    const teams = projectTeams([active, shadow]);
    expect(teams.map((t) => t.teamId)).toEqual(['t']);
  });
});

describe('/team 命令面（扩展命令缝）', () => {
  it('注册为 source=extension；list/show/msg/stop 文案正确；注销幂等', async () => {
    const o = new TeamOrchestrator({
      parentSessionId: 's1',
      cwd: '.',
      runner: async () => ({ ok: true }),
      deliverDirect: () => undefined,
    });
    const team = o.createTeam({ name: 'cmd', members: [member('a')] });
    o.addTask(team.teamId, { taskId: 't1', title: '做点事' });
    const lines: string[] = [];
    const ctx = { print: (s: string) => lines.push(s) } as unknown as Pick<CoreCommandContext, 'print'>;
    const runtime = fakeRuntime(o);
    const dispose = registerTeamCommand(runtime);
    // 注册后进入既有能力面（source='extension'），随即注销清理
    expect(listExtensionCoreCommands().some((c) => c.id === 'team' && c.source === 'extension')).toBe(true);
    try {
      await runTeamCommand(ctx, { rest: 'list' }, runtime);
      await runTeamCommand(ctx, { rest: `show ${team.teamId}` }, runtime);
      await runTeamCommand(ctx, { rest: `msg ${team.teamId} a board 你好` }, runtime);
      await runTeamCommand(ctx, { rest: `stop ${team.teamId}` }, runtime);
    } finally {
      dispose();
    }
    expect(listExtensionCoreCommands().some((c) => c.id === 'team')).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('cmd');
    expect(out).toContain('t1');
    expect(out).toContain('已投递消息');
    expect(out).toContain('已停止团队');
    expect(o.get(team.teamId)!.status).toBe('stopped');
    expect(formatTeam(o.get(team.teamId)!)[0]).toContain('stopped');
  });
});

/** 命令测试用运行时（与上面等价，抽出来复用） */
function fakeRuntime(o: TeamOrchestrator): {
  list: () => readonly TeamState[];
  get: (id: string) => TeamState | undefined;
  post: (id: string, from: string, to: string, text: string) => Promise<void>;
  stop: (id: string) => boolean;
} {
  return {
    list: () => o.list(),
    get: (id) => o.get(id),
    post: async (id, from, to, text) => {
      if (to === 'board') await o.postBoard(id, from, text);
      else await o.sendDirect(id, from, to, text);
    },
    stop: (id) => o.stopTeam(id),
  };
}
