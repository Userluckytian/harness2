// 长期记忆存储（阶段 6，对照 hermes tools/memory_tool_store.py 实证方案）：
//   - 两个文件：MEMORY.md（agent 笔记）/ USER.md（用户画像），条目以 "\n§\n" 分隔；
//   - 字符硬预算（模型无关）：memory 2200 / user 1375；超限由模型"删旧加新"整合，
//     写入器按最终态一次性校验预算并强制拒绝超限写入；
//   - 同进程互斥（promise 链）+ 原子写（tmp + rename）；跨进程文件锁不做（与会话锁
//     P2-3 已知限制同口径，如实声明）；
//   - 漂移检测：写前按 § 结构解析现状，手工编辑破坏结构 → 拒写并把原文件备份 .bak；
//   - 注入扫描：新增/替换文本命中典型指令注入模式 → 标记警告仍写入（结果随 tool 返回）。
// 隐私红线：记忆内容属用户私有数据（~/.harness2/memories/），绝不写入错误消息出口、
// 绝不进 git（测试全用临时目录）。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MEMORY_FILE_NAME = 'MEMORY.md';
export const USER_FILE_NAME = 'USER.md';
/** agent 笔记预算（字符，模型无关） */
export const MEMORY_BUDGET_CHARS = 2200;
/** 用户画像预算（字符，模型无关） */
export const USER_BUDGET_CHARS = 1375;

export type MemoryTarget = 'memory' | 'user';

export const MEMORY_TARGETS: readonly MemoryTarget[] = ['memory', 'user'];

const ENTRY_SEPARATOR = '\n§\n';
const SEPARATOR_LINE = '§';

export function defaultMemoriesRoot(home?: string): string {
  return join(home ?? homedir(), '.harness2', 'memories');
}

export function memoryFileName(target: MemoryTarget): string {
  return target === 'memory' ? MEMORY_FILE_NAME : USER_FILE_NAME;
}

export function memoryBudget(target: MemoryTarget): number {
  return target === 'memory' ? MEMORY_BUDGET_CHARS : USER_BUDGET_CHARS;
}

/** 条目文本不得包含分隔行（否则 round-trip 切分会把它拆成多条，结构即坏） */
function hasSeparatorLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === SEPARATOR_LINE);
}

// —— § 结构解析（写前 round-trip 校验 = 漂移检测的读侧） ——

export interface MemoryParseOk {
  ok: true;
  entries: string[];
}

export interface MemoryParseDrift {
  ok: false;
}

/**
 * 解析记忆文件原文为条目数组。结构规则（写入器产出的形态）：
 *   空文件（或纯空白）= 0 条；条目 = 原文按精确 "\n§\n" 切分，任一切片为空、
 *   或切片内含 trim 后为 "§" 的行（含 CRLF 分隔符等编辑器改写）= 结构破坏（漂移）。
 * 容忍：结尾多余的换行（编辑器常见）；条目内部的空行与任意文本。
 */
export function parseMemoryFile(raw: string): MemoryParseOk | MemoryParseDrift {
  if (raw.trim() === '') return { ok: true, entries: [] };
  const normalized = raw.replace(/[\r\n]+$/, '');
  const pieces = normalized.split(ENTRY_SEPARATOR);
  const entries: string[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) return { ok: false };
    if (piece.split(/\r?\n/).some((line) => line.trim() === SEPARATOR_LINE)) return { ok: false };
    entries.push(piece);
  }
  return { ok: true, entries };
}

/** 条目 → 文件原文（写入器唯一序列化出口，与 parseMemoryFile 严格互逆） */
export function serializeMemoryEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_SEPARATOR);
}

/**
 * 组装冻结进 system 的记忆快照文本（阶段 6 注入缝的唯一组装处）：
 * 两个文件都为空（或纯空白）→ null（不注入、不落事件）；
 * 否则带节头拼装（空文件标注「（空）」），整体作为 memory/snapshot.content 落盘。
 */
export function assembleMemorySnapshot(memoryContent: string, userContent: string): string | null {
  if (memoryContent.trim().length === 0 && userContent.trim().length === 0) return null;
  const memory = memoryContent.trim().length > 0 ? memoryContent.trimEnd() : '（空）';
  const user = userContent.trim().length > 0 ? userContent.trimEnd() : '（空）';
  return [
    '以下是你的长期记忆快照（会话开始时冻结；如需更新请使用 memory 工具）：',
    `## memory（${MEMORY_FILE_NAME}）`,
    memory,
    `## user（${USER_FILE_NAME}）`,
    user,
  ].join('\n');
}

// —— 注入扫描 ——

export interface InjectionPattern {
  name: string;
  regex: RegExp;
}

/** 典型指令注入模式（启发式清单；命中只告警不拦截——标记后仍按原样写入） */
export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  // ignore/disregard previous|prior|above|earlier（含 "ignore the above/previous" 冠词形态）
  {
    name: 'ignore previous instructions',
    regex: /(?:ignore|disregard)\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  },
  // 忽略/无视 + 之前/以上/上述/前面/先前/上面 + 对话/指令/内容/提示
  {
    name: '忽略之前指令',
    regex: /(?:忽略|无视)(?:掉)?(?:之前|以上|上述|前面|先前|上面)(?:的)?(?:所有|全部)?(?:对话|指令|内容|提示)/,
  },
  { name: 'system prompt 泄露', regex: /system\s*prompt/i },
  { name: '系统提示', regex: /系统提示(?:词|语)?/ },
  // reveal/show/print/repeat + your/the + instructions/rules/system prompt/system instructions
  {
    name: 'reveal instructions',
    regex: /(?:reveal|show|print|repeat)\s+(?:your|the)\s+(?:system\s+(?:prompt|instructions)|instructions|rules)/i,
  },
  // 泄露/透露/打印/复述你的系统提示词/系统指令/初始指令（须带「你的」，避免误伤普通「输出系统提示」描述）
  {
    name: '泄露你的系统指令',
    regex: /(?:泄露|透露|打印|复述)(?:一下)?你的(?:系统提示(?:词|语)?|系统指令|系统设定|(?:初始|原始)指令)/,
  },
];

export interface InjectionFinding {
  /** 命中的文本序号（scanInjection 入参数组下标） */
  index: number;
  pattern: string;
}

/** 对一批待写入文本做注入扫描；命中返回发现清单（不拦截） */
export function scanInjection(texts: readonly string[]): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [index, text] of texts.entries()) {
    for (const { name, regex } of INJECTION_PATTERNS) {
      if (regex.test(text)) findings.push({ index, pattern: name });
    }
  }
  return findings;
}

// —— 操作与结果 ——

export interface MemoryOp {
  operation: 'add' | 'replace' | 'remove';
  target: MemoryTarget;
  /** add/replace 的新条目文本 */
  text?: string;
  /** replace/remove 要匹配的现有条目全文 */
  oldText?: string;
}

export interface MemoryFileUsage {
  target: MemoryTarget;
  entries: number;
  usedChars: number;
  remainingChars: number;
  budget: number;
}

export interface MemoryReadResult {
  target: MemoryTarget;
  file: string;
  /** 原文（条目按 "\n§\n" 连接；漂移时为原样读到的内容） */
  content: string;
  /** 解析出的条目（漂移时为空数组） */
  entries: string[];
  /** 结构漂移（手工编辑破坏 § 结构）：照常返回原文，但写入会被拒绝 */
  drift: boolean;
  entriesCount: number;
  budget: number;
  usedChars: number;
  remainingChars: number;
}

export interface MemoryApplyResult {
  ok: boolean;
  /** 失败原因（一行中文；不携带记忆正文） */
  error?: string;
  /** 注入扫描警告（一行/条） */
  warnings: string[];
  /** 写入后的各目标用量（仅实际写入的文件） */
  files: MemoryFileUsage[];
  /** 漂移拒绝时 .bak 备份路径 */
  backupPath?: string;
}

/** 单操作形状校验：非法返回错误消息，合法返回 null（add 的 text/replace 的 text 不得含 § 分隔行） */
export function validateOp(op: unknown): string | null {
  if (typeof op !== 'object' || op === null || Array.isArray(op)) return '操作必须是对象';
  const o = op as Record<string, unknown>;
  if (o['operation'] !== 'add' && o['operation'] !== 'replace' && o['operation'] !== 'remove') {
    return `operation 必须是 add | replace | remove，实际为 ${JSON.stringify(o['operation'])}`;
  }
  if (o['target'] !== 'memory' && o['target'] !== 'user') {
    return `target 必须是 memory | user，实际为 ${JSON.stringify(o['target'])}`;
  }
  const operation = o['operation'] as MemoryOp['operation'];
  const text = o['text'];
  const oldText = o['oldText'];
  const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (operation === 'add') {
    if (!isText(text)) return 'add 需要非空的 text';
    if (hasSeparatorLine(text)) return 'text 不得包含整行 "§"（它是条目分隔符）';
  } else {
    const wanted = operation === 'replace' ? oldText : (oldText ?? text);
    if (!isText(wanted)) return `${operation} 需要非空的 oldText（现有条目全文）`;
    if (operation === 'replace') {
      if (!isText(text)) return 'replace 需要非空的 text（替换后的新文本）';
      if (hasSeparatorLine(text)) return 'text 不得包含整行 "§"（它是条目分隔符）';
    }
  }
  return null;
}

/** 条目匹配：全文精确相等，或 trim 后相等（模型难以复刻逐字节空白） */
function entryMatches(entry: string, wanted: string): boolean {
  return entry === wanted || entry.trim() === wanted.trim();
}

function findEntryIndex(entries: readonly string[], wanted: string): number {
  return entries.findIndex((e) => entryMatches(e, wanted));
}

/**
 * 同进程互斥：全 store 单 promise 链串行（读+写同链，读-改-写无交错窗口）。
 * 跨进程锁不做——记忆操作频率低，CLI/serve 各持一 store 的进程间并发由 OS 级
 * rename 原子性兜底为"后写者胜"（无部分写），如实声明不提供跨进程互斥。
 */
class StoreMutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
    const next = this.chain.then(fn, fn) as Promise<T>;
    this.chain = next.catch(() => {});
    return next;
  }
}

export class MemoryStore {
  private readonly mutex = new StoreMutex();

  constructor(readonly root: string = defaultMemoriesRoot()) {}

  fileFor(target: MemoryTarget): string {
    return join(this.root, memoryFileName(target));
  }

  /** 读取一个目标的现状（只读；漂移以 drift 标记返回，不抛错） */
  read(target: MemoryTarget): Promise<MemoryReadResult> {
    return this.mutex.run(() => this.readSync(target));
  }

  /**
   * 原子执行一批操作（全成或全不成）：
   *   1. 形状校验（operation/target/text/oldText/§ 分隔行）→ 任一非法即整体拒绝；
   *   2. 各目标读现状 + 漂移检测（破坏 § 结构 → 拒写 + .bak 备份原文件）；
   *   3. 按序应用操作（replace/remove 需命中现有条目，未命中即整体拒绝）；
   *   4. 预算按**最终态**一次性校验（"删旧加新"批量的中间态允许临时超限）；
   *   5. 全部通过后才落盘：先写全部 .tmp，再逐个 rename（同目录 rename 原子；
   *      跨文件非事务，第二个 rename 失败的极端窗口由"后写者胜"兜底，无部分写文件）。
   */
  apply(ops: readonly MemoryOp[]): Promise<MemoryApplyResult> {
    return this.mutex.run(() => this.applySync(ops));
  }

  private readSync(target: MemoryTarget): MemoryReadResult {
    const file = this.fileFor(target);
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const parsed = parseMemoryFile(raw);
    const entries = parsed.ok ? parsed.entries : [];
    const budget = memoryBudget(target);
    const content = parsed.ok ? serializeMemoryEntries(entries) : raw;
    return {
      target,
      file,
      content,
      entries,
      drift: !parsed.ok,
      entriesCount: entries.length,
      budget,
      usedChars: content.length,
      remainingChars: Math.max(0, budget - content.length),
    };
  }

  private applySync(ops: readonly MemoryOp[]): MemoryApplyResult {
    const warnings: string[] = [];
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, error: 'operations 不能为空', warnings, files: [] };
    }
    // 1. 形状校验
    for (const [i, op] of ops.entries()) {
      const invalid = validateOp(op);
      if (invalid !== null) return { ok: false, error: `operations[${i}]: ${invalid}`, warnings, files: [] };
    }
    // 2. 各目标读现状 + 漂移检测
    const targets = [...new Set(ops.map((o) => o.target))];
    const states = new Map<MemoryTarget, { entries: string[]; raw: string; file: string }>();
    for (const target of targets) {
      const file = this.fileFor(target);
      const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const parsed = parseMemoryFile(raw);
      if (!parsed.ok) {
        // 漂移：拒写 + .bak 备份（防手工编辑被静默覆盖；重复触发覆盖旧 .bak，保留最新漂移现场）
        const backupPath = `${file}.bak`;
        writeFileSync(backupPath, raw, 'utf8');
        return {
          ok: false,
          error: `${memoryFileName(target)} 结构被外部修改（§ 结构漂移），已拒绝写入并备份到 ${backupPath}`,
          warnings,
          files: [],
          backupPath,
        };
      }
      states.set(target, { entries: [...parsed.entries], raw, file });
    }
    // 3. 按序应用操作
    for (const [i, op] of ops.entries()) {
      const state = states.get(op.target)!;
      if (op.operation === 'add') {
        state.entries.push(op.text!);
        continue;
      }
      const wanted = op.oldText ?? op.text!;
      const idx = findEntryIndex(state.entries, wanted);
      if (idx === -1) {
        return {
          ok: false,
          error: `operations[${i}]: ${memoryFileName(op.target)} 中未找到匹配条目（replace/remove 需提供现有条目全文）`,
          warnings,
          files: [],
        };
      }
      if (op.operation === 'replace') state.entries[idx] = op.text!;
      else state.entries.splice(idx, 1);
    }
    // 4. 预算按最终态校验（一次）
    for (const target of targets) {
      const state = states.get(target)!;
      const content = serializeMemoryEntries(state.entries);
      const budget = memoryBudget(target);
      if (content.length > budget) {
        return {
          ok: false,
          error: `${memoryFileName(target)} 超出预算：最终态 ${content.length} 字符 > 上限 ${budget}（剩余空间 ${Math.max(0, budget - content.length)}）；请先删旧条目再做整合`,
          warnings,
          files: [],
        };
      }
    }
    // 5. 注入扫描（对本次新增/替换的文本；警告不拦截）
    const newTexts = ops.filter((o) => o.operation === 'add' || o.operation === 'replace').map((o) => o.text!);
    for (const f of scanInjection(newTexts)) {
      warnings.push(`注入扫描警告：operations[${f.index}] 命中疑似指令注入模式（${f.pattern}），已按原样写入`);
    }
    // 6. 落盘：先写全部 tmp，再逐个 rename；无实际变化的文件不动
    interface PendingWrite {
      file: string;
      tmp: string;
      content: string;
      target: MemoryTarget;
      entries: number;
    }
    const pendings: PendingWrite[] = [];
    try {
      mkdirSync(this.root, { recursive: true });
      for (const target of targets) {
        const state = states.get(target)!;
        const content = serializeMemoryEntries(state.entries);
        if (content === state.raw) continue;
        const tmp = `${state.file}.tmp`;
        writeFileSync(tmp, content, 'utf8');
        pendings.push({ file: state.file, tmp, content, target, entries: state.entries.length });
      }
      for (const p of pendings) renameSync(p.tmp, p.file);
    } catch (e) {
      // 失败清理：删除未 rename 的 tmp（不留半截文件；已 rename 的文件保留——后写者胜口径）
      for (const p of pendings) {
        try {
          unlinkSync(p.tmp);
        } catch {
          /* tmp 已不存在 */
        }
      }
      return { ok: false, error: `记忆写入失败: ${(e as Error)?.message ?? String(e)}`, warnings, files: [] };
    }
    return {
      ok: true,
      warnings,
      files: pendings.map((p) => ({
        target: p.target,
        entries: p.entries,
        usedChars: p.content.length,
        remainingChars: memoryBudget(p.target) - p.content.length,
        budget: memoryBudget(p.target),
      })),
    };
  }
}
