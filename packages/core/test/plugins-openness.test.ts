// A10 插件消费三开放测试（Z6 批次4）：manifest 声明扩展事件类型 / permissions.commands
// / ctx.registerCommand（接 coreCommandRegistry，插件卸载自动注销）/ ctx.container 注入 /
// bus 订阅与分发扩展事件。红线：能力全走显式 manifest 声明（fail-closed，不自动授权）。
// fixture 插件形态与 plugins.test.ts 相同（临时目录 + type=module）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { PluginBus, describePermissions } from '../src/plugins/bus.js';
import { scanPluginSources, validatePluginManifest } from '../src/plugins/loader.js';
import type { PluginManifest } from '../src/plugins/types.js';
import { findCoreCommand, resetCoreCommands } from '../src/commands/registry.js';
import { extensionEventTypes, type ExtensionSessionEvent } from '../src/session/extension-events.js';
import { createCoreContainer } from '../src/container.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-plugins-open-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  extensionEventTypes.reset();
  resetCoreCommands();
});
afterEach(() => {
  extensionEventTypes.reset();
  resetCoreCommands();
});

/** 写一个 fixture 插件：manifest + ESM 入口（package.json type=module） */
function writePlugin(
  root: string,
  name: string,
  opts: { manifest?: unknown; code?: string; noEntry?: boolean } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  if (opts.manifest !== undefined) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(opts.manifest, null, 2), 'utf8');
  }
  if (opts.noEntry !== true) {
    writeFileSync(join(dir, 'index.js'), opts.code ?? `export default { name: '${name}', setup() {} };\n`, 'utf8');
  }
  return dir;
}

function manifest(name: string, permissions?: PluginManifest['permissions']): PluginManifest {
  return { name, version: '1.0.0', ...(permissions !== undefined ? { permissions } : {}) };
}

const EXT_TYPE = 'harness2-demo/patch-applied';

describe('manifest 校验：扩展事件类型与 permissions.commands', () => {
  it('已注册扩展事件类型 → 放行；未注册 → 明确错误（先注册后声明，fail-closed）', () => {
    const raw = { name: 'demo', version: '1.0.0', permissions: { events: [EXT_TYPE] } };
    expect(validatePluginManifest(raw, 'demo').ok).toBe(false);
    extensionEventTypes.register({ type: EXT_TYPE, validator: (p) => typeof p['rev'] === 'string' });
    const v = validatePluginManifest(raw, 'demo');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.permissions?.events).toEqual([EXT_TYPE]);
    // 注销后回滚为拒绝（声明态跟随注册表现状）
    extensionEventTypes.unregister(EXT_TYPE);
    expect(validatePluginManifest(raw, 'demo').ok).toBe(false);
  });

  it('内建事件类型与 "*" 语义零变化（回归钉住）', () => {
    expect(
      validatePluginManifest({ name: 'demo', version: '1.0.0', permissions: { events: ['user/message', '*'] } }, 'demo')
        .ok,
    ).toBe(true);
    expect(
      validatePluginManifest({ name: 'demo', version: '1.0.0', permissions: { events: ['no/such'] } }, 'demo').ok,
    ).toBe(false);
  });

  it('permissions.commands：合法 id 名单放行；非法形态拒绝（非数组/坏 id/拼错键仍拒）', () => {
    const base = { name: 'demo', version: '1.0.0' };
    const ok = validatePluginManifest({ ...base, permissions: { commands: ['my-cmd', 'p2run'] } }, 'demo');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.permissions?.commands).toEqual(['my-cmd', 'p2run']);
    expect(validatePluginManifest({ ...base, permissions: { commands: 'all' } }, 'demo').ok).toBe(false);
    expect(validatePluginManifest({ ...base, permissions: { commands: ['BAD'] } }, 'demo').ok).toBe(false);
    expect(validatePluginManifest({ ...base, permissions: { commands: ['1lead'] } }, 'demo').ok).toBe(false);
    expect(validatePluginManifest({ ...base, permissions: { commands: ['-dash'] } }, 'demo').ok).toBe(false);
    // 无通配授权（fail-closed：命令能力必须逐 id 显式声明）
    expect(validatePluginManifest({ ...base, permissions: { commands: ['*'] } }, 'demo').ok).toBe(false);
    expect(validatePluginManifest({ ...base, permissions: { commandz: ['x'] } }, 'demo').ok).toBe(false);
  });

  it('scanPluginSources 对扩展事件声明的 manifest 给出非空 manifest（端到端）', () => {
    const root = tmpDir();
    extensionEventTypes.register({ type: EXT_TYPE, validator: () => true });
    writePlugin(root, 'ext-dep', { manifest: manifest('ext-dep', { events: [EXT_TYPE] }) });
    const sources = scanPluginSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.manifest).not.toBeNull();
    expect(sources[0]!.error).toBeUndefined();
  });
});

describe('PluginContext.registerCommand（接 coreCommandRegistry）', () => {
  it('声明内注册 → 进入分发面（source=extension）；插件卸载 → 自动注销（幂等）', async () => {
    const root = tmpDir();
    writePlugin(root, 'cmder', {
      manifest: manifest('cmder', { commands: ['plugin-echo'] }),
      code: `
        export default {
          name: 'cmder',
          setup(ctx) {
            ctx.registerCommand({
              id: 'plugin-echo',
              group: '通用',
              summary: '插件回声命令',
              run: (c, a) => c.print('echo:' + a.rest),
            });
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: () => {} });
    const report = await bus.loadAll(root, ['cmder']);
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0]!.commands).toEqual(['plugin-echo']);
    const cmd = findCoreCommand('plugin-echo');
    expect(cmd).toBeDefined();
    expect(cmd?.source).toBe('extension');
    // 宿主侧摘要同步登记
    expect(bus.summaryOf('cmder')?.commands).toEqual(['plugin-echo']);

    expect(bus.unload('cmder')).toBe(true);
    expect(findCoreCommand('plugin-echo')).toBeUndefined();
    expect(bus.unload('cmder')).toBe(false); // 幂等：不重复注销
  });

  it('未声明 permissions.commands → registerCommand 抛 PluginError → 整插件跳过（fail-closed）', async () => {
    const root = tmpDir();
    writePlugin(root, 'sneaky', {
      manifest: manifest('sneaky'), // 无任何权限声明
      code: `
        export default {
          name: 'sneaky',
          setup(ctx) {
            ctx.registerCommand({
              id: 'sneaky-cmd', group: '通用', summary: 'x', run: () => {},
            });
          },
        };
      `,
    });
    writePlugin(root, 'outoflist', {
      manifest: manifest('outoflist', { commands: ['declared-only'] }),
      code: `
        export default {
          name: 'outoflist',
          setup(ctx) {
            ctx.registerCommand({
              id: 'undeclared-cmd', group: '通用', summary: 'x', run: () => {},
            });
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: () => {} });
    const report = await bus.loadAll(root, ['outoflist', 'sneaky']);
    expect(report.loaded).toEqual([]);
    expect(report.skipped.find((s) => s.name === 'sneaky')!.reason).toContain('无权限注册命令 "sneaky-cmd"');
    expect(report.skipped.find((s) => s.name === 'outoflist')!.reason).toContain('无权限注册命令 "undeclared-cmd"');
    expect(findCoreCommand('sneaky-cmd')).toBeUndefined();
    expect(findCoreCommand('undeclared-cmd')).toBeUndefined();
  });

  it('与内建命令重名 → 该命令降级跳过 + 告警，插件不弃（对齐工具面 P2-5①）', async () => {
    const root = tmpDir();
    writePlugin(root, 'hijack', {
      manifest: manifest('hijack', { commands: ['help', 'fresh-cmd'] }),
      code: `
        export default {
          name: 'hijack',
          setup(ctx) {
            const reg = (id) => ctx.registerCommand({ id, group: '通用', summary: 'x', run: () => {} });
            try { reg('help'); ctx.log('help-allowed'); } catch (e) { ctx.log('denied:' + e.name); }
            reg('fresh-cmd');
          },
        };
      `,
    });
    const lines: string[] = [];
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    const report = await bus.loadAll(root, ['hijack']);
    // help 是内建 id：registerCoreCommand 抛错 → 降级跳过该命令；fresh-cmd 正常注册
    expect(report.loaded).toHaveLength(1);
    expect(report.loaded[0]!.commands).toEqual(['fresh-cmd']);
    expect(lines.join('\n')).toContain('命令 "help" 跳过');
    expect(lines.join('\n')).toContain('collides with builtin command');
    expect(findCoreCommand('fresh-cmd')).toBeDefined();
    // 卸载只注销插件自己的命令
    bus.unload('hijack');
    expect(findCoreCommand('fresh-cmd')).toBeUndefined();
  });

  it('插件间命令重名 → 先装载者保留，后者该命令跳过但插件仍装载', async () => {
    const root = tmpDir();
    const code = (n: string) => `
      export default {
        name: '${n}',
        setup(ctx) {
          ctx.registerCommand({ id: 'shared-cmd', group: '通用', summary: 'x', run: () => {} });
        },
      };
    `;
    writePlugin(root, 'a_first', {
      manifest: manifest('a_first', { commands: ['shared-cmd'] }),
      code: code('a_first'),
    });
    writePlugin(root, 'b_second', {
      manifest: manifest('b_second', { commands: ['shared-cmd'] }),
      code: code('b_second'),
    });
    const lines: string[] = [];
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    const report = await bus.loadAll(root, ['a_first', 'b_second']);
    expect(report.loaded.map((l) => l.name)).toEqual(['a_first', 'b_second']);
    expect(report.loaded[0]!.commands).toEqual(['shared-cmd']);
    expect(report.loaded[1]!.commands).toEqual([]);
    expect(lines.join('\n')).toContain('core command id "shared-cmd" already registered');
    bus.unload('a_first');
    expect(findCoreCommand('shared-cmd')).toBeUndefined(); // 先装载者卸载即让出
  });

  it('卸载后延迟逃逸 registerCommand → 静默拒绝 + 告警（P2-1 同防护）', async () => {
    const root = tmpDir();
    writePlugin(root, 'ghost', {
      manifest: manifest('ghost', { commands: ['late-cmd'] }),
      code: `
        export default {
          name: 'ghost',
          setup(ctx) {
            setTimeout(() => {
              ctx.registerCommand({ id: 'late-cmd', group: '通用', summary: 'x', run: () => {} });
              ctx.log('late-called');
            }, 30);
          },
        };
      `,
    });
    const lines: string[] = [];
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    await bus.loadAll(root, ['ghost']);
    bus.unload('ghost');
    await new Promise((r) => setTimeout(r, 120));
    expect(findCoreCommand('late-cmd')).toBeUndefined();
    expect(lines.join('\n')).toContain('插件已卸载，忽略延迟的 registerCommand');
    expect(lines.join('\n')).toContain('late-called');
  });
});

describe('bus 订阅与分发扩展事件类型', () => {
  function extEvent(seq: number): ExtensionSessionEvent {
    return { v: 1, seq, ts: 't', type: EXT_TYPE, payload: { rev: 'r1' } };
  }

  it('已注册类型 + 声明 → on() 成功，emitExtensionEvent 分发；未声明 → PluginError', async () => {
    extensionEventTypes.register({ type: EXT_TYPE, validator: (p) => typeof p['rev'] === 'string' });
    const root = tmpDir();
    const lines: string[] = [];
    writePlugin(root, 'watcher', {
      manifest: manifest('watcher', { events: [EXT_TYPE] }),
      code: `
        export default {
          name: 'watcher',
          setup(ctx) {
            ctx.on('${EXT_TYPE}', (f) => ctx.log('ext:' + f.event.payload.rev));
          },
        };
      `,
    });
    writePlugin(root, 'undeclared', {
      manifest: manifest('undeclared', { events: ['user/message'] }),
      code: `
        export default {
          name: 'undeclared',
          setup(ctx) {
            try { ctx.on('${EXT_TYPE}', () => {}); ctx.log('allowed'); }
            catch (e) { ctx.log('denied:' + e.name); }
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    const report = await bus.loadAll(root, ['undeclared', 'watcher']);
    expect(report.loaded.map((l) => l.name)).toEqual(['undeclared', 'watcher']);
    expect(lines).toContain('[plugin:undeclared] denied:PluginError');

    bus.emitExtensionEvent('s1', extEvent(1));
    expect(lines).toContain('[plugin:watcher] ext:r1');
    // 通配订阅也触达扩展事件
    const lines2: string[] = [];
    writePlugin(root, 'star', {
      manifest: manifest('star', { events: ['*'] }),
      code: `export default { name: 'star', setup(ctx) { ctx.on('*', (f) => ctx.log('star:' + f.event.type)); } };`,
    });
    const bus2 = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines2.push(l) });
    await bus2.loadAll(root, ['star']);
    bus2.emitExtensionEvent('s1', extEvent(2));
    expect(lines2).toContain('[plugin:star] star:' + EXT_TYPE);
  });

  it('未注册类型（即使 manifest 曾放行态）→ on() 抛 PluginError（双重 fail-closed）', async () => {
    // 构造「声明在先、注册已撤销」的 manifest：直接绕过 loader 校验走 bus 层
    const root = tmpDir();
    extensionEventTypes.register({ type: EXT_TYPE, validator: () => true });
    writePlugin(root, 'stale', { manifest: manifest('stale', { events: [EXT_TYPE] }) });
    extensionEventTypes.unregister(EXT_TYPE); // 装载前注销：装载期校验也会拒
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: () => {} });
    const report = await bus.loadAll(root, ['stale']);
    expect(report.loaded).toEqual([]);
    expect(report.skipped[0]!.reason).toContain(EXT_TYPE);
    expect(report.skipped[0]!.reason).toContain('已注册扩展类型');
  });

  it('emitSessionEvent 与 emitExtensionEvent 分发行为一致（内建事件回归零变化）', async () => {
    extensionEventTypes.register({ type: EXT_TYPE, validator: () => true });
    const root = tmpDir();
    const lines: string[] = [];
    writePlugin(root, 'both', {
      manifest: manifest('both', { events: ['user/message', EXT_TYPE] }),
      code: `
        export default {
          name: 'both',
          setup(ctx) {
            ctx.on('user/message', (f) => ctx.log('um:' + f.event.payload.text));
            ctx.on('${EXT_TYPE}', (f) => ctx.log('ext:' + f.event.payload.rev));
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    await bus.loadAll(root, ['both']);
    bus.emitSessionEvent('s', { v: 1, seq: 1, ts: 't', type: 'user/message', payload: { text: 'hi' } } as never);
    bus.emitSessionEvent('s', extEvent(3)); // 同一入口也接受扩展事件
    expect(lines).toEqual(expect.arrayContaining(['[plugin:both] um:hi', '[plugin:both] ext:r1']));
  });
});

describe('ctx.container 注入（D02 服务容器）', () => {
  it('缺省容器预置 commands/eventTypes 两内建服务；注入对象即内核单例', async () => {
    const root = tmpDir();
    writePlugin(root, 'consumer', {
      manifest: manifest('consumer'),
      code: `
        export default {
          name: 'consumer',
          setup(ctx) {
            const cmds = ctx.container.inject('commands');
            const evts = ctx.container.inject('eventTypes');
            globalThis.__cap = {
              commandNames: cmds.list().length,
              hasFind: typeof cmds.find === 'function',
              extTypes: evts.types(),
            };
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: () => {} });
    const report = await bus.loadAll(root, ['consumer']);
    expect(report.loaded).toHaveLength(1);
    const cap = (globalThis as { __cap?: Record<string, unknown> }).__cap!;
    expect(cap['commandNames']).toBeGreaterThan(0); // 内建 29 条可见
    expect(cap['hasFind']).toBe(true);
    expect(cap['extTypes']).toEqual([]);
    delete (globalThis as { __cap?: Record<string, unknown> }).__cap;
  });

  it('先注册后声明链路（跨装载批次）：a 批插件经容器注册类型，b 批声明并订阅；同批反证', async () => {
    // 语义钉住：manifest 校验取**扫描时刻**的注册表快照——同批后续插件 setup 注册的
    // 类型本批不可声明，须下一批（如 `plugin enable` 后重载）才可声明。
    const rootA = tmpDir();
    const rootB = tmpDir();
    writePlugin(rootA, 'a_reg', {
      manifest: manifest('a_reg'),
      code: `
        export default {
          name: 'a_reg',
          setup(ctx) {
            ctx.container.inject('eventTypes').register({
              type: '${EXT_TYPE}',
              validator: (p) => typeof p['rev'] === 'string',
            });
          },
        };
      `,
    });
    const writeUse = (root: string, name: string): void => {
      writePlugin(root, name, {
        manifest: manifest(name, { events: [EXT_TYPE] }),
        code: `
          export default {
            name: '${name}',
            setup(ctx) {
              ctx.on('${EXT_TYPE}', (f) => ctx.log('chain:' + f.event.payload.rev));
            },
          };
        `,
      });
    };
    writeUse(rootA, 'b_same_batch');
    writeUse(rootB, 'b_use');
    const lines: string[] = [];
    const bus = new PluginBus({ tools: new ToolRegistry(), logSink: (l) => lines.push(l) });
    // 同批反证：b_same_batch 与 a_reg 同批 → 扫描期快照校验拒（类型尚未注册）
    const reportA = await bus.loadAll(rootA, ['a_reg', 'b_same_batch']);
    expect(reportA.loaded.map((l) => l.name)).toEqual(['a_reg']);
    expect(reportA.skipped[0]!.name).toBe('b_same_batch');
    expect(reportA.skipped[0]!.reason).toContain('未认可的事件');
    // 跨批：a_reg 已完成 setup → 类型已注册 → b_use 声明与订阅放行
    const reportB = await bus.loadAll(rootB, ['b_use']);
    expect(reportB.loaded.map((l) => l.name)).toEqual(['b_use']);
    bus.emitExtensionEvent('s', { v: 1, seq: 1, ts: 't', type: EXT_TYPE, payload: { rev: 'ok' } });
    expect(lines).toContain('[plugin:b_use] chain:ok');
  });

  it('宿主自有容器优先注入；容器是宿主作用域——bus.dispose 不销毁容器', async () => {
    const host = createCoreContainer();
    let probed = false;
    host.register('probe', () => ({ tag: 'probe-svc' }));
    const root = tmpDir();
    writePlugin(root, 'user', {
      manifest: manifest('user'),
      code: `
        export default {
          name: 'user',
          setup(ctx) {
            globalThis.__probe = ctx.container.inject('probe').tag;
            globalThis.__commands = ctx.container.inject('commands').list().length;
          },
        };
      `,
    });
    const bus = new PluginBus({ tools: new ToolRegistry(), container: host, logSink: () => {} });
    await bus.loadAll(root, ['user']);
    const g = globalThis as { __probe?: string; __commands?: number };
    expect(g.__probe).toBe('probe-svc');
    expect(g.__commands).toBeGreaterThan(0);
    bus.dispose();
    // 容器不被 bus 销毁：宿主自有服务仍可注入
    expect(host.inject('probe')).toEqual({ tag: 'probe-svc' });
    probed = host.names().includes('probe');
    expect(probed).toBe(true);
    delete g.__probe;
    delete g.__commands;
  });

  it('describePermissions 呈现 commands 声明（审批面可见）', () => {
    expect(describePermissions(manifest('x', { commands: ['a-b', 'c-d'] }))).toBe(
      'tools=无 events=无 cron=无 commands=[a-b, c-d]',
    );
  });
});
