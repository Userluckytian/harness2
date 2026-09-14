// H-13 会话可移植（导入/迁移）：补齐 export/replay 之外的第三条腿——
// 把导出物（zip）**导入到目标会话库 root**，并做版本迁移与坏行容错。
//
// 口径与既有 export/replay 严格一致：
//   - 解压体积上限沿用 DEFAULT_MAX_REPLAY_BYTES（256 MiB），前置校验读中央目录声明体积、
//     后置校验实际解压体积，超限抛 ReplayTooLargeError（消息含上限与建议）；
//   - 幂等：目标文件内容与包内一致时**不写盘**（status: unchanged，字节与 mtime 都不动）；
//     overwrite:true 时重写但内容相同 → 再导出得到的 zip 与首次导出逐字节相同
//     （导出侧固定 mtime 的约定未改动）；
//   - 只写目标会话目录，绝不修改源包；事实源日志按包内字节原样落盘（不重排、不压缩）。
//
// 安全（zip slip 防御）：条目路径必须是相对 POSIX 路径、无 `..` 段、无 `\`、无盘符冒号，
// 且只允许冻结结构内的名字（session.v1.jsonl / rewind_points.jsonl / snapshots/** /
// subagents/<合法 sessionId>/**）；越界条目直接报错（不静默丢弃），未知的**根级**条目
// 记 warning 并跳过（前向兼容）。
//
// 版本迁移：按日志信封 `v` 判定代际。v > 当前 → 拒绝（更新版本的会话不能被旧内核读）；
// v < 当前 → 走注入的迁移链（缺省 SESSION_MIGRATIONS 为空表，即当前没有任何旧代际），
// 无可用迁移链则报错。迁移只在**该会话日志需要跨代**时重写该文件。
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { DEFAULT_MAX_REPLAY_BYTES, ReplayTooLargeError, declaredUncompressedTotal } from './export.js';
import { SESSION_ID_PATTERN, encodeCwd } from './manager.js';
import { REWIND_POINTS_FILE } from './snapshots.js';
import { SESSION_FORMAT_VERSION, SESSION_LOG_FILE, parseEventLine } from './types.js';

/** zip 内允许的直属文件名（与 export.ts 冻结结构一致） */
const ALLOWED_ROOT_FILES = new Set([SESSION_LOG_FILE, REWIND_POINTS_FILE]);

// —— 版本迁移 ——

/** 单步迁移：from 代际的日志行 → to 代际的日志行（纯函数，便于单测与审计） */
export interface SessionMigration {
  from: number;
  to: number;
  /** 说明（登记用） */
  description: string;
  migrate(lines: readonly string[]): string[];
}

/** 迁移表（当前日志代际仅 v1，故缺省为空；新代际落地时在此登记） */
export const SESSION_MIGRATIONS: readonly SessionMigration[] = [];

/** 迁移链（from → to 的连续多步）；无可用链返回 null */
export function planMigrationChain(
  from: number,
  to: number,
  table: readonly SessionMigration[] = SESSION_MIGRATIONS,
): SessionMigration[] | null {
  if (from === to) return [];
  const chain: SessionMigration[] = [];
  let cursor = from;
  while (cursor < to) {
    const step = table.find((m) => m.from === cursor);
    if (step === undefined) return null;
    chain.push(step);
    cursor = step.to;
  }
  return cursor === to ? chain : null;
}

/** 取日志代际（首个可解析行信封的 v；空日志 → null） */
export function detectLogVersion(lines: readonly string[]): number | null {
  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 坏行不参与代际判定（坏行容错由调用方计数）
    }
    const v = (obj as { v?: unknown }).v;
    return typeof v === 'number' ? v : null;
  }
  return null;
}

/** 迁移结果（重写后的行 + 代际信息） */
export interface MigratedLog {
  lines: string[];
  from: number;
  to: number;
  steps: string[];
}

/**
 * 迁移日志文本：v == 当前 → 原样返回；v > 当前 → 抛错；v < 当前 → 走链重写；
 * 无链 → 抛错；代际无法识别（空日志/全坏行）→ 原样返回（如实登记，交由坏行口径处理）。
 */
export function migrateLogLines(
  lines: readonly string[],
  table: readonly SessionMigration[] = SESSION_MIGRATIONS,
): MigratedLog {
  const from = detectLogVersion(lines);
  if (from === null || from === SESSION_FORMAT_VERSION) {
    return { lines: [...lines], from: from ?? SESSION_FORMAT_VERSION, to: SESSION_FORMAT_VERSION, steps: [] };
  }
  if (from > SESSION_FORMAT_VERSION) {
    throw new Error(
      `会话日志代际 v${from} 新于本内核支持的 v${SESSION_FORMAT_VERSION}，拒绝导入（请升级 harness2 后重试）`,
    );
  }
  const chain = planMigrationChain(from, SESSION_FORMAT_VERSION, table);
  if (chain === null) {
    throw new Error(`缺少 v${from} → v${SESSION_FORMAT_VERSION} 的迁移链，拒绝导入（请补齐迁移表或升级内核）`);
  }
  let current = [...lines];
  for (const step of chain) current = step.migrate(current);
  return { lines: current, from, to: SESSION_FORMAT_VERSION, steps: chain.map((s) => s.description) };
}

// —— 导入 ——

/** 解压条目 + 校验后的会话分组 */
interface PackedSession {
  id: string;
  /** zip 内日志路径（根会话 = session.v1.jsonl） */
  source: string;
  /** 相对会话目录的文件（rel 用 '/' 分隔）→ 字节 */
  files: Map<string, Uint8Array>;
  warnings: string[];
}

export interface ImportSessionReport {
  id: string;
  source: string;
  /** 落盘目录（dryRun 时为计划目录） */
  dir: string;
  status: 'imported' | 'overwritten' | 'unchanged' | 'skipped-existing' | 'planned';
  /** 解析成功的事件数（坏行不计） */
  events: number;
  badLines: number;
  warnings: string[];
  /** 发生了跨代迁移时的代际信息 */
  migrated?: { from: number; to: number; steps: string[] };
  /** 落盘/计划落盘的文件数 */
  files: number;
}

export interface ImportReport {
  /** 纳入导入的会话（根会话在前，子会话按 id 排序） */
  sessions: ImportSessionReport[];
  /** 包级告警（未知条目等） */
  warnings: string[];
  entryCount: number;
}

export interface ImportSessionOptions {
  /** 目标会话库 root（`<root>/<encoded-cwd>/<id>/` 布局的顶层） */
  targetRoot: string;
  /** 包内无 cwd 真值时的兜底分组 cwd（缺省不兜底 → 该会话报错跳过） */
  cwd?: string;
  /** 目标已存在且内容不同：true 覆盖，false（缺省）跳过并记 warning */
  overwrite?: boolean;
  /** 只报告不落盘 */
  dryRun?: boolean;
  /** 解压体积上限（缺省 256 MiB，与 importReplay 同口径） */
  maxDecompressedBytes?: number;
  /** 迁移表覆盖（测试注入用） */
  migrations?: readonly SessionMigration[];
  /** 落盘后 fsync（缺省 true；测试可关） */
  fsync?: boolean;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const IMPORT_LIMIT_HINT =
  '建议：确认包来源后分段导入（主会话与子会话分别导出）再导入，或用 maxDecompressedBytes 参数提高上限。';

/** zip slip 防御：拒绝绝对路径、盘符、反斜杠、`..` 段、空段 */
function assertSafeEntryPath(key: string): void {
  if (key.length === 0) throw new Error('zip 条目路径为空');
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    throw new Error(`zip 条目为绝对路径，拒绝导入: ${key}`);
  }
  if (key.includes('\\')) {
    throw new Error(`zip 条目含反斜杠路径分隔符，拒绝导入: ${key}`);
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`zip 条目含越界路径段（${segment}），拒绝导入: ${key}`);
    }
  }
}

/** 路径围栏：p 必须等于 root 或位于 root 之下（与 skills/authoring.ts 同款双防御） */
function isInside(root: string, p: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return p === root || p.startsWith(prefix);
}

/**
 * 把条目按冻结结构分组为会话。返回会话列表 + 包级告警。
 * 根级未知条目 → warning 跳过（前向兼容）；结构不符（subagents 下未知形状）→ warning 跳过；
 * 路径越界 → 抛错（安全闸门，不静默）。
 */
function groupEntries(files: Record<string, Uint8Array>): { sessions: PackedSession[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, PackedSession>();
  const ensure = (id: string, source: string): PackedSession => {
    const found = byId.get(id);
    if (found !== undefined) return found;
    const created: PackedSession = { id, source, files: new Map(), warnings: [] };
    byId.set(id, created);
    return created;
  };
  for (const key of Object.keys(files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    assertSafeEntryPath(key);
    const bytes = files[key]!;
    if (!key.includes('/')) {
      if (!ALLOWED_ROOT_FILES.has(key)) {
        warnings.push(`忽略包内未知条目: ${key}`);
        continue;
      }
      ensure('__root__', SESSION_LOG_FILE).files.set(key, bytes);
      continue;
    }
    const segments = key.split('/');
    const head = segments[0];
    if (head === 'snapshots') {
      ensure('__root__', SESSION_LOG_FILE).files.set(key, bytes);
      continue;
    }
    if (head === 'subagents') {
      const id = segments[1]!;
      if (!SESSION_ID_PATTERN.test(id)) {
        warnings.push(`忽略结构不符的子会话条目（非法 sessionId）: ${key}`);
        continue;
      }
      const rel = segments.slice(2).join('/');
      const child = ensure(id, `subagents/${id}/${SESSION_LOG_FILE}`);
      if (!rel.includes('/')) {
        if (!ALLOWED_ROOT_FILES.has(rel)) {
          warnings.push(`忽略子会话内未知条目: ${key}`);
          continue;
        }
        child.files.set(rel, bytes);
        continue;
      }
      if (!rel.startsWith('snapshots/')) {
        warnings.push(`忽略子会话内未知条目: ${key}`);
        continue;
      }
      child.files.set(rel, bytes);
      continue;
    }
    warnings.push(`忽略包内未知条目: ${key}`);
  }
  const root = byId.get('__root__');
  if (root !== undefined && !root.files.has(SESSION_LOG_FILE)) {
    warnings.push(`包根缺少 ${SESSION_LOG_FILE}（仅 ${root.files.size} 个辅助文件），忽略`);
    byId.delete('__root__');
  }
  const sessions: PackedSession[] = [];
  if (byId.has('__root__')) sessions.push(byId.get('__root__')!);
  for (const id of [...byId.keys()].filter((k) => k !== '__root__').sort()) sessions.push(byId.get(id)!);
  return { sessions, warnings };
}

/** 读会话文本的 header（首个可解析行；缺头/首行非 header 返回 null） */
function readHeaderFromText(text: string): { cwd?: string; sessionId?: string } | null {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const event = parseEventLine(line);
    if (event === null) continue; // 坏行不参与 header 判定
    if (event.type !== 'session/header') return null;
    return {
      ...(event.payload.cwd !== undefined ? { cwd: event.payload.cwd } : {}),
      sessionId: event.payload.sessionId,
    };
  }
  return null;
}

/** 字节级比较（幂等判定口径） */
function sameBytes(file: string, bytes: Uint8Array): boolean {
  if (!existsSync(file)) return false;
  try {
    const existing = readFileSync(file);
    if (existing.length !== bytes.length) return false;
    return existing.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    return false;
  }
}

/** 原子写（tmp + rename；调用方已用 sameBytes 保证幂等） */
function writeBytesAtomic(file: string, bytes: Uint8Array, opts: { fsync: boolean }): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  if (opts.fsync) {
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主错误
    }
    throw e;
  }
}

/**
 * 导入导出包到目标会话库 root。
 * 结构不符/非 harness2 导出/超限/新代际 → 抛错；单个会话内部的坏行 → 计数并登记
 * （不阻塞其余会话，与 importReplay 的坏行口径一致）。
 */
export function importSession(zipPath: string, opts: ImportSessionOptions): ImportReport {
  const limit = opts.maxDecompressedBytes ?? DEFAULT_MAX_REPLAY_BYTES;
  const fsync = opts.fsync ?? true;
  const data = readFileSync(zipPath);
  const declared = declaredUncompressedTotal(data);
  if (declared !== null && declared > limit) {
    throw new ReplayTooLargeError(
      `导入包解压体积超限：${zipPath} 声明解压后约 ${formatMiB(declared)}，超过上限 ${formatMiB(limit)}。${IMPORT_LIMIT_HINT}`,
    );
  }
  const files = unzipSync(new Uint8Array(data));
  const actual = Object.values(files).reduce((sum, b) => sum + b.length, 0);
  if (actual > limit) {
    throw new ReplayTooLargeError(
      `导入包解压体积超限：${zipPath} 实际解压 ${formatMiB(actual)}，超过上限 ${formatMiB(limit)}（包声明的条目体积不可信）。${IMPORT_LIMIT_HINT}`,
    );
  }
  const grouped = groupEntries(files);
  if (grouped.sessions.length === 0) {
    throw new Error(`zip 中没有会话日志（${SESSION_LOG_FILE}）——空包或非 harness2 导出: ${zipPath}`);
  }
  const report: ImportReport = { sessions: [], warnings: grouped.warnings, entryCount: Object.keys(files).length };
  for (const packed of grouped.sessions) {
    const logBytes = packed.files.get(SESSION_LOG_FILE);
    if (logBytes === undefined) {
      report.warnings.push(`会话 ${packed.id} 包内缺少 ${SESSION_LOG_FILE}，跳过`);
      continue;
    }
    // 代际迁移先行：新代际/缺迁移链在**读 header 之前**拒绝（header 本身可能正是旧/新代际，
    // 用 parseEventLine 读不到，故不能拿 header 作前置条件）
    const rawLines = new TextDecoder().decode(logBytes).split('\n');
    const migrated = migrateLogLines(rawLines, opts.migrations ?? SESSION_MIGRATIONS);
    const newLogText = migrated.lines.join('\n');
    const header = readHeaderFromText(newLogText);
    const id = header?.sessionId ?? packed.id;
    const cwd = header?.cwd ?? opts.cwd;
    const warnings = [...packed.warnings];
    // P1-1（H-13 修复）：会话 id 是**包内数据**（header.sessionId 可被构造成任意串），
    // 却要参与落点路径拼接 `targetRoot/encodeCwd(cwd)/id`。zip 条目路径有 assertSafeEntryPath，
    // 但 id 此前没有任何闸门 → `sessionId='../../escaped'` 可写出 targetRoot 之外。
    // 双防御第一层：格式闸门（与 session/manager.ts 的 SESSION_ID_PATTERN 同源），不合法直接拒绝。
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(
        `会话 id 非法（不符合 SESSION_ID_PATTERN），拒绝导入: ${JSON.stringify(id)}（来源 ${packed.source}；` +
          `合法形如 20260914-222222-aa0001）`,
      );
    }
    if (cwd === undefined) {
      warnings.push(`会话 ${id} 无 cwd 真值且未提供 opts.cwd，跳过导入`);
      report.sessions.push({
        id,
        source: packed.source,
        dir: '',
        status: 'skipped-existing',
        events: 0,
        badLines: 0,
        warnings,
        files: 0,
      });
      continue;
    }
    const outFiles = new Map(packed.files);
    if (newLogText !== rawLines.join('\n')) outFiles.set(SESSION_LOG_FILE, new TextEncoder().encode(newLogText));
    // 坏行口径：以**迁移后**（即最终落盘）的内容为准——旧代际行不算坏行
    const badLines = migrated.lines.filter((l) => l.length > 0 && parseEventLine(l) === null).length;
    if (badLines > 0) warnings.push(`包内会话 ${id} 含 ${badLines} 行非法事件（按坏行口径跳过，不阻塞导入）`);
    const events = migrated.lines.filter((l) => l.length > 0 && parseEventLine(l) !== null).length;
    // 落点：与本地 SessionManager.groupDir 同口径（encodeCwd(resolve(cwd))）——
    // 跨平台导入时按目标平台的路径解析归组，导入后 manager.locate(id, {cwd}) 立即可定位。
    const dir = join(opts.targetRoot, encodeCwd(resolve(cwd)), id);
    // 双防御第二层：即便格式闸门被绕过（正则放宽/编码漂移），落点也必须落在 targetRoot 内
    if (!isInside(resolve(opts.targetRoot), resolve(dir))) {
      throw new Error(`会话落点越界（必须落在 ${resolve(opts.targetRoot)} 内），拒绝导入: ${dir}`);
    }
    const targetLog = join(dir, SESSION_LOG_FILE);
    const conflict = existsSync(targetLog) && !sameBytes(targetLog, outFiles.get(SESSION_LOG_FILE)!);
    let status: ImportSessionReport['status'];
    if (opts.dryRun === true) {
      status = 'planned';
    } else if (conflict && !(opts.overwrite ?? false)) {
      status = 'skipped-existing';
      warnings.push(`目标已存在同名会话且内容不同：${dir}（overwrite:false，未覆盖）`);
    } else {
      let written = 0;
      let existedBefore = false;
      for (const [rel, bytes] of [...outFiles.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        const abs = join(dir, rel);
        if (sameBytes(abs, bytes)) continue; // 幂等：内容一致不写盘（mtime/字节都不动）
        if (existsSync(abs)) existedBefore = true;
        writeBytesAtomic(abs, bytes, { fsync });
        written += 1;
      }
      status = written === 0 ? 'unchanged' : existedBefore ? 'overwritten' : 'imported';
    }
    report.sessions.push({
      id,
      source: packed.source,
      dir,
      status,
      events,
      badLines,
      warnings,
      ...(migrated.from !== migrated.to
        ? { migrated: { from: migrated.from, to: migrated.to, steps: migrated.steps } }
        : {}),
      files: outFiles.size,
    });
  }
  return report;
}
