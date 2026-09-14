// shell-exec.ts — G-11 `!` shell 模式执行器（行首 `!` 直接执行 shell 命令）。
//
// 语义边界（钉死，与 agent bash 工具的本质区别）：
// - `!cmd` 是**用户在 prompt 里直接敲的 shell 命令**——它是用户本人的操作意图，不是
//   agent 提议的工具调用，因此**不走 core 工具审批管线**（审批管线保护的是「agent 想
//   在宿主上执行什么」，不适用「用户亲手执行什么」；与 grok 上游 `!` 直达语义一致）。
//   执行结果如实进转录（输出 + 退出码），供用户与模型共同看到。
// - 执行通道复用既有 spawn 形态：node:child_process.spawn + shell:true（POSIX /bin/sh、
//   Windows cmd.exe）——与 core bash 工具的 posix/cmd 路径同款（core bash 的 Git Bash
//   分支依赖 config.bash.shell 解析，属工具审批域，此处不复用；诚实取 Node shell 语义）。
// - 超时：缺省 30s（对齐 core bash DEFAULT_BASH_TIMEOUT_MS），超时杀**整棵进程树**
//   （P2-4：Windows taskkill /pid <pid> /T /F；POSIX spawn detached 成组长后
//   process.kill(-pid) 杀整组——与 core bash 工具 killTree 同一手法，避免 shell:true
//   下只杀直接子进程、孙进程继续产生副作用）。守护进程化自行脱离进程组者平台原语亦
//   无法触达（与 core bash 的已知限制同口径，不承诺）。
import { spawn, type ChildProcess } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * 尽力杀死整棵进程树；失败不抛出（结果由 close 事件统一回收）。
 *  - Windows：taskkill /T 按父子关系树杀（不依赖进程组，无需 detached）；
 *  - POSIX：child 经 detached 成为组长，负 PID 杀整组；
 *  - pid 未知 / 树杀失败：退回 child.kill（注入式 fake 进程无 pid 的路径）。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    return;
  }
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
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
    process.kill(-pid, 'SIGKILL'); // 负 PID = 杀整个进程组（child detached 为组长）
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return; // 进程组已不存在（正常竞态）
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已死 */
    }
  }
}

/** 执行结果（退出码/信号/输出；输出为原始捕获文本） */
export interface ShellExecResult {
  /** 进程退出码；被信号终止时为 null */
  code: number | null;
  /** 终止信号名（如 SIGTERM；正常退出为 null） */
  signal: NodeJS.Signals | null;
  /** stdout 捕获（utf8；超限截断） */
  stdout: string;
  /** stderr 捕获（utf8；超限截断） */
  stderr: string;
  /** 是否因超时被终止 */
  timedOut: boolean;
}

export interface ShellExecOptions {
  /** 工作目录（装配层传 runtime.root——会话根） */
  cwd: string;
  /** 超时毫秒（缺省 DEFAULT_SHELL_TIMEOUT_MS） */
  timeoutMs?: number;
  /** env 注入（缺省继承 process.env） */
  env?: NodeJS.ProcessEnv;
}

/** 缺省超时（对齐 core bash DEFAULT_BASH_TIMEOUT_MS：挂死命令不无限占用输入通道） */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
/** 输出捕获上限（字节；防失控命令吃满内存——对齐 core bash 的 OutputCollector 思路） */
const MAX_CAPTURE_BYTES = 1_000_000;

/**
 * 执行一条 shell 命令（spawn + shell:true；超时杀进程）。
 * 注意：命令文本完全来自用户草稿（`!` 后的部分），shell:true 即用户语义——不做任何
 * 转义改写（改写反而偏离「用户敲什么执行什么」）。shell:true 在 POSIX 解析为
 * /bin/sh -c、Windows 解析为 cmd.exe（与 core bash 工具的 posix/cmd 路径同款）。
 */
export function runShellCommand(command: string, opts: ShellExecOptions): Promise<ShellExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      // POSIX：detached 使 shell 成为进程组长（超时经负 PID 杀整组）；Windows：无进程组，
      // 树杀走 taskkill /T（core bash 同款），不设 detached 以免脱离控制台句柄。
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_CAPTURE_BYTES) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_CAPTURE_BYTES) stdout = stdout.slice(0, MAX_CAPTURE_BYTES);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_CAPTURE_BYTES) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_CAPTURE_BYTES) stderr = stderr.slice(0, MAX_CAPTURE_BYTES);
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, timeoutMs)
        : undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };
    child.on('error', (err) => {
      // spawn 失败（shell 不存在等）：以 stderr 承载错误、code 127（command not found 惯例）
      stderr += `${err.message}\n`;
      finish(127, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** 退出码标注行（如实：正常/信号/超时三形态） */
export function formatShellExitLine(result: ShellExecResult): string {
  if (result.timedOut) return `[exit timeout]`;
  if (result.code !== null) return `[exit ${result.code}]`;
  return `[exit null · signal ${result.signal ?? 'unknown'}]`;
}

/** 转录输出缺省行数上限（超限截断并如实标注——原生滚动区也经不起失控命令刷屏） */
export const SHELL_OUTPUT_MAX_LINES = 200;

/**
 * shell 执行结果 → 转录系统行（纯函数）：
 * - stdout 逐行原样；stderr 逐行加 `[stderr] ` 前缀（捕获通道无交错时序，前缀如实
 *   标注来源）；先 stdout 后 stderr；
 * - 超过 maxLines 截断（计数含两通道），追加截断说明行（标注总行数）；
 * - 末行恒为退出码标注（formatShellExitLine）。
 * 注意：截断说明行不计入行数预算（防「说明行被自己的预算挤掉」）。
 */
export function formatShellTranscript(result: ShellExecResult, maxLines: number = SHELL_OUTPUT_MAX_LINES): string[] {
  const out: string[] = [];
  const stdoutLines = splitTrimEnd(result.stdout);
  const stderrLines = splitTrimEnd(result.stderr);
  const total = stdoutLines.length + stderrLines.length;
  const budget = Math.max(0, Math.floor(maxLines));
  let shown = 0;
  for (const line of stdoutLines) {
    if (shown >= budget) break;
    out.push(line);
    shown += 1;
  }
  for (const line of stderrLines) {
    if (shown >= budget) break;
    out.push(`[stderr] ${line}`);
    shown += 1;
  }
  if (total > shown) out.push(`（输出截断：共 ${total} 行，仅显示前 ${shown} 行）`);
  out.push(formatShellExitLine(result));
  return out;
}

/** 拆行并去掉行尾 CR 与末尾空行 */
function splitTrimEnd(text: string): string[] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
