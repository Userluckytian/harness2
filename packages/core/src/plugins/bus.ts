// 插件总线（阶段 8；批次4 A10 消费三开放）：把插件能力接进宿主——工具注册进
// ToolRegistry、命令注册进 coreCommandRegistry、事件订阅走内存事件总线（内建 + 已注册
// 扩展类型）、日志带插件前缀、config 只读快照、容器注入（D02 服务容器）。
// 装载审批（allow 名单）在本层执行：manifest 合法且 allow 含插件名 → 装载；否则跳过 +
// 告警（`plugin enable` 审批后写入 allow）。
// 生命周期：每插件按获取顺序登记 disposer，卸载 = 逆序展开；单插件失败（导入/setup/
// 权限/重名）收口为「跳过 + 告警」，不拖垮其他插件与宿主进程（v1 进程内非隔离的边界
// 见 plugins/types.ts 头注释）。**命令/容器生命周期立场**：插件级清理走插件自身
// disposer 链（registerCommand 的 disposer = unregisterCoreCommand，unload 逆序展开时
// 执行）；容器是宿主作用域（随宿主创建/销毁），bus 不 dispose 容器——容器的
// dispose/disposeAll 语义归宿主装配层（见 plugins/types.ts PluginContext.container）。
import { isSessionEventType } from '../session/types.js';
import type { AnySessionEvent } from '../session/types.js';
import type { ExtensionSessionEvent } from '../session/extension-events.js';
import { extensionEventTypes } from '../session/extension-events.js';
import { createCoreContainer, type ServiceContainer } from '../container.js';
import { coreCommandRegistry, type CoreCommandRegistration } from '../commands/registry.js';
import type { HarnessConfig } from '../config/schema.js';
import type { ToolDefinition } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { importPluginModule, scanPluginSources } from './loader.js';
import {
  PluginError,
  type PluginContext,
  type PluginEventFrame,
  type PluginEventHandler,
  type PluginManifest,
} from './types.js';

export interface PluginBusOptions {
  /** 插件工具注册进该注册表（本地工具先注册——重名即拒绝，天然本地优先） */
  tools: ToolRegistry;
  /** 宿主配置快照：ctx.config() 返回深冻结拷贝 */
  config?: HarnessConfig;
  /** 插件日志 sink（缺省 console.error，避免污染 serve stdout 的启动 JSON） */
  logSink?: (line: string) => void;
  /**
   * D02 服务容器（批次4 加性）：注入宿主自有容器；缺省 = createCoreContainer()
   * （预置 'commands' / 'eventTypes' 两内建服务）。宿主作用域：bus 不负责其销毁。
   */
  container?: ServiceContainer;
}

/** 成功装载的插件摘要 */
export interface LoadedPluginSummary {
  name: string;
  dir: string;
  version: string;
  /** 实际注册成功的工具名（manifest 权限内、且未被占用） */
  tools: string[];
  /** 实际注册成功的命令 id（批次4 加性；manifest 权限内、且未与他者冲突） */
  commands: string[];
}

/** 装载批次报告：loaded/skipped 互斥；warnings = 面向用户的一行告警（已脱敏前提：不含密钥） */
export interface PluginLoadReport {
  loaded: LoadedPluginSummary[];
  skipped: Array<{ name: string; reason: string }>;
  warnings: string[];
}

interface PluginRecord {
  name: string;
  dir: string;
  manifest: PluginManifest;
  /** 依获取顺序登记的 disposer（卸载时逆序展开） */
  disposers: Array<() => void>;
  toolNames: string[];
  /** 实际注册成功的命令 id（与 disposers 未必对齐——冲突降级时不入此表） */
  commandNames: string[];
}

interface EventSubscription {
  plugin: string;
  event: string;
  handler: PluginEventHandler;
}

/** 深冻结只读拷贝（structuredClone + 逐层 freeze；config 为纯 JSON 数据） */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

export class PluginBus {
  private readonly records = new Map<string, PluginRecord>();
  /** 事件名 → 订阅集（'*' 通配单独成键；分发按 精确类型 + '*' 两路） */
  private readonly subscriptions = new Map<string, Set<EventSubscription>>();
  private readonly frozenConfig: Readonly<HarnessConfig> | undefined;
  private readonly logSink: (line: string) => void;
  private readonly container: ServiceContainer;
  private disposed = false;

  constructor(private readonly options: PluginBusOptions) {
    this.frozenConfig = options.config !== undefined ? deepFreeze(structuredClone(options.config)) : undefined;
    this.logSink = options.logSink ?? ((line: string) => console.error(line));
    // 容器注入面（批次4）：宿主自有容器优先；缺省 createCoreContainer（预置两内建服务）。
    // 宿主作用域：bus 不 dispose（理由见文件头与 PluginContext.container 注释）。
    this.container = options.container ?? createCoreContainer();
  }

  /** 已装载插件名（装载顺序） */
  loadedNames(): string[] {
    return [...this.records.keys()];
  }

  /** 单插件摘要（诊断/CLI 展示） */
  summaryOf(name: string): LoadedPluginSummary | undefined {
    const r = this.records.get(name);
    return r
      ? {
          name: r.name,
          dir: r.dir,
          version: r.manifest.version,
          tools: [...r.toolNames],
          commands: [...r.commandNames],
        }
      : undefined;
  }

  /**
   * 装载批次：扫描 root → manifest 合法 + allow 含名 → import + setup。
   * 逐插件独立收口（skip 不断批）；allow 名单里有但磁盘不存在的插件记告警（审批结果与
   * 实际文件的漂移可见）。重复调用（如测试/重载）不会重复装载同名插件（跳过并告警）。
   */
  async loadAll(root: string, allow: readonly string[]): Promise<PluginLoadReport> {
    if (this.disposed) {
      return { loaded: [], skipped: [], warnings: ['插件总线已卸载，忽略本次装载'] };
    }
    const report: PluginLoadReport = { loaded: [], skipped: [], warnings: [] };
    const allowSet = new Set(allow);
    let sources;
    try {
      sources = scanPluginSources(root);
    } catch (e) {
      report.warnings.push(`插件目录扫描失败（已跳过全部插件）: ${(e as Error).message}`);
      return report;
    }
    const onDisk = new Set(sources.map((s) => s.name));
    for (const name of allowSet) {
      if (!onDisk.has(name)) {
        report.warnings.push(`plugins.allow 中的 "${name}" 在 ${root} 下不存在（跳过）`);
      }
    }
    for (const source of sources) {
      const skip = (reason: string): void => {
        report.skipped.push({ name: source.name, reason });
        report.warnings.push(`插件 "${source.name}" 跳过: ${reason}`);
      };
      if (source.manifest === null) {
        skip(source.error ?? 'manifest 非法');
        continue;
      }
      if (!allowSet.has(source.name)) {
        // 装载审批：不在 allow 一律跳过（`harness2 plugin enable <name>` 审批后写入 allow）
        skip(`未经装载审批（不在 config.plugins.allow）——声明的权限: ${describePermissions(source.manifest)}`);
        continue;
      }
      if (this.records.has(source.name)) {
        skip('已装载（同名插件不重复装载）');
        continue;
      }
      const record: PluginRecord = {
        name: source.name,
        dir: source.dir,
        manifest: source.manifest,
        disposers: [],
        toolNames: [],
        commandNames: [],
      };
      try {
        const mod = await importPluginModule(source.dir, source.manifest.name);
        const ctx = this.createContext(record);
        // P2-1：先登记再 setup——setup 期间的 registerTool/on 走同一存活检查
        //（此后 unload/dispose 的延迟逃逸调用才会被拒绝）
        this.records.set(source.name, record);
        await mod.setup(ctx);
        report.loaded.push({
          name: source.name,
          dir: source.dir,
          version: source.manifest.version,
          tools: [...record.toolNames],
          commands: [...record.commandNames],
        });
      } catch (e) {
        // setup 半途失败：摘除登记 + 展开已获取的 disposer（不留半装载状态），再收口为跳过
        this.records.delete(source.name);
        this.unwind(record);
        this.removeSubscriptions(source.name);
        skip(
          e instanceof PluginError
            ? e.message
            : `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }
    return report;
  }

  /**
   * 会话事件分发入口（装配层把 hub onEvent 钩子接到这里）：精确类型 + '*' 两路，逐 handler 异常隔离。
   * 批次4 放宽：已注册的扩展事件类型同入口分发（宿主把 writer.appendExtension 的产物
   * 喂进来即可；内建事件的现有调用零变化）。
   */
  emitSessionEvent(sessionId: string, event: AnySessionEvent | ExtensionSessionEvent): void {
    for (const key of [event.type, '*']) {
      const subs = this.subscriptions.get(key);
      if (subs === undefined) continue;
      const frame: PluginEventFrame = { sessionId, event };
      for (const sub of [...subs]) {
        try {
          sub.handler(frame);
        } catch {
          // 单 handler 异常不阻断其他订阅者与内核
        }
      }
    }
  }

  /** 扩展事件分发别名（emitSessionEvent 的语义化入口；分发行为完全一致） */
  emitExtensionEvent(sessionId: string, event: ExtensionSessionEvent): void {
    this.emitSessionEvent(sessionId, event);
  }

  /** 卸载单个插件：disposer 逆序展开 + 订阅清理；返回是否确有装载 */
  unload(name: string): boolean {
    const record = this.records.get(name);
    if (record === undefined) return false;
    this.records.delete(name);
    this.unwind(record);
    this.removeSubscriptions(name);
    return true;
  }

  /**
   * 宿主装配层收回某插件已注册的工具（P1-3：插件抢占 subagent 等权威工具名时，
   * CLI 在重挂权威版之前剔除插件版本，而不是让重名 throw 崩掉 chat）。
   * 仅首个持有该名的插件生效（同一工具名只会被一个插件成功注册）；返回是否确有收回。
   */
  revokeTool(name: string): boolean {
    for (const record of this.records.values()) {
      const i = record.toolNames.indexOf(name);
      if (i < 0) continue;
      const disposer = record.disposers[i];
      // 先摘记账再展开：与插件自 dispose 的语义一致（unload 时不重复展开）
      record.disposers.splice(i, 1);
      record.toolNames.splice(i, 1);
      if (disposer !== undefined) {
        try {
          disposer();
        } catch {
          // 收回失败按未收回处理（调用方保持降级路径）
          return false;
        }
      }
      this.logSink(`[plugin:${record.name}] 工具 "${name}" 被宿主收回（权威实现优先）`);
      return true;
    }
    return false;
  }

  /** 全量卸载（serve/chat 关闭路径）：装载顺序的逆序逐插件展开 */
  dispose(): void {
    this.disposed = true;
    for (const name of [...this.records.keys()].reverse()) {
      this.unload(name);
    }
  }

  // —— 内部 ——

  private unwind(record: PluginRecord): void {
    for (const dispose of [...record.disposers].reverse()) {
      try {
        dispose();
      } catch {
        // disposer 异常不阻断其余展开
      }
    }
    record.disposers.length = 0;
  }

  private removeSubscriptions(plugin: string): void {
    for (const subs of this.subscriptions.values()) {
      for (const sub of [...subs]) {
        if (sub.plugin === plugin) subs.delete(sub);
      }
    }
  }

  private createContext(record: PluginRecord): PluginContext {
    const bus = this;
    const perms = record.manifest.permissions ?? {};
    const pluginName = record.name;
    // P2-1 存活检查：registerTool/on 在插件卸载（unload/dispose）后被延迟调用（setTimeout
    // 等异步逃逸）时静默拒绝 + 告警，返回 no-op disposer——杜绝「已卸载插件仍能把工具/
    // 订阅残留进宿主」。选「静默拒绝」而非抛 PluginError：逃逸调用发生在宿主无法捕获的
    // 异步回调里，抛错会变成 uncaught exception 拖垮主进程（与单插件失败不拖垮宿主矛盾）。
    const alive = (): boolean => !bus.disposed && bus.records.get(pluginName) === record;
    return {
      registerTool(def: ToolDefinition): () => void {
        if (!alive()) {
          bus.logSink(`[plugin:${pluginName}] 插件已卸载，忽略延迟的 registerTool("${def.name}") 调用（逃逸防护）`);
          return () => {};
        }
        const allowed = perms.tools === true || (Array.isArray(perms.tools) && perms.tools.includes(def.name));
        if (!allowed) {
          throw new PluginError(
            `无权限注册工具 "${def.name}"（manifest.permissions.tools 未授权${Array.isArray(perms.tools) ? `: [${perms.tools.join(', ')}]` : ''}）`,
          );
        }
        let disposer: () => void;
        try {
          disposer = bus.options.tools.register(def);
        } catch (e) {
          // P2-5①：单工具重名/非法名 → 降级为跳过该工具 + 告警，不弃整插件（对齐计划
          // 「冲突告警不中断」；本地工具先注册 = 本地优先语义保持）
          bus.logSink(
            `[plugin:${pluginName}] 工具 "${def.name}" 跳过（与既有工具冲突或名称非法）: ${(e as Error).message}`,
          );
          return () => {};
        }
        record.disposers.push(disposer);
        record.toolNames.push(def.name);
        return () => {
          disposer();
          // 插件自Dispose：从记账移除（unload 时不再重复展开）
          const i = record.disposers.indexOf(disposer);
          if (i >= 0) record.disposers.splice(i, 1);
          const t = record.toolNames.indexOf(def.name);
          if (t >= 0) record.toolNames.splice(t, 1);
        };
      },
      on(event: string, handler: PluginEventHandler): () => void {
        if (!alive()) {
          bus.logSink(`[plugin:${pluginName}] 插件已卸载，忽略延迟的 on("${event}") 订阅（逃逸防护）`);
          return () => {};
        }
        if (event !== '*' && !isSessionEventType(event) && !extensionEventTypes.has(event)) {
          throw new PluginError(`未知事件类型 "${event}"（必须是已知会话事件类型、已注册扩展类型或 '*'）`);
        }
        const allowed = Array.isArray(perms.events) && (perms.events.includes(event) || perms.events.includes('*'));
        if (!allowed) {
          throw new PluginError(
            `无权限订阅事件 "${event}"（manifest.permissions.events 未授权${Array.isArray(perms.events) ? `: [${perms.events.join(', ')}]` : ''}）`,
          );
        }
        const sub: EventSubscription = { plugin: pluginName, event, handler };
        let set = bus.subscriptions.get(event);
        if (set === undefined) {
          set = new Set();
          bus.subscriptions.set(event, set);
        }
        set.add(sub);
        const disposer = (): void => {
          set!.delete(sub);
        };
        record.disposers.push(disposer);
        return () => {
          disposer();
          const i = record.disposers.indexOf(disposer);
          if (i >= 0) record.disposers.splice(i, 1);
        };
      },
      log(message: string): void {
        bus.logSink(`[plugin:${pluginName}] ${message}`);
      },
      config(): Readonly<HarnessConfig> {
        if (bus.frozenConfig === undefined) {
          throw new PluginError('宿主未提供配置快照（ctx.config 不可用）');
        }
        return bus.frozenConfig;
      },
      registerCommand(cmd: CoreCommandRegistration): () => void {
        if (!alive()) {
          bus.logSink(`[plugin:${pluginName}] 插件已卸载，忽略延迟的 registerCommand("${cmd?.id}") 调用（逃逸防护）`);
          return () => {};
        }
        const declared = perms.commands;
        const allowed = Array.isArray(declared) && declared.includes(cmd.id);
        if (!allowed) {
          throw new PluginError(
            `无权限注册命令 "${cmd?.id}"（manifest.permissions.commands 未授权${Array.isArray(declared) ? `: [${declared.join(', ')}]` : ''}）`,
          );
        }
        try {
          coreCommandRegistry.register(cmd);
        } catch (e) {
          // 对齐工具面的 P2-5①：单命令重名/非法 → 降级为跳过该命令 + 告警，不弃整插件
          bus.logSink(
            `[plugin:${pluginName}] 命令 "${cmd.id}" 跳过（与内建/既有命令冲突或名称非法）: ${(e as Error).message}`,
          );
          return () => {};
        }
        const commandDisposer = (): void => {
          coreCommandRegistry.unregister(cmd.id);
        };
        record.disposers.push(commandDisposer);
        record.commandNames.push(cmd.id);
        return () => {
          commandDisposer();
          // 插件自卸载命令：从记账移除（unload 时不再重复展开）
          const d = record.disposers.indexOf(commandDisposer);
          if (d >= 0) record.disposers.splice(d, 1);
          const c = record.commandNames.indexOf(cmd.id);
          if (c >= 0) record.commandNames.splice(c, 1);
        };
      },
      container: bus.container,
    };
  }
}

/** 权限清单的人类可读形态（审批/CLI 展示与告警共用） */
export function describePermissions(manifest: PluginManifest): string {
  const p = manifest.permissions ?? {};
  const parts: string[] = [];
  parts.push(p.tools === undefined ? 'tools=无' : p.tools === true ? 'tools=全部' : `tools=[${p.tools.join(', ')}]`);
  parts.push(p.events === undefined ? 'events=无' : `events=[${p.events.join(', ')}]`);
  parts.push(p.cron === true ? 'cron=预留声明' : 'cron=无');
  parts.push(p.commands === undefined ? 'commands=无' : `commands=[${p.commands.join(', ')}]`);
  return parts.join(' ');
}
