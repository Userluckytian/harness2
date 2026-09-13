// 命令层测试共用缝：录制式 CoreCommandContext（收集 print 行与调用记录，便于逐字断言）。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCoreCommand, runCoreCommand } from '../../src/commands/index.js';
import type { CoreCommandContext } from '../../src/commands/types.js';
import { SessionManager } from '../../src/session/manager.js';

export interface RecordingContext extends CoreCommandContext {
  /** print 收集的输出行（逐字断言用） */
  lines: string[];
  /** switchSession 调用记录（null = /new） */
  switched: Array<string | null>;
  /** fork 调用记录（undefined = 未带序号） */
  forkCalls: Array<number | undefined>;
  /** requestExit 调用计数 */
  exitCalls: { count: number };
}

/**
 * 录制式命令缝：默认全缝已接（current=null、无快照、无 fork/contextUsage/compact/cronJobs），
 * 需要的缝在各用例经 overrides 注入。manager 默认指向不存在的临时根（list/search 返回空），
 * 需要真实会话的用例自行传入 tmp 根的 SessionManager。
 */
export function makeRecordingCtx(overrides: Partial<CoreCommandContext> = {}): RecordingContext {
  const ctx: RecordingContext = {
    lines: [],
    switched: [],
    forkCalls: [],
    exitCalls: { count: 0 },
    print: (t) => ctx.lines.push(t),
    manager: new SessionManager(join(tmpdir(), 'h2-commands-dummy-root')),
    cwd: join(tmpdir(), 'h2-commands-dummy-cwd'),
    current: () => null,
    switchSession: (id) => ctx.switched.push(id),
    requestExit: () => ctx.exitCalls.count++,
    snapshots: () => undefined,
    ...overrides,
  };
  return ctx;
}

/** 执行一条命令并等待完成（同步 run 直接返回；异步 run 等待 Promise）——测试分发辅助 */
export async function execCommand(line: string, ctx: CoreCommandContext): Promise<void> {
  const parsed = parseCoreCommand(line);
  if (parsed === null) throw new Error(`非命令行: ${line}`);
  const r = runCoreCommand(parsed, ctx);
  if (r instanceof Promise) await r;
}
