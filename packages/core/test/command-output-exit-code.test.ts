// S7b 命令执行视图（command-output-exit-code）。
// 契约（计划 S7 / 验收 #7b）：
//   - toolExecutionView 字段齐全：callId/taskId/turnId、tool、参数、cwd、实际 shell、
//     开始/结束、输出引用/截断、exitCode、状态；
//   - 真实 shell 与 exitCode 归属清楚：真实 bash 命令（exit 0 / 非 0）正确归属；
//     计划中命令 ≠ 已执行命令时如实区分（不得把计划当已执行）；
//   - 未执行（审批拒绝/取消前门/未知工具）/失败/截断如实标注；
//   - 只读视图：构建为纯投影，不重跑、不写盘。
// 真实命令执行（本地、无网络）+ 纯投影构造用例，全部临时目录。
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor, type ToolExecutionRequest } from '../src/tools/executor.js';
import type { ExecutionLifecycleObserver } from '../src/tools/executor.js';
import type { ApprovalHandler, ToolResult } from '../src/tools/types.js';
import { bashTool } from '../src/tools/predefined/bash.js';
import { truncateText } from '../src/tools/predefined/common.js';
import { buildToolExecutionView, type ToolExecutionTrace } from '../src/interaction/execution-view.js';

const dirs: string[] = [];
function tmpDir(prefix = 'h2-exec-view-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 真实 shell（Windows = ComSpec/cmd.exe，POSIX = /bin/sh）——测试时点记录来源，非视图臆造 */
function detectShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return '/bin/sh';
}

/** 生命周期观察记录器：复制 executor 观察缝（S1）——onExecuteStart=真正启动，onExecuteEnd=终态一次 */
class TraceRecorder implements ExecutionLifecycleObserver {
  readonly started = new Map<string, { at: string; args: unknown }>();
  readonly ended = new Map<
    string,
    { at: string; ok: boolean; output?: string; error?: string; durationMs?: number }
  >();

  onExecuteStart(req: ToolExecutionRequest): void {
    this.started.set(req.callId, { at: new Date().toISOString(), args: req.args });
  }

  onExecuteEnd(req: ToolExecutionRequest, result: ToolResult): void {
    this.ended.set(req.callId, {
      at: new Date().toISOString(),
      ok: result.ok,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    });
  }
}

function traceFor(
  rec: TraceRecorder,
  opts: { callId: string; taskId?: string; turnId?: string; tool: string; plannedArgs: unknown; cwd: string; shell?: string },
): ToolExecutionTrace {
  const s = rec.started.get(opts.callId);
  const e = rec.ended.get(opts.callId);
  return {
    callId: opts.callId,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
    tool: opts.tool,
    plannedArgs: opts.plannedArgs,
    cwd: opts.cwd,
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    ...(s !== undefined ? { executedArgs: s.args, startedAt: s.at } : {}),
    ...(e !== undefined ? { endedAt: e.at, ok: e.ok, output: e.output, error: e.error, durationMs: e.durationMs } : {}),
  };
}

/** 用真实 bash 工具执行命令并经观察器组装 trace → view */
async function runReal(
  command: string,
  approval?: ApprovalHandler,
): Promise<{ view: ReturnType<typeof buildToolExecutionView>; result: ToolResult }> {
  const cwd = tmpDir();
  const reg = new ToolRegistry();
  reg.register(bashTool);
  const rec = new TraceRecorder();
  const executor = new ToolExecutor(reg, approval);
  const result = await executor.execute(
    { callId: 'real-1', tool: 'bash', args: { command } },
    { signal: new AbortController().signal, cwd, observer: rec },
  );
  const trace = traceFor(rec, { callId: 'real-1', tool: 'bash', plannedArgs: { command }, cwd, shell: detectShell() });
  return { view: buildToolExecutionView(trace), result };
}

describe('toolExecutionView 字段齐全（含身份归属）', () => {
  it('view 含 callId/taskId/turnId、tool、参数、cwd、shell、开始/结束、输出引用、状态', () => {
    const cwd = tmpDir();
    const view = buildToolExecutionView({
      callId: 'call-1',
      taskId: 'task-9',
      turnId: 'turn-2',
      tool: 'bash',
      plannedArgs: { command: 'whoami' },
      cwd,
      shell: detectShell(),
      startedAt: '2026-09-08T00:00:01.000Z',
      endedAt: '2026-09-08T00:00:02.000Z',
      ok: true,
      output: 'alice',
      durationMs: 12,
    });
    expect(view.readOnly).toBe(true);
    expect(view.callId).toBe('call-1');
    expect(view.taskId).toBe('task-9');
    expect(view.turnId).toBe('turn-2');
    expect(view.tool).toBe('bash');
    expect(view.cwd).toBe(cwd);
    expect(view.shell).toBe(detectShell());
    expect(view.startedAt).toBe('2026-09-08T00:00:01.000Z');
    expect(view.endedAt).toBe('2026-09-08T00:00:02.000Z');
    expect(view.durationMs).toBe(12);
    expect(view.outputRef).toContain('alice');
    expect(view.outputTruncated).toBe(false);
    expect(view.status).toBe('success');
  });

  it('参数为计划参数（脱敏拷贝，不与 trace 共享引用）；视图深度冻结', () => {
    const plannedArgs = { command: 'echo hi' };
    const view = buildToolExecutionView({ callId: 'c', tool: 'bash', plannedArgs, cwd: tmpDir(), startedAt: 't' });
    expect(view.args).toEqual(plannedArgs);
    (plannedArgs as { command: string }).command = 'mutated';
    expect((view.args as { command: string }).command).toBe('echo hi');
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.readOnly).toBe(true);
  });
});

describe('真实 bash 执行：shell 与 exitCode 正确归属', () => {
  it('exit 0（成功）：status=success、exitCode=0（bash ok ⇔ 零退出，契约归因）、shell 真实', async () => {
    const { view } = await runReal('node -e "console.log(\'hello-exec-view\')"');
    expect(view.status).toBe('success');
    expect(view.exitCode).toBe(0);
    expect(view.exitCodeSource).toBe('bash-ok');
    expect(view.shell).toBe(detectShell());
    expect(view.outputRef).toContain('hello-exec-view');
    expect(view.outputTruncated).toBe(false);
  }, 15000);

  it('非零退出（失败）：status=failed、exitCode=1（从真实 error 解析）、输出保留供诊断', async () => {
    const { view } = await runReal('node -e "console.log(\'boom-view\'); process.exit(1)"');
    expect(view.status).toBe('failed');
    expect(view.exitCode).toBe(1);
    expect(view.exitCodeSource).toBe('bash-error');
    expect(view.outputRef).toContain('boom-view');
  }, 15000);

  it('exit code 3 与真实执行归属：commandSource=executed，actualCommand=计划命令（req 原样）', async () => {
    const { view } = await runReal('node -e "process.exit(3)"');
    expect(view.status).toBe('failed');
    expect(view.exitCode).toBe(3);
    expect(view.commandSource).toBe('executed');
    expect(view.actualCommand).toBe('node -e "process.exit(3)"');
    expect(view.durationMs).toBeGreaterThanOrEqual(0);
  }, 15000);
});

describe('未执行如实标注（无 startedAt → 不算已执行）', () => {
  it('审批拒绝：从未启动 → not-executed、无实际命令、无 exitCode、输出为空，error 如实', async () => {
    const cwd = tmpDir();
    const reg = new ToolRegistry();
    reg.register(bashTool);
    const rec = new TraceRecorder();
    const deny: ApprovalHandler = { decide: () => 'deny' };
    const result = await new ToolExecutor(reg, deny).execute(
      { callId: 'denied-1', tool: 'bash', args: { command: 'rm dangerous' } },
      { signal: new AbortController().signal, cwd, observer: rec },
    );
    expect(result.ok).toBe(false);
    const trace = traceFor(rec, {
      callId: 'denied-1',
      tool: 'bash',
      plannedArgs: { command: 'rm dangerous' },
      cwd,
      shell: detectShell(),
    });
    const view = buildToolExecutionView(trace);
    expect(view.startedAt).toBeUndefined();
    expect(view.status).toBe('not-executed');
    expect(view.actualCommand).toBeUndefined();
    expect(view.commandSource).toBe('planned-only');
    expect(view.plannedCommand).toBe('rm dangerous'); // 仅计划，未执行
    expect(view.exitCode).toBeUndefined();
    expect(view.exitCodeSource).toBe('none');
    expect(view.outputRef).toBe('');
    expect(view.error).toBe('denied by approval policy');
  });

  it('未知工具：not-executed，无命令归属（commandSource=none），不虚构输出', () => {
    const view = buildToolExecutionView({
      callId: 'unknown-1',
      tool: 'nope',
      plannedArgs: {},
      cwd: tmpDir(),
      error: 'unknown tool: nope',
    });
    expect(view.status).toBe('not-executed');
    expect(view.commandSource).toBe('none');
    expect(view.plannedCommand).toBeUndefined();
    expect(view.actualCommand).toBeUndefined();
    expect(view.exitCode).toBeUndefined();
    expect(view.outputRef).toBe('');
  });
});

describe('输出引用与截断如实标注', () => {
  it('真实 bash 32KB 截断：outputTruncated=true 且输出引用带截断标记', async () => {
    const { view } = await runReal('node -e "console.log(\'x\'.repeat(40000))"');
    expect(view.outputTruncated).toBe(true);
    expect(view.outputRef).toContain('[truncated');
  }, 20000);

  it('来源自带截断标记（未达视图上限）→ 仍如实标 outputTruncated', () => {
    const rec = new TraceRecorder();
    rec.started.set('m', { at: '2026-09-08T00:00:00.000Z', args: { command: 'echo mock' } });
    rec.ended.set('m', {
      at: '2026-09-08T00:00:01.000Z',
      ok: true,
      output: truncateText('data '.repeat(1000), 2000),
    });
    const trace = traceFor(rec, {
      callId: 'm',
      tool: 'bash',
      plannedArgs: { command: 'echo mock' },
      cwd: tmpDir(),
      shell: detectShell(),
    });
    const view = buildToolExecutionView(trace);
    expect(view.outputTruncated).toBe(true);
    expect(view.outputRef).toContain('[truncated');
    // 视图上限不触发（输出 < 4096），截断来自来源标注
    expect(view.outputRef.length).toBeLessThan(4096);
  });

  it('视图级上限：超长输出引用按视图上限截断并标 truncated', () => {
    const view = buildToolExecutionView({
      callId: 'v',
      tool: 'bash',
      plannedArgs: { command: 'yes' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: true,
      output: 'a'.repeat(20_000),
    });
    expect(view.outputTruncated).toBe(true);
    expect(view.outputRef).toContain('[truncated');
    expect(view.outputRef.length).toBeLessThan(4096 + 100);
  });
});

describe('计划中命令 ≠ 已执行命令：归属清楚', () => {
  it('executedArgs 与 plannedArgs 不同 → actualCommand 用真实采样，plannedCommand 保留计划原文', () => {
    const view = buildToolExecutionView({
      callId: 'c',
      tool: 'bash',
      plannedArgs: { command: 'echo planned' },
      executedArgs: { command: 'echo actual' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: true,
    });
    expect(view.plannedCommand).toBe('echo planned');
    expect(view.actualCommand).toBe('echo actual'); // 真实采样优先，不回计划原文
    expect(view.commandSource).toBe('executed');
  });
});

describe('状态机：running / cancelled / unknown 如实', () => {
  it('只有 started 无 ended → running', () => {
    const view = buildToolExecutionView({
      callId: 'r',
      tool: 'bash',
      plannedArgs: { command: 'slow' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(view.status).toBe('running');
    expect(view.exitCode).toBeUndefined();
  });

  it('结束于 cancelled（S1 归一）→ cancelled，而非 failed', () => {
    const view = buildToolExecutionView({
      callId: 'x',
      tool: 'bash',
      plannedArgs: { command: 'killme' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: false,
      error: 'cancelled',
    });
    expect(view.status).toBe('cancelled');
  });

  it('取消归一 unknown（不合作工具）→ unknown', () => {
    const view = buildToolExecutionView({
      callId: 'u',
      tool: 'bash',
      plannedArgs: { command: 'stubborn' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: false,
      error: 'unknown',
    });
    expect(view.status).toBe('unknown');
  });
});

describe('脱敏：命令/输出/参数中密钥不暴露', () => {
  it('sk- 形态密钥在 plannedCommand/outputRef 中被掩盖；敏感参数键值为 [REDACTED]', () => {
    const view = buildToolExecutionView({
      callId: 'sec',
      tool: 'bash',
      plannedArgs: { command: 'echo sk-abcdefgh123456', token: 'sk-abcdefgh123456' },
      cwd: tmpDir(),
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: true,
      output: 'sk-abcdefgh123456 leaked',
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-abcdefgh123456');
    expect(view.plannedCommand).toContain('[REDACTED]');
    expect(view.outputRef).not.toContain('sk-abcdefgh123456');
    expect((view.args as { token: string }).token).toBe('[REDACTED]');
  });
});

describe('只读投影：构建视图不重跑、不写盘', () => {
  it('对「将运行的命令」构建视图：不产生任何文件副作用，cwd 内容原样', () => {
    const cwd = tmpDir();
    writeFileSync(join(cwd, 'keep.txt'), 'keep', 'utf8');
    const view = buildToolExecutionView({
      callId: 'no-run',
      tool: 'bash',
      plannedArgs: { command: 'touch hacked.txt' },
      cwd,
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:00:01.000Z',
      ok: false,
      error: 'exit code 1',
    });
    expect(view.status).toBe('failed');
    expect(view.exitCode).toBe(1);
    expect(existsSync(join(cwd, 'hacked.txt'))).toBe(false); // 未重跑
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8')).toBe('keep');
  });
});