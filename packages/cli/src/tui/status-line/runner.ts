// runner.ts — 状态行 command 型子进程执行（G-45 stdin 契约 / G-47 限额 / G-48 日志落盘）。
//
// 规格依据：refs-grok-build.md G-45/G-47/G-48/G-49 与上游 25-status-line.md「How it works」：
//  - 启动即写入 stdin（payload JSON + 尾随换行，见 contract.ts serialize）并关闭 stdin；
//  - 10s 超时 → 杀进程、回报 timedOut（画行文案由 governor 给 STATUS_LINE_TIMEOUT_TEXT）；
//  - stdout 超 64KiB → 截断保留、杀进程（「Stdout past 64 KiB is truncated and the script
//    is stopped」——保护性截断，按成功处理，输出整形再经 render.shapeCommandOutput）；
//  - 退出码非 0 → 失败（error 携带退出码；governor 记账/降级）；
//  - **后台工作不留活口**：超时/超量/正常退出路径都 kill 整棵进程树（「Whatever a script
//    leaves running is killed when the run ends, on every path」）——P2-4：Windows
//    taskkill /pid <pid> /T /F，POSIX spawn detached 成组长后 process.kill(-pid)，
//    与 core bash 工具 killTree 同一手法（shell 下只杀直接子进程会遗留孙进程）。
//  - 运行目录优先级（上游 Environment 节）：会话 cwd → 仓库根 → pager 自身目录，取第一个
//    本地存在的路径——本模块按 opts.cwd 传入的第一选择执行，优先级裁决归装配层。
// spawn 可注入（测试用 fake；缺省 node:child_process.spawn）。G-48 的 unified 日志按本仓
// 家目录约定落 `~/.harness2/logs/unified.jsonl`（上游为 ~/.grok/...——G-48 路径随壳约定，
// JSONL 结构保留），路径与追加均为可注入纯函数 + 缺省实现。
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_DIR } from '@harness2/core';
import { STATUS_LINE_MAX_STDOUT_BYTES, STATUS_LINE_TIMEOUT_MS } from './config.js';
import { statusLineChildEnv } from './contract.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 尽力杀死整棵进程树（P2-4；与 core bash 工具同手法），失败不抛出：
 * Windows = taskkill /T /F；POSIX = 负 PID 杀进程组（child detached 为组长）；
 * pid 未知（注入式 fake）/ 树杀失败 = 退回 child.kill。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill();
    } catch {
      /* 已退出/句柄异常不阻塞结算 */
    }
    return;
  }
  if (IS_WINDOWS) {
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      try {
        child.kill();
      } catch {
        /* 已死 */
      }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已死 */
    }
  }
}

/** spawn 注入口（与 node:child_process.spawn 同形；测试注入 fake 用） */
export type SpawnLike = typeof nodeSpawn;

export type StatusLineRunResult =
  { ok: true; stdout: string; truncated: boolean } | { ok: false; timedOut: boolean; error: string };

/** 运行选项（env 缺省 = G-49 构造；cwd = 装配层按「会话 cwd → 仓库根 → 壳目录」裁决） */
export interface StatusLineRunOptions {
  /** 脚本命令行（config 层已做 ~/ 展开） */
  command: string;
  /** stdin 文本（serializeStatusLinePayload 的产物，含尾随换行） */
  payloadText: string;
  cwd: string;
  /** 状态行自身尺寸（G-49：COLUMNS/LINES 给的是行尺寸，不是窗口） */
  size: { cols: number; rows: number };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  spawnImpl?: SpawnLike;
}

/** 路径是否命中「存在的可执行文件」（直接执行判定；不存在则走 shell 解释） */
export function isExecutablePath(command: string): boolean {
  // 带路径分隔符或以 ~ 展开后的绝对路径才尝试文件判定；裸命令（jq、git …）恒走 shell
  if (!command.includes('/') && !command.includes('\\')) return false;
  return existsSync(command);
}

/**
 * 运行一次状态行脚本（每次运行 = 全新进程，上游：Each run is a fresh process）：
 *  - 命令是存在的可执行路径 → 直接执行；否则经 shell 解释（管道/jq 等写法照常可用；
 *    node spawn shell:true 在 Windows 用 cmd、POSIX 用 /bin/sh——与上游 sh -c 的平台差异
 *    登记在案，语义同为「shell command line」）；
 *  - env = statusLineChildEnv（G-49：行尺寸 COLUMNS/LINES、GIT_OPTIONAL_LOCKS=0、
 *    BASH_ENV/ENV 清空）；
 *  - 10s 超时 / 64KiB 超量即杀（不留后台活口）。
 */
export function runStatusLineCommand(opts: StatusLineRunOptions): Promise<StatusLineRunResult> {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? STATUS_LINE_TIMEOUT_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? STATUS_LINE_MAX_STDOUT_BYTES;
  const env = opts.env ?? statusLineChildEnv(process.env, opts.size);

  return new Promise<StatusLineRunResult>((resolve) => {
    const direct = isExecutablePath(opts.command);
    const child = spawnImpl(opts.command, {
      // shell:true 与上游 sh -c 同语义（shell command line）；直接执行路径不经 shell
      shell: !direct,
      // POSIX：detached 使脚本成为进程组长（超时/超量经负 PID 杀整组）；Windows 走 taskkill /T
      detached: !IS_WINDOWS,
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stdoutBytes = 0;
    let truncated = false;
    let stderrTail = '';
    let settled = false;

    const kill = (): void => {
      killProcessTree(child);
    };

    const finish = (result: StatusLineRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, timedOut: true, error: 'status line 脚本超时（10s）' });
    }, timeoutMs);

    child.on('error', (err) => {
      kill();
      finish({ ok: false, timedOut: false, error: `status line 脚本启动失败：${err.message}` });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        truncated = true; // 截断保留 + 停脚本（G-47），按成功结算
        stdout += chunk.subarray(0, Math.max(0, maxStdoutBytes - (stdoutBytes - chunk.length))).toString('utf8');
        kill();
        finish({ ok: true, stdout, truncated });
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr 只留尾部做诊断（不进画行内容——状态行只展示 stdout）
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-400);
    });

    child.on('close', (code) => {
      if (truncated) return; // 已按截断成功结算
      if (code === 0) {
        finish({ ok: true, stdout, truncated });
      } else {
        const tail = stderrTail.length > 0 ? `：${stderrTail.trim()}` : '';
        finish({ ok: false, timedOut: false, error: `status line 脚本退出码 ${code ?? 'signal'}${tail}` });
      }
    });

    // stdin 契约（G-45）：payload JSON + 尾随换行写入后关闭——input=$(cat) 与 read -r 均可用
    child.stdin?.on('error', () => {
      // 脚本不读 stdin 提前退出时 EPIPE 可达——不当作运行失败
    });
    child.stdin?.end(opts.payloadText, 'utf8');
  });
}

// —— G-48 unified 日志（失败落盘；路径随本仓家目录约定）─────────────────────────

/** unified 日志路径（G-48：~/.grok/logs/unified.jsonl → 本仓 ~/.harness2/logs/unified.jsonl） */
export function unifiedLogPath(home: string): string {
  return join(home, HARNESS_DIR, 'logs', 'unified.jsonl');
}

/** 日志条目（JSONL 单行；ts 为 epoch ms——脚本消费者按字段读，不依赖排序） */
export interface UnifiedLogEntry {
  readonly ts: number;
  readonly level: 'error';
  readonly source: 'status_line';
  readonly message: string;
  readonly timedOut: boolean;
}

/** 追加一条失败日志（缺省同步追加；目录不存在则创建。返回是否落盘成功——日志失败不上抛） */
export function appendStatusLineFailureLog(path: string, entry: UnifiedLogEntry, now: number = Date.now()): boolean {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...entry, ts: entry.ts || now })}\n`, 'utf8');
    return true;
  } catch {
    return false; // 日志是诊断面：写不进不阻塞状态行降级路径
  }
}
