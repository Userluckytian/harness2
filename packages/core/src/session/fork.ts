// 会话分叉（阶段 6，对照 deepseek-harness header 血缘方案）：
// 从原会话活动投影截取事件（seq <= atSeq，缺省 = 全部活动）重放进新会话（新 seq），
// 新 header 记录 parentSession/isSeeded 血缘；原会话零改动（append-only 日志只读不写）。
// 明确不复制：session/header（新会话有自己的）、rewind/marker（新会话 undo 从零开始，
// README 已注明）、影子事件（被回退遮蔽的 history 不进新时间线）、文件快照（快照
// 属原会话目录，不迁移）。memory/snapshot 是普通活动事件，照常复制（分叉后冻结
// 语义继续成立：后续轮复用快照）。
// D02 扩展事件：活动（未被 rewind 遮蔽）且 seq <= atSeq 的扩展事件照常复制
// （appendExtension 重放；类型必须仍处于注册态，未注册 fail-closed 抛错）。
import { rmSync } from 'node:fs';
import { computeProjection, loadSession } from './reader.js';
import { SessionManager } from './manager.js';
import type { ExtensionSessionEvent } from './extension-events.js';
import { isSessionEventType, type AnySessionEvent } from './types.js';
import { SessionWriter } from './writer.js';

export interface ForkOptions {
  /** 截取上界（含）：只复制 seq <= atSeq 的活动非 header/非 rewind 事件；缺省 = 全部活动 */
  atSeq?: number;
}

export interface ForkResult {
  /** 新会话 id */
  id: string;
  dir: string;
  /** 原会话 id（= 新 header.parentSession） */
  parentSession: string;
  /** 复制的活动事件数 */
  copiedEvents: number;
}

/** 分叉失败（code 供 hub/HTTP 出口映射状态码：not_found / invalid） */
export class ForkError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ForkError';
  }
}

/** 原会话（含 header.cwd）→ 新会话（血缘 header + 事件重放）。原会话日志零改动。 */
export function forkSession(manager: SessionManager, id: string, options: ForkOptions = {}): ForkResult {
  let dir: string;
  try {
    dir = manager.locate(id);
  } catch {
    throw new ForkError('not_found', `session not found: ${id}`);
  }
  const session = loadSession(dir);
  const header = session.header;
  if (header === null || header.cwd === undefined) {
    throw new ForkError('invalid', `会话 ${id} 缺少 header.cwd，无法确定分叉会话的分组目录`);
  }
  computeProjection(session); // 就地标记活动性（内建与扩展两条通道；影子事件不复制）
  const lastSeq = Math.max(session.events.at(-1)?.event.seq ?? 0, session.extensionEvents.at(-1)?.event.seq ?? 0);
  const atSeq = options.atSeq ?? lastSeq;
  if (!Number.isInteger(atSeq) || atSeq < 1 || atSeq > lastSeq) {
    throw new ForkError('invalid', `atSeq 必须是 1..${lastSeq} 的整数，实际为 ${String(options.atSeq)}`);
  }
  // 两条活动通道按原 seq 归并（保持日志序重放）：内建排除 header/rewind，扩展照常携带
  const toCopy: Array<AnySessionEvent | ExtensionSessionEvent> = [
    ...session.events
      .filter(
        ({ event, active }) =>
          active && event.seq <= atSeq && event.type !== 'session/header' && event.type !== 'rewind/marker',
      )
      .map(({ event }) => event),
    ...session.extensionEvents.filter(({ event, active }) => active && event.seq <= atSeq).map(({ event }) => event),
  ].sort((a, b) => a.seq - b.seq);

  // 新会话落在与原会话相同的 cwd 组（encodeCwd 对同一 cwd 真值结果确定）
  const created = manager.create(header.cwd, { parentSession: id, isSeeded: true });
  const writer: SessionWriter = created.writer;
  try {
    for (const event of toCopy) {
      if (isSessionEventType(event.type)) {
        const builtin = event as AnySessionEvent;
        writer.append(builtin.type, builtin.payload); // 新 seq + 新 ts；payload 原样保留（含原 turnId）
      } else {
        const ext = event as ExtensionSessionEvent;
        writer.appendExtension(ext.type, ext.payload); // 扩展事件经注册表 validator 重放
      }
    }
  } catch (e) {
    // 复制中途失败：关闭半成品 writer 并删除半成品会话目录（不让半截会话留在库里）
    writer.close();
    try {
      rmSync(created.dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
  writer.close(); // 分叉即关闭；后续由调用方按需 resume（锁不长期占用）

  return { id: created.id, dir: created.dir, parentSession: id, copiedEvents: toCopy.length };
}
