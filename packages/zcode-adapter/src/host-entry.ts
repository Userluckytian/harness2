/**
 * host-entry —— ZS1 桩 host 进程入口（在 Electron utilityProcess 内运行）
 *
 * 职责（main↔host 协议最小集，见计划执行记录「main↔host 协议」）：
 * 1. 收 InitLocal（带转移 MessagePort）→ 经 parentPort 回 DatabaseStartupState
 *    （phase=ready，startupId 用 InitLocal 下发的 databaseStartupId 原样回填）；
 * 2. 在转移端口上开 ChannelServer，注册 createHarness2Services() 的全部频道桩；
 * 3. 收 AttachServicePort → 同一集合暴露到新端口（ZS1 远程会话不真实支持，暴露桩无害）；
 *    收 DetachServicePort → 关闭对应端口；
 * 4. 收 DatabaseStartupControl（snapshot/retry）→ 重发当前 ready 状态；
 * 5. 收 Dispose → process.exit(0)。
 *
 * 端口适配复刻 ZCode packages/desktop/src/host/electronPort.ts 的 wrapElectronPort
 * （Apache-2.0，见 LICENSE-ZCODE.md）：MessagePortMain 的 .on/.off/.start/.close
 * 适配为 RPC 层 MessagePortLike 的 addEventListener/postMessage。
 *
 * ZS1 桩阶段不写真实数据：无 SQLite、无 agent 子进程；数据根重定向经
 * ZCODE_DATA_BASE_DIR 由壳 main 进程下发（本入口不触碰磁盘业务数据）。
 */
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  ChannelServer,
  LoggingChannelServer,
  MessagePortProtocol,
  type MessagePortLike,
  type MessagePortPayload,
} from '@zcode/rpc';
import { HostMessageTypes, HostResponseTypes } from '@zcode/shared';
import { createHarness2Services } from './createHarness2Services.js';
import { attachHostSampling } from './real/host-sampling.js';
import { installCrashHooks } from './real/host-crash.js';
import { createBootTiming } from './real/boot-timing.js';

// ZS5-T4：host 进程崩溃归因接线（uncaughtException / unhandledRejection → core writeCrashReport）。
// 仅本地落盘、零遥测；钩子自身 try/catch 兜底，绝不再抛。
installCrashHooks();

// ZS5-T4：启动分段计时基线（进程模块加载时刻）。
// 早期（InitLocal 前）host 日志通道（HostResponseTypes.Log）尚未有结构化回帖可保证，
// 降级 console：utilityProcess 的 stdout/stderr 由 scratch main 的 hostLogRelay
// 转入主日志（D:/AI_Projects/harness2-zs1-build/ZCode/packages/desktop/src/main/desktopHostProcess.ts:288-294
// child.stdout/stderr 'data' → hostLogRelay.onStdout/onStderr；createHostLogRelay 优先结构化，
// 早期缓存 stdout 作为兜底）。故 module_load 行即使被后续结构化日志冲掉也无害；后续里程碑走 log()。
const bootTimingOrigin =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

interface ElectronMessagePortMainLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  postMessage(message: unknown): unknown;
  start(): unknown;
  close(): unknown;
}

/** 复刻 ZCode electronPort.ts 的适配（Apache-2.0） */
function wrapElectronPort(port: ElectronMessagePortMainLike): MessagePortLike {
  return {
    addEventListener(_type: 'message', listener: (e: { data: MessagePortPayload }) => void) {
      port.on('message', listener as (e: { data: unknown }) => void);
    },
    removeEventListener(_type: 'message', listener: (e: { data: MessagePortPayload }) => void) {
      port.off('message', listener as (e: { data: unknown }) => void);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

const parentPort = (
  process as typeof process & {
    parentPort?: ElectronMessagePortMainLike;
  }
).parentPort;

// ZS5-T4：module_load 里程碑。优先走 host 现有日志通道（HostResponseTypes.Log → main 落盘），
// 通道不可用（非 Electron / parentPort 缺失）时降级 console（utilityProcess stdout → hostLogRelay）。
{
  const _now =
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const _ms = Math.max(0, Math.round(_now - bootTimingOrigin));
  const _line = `[h2-boot-timing] module_load +${_ms}ms`;
  let _posted = false;
  if (parentPort) {
    try {
      parentPort.postMessage({ type: HostResponseTypes.Log, level: 'info', source: 'zs1-stub-host', message: _line });
      _posted = true;
    } catch {
      _posted = false;
    }
  }
  if (!_posted) {
    try {
      console.log(_line);
    } catch {
      // ignore
    }
  }
}

if (parentPort) {
  // ZS5-T1：应答资源管理器采样协议（纯加性，不影响 InitLocal/DatabaseStartup/ChannelServer）
  attachHostSampling(parentPort as unknown as Parameters<typeof attachHostSampling>[0]);
}

function postToMain(message: unknown): void {
  if (!parentPort) throw new Error('parentPort unavailable');
  parentPort.postMessage(message);
}

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  postToMain({ type: HostResponseTypes.Log, level, source: 'zs1-stub-host', message });
};

interface DatabaseStartupStateReady {
  schemaVersion: 1;
  startupId: string;
  attemptId: string;
  sequence: number;
  startedAt: number;
  updatedAt: number;
  phase: 'ready';
  databasePhase: 'ready';
  disk: never[];
}

/** 桩 host 的数据库启动状态：无真实 SQLite，直接 ready（renderer 据此过 loading 屏） */
function readyState(startupId: string, attemptId: string, startedAt: number): DatabaseStartupStateReady {
  return {
    schemaVersion: 1,
    startupId,
    attemptId,
    sequence: 1,
    startedAt,
    updatedAt: Date.now(),
    phase: 'ready',
    databasePhase: 'ready',
    disk: [],
  };
}

function publishReady(state: DatabaseStartupStateReady): void {
  postToMain({ type: HostResponseTypes.DatabaseStartupState, state });
}

/** 在一个转移端口上暴露全部桩服务（桌面 local clientMode：无曝光过滤） */
function exposeServicesOnPort(port: ElectronMessagePortMainLike): void {
  const { services, dispose } = createHarness2Services();
  const protocol = new MessagePortProtocol(wrapElectronPort(port));
  const rawServer = new ChannelServer(protocol, 'host', 1000, false);
  // rpc:call 日志层（与原版 host 同款中间件）：T3 取证用——证明 renderer 在消费桩
  const server = new LoggingChannelServer(rawServer, (message) => log('info', message));
  services.exposeOnChannelServer(server);
  port.once('close', () => {
    rawServer.dispose();
    protocol.disconnect();
    // ZS6 尾巴清偿（zs5-review-t1t5 §4）：连接死亡→回收服务后台资源（sessions-index
    // 轮询定时器/订阅表），杜绝 renderer 重载累积孤儿定时器。
    dispose();
  });
}

if (!parentPort) {
  // utilityProcess 外被直接执行（如单测误跑）：明确报错退出
  console.error('[zs1-stub-host] must run inside Electron utilityProcess (parentPort required)');
  process.exit(1);
}

let startupStartedAt = Date.now();
let currentStartupId = '';
let currentAttemptId = '';

// ZS5-T4：启动分段计时实例（基线=模块加载时刻）；emit 走 host 现有日志通道 log()，
// 失败降级 console（与 module_load 早期策略一致）。
const bootTiming = createBootTiming({
  now: () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(),
  origin: bootTimingOrigin,
  emit: (line) => {
    try {
      log('info', line);
    } catch {
      console.log(line);
    }
  },
});
let servicesTimingMarked = false;

parentPort.on('message', (e: { data?: unknown }) => {
  const raw = e.data as { type?: string; [key: string]: unknown } | undefined;
  if (!raw || typeof raw.type !== 'string') return;
  const port = (e as { ports?: unknown[] }).ports?.[0] as ElectronMessagePortMainLike | undefined;

  switch (raw.type) {
    case HostMessageTypes.InitLocal: {
      bootTiming.mark('init_local');
      const msg = raw as { databaseStartupId?: string };
      startupStartedAt = Date.now();
      currentStartupId = msg.databaseStartupId ?? 'zs1-stub';
      currentAttemptId = `zs1-${randomUUID()}`;
      log('info', `InitLocal received (startupId=${currentStartupId}); exposing stub services`);
      if (!port) {
        log('error', 'init-local message missing MessagePort');
        return;
      }
      // 1) 报 ready（renderer 的 DatabaseStartupAdmission 按 startupId 配对 state+port）
      publishReady(readyState(currentStartupId, currentAttemptId, startupStartedAt));
      bootTiming.mark('database_ready');
      // 2) 在端口上暴露全部桩频道
      exposeServicesOnPort(port);
      if (!servicesTimingMarked) {
        servicesTimingMarked = true;
        bootTiming.mark('services_ready');
      }
      log('info', 'stub services exposed on ChannelServer (all channels registered)');
      return;
    }
    case HostMessageTypes.DatabaseStartupControl: {
      const control = (raw as { control?: { action?: string } }).control;
      if (control?.action === 'snapshot' || control?.action === 'retry') {
        // 桩无失败态可重试：重发当前 ready 状态（sequence 递增以通过 relay 去重）
        publishReady({ ...readyState(currentStartupId, currentAttemptId, startupStartedAt), sequence: 2 });
      }
      return;
    }
    case HostMessageTypes.AttachServicePort: {
      if (port) {
        log('info', 'AttachServicePort: exposing stub services (ZS1 remote sessions not truly supported)');
        exposeServicesOnPort(port);
      }
      return;
    }
    case HostMessageTypes.DetachServicePort: {
      if (port) port.close();
      return;
    }
    case HostMessageTypes.Dispose: {
      log('info', 'Dispose received, exiting');
      process.exit(0);
      return;
    }
    default:
      // 其余 main→host 消息（Broadcast/CronRun/TaskRealtimeDeliver 等）ZS1 桩静默忽略
      return;
  }
});

log('info', `zs1 stub host started (pid=${process.pid})`);

// 仅 e2e：启动后 ~3s 主动抛出，走 unhandledRejection 路径，验证崩溃报告落盘且壳不连坐崩。
// ZS6 尾巴清偿（zs5-review-t1t5 §3）：**双信号门**——ZS5_TEST_CRASH=1 且 ZS2_PROBE=1
// （run-e2e.ps1 两枚均只有 e2e runbook 会设；正常 launch-manual/用户环境不带 ZS2_PROBE），
// 单 env 误带入不再可能触发主动崩溃。
if (process.env.ZS5_TEST_CRASH === '1' && process.env.ZS2_PROBE === '1') {
  setTimeout(() => {
    void Promise.reject(new Error('zs5-e2e-crash-probe'));
  }, 3000);
}
