// A09 hook 执行器：spawn 一条 shell 命令，stdin 注入 JSON 上下文（对齐 ZCode：
// stdin 单行 JSON，而非 env 变量），stdout/stderr 有界捕获，超时击杀，按平台走 shell。
//
// 安全约束（红线）：
//   - env **显式白名单**：只透传 shell 解析/系统运行必需的最小集合 + 自注入的
//     HARNESS2_* 变量；绝不把宿主 process.env 整包交给子进程（防密钥/令牌外泄）。
//   - 输出截断：stdout/stderr 各最多 maxOutputBytes 字节（+ 1 字节探测是否截断）；
//     记录层再做字符级预览截断 + redactSecrets 脱敏（见 runner.ts）。
//   - 超时：单条 hook 上限（默认取 config.timeoutMs，缺省 30s；schema 钳 1..300000ms）。
//   - shell：Node spawn 的 shell:true —— Windows 走 cmd.exe / POSIX 走 /bin/sh；
//     shell 可经 hooks 段透传（ZCode 有 shell 覆盖能力，本轮先按平台缺省，见报告未做项）。
//
// 可测性：真实 spawn 经 spawnHook 注入点；测试传 mock（不真起进程）或用 node -e 轻量真命令。
import { spawn } from 'node:child_process';

/** 执行器入参（runner 构造：命令 + 注入 + 边界） */
export interface HookSpawnInput {
  /** 待执行 shell 命令（来自用户 config，与权限 DSL 同级信任） */
  command: string;
  /** 注入 stdin 的 JSON 文本（含尾换行） */
  stdin: string;
  cwd: string;
  /** 最小白名单环境（buildHookEnv 产物） */
  env: Record<string, string>;
  timeoutMs: number;
  /** 捕获上限（字节；stdout 与 stderr 各自独立上限） */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface HookSpawnResult {
  status: 'completed' | 'timeout' | 'error';
  /** 正常结束时的退出码；spawn 失败/超时无退出码 → null */
  exitCode: number | null;
  /** 已按 maxOutputBytes 截断的 stdout（超限则尾部截断） */
  stdout: string;
  stderr: string;
  /** spawn 失败（ENOENT 等）或超时被杀的一行原因 */
  errorMessage?: string;
}

/** 执行器缝：默认真实 spawn；测试注入 mock（不真起进程） */
export type HookSpawnHook = (input: HookSpawnInput) => Promise<HookSpawnResult>;

/**
 * 子进程环境白名单（**唯一出口**，测试与实现同源）：
 *   - Shell 解析与系统运行必需：PATH / PATHEXT / SystemRoot / ComSpec / windir /
 *     TEMP / TMP / TMPDIR / HOME / USERPROFILE / SystemDrive / OS；
 *   - 自注入上下文：HARNESS2_HOOK_EVENT / HARNESS2_CWD / HARNESS2_SESSION_ID。
 * 显式不含任何宿主业务密钥变量——未列入的一律不透传。
 */
export function buildHookEnv(
  base: Record<string, string | undefined>,
  extra: { event: string; cwd: string; sessionId?: string },
): Record<string, string> {
  const allow = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SystemDrive',
    'ComSpec',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'OS',
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = base[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  env['HARNESS2_HOOK_EVENT'] = extra.event;
  env['HARNESS2_CWD'] = extra.cwd;
  if (extra.sessionId !== undefined && extra.sessionId.length > 0) {
    env['HARNESS2_SESSION_ID'] = extra.sessionId;
  }
  return env;
}

/**
 * 有界捕获：把 chunk 追加进缓冲，最多保留 maxBytes（+1 字节探测截断）；返回文本。
 * 超限后继续消费流但不增长（避免背压卡死子进程）。
 */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.size += remaining;
    this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  wasTruncated(): boolean {
    return this.truncated;
  }
}

/** 默认执行器：真实 shell spawn（shell:true 按平台；stdin 写 JSON；超时 kill） */
export const defaultSpawnHook: HookSpawnHook = (input) =>
  new Promise<HookSpawnResult>((resolve) => {
    const stdout = new BoundedBuffer(input.maxOutputBytes);
    const stderr = new BoundedBuffer(input.maxOutputBytes);
    let settled = false;
    // timer 容器（对象属性赋值，避免 let 声明在闭包里被 prefer-const 判为可 const）
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    let child: ReturnType<typeof spawn>;
    const finish = (result: HookSpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer.id !== undefined) clearTimeout(timer.id);
      if (input.signal !== undefined) input.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // 已退出/无法 kill：忽略
      }
      finish({
        status: 'error',
        exitCode: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        errorMessage: 'hook aborted',
      });
    };

    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        env: input.env,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({
        status: 'error',
        exitCode: null,
        stdout: '',
        stderr: '',
        errorMessage: (e as Error)?.message ?? String(e),
      });
      return;
    }

    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

    timer.id = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        status: 'timeout',
        exitCode: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        errorMessage: `hook timed out after ${input.timeoutMs}ms`,
      });
    }, input.timeoutMs);
    timer.id.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (e) => {
      finish({
        status: 'error',
        exitCode: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        errorMessage: e.message,
      });
    });
    child.on('close', (code) => {
      finish({
        status: 'completed',
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
    // stdin：写入后立即 end（ZCode 同款单向注入；命令不必等待 EOF 也可先读）
    try {
      child.stdin?.end(input.stdin);
    } catch {
      // 子进程已退：stdin 写入失败不影响结果判定
    }
  });
