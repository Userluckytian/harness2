/**
 * host-sampling —— adapter host 进程对 ZCode 原生资源管理器采样协议的应答实现。
 *
 * 协议形状严格照 `@zcode/shared`：
 *   main → host : `{ type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId }`
 *   main → host : `{ type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId }`
 *   host → main : `{ type: HostResponseTypes.ResourceUsageSnapshotResult, requestId, sampledAt, processes }`
 *
 * 设计要点：
 * - 纯函数 + 注入缝：采样（process.cpuUsage 差分 / process.memoryUsage）与协议编解码均在此文件；
 *   parentPort 只要求 EventEmitter 形状（on/postMessage），单测不依赖 Electron。
 * - CPU：两次 process.cpuUsage() 差分 / 墙钟 / 逻辑核数归一（整机归一化百分比）；
 *   首次快照无前值 → 0（保守值，避免虚高）。
 * - 内存：process.memoryUsage().rss（字节）。
 * - 取消：仅当请求仍处于未回帖状态时生效；已回帖后忽略。
 * - 未知消息类型：静默忽略，不抛，不干扰 InitLocal/DatabaseStartup/ChannelServer 流程。
 * - 出口全过 redactSecrets：name/groupKey/groupLabel 等自由文本字段一律脱敏。
 */
import os from 'node:os';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { HostMessageTypes, HostResponseTypes, formatZCodeHostProcessName } from '@zcode/shared';
import { redactSecrets } from './core-bridge.js';

export interface HostSamplingPort {
  on(event: 'message', listener: (event: unknown) => void): unknown;
  off?(event: 'message', listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: 'message', listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): unknown;
}

export interface HostSamplingOptions {
  /** 注入 CPU 读数（默认 process.cpuUsage） */
  cpuUsage?: () => NodeJS.CpuUsage;
  /** 注入内存读数（默认 process.memoryUsage） */
  memoryUsage?: () => NodeJS.MemoryUsage;
  /** 注入时钟（默认 Date.now） */
  now?: () => number;
  /** 逻辑核数（默认 os.cpus().length） */
  logicalCpuCount?: number;
  /** 进程显示名（默认按 ZCODE_PROCESS_LABEL 推导，照抄 ZCode 原 host 取值习惯） */
  hostName?: string;
  /** 进程 pid（默认 process.pid） */
  pid?: number;
  /** 脱敏函数（默认 core.redactSecrets） */
  redact?: (text: string) => string;
}

export interface HostSamplingProcessRow {
  pid: number;
  name: string;
  category: 'base' | 'builtin-plugin' | 'community-plugin';
  groupKey: string;
  groupLabel: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface HostSamplingResponse {
  type: string;
  requestId: string;
  sampledAt: number;
  processes: HostSamplingProcessRow[];
}

interface PendingToken {
  cancelled: boolean;
}

export interface HostSamplingController {
  port: HostSamplingPort;
  sample: () => HostSamplingProcessRow;
  handleRequest: (requestId: string) => void;
  cancelRequest: (requestId: string) => void;
  handleMessage: (raw: unknown) => boolean;
  handle: (raw: unknown) => boolean;
  onMessage: (raw: unknown) => boolean;
  dispose: () => void;
}

interface SamplerState {
  previousCpu: NodeJS.CpuUsage | undefined;
  previousTime: number | undefined;
}

export function createHostSamplingSampler(options: HostSamplingOptions = {}) {
  const cpuUsageFn = options.cpuUsage ?? (() => process.cpuUsage());
  const memoryUsageFn = options.memoryUsage ?? (() => process.memoryUsage());
  const nowFn = options.now ?? (() => Date.now());
  const logicalCores =
    typeof options.logicalCpuCount === 'number' && options.logicalCpuCount > 0
      ? options.logicalCpuCount
      : os.cpus().length || 1;
  const redact = options.redact ?? redactSecrets;
  const state: SamplerState = { previousCpu: undefined, previousTime: undefined };

  const hostNameRaw =
    options.hostName ??
    (process.env.ZCODE_PROCESS_LABEL
      ? formatZCodeHostProcessName(process.env.ZCODE_PROCESS_LABEL)
      : process.title && process.title !== 'node'
        ? process.title
        : formatZCodeHostProcessName('local'));

  function sample(): HostSamplingProcessRow {
    const now = nowFn();
    const cpu = cpuUsageFn();
    let cpuPercent = 0;
    if (state.previousCpu && state.previousTime !== undefined) {
      const wallMs = now - state.previousTime;
      if (wallMs > 0) {
        const cpuDiffUs = cpu.user - state.previousCpu.user + (cpu.system - state.previousCpu.system);
        const cpuMs = cpuDiffUs / 1000;
        const rawPercent = (cpuMs / wallMs) * 100;
        cpuPercent = rawPercent / (logicalCores > 0 ? logicalCores : 1);
        if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
      }
    }
    // 首次快照无前值 → 0（保守值，注释见文件头）
    state.previousCpu = cpu;
    state.previousTime = now;

    const mem = memoryUsageFn();
    const row: HostSamplingProcessRow = {
      pid: options.pid ?? process.pid,
      name: redact(hostNameRaw),
      category: 'base',
      groupKey: redact('host'),
      groupLabel: redact('host'),
      cpuPercent,
      memoryBytes: mem.rss,
    };
    return row;
  }

  function reset() {
    state.previousCpu = undefined;
    state.previousTime = undefined;
  }

  return { sample, reset, state };
}

export function redactHostSamplingProcess(
  row: HostSamplingProcessRow,
  redact: (text: string) => string = redactSecrets,
): HostSamplingProcessRow {
  return {
    ...row,
    name: redact(row.name),
    groupKey: redact(row.groupKey),
    groupLabel: redact(row.groupLabel),
  };
}

export function buildHostSamplingResponse(
  requestId: string,
  processRow: HostSamplingProcessRow,
  sampledAt: number,
  redact: (text: string) => string = redactSecrets,
): HostSamplingResponse {
  return {
    type: HostResponseTypes.ResourceUsageSnapshotResult,
    requestId,
    sampledAt: Math.max(0, Math.trunc(sampledAt)),
    processes: [redactHostSamplingProcess(processRow, redact)],
  };
}

export function isHostSamplingRequest(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === HostMessageTypes.ResourceUsageSnapshotRequest &&
    typeof (message as { requestId?: unknown }).requestId === 'string'
  );
}

export function isHostSamplingCancel(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === HostMessageTypes.ResourceUsageSnapshotCancel &&
    typeof (message as { requestId?: unknown }).requestId === 'string'
  );
}

export function createHostSamplingController(
  port: HostSamplingPort,
  options: HostSamplingOptions = {},
): HostSamplingController {
  const redact = options.redact ?? redactSecrets;
  const sampler = createHostSamplingSampler(options);
  const pending = new Map<string, PendingToken>();

  const sampledAtFn = options.now ?? (() => Date.now());

  function handleRequest(requestId: string): void {
    const token: PendingToken = { cancelled: false };
    pending.set(requestId, token);
    const row = sampler.sample();
    const sampledAt = sampledAtFn();
    if (token.cancelled) {
      pending.delete(requestId);
      return;
    }
    const response = buildHostSamplingResponse(requestId, row, sampledAt, redact);
    try {
      port.postMessage(response);
    } catch {
      // 观测失败只丢弃本轮，不能影响 host 生命周期
    }
    pending.delete(requestId);
  }

  function cancelRequest(requestId: string): void {
    const token = pending.get(requestId);
    if (!token) return; // 已回帖或未知 → 忽略
    token.cancelled = true;
  }

  function handleMessage(raw: unknown): boolean {
    const msg = (raw && typeof raw === 'object' ? ((raw as { data?: unknown }).data ?? raw) : raw) as {
      type?: unknown;
      requestId?: unknown;
    };
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
      if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) return false;
      handleRequest(msg.requestId);
      return true;
    }
    if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
      if (typeof msg.requestId !== 'string' || msg.requestId.length === 0) return false;
      cancelRequest(msg.requestId);
      return true;
    }
    return false;
  }

  const listener = (event: unknown) => {
    const ev = event as { data?: unknown } | undefined;
    const raw = ev && typeof ev === 'object' && 'data' in ev ? ev.data : event;
    handleMessage(raw);
  };

  try {
    port.on('message', listener);
  } catch {
    // ignore
  }

  function dispose() {
    try {
      if (typeof port.off === 'function') port.off('message', listener);
      else if (typeof port.removeListener === 'function') port.removeListener('message', listener);
    } catch {
      // ignore
    }
  }

  const controller: HostSamplingController = {
    port,
    sample: () => sampler.sample(),
    handleRequest,
    cancelRequest,
    handleMessage,
    handle: handleMessage,
    onMessage: handleMessage,
    dispose,
  };
  return controller;
}

// 兼容/别名：不同命名习惯都能拿到同一控制器
const controllerCache = new WeakMap<object, HostSamplingController>();

export function getHostSamplingController(
  port: HostSamplingPort,
  options: HostSamplingOptions = {},
): HostSamplingController {
  const key = port as unknown as object;
  let controller = controllerCache.get(key);
  if (!controller) {
    controller = createHostSamplingController(port, options);
    controllerCache.set(key, controller);
  }
  return controller;
}

export function attachHostSampling(port: HostSamplingPort, options: HostSamplingOptions = {}) {
  return getHostSamplingController(port, options);
}

export function registerHostSampling(port: HostSamplingPort, options: HostSamplingOptions = {}) {
  return getHostSamplingController(port, options);
}

export function startHostSampling(port: HostSamplingPort, options: HostSamplingOptions = {}) {
  return getHostSamplingController(port, options);
}

export function createHostSamplingResponder(port: HostSamplingPort, options: HostSamplingOptions = {}) {
  return getHostSamplingController(port, options);
}

export function createHostResourceUsageResponder(port: HostSamplingPort, options: HostSamplingOptions = {}) {
  return getHostSamplingController(port, options);
}

export function handleHostSamplingMessage(
  port: HostSamplingPort,
  message: unknown,
  options: HostSamplingOptions = {},
): boolean {
  const controller = getHostSamplingController(port, options);
  const raw =
    message && typeof message === 'object' && 'data' in (message as Record<string, unknown>)
      ? (message as { data?: unknown }).data
      : message;
  return controller.handleMessage(raw);
}

export function handleHostSampling(
  port: HostSamplingPort,
  message: unknown,
  options: HostSamplingOptions = {},
): boolean {
  return handleHostSamplingMessage(port, message, options);
}

export function sampleHostProcess(options: HostSamplingOptions = {}) {
  const sampler = createHostSamplingSampler(options);
  return sampler.sample();
}

// 便于测试直接构造一个 EventEmitter 形状的端口
export { EventEmitter };
