// 服务容器（D02 内核可扩展性第三开放）：轻量类型化容器，语义按 DECISIONS D02 的
// `inject / apply / dispose` 定形——语义参照 refs-deepseek-harness D-30（注册表：拒重复 key、
// 保注册顺序、幂等 disposer）与 D-02（功能包经注入点挂服务），**不引 Cordis 运行时**。
//
// 与前两步的关系（对齐 D02「统一注册表 + 服务容器」）：命令注册表（coreCommandRegistry）
// 与扩展事件类型注册表（extensionEventTypes）作为两个内建服务经 createCoreContainer 挂入；
// core 现有 server/*（hub/serve）不强制迁移（渐进路线登记为后续批次），本轮只保证容器
// 可用且两注册表经容器可取。
//
// 语义契约：
//   register  —— 重名/非法名/非法 factory 一律抛错（fail-closed）；记录注册顺序；
//   inject    —— 惰性单例（首次注入才建实例）；未知服务抛错；工厂执行期间环检测，
//                循环依赖抛错并给出 a → b → a 链路；
//   apply     —— 扩展挂载点：对服务实例（惰性实例化）执行 ext，ext 返回的清理函数
//                记录在服务名下，dispose 时按挂载逆序执行；挂载一次性消费（dispose 后
//                再 inject 得到的是未挂扩展的新实例）；
//   dispose   —— 单服务清理：先按挂载逆序执行扩展清理，再执行注册时的服务 disposer，
//                然后清掉实例（注册保留，下次 inject 重建惰性单例）；未实例化 = 无操作
//                （幂等）；未知服务抛错；
//   disposeAll—— 按注册逆序逐个 dispose（只对已实例化服务实际执行清理）。
import { coreCommandRegistry } from './commands/registry.js';
import { extensionEventTypes } from './session/extension-events.js';

/** 服务工厂：惰性实例化入口（拿到容器本身，可在工厂内 inject 其它服务） */
export type ServiceFactory<T> = (container: ServiceContainer) => T;

/** 服务清理器（dispose 时在扩展清理之后执行） */
export type ServiceDisposer<T> = (service: T) => void;

/** 扩展挂载器：对服务实例做增强/观察；返回清理函数（可选）随 dispose 逆序执行 */
export type ServiceExtension<T> = (service: T, container: ServiceContainer) => void | (() => void);

interface ExtensionRecord {
  cleanup?: () => void;
}

export class ServiceContainer {
  private readonly factories = new Map<string, ServiceFactory<unknown>>();
  private readonly disposers = new Map<string, ServiceDisposer<unknown>>();
  private readonly instances = new Map<string, unknown>();
  private readonly extensions = new Map<string, ExtensionRecord[]>();
  /** 注册顺序（disposeAll 逆序清理的依据） */
  private readonly order: string[] = [];
  /** 环检测：当前工厂执行链（inject 栈） */
  private resolving: string[] = [];

  /** 注册服务；重名/非法名/非法 factory 一律抛错（fail-closed） */
  register<T>(name: string, factory: ServiceFactory<T>, dispose?: ServiceDisposer<T>): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`invalid service name: ${String(name)}`);
    }
    if (typeof factory !== 'function') {
      throw new Error(`service ${name}: factory must be a function`);
    }
    if (this.factories.has(name)) {
      throw new Error(`service already registered: ${name}（fail-closed，不做覆盖）`);
    }
    this.factories.set(name, factory as ServiceFactory<unknown>);
    if (dispose !== undefined) this.disposers.set(name, dispose as ServiceDisposer<unknown>);
    this.order.push(name);
  }

  /** 惰性单例注入：首次注入执行工厂，之后返回同一实例；未知服务/循环依赖抛错 */
  inject<T>(name: string): T {
    if (this.instances.has(name)) return this.instances.get(name) as T;
    const factory = this.factories.get(name);
    if (factory === undefined) {
      throw new Error(`unknown service: ${name}（先经 register 注册）`);
    }
    if (this.resolving.includes(name)) {
      throw new Error(`circular service dependency: ${[...this.resolving, name].join(' → ')}`);
    }
    this.resolving.push(name);
    try {
      const instance = (factory as ServiceFactory<unknown>)(this);
      this.instances.set(name, instance);
      return instance as T;
    } finally {
      this.resolving.pop();
    }
  }

  /** 扩展挂载点：对服务实例执行 ext（未实例化则先惰性实例化）；返回的清理函数随 dispose 逆序执行 */
  apply<T>(name: string, ext: ServiceExtension<T>): void {
    if (typeof ext !== 'function') {
      throw new Error(`service ${name}: extension must be a function`);
    }
    const service = this.inject<T>(name);
    const cleanup = ext(service, this);
    const list = this.extensions.get(name) ?? [];
    list.push(cleanup !== undefined ? { cleanup } : {});
    this.extensions.set(name, list);
  }

  /**
   * 单服务清理：挂载扩展清理（逆序）→ 服务 disposer → 清实例（注册保留，可再注入）。
   * 未实例化 = 无操作（幂等）；未知服务抛错（fail-closed）。
   */
  dispose(name: string): void {
    if (!this.factories.has(name)) {
      throw new Error(`unknown service: ${name}`);
    }
    if (!this.instances.has(name)) return;
    const records = this.extensions.get(name) ?? [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      records[i]?.cleanup?.();
    }
    const disposer = this.disposers.get(name);
    if (disposer !== undefined) disposer(this.instances.get(name));
    this.instances.delete(name);
    // 挂载一次性消费：dispose 后再注入的是未挂扩展的新实例（语义见文件头）
    this.extensions.set(name, []);
  }

  /** 全量清理：按注册逆序逐个 dispose（未实例化的服务为无操作） */
  disposeAll(): void {
    for (const name of [...this.order].reverse()) {
      this.dispose(name);
    }
  }

  /** 已注册服务名（注册顺序） */
  names(): readonly string[] {
    return [...this.order];
  }
}

/** createCoreContainer 预置的内建服务名 */
export const CORE_SERVICE_NAMES = {
  /** core 命令注册表门面（CoreCommandRegistryService：register/unregister/list/find） */
  commands: 'commands',
  /** 扩展事件类型注册表（ExtensionEventTypeRegistry：扩展事件类型注册/注销/查询） */
  eventTypes: 'eventTypes',
} as const;

/**
 * 构造预置两个内建服务的容器（D02「统一注册表 + 服务容器」）：
 *   - 'commands'   → coreCommandRegistry（命令注册开放化的门面，单例对象）
 *   - 'eventTypes' → extensionEventTypes（扩展事件类型注册表进程级单例）
 * 两服务均为既有模块级单例的门面/本体，容器只做挂载不做再造；core 现有 server/*
 * 不强制迁移（渐进路线见文件头）。
 */
export function createCoreContainer(): ServiceContainer {
  const container = new ServiceContainer();
  // 挂载对象经静态 import 引入（依赖方向：container → commands/registry、
  // session/extension-events，两者都不依赖本模块，无环）；容器只做挂载不做再造。
  container.register(CORE_SERVICE_NAMES.commands, () => coreCommandRegistry);
  container.register(CORE_SERVICE_NAMES.eventTypes, () => extensionEventTypes);
  return container;
}
