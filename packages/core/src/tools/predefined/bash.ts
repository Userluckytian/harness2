// bash 工具：shell 执行命令（unsafe：可能产生任意副作用，独占执行）。
//
// shell 选择（A1-1）：Windows 不再硬走 cmd.exe——探测顺序 config.bash.shell >
// Git Bash（GIT_BASH / 常见路径 / PATH 里的 Git）> cmd 回退（见 ../shell.ts；
// doctor 报告实际使用的 shell）。
// 输出解码（A1-2）：stdout/stderr 按字节累积后统一解码（严格 UTF-8 → Windows 下 GBK 回退），
// 避免多字节字符跨 chunk 断裂与 GBK 乱码进入模型上下文（见 ../process-output.ts）。
//
// 超时/取消时杀死整个进程树（P1-3）：
//   - Windows：taskkill /pid <pid> /T /F（按父子关系树杀，覆盖 shell 与工作子进程；
//     纯 child.kill 只能杀直接子进程，工作进程会存活并继续产生副作用）；
//   - POSIX：spawn detached 使 shell 成为进程组长，process.kill(-pid) 杀整组。
// 已知限制（如实声明）：命令内部守护进程化（自行 setsid 脱离进程组/换父）的进程
// 平台原语均无法触达，本工具不承诺杀死此类脱离进程。
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition, ToolOutput } from '../types.js';
import { expectObject, expectString, optionalNumber, truncateText } from './common.js';
import { OutputCollector } from '../process-output.js';
import { loadConfiguredBashShell, resolveBashShell } from '../shell.js';

export const MAX_BASH_OUTPUT_CHARS = 32 * 1024;
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024; // 输出回收上限（防失控命令吃满内存；超限后停止追加，不再像 exec 那样杀进程）

const IS_WINDOWS = process.platform === 'win32';

/** 尽力杀死整棵进程树；失败不抛出（结果由 close 事件统一回收）。
 *  Windows：taskkill /T 按父子关系树杀（不依赖进程组，无需 detached）；
 *  POSIX：child 经 detached 成为组长，负 PID 杀整组。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    // /T = 树杀（shell 及全部子孙） /F = 强制。用 spawn 发起避免阻塞事件循环。
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
    } // 其他错误退回只杀直接子进程
  }
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the session working directory. ' +
    'Returns combined stdout+stderr (truncated to 32KB, decoded as UTF-8 with a GBK fallback on Windows). ' +
    'On Windows the shell is Git Bash when available (config.bash.shell > GIT_BASH/common paths > cmd.exe fallback). ' +
    'Non-zero exit codes are reported as errors with the captured output preserved for diagnosis. ' +
    'On timeout/cancellation the whole process tree is killed (Windows: taskkill /T /F; POSIX: process-group kill), ' +
    'except processes that daemonize themselves out of the process group — killing those cannot be guaranteed.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeoutMs: {
        type: 'number',
        description: 'Kill the command (whole process tree) after this many ms (default 30000)',
      },
    },
    required: ['command'],
  },
  // unsafe（默认）：不声明 concurrencySafe
  // cancelGuaranteed：abort/timeout 触发整棵进程树击杀（taskkill /T /F 或负 PID）并等待 close；
  // 脱离进程组的守护进程是文档化例外（见文件头已知限制）。
  cancelGuaranteed: true,
  execute: (rawArgs, ctx) =>
    new Promise<ToolOutput>((resolve) => {
      let command: string;
      let timeoutMs: number;
      try {
        const args = expectObject(rawArgs, 'bash');
        command = expectString(args, 'command', 'bash');
        timeoutMs = optionalNumber(args, 'timeoutMs') ?? DEFAULT_BASH_TIMEOUT_MS;
      } catch (e) {
        resolve({ error: (e as Error).message });
        return;
      }
      if (ctx.signal.aborted) {
        resolve({ error: 'cancelled' });
        return;
      }

      // A1-1：config.bash.shell（调用方注入）优先，否则从会话 cwd 逐级发现项目/全局配置
      const configured = ctx.bashShell ?? loadConfiguredBashShell(ctx.cwd);
      const shell = resolveBashShell({ configured });

      let timedOut = false;
      let spawnFailure: Error | undefined;
      let settled = false;
      const stdout = new OutputCollector(MAX_CAPTURE_BYTES);
      const stderr = new OutputCollector(MAX_CAPTURE_BYTES);

      // 直接 spawn（Git Bash / 配置的 bash 兼容 shell）：`<shell> -c <command>`。
      // Node 的 shell:true（POSIX /bin/sh、Windows cmd.exe）保留旧行为：
      // detached 仅 POSIX 启用（使 shell 成为进程组长，可整组击杀）；Windows 禁用——
      // detached 让 cmd 脱离控制台后不再向管道写输出（实测 stdout/stderr 全空），
      // 而 Windows 的树杀用 taskkill /T 按父子关系即可，无需进程组。
      const child = shell.useNodeShell
        ? spawn(command, {
            cwd: ctx.cwd,
            shell: shell.executable,
            detached: !IS_WINDOWS,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(shell.executable, [...shell.argsPrefix, command], {
            cwd: ctx.cwd,
            detached: !IS_WINDOWS,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs);
      }
      const onAbort = (): void => killTree(child);
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        // A1-2：完整累积后统一解码（严格 UTF-8 → Windows GBK 回退），多字节不跨 chunk 断裂
        const combined = `${stdout.decode()}${stderr.decode()}`.replace(/\r\n/g, '\n');
        if (ctx.signal.aborted) return resolve({ error: 'cancelled' });
        if (timedOut) {
          return resolve({
            error: `command timed out after ${timeoutMs}ms`,
            output: truncateText(combined, MAX_BASH_OUTPUT_CHARS), // 杀掉后仍回收残余输出供诊断
          });
        }
        if (spawnFailure !== undefined) {
          // spawn 失败（如配置的 shell 路径不存在）：报出实际使用的 shell，便于自纠
          return resolve({ error: `${spawnFailure.message}（shell: ${shell.display}）` });
        }
        const code = child.exitCode;
        if (code !== 0 || child.signalCode !== null) {
          if (child.signalCode !== null && code === null) {
            // 未到超时却死于信号：外部工具击杀或 shell 异常，按非零退出口径报告
            return resolve({
              error: `exit code ${code ?? 1} (signal ${child.signalCode})`,
              output: truncateText(combined, MAX_BASH_OUTPUT_CHARS),
            });
          }
          return resolve({
            error: `exit code ${code}`,
            output: truncateText(combined, MAX_BASH_OUTPUT_CHARS),
          });
        }
        resolve({ output: truncateText(combined, MAX_BASH_OUTPUT_CHARS) || '(no output)' });
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      // spawn 本身失败（极少见：shell 找不到等）——close 不一定触发，这里直接收尾
      child.on('error', (e) => {
        spawnFailure ??= e;
        finish();
      });
      // close：进程退出且 stdio 流全部关闭（含被杀后的残余输出回收完毕）
      child.on('close', () => finish());
    }),
};
