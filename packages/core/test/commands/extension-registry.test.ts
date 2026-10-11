// D02 命令注册开放化测试：register/unregister/重名拒绝（builtin fail-closed）/describeCapabilities
// 加性 source/分发面接线/测试隔离。内建 29 条行为零变化为红线。
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_COMMANDS,
  describeCapabilities,
  findCoreCommand,
  listCoreCommands,
  parseCoreCommand,
  registerCoreCommand,
  resetCoreCommands,
  runCoreCommand,
  unregisterCoreCommand,
  type CoreCommandContext,
} from '../../src/index.js';

afterEach(() => {
  resetCoreCommands(); // 扩展命令清场（内建 29 条不动）
});

/** 最小命令执行缝（录 print 行） */
function makeCtx(): CoreCommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (text: string) => lines.push(text),
    manager: {} as never,
    cwd: 'D:/x',
    current: () => null,
    switchSession: () => {},
    requestExit: () => {},
    snapshots: () => undefined,
  };
}

describe('registerCoreCommand（开放注册）', () => {
  it('注册后进入分发面：findCoreCommand（id/别名）、parseCoreCommand、runCoreCommand 可执行', () => {
    registerCoreCommand({
      id: 'greet',
      aliases: ['hi'],
      group: '通用',
      summary: '扩展问候命令',
      run: (ctx, args) => ctx.print(`hello ${args.rest}`),
    });
    expect(findCoreCommand('greet')?.source).toBe('extension');
    expect(findCoreCommand('/hi')?.id).toBe('greet');
    expect(parseCoreCommand('/greet world')).toEqual({ raw: '/greet', id: 'greet', rest: 'world' });
    const ctx = makeCtx();
    const parsed = parseCoreCommand('/hi zoe');
    void runCoreCommand(parsed!, ctx);
    expect(ctx.lines).toEqual(['hello zoe']);
  });

  it('describeCapabilities 加性携带 source：内建 29 条全 builtin、扩展追加且 source=extension', () => {
    const before = describeCapabilities().commands;
    expect(before).toHaveLength(CORE_COMMANDS.length); // 未注册时与内建一一对应
    expect(before.every((c) => c.source === 'builtin')).toBe(true);

    registerCoreCommand({ id: 'ext-a', group: '通用', summary: '扩展 A', run: () => {} });
    const caps = describeCapabilities().commands;
    expect(caps).toHaveLength(CORE_COMMANDS.length + 1);
    expect(caps.slice(0, CORE_COMMANDS.length).every((c) => c.source === 'builtin')).toBe(true);
    expect(caps.at(-1)).toMatchObject({ id: 'ext-a', source: 'extension' });
    // 内建条目的既有字段不受影响（加性字段不破坏旧消费者）
    expect(caps.find((c) => c.id === 'undo')).toMatchObject({ aliases: ['rewind'], group: '历史' });
  });

  it('listCoreCommands：内建在前（声明序），扩展按注册序追加', () => {
    registerCoreCommand({ id: 'ext-b', group: '通用', summary: 'B', run: () => {} });
    registerCoreCommand({ id: 'ext-a', group: '通用', summary: 'A', run: () => {} });
    const all = listCoreCommands();
    expect(all.slice(0, CORE_COMMANDS.length)).toEqual(CORE_COMMANDS); // 内建清单原样在前
    expect(all.slice(CORE_COMMANDS.length).map((c) => c.id)).toEqual(['ext-b', 'ext-a']);
  });

  it('重名拒绝：id 撞内建 / 别名撞内建别名 / id 撞扩展 / 别名撞扩展别名 → 明确错误（fail-closed）', () => {
    expect(() => registerCoreCommand({ id: 'help', group: '通用', summary: 'x', run: () => {} })).toThrow(
      /collides with builtin/,
    );
    expect(() => registerCoreCommand({ id: 'quit', group: '通用', summary: 'x', run: () => {} })).toThrow(
      /collides with builtin/,
    ); // 内建别名
    registerCoreCommand({ id: 'ext-c', aliases: ['c'], group: '通用', summary: 'C', run: () => {} });
    expect(() => registerCoreCommand({ id: 'ext-c', group: '通用', summary: 'x', run: () => {} })).toThrow(
      /already registered/,
    );
    expect(() =>
      registerCoreCommand({ id: 'ext-d', aliases: ['c'], group: '通用', summary: 'x', run: () => {} }),
    ).toThrow(/already registered/);
  });

  it('非法定义拒绝：缺 run / 坏名 / 空 summary / 自报 source', () => {
    expect(() => registerCoreCommand({ id: 'no-run', group: '通用', summary: 'x', run: undefined as never })).toThrow(
      /run is required/,
    );
    expect(() => registerCoreCommand({ id: 'Bad_Name', group: '通用', summary: 'x', run: () => {} })).toThrow(
      /invalid core command id/,
    );
    expect(() =>
      registerCoreCommand({ id: 'ok-id', aliases: ['ALSO_BAD'], group: '通用', summary: 'x', run: () => {} }),
    ).toThrow(/invalid core command alias/);
    expect(() => registerCoreCommand({ id: 'ok-id2', group: '通用', summary: '', run: () => {} })).toThrow(
      /summary must be a non-empty string/,
    );
    expect(() =>
      registerCoreCommand({ id: 'ok-id3', group: '通用', summary: 'x', run: () => {}, source: 'builtin' } as never),
    ).toThrow(/source is assigned by the registry/);
  });

  it('shellOnly 扩展不收（无 run 即拒，不画饼）', () => {
    expect(() =>
      registerCoreCommand({ id: 'shell-ext', group: '通用', summary: 'x', run: undefined as never }),
    ).toThrow(/run is required/);
  });
});

describe('unregisterCoreCommand（dispose 配套）', () => {
  it('注销扩展命令：退出分发面与 describeCapabilities；未注册返回 false（幂等）', () => {
    registerCoreCommand({ id: 'temp-cmd', group: '通用', summary: '临时', run: () => {} });
    expect(findCoreCommand('temp-cmd')).toBeDefined();
    expect(unregisterCoreCommand('temp-cmd')).toBe(true);
    expect(findCoreCommand('temp-cmd')).toBeUndefined();
    expect(describeCapabilities().commands.some((c) => c.id === 'temp-cmd')).toBe(false);
    expect(unregisterCoreCommand('temp-cmd')).toBe(false);
  });

  it('内建命令不可注销（fail-closed），含按内建别名注销也拒', () => {
    expect(() => unregisterCoreCommand('help')).toThrow(/cannot unregister builtin/);
    expect(() => unregisterCoreCommand('quit')).toThrow(/cannot unregister builtin/); // exit 的别名
    expect(findCoreCommand('help')).toBeDefined(); // 分发面无损
  });
});

describe('测试隔离与内建零变化', () => {
  it('resetCoreCommands：清空扩展，内建 29 条原样（id 清单与注册表一致）', () => {
    registerCoreCommand({ id: 'wipe-me', group: '通用', summary: 'x', run: () => {} });
    resetCoreCommands();
    expect(listCoreCommands()).toEqual(CORE_COMMANDS);
    expect(findCoreCommand('wipe-me')).toBeUndefined();
    expect(CORE_COMMANDS.every((c) => c.source === undefined)).toBe(true); // 内建清单无 source 污染
    expect(CORE_COMMANDS.map((c) => c.id)).toEqual(describeCapabilities().commands.map((c) => c.id));
  });
});
