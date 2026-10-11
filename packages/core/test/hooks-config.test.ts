// A09 Hooks 配置节校验测试（fail-closed）：合法形状解析、缺省补全、非法形状拒绝。
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOOKS_CONFIG, HOOK_EVENT_NAMES, parseConfig } from '../src/config/schema.js';

const BASE = {
  providers: { p: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1' } },
  roles: { main: { channel: 'p', model: 'm' } },
} as const;

function parse(hooks?: unknown) {
  return parseConfig(hooks === undefined ? { ...BASE } : { ...BASE, hooks });
}

describe('config.hooks 校验', () => {
  it('未配置 hooks 段：HarnessConfig 上不出现该字段（零回归）', () => {
    const r = parse();
    expect(r.errors).toEqual([]);
    expect(r.config?.hooks).toBeUndefined();
  });

  it('空对象段：透出缺省（enabled=true / timeoutMs=30000 / maxOutputBytes=32768 / entries=[]）', () => {
    const r = parse({});
    expect(r.errors).toEqual([]);
    expect(r.config?.hooks).toEqual(DEFAULT_HOOKS_CONFIG);
  });

  it('合法条目：event/matcher/command/timeoutMs/enabled/async 全解析', () => {
    const r = parse({
      enabled: true,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      entries: [
        { event: 'preTool', matcher: 'bash', command: 'echo hi', timeoutMs: 1000, enabled: false },
        { event: 'postTool', command: 'node hook.js', async: true },
        { event: 'turnEnd', command: 'true' },
        { event: 'sessionStart', command: 'true' },
        { event: 'sessionEnd', command: 'true' },
      ],
    });
    expect(r.errors).toEqual([]);
    const hooks = r.config?.hooks;
    expect(hooks?.timeoutMs).toBe(5000);
    expect(hooks?.maxOutputBytes).toBe(1024);
    expect(hooks?.entries).toHaveLength(5);
    expect(hooks?.entries[0]).toEqual({
      event: 'preTool',
      matcher: 'bash',
      command: 'echo hi',
      timeoutMs: 1000,
      enabled: false,
    });
    expect(hooks?.entries[1]).toEqual({ event: 'postTool', command: 'node hook.js', async: true });
  });

  it('HOOK_EVENT_NAMES 覆盖五个触发源', () => {
    expect([...HOOK_EVENT_NAMES]).toEqual(['sessionStart', 'sessionEnd', 'turnEnd', 'preTool', 'postTool']);
  });

  it.each([
    ['hooks 非对象', 42, 'config.hooks 必须是对象'],
    ['entries 非数组', { entries: {} }, 'hooks.entries 必须是数组'],
    ['entry 非对象', { entries: [1] }, '必须是对象'],
    ['event 非法', { entries: [{ event: 'nope', command: 'x' }] }, '.event 必须是'],
    ['command 缺失', { entries: [{ event: 'turnEnd' }] }, '.command 必须是非空字符串'],
    ['command 空白', { entries: [{ event: 'turnEnd', command: '   ' }] }, '.command 必须是非空字符串'],
    [
      'matcher 用在 turnEnd',
      { entries: [{ event: 'turnEnd', matcher: 'x', command: 'c' }] },
      'matcher 仅 preTool/postTool',
    ],
    ['matcher 空串', { entries: [{ event: 'preTool', matcher: '', command: 'c' }] }, '.matcher 必须是非空字符串'],
    ['timeoutMs 越界', { timeoutMs: 0 }, 'hooks.timeoutMs 必须是 1..'],
    ['timeoutMs 非整数', { timeoutMs: 1.5 }, 'hooks.timeoutMs 必须是 1..'],
    ['maxOutputBytes 超上限', { maxOutputBytes: 999_999_999 }, 'hooks.maxOutputBytes 必须是 1..'],
    ['enabled 非布尔', { enabled: 'yes' }, 'hooks.enabled 必须是布尔值'],
    ['entry.enabled 非布尔', { entries: [{ event: 'preTool', command: 'c', enabled: 1 }] }, '.enabled 必须是布尔值'],
    ['entry.async 非布尔', { entries: [{ event: 'preTool', command: 'c', async: 'y' }] }, '.async 必须是布尔值'],
    ['entry.timeoutMs 越界', { entries: [{ event: 'preTool', command: 'c', timeoutMs: 0 }] }, '.timeoutMs 必须是 1..'],
  ])('fail-closed：%s → 致命错误（config=null）', (_label, hooks, needle) => {
    const r = parse(hooks);
    expect(r.config).toBeNull();
    expect(r.errors.join('\n')).toContain(needle as string);
  });

  it('未知字段记告警（不致命）', () => {
    const r = parse({ entries: [{ event: 'preTool', command: 'c', bogus: 1 }], extraRoot: true });
    expect(r.config?.hooks?.entries).toHaveLength(1);
    expect(r.warnings.join('\n')).toContain('未知字段');
    expect(r.errors).toEqual([]);
  });
});
