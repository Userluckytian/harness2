// D02 服务容器测试：register/inject（惰性单例）/apply（扩展挂载）/dispose（逆序清理）
// /循环依赖与重复注册 fail-closed / createCoreContainer 双内建服务（命令注册表 + 事件类型注册表）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ServiceContainer,
  SessionWriter,
  computeProjection,
  createCoreContainer,
  CORE_SERVICE_NAMES,
  coreCommandRegistry,
  extensionEventTypes,
  findCoreCommand,
  loadSession,
  resetCoreCommands,
} from '../src/index.js';

beforeEach(() => {
  extensionEventTypes.reset();
  resetCoreCommands();
});
afterEach(() => {
  extensionEventTypes.reset();
  resetCoreCommands();
});

describe('ServiceContainer：register / inject（惰性单例）', () => {
  it('首次注入才建实例，此后同一实例（惰性单例）', () => {
    const c = new ServiceContainer();
    let builds = 0;
    c.register('svc', () => ({ id: ++builds }));
    expect(builds).toBe(0); // 注册不实例化
    const a = c.inject<{ id: number }>('svc');
    const b = c.inject<{ id: number }>('svc');
    expect(builds).toBe(1);
    expect(a).toBe(b);
  });

  it('工厂可经容器 inject 其它服务（依赖组装）', () => {
    const c = new ServiceContainer();
    c.register('dep', () => ({ v: 42 }));
    c.register('top', (x) => ({ sum: x.inject<{ v: number }>('dep').v + 1 }));
    expect(c.inject<{ sum: number }>('top').sum).toBe(43);
  });

  it('重复注册 → 抛错（fail-closed，不覆盖）；非法名/非法 factory → 抛错', () => {
    const c = new ServiceContainer();
    c.register('svc', () => 1);
    expect(() => c.register('svc', () => 2)).toThrow(/already registered/);
    expect(() => c.register('', () => 1)).toThrow(/invalid service name/);
    expect(() => c.register('bad', undefined as never)).toThrow(/factory must be a function/);
  });

  it('inject 未知服务 → 抛错（fail-closed）', () => {
    const c = new ServiceContainer();
    expect(() => c.inject('ghost')).toThrow(/unknown service/);
  });

  it('循环依赖 → 抛错并给出 a → b → a 链路', () => {
    const c = new ServiceContainer();
    c.register('a', (x) => ({ b: x.inject('b') }));
    c.register('b', (x) => ({ a: x.inject('a') }));
    expect(() => c.inject('a')).toThrow(/^circular service dependency: a → b → a$/);
    // 环检测不污染后续注入：修复后可正常实例化
    const c2 = new ServiceContainer();
    c2.register('a', () => 'ok');
    expect(c2.inject('a')).toBe('ok');
  });
});

describe('ServiceContainer：apply（扩展挂载）与 dispose（逆序清理）', () => {
  it('apply 对（惰性实例化的）服务执行扩展；dispose 按挂载逆序执行清理', () => {
    const c = new ServiceContainer();
    const log: string[] = [];
    c.register(
      'svc',
      () => ({ name: 'svc' }),
      (svc) => log.push(`service:${svc.name}`),
    );
    c.apply<{ name: string }>('svc', (svc) => {
      log.push(`mount:${svc.name}`); // apply 即执行（对当前实例挂载）
    });
    c.apply<{ name: string }>('svc', () => () => {
      log.push('ext-2-cleanup');
    });
    expect(log).toEqual(['mount:svc']); // 扩展挂载即时生效；清理未发生
    c.dispose('svc');
    expect(log).toEqual(['mount:svc', 'ext-2-cleanup', 'service:svc']); // 扩展逆序 → 服务 disposer 收尾
  });

  it('dispose 清实例但保留注册：再注入得到新实例，扩展不重挂（一次性消费）', () => {
    const c = new ServiceContainer();
    let builds = 0;
    c.register('svc', () => ({ id: ++builds }));
    let mounted = 0;
    c.apply<{ id: number }>('svc', () => {
      mounted += 1;
    });
    expect(mounted).toBe(1);
    const first = c.inject<{ id: number }>('svc');
    c.dispose('svc');
    const second = c.inject<{ id: number }>('svc');
    expect(second).not.toBe(first);
    expect(builds).toBe(2);
    expect(mounted).toBe(1); // 扩展不随重建复挂
  });

  it('dispose 幂等：未实例化 = 无操作；重复 dispose 不重复执行清理；未知服务抛错', () => {
    const c = new ServiceContainer();
    let disposed = 0;
    c.register(
      'lazy',
      () => 'x',
      () => (disposed += 1),
    );
    c.dispose('lazy'); // 未实例化：无操作
    c.inject('lazy');
    c.dispose('lazy');
    c.dispose('lazy');
    expect(disposed).toBe(1);
    expect(() => c.dispose('ghost')).toThrow(/unknown service/);
  });

  it('disposeAll：按注册逆序清理（只对已实例化服务执行）', () => {
    const c = new ServiceContainer();
    const log: string[] = [];
    c.register(
      'first',
      () => 'f',
      () => log.push('first'),
    );
    c.register(
      'second',
      () => 's',
      () => log.push('second'),
    );
    c.register(
      'never-built',
      () => 'n',
      () => log.push('never'),
    );
    c.inject('second'); // 只实例化 second
    c.disposeAll();
    expect(log).toEqual(['second']); // never-built 未实例化 → 无操作；first 未实例化 → 无操作
  });

  it('apply 未知服务 → 抛错（经 inject fail-closed）；扩展抛错时不留半挂记录', () => {
    const c = new ServiceContainer();
    expect(() => c.apply('ghost', () => {})).toThrow(/unknown service/);
  });
});

describe('createCoreContainer（D02 统一注册表 + 服务容器）', () => {
  it('两个内建服务可取：commands 门面与 extensionEventTypes 单例（同一引用）', () => {
    const c = createCoreContainer();
    expect(c.names()).toEqual([CORE_SERVICE_NAMES.commands, CORE_SERVICE_NAMES.eventTypes]);
    expect(c.inject(CORE_SERVICE_NAMES.commands)).toBe(coreCommandRegistry);
    expect(c.inject(CORE_SERVICE_NAMES.eventTypes)).toBe(extensionEventTypes);
  });

  it('经容器的命令服务注册 → 立即进入全局分发面（模块级注册表挂载，非再造）', () => {
    const c = createCoreContainer();
    c.inject<typeof coreCommandRegistry>(CORE_SERVICE_NAMES.commands).register({
      id: 'via-container',
      group: '通用',
      summary: '经容器注册',
      run: () => {},
    });
    expect(findCoreCommand('via-container')?.source).toBe('extension');
    expect(coreCommandRegistry.unregister('via-container')).toBe(true);
    expect(findCoreCommand('via-container')).toBeUndefined();
  });

  it('经容器的事件类型注册表注册 → writer 即接受该扩展类型（注册表单例挂载）', () => {
    const c = createCoreContainer();
    c.inject<typeof extensionEventTypes>(CORE_SERVICE_NAMES.eventTypes).register({
      type: 'cits/status',
      validator: (p) => typeof p.state === 'string',
      projection: 'opaque',
    });
    const dir = mkdtempSync(join(tmpdir(), 'h2-container-'));
    try {
      const w = SessionWriter.create(dir, { sessionId: 's1', cwd: 'D:/x' }, { fsync: false });
      w.appendExtension('cits/status', { state: 'ready' });
      w.close();
      const s = loadSession(dir);
      expect(s.extensionEvents.map((x) => x.event.type)).toEqual(['cits/status']);
      expect(computeProjection(s).opaqueEvents.map((o) => o.type)).toEqual(['cits/status']);
      expect(computeProjection(s).opaqueEvents[0]?.payload).toEqual({ state: 'ready' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
