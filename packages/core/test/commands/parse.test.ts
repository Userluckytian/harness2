// 命令行解析测试：/ 前缀、大小写归一、别名（/? → help、/quit → exit）、/undo 参数校验。
import { describe, expect, it } from 'vitest';
import { parseUndoArgs, splitCommandLine } from '../../src/commands/parse.js';
import { findCoreCommand, parseCoreCommand } from '../../src/commands/registry.js';

describe('splitCommandLine 词法解析', () => {
  it('非命令（无 / 前缀）返回 null', () => {
    expect(splitCommandLine('hello world')).toBeNull();
    expect(splitCommandLine('  plain text ')).toBeNull();
    expect(splitCommandLine('')).toBeNull();
  });

  it('命令词与参数分离，参数已 trim', () => {
    expect(splitCommandLine('/resume 20260913-101010-abcdef')).toEqual({
      word: '/resume',
      rest: '20260913-101010-abcdef',
    });
    expect(splitCommandLine('  /undo   3 --dry-run  ')).toEqual({ word: '/undo', rest: '3 --dry-run' });
  });

  it('命令词小写归一（/HELP → /help）', () => {
    expect(splitCommandLine('/HELP')).toEqual({ word: '/help', rest: '' });
  });

  it('裸 / 与只有空格的参数', () => {
    expect(splitCommandLine('/')).toEqual({ word: '/', rest: '' });
    expect(splitCommandLine('/resume    ')).toEqual({ word: '/resume', rest: '' });
  });
});

describe('parseCoreCommand 别名与规范 id', () => {
  it('别名解析为规范 id：/? → help、/quit → exit（raw 保留原词）', () => {
    expect(parseCoreCommand('/?')).toEqual({ raw: '/?', id: 'help', rest: '' });
    expect(parseCoreCommand('/quit')).toEqual({ raw: '/quit', id: 'exit', rest: '' });
  });

  it('注册命令返回规范 id（不含 /）', () => {
    expect(parseCoreCommand('/sessions keyword')).toEqual({
      raw: '/sessions',
      id: 'sessions',
      rest: 'keyword',
    });
  });

  it('未注册命令 id=null、raw 保留（供「未知命令」文案逐字输出）', () => {
    expect(parseCoreCommand('/nope x')).toEqual({ raw: '/nope', id: null, rest: 'x' });
    expect(parseCoreCommand('/')).toEqual({ raw: '/', id: null, rest: '' });
  });

  it('大小写不敏感（/UNDO → undo）', () => {
    expect(parseCoreCommand('/UNDO 2')?.id).toBe('undo');
  });

  it('非命令返回 null', () => {
    expect(parseCoreCommand('普通消息')).toBeNull();
    expect(parseCoreCommand('  ')).toBeNull();
  });
});

describe('findCoreCommand 注册表查找', () => {
  it('按 id 查找；可带 / 前缀；大小写不敏感', () => {
    expect(findCoreCommand('undo')?.id).toBe('undo');
    expect(findCoreCommand('/undo')?.id).toBe('undo');
    expect(findCoreCommand('UNDO')?.id).toBe('undo');
  });

  it('按别名查找（?、quit）', () => {
    expect(findCoreCommand('?')?.id).toBe('help');
    expect(findCoreCommand('quit')?.id).toBe('exit');
  });

  it('未注册词与空词返回 undefined', () => {
    expect(findCoreCommand('nope')).toBeUndefined();
    expect(findCoreCommand('/')).toBeUndefined();
    expect(findCoreCommand('')).toBeUndefined();
  });
});

describe('parseUndoArgs（/undo [n] [--dry-run]）', () => {
  it('缺省：1 层、非 dry-run', () => {
    expect(parseUndoArgs('')).toEqual({ count: 1, dryRun: false });
  });

  it('层数与 --dry-run 任意顺序', () => {
    expect(parseUndoArgs('3 --dry-run')).toEqual({ count: 3, dryRun: true });
    expect(parseUndoArgs('--dry-run 3')).toEqual({ count: 3, dryRun: true });
  });

  it('边界 1 与 100 合法', () => {
    expect(parseUndoArgs('1')).toEqual({ count: 1, dryRun: false });
    expect(parseUndoArgs('100')).toEqual({ count: 100, dryRun: false });
  });

  it('0 与 101 非法（逐字错误文案）', () => {
    expect(parseUndoArgs('0')).toBe('无效的撤回层数 "0"（应为 1..100 整数）');
    expect(parseUndoArgs('101')).toBe('无效的撤回层数 "101"（应为 1..100 整数）');
  });

  it('非整数非法', () => {
    expect(parseUndoArgs('abc')).toBe('无效的撤回层数 "abc"（应为 1..100 整数）');
    expect(parseUndoArgs('1.5')).toBe('无效的撤回层数 "1.5"（应为 1..100 整数）');
  });
});
