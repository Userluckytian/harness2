// H-43 零开销轮次的模型面：`run_script` 工具（P7-C；P7 修复棒改子进程执行）。
//
// 模型写一段 JS 脚本，脚本通过 RPC 客户端**直连工具**（列工具 / 调工具 / 取结构化结果），
// 只有脚本的最终输出回到会话——中间的工具结果从不作为 tool 消息进入 prompt，这就是
// 「零开销轮次」：一次模型调用换掉 N 次「模型 → 工具 → 模型」往返。
//
// 执行边界（P0-1 修复，如实声明，不再有「沙箱/隔离」表述）：
//   - 脚本跑在**独立 Node 子进程**里（`node -e <本文件内联的子进程程序>`），与宿主进程只有
//     一条 NDJSON（`tools/rpc-stdio.ts` v1 帧格式）管道：子进程发请求、宿主回响应。
//     脚本若用构造器链逃逸（`harness.tools.call.constructor.constructor('return this')()` 等），
//     拿到的只是**子进程自己的** globalThis/process——宿主对象（registry / 审批缝 / 会话
//     writer / 宿主 process）在子进程里根本不存在，故无法像 `node:vm` 那样被穿透。
//   - 但这不是「沙箱」：脚本就是普通 Node 代码，子进程内**可以**直接读写文件、起进程、用网络
//     （与 bash 同级），因此本工具按 unsafe 处理（独占执行 + 审批策略下默认 ask，绝不进只读工具集）。
//   - 脚本经 `harness.tools.call` 的工具调用仍走宿主 ToolRpcService → ToolExecutor：审批策略、
//     白名单、单次超时、输出上限全部生效，脚本无法绕过审批去间接执行命令。
//   - 未声明的两处（P1-3，如实登记）：脚本内层 write/edit 的文件改动**不进快照、/undo 无法恢复**；
//     内层调用也**不进会话日志与执行观察面**（只有 run_script 这一次调用本身有 tool/call+result）。
//   - 超时：脚本总时长受 timeoutMs 约束（超时/取消 → 杀子进程 + 中止内层在途调用）。
//
// 契约：execute 返回 `{ output }`（脚本输出，已截断）或 `{ error }`（编译/运行/超时错误）。
import { spawn, type ChildProcess } from 'node:child_process';
import { TOOL_RPC_PROTOCOL, ToolRpcLineServer } from './rpc-stdio.js';
import type { ToolRpcService } from './rpc.js';
import type { ToolDefinition, ToolOutput } from './types.js';

/** 模型面工具名（^[a-z0-9_]+$ 约束内） */
export const SCRIPT_TOOL_NAME = 'run_script';

/** 脚本总时长上限（缺省 30s；可用 options.timeoutMs 覆盖） */
export const SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
/** 脚本输出进模型的字符上限（缺省 8000；超限截断并标记） */
export const SCRIPT_DEFAULT_MAX_OUTPUT_CHARS = 8_000;
/** console 日志保留上限（行数/字符；防脚本用日志绕开输出上限） */
export const SCRIPT_MAX_LOG_LINES = 200;
export const SCRIPT_MAX_LOG_CHARS = 4_000;

export interface ScriptToolOptions {
  /** 工具 RPC 服务（脚本调工具的唯一出口；审批/白名单/超时在服务侧收口） */
  service: ToolRpcService;
  /** 脚本总时长上限 ms（缺省 30000） */
  timeoutMs?: number;
  /** 输出字符上限（缺省 8000） */
  maxOutputChars?: number;
}

/**
 * 子进程程序（内联为 `node -e` 的源码，传参经 stdin 首帧、结果经 fd3 单列管道）。
 * 依赖只有 node 内建模块（fs / readline）——不 import 宿主任何模块，因此子进程里不存在
 * 宿主对象可被构造器链取到。脚本本体经 stdin 首帧传入（不走 argv，无长度上限）。
 */
const SCRIPT_CHILD_PROGRAM = `
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const PROTOCOL = ${JSON.stringify(TOOL_RPC_PROTOCOL)};
const MAX_LOG_LINES = ${SCRIPT_MAX_LOG_LINES};
const MAX_LOG_CHARS = ${SCRIPT_MAX_LOG_CHARS};
const logs = [];
function pushLog(v) { if (logs.length >= MAX_LOG_LINES) return; logs.push(v); }
function fmt(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
}
// 采集脚本自己写 stdout/stderr 的内容（进日志）：宿主与子进程间的 NDJSON 帧只走 fd1/fd0，
// 结果只走 fd3——脚本的普通输出不会污染协议。
process.stdout.write = function (chunk) { pushLog(String(chunk)); return true; };
process.stderr.write = function (chunk) { pushLog(String(chunk)); return true; };
const pending = new Map();
let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  const frame = { id: id, method: method };
  if (params !== undefined) frame.params = params;
  fs.writeSync(1, JSON.stringify(frame) + '\\n');
  return new Promise(function (resolve, reject) { pending.set(id, { resolve: resolve, reject: reject }); });
}
const harness = Object.freeze({
  protocol: PROTOCOL,
  tools: Object.freeze({
    list: function () { return rpc('tools.list'); },
    describe: function (name) { return rpc('tools.describe', { name: name }); },
    call: function (name, args, timeoutMs) {
      const params = { name: name, args: args === undefined ? {} : args };
      if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
      return rpc('tool.call', params);
    },
  }),
});
function logConsole() {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
  pushLog(parts.join(' '));
}
const console = Object.freeze({ log: logConsole, info: logConsole, warn: logConsole, error: logConsole });
function formatOutput(value) {
  const logText = logs.length > 0 ? logs.join('\\n').slice(0, MAX_LOG_CHARS) : '';
  let valueText = '';
  if (value !== undefined) {
    try { const s = JSON.stringify(value); valueText = s === undefined ? String(value) : s; } catch (e) { valueText = String(value); }
  }
  if (logText !== '' && valueText !== '') return logText + '\\n' + valueText;
  if (valueText !== '') return valueText;
  if (logText !== '') return logText;
  return '（脚本无输出：既没有 return，也没有 console.log）';
}
function finish(payload) {
  try { fs.writeSync(3, JSON.stringify(payload) + '\\n'); } catch (e) { /* 宿主已收管道：忽略 */ }
  process.exit(0);
}
function start(line) {
  let script = '';
  try { const first = JSON.parse(line); if (typeof first.script === 'string') script = first.script; } catch (e) { /* 首帧坏了：脚本为空串 */ }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let fn;
  try {
    // 脚本体即授时函数体：可用 await 与顶层 return；require/module 是子进程自己的（与 bash 同级）
    fn = new AsyncFunction('harness', 'console', 'require', 'module', 'exports', '__filename', '__dirname', script);
  } catch (e) {
    finish({ ok: false, error: '脚本编译失败: ' + (e && e.message ? e.message : String(e)), logs: logs.join('\\n') });
    return;
  }
  Promise.resolve()
    .then(function () { return fn(harness, console, require, module, exports, 'harness2-run-script.js', process.cwd()); })
    .then(function (value) { finish({ ok: true, text: formatOutput(value) }); })
    .catch(function (e) { finish({ ok: false, error: (e && e.message ? e.message : String(e)), logs: logs.join('\\n') }); });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let firstLine = true;
rl.on('line', function (line) {
  if (firstLine) { firstLine = false; start(line); return; }
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const p = msg === null || typeof msg !== 'object' ? undefined : pending.get(msg.id);
  if (p === undefined) return;
  pending.delete(msg.id);
  if (msg.ok === true) p.resolve(msg.result);
  else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'rpc error'));
});
`;

/** 子进程结果帧（fd3 一行 JSON） */
interface ScriptChildPayload {
  ok: boolean;
  text?: string;
  error?: string;
  logs?: string;
}

/** 子进程退出裁决 */
type ScriptExit =
  { kind: 'exit'; code: number | null } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'error'; message: string };

/** 取缓冲区最后一行非空文本（子进程结果帧；噪声行忽略） */
function lastLine(text: string): string | undefined {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/**
 * 构造 run_script 工具（装配层在拿到 ToolRpcService 后注册；本工具不随 builtinTools 静态注册，
 * 因为它需要绑定运行中的工具面与审批缝）。
 */
export function createScriptTool(options: ScriptToolOptions): ToolDefinition {
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : SCRIPT_DEFAULT_TIMEOUT_MS;
  const maxOutputChars =
    options.maxOutputChars !== undefined && Number.isFinite(options.maxOutputChars) && options.maxOutputChars > 0
      ? Math.floor(options.maxOutputChars)
      : SCRIPT_DEFAULT_MAX_OUTPUT_CHARS;

  return {
    name: SCRIPT_TOOL_NAME,
    description:
      'Run a JavaScript script in a **separate Node child process** that can call tools over an RPC channel and ' +
      "only returns the script's final output to the conversation. Use it to chain many tool calls (e.g. read 10 " +
      'files, filter, aggregate) without paying a model round-trip per call. Inside the script use `await ' +
      'harness.tools.list()` to enumerate tools, `await harness.tools.call(name, args)` to invoke one ' +
      '(returns { ok, output, error, durationMs }), and `return` the compact value you want to send back. ' +
      'Honest boundaries: this tool is code execution equivalent to bash — the script runs as ordinary Node code ' +
      'and can itself read/write files, spawn processes and use the network, so the approval prompt is at the ' +
      'run_script tool level (unsafe tier, never enabled by a read-only toolset). Nested calls via ' +
      '`harness.tools.call` still go through the host approval policy, the enabled-tool whitelist, per-call ' +
      'timeouts and output caps, but file changes made by nested write/edit calls are NOT recorded in undo ' +
      'snapshots (they cannot be reverted with /undo) and nested calls stay out of the execution observer ' +
      'surface (only this run_script call itself is observed). Call write/edit directly when you need a ' +
      'revertable change.',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'JS 脚本体（可用 await；return 的值即本次工具输出）。harness.tools.call("read", { file_path: "..." })',
        },
      },
      required: ['script'],
    },
    // 脚本会直接产生副作用（代码执行，与 bash 同级），按 unsafe 处理：独占执行 + 受审批策略约束
    concurrencySafe: false,
    async execute(rawArgs, ctx): Promise<ToolOutput> {
      const script = (rawArgs as Record<string, unknown> | null)?.['script'];
      if (typeof script !== 'string' || script.trim() === '') {
        return { error: 'run_script: script 必须是非空字符串' };
      }
      if (ctx.signal.aborted) {
        return { error: `run_script 已取消: ${(ctx.signal.reason as Error)?.message ?? 'aborted'}` };
      }

      // 内层在途调用的取消信号：外部取消 or 脚本超时 → 一并中止（不留孤儿副作用）
      const ac = new AbortController();
      const onOuterAbort = (): void => ac.abort(ctx.signal.reason ?? new Error('aborted'));
      ctx.signal.addEventListener('abort', onOuterAbort, { once: true });

      // 宿主侧 RPC 服务端：一行进（子进程 stdout）→ 一行出（子进程 stdin）
      const server = new ToolRpcLineServer(options.service, { signal: ac.signal, timeoutMs });

      let child: ChildProcess;
      try {
        child = spawn(process.execPath, ['--input-type=commonjs', '-e', SCRIPT_CHILD_PROGRAM], {
          cwd: ctx.cwd,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        ctx.signal.removeEventListener('abort', onOuterAbort);
        return { error: `run_script 子进程启动失败: ${(e as Error)?.message ?? String(e)}` };
      }

      let stdoutBuf = '';
      let resultBuf = '';
      let stderrTail = '';
      const onStdout = (chunk: Buffer): void => {
        stdoutBuf += chunk.toString('utf8');
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.trim() === '') continue;
          void server
            .handleLine(line)
            .then((reply) => {
              if (reply === undefined || child.stdin === null || child.stdin.destroyed) return;
              try {
                child.stdin.write(reply);
              } catch {
                // 子进程已退出：响应帧丢弃（脚本侧看不到结果，属正常竞态）
              }
            })
            .catch(() => {
              // 协议层任何异常都不击穿宿主 turn
            });
        }
      };
      child.stdout?.on('data', onStdout);
      // 结果单列管道（fd3）：脚本自己的 stdout/stderr 不参与，协议帧不会被噪声污染
      (child.stdio[3] as NodeJS.ReadableStream | null | undefined)?.on('data', (chunk: Buffer | string) => {
        resultBuf += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000);
      });

      const killChild = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
      };

      let exit: ScriptExit;
      try {
        exit = await new Promise<ScriptExit>((resolve) => {
          let settled = false;
          const settle = (v: ScriptExit): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ctx.signal.removeEventListener('abort', onAbort);
            resolve(v);
          };
          const onAbort = (): void => {
            ac.abort(ctx.signal.reason ?? new Error('aborted'));
            killChild();
            settle({ kind: 'abort' });
          };
          const timer = setTimeout(() => {
            ac.abort(new Error(`run_script 超时（>${timeoutMs}ms）`));
            killChild();
            settle({ kind: 'timeout' });
          }, timeoutMs);
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          child.once('error', (e: Error) => settle({ kind: 'error', message: e.message }));
          child.once('close', (code: number | null) => settle({ kind: 'exit', code }));
          // 交付脚本本体（stdin 首帧；脚本长度不受 argv 限制）
          try {
            child.stdin?.write(`${JSON.stringify({ kind: 'script', script })}\n`);
          } catch (e) {
            settle({ kind: 'error', message: (e as Error)?.message ?? String(e) });
          }
        });
      } finally {
        ctx.signal.removeEventListener('abort', onOuterAbort);
        child.stdout?.removeListener('data', onStdout);
      }

      if (exit.kind === 'error') return { error: `run_script 子进程启动失败: ${exit.message}` };
      if (exit.kind === 'timeout') {
        return { error: `run_script 超时（>${timeoutMs}ms）` };
      }
      if (exit.kind === 'abort') {
        return { error: `run_script 已取消: ${(ctx.signal.reason as Error)?.message ?? 'aborted'}` };
      }

      const raw = lastLine(resultBuf);
      let payload: ScriptChildPayload | undefined;
      if (raw !== undefined) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null) payload = parsed as ScriptChildPayload;
        } catch {
          payload = undefined;
        }
      }
      if (payload === undefined || typeof payload.ok !== 'boolean') {
        const detail = stderrTail.trim() !== '' ? `（子进程 stderr 末尾: ${stderrTail.trim()}）` : '';
        return { error: `run_script 子进程异常退出（code ${exit.code ?? 'null'}）${detail}` };
      }
      if (!payload.ok) {
        const logTail =
          typeof payload.logs === 'string' && payload.logs !== ''
            ? `\n脚本日志:\n${payload.logs.slice(0, SCRIPT_MAX_LOG_CHARS)}`
            : '';
        return { error: `run_script 执行失败: ${payload.error ?? 'unknown error'}${logTail}` };
      }
      const text = payload.text ?? '';
      if (text.length > maxOutputChars) {
        return {
          output: `${text.slice(0, maxOutputChars)}\n...[run_script 输出截断（>${maxOutputChars} 字符，原文 ${text.length}）]`,
        };
      }
      return { output: text };
    },
  };
}
