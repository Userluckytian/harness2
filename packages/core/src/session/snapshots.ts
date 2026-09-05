// 文件级快照存储（决策 D6，grok rewind 语义）：独立于 git 的 before/after 快照。
// 存储位置 = 会话目录内的辅助文件 rewind_points.jsonl（一行一条 JSON），绝不回改
// session.v1.jsonl（append-only 红线）。条目键 = 对应 tool/call 事件的 seq。
//
// 写入协议（由 agent loop 驱动，见 agent/loop.ts）：
//   capture(seq, file, before)   —— 工具执行前读取当前内容存入内存待写表；
//   commitAfter(seq, after)      —— 工具成功后补记，整条 {seq,file,before,after} 追加落盘。
// 失败/取消不调用 commitAfter → 不产生条目（未完成的修改没有恢复点）。
//
// 恢复语义：
//   restore(toSeq)        —— undo：对 seq > toSeq 的条目**按文件取最早一条**恢复 before
//                            （文件创建→删除）。冲突检测：当前内容 ≠ 该文件在被撤操作中
//                            最后一次记录的 after → externallyModified（dryRun 列出；
//                            实际恢复时报告后仍执行）。
//   restoreAfter(fromSeq) —— redo：对 seq > fromSeq 的条目按文件取最新一条恢复 after；
//                            冲突检测基准 = 最早一条的 before（即 undo 实际恢复到的状态）。
//
// 崩溃容错：读取时按 writer 同款「换行即提交」策略容错——末尾未以 \n 终止的行与
// 解析失败的已提交行一律跳过（快照是辅助文件，缺一条目的代价小于读取崩溃）。
//
// 已知边界（M1）：bash 造成的文件改动不进快照（如实声明于 chat 帮助与 README）；
// undo 与 redo 之间若发生了新的被快照追踪的写入，redo 的冲突检测会报告
// externallyModified（恢复本身是最新 after 的幂等写，无数据风险）。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** 快照条目文件名（位于会话目录内，与 session.v1.jsonl 同级） */
export const REWIND_POINTS_FILE = 'rewind_points.jsonl';

/** 快照条目：v 仅用于未来格式代际；file 恒为绝对路径；null = 文件不存在 */
export interface SnapshotEntry {
  v: 1;
  seq: number;
  file: string;
  before: string | null;
  after: string | null;
}

/** 单文件恢复计划/结果 */
export interface SnapshotRestoreItem {
  file: string;
  /** 将恢复/已恢复到的内容（null = 删除该文件） */
  target: string | null;
  /** 扫描时的当前内容（null = 不存在） */
  current: string | null;
  /** 当前内容与该文件最后一次被追踪的落点不一致（可能被外部修改） */
  externallyModified: boolean;
  /** dryRun 时恒为 false */
  restored: boolean;
  /** 单文件恢复失败原因（不中断整体恢复） */
  error?: string;
}

export interface SnapshotRestoreResult {
  dryRun: boolean;
  items: SnapshotRestoreItem[];
}

export interface SnapshotCaptureInput {
  seq: number;
  file: string;
  before: string | null;
}

export interface SnapshotCommitInput {
  seq: number;
  after: string | null;
}

/** 快照参与工具：名称 → 参数中的目标文件字段（loop 据此捕获；bash/read 等不参与） */
export const SNAPSHOT_TOOLS: Readonly<Record<string, string>> = {
  write: 'file_path',
  edit: 'file_path',
};

/**
 * 从工具调用参数中解析快照目标文件的绝对路径（相对路径按 cwd 解析）。
 * 非快照工具 / 参数缺失 / 类型不符返回 null（该调用不产生快照，工具自身会校验报错）。
 */
export function snapshotTargetFile(tool: string, args: unknown, cwd: string): string | null {
  const key = SNAPSHOT_TOOLS[tool];
  if (!key) return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const raw = (args as Record<string, unknown>)[key];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return resolve(cwd, raw);
}

/** 读取文本文件内容；不存在返回 null（读取失败同样按不存在处理——快照尽力而为） */
export function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 原子写（tmp + rename），与 tools/predefined/common.ts 的 writeAtomic 同策略；
 * 本模块不依赖工具层，故本地实现（两处须保持一致）。
 */
function writeTextAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不影响主错误
    }
    throw e;
  }
}

function isSnapshotEntry(obj: unknown): obj is SnapshotEntry {
  if (typeof obj !== 'object' || obj === null) return false;
  const e = obj as Record<string, unknown>;
  return (
    e['v'] === 1 &&
    typeof e['seq'] === 'number' &&
    Number.isInteger(e['seq']) &&
    typeof e['file'] === 'string' &&
    (e['before'] === null || typeof e['before'] === 'string') &&
    (e['after'] === null || typeof e['after'] === 'string')
  );
}

/** 解析单个文件目标在 restore/restoreAfter 下的恢复计划（按文件分组，seq 升序） */
interface FilePlan {
  file: string;
  firstSeq: number;
  /** 该文件 seq 范围内最早一条 */
  earliest: SnapshotEntry;
  /** 该文件 seq 范围内最新一条 */
  latest: SnapshotEntry;
}

function groupByFile(entries: readonly SnapshotEntry[]): FilePlan[] {
  const byFile = new Map<string, SnapshotEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.file);
    if (list) list.push(e);
    else byFile.set(e.file, [e]);
  }
  const plans: FilePlan[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.seq - b.seq);
    plans.push({ file, firstSeq: list[0]!.seq, earliest: list[0]!, latest: list[list.length - 1]! });
  }
  plans.sort((a, b) => a.firstSeq - b.firstSeq); // 稳定输出顺序（按首次触碰顺序）
  return plans;
}

/** 应用单文件恢复：内容写回 / null 删除；失败转 item.error（不抛出） */
function applyRestore(item: SnapshotRestoreItem): void {
  try {
    if (item.target === null) {
      try {
        unlinkSync(item.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    } else {
      writeTextAtomic(item.file, item.target);
    }
    item.restored = true;
  } catch (e) {
    item.error = (e as Error | undefined)?.message ?? String(e);
  }
}

export class SnapshotStore {
  private readonly path: string;
  /** 已 capture、待 commitAfter 的条目（键 = tool/call 事件 seq） */
  private readonly pending = new Map<number, { file: string; before: string | null }>();

  constructor(readonly dir: string) {
    this.path = join(dir, REWIND_POINTS_FILE);
  }

  /** 工具执行前调用：登记 before（仅入内存，落盘延后到 commitAfter） */
  capture(entry: SnapshotCaptureInput): void {
    if (!Number.isInteger(entry.seq) || entry.seq < 1) {
      throw new Error(`invalid snapshot seq: ${entry.seq}`);
    }
    const file = isAbsolute(entry.file) ? entry.file : resolve(entry.file); // 路径规范化：条目存绝对路径
    this.pending.set(entry.seq, { file, before: entry.before });
  }

  /** 工具成功后调用：整条 {seq,file,before,after} 追加落盘；失败/取消不调用本方法 */
  commitAfter(entry: SnapshotCommitInput): void {
    const captured = this.pending.get(entry.seq);
    if (!captured) {
      throw new Error(`commitAfter without capture for seq ${entry.seq}`);
    }
    this.pending.delete(entry.seq);
    const line = JSON.stringify({
      v: 1,
      seq: entry.seq,
      file: captured.file,
      before: captured.before,
      after: entry.after,
    } satisfies SnapshotEntry);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, line + '\n', { flag: 'a', encoding: 'utf8' });
  }

  /** 已落盘条目（每次从文件重读；崩溃残行按「换行即提交」策略跳过） */
  entries(): SnapshotEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const entries: SnapshotEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue; // 空行 / 末尾分隔符
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 撕裂/损坏行：跳过
      }
      if (isSnapshotEntry(obj)) entries.push(obj);
    }
    return entries;
  }

  /**
   * undo 恢复：对 seq > toSeq 的条目按文件取最早一条恢复 before。
   * 冲突基准 = 该文件在被撤操作中最后一次记录的 after。
   */
  restore(toSeq: number, opts: { dryRun?: boolean } = {}): SnapshotRestoreResult {
    const entries = this.entries().filter((e) => e.seq > toSeq);
    return this.plan(entries, { mode: 'before', dryRun: opts.dryRun ?? false });
  }

  /**
   * redo 恢复：对 seq > fromSeq 的条目按文件取最新一条恢复 after。
   * 冲突基准 = 最早一条的 before（undo 实际恢复到的状态）。
   */
  restoreAfter(fromSeq: number, opts: { dryRun?: boolean } = {}): SnapshotRestoreResult {
    const entries = this.entries().filter((e) => e.seq > fromSeq);
    return this.plan(entries, { mode: 'after', dryRun: opts.dryRun ?? false });
  }

  /**
   * plan：mode='before'（undo）→ 目标取每文件最早一条的 before、冲突基准 = 最新一条的 after；
   *       mode='after' （redo）→ 目标取每文件最新一条的 after、冲突基准 = 最早一条的 before。
   */
  private plan(
    entries: readonly SnapshotEntry[],
    opts: { mode: 'before' | 'after'; dryRun: boolean },
  ): SnapshotRestoreResult {
    const undoMode = opts.mode === 'before';
    const items: SnapshotRestoreItem[] = [];
    for (const plan of groupByFile(entries)) {
      const expected = undoMode ? plan.latest.after : plan.earliest.before;
      const current = readTextOrNull(plan.file);
      const item: SnapshotRestoreItem = {
        file: plan.file,
        target: undoMode ? plan.earliest.before : plan.latest.after,
        current,
        externallyModified: current !== expected,
        restored: false,
      };
      if (!opts.dryRun) applyRestore(item);
      items.push(item);
    }
    return { dryRun: opts.dryRun, items };
  }
}
