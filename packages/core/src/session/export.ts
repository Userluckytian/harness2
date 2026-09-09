// 会话轨迹导出/回放（阶段 10 Task 1）：轨迹作为资产的最小闭环。
//   exportSession —— 只读打包：会话目录（主日志 + rewind_points.jsonl + snapshots/）
//     及其子代理会话（全库扫描 header.parentSession 匹配）递归打进一个 zip。
//     红线：不修改会话目录任何文件（只读遍历 + 白名单收集）；zip 内路径按冻结结构。
//   importReplay —— 回放校验：解包 → 每个 session.v1.jsonl 逐行 parseEventLine
//     （坏行计数与告警）→ computeProjection → 投影摘要报告。CI 零 key 可跑
//     （轨迹即测试夹具，对照 deepseek-harness snapshots）。
//
// zip 冻结结构（计划冻结，路径分隔符恒为 '/'）：
//   <sessionId>.zip
//   ├── session.v1.jsonl
//   ├── rewind_points.jsonl        # 存在时
//   ├── snapshots/                  # 存在时（目录递归）
//   └── subagents/<sessionId>/…    # 子会话目录按同白名单递归（lock 永不入包）
//
// 确定性（幂等）：fflate 默认给每个条目打「当前时间」时间戳——统一固定 mtime，
// 同目录同内容两次导出得到逐字节相同的 zip。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { zipSync, unzipSync, type Zippable } from 'fflate';
import { computeProjection, loadSession, type LoadedSession } from './reader.js';
import { REWIND_POINTS_FILE } from './snapshots.js';
import { SESSION_LOG_FILE, parseEventLine, type SessionHeaderPayload } from './types.js';

/** 快照辅助目录名（当前内核不创建；存在即随导出，冻结结构预留） */
const SNAPSHOTS_DIR = 'snapshots';

/** 导出条目的固定 mtime（幂等的唯一来源；zip DOS 时间仅支持 1980-2099，取区间内定值） */
const EXPORT_MTIME = new Date(Date.UTC(2000, 0, 1));

/** 默认导出目录名（outFile 缺省时落在 cwd） */
export function defaultExportPath(sessionDir: string): string {
  const header = readSessionHeader(sessionDir);
  const id = header?.sessionId ?? basename(sessionDir);
  return join(process.cwd(), `${id}.zip`);
}

export interface ExportResult {
  sessionId: string;
  outFile: string;
  /** 打包的文件条目数（不含目录占位） */
  entryCount: number;
  /** 递归打包的子代理会话 id（zip 内 subagents/<id>/） */
  subagentIds: string[];
}

/** 读取会话头（只读；日志缺失/首事件非法 → null） */
function readSessionHeader(dir: string): SessionHeaderPayload | null {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) return null;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const e = parseEventLine(line);
    if (e === null) return null; // 首个非空行必须是 header（writer.create 的写入顺序）
    return e.type === 'session/header' ? e.payload : null;
  }
  return null;
}

/**
 * 白名单收集一个会话目录内应入包的文件（相对路径，'/' 分隔）：
 * session.v1.jsonl（必需）+ rewind_points.jsonl + snapshots/**（存在时）。
 * lock 与其余未知文件不入包——导出结构冻结，避免把进程状态/临时文件带进资产。
 * 收尾按 rel 排序（审查 P2-1）：readdir 顺序跨平台不保证，排序是字节幂等的一部分。
 */
function collectSessionFiles(dir: string): Array<{ rel: string; abs: string }> {
  const logPath = join(dir, SESSION_LOG_FILE);
  if (!existsSync(logPath)) {
    throw new Error(`session log not found: ${logPath}`);
  }
  const files: Array<{ rel: string; abs: string }> = [{ rel: SESSION_LOG_FILE, abs: logPath }];
  const rewindPath = join(dir, REWIND_POINTS_FILE);
  if (existsSync(rewindPath)) {
    files.push({ rel: REWIND_POINTS_FILE, abs: rewindPath });
  }
  const snapshotsDir = join(dir, SNAPSHOTS_DIR);
  if (existsSync(snapshotsDir)) {
    files.push(...collectDirRecursive(snapshotsDir, SNAPSHOTS_DIR));
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** 递归收集目录内全部文件（rel 为 '/' 分隔的包内路径；目录本身不产生条目） */
function collectDirRecursive(absDir: string, relPrefix: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectDirRecursive(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out;
}

/**
 * 在会话库 root（<root>/<encoded-cwd>/<id> 布局的顶层）下扫描指定会话的直接子代理
 * 会话（header.parentSession === parentId）。按 id 排序保证打包顺序确定。
 * 只扫当前库 root（计划风险口径）：性能与 list/search 全量解析同档（P2-4 留档）。
 */
function findSubagentDirs(root: string, parentId: string): Array<{ id: string; dir: string }> {
  const found: Array<{ id: string; dir: string }> = [];
  let groups: Array<string> = [];
  try {
    if (existsSync(root)) {
      groups = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name));
    }
  } catch {
    return found; // root 不可读/被并发删除：视为无子会话（导出主会话不受影响）
  }
  for (const groupDir of groups) {
    let entries: Array<string> = [];
    try {
      entries = readdirSync(groupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // 组目录不可读/被并发删除（如并行测试的临时目录）：跳过
    }
    for (const name of entries) {
      const dir = join(groupDir, name);
      if (!existsSync(join(dir, SESSION_LOG_FILE))) continue;
      let header: SessionHeaderPayload | null = null;
      try {
        header = loadSession(dir).header;
      } catch {
        continue; // 损坏会话不阻塞导出
      }
      if (header?.parentSession === parentId) found.push({ id: name, dir });
    }
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 导出会话轨迹（只读）：主会话 + 全库内 parentSession 匹配的子代理会话 → zip。
 * outFile 缺省 = cwd/<sessionId>.zip。同目录同内容 → 同 zip 字节（固定 mtime + 排序）。
 */
export function exportSession(sessionDir: string, outFile?: string): ExportResult {
  const mainFiles = collectSessionFiles(sessionDir); // 日志缺失在此抛错
  const header = readSessionHeader(sessionDir);
  const sessionId = header?.sessionId ?? basename(sessionDir);
  // 子代理会话与主会话同库：<root>/<group>/<id> 的顶层即库 root；布局不符时扫不到（无害降级）
  const root = dirname(dirname(sessionDir));
  const children = header === null ? [] : findSubagentDirs(root, sessionId);

  const entries: Zippable = {};
  const addFiles = (files: Array<{ rel: string; abs: string }>, prefix: string): void => {
    for (const f of files) {
      entries[`${prefix}${f.rel}`] = [new Uint8Array(readFileSync(f.abs)), { mtime: EXPORT_MTIME }];
    }
  };
  addFiles(mainFiles, '');
  for (const child of children) addFiles(collectSessionFiles(child.dir), `subagents/${child.id}/`);

  const out = outFile ?? defaultExportPath(sessionDir);
  mkdirSync(dirname(out), { recursive: true });
  const zipped = zipSync(entries);
  writeFileSync(out, zipped);
  const entryCount = Object.keys(entries).length;
  return { sessionId, outFile: out, entryCount, subagentIds: children.map((c) => c.id) };
}

// —— 回放校验 ——

/** importReplay 累计解压字节缺省上限（256 MiB；解压炸弹防护，OPEN.md 2026-09-06 P2-5 消化） */
export const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024 * 1024;

/** 解压体积超限：消息含上限值与建议（CLI 一行输出 exit 1） */
export class ReplayTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayTooLargeError';
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const REPLAY_LIMIT_HINT =
  '建议：确认包来源后分段导出（主会话与子会话分别导出）再回放，或在调用 importReplay 时用 maxDecompressedBytes 参数提高上限。';

/**
 * 前置校验（不解压）：解析 zip 中央目录各条目「声明的解压后体积」并求和。
 * 返回 null = 结构无法识别（非 zip / zip64 EOCD 等）——此时跳过前置校验，
 * 由后置实际体积校验兜底。条目声明 0xFFFFFFFF（zip64 标记值）时该项不可信，
 * 同样交给后置校验。恶意包可谎报体积，本地信任域口径下前置校验是主闸门、
 * 后置校验拦「声明撒谎」包的后续处理。
 */
function declaredUncompressedTotal(data: Uint8Array): number | null {
  const minEocd = 22;
  if (data.length < minEocd) return null;
  // EOCD 从尾部向前扫（注释最长 65535 字节）
  let eocd = -1;
  const scanFrom = Math.max(0, data.length - minEocd - 65535);
  for (let i = data.length - minEocd; i >= scanFrom; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalEntries = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  let pos = cdOffset;
  let total = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > data.length || dv.getUint32(pos, true) !== 0x02014b50) return null;
    const uncompressed = dv.getUint32(pos + 24, true);
    if (uncompressed !== 0xffffffff) total += uncompressed;
    pos += 46 + dv.getUint16(pos + 28, true) + dv.getUint16(pos + 30, true) + dv.getUint16(pos + 32, true);
  }
  return total;
}

export interface ReplaySessionReport {
  /** 会话 id（header.sessionId；缺头时回退包内路径推导） */
  id: string;
  /** zip 内日志条目路径（根会话 = session.v1.jsonl；子会话 = subagents/<id>/…） */
  source: string;
  /** 解析成功的事件数 */
  events: number;
  /** 坏行数（parseEventLine 拒绝；明细在 warnings） */
  badLines: number;
  /** 坏行/解析告警（loadSession 同款格式） */
  warnings: string[];
  /** 投影活动消息数（user+assistant） */
  messageCount: number;
  /** 投影最后事件 seq */
  lastSeq: number;
}

export interface ReplayReport {
  sessions: ReplaySessionReport[];
}

/** 从 JSONL 文本逐行解析并计算投影摘要（内存内进行，不落盘） */
function replayFromJsonl(text: string, source: string): ReplaySessionReport {
  const warnings: string[] = [];
  const events: LoadedSession['events'] = [];
  let header: SessionHeaderPayload | null = null;
  let badLines = 0;
  let maxSeq = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (line.length === 0) continue;
    const e = parseEventLine(line);
    if (e === null) {
      badLines += 1;
      warnings.push(`skipped invalid line ${i + 1}: ${line.slice(0, 80)}`);
      continue;
    }
    if (e.type === 'session/header') header = e.payload;
    if (e.seq > maxSeq) maxSeq = e.seq;
    events.push({ event: e, active: true });
  }
  // 越界 rewind/marker 告警与 loadSession（reader.ts）同款（审查 P2-3）——纯内存补齐，
  // 使「loadSession 同款告警格式」声明完整成立（坏行计数 badLines 不含此项）
  for (const { event } of events) {
    if (event.type !== 'rewind/marker') continue;
    const n = event.payload.rewindToSeq;
    if (!Number.isInteger(n) || n < 1 || n > maxSeq) {
      warnings.push(
        `rewind/marker at seq ${event.seq}: rewindToSeq ${n} out of range (1..${maxSeq})`,
      );
    }
  }
  // id 优先取 header；无头时按包内路径推导（subagents/<id>/… → <id>），再退 'unknown'
  const pathDerived = source.startsWith('subagents/') ? source.split('/')[1] : undefined;
  const id = header?.sessionId ?? pathDerived ?? 'unknown';
  const projection = computeProjection({ dir: source, header, events, warnings });
  return {
    id,
    source,
    events: events.length,
    badLines,
    warnings,
    messageCount: projection.messages.length,
    lastSeq: projection.lastSeq,
  };
}

/** importReplay 选项 */
export interface ImportReplayOptions {
  /** 累计解压字节上限（缺省 DEFAULT_MAX_REPLAY_BYTES = 256 MiB；测试/特殊场景可覆盖） */
  maxDecompressedBytes?: number;
}

/**
 * 回放校验：解包 zip → 每个会话日志逐行解析（坏行计数与告警）→ 投影摘要。
 * 包内没有任何 session.v1.jsonl（空包/非 harness2 导出）→ 抛错（CLI exit 1）。
 * 解压体积上限（OPEN.md P2-5 消化）：累计解压字节超过 maxDecompressedBytes
 * （缺省 256 MiB）→ ReplayTooLargeError（消息含上限值与建议）。
 * 前置校验读中央目录声明体积（不解压即拒绝）；后置校验核实际解压体积
 * （声明撒谎的包在解包后、进解析前拦截）。顺序：根会话在前，子会话按路径排序。
 */
export function importReplay(zipPath: string, opts: ImportReplayOptions = {}): ReplayReport {
  const limit = opts.maxDecompressedBytes ?? DEFAULT_MAX_REPLAY_BYTES;
  const data = readFileSync(zipPath);
  const declared = declaredUncompressedTotal(data);
  if (declared !== null && declared > limit) {
    throw new ReplayTooLargeError(
      `回放包解压体积超限：${zipPath} 声明解压后约 ${formatMiB(declared)}，超过上限 ${formatMiB(limit)}。${REPLAY_LIMIT_HINT}`,
    );
  }
  const files = unzipSync(new Uint8Array(data));
  const actual = Object.values(files).reduce((sum, b) => sum + b.length, 0);
  if (actual > limit) {
    throw new ReplayTooLargeError(
      `回放包解压体积超限：${zipPath} 实际解压 ${formatMiB(actual)}，超过上限 ${formatMiB(limit)}（包声明的条目体积不可信）。${REPLAY_LIMIT_HINT}`,
    );
  }
  const logEntries = Object.keys(files)
    .filter(
      (k) =>
        k === SESSION_LOG_FILE ||
        (k.startsWith('subagents/') && k.endsWith(`/${SESSION_LOG_FILE}`)),
    )
    .sort((a, b) => (a === SESSION_LOG_FILE ? -1 : b === SESSION_LOG_FILE ? 1 : a.localeCompare(b)));
  if (logEntries.length === 0) {
    throw new Error(`zip 中没有会话日志（${SESSION_LOG_FILE}）——空包或非 harness2 导出: ${zipPath}`);
  }
  const decoder = new TextDecoder();
  return { sessions: logEntries.map((k) => replayFromJsonl(decoder.decode(files[k]!), k)) };
}
