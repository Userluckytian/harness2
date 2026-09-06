// 记忆写入 gate 的 pending 暂存（阶段 4，对照 hermes tools/write_approval.py 的 stage 语义）：
// mode=ask 时模型的记忆写入不直接落盘，先进 pending/<ts>-<id>.json（记录 ops + 来源会话），
// 人工 `harness2 memory approve <id>` 重放执行 / `reject <id>` 丢弃——只延迟、绝不静默丢弃。
// 同进程互斥与 MemoryStore 同思路（promise 链）；文件原子写（tmp + rename）。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultMemoriesRoot, validateOp, MemoryStore, type MemoryApplyResult, type MemoryOp } from './store.js';

export const PENDING_DIR_NAME = 'pending';

export function defaultPendingRoot(home?: string): string {
  return join(defaultMemoriesRoot(home), PENDING_DIR_NAME);
}

/** 一条待审批的记忆写入（ops 语义与 memory 工具完全一致，approve 时原样重放） */
export interface PendingMemory {
  /** 文件名去 .json 后缀：<epochMs>-<rand4> */
  id: string;
  createdAt: string;
  /** 触发写入的来源会话（主 turn 或复盘 turn 所属会话） */
  sessionId: string;
  ops: MemoryOp[];
}

export interface PendingApproveResult {
  ok: boolean;
  /** 重放执行结果（stage 校验失败 / 文件缺失时缺省） */
  result?: MemoryApplyResult;
  error?: string;
}

function pendingFileName(now: Date): { id: string; file: string } {
  const id = `${now.getTime()}-${randomBytes(2).toString('hex')}`;
  return { id, file: `${id}.json` };
}

function parsePendingFile(raw: string): PendingMemory | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || typeof obj['createdAt'] !== 'string') return null;
    if (typeof obj['sessionId'] !== 'string') return null;
    if (!Array.isArray(obj['ops'])) return null;
    for (const op of obj['ops']) {
      if (validateOp(op) !== null) return null;
    }
    return { id: obj['id'], createdAt: obj['createdAt'], sessionId: obj['sessionId'], ops: obj['ops'] as MemoryOp[] };
  } catch {
    return null;
  }
}

export class PendingMemoryStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string = defaultPendingRoot(),
    /** approve 重放的目标 store（与主记忆同一 MemoryStore 实例） */
    private readonly store?: MemoryStore,
  ) {}

  private run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const next = this.chain.then(fn, fn) as Promise<T>;
    this.chain = next.catch(() => {});
    return next;
  }

  /** 暂存一批操作（形状校验失败即拒绝，不产生文件） */
  stage(sessionId: string, ops: readonly MemoryOp[]): Promise<PendingMemory> {
    return this.run(() => {
      if (!Array.isArray(ops) || ops.length === 0) throw new Error('pending: operations 不能为空');
      for (const [i, op] of ops.entries()) {
        const invalid = validateOp(op);
        if (invalid !== null) throw new Error(`pending: operations[${i}]: ${invalid}`);
      }
      mkdirSync(this.root, { recursive: true });
      const { id, file } = pendingFileName(new Date());
      const pending: PendingMemory = {
        id,
        createdAt: new Date().toISOString(),
        sessionId,
        ops: [...ops],
      };
      // 同毫秒碰撞防御：文件已存在则报错重试由调用方发起（概率极低，随机后缀 1/65536）
      const path = join(this.root, file);
      if (existsSync(path)) throw new Error(`pending: 文件已存在: ${file}`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(pending, null, 2), 'utf8');
      renameSync(tmp, path);
      return pending;
    });
  }

  /** 全部待审批项（createdAt 升序，先到先审） */
  list(): Promise<PendingMemory[]> {
    return this.run(() => {
      if (!existsSync(this.root)) return [];
      const items: PendingMemory[] = [];
      for (const name of listJsonFiles(this.root)) {
        const parsed = parsePendingFile(readFileSync(join(this.root, name), 'utf8'));
        if (parsed !== null) items.push(parsed);
      }
      return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  get(id: string): Promise<PendingMemory | null> {
    return this.run(() => this.getSync(id));
  }

  private getSync(id: string): PendingMemory | null {
    const path = join(this.root, `${id}.json`);
    if (!existsSync(path)) return null;
    return parsePendingFile(readFileSync(path, 'utf8'));
  }

  /**
   * 审批通过：重放 ops 到 store（预算/漂移等写侧校验全部生效）。
   * 成功 → 删除暂存文件；失败（预算满/漂移等）→ 保留暂存（只延迟不丢弃），返回原因。
   */
  approve(id: string): Promise<PendingApproveResult> {
    return this.run(async () => {
      if (this.store === undefined) {
        return { ok: false, error: 'pending: 未配置记忆 store，无法重放执行' };
      }
      const pending = this.getSync(id);
      if (pending === null) return { ok: false, error: `pending: 未找到待审批项 ${id}` };
      const result = await this.store.apply(pending.ops);
      if (result.ok) {
        const path = join(this.root, `${id}.json`);
        try {
          unlinkSync(path);
        } catch {
          /* 已不存在 */
        }
        return { ok: true, result };
      }
      return { ok: false, result, error: result.error };
    });
  }

  /** 拒绝：删除暂存文件（用户显式丢弃） */
  reject(id: string): Promise<boolean> {
    return this.run(() => {
      const path = join(this.root, `${id}.json`);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    });
  }
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.json'));
}
